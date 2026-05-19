"""
providers/triage.py — interactive review of needs_review masjids.

Walks every masjid whose quality.status is 'needs_review', shows the issues,
and lets you decide per-masjid: acknowledge, delete, skip, or quit. Applies
all decisions at the end and rebuilds CSVs from cached raw data where
acknowledgments require the time values to be restored.

Usage (run from repo root):
    python -m providers.triage
    python -m providers.triage --data-dir data --list-file data/mawaqit_uk.txt

Key actions:
    [a]cknowledge  Mark every unacknowledged high-severity issue on this
                   masjid as accepted. Quality status drops to 'warnings' so
                   it appears in the public list. For mawaqit masjids, the
                   CSV is rebuilt from the cached raw blob so values that
                   were defensively blanked (e.g. Isha) come back.
    [d]elete       Remove the masjid's config + csv + raw cache, and
                   comment out its line in the curated list file so the
                   bulk fetcher won't re-add it on the next run.
    [n]ext         Leave as-is. Masjid stays in needs_review (hidden).
    [q]uit         Apply decisions made so far and exit.
"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import argparse
import json
from pathlib import Path

from providers import regenerate_index


ISSUE_DESCRIPTIONS = {
    "isha_clamped": "Isha == Maghrib (common UK summer combine pattern)",
    "fajr_after_sunrise": "Fajr jama'at is at or after sunrise (data error)",
    "iqamas_unconfigured": "All iqama fields empty (masjid hasn't set jama'at times)",
    "sehri_unconfigured": "Suhoor cutoff not set (sehri_ends = fajr_start)",
}


def load_needs_review(mosques_dir: Path):
    out = []
    for p in sorted(mosques_dir.glob("*.json")):
        if p.name == "index.json":
            continue
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  Couldn't read {p.name}: {e}")
            continue
        q = cfg.get("quality") or {}
        if q.get("status") == "needs_review":
            out.append((p, cfg))
    return out


def format_issue_header(issue: dict) -> str:
    typ = issue.get("type", "?")
    desc = ISSUE_DESCRIPTIONS.get(typ, "")
    return f"    ! {typ}" + (f" — {desc}" if desc else "")


def _is_contiguous(dates: list[str]) -> bool:
    """ISO date strings are lexically ordered. Contiguous = adjacent ISO dates differ by 1 day."""
    from datetime import date
    try:
        ds = [date.fromisoformat(d) for d in dates]
    except ValueError:
        return False
    return all((b - a).days == 1 for a, b in zip(ds, ds[1:]))


def format_issue_detail(issue: dict) -> list[str]:
    out = []
    count = issue.get("count")
    if count is not None:
        text = f"{count} day{'s' if count != 1 else ''}"
        affected = issue.get("affected_dates") or []
        if affected and len(affected) <= 8:
            # Few enough to list explicitly — best clarity when dates are scattered
            text += f": {', '.join(affected)}"
        elif affected and _is_contiguous(affected):
            text += f" (contiguous: {affected[0]} → {affected[-1]})"
        elif affected:
            text += f" (scattered between {affected[0]} and {affected[-1]})"
        elif issue.get("first_date"):
            # Fallback for older configs without affected_dates
            text += f" ({issue['first_date']} → {issue.get('last_date', '?')})"
        out.append(f"        {text}")
    if issue.get("action_taken"):
        out.append(f"        Action taken: {issue['action_taken']}")
    if issue.get("fix"):
        out.append(f"        Fix: {issue['fix']}")
    return out


def recompute_status(cfg: dict) -> str:
    """Recompute quality.status from the issues list (matching quality_check)."""
    issues = cfg.get("quality", {}).get("issues", []) or []
    if not issues:
        return "ok"
    unack = [i for i in issues if not i.get("acknowledged")]
    if not unack:
        return "ok"
    if any(i.get("severity") == "high" for i in unack):
        return "needs_review"
    return "warnings"


def acknowledge(cfg_path: Path, cfg: dict, issue_types: list[str]) -> None:
    """Update config: extend acknowledged_issues, mark issues, recompute status."""
    existing_ack = set(cfg.get("acknowledged_issues") or [])
    cfg["acknowledged_issues"] = sorted(existing_ack | set(issue_types))
    for issue in cfg.get("quality", {}).get("issues", []):
        if issue.get("type") in issue_types:
            issue["acknowledged"] = True
    cfg["quality"]["status"] = recompute_status(cfg)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def comment_out_in_list(slug: str, mawaqit_path: str, list_file: Path) -> bool:
    """
    Comment out the line in the curated list whose 1st field matches
    `mawaqit_path` or whose 2nd field matches `slug`. Returns True if a line
    was changed.
    """
    if not list_file or not list_file.exists():
        return False
    lines = list_file.read_text(encoding="utf-8").splitlines()
    changed = False
    out = []
    for line in lines:
        if line.startswith("#") or not line.strip():
            out.append(line)
            continue
        parts = line.split()
        first = parts[0] if parts else ""
        second = parts[1] if len(parts) > 1 else ""
        if first == mawaqit_path or second == slug:
            out.append(f"# triage-deleted: {line}")
            changed = True
        else:
            out.append(line)
    if changed:
        list_file.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def delete_masjid(slug: str, cfg: dict, data_dir: Path, list_file: Path) -> list[str]:
    """Remove config + csv + raw, comment out the curated-list entry."""
    deleted = []
    for path in [
        data_dir / "mosques" / f"{slug}.json",
        data_dir / f"{slug}.csv",
        data_dir / "raw" / f"{slug}.json",
    ]:
        if path.exists():
            path.unlink()
            deleted.append(str(path))
    provider = cfg.get("provider") or {}
    mawaqit_path = (provider.get("ref") or {}).get("path", "")
    if list_file and comment_out_in_list(slug, mawaqit_path, list_file):
        deleted.append(f"(commented out in {list_file})")
    return deleted


def rebuild(slug: str, cfg: dict, data_dir: Path) -> dict | None:
    """Rebuild CSV from cached raw data. Returns new quality dict or None if not applicable."""
    provider = cfg.get("provider") or {}
    if provider.get("type") != "mawaqit":
        return None
    from providers.mawaqit.fetch import rebuild_from_cache
    return rebuild_from_cache(slug, data_dir)


def show_masjid(idx: int, total: int, cfg_path: Path, cfg: dict) -> None:
    slug = cfg_path.stem
    name = cfg.get("display_name") or slug
    city = cfg.get("city") or ""
    address = cfg.get("address") or ""
    provider = cfg.get("provider") or {}
    source = provider.get("source_url") or "—"

    print()
    print("━" * 72)
    header = f"[{idx}/{total}] {slug} — {name}"
    if city:
        header += f"  ({city})"
    print(header)
    print("━" * 72)
    if address:
        print(f"  Address:  {address}")
    print(f"  Provider: {provider.get('type', '?')}")
    print(f"  Source:   {source}")

    issues = cfg.get("quality", {}).get("issues", [])
    unack_high = [
        i for i in issues
        if i.get("severity") == "high" and not i.get("acknowledged")
    ]
    if unack_high:
        print("\n  Unacknowledged high-severity issues:")
        for issue in unack_high:
            print(format_issue_header(issue))
            for line in format_issue_detail(issue):
                print(line)
    else:
        # Shouldn't happen given the load filter, but handle gracefully
        print("\n  (No unacknowledged high issues — status may be stale; pick [a] to refresh)")

    print()
    print("  [a] Acknowledge all unacknowledged high issues (un-hide masjid)")
    print("  [d] Delete masjid (remove files + comment out in curated list)")
    print("  [n] Next (leave as-is, masjid stays hidden)")
    print("  [q] Quit (apply decisions so far and exit)")


def prompt_choice() -> str:
    while True:
        try:
            choice = input("\n  Choice [a/d/n/q]: ").strip().lower()
        except EOFError:
            return "q"
        if choice in ("a", "d", "n", "q"):
            return choice
        print("  Invalid — pick a, d, n, or q")


def main():
    parser = argparse.ArgumentParser(
        description="Interactive review of needs_review masjids",
    )
    parser.add_argument("--data-dir", default="data")
    parser.add_argument(
        "--list-file", default="data/mawaqit_uk.txt",
        help="Curated list to comment-out deleted entries in (mawaqit-only)",
    )
    parser.add_argument(
        "--no-rebuild", action="store_true",
        help="Skip the rebuild-from-cache step after acknowledgment (faster, but CSVs may show blanked values)",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    list_file = Path(args.list_file) if args.list_file else None
    mosques_dir = data_dir / "mosques"

    pending = load_needs_review(mosques_dir)
    if not pending:
        print("No masjids in needs_review — nothing to triage.")
        return

    print(f"Found {len(pending)} masjid(s) in needs_review.")

    acknowledged_log = []  # list of (slug, [issue_types])
    deleted_log = []       # list of (slug, [files])
    skipped_log = []       # list of slugs

    for i, (cfg_path, cfg) in enumerate(pending, start=1):
        show_masjid(i, len(pending), cfg_path, cfg)
        choice = prompt_choice()

        slug = cfg_path.stem
        if choice == "q":
            print("\nQuit — applying decisions made so far")
            break
        if choice == "n":
            skipped_log.append(slug)
            continue
        if choice == "a":
            issues = cfg.get("quality", {}).get("issues", [])
            types = sorted({
                i["type"] for i in issues
                if i.get("severity") == "high" and not i.get("acknowledged")
            })
            acknowledge(cfg_path, cfg, types)
            acknowledged_log.append((slug, types))
            print(f"  ✓ Acknowledged: {', '.join(types)}")
        elif choice == "d":
            deleted = delete_masjid(slug, cfg, data_dir, list_file)
            deleted_log.append((slug, deleted))
            print(f"  ✓ Deleted {len(deleted)} item(s)")

    # Rebuild CSVs for acknowledged mawaqit masjids
    rebuild_results = []  # list of (slug, new_status_or_error)
    if acknowledged_log and not args.no_rebuild:
        print("\nRebuilding CSVs from cached raw data...")
        for slug, _types in acknowledged_log:
            cfg_path = mosques_dir / f"{slug}.json"
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            try:
                q = rebuild(slug, cfg, data_dir)
                if q is None:
                    rebuild_results.append((slug, "skipped (not mawaqit)"))
                else:
                    rebuild_results.append((slug, q["status"]))
            except Exception as e:
                rebuild_results.append((slug, f"FAILED: {e}"))

    # Regenerate index if anything changed
    if acknowledged_log or deleted_log:
        count = regenerate_index(mosques_dir)
        print(f"\nRegenerated {mosques_dir / 'index.json'} ({count} masjids)")

    # Summary
    print()
    print("━" * 72)
    print("Summary")
    print("━" * 72)
    if acknowledged_log:
        print(f"  Acknowledged ({len(acknowledged_log)}):")
        for slug, types in acknowledged_log:
            extra = ""
            for rs_slug, rs_status in rebuild_results:
                if rs_slug == slug:
                    extra = f" → {rs_status}"
                    break
            print(f"    {slug:18s}  {', '.join(types)}{extra}")
    if deleted_log:
        print(f"  Deleted ({len(deleted_log)}):")
        for slug, _ in deleted_log:
            print(f"    {slug}")
    if skipped_log:
        print(f"  Skipped ({len(skipped_log)}):")
        for slug in skipped_log:
            print(f"    {slug}")
    if not (acknowledged_log or deleted_log or skipped_log):
        print("  (no decisions made)")


if __name__ == "__main__":
    main()
