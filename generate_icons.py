"""Generate PWA icons from salahdaily_icon.png."""

from pathlib import Path
from PIL import Image

ICON_SRC = Path("salahdaily_icon.png")
ICONS_DIR = Path("icons")
BG_COLOR = (5, 12, 24)  # #050c18


def create_icon(src_img, size, padding_fraction=0.0):
    """Create a square icon with the source image centred on a dark background."""
    canvas = Image.new("RGBA", (size, size), (*BG_COLOR, 255))

    if padding_fraction > 0:
        inner_size = int(size * (1 - padding_fraction * 2))
    else:
        inner_size = size

    resized = src_img.resize((inner_size, inner_size), Image.LANCZOS)

    offset = (size - inner_size) // 2
    canvas.paste(resized, (offset, offset), resized if resized.mode == "RGBA" else None)

    return canvas.convert("RGB") if resized.mode != "RGBA" else canvas


def main():
    ICONS_DIR.mkdir(exist_ok=True)

    src = Image.open(ICON_SRC)

    # Standard icons — no extra padding
    create_icon(src, 192).save(ICONS_DIR / "icon-192.png")
    create_icon(src, 512).save(ICONS_DIR / "icon-512.png")

    # Maskable icons — 10% padding on each side for the 80% safe zone
    create_icon(src, 192, padding_fraction=0.1).save(ICONS_DIR / "icon-maskable-192.png")
    create_icon(src, 512, padding_fraction=0.1).save(ICONS_DIR / "icon-maskable-512.png")

    # Apple touch icon
    create_icon(src, 180).save(ICONS_DIR / "apple-touch-icon.png")

    print("Generated icons:")
    for f in sorted(ICONS_DIR.glob("*.png")):
        img = Image.open(f)
        print(f"  {f.name}: {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    main()
