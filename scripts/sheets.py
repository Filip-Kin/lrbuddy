"""Contact sheets of every screen, one sheet per role and colour scheme.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/sheets.py https://lrbuddy.filipkin.com <admin password>

Phone screens are shot at 390x844 with a 2x device scale factor (780 px wide on the sheet).
Laptop screens for green and admin are shot at 1440x900 at 1x. Output:
/home/filip/preview-shots/lrbuddy-sheets/<role>-<size>-<scheme>.png
"""
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip("/")
ADMIN = sys.argv[2]
OUT = pathlib.Path("/home/filip/preview-shots/lrbuddy-sheets")
RAW = OUT / "raw"
RAW.mkdir(parents=True, exist_ok=True)

ROLES = {
    "crew": {"login": {"code": "demo-crew-01", "displayName": "Filip"}, "routes": [
        ("/", "Map"), ("/request", "Request"), ("/requests", "Requests"), ("/lots", "Lots"), ("/cc", "Command center"), ("/settings", "Settings")],
        "sizes": ["phone"]},
    "driver": {"login": {"code": "TRUCK1", "displayName": "Filip"}, "routes": [
        ("/", "Queue"), ("/map", "Map"), ("/stock", "Stock"), ("/settings", "Settings")],
        "sizes": ["phone"]},
    "green": {"login": {"code": "EAST01", "displayName": "Filip"}, "routes": [
        ("/", "Map"), ("/requests", "Requests"), ("/lots", "Lots"), ("/photos", "Photos"), ("/crews", "Crews"), ("/trucks", "Trucks"), ("/broadcast", "Broadcast"), ("/stats", "Stats"), ("/access", "Access")],
        "sizes": ["phone", "laptop"]},
    "admin": {"login": {"code": ADMIN}, "routes": [
        ("/admin", "Event"), ("/admin/companies", "Companies"), ("/admin/crews", "Crews"), ("/admin/lots", "Lots"), ("/admin/photos", "Photos"), ("/admin/catalog", "Catalog"), ("/admin/export", "Export"), ("/admin/access", "Access")],
        "sizes": ["laptop"]},
    "plan": {"login": {"code": ADMIN}, "routes": [
        ("/plan/survey", "Survey"), ("/plan/blocks", "Blocks"), ("/plan/assignments", "Assignments"), ("/plan/print", "Print")],
        "sizes": ["laptop"]},
    "drive": {"login": {"code": ADMIN}, "routes": [("/plan/survey/drive", "Drive")], "sizes": ["phone"]},
    "login": {"login": None, "routes": [("/login", "Login")], "sizes": ["phone"]},
}
SIZES = {"phone": (390, 844, 2), "laptop": (1440, 900, 1)}
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)


def shoot() -> dict[tuple[str, str, str], list[tuple[str, pathlib.Path]]]:
    shots: dict[tuple[str, str, str], list[tuple[str, pathlib.Path]]] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for role, cfg in ROLES.items():
            for size in cfg["sizes"]:
                w, h, dsf = SIZES[size]
                for scheme in ("light", "dark"):
                    ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme,
                                              device_scale_factor=dsf, is_mobile=(size == "phone"), has_touch=(size == "phone"))
                    if cfg["login"]:
                        ctx.request.post(f"{BASE}/auth/login", data=json.dumps(cfg["login"]), headers={"content-type": "application/json"})
                    page = ctx.new_page()
                    for route, label in cfg["routes"]:
                        page.goto(BASE + route, wait_until="networkidle", timeout=60000)
                        if route == "/plan/print":
                            page.wait_for_selector("[data-print-ready]", state="attached", timeout=60000)
                        page.wait_for_timeout(1200)
                        dest = RAW / f"{role}-{size}-{scheme}-{label.lower().replace(' ', '_')}.png"
                        page.screenshot(path=str(dest))
                        shots.setdefault((role, size, scheme), []).append((label, dest))
                        print("shot", dest.name)
                    ctx.close()
        browser.close()
    return shots


def sheet(role: str, size: str, scheme: str, items: list[tuple[str, pathlib.Path]]) -> pathlib.Path:
    imgs = [(label, Image.open(p).convert("RGB")) for label, p in items]
    cols = 3 if size == "phone" else 2
    gap, cap = 40, 56
    tw, th = imgs[0][1].size
    rows = (len(imgs) + cols - 1) // cols
    bg = (14, 48, 56) if scheme == "dark" else (242, 243, 245)
    fg = (232, 238, 240) if scheme == "dark" else (14, 48, 56)
    W = gap + cols * (tw + gap)
    H = gap + 70 + rows * (th + cap + gap)
    out = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(out)
    d.text((gap, gap), f"LR Buddy  {role}  {size}  {scheme}", fill=fg, font=FONT)
    for i, (label, im) in enumerate(imgs):
        r, c = divmod(i, cols)
        x = gap + c * (tw + gap)
        y = gap + 70 + r * (th + cap + gap)
        d.text((x, y), label, fill=fg, font=FONT)
        out.paste(im, (x, y + cap))
        d.rectangle([x - 1, y + cap - 1, x + tw, y + cap + th], outline=(120, 130, 135), width=1)
    dest = OUT / f"{role}-{size}-{scheme}.png"
    out.save(dest, optimize=True)
    return dest


shots = shoot()
for key, items in shots.items():
    print("sheet", sheet(*key, items))
