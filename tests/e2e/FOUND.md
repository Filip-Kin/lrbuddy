# Bugs the e2e suite found

Each entry has a test in `specs/found.e2e.ts` named with the entry's id, marked `test.fixme` while
the bug is open. When a fix lands, change `test.fixme` to `test`, run `bun run e2e found.e2e.ts`,
and mark the entry fixed with its commit.

## FOUND-1: leaving a map while it zooms throws `_leaflet_pos`

**Fixed in 1dd57ca.** Every map now goes through `web/src/lib/map/removeMap.ts`, which stops
animations, finishes the pending zoom, clears the wheel and pinch timers, removes the map and
drops its listeners. The fixtures no longer excuse this error.

Tapping a nav link while a Leaflet map is still animating (the zoom buttons, a wheel zoom, or the
first fit just after the screen opens) throws an uncaught
`TypeError: Cannot read properties of undefined (reading '_leaflet_pos')`. The next screen opens,
but the error goes through `window.onerror` to `POST /client-error` and lands in
**Client errors** as if a screen had crashed, so every quick tap away from a map is a false report
in the list Filip reads after a field day. Seen first in the suite on the green map going to Crews.

Repro (any role with a map; green shown):

1. Sign in as a green shirt (`EAST01`) at 1440 x 900, open `/`.
2. Tap the map's **+** and within 200 ms tap **Crews** in the nav.
3. The page logs the TypeError; `/admin/client-errors` lists it with url `/` or `/crews`.

The same happens when **Crews** is tapped within about 200 ms of the map screen opening (the first
fit). Likely cause: `web/src/lib/map/MapView.tsx` calls `m.remove()` on unmount while a zoom
transition is pending; Leaflet's `_onZoomTransitionEnd` then reads a removed pane. Stopping the
animation first (`m.stop()`, or `m.off()` and removing on `zoomend`) is the usual fix.

Test: `found.e2e.ts` "FOUND-1 ...", with an in-page round (zoom and route change from one script)
because the Playwright clicks alone could land after the zoom had ended and pass on the bug.

## FOUND-2: Land Bank addresses keep the Land Bank's capitals

**Fixed in 1dd57ca.** `titleCase` runs in `fetchDlba`, `upsertLots` (Land Bank, vacant parcels,
CSV), `addManualLot`, publish, the survey photo lot and the drawn-lot alley names. Lots stored
before the fix: `DATA_DIR=<dir> bun scripts/fix-address-case.ts` (`--dry` to count first).

`fetchDlba` (`server/lots-import.ts`, the `out.push` in the page loop) stores the Land Bank's
`name` as it comes, in capitals ("4136 BUCKINGHAM"), while lots from the parcel layer go through
`titleCase` ("4131 Buckingham"); `titleCase`'s own comment says the Land Bank writes addresses
that way. Publish rewrites the addresses of the lots it touches but leaves done lots alone, so a
crew's Lots list (and the green map sheets, the print sheets and the exports) mixes the two:

    4131 Buckingham    Todo
    4136 BUCKINGHAM    Done
    4114 DEVONSHIRE    Done

Repro: the e2e seed (its fake Land Bank answers in capitals, as `titleCase`'s comment describes the
real one), sign in as
`demo-crew-07`, open `/lots`. Or Import DLBA on `/admin/lots` and open a new lot's sheet.

Test: `found.e2e.ts` "FOUND-2 ...".
