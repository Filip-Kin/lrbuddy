"""Screenshot LR Buddy routes at phone and desktop widths, light and dark.

    bun run shots http://127.0.0.1:3000 crew-map --link /j/<token> /,/requests
    .venv/bin/python scripts/shots.py <base> <tag> (--admin | --link PATH) [routes] [--sizes phone,desktop]

Signs in first in every browser context, through the fake Auth emulator the local server runs
with (scripts/seedcodes.py): `--admin` as the seed's admin user, `--link` as a fresh user who
then opens a QR or invite link path (`/j/<crew token>`, `/t/<truck code>`, `/g/<green code>`,
`/i/<invite>`; the seed writes the QR links to `$DATA_DIR/seed-codes.json`). There is no password.
Writes /home/filip/preview-shots/lrbuddy/<tag>/<route>-<size>-<scheme>.png and
prints overflow_px per shot (must be 0) plus how many map tiles loaded.
Adapted from reference/shots.py.
"""
import argparse
import pathlib
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

import seedcodes

ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("tag")
ap.add_argument("routes", nargs="?", default="/")
who = ap.add_mutually_exclusive_group()
who.add_argument("--admin", action="store_true", help="the seed's admin user")
who.add_argument("--link", help="link path: /j/<crew token>, /t/<truck code>, /g/<green code>, /i/<invite>")
ap.add_argument("--name", default="Sam", help="session display name, so the crew name prompt stays closed")
ap.add_argument("--sizes", default="phone,desktop")
ap.add_argument("--schemes", default="light,dark")
args = ap.parse_args()

base = args.base.rstrip("/")
routes = [r if r.startswith("/") else "/" + r for r in args.routes.split(",") if r]
out = pathlib.Path("/home/filip/preview-shots/lrbuddy") / args.tag
out.mkdir(parents=True, exist_ok=True)
all_sizes = {"phone": (390, 844), "desktop": (1440, 900)}
sizes = {k: all_sizes[k] for k in args.sizes.split(",") if k in all_sizes}


def login(ctx, page):
    # The name keeps the crew name prompt closed.
    if not args.admin and not args.link:
        return
    named = {"displayName": args.name} if args.name else {}
    status = seedcodes.sign_in(ctx, base, {"link": args.link, **named} if args.link else {"admin": True})
    if status != 200:
        raise SystemExit(f"login failed: HTTP {status}")


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    for scheme in args.schemes.split(","):
        for size, (w, h) in sizes.items():
            ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, device_scale_factor=1)
            page = ctx.new_page()
            login(ctx, page)
            for path in routes:
                name = (path.strip("/").split("?")[0] or "home").replace("/", "_")
                try:
                    page.goto(base + path, wait_until="networkidle", timeout=45000)
                    if page.locator(".leaflet-container").count() > 0:
                        try:
                            page.wait_for_selector("img.leaflet-tile-loaded", timeout=10000)
                        except PWTimeout:
                            pass
                    page.wait_for_timeout(1200)
                    dest = out / f"{name}-{size}-{scheme}.png"
                    page.screenshot(path=str(dest), full_page=True)
                    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                    tiles = page.locator("img.leaflet-tile-loaded").count()
                    extra = f" tiles={tiles}" if page.locator(".leaflet-container").count() else ""
                    print(f"{dest.name:<44} overflow_px={over}{extra}")
                except Exception as e:  # noqa: BLE001 - report and keep going
                    print(f"{name}-{size}-{scheme}: FAILED {type(e).__name__}: {str(e)[:100]}")
            ctx.close()
    browser.close()
