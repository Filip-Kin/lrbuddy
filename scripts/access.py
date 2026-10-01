"""SPEC 18 end to end against the Firebase Auth emulator: phone sign-in, request, approval, QR joins.

    docker compose up -d                      # emulator on :9099 (FIREBASE_AUTH_PORT to move it)
    VITE_FIREBASE_EMULATOR=http://127.0.0.1:9099 bun run build
    bun run seed
    FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 bun run start
    /home/filip/pit-podcast-automation/.venv/bin/python scripts/access.py http://127.0.0.1:3000 http://127.0.0.1:9099 <admin pw>

Reads the codes the emulator "sent" from its REST API, so no SMS leaves the box. Never point it at
production: it signs up test users. Reseed afterwards. Screenshots in /home/filip/preview-shots/lrbuddy-access/.
"""
import json
import pathlib
import sys
import time
import urllib.request

from playwright.sync_api import Page, expect, sync_playwright

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:3000"
EMU = sys.argv[2].rstrip("/") if len(sys.argv) > 2 else "http://127.0.0.1:9099"
PROJECT = "demo-lrbuddy"
OUT = pathlib.Path("/home/filip/preview-shots/lrbuddy-access")
OUT.mkdir(parents=True, exist_ok=True)
PHONE = {"width": 390, "height": 844}

failures: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(("ok    " if ok else "FAIL  ") + msg)
    if not ok:
        failures.append(msg)


def shot(page: Page, name: str) -> None:
    page.screenshot(path=str(OUT / f"{name}.png"))
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(over == 0, f"{name}: no horizontal overflow ({over}px)")


def emulator(path: str, method: str = "GET") -> dict:
    req = urllib.request.Request(f"{EMU}{path}", method=method, headers={"authorization": "Bearer owner"})
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read()
        return json.loads(body) if body else {}


def code_for(phone_e164: str) -> str:
    for _ in range(20):
        codes = emulator(f"/emulator/v1/projects/{PROJECT}/verificationCodes").get("verificationCodes", [])
        mine = [c for c in codes if c.get("phoneNumber") == phone_e164]
        if mine:
            return mine[-1]["code"]
        time.sleep(0.25)
    raise RuntimeError(f"no code for {phone_e164}")


def phone_sign_in(page: Page, name: str, typed: str, e164: str, tag: str) -> None:
    page.goto(BASE + "/login", wait_until="networkidle")
    page.get_by_label("Name").fill(name)
    page.get_by_label("Mobile number").fill(typed)
    shot(page, f"{tag}-1-login")
    page.get_by_role("button", name="Continue").click()
    otp = page.locator("input[name=otp]")
    expect(otp).to_be_visible(timeout=15000)
    shot(page, f"{tag}-2-code")
    otp.fill(code_for(e164))
    page.get_by_role("button", name="Sign in", exact=True).first.click()


def code_login(ctx, code: str) -> None:
    r = ctx.request.post(f"{BASE}/auth/login", data=json.dumps({"code": code, "displayName": "Dana"}), headers={"content-type": "application/json"})
    check(r.status == 200, f"code login {code} -> {r.status}")


def main() -> None:
    # Start clean: no users or codes left in the emulator from an earlier run.
    emulator(f"/emulator/v1/projects/{PROJECT}/accounts", "DELETE")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        opts = dict(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)

        # region 1. Phone sign-in, request ROCKET 1 as a red shirt, EAST01 approves, the crew map opens.
        red = browser.new_context(**opts)
        page = red.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/login", wait_until="networkidle")
        labels = page.evaluate("[...document.querySelectorAll('label')].filter(l => l.offsetParent !== null).map(l => l.innerText.trim())")
        check(not any("code" in l.lower() for l in labels), f"first paint has no field labelled Code ({labels})")
        tel = page.locator("input[type=tel][autocomplete=tel]")
        check(tel.count() == 1 and tel.is_visible(), "Mobile number is type=tel autocomplete=tel")
        otp = page.locator("input[autocomplete=one-time-code][inputmode=numeric]")
        check(otp.count() == 1 and not otp.is_visible(), "one-time-code field present and hidden before Continue")
        phone_sign_in(page, "Jordan Reed", "(313) 555-0142", "+13135550142", "red")
        page.wait_for_url(BASE + "/", timeout=15000)
        expect(page.get_by_role("radiogroup", name="Role")).to_be_visible(timeout=15000)
        shot(page, "red-3-request-empty")
        page.get_by_role("radio", name="Red shirt").click()
        page.get_by_role("radio", name="CC East").click()
        page.get_by_role("radio", name="Rocket", exact=True).click()
        page.get_by_role("radio", name="ROCKET 1", exact=True).click()
        shot(page, "red-4-request-filled")
        page.get_by_role("button", name="Request", exact=True).click()
        expect(page.get_by_text("Pending", exact=True)).to_be_visible(timeout=10000)
        page.wait_for_timeout(500)
        shot(page, "red-5-pending")
        check(page.get_by_role("link", name="Call").count() > 0, "pending screen shows the CC's green shirts with Call")

        green = browser.new_context(**opts)
        code_login(green, "EAST01")
        gpage = green.new_page()
        gpage.goto(BASE + "/access", wait_until="networkidle")
        expect(gpage.locator("[data-access-request]")).to_have_count(1, timeout=10000)
        shot(gpage, "green-1-access")
        gpage.get_by_role("button", name="Menu").click()
        gpage.wait_for_timeout(300)
        badge = gpage.locator("[data-menu] a", has_text="Access").inner_text()
        check("1" in badge, f"nav badge shows the pending count ({badge!r})")
        shot(gpage, "green-2-menu-badge")
        gpage.keyboard.press("Escape")
        gpage.get_by_role("button", name="Approve").click()
        # Seeded crews have a red shirt: approval asks Replace lead or Add.
        expect(gpage.get_by_role("button", name="Replace lead")).to_be_visible(timeout=5000)
        shot(gpage, "green-3-lead-choice")
        gpage.get_by_role("button", name="Add", exact=True).click()
        expect(gpage.get_by_text("No requests")).to_be_visible(timeout=10000)
        shot(gpage, "green-4-decided")

        # The red shirt's screen moves into the crew on its own.
        expect(page.locator(".leaflet-container")).to_be_visible(timeout=20000)
        page.wait_for_timeout(1500)
        scope = page.locator("header").inner_text()
        check("ROCKET 1" in scope, f"red shirt lands on the crew map for ROCKET 1 ({scope.splitlines()!r})")
        shot(page, "red-6-crew-map")
        check(not errors, f"no page errors on the red shirt's phone ({errors[:2]})")

        # Returning user: a new tab on the same phone goes straight through.
        page2 = red.new_page()
        page2.goto(BASE + "/login", wait_until="domcontentloaded")
        page2.wait_for_url(BASE + "/", timeout=15000)
        expect(page2.locator(".leaflet-container")).to_be_visible(timeout=15000)
        check(True, "returning user skips the sign-in form")
        page2.close()

        # Leave crew keeps the sign-in: the access screen offers the approved crew.
        page.goto(BASE + "/settings", wait_until="networkidle")
        page.get_by_role("button", name="Leave crew").first.click()
        page.locator("[role=dialog]").get_by_role("button", name="Leave crew").click()
        expect(page.get_by_text("Sign in as")).to_be_visible(timeout=10000)
        shot(page, "red-7-chooser")
        page.get_by_role("button", name="ROCKET 1").click()
        expect(page.locator(".leaflet-container")).to_be_visible(timeout=15000)
        check(True, "chooser re-enters the crew")
        red.close()
        green.close()
        # endregion

        # region 2. QR path: scan DTE 1's code before sign-in, sign in, land in DTE 1.
        qr = browser.new_context(**opts)
        qpage = qr.new_page()
        qpage.goto(BASE + "/j/demo-crew-03", wait_until="networkidle")
        check(qpage.url.endswith("/login"), f"crew QR before sign-in goes to /login ({qpage.url})")
        expect(qpage.get_by_text("DTE 1, DTE, CC East")).to_be_visible(timeout=5000)
        shot(qpage, "qr-1-login-with-link")
        phone_sign_in(qpage, "Sam Ortiz", "313 555 0143", "+13135550143", "qr")
        qpage.wait_for_url(BASE + "/", timeout=15000)
        expect(qpage.locator(".leaflet-container")).to_be_visible(timeout=20000)
        scope = qpage.locator("header").inner_text()
        check("DTE 1" in scope, f"QR join lands on DTE 1 ({scope.splitlines()!r})")
        shot(qpage, "qr-2-crew-map")
        # Scanning again after sign-in joins at once and keeps one membership.
        qpage.goto(BASE + "/j/demo-crew-03", wait_until="networkidle")
        check(qpage.url == BASE + "/", f"second scan goes straight in ({qpage.url})")
        # Truck QR on the same signed-in phone: now a driver.
        qpage.goto(BASE + "/t/TRUCK2", wait_until="networkidle")
        qpage.wait_for_timeout(1000)
        scope = qpage.locator("header").inner_text()
        check("Truck 2" in scope, f"truck QR signs in as Truck 2 ({scope.splitlines()!r})")
        shot(qpage, "qr-3-driver")
        qr.close()
        # endregion

        # region 3. Google through the emulator's account picker, after scanning the green QR.
        gg = browser.new_context(**opts)
        gp = gg.new_page()
        gp.goto(BASE + "/g/EAST01", wait_until="networkidle")
        with gp.expect_popup() as popup:
            gp.get_by_role("button", name="Google").click()
        win = popup.value
        win.wait_for_load_state()
        win.get_by_text("Add new account").click()
        win.get_by_text("Auto-generate user information").click()
        win.get_by_text("Sign in with Google.com").click()
        gp.wait_for_url(BASE + "/", timeout=15000)
        gp.wait_for_timeout(2000)
        scope = gp.locator("header").inner_text()
        check("CC East" in scope, f"Google sign-in after the green QR lands on CC East ({scope.splitlines()!r})")
        shot(gp, "google-1-green-map")
        gg.close()
        # endregion

        # region 4. Admin sees every CC; staff password still works.
        adm = browser.new_context(viewport={"width": 1440, "height": 900})
        apage = adm.new_page()
        apage.goto(BASE + "/login", wait_until="networkidle")
        apage.get_by_role("button", name="Staff password").click()
        apage.get_by_label("Staff password").fill(ADMIN)
        apage.get_by_role("button", name="Sign in").last.click()
        apage.wait_for_url("**/admin", timeout=15000)
        apage.goto(BASE + "/admin/access", wait_until="networkidle")
        expect(apage.get_by_text("Decided")).to_be_visible()
        shot(apage, "admin-1-access")
        adm.close()
        # endregion
        browser.close()


ADMIN = sys.argv[3] if len(sys.argv) > 3 else ""
main()
print()
print(f"{len(failures)} failures, screenshots in {OUT}")
sys.exit(1 if failures else 0)
