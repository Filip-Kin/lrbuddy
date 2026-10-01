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
