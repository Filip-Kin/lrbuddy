"""Seed codes and sign-in for the scripts (gate, story, sheets, access, perf, shots).

`bun run seed` generates every green code, truck code and crew token (SPEC 11) and writes them to
`$DATA_DIR/seed-codes.json`: one row per place with role, day, cc, name, code, path and link, plus
one `admin` row whose `code` is the Firebase uid of the seed's admin user (SPEC 26).
`load()` reads that file (`SEED_CODES` names another one; else `$DATA_DIR`, default `./data`).

There is no password. People sign in with Firebase; against a local server that runs with the fake
Auth emulator (`bun tests/e2e/support/fake-auth.ts 9297` and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9297`)
an unsigned ID token for any uid is accepted, so `sign_in` signs the seed's admin user in, or a
fresh user who then opens a QR link (`/j/<token>`, `/t/<code>`, `/g/<code>`) or invite (`/i/<token>`).
The login dict is `{"admin": True}`, `{"link": "/t/ABC234", "displayName": "Gate"}` or
`{"seed": ("driver", "Truck 1"), "displayName": "Gate"}` (looked up with `find` when used, so a
script that never signs in needs no seed file).
"""
import json
import os
import pathlib
import time
import base64

_cache: list[dict] | None = None


def codes_file() -> pathlib.Path:
    named = os.environ.get("SEED_CODES")
    if named:
        return pathlib.Path(named)
    return pathlib.Path(os.environ.get("DATA_DIR", "./data")) / "seed-codes.json"


def load() -> list[dict]:
    global _cache
    if _cache is None:
        path = codes_file()
        if not path.is_file():
            raise SystemExit(f"{path} not found: run `bun run seed` with the same DATA_DIR, or set SEED_CODES")
        _cache = json.loads(path.read_text())
    return _cache


def find(role: str, name: str, cc: str | None = None, day: int | None = None) -> dict:
    """The seed row for a place: role "green" | "driver" | "crew", name "CC East" | "Truck 1" | "FORD 1"."""
    for row in load():
        if row["role"] == role and row["name"] == name and (cc is None or row["cc"] == cc) and (day is None or row["day"] == day):
            return row
    raise SystemExit(f"{codes_file()} has no {role} '{name}'" + (f" at CC {cc}" if cc else "") + (f" on Day {day}" if day else ""))


def path(role: str, name: str, cc: str | None = None, day: int | None = None) -> str:
    """QR link path, `/g/...`, `/t/...` or `/j/...`."""
    return find(role, name, cc, day)["path"]


def admin_uid() -> str:
    """Firebase uid of the seed's admin user."""
    return find("admin", "Admin")["code"]


def _b64(v: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip("=")


def id_token(uid: str, name: str = "", phone: str = "") -> str:
    """An unsigned emulator ID token (alg none), as tests/e2e/support/firebase.ts makes one."""
    project = os.environ.get("FIREBASE_PROJECT_ID", "demo-lrbuddy")
    now = int(time.time())
    payload = {
        "iss": f"https://securetoken.google.com/{project}",
        "aud": project,
        "auth_time": now,
        "user_id": uid,
        "sub": uid,
        "iat": now,
        "exp": now + 3600,
        "firebase": {"identities": {"phone": [phone]} if phone else {}, "sign_in_provider": "phone" if phone else "google.com"},
    }
    if phone:
        payload["phone_number"] = phone
    if name:
        payload["name"] = name
    return f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{_b64(payload)}."


def firebase_sign_in(ctx, base: str, uid: str, name: str = "", phone: str = "") -> tuple[int, str]:
    """POST /auth/firebase with an emulator token; returns (status, state)."""
    body = {"idToken": id_token(uid, name, phone)}
    if name:
        body["name"] = name
    r = ctx.request.post(base + "/auth/firebase", data=json.dumps(body), headers={"content-type": "application/json"})
    if r.status != 200:
        return r.status, ""
    return 200, r.json().get("state", "")


_serial = 0


def sign_in(ctx, base: str, login: dict) -> int:
    """Signs the context in; returns the HTTP status (200 on success, else the failing status).

    `admin`: the seed's admin user signs in and must land in its admin membership. A link: a fresh
    user signs in, then opens the link the way a phone does (302 to `/`).
    """
    global _serial
    if login.get("admin"):
        status, state = firebase_sign_in(ctx, base, admin_uid())
        if status != 200:
            return status
        return 200 if state == "entered" else 403
    if "seed" in login:
        login = {**login, "link": path(*login["seed"])}
    if "link" not in login:
        raise SystemExit(f"sign_in: no link and not admin: {login}")
    _serial += 1
    uid = f"script-{os.getpid()}-{_serial}-{int(time.time() * 1000)}"
    status, _ = firebase_sign_in(ctx, base, uid, login.get("displayName") or "Script")
    if status != 200:
        return status
    r = ctx.request.get(base + login["link"], max_redirects=0)
    if r.status != 302 or r.headers.get("location") != "/":
        return r.status if r.status != 302 else 401
    return 200
