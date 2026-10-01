"""Release gate. Every check here is a mistake that has shipped before.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/gate.py http://127.0.0.1:3000 <admin password>

Run from the repo root against a seeded server. Exit 1 on any failure.
Static checks read the tree; dynamic checks log in as each role and walk every route
at phone and laptop widths, light and dark. Screenshots land in
/home/filip/preview-shots/lrbuddy-gate/.
"""
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:3000"
ADMIN = sys.argv[2] if len(sys.argv) > 2 else None
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path("/home/filip/preview-shots/lrbuddy-gate")
OUT.mkdir(parents=True, exist_ok=True)

failures: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL  {msg}")


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"warn  {msg}")


# region Static checks

SRC_DIRS = ["server", "web/src", "web/index.html", "web/public", "README.md", "docs/SPEC.md", "CLAUDE.md"]
UI_DIRS = ["web/src"]


def files_under(paths: list[str], exts: tuple[str, ...]) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for p in paths:
        path = ROOT / p
        if path.is_file():
            out.append(path)
        elif path.is_dir():
            out += [f for f in path.rglob("*") if f.is_file() and f.suffix in exts and "node_modules" not in f.parts]
    return out


CODE_EXTS = (".ts", ".tsx", ".css", ".html", ".md", ".js", ".webmanifest", ".json")
UI_EXTS = (".ts", ".tsx", ".html")

BANNED_COPY = [
    r"\bYou can\b", r"\bHere you can\b", r"\bPick an?\b", r"\bHover\b", r"\bClick here\b",
    r"\bPlease\b", r"\bWe(?:'re| are| will)\b", r"\bYour\b.*\bhas been\b", r"\bSuccessfully\b",
    r"\bOops\b", r"\bWhoops\b", r"\bSomething went wrong\b(?!\.)",
]
BANNED_WORDS = [
    "leverage", "seamless", "robust", "delve", "utilize", "comprehensive", "cutting-edge",
    "game-changing", "innovative", "empower", "streamline",
]


def static_checks() -> None:
    for f in files_under(SRC_DIRS, CODE_EXTS):
        text = f.read_text(errors="ignore")
        rel = f.relative_to(ROOT)
        for i, line in enumerate(text.splitlines(), 1):
            if "—" in line or "–" in line:
                fail(f"{rel}:{i} em or en dash")
            if re.search(r"^\s*(//|#)\s*[-=*]{6,}", line):
                fail(f"{rel}:{i} decorative comment banner, use // #region")
            if f.suffix in (".ts", ".tsx"):
                if re.search(r"(:\s*any\b|\bas any\b|<any>|\bany\[\])", line) and "// gate-allow-any" not in line:
                    fail(f"{rel}:{i} any")
                if re.search(r"\bTODO\b|\bFIXME\b|\bXXX\b", line):
                    fail(f"{rel}:{i} TODO left in code")
            if f.suffix == ".md":
                low = line.lower()
                for w in BANNED_WORDS:
                    if re.search(rf"\b{re.escape(w)}\b", low):
                        fail(f"{rel}:{i} banned word '{w}'")
    for f in files_under(UI_DIRS, UI_EXTS + (".css",)):
        text = f.read_text(errors="ignore")
        rel = f.relative_to(ROOT)
        for i, line in enumerate(text.splitlines(), 1):
            if re.search(r"\b100vh\b", line):
                fail(f"{rel}:{i} 100vh, use 100dvh")
            if f.suffix in (".ts", ".tsx"):
                if re.search(r"console\.(log|debug)\(", line):
                    fail(f"{rel}:{i} console.log in client")
                for pat in BANNED_COPY:
                    if re.search(pat, line):
                        fail(f"{rel}:{i} copy reads as a sentence to the user: {line.strip()[:80]}")
                for w in BANNED_WORDS:
                    if re.search(rf"\b{w}\b", line, re.I):
                        fail(f"{rel}:{i} banned word '{w}'")
    html = (ROOT / "web/index.html").read_text(errors="ignore") if (ROOT / "web/index.html").exists() else ""
    if "width=device-width" not in html or "initial-scale=1" not in html:
        fail("web/index.html missing a proper viewport meta")
    if 'name="theme-color"' not in html:
        fail("web/index.html missing theme-color meta")
    if "manifest" not in html:
        fail("web/index.html missing manifest link")
    if "apple-touch-icon" not in html:
        fail("web/index.html missing apple-touch-icon (iOS ignores the manifest icons)")
    if "viewport-fit=cover" not in html:
        warn("viewport meta without viewport-fit=cover; safe-area insets will not apply when installed")
    manifest = ROOT / "web/public/manifest.webmanifest"
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            sizes = {i.get("sizes") for i in m.get("icons", [])}
            if not {"192x192", "512x512"} <= sizes:
                fail("manifest icons must include 192x192 and 512x512")
            if not any("maskable" in (i.get("purpose") or "") for i in m.get("icons", [])):
                fail("manifest has no maskable icon")
            if m.get("display") not in ("standalone", "fullscreen"):
                fail("manifest display must be standalone")
        except json.JSONDecodeError:
            fail("manifest.webmanifest is not valid JSON")
    else:
        fail("web/public/manifest.webmanifest missing")
    for name in ("web/public/sw.js", "Dockerfile", ".env.example", "README.md"):
        if not (ROOT / name).exists():
            fail(f"{name} missing")


# endregion

# region Dynamic checks

ROLES = {
    "anon": {"login": None, "routes": ["/login"]},
    "crew": {"login": {"code": "demo-crew-01", "displayName": "Gate"}, "routes": ["/", "/request", "/requests", "/lots", "/cc", "/settings"]},
    "driver": {"login": {"code": "TRUCK1", "displayName": "Gate"}, "routes": ["/", "/map", "/stock", "/settings"]},
    "green": {"login": {"code": "EAST01", "displayName": "Gate"}, "routes": ["/", "/requests", "/lots", "/photos", "/crews", "/trucks", "/broadcast", "/stats"]},
    "admin": {"login": {"code": ADMIN}, "routes": ["/admin", "/admin/companies", "/admin/crews", "/admin/lots", "/admin/photos", "/admin/catalog", "/admin/print", "/admin/export"]},
}
SIZES = {"phone": (390, 844), "laptop": (1440, 900)}
NO_NAV = {"/admin/print", "/login"}

LUM_JS = """() => {
  const c = getComputedStyle(document.body).backgroundColor.match(/\\d+(\\.\\d+)?/g).map(Number);
  const [r,g,b] = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
  return 0.2126*r + 0.7152*g + 0.0722*b;
}"""

BUTTONS_JS = """() => [...document.querySelectorAll('button, a[role=button], [role=tab]')]
  .filter(b => b.offsetParent !== null)
  .map(b => { const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, t: (b.innerText||b.getAttribute('aria-label')||'').trim().slice(0,30) }; })
  .filter(b => b.h > 0)"""

CAMERA_JS = """() => [...document.querySelectorAll('[data-camera]')]
  .filter(b => b.offsetParent !== null)
  .map(b => { const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, t: (b.getAttribute('aria-label')||b.innerText||'').trim().slice(0,40) }; })"""

VIEWER_JS = """() => { const v = document.querySelector('[data-viewer]'); if (!v) return null;
  const r = v.getBoundingClientRect();
  return { h: r.height, vh: window.innerHeight, cls: v.className }; }"""

GALLERY_ROUTES = {"/photos", "/admin/photos"}

INPUTS_JS = """() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea')]
  .filter(i => i.offsetParent !== null)
  .map(i => ({ fs: parseFloat(getComputedStyle(i).fontSize), n: i.name || i.id || i.placeholder || i.type }))"""


def dynamic_checks() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for role, cfg in ROLES.items():
            if role == "admin" and not ADMIN:
                warn("no admin password given, admin routes skipped")
                continue
            for scheme in ("light", "dark"):
                for size, (w, h) in SIZES.items():
                    ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme,
                                              device_scale_factor=1, has_touch=(size == "phone"),
                                              is_mobile=(size == "phone"))
                    if cfg["login"]:
                        r = ctx.request.post(f"{BASE}/auth/login", data=json.dumps(cfg["login"]),
                                             headers={"content-type": "application/json"})
                        if r.status >= 400:
                            fail(f"{role}: login returned {r.status}")
                            ctx.close()
                            continue
                    page = ctx.new_page()
                    errors: list[str] = []
                    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    bad: list[str] = []
                    page.on("response", lambda resp: bad.append(f"{resp.status} {resp.url}") if resp.status >= 400 and BASE in resp.url else None)
                    for route in cfg["routes"]:
                        tag = f"{role}{route.replace('/', '_') or '_home'}-{size}-{scheme}"
                        errors.clear()
                        bad.clear()
                        try:
                            page.goto(BASE + route, wait_until="networkidle", timeout=45000)
                            page.wait_for_timeout(700)
                        except Exception as e:  # noqa: BLE001
                            fail(f"{tag}: navigation failed {type(e).__name__}")
                            continue
                        page.screenshot(path=str(OUT / f"{tag}.png"), full_page=(route == "/admin/print"))
                        over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                        if over != 0:
                            fail(f"{tag}: horizontal overflow {over}px")
                        for e in errors:
                            fail(f"{tag}: console error: {e[:120]}")
                        for b in bad:
                            fail(f"{tag}: request failed: {b[:120]}")
                        text = page.evaluate("document.body.innerText")
                        if "—" in text:
                            fail(f"{tag}: em dash rendered on page")
                        if re.search(r"\b(undefined|null|NaN|\[object Object\])\b", text):
                            fail(f"{tag}: raw undefined/null/NaN in page text")
                        if re.search(r"\b(lorem|placeholder|TODO)\b", text, re.I):
                            fail(f"{tag}: placeholder text on page")
                        lum = page.evaluate(LUM_JS)
                        if scheme == "dark" and lum > 0.35:
                            fail(f"{tag}: dark mode is not dark (body luminance {lum:.2f})")
                        if scheme == "light" and lum < 0.5:
                            fail(f"{tag}: light mode is not light (body luminance {lum:.2f})")
                        for i in page.evaluate(INPUTS_JS):
                            if i["fs"] < 16:
                                fail(f"{tag}: input '{i['n']}' font-size {i['fs']}px (<16 makes iOS zoom on focus)")
                        for c in page.evaluate(CAMERA_JS):
                            if c["h"] < 44 or c["w"] < 44:
                                fail(f"{tag}: camera button '{c['t']}' is {c['w']:.0f}x{c['h']:.0f}px (<44)")
                        if route in GALLERY_ROUTES and size == "phone":
                            pair = page.locator("main li button").first
                            if pair.count() == 0:
                                fail(f"{tag}: gallery shows no pair to open")
                            else:
                                pair.click()
                                page.wait_for_timeout(900)
                                v = page.evaluate(VIEWER_JS)
                                if v is None:
                                    fail(f"{tag}: tapping a pair opened no [data-viewer]")
                                else:
                                    page.screenshot(path=str(OUT / f"{tag}-viewer.png"))
                                    if abs(v["h"] - v["vh"]) > 1:
                                        fail(f"{tag}: viewer is {v['h']:.0f}px tall, viewport {v['vh']}px")
                                    if "100dvh" not in v["cls"] or "safe-area-inset-bottom" not in v["cls"]:
                                        fail(f"{tag}: viewer lacks 100dvh height or safe-area padding")
                                    for b in page.evaluate(BUTTONS_JS):
                                        if b["h"] < 40 and len(b["t"]) > 1:
                                            fail(f"{tag}: viewer button '{b['t']}' is {b['h']:.0f}px tall (<40)")
                                    page.keyboard.press("Escape")
                                    page.wait_for_timeout(300)
                                    if page.evaluate(VIEWER_JS) is not None:
                                        fail(f"{tag}: Escape did not close the viewer")
                        if size == "phone" and route not in NO_NAV:
                            for b in page.evaluate(BUTTONS_JS):
                                if b["h"] < 40 and len(b["t"]) > 1:
                                    fail(f"{tag}: button '{b['t']}' is {b['h']:.0f}px tall (<40)")
                        if route in NO_NAV:
                            continue
                        burger = page.locator("button[aria-expanded]").first
                        if size == "phone":
                            if burger.count() == 0 or not burger.is_visible():
                                fail(f"{tag}: no hamburger button with aria-expanded at 390px")
                                continue
                            bb = burger.bounding_box() or {"x": 9999, "width": 0}
                            if bb["x"] + bb["width"] / 2 > w / 2:
                                fail(f"{tag}: hamburger is on the right (x={bb['x']:.0f}); it belongs on the left")
                            burger.click()
                            page.wait_for_timeout(250)
                            if burger.get_attribute("aria-expanded") != "true":
                                fail(f"{tag}: hamburger click did not set aria-expanded=true")
                            menu = page.locator("[data-menu]").first
                            if menu.count() == 0:
                                fail(f"{tag}: open menu has no [data-menu] panel")
                            else:
                                mb = menu.bounding_box() or {"x": 9999}
                                if mb["x"] > 1:
                                    fail(f"{tag}: menu panel opens from the right (x={mb['x']:.0f}); it slides in from the left")
                            page.keyboard.press("Escape")
                            page.wait_for_timeout(250)
                            if burger.get_attribute("aria-expanded") != "false":
                                fail(f"{tag}: Escape did not close the menu")
                            burger.click()
                            page.wait_for_timeout(250)
                            scrim = page.locator("[data-scrim]").first
                            if scrim.count() == 0:
                                fail(f"{tag}: open menu has no [data-scrim] element to tap")
                            else:
                                scrim.click(position={"x": 5, "y": 5}, force=True)
                                page.wait_for_timeout(250)
                                if burger.get_attribute("aria-expanded") != "false":
                                    fail(f"{tag}: scrim tap did not close the menu")
                        else:
                            if burger.count() > 0 and burger.is_visible():
                                fail(f"{tag}: hamburger visible at 1440px; links should be inline")
                    ctx.close()
        browser.close()


# endregion

static_checks()
dynamic_checks()
print()
print(f"{len(failures)} failures, {len(warnings)} warnings, screenshots in {OUT}")
sys.exit(1 if failures else 0)
