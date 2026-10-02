# Bugs the e2e suite found

Each entry has a test in `specs/found.e2e.ts` marked `test.fixme` with the entry's id. When a fix
lands, change `test.fixme` to `test` and run `bun run e2e specs/found.e2e.ts`.

## FOUND-1: leaving a map while it zooms throws `_leaflet_pos`

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

Test: `found.e2e.ts` "FOUND-1 ...". Other specs wait for the map to settle before they navigate,
and the fixtures report this one error as an annotation instead of failing the test, so the bug
does not make unrelated tests flaky.

## FOUND-2: Land Bank addresses keep the Land Bank's capitals

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
