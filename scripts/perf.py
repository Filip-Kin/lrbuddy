"""Cold-load timings on a throttled phone link.

    /home/filip/pit-podcast-automation/.venv/bin/python scripts/perf.py http://127.0.0.1:3061 [runs]

Chromium with CDP network throttling at Slow 4G (1.6 Mbps down, 750 kbps up, 150 ms RTT), a fresh
context per run (cold HTTP cache, empty IndexedDB), 390x844. Times are from navigation start:

- login paint: the sign-in form's first input is visible, signed out.
- green map: as CC Webb's green shirt, at least one lot outline drawn on the map at `/`.
- driver map: as Truck B1, at least one lot outline drawn at `/`.
- flag ready: as CC Webb's green shirt standing on a bare parcel, `/flag` names the parcel (not "No parcel").

Warm rows open the same screen a second time in the same context (HTTP cache and IndexedDB kept
from the first open), throttled the same way: a phone reopening the app.

Both sign in by their QR links from `$DATA_DIR/seed-codes.json` (scripts/seedcodes.py); run
with the DATA_DIR the server was seeded into.

Also counts the `/trpc` requests and the bytes received up to that moment. Prints the median of
`runs` (default 3) per row. Local numbers on a local server; production adds its own latency.
"""
import json
import statistics
import sys
import urllib.request

from playwright.sync_api import sync_playwright

import seedcodes

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:3061"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
GREEN = {"seed": ("green", "CC Webb", "Webb", 4), "displayName": "Perf"}
DRIVER = {"seed": ("driver", "Truck B1", "Webb", 4), "displayName": "Perf"}
SLOW_4G = {"offline": False, "latency": 150, "downloadThroughput": 1_600_000 / 8, "uploadThroughput": 750_000 / 8}

LOTS_DRAWN = "() => document.querySelectorAll('.leaflet-container path[class*=\"lrb-lot-shape-\"]').length > 0 && performance.now()"
LOGIN_PAINT = "() => { const i = document.querySelector('main input, form input, input'); return !!i && i.getBoundingClientRect().height > 0 && performance.now(); }"
FLAG_READY = "() => { const t = document.querySelector('[data-flag-target]'); return !!t && !/No parcel/.test(t.textContent || '') && performance.now(); }"


def bare_parcel() -> dict:
    """A bare parcel at CC Webb to stand on, read once with a throwaway session."""
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        ctx = b.new_context()
        seedcodes.sign_in(ctx, BASE, GREEN)
        body = ctx.request.get(f"{BASE}/trpc/green.parcels").json()
        b.close()
    rows = body["result"]["data"]["json"]
    return rows[len(rows) // 2]


SESSIONS: dict[str, dict] = {}


def session(browser, login: dict) -> dict:
    """One sign-in per place for the whole run, its cookies reused by every context."""
    key = json.dumps(login["seed"])
    if key not in SESSIONS:
        ctx = browser.new_context()
        status = seedcodes.sign_in(ctx, BASE, login)
        if status != 200:
            raise RuntimeError(f"login {login['seed']} returned {status}")
        SESSIONS[key] = ctx.storage_state()
        ctx.close()
    return SESSIONS[key]


def run(browser, login: dict | None, path: str, ready: str, geo: dict | None = None, warm: bool = False) -> tuple[float, int, int]:
    opts: dict = {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True, "device_scale_factor": 1}
    if geo:
        opts["permissions"] = ["camera", "geolocation"]
        opts["geolocation"] = geo
    if login:
        opts["storage_state"] = session(browser, login)
    ctx = browser.new_context(**opts)
    if warm:
        first = ctx.new_page()
        first.goto(BASE + path, wait_until="commit", timeout=90000)
        first.wait_for_function(ready, timeout=90000, polling=100)
        first.wait_for_timeout(2500)
        first.close()
    page = ctx.new_page()
    cdp = ctx.new_cdp_session(page)
    cdp.send("Network.enable")
    cdp.send("Network.setCacheDisabled", {"cacheDisabled": not warm})
    cdp.send("Network.emulateNetworkConditions", SLOW_4G)
    trpc: list[str] = []
    received = {"bytes": 0}
    page.on("request", lambda q: trpc.append(q.url) if "/trpc/" in q.url and "onCc" not in q.url else None)
    cdp.on("Network.loadingFinished", lambda e: received.__setitem__("bytes", received["bytes"] + int(e.get("encodedDataLength", 0))))
    page.goto(BASE + path, wait_until="commit", timeout=90000)
    t = page.wait_for_function(ready, timeout=90000, polling=50).json_value()
    n, kb = len(trpc), received["bytes"] // 1024
    ctx.close()
    return float(t), n, kb


def main() -> None:
    p = bare_parcel()
    geo = {"latitude": p["lat"], "longitude": p["lng"], "accuracy": 5}
    rows = [
        ("Login paint", None, "/login", LOGIN_PAINT, None),
        ("Green map, lots drawn (CC Webb)", GREEN, "/", LOTS_DRAWN, None),
        ("Driver map, lots drawn (Truck B1)", DRIVER, "/", LOTS_DRAWN, None),
        ("/flag ready (CC Webb)", GREEN, "/flag", FLAG_READY, geo),
        ("Warm: green map, lots drawn", GREEN, "/", LOTS_DRAWN, None),
        ("Warm: /flag ready", GREEN, "/flag", FLAG_READY, geo),
    ]
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium",
                                     args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        print("| Screen | Median ms | Runs ms | tRPC requests | KB received |")
        print("|---|---:|---|---:|---:|")
        for name, login, path, ready, g in rows:
            times, reqs, kbs = [], [], []
            for _ in range(RUNS):
                t, n, kb = run(browser, login, path, ready, g, warm=name.startswith("Warm"))
                times.append(t)
                reqs.append(n)
                kbs.append(kb)
            print(f"| {name} | {statistics.median(times):.0f} | {', '.join(f'{x:.0f}' for x in times)} | {statistics.median(reqs):.0f} | {statistics.median(kbs):.0f} |")
            sys.stdout.flush()
        browser.close()


if __name__ == "__main__":
    urllib.request.urlopen(BASE + "/health", timeout=10).read()
    main()
