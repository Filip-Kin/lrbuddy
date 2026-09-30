"""Screenshot a set of pages at phone and desktop widths, light and dark.

    .venv/bin/python /tmp/shots.py http://127.0.0.1:8090 baseline

Writes /home/filip/preview-shots/<tag>/<page>-<size>-<scheme>.png
"""
import sys, pathlib
from playwright.sync_api import sync_playwright

base = sys.argv[1].rstrip("/")
tag = sys.argv[2] if len(sys.argv) > 2 else "shots"
pages = sys.argv[3].split(",") if len(sys.argv) > 3 else ["/", "/analytics", "/shorts", "/ep/55", "/ep/EV6", "/ep/56"]
out = pathlib.Path("/home/filip/preview-shots") / tag
out.mkdir(parents=True, exist_ok=True)
sizes = {"phone": (390, 844), "desktop": (1440, 900)}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    for scheme in ("light", "dark"):
        for size, (w, h) in sizes.items():
            ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme,
                                      device_scale_factor=1)
            page = ctx.new_page()
            for path in pages:
                name = (path.strip("/") or "home").replace("/", "_")
                try:
                    page.goto(base + path, wait_until="networkidle", timeout=45000)
                    page.wait_for_timeout(800)
                    dest = out / f"{name}-{size}-{scheme}.png"
                    page.screenshot(path=str(dest), full_page=True)
                    # horizontal overflow is the phone bug that started all this
                    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                    print(f"{dest.name:<40} overflow_px={over}")
                except Exception as e:
                    print(f"{name}-{size}-{scheme}: FAILED {type(e).__name__}: {str(e)[:80]}")
            ctx.close()
    browser.close()
