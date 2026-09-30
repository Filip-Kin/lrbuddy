
## Lot outlines (spec change 2026-09-30 17:35, after the scaffold started)
- server/db/schema.ts: add `geometry` (text, nullable) to `lots`; regenerate migrations.
- server/lots-import.ts: after a DLBA import fetch parcel polygons in batches of 100 from the
  parcel_file_current layer (SPEC section 8) and store GeoJSON on each lot; add the Vacant parcels
  import (`source: 'parcel'`); manual and CSV lots resolve their parcel by point query.
- server/seed.ts: seeded lots get their outlines too (fetch live; if offline, synthesise a 12 m x 35 m
  rectangle around the point so the map still shows outlines).
- web/src/lib/map: a `lotLayer` helper that draws GeoJSON polygons in the status colour with a square
  fallback, used by crew, green and admin maps. Role agents may have drawn squares; replace with this.

## From the crew agent (2026-09-30)
- `.gitignore`: add `data-*/` and `web/dist-*/`. The per-agent sandboxes (`data-crew`, `web/dist-crew`, and the other roles') are not ignored today and would be picked up by a `git add -A`.
- `web/index.html`: `theme-color` is `#15803d` / `#0b1510` (a green from before the palette). The bar is `--bar` (`#0e3038` light, `#0a252c` dark); the phone status bar should match it.
- `server/routers/shared.ts` `me`: returns the crew row with `token` to the crew session. Harmless (the crew holds the token already) but nothing reads it; `crew: { ...row.crew, token: undefined }` or a column pick would keep it out of every response.
- tRPC error responses include `data.stack`. Check that the error formatter or `isDev` strips it when `NODE_ENV=production`.

## Driver agent (2026-09-30)
- .gitignore: add `data-*/` and `web/dist-*/`. Parallel agents run servers with `DATA_DIR=./data-driver` and build into
  `web/dist-driver`; the current patterns (`data/`, `dist/`) do not match those names, so they show as untracked.
- web/src/lib/position.ts (optional): after the Settings Location row's Allow button grants permission, the watcher
  that already failed with PERMISSION_DENIED only restarts on a visibility change. Restarting the watch when
  `navigator.permissions` reports `granted` would bring the blue dot back without leaving the page.

## Green agent (2026-09-30)
- .gitignore: add `data-*/` and `web/dist-*/` (same as crew and driver); `data-green` and `web/dist-green` are untracked sandboxes.
- web/src/lib/live.ts, `lots` case: add `void utils.green.stats.invalidate();`. Stats shows lots by status and lots done by company; today it only catches a lot change on its 60 s refetch.
- web/src/styles.css `.lrb-req span`: the ring fades to opacity 0 at the end of each pulse, so in a screenshot or a glance in sun it is often invisible. A static 2 px `--crew` ring under the pulsing one (box-shadow or a second element) keeps it readable. Affects crew and green maps.
- web/src/lib/map/MapView.tsx (optional): a `selected?: boolean` on lot markers (ink stroke, thicker) would replace the green Lots page drawing selected parcels as `lines`, which uses the route line style.
- 2026-09-30 18:09 EDT: the crew agent's cleanup ran `pkill -f "bun server/index.ts"`, which also stopped the driver (:3102) and green (:3103) sandbox servers, and possibly admin (:3104). Restart with `PORT=310x DATA_DIR=./data-<role> WEB_DIST=$PWD/web/dist-<role> bun server/index.ts`. Data is untouched.

## From the admin agent (2026-09-30)
- web/src/lib/map/MapView.tsx: optional `draggable` plus `onDragEnd(lat, lng)` on `cc` markers, so the admin day map can drag a CC as SPEC 5 says. Admin works around it with Move then tap.
- web/src/lib/map/MapView.tsx: optional `rects` prop (thin dashed outline) for selection rectangles. Admin draws them with `lines`, which uses the thick route style.
- .gitignore: add `data-*/` and `web/dist-*/`. Parallel agents build into `web/dist-admin` and run on `data-admin`; neither is ignored now.
- web/src/lib/format.ts: `ago(null)` returns lowercase "never"; admin handles null itself. Consider "Never" or leaving null to callers.
