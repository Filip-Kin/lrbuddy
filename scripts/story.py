"""End-to-end story across all four roles, each in its own browser context.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/story.py http://127.0.0.1:3000 <admin password>

Run against a freshly seeded server (`bun run seed`). It changes data: one
request, one green stop and a DLBA import. Every step prints PASS or FAIL;
exit 1 on any FAIL. Screenshots of each step land in
/home/filip/preview-shots/lrbuddy/story/.

1. Crew 1 (demo-crew-01) sends Water x2.
2. Green EAST01 sees it on the board and a request ring on the map.
3. The truck's queue shows it, and the driver map draws a route.
4. Driver taps En route; the crew sees En route without a reload.
5. Driver taps Delivered; the crew sees Delivered, truck water drops by 2,
   green stats count one more delivery.
6. Green adds a crewless stop on the map; it lands in a truck queue.
7. Admin imports DLBA lots by rectangle into CC East; the green sees them.
"""
import json
import pathlib
import sys
import time
import urllib.parse

from playwright.sync_api import Page, BrowserContext, sync_playwright

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:3000"
ADMIN = sys.argv[2] if len(sys.argv) > 2 else None
OUT = pathlib.Path("/home/filip/preview-shots/lrbuddy/story")
OUT.mkdir(parents=True, exist_ok=True)

CREW1 = {"latitude": 42.37762, "longitude": -82.98817, "accuracy": 8}
failures: list[str] = []
console_errors: list[str] = []


def check(ok: bool, msg: str) -> bool:
    print(("PASS  " if ok else "FAIL  ") + msg, flush=True)
    if not ok:
        failures.append(msg)
    return ok


def shot(page: Page, name: str) -> None:
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)


def api(ctx: BrowserContext, path: str, inp: object | None = None) -> object:
    url = f"{BASE}/trpc/{path}"
    if inp is not None:
        url += "?input=" + urllib.parse.quote(json.dumps({"json": inp}))
    res = ctx.request.get(url)
    body = res.json()
    if "error" in body:
        raise RuntimeError(f"{path}: {body['error']}")
    return body["result"]["data"]["json"]


def wait_for(fn, timeout_s: float = 15, every_s: float = 0.5):
    end = time.time() + timeout_s
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(every_s)
    return last


def new_role(browser, code: str, size: tuple[int, int], geo: dict | None = None, name: str = "Sam") -> tuple[BrowserContext, Page]:
    opts: dict = {"viewport": {"width": size[0], "height": size[1]}, "device_scale_factor": 1}
    if geo:
        opts["geolocation"] = geo
        opts["permissions"] = ["geolocation"]
    ctx = browser.new_context(**opts)
    res = ctx.request.post(BASE + "/auth/login", data={"code": code, "displayName": name})
    if not res.ok:
        raise SystemExit(f"login {code}: HTTP {res.status}")
    page = ctx.new_page()
    page.on("console", lambda m: console_errors.append(f"{code}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(f"{code}: {e}"))
    return ctx, page


def water_qty(ctx: BrowserContext) -> int:
    stock = api(ctx, "driver.stock")
    return next(s["qty"] for s in stock if s["key"] == "water")


def stop_for(page: Page, name: str):
    """The stop's action area: the next stop card, or the sheet opened from its row."""
    card = page.locator('section[aria-label="Next stop"]')
    if card.count() and name in card.inner_text():
        return card
    page.locator("li button", has_text=name).first.click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    return dialog


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
    crew_ctx, crew = new_role(browser, "demo-crew-01", (390, 844), CREW1)
    drv_ctx, drv = new_role(browser, "TRUCK1", (390, 844), {**CREW1, "latitude": CREW1["latitude"] + 0.0004})
    green_ctx, green = new_role(browser, "EAST01", (1440, 900))

    # The driver's phone is open first so Truck 1 counts as seen and has a fresh fix.
    drv.goto(BASE + "/", wait_until="networkidle")
    drv.get_by_role("heading", name="Queue").wait_for()
    time.sleep(2)
    water_before = water_qty(drv_ctx)
    delivered_before = api(green_ctx, "green.stats")["delivered"]

    # #region 1. crew sends Water x2
    crew.goto(BASE + "/request", wait_until="networkidle")
    crew.get_by_role("button", name="Water").first.click()
    sheet = crew.get_by_role("dialog")
    sheet.get_by_role("button", name="More").click()
    sheet.get_by_role("button", name="Send").click()
    crew.wait_for_url("**/requests", timeout=10_000)
    mine = api(crew_ctx, "crew.myRequests")
    req = max((r for r in mine if r["typeKey"] == "water"), key=lambda r: r["id"])
    check(req["qty"] == 2 and req["status"] in ("open", "assigned"), f"crew sent Water x2 (request {req['id']}, {req['status']})")
    shot(crew, "1-crew-sent")
    # #endregion

    # #region 2. green sees it
    assigned = wait_for(lambda: next((r for r in api(crew_ctx, "crew.myRequests") if r["id"] == req["id"] and r["status"] == "assigned"), None), 10)
    truck_name = assigned["truckName"] if assigned else None
    check(assigned is not None, f"request assigned to {truck_name}")
    if truck_name and truck_name != "Truck 1":
        # Dispatch picked the other truck; the green moves it to Truck 1, which is the phone in this story.
        green.goto(BASE + "/requests", wait_until="networkidle")
        card = green.locator("article", has_text="Crew 1").filter(has_text="Water").first
        card.get_by_role("button", name="Assign").click()
        green.get_by_role("dialog").get_by_role("button", name="Truck 1").click()
        moved = wait_for(lambda: next((r for r in api(crew_ctx, "crew.myRequests") if r["id"] == req["id"] and r["truckName"] == "Truck 1"), None), 10)
        check(moved is not None, "green reassigned it to Truck 1")
    green.goto(BASE + "/requests", wait_until="networkidle")
    board = green.locator("main")
    seen = wait_for(lambda: "Crew 1" in board.inner_text() and "Water" in board.inner_text(), 10)
    check(bool(seen), "green board shows Crew 1 Water")
    shot(green, "2-green-board")
    green.goto(BASE + "/", wait_until="networkidle")
    rings = wait_for(lambda: green.locator(".lrb-req").count(), 10)
    check(bool(rings), f"green map shows request rings ({rings})")
    shot(green, "2-green-map")
    # #endregion

    # #region 3. driver queue and route
    drv.goto(BASE + "/", wait_until="networkidle")
    in_queue = wait_for(lambda: "Crew 1" in drv.locator("main").inner_text(), 15)
    check(bool(in_queue), "Truck 1 queue shows Crew 1")
    shot(drv, "3-driver-queue")
    drv.goto(BASE + "/map", wait_until="networkidle")
    route = wait_for(lambda: drv.locator("path.lrb-route").count(), 15)
    check(bool(route), "driver map draws the route")
    shot(drv, "3-driver-map")
    # #endregion

    # #region 4. en route
    crew.goto(BASE + "/requests", wait_until="networkidle")
    drv.goto(BASE + "/", wait_until="networkidle")
    drv.get_by_text("Crew 1").first.wait_for()
    time.sleep(1)  # a freshly shown stop card ignores taps for 800 ms
    stop_for(drv, "Crew 1").get_by_role("button", name="En route").click()
    ok = wait_for(lambda: next((r for r in api(crew_ctx, "crew.myRequests") if r["id"] == req["id"] and r["status"] == "en_route"), None), 10)
    check(ok is not None, "driver marked the stop en route")
    crew_card = crew.locator("article", has_text="Water").first
    live = wait_for(lambda: "En route" in crew_card.inner_text(), 10)
    check(bool(live), "crew sees En route without a reload")
    shot(crew, "4-crew-en-route")
    # #endregion

    # #region 5. delivered
    drv.keyboard.press("Escape")
    time.sleep(1)
    stop_for(drv, "Crew 1").get_by_role("button", name="Delivered").click()
    done = wait_for(lambda: next((r for r in api(crew_ctx, "crew.myRequests") if r["id"] == req["id"] and r["status"] == "delivered"), None), 10)
    check(done is not None, "driver delivered the stop")
    live = wait_for(lambda: "Delivered" in crew.locator("main").inner_text(), 10)
    check(bool(live), "crew sees Delivered without a reload")
    shot(crew, "5-crew-delivered")
    water_after = water_qty(drv_ctx)
    check(water_after == max(0, water_before - 2), f"truck water {water_before} -> {water_after}")
    drv.goto(BASE + "/stock", wait_until="networkidle")
    shot(drv, "5-driver-stock")
    stats = wait_for(lambda: (s := api(green_ctx, "green.stats"))["delivered"] > delivered_before and s, 10)
    check(bool(stats), f"green stats delivered {delivered_before} -> {stats['delivered'] if stats else '?'}")
    green.goto(BASE + "/stats", wait_until="networkidle")
    shot(green, "5-green-stats")
    # #endregion

    # #region 6. green adds a crewless stop
    green.goto(BASE + "/", wait_until="networkidle")
    crewless_before = {r["id"] for r in api(green_ctx, "green.requests") if r["crewId"] is None}
    green.get_by_role("button", name="Add stop").click()
    box = green.locator(".leaflet-container").bounding_box()
    green.mouse.click(box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.45)
    add = green.get_by_role("dialog")
    add.get_by_role("button", name="Send").click()
    toast = green.get_by_text("Stop sent").or_(green.get_by_text("Stop open"))
    toast.first.wait_for(timeout=10_000)
    text = toast.first.inner_text()
    check(text.startswith("Stop sent"), f"green stop: {text}")
    shot(green, "6-green-stop")
    stop_truck = text.split(", ", 1)[1] if ", " in text else None
    code = {"Truck 1": "TRUCK1", "Truck 2": "TRUCK2"}.get(stop_truck or "", "TRUCK1")
    t_ctx, _ = new_role(browser, code, (390, 844))
    new_ids = {r["id"] for r in api(green_ctx, "green.requests") if r["crewId"] is None} - crewless_before
    pinned = wait_for(lambda: [s for s in api(t_ctx, "driver.queue")["stops"] if any(i["id"] in new_ids for i in s["items"])], 10)
    check(len(new_ids) == 1 and bool(pinned), f"{stop_truck} queue has the new pinned stop, {pinned[0]['name'] if pinned else '?'}")
    t_ctx.close()
    # #endregion

    # #region 7. admin imports DLBA lots into CC East
    if ADMIN:
        adm_ctx, adm = new_role(browser, ADMIN, (1440, 900))
        green.goto(BASE + "/lots", wait_until="networkidle")
        lots_before = len(api(green_ctx, "green.lots")["lots"])
        adm.goto(BASE + "/admin/lots", wait_until="networkidle")
        adm.locator("img.leaflet-tile-loaded").first.wait_for(timeout=15_000)
        adm.get_by_role("button", name="Import DLBA").click()
        box = adm.locator(".leaflet-container").bounding_box()
        cx, cy = box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5
        adm.mouse.click(cx - 90, cy - 55)
        adm.mouse.click(cx + 90, cy + 55)
        sheet = adm.get_by_role("dialog")
        sheet.get_by_label("Command center").select_option(label="Day 1, CC East")
        shot(adm, "7-admin-import-sheet")
        sheet.get_by_role("button", name="Import Land Bank lots").click()
        notice = adm.get_by_role("status").filter(has_text="added")
        notice.first.wait_for(timeout=60_000)
        note = notice.first.inner_text()
        check("to CC East" in note, f"admin import: {note}")
        shot(adm, "7-admin-imported")
        lots_after = wait_for(lambda: (n := len(api(green_ctx, "green.lots")["lots"])) > lots_before and n, 10)
        check(bool(lots_after), f"green lots {lots_before} -> {lots_after}")
        green.reload(wait_until="networkidle")
        shot(green, "7-green-lots")
        adm_ctx.close()
    else:
        check(False, "admin step skipped: no admin password given")
    # #endregion

    noise = [e for e in console_errors if "geolocation" not in e.lower()]
    check(not noise, f"no console errors ({len(noise)})")
    for e in noise[:10]:
        print("      " + e[:200])
    browser.close()

print(f"\n{len(failures)} failures, screenshots in {OUT}")
sys.exit(1 if failures else 0)
