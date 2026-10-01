# Integration notes

Requests between the parallel role agents (crew, driver, green, admin) for files
none of them owned. All of them were resolved in the integration pass on
2026-09-30; this file stays as the record. New cross-role requests go here.

## Resolved 2026-09-30

- Lot outlines (spec change after the scaffold started): schema, DLBA outline fetch, Vacant parcels
  import, point queries for CSV and manual lots, seed outlines, and one lot layer in MapView. Done in
  the foundation commit.
- `.gitignore` ignores `data-*/` and `web/dist-*/`; the per-role sandboxes are deleted.
- `web/index.html` theme-color matches the bar: `#0e3038` light, `#0a252c` dark.
- `shared.me` leaves out the crew join token.
- tRPC error responses carry no stack trace (`isDev: false` in `server/trpc.ts`).
- `web/src/lib/position.ts` restarts the watch when the geolocation permission turns `granted`, so
  Allow in Settings brings the blue dot back without leaving the page.
- `web/src/lib/live.ts` refreshes `green.stats` on lot events.
- `.lrb-req` draws a steady ring under the pulse.
- `MapView`: lot markers take `selected`; lines take `style: "select"` (thin dashed rectangle);
  CC markers take `onDragEnd`. The admin day map drags CCs (Move then tap still works on a phone);
  green Lots draws the selection with `selected`.
- `ago(null)` reads "Never".
- Found during integration: `styles.css` set `position: relative` on crew, truck and CC markers,
  which beat Leaflet's `position: absolute` and drew them away from their real place. Removed.

## Planning portal slice (2026-09-30)

The foundation is in. Each slice owns its files; ask here for changes to the shared ones.

- Survey and drive: `web/src/pages/plan/SurveyPage.tsx`, `DrivePage.tsx`, `server/routers/plan/survey.ts`.
- Blocks and assignments: `web/src/pages/plan/BlocksPage.tsx`, `AssignmentsPage.tsx`, `server/routers/plan/blocks.ts`,
  `server/routers/plan/assignments.ts`, and the shared `web/src/lib/map/orientedRect.ts` (SPEC 16).
- Print: `web/src/pages/plan/PrintPage.tsx`, `server/routers/plan/print.ts`.
- Shared, change through a request here: `server/parcels.ts`, `server/db/schema.ts`, `server/routers/plan/common.ts`,
  `web/src/components/plan/*`, `web/src/pages/plan/index.tsx`, `scripts/gate.py`, `scripts/sheets.py`, the seed.
- 2026-09-30 print slice: `admin.print.sheet` (server/routers/admin.ts) has no UI caller since `/plan/print` reads `plan.print.sheets`; only `server/admin.test.ts` still uses it. It can go, with that test, in the next pass over admin.ts.
- 2026-09-30 print slice: `plan.print.sheets` crew pages now carry `code` (the crew token) and `loginUrl`; lot rows carry `parcelId`.
- 2026-09-30 blocks and assignments slice, requests for shared files:
  - `MapView`: an `onReady?: (map: L.Map) => void` prop (or a forwarded ref). `lib/map/orientedRect.ts` finds the map through `L.Map.addInitHook` instead; once the prop exists, `useLeafletMap` can go.
  - `styles.css`: take the CSS strings in `lib/map/orientedRect.ts` (`.lrb-orect*`) and `pages/plan/blocks/sides.ts` (`.lrb-side*`, `.lrb-area*`) into the map region and drop the two `injectCss` helpers.
  - `admin.lots`: `assignCcIds({ ids, ccId })` with `assignLotsToCcByBBox`'s same-site crew rule, for the admin Lots page's Assign CC (it sends one `update` per lot meanwhile). `importDlba`, `countVacant` and `importVacant` could take a polygon (`esriGeometryPolygon`) so imports match the rotated rectangle instead of its bounding box.
  - `components/admin/rect.ts` (`useRectDraw`) is no longer used by either Lots page; Survey still uses it for Load parcels.
  - New procedure `plan.blocks.shapes` (hull per block side) and `attendCcId` on `plan.assignments.companies`; Print may want the shapes for its overview map.

### Requests from the survey slice (2026-09-30)

- `web/src/lib/map/MapView.tsx`: export `usePrefersDark`. `pages/plan/survey/style.ts` carries a copy because the hook is private.
- `web/src/components/plan/PlanLayout.tsx` or the portal settings: a Keep screen on switch for admins. Drive mode honours the driver preference (`lrb.driver.wake`, on by default) through `useWakeLock`, but only the driver Settings page can turn it off.
- `web/src/pages/plan/SurveyPage.tsx` and `DrivePage.tsx` are now one-line re-exports of `pages/plan/survey/`; `index.tsx` needs no change.
- New test file `server/routers/plan/survey.test.ts` covers `survey.sides`, `survey.lotOf` and `survey.lotForPhoto`; the drive rules are tested in `web/src/pages/plan/survey/drive.test.ts`.
