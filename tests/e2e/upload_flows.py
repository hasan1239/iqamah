"""E2E browser tests for the Add Masjid and Update Masjid wizards.

Drives the real SPA in Chromium against a local `wrangler pages dev` server,
walking both upload wizards end to end: file upload -> extract -> review ->
submit -> confirmation.

External seams are stubbed IN THE BROWSER via Playwright route interception:
  - /api/extract, /api/submit, /api/update return canned responses
  - the Cloudflare Turnstile script is replaced with a stub that issues a token
The worker side of those seams is covered by tests/worker.test.mjs, so between
the two suites the full path is pinned: this suite proves the client sends the
right payloads and renders every wizard step; the node suite proves the worker
handles those payloads correctly.

Usage:
    python tests/e2e/upload_flows.py               # starts wrangler itself
    python tests/e2e/upload_flows.py --headed      # watch the browser
    python tests/e2e/upload_flows.py --base-url http://127.0.0.1:8788
                                                   # reuse a running server

Requires: playwright (+ chromium), pillow, wrangler (all existing project deps).
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 8788
UPDATE_SLUG = "faizul"  # any masjid with a config in data/mosques/

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

TURNSTILE_STUB = """
window.turnstile = {
  render: function (sel, opts) {
    if (opts && opts.callback) setTimeout(function () { opts.callback('e2e-token'); }, 30);
    return 0;
  },
  reset: function () {},
  remove: function () {}
};
if (window.onTurnstileLoad) window.onTurnstileLoad();
"""


def sample_extraction(name="Extracted Masjid Name"):
    """Three rows starting tomorrow; times chosen to pass the client-side
    validateExtractedData sanity checks."""
    rows = []
    year = datetime.now(timezone.utc).year
    for i in range(1, 4):
        d = datetime.now(timezone.utc) + timedelta(days=i)
        year = d.year
        rows.append({
            "date": f"{d.day} {MONTHS[d.month - 1]}",
            "day": DAYS[int(d.strftime('%w'))],
            "islamic_day": None,
            "sehri_ends": "", "fajr_start": "03:15", "sunrise": "04:45", "zawal": "",
            "zohr": "01:18", "asr": "05:39", "esha": "",
            "fajr_jamaat": "3:45", "zohar_jamaat": "1:30", "asr_jamaat": "6:00",
            "maghrib_iftari": "09:44", "maghrib_jamaat": "", "esha_jamaat": "10:59",
        })
    return {
        "mosque_name": name, "suggested_slug": "", "address": "", "phone": "",
        "month": "E2E", "year": year, "islamic_month": "", "jummah_times": "",
        "eid_salah": "", "sadaqatul_fitr": "", "radio_frequency": "", "notes": "",
        "rows": rows,
    }


def make_fixture_image(path):
    """A >=800px-per-side PNG so the client-side resolution check passes."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (1000, 1400), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "E2E Test Timetable", fill="black")
    for i in range(30):
        d.text((40, 90 + i * 40), f"{i + 1} Aug   05:00  06:30  13:15  18:00  21:00", fill="black")
    img.save(path)


def wait_for_server(base_url, timeout=120):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/version.json", timeout=3) as r:
                if r.status == 200:
                    return
        except Exception as e:  # noqa: BLE001 - retry until deadline
            last_err = e
        time.sleep(1)
    raise RuntimeError(f"Dev server did not become ready at {base_url}: {last_err}")


def start_wrangler(port, log_path):
    log = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        f"npx wrangler pages dev . --port {port}",
        cwd=ROOT, shell=True, stdout=log, stderr=subprocess.STDOUT,
    )
    return proc, log


def stop_wrangler(proc):
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(f"taskkill /PID {proc.pid} /T /F", shell=True, capture_output=True)
    else:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# The test context blocks service workers (so Playwright route interception
# sees every request), which makes the SW registration in js/utils/pwa.js
# reject with this error. Expected in tests only - not an app bug.
SW_BLOCKED_ERROR = "reading 'waiting'"


def setup_page(context, captured, errors):
    page = context.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}") if SW_BLOCKED_ERROR not in str(e) else None)
    page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)

    def turnstile_handler(route):
        if "api.js" in route.request.url:
            route.fulfill(status=200, content_type="application/javascript", body=TURNSTILE_STUB)
        else:
            route.fulfill(status=200, body="")

    page.route("**/challenges.cloudflare.com/**", turnstile_handler)

    def extract_handler(route):
        captured["extract_action"] = (route.request.post_data or "").count("name=\"action\"")
        route.fulfill(json={"success": True, "data": sample_extraction()})

    page.route("**/api/extract", extract_handler)

    def submit_handler(route):
        captured["submit"] = json.loads(route.request.post_data)
        route.fulfill(json={
            "success": True, "slug": "e2e_test_masjid", "url": "/e2e_test_masjid",
            "pending": True, "message": "E2E Test Masjid has been submitted for review!",
        })

    page.route("**/api/submit", submit_handler)

    def update_handler(route):
        captured["update"] = json.loads(route.request.post_data)
        route.fulfill(json={
            "success": True, "slug": UPDATE_SLUG, "url": f"/{UPDATE_SLUG}",
            "pending": True, "message": "Timetable has been updated!",
        })

    page.route("**/api/update", update_handler)
    return page


def walk_wizard(page, base_url, path, fixture, masjid_name=None):
    """Shared steps: upload file -> extract -> review appears -> submit -> done."""
    page.goto(f"{base_url}{path}")
    page.wait_for_selector("#fileInput", state="attached", timeout=30000)
    page.set_input_files("#fileInput", fixture)
    expect(page.locator("#extractBtn")).to_be_enabled(timeout=15000)
    page.click("#extractBtn")

    page.wait_for_selector("#step3.active", timeout=20000)
    expect(page.locator("#reviewTbody tr")).to_have_count(3)

    if masjid_name is not None:
        page.fill("#masjidName", masjid_name)

    page.click("#submitBtn")
    page.wait_for_selector("#step4.active", timeout=15000)
    expect(page.locator("#confirmationText")).to_be_visible()


def test_add_flow(context, base_url, fixture):
    captured, errors = {}, []
    page = setup_page(context, captured, errors)
    walk_wizard(page, base_url, "/add", fixture, masjid_name="E2E Test Masjid")

    payload = captured.get("submit")
    assert payload, "submit was never called"
    assert payload["data"]["mosque_name"] == "E2E Test Masjid", payload["data"].get("mosque_name")
    assert len(payload["data"]["rows"]) == 3, f"expected 3 rows, got {len(payload['data']['rows'])}"
    assert payload["data"]["rows"][0]["fajr_jamaat"], "review table lost the jama'at times"
    assert payload.get("image", "").startswith("data:image/"), "source image missing from submit"
    page.close()
    return errors


def test_update_flow(context, base_url, fixture):
    captured, errors = {}, []
    page = setup_page(context, captured, errors)
    walk_wizard(page, base_url, f"/update/{UPDATE_SLUG}", fixture)

    payload = captured.get("update")
    assert payload, "update was never called"
    assert payload["slug"] == UPDATE_SLUG, payload.get("slug")
    assert len(payload["data"]["rows"]) == 3, f"expected 3 rows, got {len(payload['data']['rows'])}"
    page.close()
    return errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", help="reuse a running dev server instead of starting wrangler")
    ap.add_argument("--headed", action="store_true", help="run with a visible browser")
    args = ap.parse_args()

    tmpdir = Path(tempfile.mkdtemp(prefix="iqamah-e2e-"))
    fixture = str(tmpdir / "timetable.png")
    make_fixture_image(fixture)

    proc = log = None
    base_url = args.base_url
    wrangler_log = tmpdir / "wrangler.log"
    if not base_url:
        base_url = f"http://127.0.0.1:{DEFAULT_PORT}"
        print(f"Starting wrangler pages dev on {base_url} (log: {wrangler_log})")
        proc, log = start_wrangler(DEFAULT_PORT, wrangler_log)
    try:
        wait_for_server(base_url)
        version = json.loads((ROOT / "version.json").read_text(encoding="utf-8-sig"))
        seed = (
            f"localStorage.setItem('iqamah-review-hint-dismissed','1');"
            f"localStorage.setItem('iqamah-last-seen-version','{version.get('version', '')}');"
        )

        failures = []
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headed)
            context = browser.new_context(service_workers="block")
            context.add_init_script(seed)

            for name, fn in [("add masjid", test_add_flow), ("update masjid", test_update_flow)]:
                try:
                    errors = fn(context, base_url, fixture)
                    js_errors = [e for e in errors if e.startswith("pageerror")]
                    if js_errors:
                        raise AssertionError("uncaught JS errors: " + "; ".join(js_errors[:3]))
                    print(f"PASS  {name}")
                except Exception as e:  # noqa: BLE001 - report and continue
                    print(f"FAIL  {name}: {e}")
                    failures.append(name)
            browser.close()

        if failures:
            print(f"\n{len(failures)} flow(s) failed: {', '.join(failures)}")
            if proc and wrangler_log.exists():
                print(f"wrangler log: {wrangler_log}")
            sys.exit(1)
        print("\nAll browser flows passed.")
    finally:
        if proc:
            stop_wrangler(proc)
        if log:
            log.close()


if __name__ == "__main__":
    main()
