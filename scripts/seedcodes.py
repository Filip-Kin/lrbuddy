"""Seed codes and QR link sign-in for the scripts (gate, story, sheets, access, perf, shots).

`bun run seed` generates every green code, truck code and crew token (SPEC 11) and writes them to
`$DATA_DIR/seed-codes.json`: one row per place with role, day, cc, name, code, path and link.
`load()` reads that file (`SEED_CODES` names another one; else `$DATA_DIR`, default `./data`).

People sign in only by QR link (`/j/<token>`, `/t/<code>`, `/g/<code>`) or, for staff, with the
admin password at `POST /auth/login` (SPEC 4). `sign_in` does whichever the login dict asks for:
`{"link": "/t/ABC234", "displayName": "Gate"}`, `{"seed": ("driver", "Truck 1"), "displayName": "Gate"}`
(looked up with `find` when used, so a script that never signs in needs no seed file) or
`{"code": <admin password>}`.
"""
import json
import os
import pathlib

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


def sign_in(ctx, base: str, login: dict) -> int:
    """Signs the context in; returns the HTTP status (200 on success, else the failing status).

    A link login opens the QR link the way a phone does (302 to `/` with the session cookie), then
    names the session. Anything else posts the admin password to `/auth/login`.
    """
    if "seed" in login:
        login = {**login, "link": path(*login["seed"])}
    if "link" in login:
        r = ctx.request.get(base + login["link"], max_redirects=0)
        if r.status != 302 or r.headers.get("location") != "/":
            return r.status if r.status != 302 else 401
        name = login.get("displayName")
        if name:
            n = ctx.request.post(base + "/auth/name", data=json.dumps({"displayName": name}), headers={"content-type": "application/json"})
            if n.status >= 400:
                return n.status
        return 200
    r = ctx.request.post(base + "/auth/login", data=json.dumps(login), headers={"content-type": "application/json"})
    return r.status
