
## Lot outlines (spec change 2026-09-30 17:35, after the scaffold started)
- server/db/schema.ts: add `geometry` (text, nullable) to `lots`; regenerate migrations.
- server/lots-import.ts: after a DLBA import fetch parcel polygons in batches of 100 from the
  parcel_file_current layer (SPEC section 8) and store GeoJSON on each lot; add the Vacant parcels
  import (`source: 'parcel'`); manual and CSV lots resolve their parcel by point query.
- server/seed.ts: seeded lots get their outlines too (fetch live; if offline, synthesise a 12 m x 35 m
  rectangle around the point so the map still shows outlines).
- web/src/lib/map: a `lotLayer` helper that draws GeoJSON polygons in the status colour with a square
  fallback, used by crew, green and admin maps. Role agents may have drawn squares; replace with this.
