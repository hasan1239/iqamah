"""
providers/mawaqit/rename.py — preview/apply name-based slug + display_name
fixes for existing mawaqit masjids.

For each mawaqit config on disk it loads the cached raw blob, re-runs the
current display-name/slug rules, and compares to what's already there.
Reports a diff so you can review before applying. Apply mode (not built yet)
would rename files and update internal slug references atomically.

Why this exists: earlier sweeps produced wonky path-derived slugs like
'old' for "Old Hill Masjid" and bilingual display_names like
"ZAYTUNA MASJID مسجد الزيتونة". The rules have since been improved
(strip Arabic; use the masjid name for the slug). This tool brings
already-onboarded configs in line with the new rules.

Usage (run from repo root):
    python -m providers.mawaqit.rename            # preview only (default)
"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import argparse
import json
import time
from pathlib import Path

from providers import INDEX_FILENAMES, regenerate_index
from providers.mawaqit.fetch import parse_mawaqit_label
from providers.mawaqit.sweep import name_to_slug, extract_postcode


def load_list_overrides(list_path: Path) -> dict[str, str]:
    """
    Parse data/mawaqit_uk.txt for explicit 2nd-column slug overrides.
    Returns {mawaqit_path: short_slug}. Comments + commented lines ignored.
    """
    out = {}
    if not list_path.exists():
        return out
    for line in list_path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = s.split()
        if len(parts) >= 2:
            out[parts[0]] = parts[1]
    return out


def apply_renames(proposals: list, data_dir: Path, list_path: Path) -> dict:
    """
    Apply the slug + display_name updates from `proposals`. Uses a two-phase
    staged rename so any future cycles are handled safely. Returns a summary.

    Each proposal is (current_slug, current_name, ideal_name, ideal_slug, _).
    """
    mosques_dir = data_dir / "mosques"
    raw_dir = data_dir / "raw"
    suffix = f".rename_tmp_{int(time.time())}"

    slug_renames = [
        (cur, target) for (cur, _cn, _in, target, _) in proposals if cur != target
    ]
    name_updates = [
        (cur, target, new_name)
        for (cur, cur_name, new_name, target, _) in proposals
        if new_name != cur_name
    ]

    # Phase 1: stage each file involved in a slug rename to <current><suffix>
    for cur, target in slug_renames:
        for src in [
            mosques_dir / f"{cur}.json",
            data_dir / f"{cur}.csv",
            raw_dir / f"{cur}.json",
        ]:
            if src.exists():
                staged = src.with_name(cur + suffix + src.suffix)
                src.rename(staged)

    # Phase 2: move staged files to their final target paths
    for cur, target in slug_renames:
        for kind, dir_, ext in [
            ("config", mosques_dir, ".json"),
            ("csv",    data_dir,    ".csv"),
            ("raw",    raw_dir,     ".json"),
        ]:
            staged = dir_ / f"{cur}{suffix}{ext}"
            if staged.exists():
                staged.rename(dir_ / f"{target}{ext}")

    # Update internal fields on every renamed config + every name-only update
    touched_paths = {target for _cur, target in slug_renames}
    for cur, target, new_name in name_updates:
        touched_paths.add(target)
    for cur, _cn, ideal_name, target, _ in proposals:
        if target not in touched_paths:
            continue
        cfg_path = mosques_dir / f"{target}.json"
        if not cfg_path.exists():
            continue
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        cfg["display_name"] = ideal_name
        cfg["slug"] = target
        cfg["csv"] = f"{target}.csv"
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)

    # Update mawaqit_uk.txt: for each renamed slug, ensure the active line has
    # the new short slug as 2nd column. Leaves comments + parked lines alone.
    if list_path.exists() and slug_renames:
        slug_by_path = {}
        for (cur, _cn, _in, target, _) in proposals:
            if cur == target:
                continue
            # Find the masjid's mawaqit path from its config (now at target)
            cfg_path = mosques_dir / f"{target}.json"
            if not cfg_path.exists():
                continue
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            mp = ((cfg.get("provider") or {}).get("ref") or {}).get("path")
            if mp:
                slug_by_path[mp] = target

        new_lines = []
        for line in list_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                new_lines.append(line)
                continue
            parts = s.split()
            mp = parts[0]
            if mp in slug_by_path:
                new_lines.append(f"{mp}  {slug_by_path[mp]}")
            else:
                new_lines.append(line)
        list_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    count = regenerate_index(mosques_dir)

    return {
        "slug_renames": len(slug_renames),
        "name_updates": len(name_updates),
        "index_count": count,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Preview (default) or apply slug + display_name renames "
                    "for existing mawaqit masjids.",
    )
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--list-file", default="data/mawaqit_uk.txt")
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually rename files + update configs + edit mawaqit_uk.txt. "
             "Default is preview-only.",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    mosques_dir = data_dir / "mosques"
    list_path = Path(args.list_file)
    list_overrides = load_list_overrides(list_path)

    # Collect mawaqit configs + their cached raw data
    configs: list[tuple[str, dict, dict]] = []  # (current_slug, config, raw_data_or_None)
    for p in sorted(mosques_dir.glob("*.json")):
        if p.name in INDEX_FILENAMES:
            continue
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if (cfg.get("provider") or {}).get("type") != "mawaqit":
            continue
        raw_path = data_dir / "raw" / f"{p.stem}.json"
        raw = None
        if raw_path.exists():
            try:
                raw = json.loads(raw_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        configs.append((p.stem, cfg, raw))

    print(f"Scanning {len(configs)} mawaqit config(s)...\n")

    # First pass: compute ideal display_name + slug for each, detect collisions
    proposals = []  # (current_slug, current_name, ideal_name, ideal_slug, has_collision_note)
    proposed_slugs: dict[str, str] = {}  # ideal_slug -> first current_slug claiming it

    for current_slug, cfg, raw in configs:
        current_name = cfg.get("display_name", "") or ""
        mawaqit_path = ((cfg.get("provider") or {}).get("ref") or {}).get("path", "")

        # Compute the ideal display_name. If the current name is already clean
        # (no Arabic, no obviously-bad pattern), assume it's a manual fix and
        # keep it. Otherwise re-derive from the raw label.
        def _looks_clean(name: str) -> bool:
            if not name:
                return False
            return all(ord(c) < 128 for c in name) and "|" not in name

        if _looks_clean(current_name):
            ideal_name = current_name
        elif raw:
            label = raw.get("label") or raw.get("name") or current_name
            ideal_name, _ = parse_mawaqit_label(label)
            if not ideal_name:
                ideal_name = current_name
        else:
            ideal_name, _ = parse_mawaqit_label(current_name)
            if not ideal_name:
                ideal_name = current_name

        # Target slug: explicit override in mawaqit_uk.txt wins; otherwise
        # derive from the ideal name; otherwise keep current.
        override = list_overrides.get(mawaqit_path)
        if override:
            ideal_slug = override
        else:
            ideal_slug_base = name_to_slug(ideal_name)
            if not ideal_slug_base:
                proposals.append((current_slug, current_name, ideal_name, current_slug, ""))
                continue
            ideal_slug = ideal_slug_base
            if ideal_slug != current_slug:
                existing_filenames = {c[0] for c in configs}
                taken = (existing_filenames - {current_slug}) | set(proposed_slugs.keys())
                if ideal_slug in taken:
                    pc = ""
                    addr = cfg.get("address") or ""
                    import re as _re
                    m = _re.search(r"\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b", addr)
                    if m:
                        pc = f"{m.group(1)} {m.group(2)}".upper()
                    outward = pc.split(" ")[0].lower() if pc else ""
                    if outward and f"{ideal_slug_base}_{outward}" not in taken:
                        ideal_slug = f"{ideal_slug_base}_{outward}"
                    else:
                        n = 2
                        while f"{ideal_slug_base}_{n}" in taken:
                            n += 1
                        ideal_slug = f"{ideal_slug_base}_{n}"
        proposed_slugs[ideal_slug] = current_slug
        proposals.append((current_slug, current_name, ideal_name, ideal_slug, ""))

    # Categorise
    slug_changes = []
    name_changes_only = []
    unchanged = []
    for cur_slug, cur_name, new_name, new_slug, _ in proposals:
        slug_diff = new_slug != cur_slug
        name_diff = new_name != cur_name
        if slug_diff and name_diff:
            slug_changes.append(("BOTH", cur_slug, cur_name, new_slug, new_name))
        elif slug_diff:
            slug_changes.append(("SLUG", cur_slug, cur_name, new_slug, new_name))
        elif name_diff:
            name_changes_only.append(("NAME", cur_slug, cur_name, new_slug, new_name))
        else:
            unchanged.append(cur_slug)

    print(f"Slug changes ({len(slug_changes)}):")
    if slug_changes:
        for kind, cur_slug, cur_name, new_slug, new_name in slug_changes:
            marker = "+" if kind == "BOTH" else " "
            print(f"  {cur_slug:24s} → {new_slug:28s}  {marker} {cur_name}")
            if kind == "BOTH":
                print(f"  {' ':24s}   {' ':28s}    → {new_name}")
    else:
        print("  (none)")
    print()
    print(f"Display-name-only changes ({len(name_changes_only)}):")
    if name_changes_only:
        for _kind, cur_slug, cur_name, _new_slug, new_name in name_changes_only:
            print(f"  {cur_slug:24s}  {cur_name}")
            print(f"  {' ':24s}  → {new_name}")
    else:
        print("  (none)")
    print()
    print(f"Unchanged ({len(unchanged)}):")
    for s in unchanged:
        print(f"  {s}")

    print()
    print(f"Total: {len(proposals)} configs ({len(slug_changes)} slug, {len(name_changes_only)} name-only, {len(unchanged)} unchanged)")
    print()

    if not args.apply:
        print("Preview only. Re-run with --apply to make these changes.")
        return

    if not slug_changes and not name_changes_only:
        print("Nothing to apply.")
        return

    print("Applying changes...")
    summary = apply_renames(proposals, data_dir, list_path)
    print(f"  Slug renames: {summary['slug_renames']}")
    print(f"  Name updates: {summary['name_updates']}")
    print(f"  Regenerated index.json ({summary['index_count']} masjids)")
    print()
    print("Done. URLs for renamed masjids have changed — old bookmarks will 404.")


if __name__ == "__main__":
    main()
