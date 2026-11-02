"""Build the drag-to-Applications macOS installer image.

Produces a DMG whose Finder window shows Haven.app on the left, an arrow, and
an Applications shortcut on the right. Background art is generated with Pillow
so this script has no image assets to maintain. dmgbuild writes the .DS_Store
layout without driving Finder, which keeps it reliable on headless CI runners.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import tempfile

import dmgbuild
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 660, 420
APP_POSITION = (170, 235)
APPLICATIONS_POSITION = (490, 235)


def _font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for path in candidates:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default(size)


def _draw_background(scale):
    width, height = WIDTH * scale, HEIGHT * scale
    image = Image.new("RGB", (width, height), "#0b1a26")
    pixels = image.load()
    for y in range(height):
        ratio = y / max(1, height - 1)
        for x in range(0, width, max(1, scale * 4)):
            for offset in range(min(scale * 4, width - x)):
                blend = 0.10 + 0.10 * ratio + 0.04 * (x / max(1, width))
                pixels[x + offset, y] = (
                    int(11 + 10 * blend),
                    int(26 + 24 * blend),
                    int(38 + 38 * blend),
                )
    draw = ImageDraw.Draw(image, "RGBA")

    # Soft light pools, matching the app's frosted backdrop.
    for cx, cy, radius, color in (
        (WIDTH * 0.16, HEIGHT * 0.05, WIDTH * 0.6, (64, 150, 206, 34)),
        (WIDTH * 0.92, HEIGHT * 0.95, WIDTH * 0.55, (102, 120, 216, 28)),
    ):
        draw.ellipse(
            [cx * scale - radius * scale, cy * scale - radius * scale,
             cx * scale + radius * scale, cy * scale + radius * scale],
            fill=color,
        )

    logo = Path(__file__).resolve().parents[1] / "docs" / "logo.png"
    if logo.is_file():
        icon = Image.open(logo).convert("RGBA").resize((72 * scale, 72 * scale), Image.Resampling.LANCZOS)
        image.paste(icon, (int(WIDTH * 0.5 * scale - 36 * scale), int(38 * scale)), icon)

    title = "将 Haven 拖入「应用程序」"
    subtitle = "Drag Haven into Applications to install"
    draw.text((WIDTH * 0.5 * scale, 128 * scale), title, font=_font(21 * scale), fill=(234, 247, 255, 255), anchor="mm")
    draw.text((WIDTH * 0.5 * scale, 156 * scale), subtitle, font=_font(12 * scale), fill=(170, 202, 220, 255), anchor="mm")

    # Arrow between the app and the Applications shortcut.
    y = APP_POSITION[1] * scale
    start_x, end_x = 292 * scale, 378 * scale
    shaft = 7 * scale
    draw.rectangle([start_x, y - shaft // 2, end_x - 18 * scale, y + shaft // 2], fill=(143, 216, 255, 210))
    draw.polygon(
        [
            (end_x, y),
            (end_x - 24 * scale, y - 17 * scale),
            (end_x - 24 * scale, y + 17 * scale),
        ],
        fill=(143, 216, 255, 220),
    )
    return image


def build(app, output, version, volume_name=None):
    app = Path(app).resolve()
    output = Path(output).resolve()
    if not app.is_dir():
        raise SystemExit(f"Haven.app 不存在：{app}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="haven-dmg-") as temp:
        background = Path(temp) / "background.png"
        _draw_background(1).save(background)
        _draw_background(2).save(Path(temp) / "background@2x.png")
        settings = {
            "files": [str(app)],
            "symlinks": {"Applications": "/Applications"},
            "icon_locations": {"Haven.app": APP_POSITION, "Applications": APPLICATIONS_POSITION},
            "background": str(background),
            "window_rect": ((120, 120), (WIDTH, HEIGHT)),
            "default_view": "icon-view",
            "show_status_bar": False,
            "show_tab_view": False,
            "show_toolbar": False,
            "show_pathbar": False,
            "show_sidebar": False,
            "icon_size": 112,
            "text_size": 13,
            "format": "UDZO",
            "filesystem": "HFS+",
        }
        dmgbuild.build_dmg(str(output), volume_name or f"Haven {version}", settings=settings)
    return output


def main():
    parser = argparse.ArgumentParser(description="Build Haven-mac-arm64.dmg")
    parser.add_argument("--app", default="dist/Haven.app")
    parser.add_argument("--output", default="dist/Haven-mac-arm64.dmg")
    parser.add_argument("--version", default=Path("version.txt").read_text(encoding="utf-8").strip())
    args = parser.parse_args()
    output = build(args.app, args.output, args.version)
    print(output)


if __name__ == "__main__":
    main()
