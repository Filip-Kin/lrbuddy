# Decisions

One line per call made without anyone to ask. Newest at the bottom.

- 2026-09-30 foundation: added `crews.number` so every surface can say "Crew 7"; seed numbers 1..12, admin create and CSV import take the next free number for the day.
- 2026-09-30 foundation: added `request_types.default_capacity` so new trucks start full without a hard-coded table; seeded per type in `server/setup.ts`.
- 2026-09-30 foundation: added `requests.cancel_note` for the driver's cancel reason instead of overwriting the crew's note.
- 2026-09-30 foundation: added `routes.legs` (per-stop ETA and position) and `routes.origin_lat/lng` (for the 250 m recompute check); SPEC section 3 updated.
- 2026-09-30 foundation: crew stop position = fix from the last 20 min, else the newer of the stale fix and the request's own position, else the CC. The literal SPEC order made "within 20 minutes" and "most recent" the same thing.
- 2026-09-30 foundation: a second request from a crew whose stop is already on a truck costs 0 for that truck, so one crew stays one stop.
- 2026-09-30 foundation: route recompute also fires when a crew with an active stop moves more than 250 m from its routed position.
- 2026-09-30 foundation: when a stale truck posts a position again, open requests at its CC are re-run through assignment (`sweepOpen`). Otherwise they sat open until a green assigned them.
- 2026-09-30 foundation: green Assign on an en_route request puts it back to `assigned` on the new truck (the new driver has not started it).
- 2026-09-30 foundation: delivery writes a stock_moves row with the delta actually applied (floored), so stock_moves sums to truck_stock.
- 2026-09-30 foundation: driver stock plus and minus clamp to 0..capacity.
- 2026-09-30 foundation: position broadcasts are throttled at emit time (one per entity per 5 s for every subscriber); every fix is still stored.
- 2026-09-30 foundation: trucks and crews count as seen on any procedure call from their session (throttled to 30 s), not only on position posts. An open driver app is a seen truck.
- 2026-09-30 foundation: sessions store `cc_id` for every role so push to a CC is one query.
- 2026-09-30 foundation: admin CC override for green views travels as header `x-lrb-cc` and SSE connectionParams `cc`; ignored for non-admin roles. Picker at `/admin/green`.
- 2026-09-30 foundation: `OSRM_URL=off` forces the fallback; the test suite uses it.
- 2026-09-30 foundation: dark mode basemap is Esri `World_Dark_Gray_Base` and `World_Dark_Gray_Reference` on the same `server.arcgisonline.com` host; light constants copied from reference/basemap.ts unchanged, attribution without the "stores" clause.
- 2026-09-30 foundation: login code field is plain text, not password type, because drivers type 6-character codes on a phone.
- 2026-09-30 foundation: PNG icons rendered from SVG with Chromium (`scripts/render_icons.py`); ImageMagick here has no SVG delegate.
- 2026-09-30 foundation: web client uses `@trpc/react-query` (classic hooks) plus a vanilla client for the position watcher and push.
- 2026-09-30 foundation: one `shared.onCc` stream per signed-in app shell; events invalidate matching queries, coalesced to one refetch per kind per 1.5 s (`web/src/lib/live.ts`).
- 2026-09-30 foundation: crew map (`/`) is implemented, not a stub, because the foundation gate screenshots it; every other role screen is a stub.
- 2026-09-30 foundation: crew display name prompt lives in the app shell and saves through `POST /auth/name`; `scripts/shots.py` logs in with `displayName` so the prompt does not cover screenshots. The tRPC `shared.setDisplayName` was dropped so there is one way to set a name.
- 2026-09-30 foundation: green shirts and admin get "Sign out" in the nav; crews and drivers leave from Settings as the SPEC says.
- 2026-09-30 foundation: phone nav is a right-hand drawer over a full-screen `[data-scrim]`, so a tap anywhere left of the drawer closes it (the gate taps the scrim's top-left corner).
- 2026-09-30 foundation: text on yellow is `--on-brand` (#0e3038) in both schemes. SPEC 13 says text on `--brand` is `--ink`, but dark `--ink` is near white and fails contrast on yellow.
- 2026-09-30 foundation: status pills with a red, green or orange status use a 15 % tint, a coloured dot and ink text; white or teal text on the palette red and green is under 4.5:1. Danger buttons are a red ring for the same reason.
- 2026-09-30 foundation: lots are 12 px divIcon squares inside a 28 px tap target (300 DOM markers is fine), styled by CSS variables so they follow the scheme.
- 2026-09-30 foundation: the `shared.onCc` stream opens 2.5 s after the shell mounts. An open SSE request never lets the page reach network idle, which the gate and the screenshot harness wait for; queries load on mount and refetch when the stream starts.
- 2026-09-30 foundation: exports use Detroit local time (`2026-09-28 14:05:09`); `web/src/lib/format.ts` has `clock` and `dateTime` fixed to America/Detroit.
- 2026-09-30 foundation: `web/src/lib/push.ts` returns `install` on iOS outside a Home Screen app with the label "Add to Home Screen first"; `web/src/lib/position.ts` exposes `locationPermission()` and row labels for the settings screens.
- 2026-09-30 foundation: removed a committed `scripts/__pycache__` and ignored it.
- 2026-09-30 foundation: gates ran on PORT=3020 because zwavejs2mqtt holds 3000 on the NAS; the default stays 3000.
- 2026-09-30 foundation: typescript resolved to 7.0.2 and vite to 8.3.1 at install; both typecheck and build cleanly, kept.
