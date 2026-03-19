"""Generate Eid Mubarak greeting image from HTML template using Playwright."""

import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image

TEMPLATE = Path(__file__).parent / "templates" / "eid_mubarak.html"
OUTPUT = Path(__file__).parent / "output" / "eid_mubarak.png"

VIEWPORT_W = 540
VIEWPORT_H = 540
SCALE = 3  # 3x for crisp rendering → 1620x1620
FINAL_SIZE = (1080, 1080)


def main():
    OUTPUT.parent.mkdir(exist_ok=True)
    file_url = TEMPLATE.as_uri()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": VIEWPORT_W, "height": VIEWPORT_H},
            device_scale_factor=SCALE,
        )
        page.goto(file_url)
        page.wait_for_timeout(2000)  # Let Google Fonts load

        # Screenshot to temp file
        tmp = Path(tempfile.gettempdir()) / "eid_mubarak_raw.png"
        page.screenshot(path=str(tmp))
        browser.close()

    # Resize to final size
    img = Image.open(tmp)
    img = img.resize(FINAL_SIZE, Image.LANCZOS)
    img.save(str(OUTPUT), "PNG", optimize=True)
    tmp.unlink(missing_ok=True)

    print(f"Generated: {OUTPUT} ({FINAL_SIZE[0]}x{FINAL_SIZE[1]})")


if __name__ == "__main__":
    main()
