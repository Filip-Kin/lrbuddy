"""Release gate. Every check here is a mistake that has shipped before.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/gate.py http://127.0.0.1:3000 <admin password>

Run from the repo root against a seeded server. Exit 1 on any failure.
Static checks read the tree; dynamic checks log in as each role and walk every route
at phone and laptop widths, light and dark. Screenshots land in
/home/filip/preview-shots/lrbuddy-gate/.
"""
import json
import os
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
    "driver": {"login": {"code": "TRUCK1", "displayName": "Gate"}, "routes": ["/", "/stock", "/settings"]},
    "green": {"login": {"code": "EAST01", "displayName": "Gate"}, "routes": ["/", "/requests", "/lots", "/photos", "/crews", "/trucks", "/broadcast", "/stats", "/access"]},
    "admin": {"login": {"code": ADMIN}, "routes": ["/admin", "/admin/companies", "/admin/crews", "/admin/lots", "/admin/photos", "/admin/catalog", "/admin/export",
                                                  "/admin/access", "/plan/survey", "/plan/blocks", "/plan/assignments", "/plan/print", "/plan/survey/drive"]},
}
SIZES = {"phone": (390, 844), "laptop": (1440, 900)}
# The planning portal is a laptop surface with one phone screen (drive mode). Other routes run at both sizes.
ROUTE_SIZES = {
    "/plan/survey": {"laptop"},
    "/plan/blocks": {"laptop"},
    "/plan/assignments": {"laptop"},
    "/plan/print": {"laptop"},
    "/plan/survey/drive": {"phone"},
}
# Documents, not screens: no hamburger check. Overflow still applies.
NO_NAV = {"/plan/print", "/login"}
# Print pages draw maps; the page sets [data-print-ready] once every tile has loaded.
PRINT_ROUTES = {"/plan/print"}
# Old paths that must land somewhere else, per role.
REDIRECTS = {"admin": {"/admin/print": "/plan/print"}, "driver": {"/map": "/"}}
# Driver home (SPEC 17): the next stop card plus the guidance banner stay under this share of the
# phone height, and the Queue button is at least this big.
DRIVER_CARD_MAX = 0.36
QUEUE_MIN_PX = 56
# The Lots toggle beside Recenter (SPEC 17) is a primary control on a moving truck.
LOTS_TOGGLE_MIN_PX = 44

DRIVER_HOME_JS = """() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e || e.offsetParent === null) return null;
    const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  return { card: box('[data-next-card]'), banner: box('[data-guidance]'), queue: box('[data-queue-button]'), lots: box('[data-lots-toggle]'), vh: window.innerHeight };
}"""

LUM_JS = """() => {
  const c = getComputedStyle(document.body).backgroundColor.match(/\\d+(\\.\\d+)?/g).map(Number);
  const [r,g,b] = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
  return 0.2126*r + 0.7152*g + 0.0722*b;
}"""

BUTTONS_JS = """() => [...document.querySelectorAll('button, a[role=button], [role=tab]')]
  .filter(b => b.offsetParent !== null)
  .map(b => { const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, t: (b.innerText||b.getAttribute('aria-label')||'').trim().slice(0,30) }; })
  .filter(b => b.h > 0)"""

# Printed maps: every label inside its map and clear of every other label (SPEC 16, 19), and the
# company sheets (SPEC 19): landscape, area names in pills, a lettered CC circle.
PRINT_MAPS_JS = """() => {
  const maps = [...document.querySelectorAll('.lrb-pm')].map(m => {
    const r = m.getBoundingClientRect();
    const labels = [...m.querySelectorAll('.lrb-pm-label')].map(l => {
      const b = l.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, t: l.innerText.trim().slice(0, 40), clip: l.scrollWidth > l.clientWidth + 1 };
    });
    return { name: m.getAttribute('aria-label') || '', x: r.left, y: r.top, w: r.width, h: r.height, labels };
  });
  const sheets = [...document.querySelectorAll('[data-sheet=company]')].map(s => {
    const r = s.getBoundingClientRect();
    return {
      w: r.width, h: r.height,
      pills: [...s.querySelectorAll('.lrb-pm-pill')].map(p => p.innerText.trim()),
      cc: [...s.querySelectorAll('.lrb-pm-ccb')].map(c => c.innerText.trim()),
      title: (s.querySelector('h2') || {}).innerText || '',
    };
  });
  return { maps, sheets };
}"""

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


LOGIN_JS = """() => {
  const visible = (el) => el.offsetParent !== null;
  const labels = [...document.querySelectorAll('label')].filter(visible).map(l => l.innerText.trim());
  const pick = (sel) => { const el = document.querySelector(sel); return el ? { visible: visible(el), fs: parseFloat(getComputedStyle(el).fontSize) } : null; };
  return {
    labels,
    phoneForm: !!document.querySelector('[data-phone-signin]'),
    tel: pick('input[type=tel][autocomplete=tel]'),
    otp: pick('input[inputmode=numeric][autocomplete="one-time-code"]'),
    staffLink: [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Staff password'),
  };
}"""


def login_checks(browser) -> None:
    """SPEC 18: nobody faces a Code box. Reads the page; never presses Continue, so no SMS is sent."""
    for scheme in ("light", "dark"):
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme=scheme, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        try:
            page.goto(BASE + "/login", wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(500)
        except Exception as e:  # noqa: BLE001
            fail(f"login-{scheme}: navigation failed {type(e).__name__}")
            ctx.close()
            continue
        info = page.evaluate(LOGIN_JS)
        for label in info["labels"]:
            if re.search(r"\bcode\b", label, re.I):
                fail(f"login-{scheme}: field labelled '{label}' on first paint")
        if info["phoneForm"] and not info["staffLink"]:
            fail(f"login-{scheme}: no Staff password link")
        if not info["phoneForm"] and not page.locator("input[type=password]").first.is_visible():
            fail(f"login-{scheme}: Firebase off and no password field on first paint")
        if info["phoneForm"]:
            tel, otp = info["tel"], info["otp"]
            if not tel or not tel["visible"]:
                fail(f"login-{scheme}: no visible input type=tel autocomplete=tel")
            elif tel["fs"] < 16:
                fail(f"login-{scheme}: phone field font-size {tel['fs']}px (<16)")
            if not otp:
                fail(f"login-{scheme}: no inputmode=numeric autocomplete=one-time-code field")
            else:
                if otp["visible"]:
                    fail(f"login-{scheme}: code field shows before Continue")
                if otp["fs"] < 16:
                    fail(f"login-{scheme}: code field font-size {otp['fs']}px (<16)")
        elif scheme == "light":
            warn("login: Firebase sign-in is off on this server (no phone form); phone field checks skipped")
        over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if over != 0:
            fail(f"login-{scheme}: horizontal overflow {over}px")
        page.screenshot(path=str(OUT / f"login-sign-in-phone-{scheme}.png"))
        if info["staffLink"]:
            page.get_by_role("button", name="Staff password").click()
            page.wait_for_timeout(200)
            field = page.locator("input[type=password]")
            if field.count() == 0 or not field.first.is_visible():
                fail(f"login-{scheme}: Staff password does not reveal a password field")
            page.screenshot(path=str(OUT / f"login-staff-password-phone-{scheme}.png"))
        ctx.close()


def dynamic_checks() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        login_checks(browser)
        only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
        for role, cfg in ROLES.items():
            if only and role not in only:
                continue
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
                    if size == "laptop" and scheme == "light":
                        for old, new in REDIRECTS.get(role, {}).items():
                            try:
                                page.goto(BASE + old, wait_until="networkidle", timeout=45000)
                                page.wait_for_timeout(300)
                                landed = page.evaluate("location.pathname")
                                if landed != new:
                                    fail(f"{role} {old}: landed on {landed}, expected {new}")
                            except Exception as e:  # noqa: BLE001
                                fail(f"{role} {old}: navigation failed {type(e).__name__}")
                    for route in cfg["routes"]:
                        if size not in ROUTE_SIZES.get(route, set(SIZES)):
                            continue
                        tag = f"{role}{route.replace('/', '_') or '_home'}-{size}-{scheme}"
                        errors.clear()
                        bad.clear()
                        try:
                            page.goto(BASE + route, wait_until="networkidle", timeout=45000)
                            if route in PRINT_ROUTES:
                                page.wait_for_selector("[data-print-ready]", state="attached", timeout=60000)
                            page.wait_for_timeout(700)
                        except Exception as e:  # noqa: BLE001
                            fail(f"{tag}: navigation failed {type(e).__name__}")
                            continue
                        page.screenshot(path=str(OUT / f"{tag}.png"), full_page=(route in PRINT_ROUTES))
                        if route in PRINT_ROUTES:
                            pm = page.evaluate(PRINT_MAPS_JS)
                            for m in pm["maps"]:
                                ls = m["labels"]
                                for i, l in enumerate(ls):
                                    if l["clip"]:
                                        fail(f"{tag}: label '{l['t']}' cut off inside its box on '{m['name']}'")
                                    if l["x"] < m["x"] - 0.5 or l["y"] < m["y"] - 0.5 or l["x"] + l["w"] > m["x"] + m["w"] + 0.5 or l["y"] + l["h"] > m["y"] + m["h"] + 0.5:
                                        fail(f"{tag}: label '{l['t']}' runs past the edge of '{m['name']}'")
                                    for o in ls[i + 1:]:
                                        if l["x"] < o["x"] + o["w"] - 0.5 and o["x"] < l["x"] + l["w"] - 0.5 and l["y"] < o["y"] + o["h"] - 0.5 and o["y"] < l["y"] + l["h"] - 0.5:
                                            fail(f"{tag}: labels '{l['t']}' and '{o['t']}' overlap on '{m['name']}'")
                            sheets = pm["sheets"]
                            if not sheets:
                                fail(f"{tag}: no company map sheet ([data-sheet=company])")
                            for sh in sheets:
                                if sh["w"] <= sh["h"]:
                                    fail(f"{tag}: company sheet '{sh['title']}' is not landscape ({sh['w']:.0f}x{sh['h']:.0f})")
                                if not sh["pills"]:
                                    fail(f"{tag}: company sheet '{sh['title']}' names no area on its map")
                                if len(sh["cc"]) != 1:
                                    fail(f"{tag}: company sheet '{sh['title']}' has {len(sh['cc'])} CC circles, expected 1")
                            if sheets and not any("&" in p for sh in sheets for p in sh["pills"]):
                                fail(f"{tag}: no company sheet shows a shared area label with '&' (the seed has one per CC)")
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
                        if role == "driver" and route == "/" and size == "phone":
                            dh = page.evaluate(DRIVER_HOME_JS)
                            if dh["card"] is None:
                                fail(f"{tag}: no [data-next-card] on the driver map")
                            else:
                                parts = [b for b in (dh["card"], dh["banner"]) if b]
                                if dh["banner"] is None:
                                    warn(f"{tag}: no [data-guidance] banner (no next stop?)")
                                top = min(b["top"] for b in parts)
                                bottom = max(b["bottom"] for b in parts)
                                share = (bottom - top) / dh["vh"]
                                if share >= DRIVER_CARD_MAX:
                                    fail(f"{tag}: next stop card plus banner cover {share:.0%} of the height (max {DRIVER_CARD_MAX:.0%})")
                            q = dh["queue"]
                            if q is None:
                                fail(f"{tag}: no [data-queue-button] on the driver map")
                            elif q["h"] < QUEUE_MIN_PX or q["w"] < QUEUE_MIN_PX:
                                fail(f"{tag}: Queue button is {q['w']:.0f}x{q['h']:.0f}px (<{QUEUE_MIN_PX})")
                            lt = dh["lots"]
                            if lt is None:
                                fail(f"{tag}: no [data-lots-toggle] on the driver map")
                            elif lt["h"] < LOTS_TOGGLE_MIN_PX or lt["w"] < LOTS_TOGGLE_MIN_PX:
                                fail(f"{tag}: Lots toggle is {lt['w']:.0f}x{lt['h']:.0f}px (<{LOTS_TOGGLE_MIN_PX})")
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
