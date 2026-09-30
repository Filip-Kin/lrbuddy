"""Render web/public/icons/*.svg to the PNG sizes the manifest names.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/render_icons.py

ImageMagick on the build box has no SVG delegate, so Chromium does the drawing.
"""
import pathlib
from playwright.sync_api import sync_playwright

icons = pathlib.Path(__file__).resolve().parent.parent / "web" / "public" / "icons"
jobs = [("icon.svg", "icon-192.png", 192), ("icon.svg", "icon-512.png", 512),
        ("maskable.svg", "maskable-512.png", 512), ("badge.svg", "badge-96.png", 96)]

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    for src, dest, size in jobs:
        page = browser.new_page(viewport={"width": size, "height": size}, device_scale_factor=1)
        svg = (icons / src).read_text()
        page.set_content(f'<html><body style="margin:0;background:transparent">'
                         f'<div style="width:{size}px;height:{size}px">{svg.replace("<svg ", f"<svg width={size} height={size} ", 1)}</div></body></html>')
        page.screenshot(path=str(icons / dest), omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
        page.close()
        print(dest)
    browser.close()
