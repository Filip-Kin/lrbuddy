"""Release gate. Every check here is a mistake that has shipped before.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/gate.py http://127.0.0.1:3000

Run from the repo root against a seeded server that signs in through the fake Auth emulator
(`bun tests/e2e/support/fake-auth.ts 9297`, server with FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9297;
CLAUDE.md "Commands"). Admin is the seed's admin user (SPEC 26). Exit 1 on any failure.
Static checks read the tree; dynamic checks log in as each role and walk every route
at phone and laptop widths, light and dark. Screenshots land in
/home/filip/preview-shots/lrbuddy-gate/.
"""
import gzip
import json
import urllib.parse
import os
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

import seedcodes

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:3000"
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


# First paint (Filip, 2026-10-01, on 5G): the entry script and everything index.html preloads with it
# stay under this gzipped, and none of it is Leaflet; the maps load in their role's chunk.
ENTRY_MAX_GZ_KB = 150


def bundle_checks() -> None:
    dist = ROOT / "web/dist"
    html_path = dist / "index.html"
    if not html_path.exists():
        fail("web/dist/index.html missing; run bun run build")
        return
    html = html_path.read_text(errors="ignore")
    entry = re.findall(r'<script type="module"[^>]*src="(/assets/[^"]+\.js)"', html)
    preloads = re.findall(r'<link rel="modulepreload"[^>]*href="(/assets/[^"]+\.js)"', html)
    if not entry:
        fail("web/dist/index.html has no module entry script")
        return
    total = 0
    for rel in entry + preloads:
        data = (dist / rel.lstrip("/")).read_bytes()
        total += len(gzip.compress(data, 9))
        if b"leaflet-pane" in data:
            fail(f"{rel}: Leaflet is in the entry chunk's critical path")
    kb = total / 1024
    print(f"entry chunk {', '.join(r.rsplit('/', 1)[-1] for r in entry + preloads)}: {kb:.1f} KB gzipped")
    if kb >= ENTRY_MAX_GZ_KB:
        fail(f"entry chunk is {kb:.1f} KB gzipped (>= {ENTRY_MAX_GZ_KB} KB)")
    if 'data-error-panel' not in html:
        fail("web/index.html has no boot error panel; a module that throws on load leaves a blank page")


# endregion

# region Dynamic checks

ROLES = {
    "anon": {"login": None, "routes": ["/login"]},
    "crew": {"login": {"seed": ("crew", "FORD 1", "East", 1), "displayName": "Gate"}, "routes": ["/", "/request", "/requests", "/lots", "/cc", "/settings"]},
    "driver": {"login": {"seed": ("driver", "Truck 1", "East", 1), "displayName": "Gate"}, "routes": ["/", "/stock", "/settings"]},
    "green": {"login": {"seed": ("green", "CC East", "East", 1), "displayName": "Gate"}, "routes": ["/", "/wrap", "/flag", "/requests", "/photos", "/crews", "/trucks", "/broadcast", "/stats", "/access", "/invite"]},
    "admin": {"login": {"admin": True}, "routes": ["/admin", "/admin/companies", "/admin/crews", "/admin/lots", "/admin/photos", "/admin/catalog", "/admin/export",
                                                  "/admin/access", "/admin/invite", "/admin/people", "/admin/client-errors", "/plan/survey", "/plan/blocks", "/plan/assignments", "/plan/print", "/plan/survey/drive"]},
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
    password: document.querySelectorAll('input[type=password]').length,
    staffText: document.body.innerText.includes('Staff password'),
  };
}"""


def login_checks(browser) -> None:
    """SPEC 18: nobody faces a Code box. Reads the page; never presses Continue, so no SMS is sent.

    SPEC 26: no staff password. `POST /auth/login` is not a route (404) for a password, a truck
    code, a green code or a crew token; each code signs in only through its own QR link.
    """
    ctx = browser.new_context()
    for role, name, cc, day in (("driver", "Truck 1", "East", 1), ("green", "CC East", "East", 1), ("crew", "FORD 1", "East", 1)):
        code = seedcodes.find(role, name, cc, day)["code"]
        r = ctx.request.post(f"{BASE}/auth/login", data=json.dumps({"code": code}), headers={"content-type": "application/json"})
        if r.status != 404:
            fail(f"login: {role} code posted to /auth/login answered {r.status} (expected 404)")
    for pw_guess in ("change-me", "admin"):
        r = ctx.request.post(f"{BASE}/auth/login", data=json.dumps({"code": pw_guess}), headers={"content-type": "application/json"})
        if r.status != 404:
            fail(f"login: a password posted to /auth/login answered {r.status} (expected 404)")
    ctx.close()
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
        if info["password"] or info["staffText"]:
            fail(f"login-{scheme}: a password field or Staff password on the sign-in page")
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
            warn("login: no phone form in this web build (no Firebase web config); phone field checks skipped")
        over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if over != 0:
            fail(f"login-{scheme}: horizontal overflow {over}px")
        page.screenshot(path=str(OUT / f"login-sign-in-phone-{scheme}.png"))
        ctx.close()


def dynamic_checks() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        login_checks(browser)
        only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
        for role, cfg in ROLES.items():
            if only and role not in only:
                continue
            for scheme in ("light", "dark"):
                for size, (w, h) in SIZES.items():
                    ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme,
                                              device_scale_factor=1, has_touch=(size == "phone"),
                                              is_mobile=(size == "phone"))
                    if cfg["login"]:
                        r_status = seedcodes.sign_in(ctx, BASE, cfg["login"])
                        if r_status != 200:
                            fail(f"{role}: login returned {r_status}")
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
                        # "Todo" is a parcel status (SPEC 21); a leftover marker is written TODO in the source text.
                        # textContent, not innerText: a table header set in capitals by CSS reads "TODO" in innerText.
                        if re.search(r"\b(lorem|placeholder)\b", text, re.I) or re.search(r"\bTODO\b", page.evaluate("document.body.textContent") or ""):
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

# region One parcel status (SPEC 21)
# As a green shirt at zoom 17: tap a parcel with no lot, the sheet opens, Todo, the outline turns
# red, and a reload still shows it red. The parcel is put back to Not todo afterwards, which
# deletes the lot again (nobody worked on it), so the check leaves the data as it found it.

PARCEL_PICK_JS = """() => {
  const map = document.querySelector('.leaflet-container').getBoundingClientRect();
  const cx = map.left + map.width / 2, cy = map.top + map.height / 2;
  let best = null;
  for (const el of document.querySelectorAll('[data-parcel]')) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < map.left + 60 || x > map.right - 160 || y < map.top + 130 || y > map.bottom - 110) continue;
    // Only a parcel that is what a tap there would hit (not under the CC marker or a pill).
    if (document.elementFromPoint(x, y) !== el) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.d) best = { d, pid: el.getAttribute('data-parcel') };
  }
  return best && best.pid;
}"""

PARCEL_AT_JS = """(sel) => { const el = document.querySelector(sel); if (!el) return null;
  const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }"""

LOT_FILL_JS = """(pid) => { const el = document.querySelector(`[data-lot-parcel="${pid}"]`); if (!el) return null;
  return { cls: el.getAttribute('class') || '', fill: getComputedStyle(el).fill }; }"""

ZOOM_JS = "() => Number(document.querySelector('.leaflet-container').dataset.zoom || 0)"
RED = "rgb(229, 72, 77)"
RED_DARK = "rgb(255, 107, 107)"


def parcel_status_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "green" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1, color_scheme="light")
        r_status = seedcodes.sign_in(ctx, BASE, ROLES["green"]["login"])
        if r_status != 200:
            fail(f"green parcel status: login returned {r_status}")
            ctx.close()
            browser.close()
            return
        page = ctx.new_page()
        pid = None
        try:
            page.goto(BASE + "/", wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(800)
            for _ in range(8):
                if page.evaluate(ZOOM_JS) >= 16:
                    break
                page.locator(".leaflet-control-zoom-in").click()
                page.wait_for_timeout(450)
            pid = page.evaluate(PARCEL_PICK_JS)
            if not pid:
                fail("green /: no bare parcel ([data-parcel]) drawn at zoom 16")
            else:
                sel = f'[data-parcel="{pid}"]'
                for _ in range(10):
                    if page.evaluate(ZOOM_JS) >= 17:
                        break
                    at = page.evaluate(PARCEL_AT_JS, sel)
                    page.mouse.move(at["x"], at["y"])
                    page.mouse.wheel(0, -120)
                    page.wait_for_timeout(500)
                if page.evaluate(ZOOM_JS) < 17:
                    fail(f"green /: map did not reach zoom 17 (at {page.evaluate(ZOOM_JS)})")
                at = page.evaluate(PARCEL_AT_JS, sel)
                page.mouse.click(at["x"], at["y"])
                page.wait_for_timeout(500)
                todo = page.locator('[role=dialog] [data-status="open"]')
                if todo.count() == 0:
                    fail(f"green /: tapping bare parcel {pid} opened no sheet with Todo")
                else:
                    todo.first.click()
                    ok = False
                    for _ in range(20):
                        page.wait_for_timeout(300)
                        lot = page.evaluate(LOT_FILL_JS, pid)
                        if lot and "lrb-lot-shape-open" in lot["cls"] and lot["fill"] == RED:
                            ok = True
                            break
                    page.screenshot(path=str(OUT / "green_parcel_todo-laptop-light.png"))
                    if not ok:
                        fail(f"green /: parcel {pid} did not turn red after Todo")
                    page.reload(wait_until="networkidle", timeout=45000)
                    page.wait_for_timeout(800)
                    lot = page.evaluate(LOT_FILL_JS, pid)
                    if not lot or "lrb-lot-shape-open" not in lot["cls"] or lot["fill"] != RED:
                        fail(f"green /: parcel {pid} is not red after a reload ({lot})")
        except Exception as e:  # noqa: BLE001
            fail(f"green parcel status: {type(e).__name__} {str(e)[:120]}")
        finally:
            if pid:
                res = ctx.request.post(f"{BASE}/trpc/green.setLotStatus", data=json.dumps({"json": {"parcelId": pid, "status": "not_todo"}}),
                                       headers={"content-type": "application/json"})
                if res.status >= 400:
                    warn(f"green parcel status: could not put parcel {pid} back to Not todo ({res.status})")
        ctx.close()
        browser.close()


# endregion

# region Flag screen (SPEC 22)
# At 390x844 the Todo shutter is at least 84 px and Do not touch 56 px (the only side button: no
# Wrong lot), with no overflow and no yellow frame over the camera.
# With a fake camera and the phone placed on a bare parcel: Todo makes the lot Todo with a Before
# photo. Undo then takes the parcel back to bare, so the data is left as it was.
# Map strip: about 28 % of the height (accepted 20 to 36 %), Expand and Collapse at least 44 px, the
# picked parcel outlined in yellow inside the strip. A tap on another parcel in the strip picks it and
# shows Clear (44 px); Clear goes back to the aimed parcel. Expanded the map takes most of the screen,
# the camera pauses, the flag buttons give way to the paint bar, a reload keeps it expanded, and
# Collapse brings the strip, the camera and the buttons back. Light and dark screenshots of both.
SHUTTER_MIN_PX = 84
SIDE_MIN_PX = 56
STRIP_MIN, STRIP_MAX = 0.20, 0.36
EXPAND_MIN_PX = 44

STRIP_JS = """() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const strip = document.querySelector('[data-flag-strip]');
  const pick = strip ? strip.querySelector('[data-flag-pick]') : null;
  const v = document.querySelector('[data-flag] video');
  const z = strip ? strip.querySelector('.leaflet-container') : null;
  return { strip: box(strip), expand: box(document.querySelector('[data-flag-expand]')),
           mode: (strip && strip.querySelector('[data-flag-map]') || {}).dataset?.flagMap || '',
           pick: box(pick), pickKey: pick ? pick.getAttribute('data-flag-pick') : null,
           zoom: z ? Number(z.dataset.zoom || 0) : 0, paused: v ? v.paused : null,
           vh: window.innerHeight };
}"""

# Bare parcels whose centre sits well inside the expanded map, away from its corners and buttons.
OTHER_PARCELS_JS = """(skip) => {
  const s = document.querySelector('[data-flag-strip]').getBoundingClientRect();
  const out = [];
  for (const el of document.querySelectorAll('[data-flag-strip] [data-parcel]')) {
    const id = el.getAttribute('data-parcel'); if (id === skip) continue;
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (r.width < 12 || r.height < 12) continue;
    if (x < s.left + 60 || x > s.right - 60 || y < s.top + 70 || y > s.bottom - 70) continue;
    out.push({ id, x, y, d: Math.hypot(x - (s.left + s.width / 2), y - (s.top + s.height / 2)) });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 6);
}"""

FLAG_BOXES_JS = """() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; };
  return { shutter: box(document.querySelector('[data-flag-shutter]')),
           sides: [...document.querySelectorAll('[data-flag-side]')].map(box),
           target: (document.querySelector('[data-flag-target] p') || {}).textContent || '',
           wrong: [...document.querySelectorAll('[data-flag] button')].filter((e) => e.textContent.trim() === 'Wrong lot').length,
           frame: [...document.querySelectorAll('[data-flag-camera] *')].filter((e) => getComputedStyle(e).borderTopColor === 'rgb(253, 221, 8)' && parseFloat(getComputedStyle(e).borderTopWidth) > 0).length,
           clear: box(document.querySelector('[data-flag-clear]')),
           bar: !!document.querySelector('[data-paint-bar]'),
           shutterShown: !!document.querySelector('[data-flag-shutter]') && document.querySelector('[data-flag-shutter]').offsetParent !== null,
           over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}"""


def trpc_get(ctx, path: str, inp=None):
    url = f"{BASE}/trpc/{path}"
    if inp is not None:
        url += "?input=" + urllib.parse.quote(json.dumps({"json": inp}))
    body = ctx.request.get(url).json()
    if "error" in body:
        raise RuntimeError(f"{path}: {str(body['error'])[:120]}")
    return body["result"]["data"]["json"]


def flag_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "green" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium",
                                     args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, has_touch=True, is_mobile=True,
                                  permissions=["camera", "geolocation"], geolocation={"latitude": 42.0, "longitude": -83.0})
        r_status = seedcodes.sign_in(ctx, BASE, ROLES["green"]["login"])
        if r_status != 200:
            fail(f"green /flag: login returned {r_status}")
            ctx.close()
            browser.close()
            return
        page = ctx.new_page()
        pid = None
        try:
            bare = trpc_get(ctx, "green.parcels")
            if not bare:
                fail("green /flag: no bare parcel in the CC's day area to flag")
            else:
                p = bare[len(bare) // 2]
                pid = p["parcelId"]
                ctx.set_geolocation({"latitude": p["lat"], "longitude": p["lng"], "accuracy": 5})
                page.goto(BASE + "/flag", wait_until="domcontentloaded", timeout=45000)
                page.wait_for_selector("[data-flag-shutter]", timeout=20000)
                page.wait_for_timeout(2500)
                b = page.evaluate(FLAG_BOXES_JS)
                page.screenshot(path=str(OUT / "green_flag-phone-light.png"))
                if not b["shutter"] or min(b["shutter"]["w"], b["shutter"]["h"]) < SHUTTER_MIN_PX:
                    fail(f"green /flag: shutter is {b['shutter']} (<{SHUTTER_MIN_PX}px)")
                if len(b["sides"]) != 1 or any(not sd or sd["h"] < SIDE_MIN_PX for sd in b["sides"]):
                    fail(f"green /flag: side buttons {b['sides']} (want Do not touch only, {SIDE_MIN_PX}px tall)")
                if b["wrong"]:
                    fail("green /flag: Wrong lot button still shown")
                if b["frame"]:
                    fail("green /flag: yellow frame over the camera")
                if b["over"] > 0:
                    fail(f"green /flag: horizontal overflow {b['over']}px")
                if b["target"] == "No parcel":
                    fail(f"green /flag: no parcel picked at parcel {pid}'s centre")
                st = page.evaluate(STRIP_JS)
                if not st["strip"] or not (STRIP_MIN <= st["strip"]["h"] / st["vh"] <= STRIP_MAX):
                    fail(f"green /flag: map strip is {st['strip']} of {st['vh']}px (want {STRIP_MIN:.0%} to {STRIP_MAX:.0%})")
                if st["mode"] != "strip":
                    fail(f"green /flag: map opens as {st['mode']!r}, not the strip")
                if not st["expand"] or min(st["expand"]["w"], st["expand"]["h"]) < EXPAND_MIN_PX:
                    fail(f"green /flag: Expand is {st['expand']} (<{EXPAND_MIN_PX}px)")
                if abs(st["zoom"] - 18) > 0.01:
                    fail(f"green /flag: strip zoom is {st['zoom']}, not 18")
                sb, pk = st["strip"], st["pick"]
                if not pk or st["pickKey"] != f"p:{pid}":
                    fail(f"green /flag: picked parcel p:{pid} not outlined in the strip (got {st['pickKey']})")
                elif not sb or pk["x"] + pk["w"] < sb["x"] or pk["x"] > sb["x"] + sb["w"] or pk["y"] + pk["h"] < sb["y"] or pk["y"] > sb["y"] + sb["h"]:
                    fail(f"green /flag: yellow outline {pk} is outside the strip {sb}")
                else:
                    stroke = page.evaluate("() => getComputedStyle(document.querySelector('[data-flag-strip] [data-flag-pick]')).stroke")
                    if stroke != "rgb(253, 221, 8)":
                        fail(f"green /flag: picked outline stroke is {stroke}, not yellow")
                page.locator("[data-flag-shutter]").click()
                lot = None
                for _ in range(40):
                    page.wait_for_timeout(500)
                    lots = trpc_get(ctx, "green.overview")["lots"]
                    lot = next((x for x in lots if x["parcelId"] == pid), None)
                    if lot:
                        photos = trpc_get(ctx, "shared.lotPhotos", {"lotId": lot["id"]})
                        listed = photos if isinstance(photos, list) else photos.get("photos", [])
                        if any(ph.get("kind") == "before" for ph in listed):
                            break
                else:
                    lot = lot or None
                if not lot or lot["status"] != "open":
                    fail(f"green /flag: parcel {pid} is not a Todo lot after the shutter ({lot and lot['status']})")
                else:
                    photos = trpc_get(ctx, "shared.lotPhotos", {"lotId": lot["id"]})
                    listed = photos if isinstance(photos, list) else photos.get("photos", [])
                    if not any(ph.get("kind") == "before" for ph in listed):
                        fail(f"green /flag: lot {lot['id']} has no Before photo after the shutter")
                page.screenshot(path=str(OUT / "green_flag_done-phone-light.png"))
                undo = page.locator("[data-flag-undo]")
                if undo.count() == 0:
                    fail("green /flag: no Undo on the last-flag card")
                else:
                    undo.click()
                    back = False
                    for _ in range(20):
                        page.wait_for_timeout(500)
                        if any(x["parcelId"] == pid for x in trpc_get(ctx, "green.parcels")):
                            back = True
                            break
                    if back:
                        aimed = pid
                        pid = None
                        flag_expand_checks(page, aimed, "light")
                    else:
                        fail(f"green /flag: Undo did not take parcel {pid} back to Not todo")
        except Exception as e:  # noqa: BLE001
            fail(f"green /flag: {type(e).__name__} {str(e)[:120]}")
        finally:
            if pid:
                ctx.request.post(f"{BASE}/trpc/green.setLotStatus", data=json.dumps({"json": {"parcelId": pid, "status": "not_todo"}}),
                                 headers={"content-type": "application/json"})
        ctx.close()
        # Dark: the strip and the expanded map, screenshots only plus overflow.
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, has_touch=True, is_mobile=True, color_scheme="dark",
                                  permissions=["camera", "geolocation"], geolocation={"latitude": 42.0, "longitude": -83.0})
        try:
            seedcodes.sign_in(ctx, BASE, ROLES["green"]["login"])
            bare = trpc_get(ctx, "green.parcels")
            if bare:
                p = bare[len(bare) // 2]
                ctx.set_geolocation({"latitude": p["lat"], "longitude": p["lng"], "accuracy": 5})
                page = ctx.new_page()
                page.goto(BASE + "/flag", wait_until="domcontentloaded", timeout=45000)
                page.wait_for_selector("[data-flag-shutter]", timeout=20000)
                page.wait_for_timeout(2500)
                page.screenshot(path=str(OUT / "green_flag-phone-dark.png"))
                page.locator("[data-flag-expand]").click()
                page.wait_for_timeout(1500)
                page.screenshot(path=str(OUT / "green_flag_expanded-phone-dark.png"))
                b = page.evaluate(FLAG_BOXES_JS)
                if b["over"] > 0:
                    fail(f"green /flag dark expanded: horizontal overflow {b['over']}px")
                page.locator("[data-flag-expand]").click()
                page.wait_for_timeout(500)
        except Exception as e:  # noqa: BLE001
            fail(f"green /flag dark: {type(e).__name__} {str(e)[:120]}")
        ctx.close()
        browser.close()


def flag_expand_checks(page, aimed: str, scheme: str) -> None:
    """Tap another parcel in the strip, Clear; Expand (paint), reload, Collapse. Nothing is flagged."""
    picked_other = None
    for c in page.evaluate(OTHER_PARCELS_JS, aimed):
        page.mouse.click(c["x"], c["y"])
        page.wait_for_timeout(500)
        if page.evaluate(STRIP_JS)["pickKey"] == f"p:{c['id']}":
            picked_other = c["id"]
            break
    if not picked_other:
        fail("green /flag: a tap on another parcel in the strip did not pick it")
    else:
        b = page.evaluate(FLAG_BOXES_JS)
        page.screenshot(path=str(OUT / f"green_flag_tap-phone-{scheme}.png"))
        if not b["clear"] or min(b["clear"]["w"], b["clear"]["h"]) < EXPAND_MIN_PX:
            fail(f"green /flag: Clear is {b['clear']} (<{EXPAND_MIN_PX}px)")
        else:
            page.locator("[data-flag-clear]").click()
            page.wait_for_timeout(400)
            if page.evaluate(STRIP_JS)["pickKey"] != f"p:{aimed}":
                fail("green /flag: Clear did not go back to the aimed parcel")
    page.locator("[data-flag-expand]").click()
    page.wait_for_timeout(1200)
    st = page.evaluate(STRIP_JS)
    b = page.evaluate(FLAG_BOXES_JS)
    page.screenshot(path=str(OUT / f"green_flag_expanded-phone-{scheme}.png"))
    if st["mode"] != "full" or not st["strip"] or st["strip"]["h"] < 0.5 * st["vh"]:
        fail(f"green /flag: Expand left the map at {st['strip']} ({st['mode']!r})")
    if st["paused"] is not True:
        fail(f"green /flag: camera not paused with the map full screen (paused={st['paused']})")
    if not st["expand"] or min(st["expand"]["w"], st["expand"]["h"]) < EXPAND_MIN_PX:
        fail(f"green /flag: Collapse is {st['expand']} (<{EXPAND_MIN_PX}px)")
    if not b["bar"] or b["shutterShown"]:
        fail(f"green /flag expanded: paint bar {b['bar']}, shutter shown {b['shutterShown']} (want the bar, no shutter)")
    if b["over"] > 0:
        fail(f"green /flag expanded: horizontal overflow {b['over']}px")
    page.reload(wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-flag-strip]", timeout=20000)
    page.wait_for_timeout(1500)
    if page.evaluate(STRIP_JS)["mode"] != "full" or not page.evaluate(FLAG_BOXES_JS)["bar"]:
        fail("green /flag: the expanded map did not come back expanded and painting after a reload")
    page.locator("[data-flag-expand]").click()
    page.wait_for_timeout(1200)
    st = page.evaluate(STRIP_JS)
    b = page.evaluate(FLAG_BOXES_JS)
    if st["mode"] != "strip" or not st["strip"] or not (STRIP_MIN <= st["strip"]["h"] / st["vh"] <= STRIP_MAX):
        fail(f"green /flag: Collapse left the map at {st['strip']} ({st['mode']!r})")
    if st["paused"] is not False:
        fail(f"green /flag: camera did not resume after Collapse (paused={st['paused']})")
    if b["bar"] or not b["shutterShown"]:
        fail(f"green /flag: after Collapse paint bar {b['bar']}, shutter shown {b['shutterShown']}")
    if st["pickKey"] != f"p:{aimed}":
        fail(f"green /flag: after Collapse the pick is {st['pickKey']}, not the aimed p:{aimed}")


# endregion

# region Driver Stock: Expected control (SPEC 20)
# Each stock row's "of 30 cases" opens the Expected sheet. A driver taps it at the truck,
# so it is a primary control: at least 44 px tall. Opens one sheet, never saves.
EXPECTED_MIN_PX = 44

EXPECTED_JS = """() => [...document.querySelectorAll('[data-expected]')]
  .filter(b => b.offsetParent !== null)
  .map(b => { const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, t: (b.getAttribute('aria-label')||'').slice(0,40) }; })"""


def stock_expected_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "driver" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, has_touch=True, is_mobile=True)
        r_status = seedcodes.sign_in(ctx, BASE, ROLES["driver"]["login"])
        if r_status != 200:
            fail(f"driver stock expected: login returned {r_status}")
        else:
            page = ctx.new_page()
            try:
                page.goto(BASE + "/stock", wait_until="networkidle", timeout=45000)
                page.wait_for_timeout(500)
                rows = page.evaluate(EXPECTED_JS)
                if not rows:
                    fail("driver /stock: no Expected control ([data-expected]) on the stock rows")
                for b in rows:
                    if b["h"] < EXPECTED_MIN_PX:
                        fail(f"driver /stock: Expected control '{b['t']}' is {b['h']:.0f}px tall (<{EXPECTED_MIN_PX})")
                if rows:
                    page.locator("[data-expected]").first.click()
                    page.wait_for_timeout(300)
                    if page.locator("[role=dialog] [data-expected-input]").count() == 0:
                        fail("driver /stock: Expected sheet did not open with a number field")
                    page.keyboard.press("Escape")
            except Exception as e:  # noqa: BLE001
                fail(f"driver /stock expected: {type(e).__name__}")
        ctx.close()
        browser.close()


# endregion

# region Paint mode (SPEC 23)
# As CC Webb's green link (the real day) at 1440 and 390: Paint opens the brush bar with chips at least
# 44 px tall, a mouse drag across three neighbouring bare parcels at zoom 17 makes them Todo with the
# counter reading "3 lots", and Undo takes them back to bare. Overflow 0. Undo leaves the data as found.
PAINT_GREEN = {"seed": ("green", "CC Webb", "Webb", 4), "displayName": "Gate"}
CHIP_MIN_PX = 44

PAINT_TRIPLE_JS = """() => {
  const map = document.querySelector('.leaflet-container').getBoundingClientRect();
  const bar = document.querySelector('[data-paint-bar]');
  const bottom = bar ? bar.getBoundingClientRect().top - 10 : map.bottom - 10;
  const legend = document.querySelector('[data-legend]');
  const lr = legend ? legend.getBoundingClientRect() : null;
  const pts = [];
  for (const el of document.querySelectorAll('[data-parcel]')) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < map.left + 50 || x > map.right - 50 || y < map.top + 50 || y > bottom) continue;
    if (lr && x > lr.left - 10 && y < lr.bottom + 10) continue;
    if (document.elementFromPoint(x, y) !== el) continue;
    pts.push({ x, y, pid: el.getAttribute('data-parcel'), el });
  }
  const cx = map.left + map.width / 2, cy = (map.top + bottom) / 2;
  pts.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  const clean = (path, ok) => {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2);
      for (let k = 0; k <= n; k++) {
        const e = document.elementFromPoint(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
        if (!e) return false;
        if (e.hasAttribute('data-lot-id') || e.hasAttribute('data-lot-parcel')) return false;
        if (e.hasAttribute('data-parcel') && !ok.has(e.getAttribute('data-parcel'))) return false;
      }
    }
    return true;
  };
  for (const p of pts.slice(0, 40)) {
    const near = pts.filter((q) => q !== p).map((q) => ({ q, d: Math.hypot(q.x - p.x, q.y - p.y) })).sort((a, b) => a.d - b.d);
    for (const { q, d } of near.slice(0, 4)) {
      if (d > 90) break;
      const tx = q.x + (q.x - p.x), ty = q.y + (q.y - p.y);
      const r = pts.find((o) => o !== p && o !== q && Math.hypot(o.x - tx, o.y - ty) < d * 0.35);
      if (!r) continue;
      const ok = new Set([p.pid, q.pid, r.pid]);
      if (clean([p, q, r], ok)) return [p, q, r].map(({ x, y, pid }) => ({ x, y, pid }));
    }
  }
  return null;
}"""

PAINT_STATE_JS = """() => ({
  bar: !!document.querySelector('[data-paint-bar]'),
  count: (document.querySelector('[data-paint-count]') || {}).textContent || '',
  zoomLabel: !!document.querySelector('[data-paint-zoom]'),
  chips: [...document.querySelectorAll('[data-brush]')].map((e) => e.getBoundingClientRect().height),
  over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
})"""


def zoom_to(page, sel: str, target: float) -> None:
    for _ in range(12):
        if page.evaluate(ZOOM_JS) >= target:
            return
        at = page.evaluate(PARCEL_AT_JS, sel)
        if not at:
            return
        page.mouse.move(at["x"], at["y"])
        page.mouse.wheel(0, -120)
        page.wait_for_timeout(450)


def paint_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "green" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for size, (w, h) in SIZES.items():
            tag = f"green paint {size}"
            phone = size == "phone"
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="light", is_mobile=phone, has_touch=phone)
            r_status = seedcodes.sign_in(ctx, BASE, PAINT_GREEN)
            if r_status != 200:
                fail(f"{tag}: CC Webb login returned {r_status}")
                ctx.close()
                continue
            page = ctx.new_page()
            painted: list[str] = []
            try:
                page.goto(BASE + "/", wait_until="networkidle", timeout=45000)
                page.wait_for_timeout(800)
                page.locator("[data-paint]").first.click()
                page.wait_for_timeout(400)
                st = page.evaluate(PAINT_STATE_JS)
                if not st["bar"]:
                    fail(f"{tag}: Paint opened no brush bar")
                    continue
                small = [round(c) for c in st["chips"] if c < CHIP_MIN_PX]
                if len(st["chips"]) < 5 or small:
                    fail(f"{tag}: brush chips {len(st['chips'])}, under {CHIP_MIN_PX}px: {small}")
                page.wait_for_timeout(600)
                first = page.evaluate(PARCEL_PICK_JS)
                if not first:
                    fail(f"{tag}: no bare parcel drawn while painting")
                    continue
                zoom_to(page, f'[data-parcel="{first}"]', 17)
                if page.evaluate(ZOOM_JS) < 17:
                    fail(f"{tag}: map did not reach zoom 17")
                if page.evaluate(PAINT_STATE_JS)["zoomLabel"]:
                    fail(f"{tag}: 'Zoom in to paint' still showing at zoom 17")
                page.wait_for_timeout(500)
                tri = page.evaluate(PAINT_TRIPLE_JS)
                if not tri:
                    fail(f"{tag}: no three neighbouring bare parcels in a row at zoom 17")
                    continue
                page.locator('[data-brush="open"]').click()
                p, q, rr = tri
                page.mouse.move(p["x"], p["y"])
                page.mouse.down()
                page.mouse.move(q["x"], q["y"], steps=8)
                page.mouse.move(rr["x"], rr["y"], steps=8)
                page.mouse.up()
                painted = [t["pid"] for t in tri]
                ok = False
                for _ in range(20):
                    page.wait_for_timeout(300)
                    reds = [page.evaluate(LOT_FILL_JS, pid) for pid in painted]
                    if all(x and "lrb-lot-shape-open" in x["cls"] and x["fill"] == RED for x in reds):
                        ok = True
                        break
                st = page.evaluate(PAINT_STATE_JS)
                page.screenshot(path=str(OUT / f"green_paint-{size}-light.png"))
                if not ok:
                    fail(f"{tag}: the three painted parcels did not turn red Todo")
                if st["count"].strip() != "3 lots":
                    fail(f"{tag}: counter reads '{st['count']}', expected '3 lots'")
                if st["over"] != 0:
                    fail(f"{tag}: horizontal overflow {st['over']}px")
                page.locator("[data-paint-undo]").click()
                back = False
                for _ in range(20):
                    page.wait_for_timeout(300)
                    if all(page.locator(f'[data-parcel="{pid}"]').count() > 0 for pid in painted):
                        back = True
                        break
                page.screenshot(path=str(OUT / f"green_paint_undo-{size}-light.png"))
                if not back:
                    fail(f"{tag}: Undo did not return the three parcels to Not todo")
                else:
                    painted = []
                page.locator("[data-paint-exit]").click()
            except Exception as e:  # noqa: BLE001
                fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
            finally:
                for pid in painted:
                    ctx.request.post(f"{BASE}/trpc/green.setLotStatus", data=json.dumps({"json": {"parcelId": pid, "status": "not_todo"}}),
                                     headers={"content-type": "application/json"})
                ctx.close()
        browser.close()


# Flag screen, Paint on the expanded map (SPEC 22). As CC Webb's green on /flag at 390x844, light and
# dark: the strip has no paint bar; Expand opens the paint bar at once (no brush chips, the Do not
# touch switch at 44 px, off) in place of the flag buttons, zoom 18; a drag over three bare parcels
# sets them Todo with "3 lots"; the same drag again sets them back to Not todo; Undo twice returns
# them; the Do not touch switch turns on and off; Collapse ends paint mode and leaves the strip.
# Overflow 0. Undo leaves the data as found.
FLAG_PAINT_JS = """() => {
  const vis = (el) => !!el && el.offsetParent !== null;
  const box = (el) => { if (!vis(el)) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; };
  const strip = document.querySelector('[data-flag-strip]');
  const dnt = document.querySelector('[data-flag-dnt-brush]');
  return { bar: !!document.querySelector('[data-paint-bar]'),
           dnt: box(dnt), dntOn: dnt ? dnt.getAttribute('aria-pressed') : null,
           shutter: vis(document.querySelector('[data-flag-shutter]')),
           sides: [...document.querySelectorAll('[data-flag-side]')].filter(vis).length,
           mode: (strip && strip.querySelector('[data-flag-map]') || {}).dataset?.flagMap || '',
           zoom: Number((document.querySelector('[data-flag-strip] .leaflet-container') || { dataset: {} }).dataset.zoom || 0),
           over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}"""


def flag_paint_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "green" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium",
                                     args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        for scheme in ("light", "dark"):
            tag = f"green /flag paint {scheme}"
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, has_touch=True, is_mobile=True, color_scheme=scheme,
                                      permissions=["camera", "geolocation"], geolocation={"latitude": 42.0, "longitude": -83.0})
            r_status = seedcodes.sign_in(ctx, BASE, PAINT_GREEN)
            if r_status != 200:
                fail(f"{tag}: CC Webb login returned {r_status}")
                ctx.close()
                continue
            page = ctx.new_page()
            painted: list[str] = []

            def statuses() -> list[str]:
                lots = trpc_get(ctx, "green.overview")["lots"]
                return [next((x["status"] for x in lots if x["parcelId"] == pid), "bare") for pid in painted]

            def wait_for(want: list[str]) -> bool:
                for _ in range(30):
                    page.wait_for_timeout(300)
                    if statuses() == want:
                        return True
                return False

            try:
                bare = trpc_get(ctx, "green.parcels")
                if not bare:
                    fail(f"{tag}: no bare parcel at the CC")
                    continue
                p = bare[len(bare) // 2]
                ctx.set_geolocation({"latitude": p["lat"], "longitude": p["lng"], "accuracy": 5})
                page.goto(BASE + "/flag", wait_until="domcontentloaded", timeout=45000)
                page.wait_for_selector("[data-flag-shutter]", timeout=20000)
                page.wait_for_timeout(2000)
                st = page.evaluate(FLAG_PAINT_JS)
                if st["mode"] != "strip" or st["bar"]:
                    fail(f"{tag}: the strip paints ({st['mode']!r}, bar={st['bar']})")
                page.locator("[data-flag-expand]").click()
                page.wait_for_timeout(1500)
                st = page.evaluate(FLAG_PAINT_JS)
                ps = page.evaluate(PAINT_STATE_JS)
                if not st["bar"]:
                    fail(f"{tag}: Expand opened no paint bar")
                    continue
                if st["shutter"] or st["sides"]:
                    fail(f"{tag}: flag buttons still showing with the paint bar (shutter={st['shutter']}, sides={st['sides']})")
                if ps["chips"]:
                    fail(f"{tag}: the Flag paint bar shows {len(ps['chips'])} brush chips (want none)")
                if not st["dnt"] or min(st["dnt"]["w"], st["dnt"]["h"]) < CHIP_MIN_PX or st["dntOn"] != "false":
                    fail(f"{tag}: Do not touch switch {st['dnt']} pressed={st['dntOn']} (want {CHIP_MIN_PX}px, off)")
                if abs(st["zoom"] - 18) > 0.01:
                    fail(f"{tag}: expanded map zoom is {st['zoom']}, not 18")
                tri = page.evaluate(PAINT_TRIPLE_JS)
                if not tri:
                    fail(f"{tag}: no three neighbouring bare parcels in a row at zoom 18")
                    continue

                def stroke() -> None:
                    a, b, c = tri
                    page.mouse.move(a["x"], a["y"])
                    page.mouse.down()
                    page.mouse.move(b["x"], b["y"], steps=8)
                    page.mouse.move(c["x"], c["y"], steps=8)
                    page.mouse.up()

                stroke()
                painted = [t["pid"] for t in tri]
                ok = False
                for _ in range(20):
                    page.wait_for_timeout(300)
                    reds = [page.evaluate(LOT_FILL_JS, pid) for pid in painted]
                    if all(x and "lrb-lot-shape-open" in x["cls"] and x["fill"] == (RED if scheme == "light" else RED_DARK) for x in reds):
                        ok = True
                        break
                ps = page.evaluate(PAINT_STATE_JS)
                page.screenshot(path=str(OUT / f"green_flag_paint-phone-{scheme}.png"))
                if not ok:
                    fail(f"{tag}: the three painted parcels did not turn red Todo")
                if not wait_for(["open"] * 3):
                    fail(f"{tag}: the painted parcels are {statuses()} on the server, not Todo")
                if ps["count"].strip() != "3 lots":
                    fail(f"{tag}: counter reads '{ps['count']}', expected '3 lots'")
                if ps["over"] != 0:
                    fail(f"{tag}: horizontal overflow {ps['over']}px")
                stroke()
                if not wait_for(["bare"] * 3):
                    fail(f"{tag}: the same stroke again left {statuses()}, not Not todo")
                page.locator("[data-flag-dnt-brush]").click()
                page.wait_for_timeout(300)
                st = page.evaluate(FLAG_PAINT_JS)
                page.screenshot(path=str(OUT / f"green_flag_paint_dnt-phone-{scheme}.png"))
                if st["dntOn"] != "true":
                    fail(f"{tag}: Do not touch switch did not turn on")
                page.locator("[data-flag-dnt-brush]").click()
                page.wait_for_timeout(300)
                if page.evaluate(FLAG_PAINT_JS)["dntOn"] != "false":
                    fail(f"{tag}: Do not touch switch did not turn off")
                page.locator("[data-paint-undo]").click()
                if not wait_for(["open"] * 3):
                    fail(f"{tag}: Undo of the second stroke left {statuses()}")
                page.wait_for_timeout(400)
                page.locator("[data-paint-undo]").click()
                if wait_for(["bare"] * 3):
                    painted = []
                else:
                    fail(f"{tag}: Undo of the first stroke left {statuses()}")
                page.locator("[data-flag-expand]").click()
                page.wait_for_timeout(1200)
                st = page.evaluate(FLAG_PAINT_JS)
                b2 = page.evaluate(FLAG_BOXES_JS)
                if st["mode"] != "strip" or st["bar"] or not st["shutter"]:
                    fail(f"{tag}: Collapse left map {st['mode']!r}, bar={st['bar']}, shutter={st['shutter']}")
                if b2["over"] > 0:
                    fail(f"{tag}: horizontal overflow after Collapse {b2['over']}px")
            except Exception as e:  # noqa: BLE001
                fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
            finally:
                for pid in painted:
                    ctx.request.post(f"{BASE}/trpc/green.setLotStatus", data=json.dumps({"json": {"parcelId": pid, "status": "not_todo"}}),
                                     headers={"content-type": "application/json"})
                ctx.close()
        browser.close()


# endregion

# region Draw lot (SPEC 24)
# As CC Webb's green at zoom 17 on a phone and a laptop: Draw lot, four taps round a thin strip across
# neighbouring parcels, Close, Save; the lot appears red, is on the driver's lot list (Truck B1),
# and a tap on it opens its sheet with Delete lot. Overflow 0. The lot is deleted afterwards.
DRAW_DRIVER = {"seed": ("driver", "Truck B1", "Webb", 4), "displayName": "Gate"}

LOT_BOX_JS = """(id) => { const el = document.querySelector(`[data-lot-id="${id}"]`); if (!el) return null;
  const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2,
  cls: el.getAttribute('class') || '', fill: getComputedStyle(el).fill }; }"""


def draw_lot_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "green" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for size, (w, h) in SIZES.items():
            tag = f"green draw lot {size}"
            phone = size == "phone"
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="light", is_mobile=phone, has_touch=phone)
            r_status = seedcodes.sign_in(ctx, BASE, PAINT_GREEN)
            if r_status != 200:
                fail(f"{tag}: CC Webb login returned {r_status}")
                ctx.close()
                continue
            page = ctx.new_page()
            made = None
            try:
                page.goto(BASE + "/", wait_until="networkidle", timeout=45000)
                page.wait_for_timeout(800)
                for _ in range(8):
                    if page.evaluate(ZOOM_JS) >= 16:
                        break
                    page.locator(".leaflet-control-zoom-in").click()
                    page.wait_for_timeout(450)
                first = page.evaluate(PARCEL_PICK_JS)
                if not first:
                    fail(f"{tag}: no bare parcel to zoom on")
                    continue
                zoom_to(page, f'[data-parcel="{first}"]', 17)
                page.wait_for_timeout(500)
                tri = page.evaluate(PAINT_TRIPLE_JS)
                if not tri:
                    fail(f"{tag}: no three neighbouring parcels for the strip")
                    continue
                a, _, b = tri
                dx, dy = b["x"] - a["x"], b["y"] - a["y"]
                ln = max((dx * dx + dy * dy) ** 0.5, 1)
                # 28 px wide: the fourth tap must clear the first point's 44 px hit box, or it closes the shape.
                nx, ny = -dy / ln * 14, dx / ln * 14
                corners = [(a["x"] + nx, a["y"] + ny), (b["x"] + nx, b["y"] + ny), (b["x"] - nx, b["y"] - ny), (a["x"] - nx, a["y"] - ny)]
                before = {l["id"] for l in trpc_get(ctx, "green.lots")["lots"]}
                page.locator("[data-draw-lot]").click()
                page.wait_for_timeout(300)
                if page.locator("[data-draw-lot-bar]").count() == 0:
                    fail(f"{tag}: Draw lot shows no bar")
                    continue
                for x, y in corners:
                    page.mouse.click(x, y)
                    page.wait_for_timeout(350)
                if page.locator("[data-draw-vertex]").count() != 4:
                    fail(f"{tag}: four taps left {page.locator('[data-draw-vertex]').count()} points")
                page.locator("[data-draw-close]").click()
                save = page.locator("[data-draw-lot-save]")
                save.wait_for(state="visible", timeout=5000)
                page.wait_for_function("() => { const b = document.querySelector('[data-draw-lot-save]'); return b && !b.disabled; }", timeout=8000)
                over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if over != 0:
                    fail(f"{tag}: horizontal overflow {over}px with the Save sheet open")
                page.screenshot(path=str(OUT / f"green_draw_lot_sheet-{size}-light.png"))
                name = page.locator('[role=dialog] input').first.input_value()
                save.click()
                for _ in range(20):
                    page.wait_for_timeout(300)
                    new = [l for l in trpc_get(ctx, "green.lots")["lots"] if l["id"] not in before]
                    if new:
                        made = new[0]
                        break
                if not made:
                    fail(f"{tag}: Save made no lot")
                    continue
                if made["source"] != "drawn" or made["parcelId"] is not None or made["status"] != "open":
                    fail(f"{tag}: new lot is {made['source']} {made['parcelId']} {made['status']}, expected a drawn Todo lot")
                red = None
                for _ in range(20):
                    page.wait_for_timeout(300)
                    red = page.evaluate(LOT_BOX_JS, made["id"])
                    if red and "lrb-lot-shape-open" in red["cls"] and red["fill"] == RED:
                        break
                if not red or red["fill"] != RED:
                    fail(f"{tag}: drawn lot not drawn red ({red})")
                dctx = browser.new_context()
                dr_status = seedcodes.sign_in(dctx, BASE, DRAW_DRIVER)
                if dr_status != 200 or not any(l["id"] == made["id"] for l in trpc_get(dctx, "driver.lots")["lots"]):
                    fail(f"{tag}: drawn lot {made['id']} not on Truck B1's lot list")
                dctx.close()
                if red:
                    page.mouse.click(red["x"], red["y"])
                    page.wait_for_timeout(600)
                    title = page.locator("[role=dialog] h2").first.text_content() if page.locator("[role=dialog] h2").count() else ""
                    if (title or "").strip() != name.strip() or page.locator("[data-delete-lot]").count() == 0:
                        fail(f"{tag}: tapping the drawn lot opened '{title}', expected '{name}' with Delete lot")
                over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if over != 0:
                    fail(f"{tag}: horizontal overflow {over}px")
                page.screenshot(path=str(OUT / f"green_draw_lot-{size}-light.png"))
            except Exception as e:  # noqa: BLE001
                fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
            finally:
                if made:
                    res = ctx.request.post(f"{BASE}/trpc/green.deleteLot", data=json.dumps({"json": {"lotId": made["id"]}}), headers={"content-type": "application/json"})
                    if res.status >= 400:
                        warn(f"{tag}: could not delete drawn lot {made['id']} ({res.status})")
                ctx.close()
        browser.close()


# Crash visibility: a screen that throws shows the error panel (title, the error, Reload and Back at
# 44 px), not a blank page, and the report reaches /admin/client-errors.
def crash_checks() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for scheme in ("light", "dark"):
            tag = f"crash-test-phone-{scheme}"
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme=scheme, is_mobile=True, has_touch=True, device_scale_factor=1)
            r_status = seedcodes.sign_in(ctx, BASE, {"admin": True})
            if r_status != 200:
                fail(f"{tag}: admin login returned {r_status}")
                ctx.close()
                continue
            page = ctx.new_page()
            try:
                page.goto(BASE + "/admin/client-errors", wait_until="networkidle", timeout=45000)
                page.goto(BASE + "/admin/client-errors/test", wait_until="networkidle", timeout=45000)
                page.wait_for_selector("[data-error-panel]", timeout=10000)
                info = page.evaluate("""() => {
                  const p = document.querySelector('[data-error-panel]');
                  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; };
                  const btn = (name) => [...p.querySelectorAll('button')].find((b) => b.textContent.trim() === name);
                  return { title: p.querySelector('h2')?.textContent, msg: p.querySelector('[data-error-message]')?.textContent,
                           reload: box(btn('Reload')), back: box(btn('Back')), nav: !!document.querySelector('button[aria-expanded]'),
                           over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
                }""")
                if info["title"] != "Screen failed":
                    fail(f"{tag}: panel title is {info['title']!r}")
                if "Crash test" not in (info["msg"] or ""):
                    fail(f"{tag}: panel does not show the error ({info['msg']!r})")
                for name in ("reload", "back"):
                    if not info[name] or info[name]["h"] < 44:
                        fail(f"{tag}: {name} button is {info[name]} (<44px)")
                if not info["nav"]:
                    fail(f"{tag}: the nav is gone with the crashed screen")
                if info["over"] != 0:
                    fail(f"{tag}: horizontal overflow {info['over']}px")
                page.screenshot(path=str(OUT / f"{tag}.png"))
                found = False
                for _ in range(20):
                    page.wait_for_timeout(250)
                    rows = trpc_get(ctx, "admin.clientErrors")
                    if any("Crash test" in r["message"] and r["role"] == "admin" and r["url"] == "/admin/client-errors/test" for r in rows):
                        found = True
                        break
                if not found:
                    fail(f"{tag}: the crash never reached admin.clientErrors")
                page.locator("[data-error-panel] button", has_text="Back").click()
                page.wait_for_timeout(800)
                if page.evaluate("location.pathname") != "/admin/client-errors" or page.locator("[data-error-panel]").count() != 0:
                    fail(f"{tag}: Back did not return to a working screen")
                elif page.locator("[data-client-error]").count() == 0:
                    fail(f"{tag}: /admin/client-errors lists no report")
                page.screenshot(path=str(OUT / f"admin_client-errors-list-phone-{scheme}.png"))
            except Exception as e:  # noqa: BLE001
                fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
            finally:
                ctx.close()
        browser.close()


# region Switch (SPEC 27)
# The scope chip opens Switch: a bottom sheet at 390, a popover under the chip at 1440, light and dark,
# with screenshots. CC Webb's green shirt (Day 4) takes Driver for Truck B1 from the chip and comes back
# with no reload; the same person paints three bare parcels Todo on the driver map and Undo takes them
# back; Sign out lands on /login and stays there; the admin switches to Day 1 CC East green, then Day 4
# Truck B1, then back to Admin.

SWITCH_JS = """() => {
  const d = [...document.querySelectorAll('[role=dialog]')].find((e) => (e.getAttribute('aria-label') || e.innerText).includes('Switch'));
  const chip = document.querySelector('[data-scope-chip]');
  if (!d || !chip) return null;
  const r = d.getBoundingClientRect(), c = chip.getBoundingClientRect();
  const rows = [...d.querySelectorAll('[data-switch-role], [data-switch-admin], [data-switch] button')].map((b) => b.getBoundingClientRect().height);
  return { top: r.top, bottom: r.bottom, w: r.width, chipBottom: c.bottom, vh: innerHeight, popover: !!document.querySelector('[data-switch-popover]'),
    rows, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: d.innerText };
}"""


def open_switch(page, tag: str) -> dict | None:
    page.locator("[data-scope-chip]").click()
    try:
        page.wait_for_selector("[data-switch]", timeout=15000)
    except Exception:  # noqa: BLE001
        fail(f"{tag}: the scope chip opened no Switch")
        return None
    page.wait_for_timeout(400)
    return page.evaluate(SWITCH_JS)


def pick_role(page, name: str, day: str | None = None, cc: str | None = None) -> None:
    panel = page.get_by_role("dialog", name="Switch")
    if day:
        panel.get_by_role("radiogroup", name="Day").get_by_role("radio", name=re.compile(rf"^{re.escape(day)}\b")).click()
    if cc:
        panel.get_by_role("radiogroup", name="Command center").get_by_role("radio", name=cc, exact=True).click()
    panel.locator("[data-switch-role]").filter(has_text=re.compile(rf"^{re.escape(name)}")).first.click()
    page.wait_for_timeout(1200)


def chip_text(page) -> str:
    return page.locator("[data-scope-chip]").inner_text().strip()


def switch_checks() -> None:
    only = {r for r in os.environ.get("GATE_ROLES", "").split(",") if r}
    if only and "green" not in only:
        return
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        # The panel at both sizes and both schemes.
        for scheme in ("light", "dark"):
            for size, (w, h) in SIZES.items():
                tag = f"switch {size} {scheme}"
                phone = size == "phone"
                ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, is_mobile=phone, has_touch=phone)
                if seedcodes.sign_in(ctx, BASE, PAINT_GREEN) != 200:
                    fail(f"{tag}: CC Webb login failed")
                    ctx.close()
                    continue
                page = ctx.new_page()
                try:
                    page.goto(BASE + "/", wait_until="networkidle", timeout=45000)
                    page.wait_for_timeout(600)
                    st = open_switch(page, tag)
                    if not st:
                        continue
                    page.screenshot(path=str(OUT / f"switch-{size}-{scheme}.png"))
                    if phone and abs(st["bottom"] - st["vh"]) > 1:
                        fail(f"{tag}: the sheet does not sit on the bottom edge ({st['bottom']:.0f} of {st['vh']})")
                    if not phone and (not st["popover"] or st["top"] < st["chipBottom"] or st["top"] > st["chipBottom"] + 24 or st["w"] > 500):
                        fail(f"{tag}: not a popover under the chip (top {st['top']:.0f}, chip bottom {st['chipBottom']:.0f}, width {st['w']:.0f})")
                    small = [round(x) for x in st["rows"] if x < 40]
                    if small:
                        fail(f"{tag}: Switch controls under 40 px: {small}")
                    if st["over"] != 0:
                        fail(f"{tag}: horizontal overflow {st['over']}px")
                    for word in ("Day", "Command center", "Green shirt", "Truck B1", "Sign out"):
                        if word not in st["text"]:
                            fail(f"{tag}: '{word}' missing from the Switch")
                    if "—" in st["text"]:
                        fail(f"{tag}: em dash in the Switch")
                except Exception as e:  # noqa: BLE001
                    fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
                finally:
                    ctx.close()

        # Green Day 4 to Truck B1 and back, then paint on the driver map, then Sign out.
        tag = "switch green to driver"
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, color_scheme="light", is_mobile=True, has_touch=True)
        painted: list[str] = []
        try:
            if seedcodes.sign_in(ctx, BASE, PAINT_GREEN) != 200:
                raise RuntimeError("CC Webb login failed")
            bare = trpc_get(ctx, "green.parcels")
            mid_lat = sum(p["lat"] for p in bare) / len(bare)
            mid_lng = sum(p["lng"] for p in bare) / len(bare)
            stand = min(bare, key=lambda p: (p["lat"] - mid_lat) ** 2 + (p["lng"] - mid_lng) ** 2)
            ctx.grant_permissions(["geolocation"], origin=BASE)
            ctx.set_geolocation({"latitude": stand["lat"], "longitude": stand["lng"], "accuracy": 5})
            page = ctx.new_page()
            page.goto(BASE + "/", wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(600)
            page.evaluate("() => { window.lrbNoReload = 1; }")
            if not open_switch(page, tag):
                raise RuntimeError("no Switch")
            pick_role(page, "Truck B1")
            page.wait_for_selector("[aria-label='Route map']", timeout=15000)
            if "Truck B1" not in chip_text(page):
                fail(f"{tag}: chip reads '{chip_text(page)}' after taking Truck B1")
            if page.evaluate("() => window.lrbNoReload") != 1:
                fail(f"{tag}: the app reloaded on Switch")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / "switch-driver-map-green-phone-light.png"))

            # Paint on the driver map (a green shirt driving).
            ptag = "driver map paint (green and driver)"
            if page.locator("[data-paint]").count() == 0:
                fail(f"{ptag}: no Paint on the driver map")
            else:
                page.locator("[data-paint]").click()
                page.wait_for_timeout(700)
                if page.locator("[data-paint-bar]").count() == 0:
                    fail(f"{ptag}: Paint opened no bar")
                for b in ("not_todo", "open", "in_progress", "done", "do_not_touch"):
                    if page.locator(f'[data-brush="{b}"]').count() == 0:
                        fail(f"{ptag}: no {b} brush in the bar")
                tri = page.evaluate(PAINT_TRIPLE_JS)
                if not tri:
                    fail(f"{ptag}: no three neighbouring bare parcels on the driver map")
                else:
                    p, q, rr = tri
                    page.mouse.move(p["x"], p["y"])
                    page.mouse.down()
                    page.mouse.move(q["x"], q["y"], steps=8)
                    page.mouse.move(rr["x"], rr["y"], steps=8)
                    page.mouse.up()
                    painted = [t["pid"] for t in tri]
                    ok = False
                    for _ in range(20):
                        page.wait_for_timeout(300)
                        reds = [page.evaluate(LOT_FILL_JS, pid) for pid in painted]
                        if all(x and "lrb-lot-shape-open" in x["cls"] and x["fill"] == RED for x in reds):
                            ok = True
                            break
                    page.screenshot(path=str(OUT / "switch-driver-paint-phone-light.png"))
                    if not ok:
                        fail(f"{ptag}: the three painted parcels did not turn red Todo")
                    cnt = page.evaluate(PAINT_STATE_JS)["count"].strip()
                    if cnt != "3 lots":
                        fail(f"{ptag}: counter reads '{cnt}', expected '3 lots'")
                    page.locator("[data-paint-undo]").click()
                    back = False
                    for _ in range(20):
                        page.wait_for_timeout(300)
                        if all(page.locator(f'[data-parcel="{pid}"]').count() > 0 for pid in painted):
                            back = True
                            break
                    if not back:
                        fail(f"{ptag}: Undo did not return the three parcels")
                    else:
                        painted = []
                over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if over:
                    fail(f"{ptag}: horizontal overflow {over}px")
                page.locator("[data-paint-exit]").click()
                page.wait_for_timeout(300)

            if not open_switch(page, tag):
                raise RuntimeError("no Switch from the driver map")
            pick_role(page, "Green shirt")
            page.wait_for_selector("[aria-label='Command center map']", timeout=15000)
            if "CC Webb, Day 4" not in chip_text(page):
                fail(f"{tag}: chip reads '{chip_text(page)}' after Green shirt")
            if page.evaluate("() => window.lrbNoReload") != 1:
                fail(f"{tag}: the app reloaded on the way back")

            # Sign out lands on /login and stays there.
            stag = "sign out"
            open_switch(page, stag)
            page.locator("[data-switch-sign-out]").click()
            page.wait_for_url("**/login", timeout=15000)
            page.wait_for_timeout(2500)
            if page.evaluate("location.pathname") != "/login":
                fail(f"{stag}: landed on {page.evaluate('location.pathname')}, expected /login")
            if trpc_get(ctx, "shared.me").get("role") != "anon":
                fail(f"{stag}: still signed in after Sign out")
        except Exception as e:  # noqa: BLE001
            fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
        finally:
            if painted:
                green = browser.new_context()
                if seedcodes.sign_in(green, BASE, PAINT_GREEN) == 200:
                    for pid in painted:
                        green.request.post(f"{BASE}/trpc/green.setLotStatus", data=json.dumps({"json": {"parcelId": pid, "status": "not_todo"}}),
                                           headers={"content-type": "application/json"})
                green.close()
            ctx.close()

        # The admin: any day, any CC, any role, and back.
        tag = "switch admin"
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1, color_scheme="light")
        try:
            if seedcodes.sign_in(ctx, BASE, {"admin": True}) != 200:
                raise RuntimeError("admin login failed")
            page = ctx.new_page()
            page.goto(BASE + "/admin", wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(500)
            st = open_switch(page, tag)
            if st and ("Day 1" not in st["text"] or "Day 4" not in st["text"] or "Admin" not in st["text"]):
                fail(f"{tag}: Switch lacks Admin, Day 1 or Day 4")
            page.screenshot(path=str(OUT / "switch-admin-laptop-light.png"))
            pick_role(page, "Green shirt", "Day 1", "CC East")
            page.wait_for_selector("[aria-label='Command center map']", timeout=15000)
            if "CC East, Day 1" not in chip_text(page):
                fail(f"{tag}: chip reads '{chip_text(page)}' after Day 1 CC East green")
            open_switch(page, tag)
            pick_role(page, "Truck B1", "Day 4", "CC Webb")
            page.wait_for_selector("[aria-label='Route map']", timeout=15000)
            if "Truck B1" not in chip_text(page):
                fail(f"{tag}: chip reads '{chip_text(page)}' after Day 4 Truck B1")
            open_switch(page, tag)
            page.locator("[data-switch-admin]").click()
            page.wait_for_url("**/admin", timeout=15000)
            if trpc_get(ctx, "shared.me").get("role") != "admin":
                fail(f"{tag}: not back in admin")
        except Exception as e:  # noqa: BLE001
            fail(f"{tag}: {type(e).__name__} {str(e)[:160]}")
        finally:
            ctx.close()
        browser.close()


# endregion

CHECKS = [static_checks, bundle_checks, crash_checks, dynamic_checks, stock_expected_checks, parcel_status_checks, flag_checks, paint_checks, flag_paint_checks, draw_lot_checks, switch_checks]
# GATE_ONLY=paint_checks,flag_checks runs just those groups while working on one screen; the release gate runs all.
_only = {c for c in os.environ.get("GATE_ONLY", "").split(",") if c}
for check in CHECKS:
    if not _only or check.__name__ in _only:
        check()
print()
print(f"{len(failures)} failures, {len(warnings)} warnings, screenshots in {OUT}")
sys.exit(1 if failures else 0)
