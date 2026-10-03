/**
 * Alleys on the Flag screen (SPEC 22, alleys). The OpenStreetMap alleys cached
 * in `osm_alleys` are cut into halves (`alley-halves.ts`) with the parcels
 * backing onto them; the Flag screen picks a half by the camera's bearing and
 * the shutter makes it a lot the way Draw lot does (SPEC 24): source `drawn`,
 * no parcel, the name as its address, a 4 m outline round the half's
 * centreline, plus the half's key so the next flag finds the same lot.
 *
 * Reads the cache only; nothing here waits on Overpass.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { alleyNames } from "./alleys.ts";
import { alleyOutline, halfMiddle, parseHalfKey, splitAlley, type AlleyHalf, type HalfSide } from "./alley-halves.ts";
import { db } from "./db/index.ts";
import { lots, osmAlleys, parcels, type Lot, type LotGeometry } from "./db/schema.ts";
import { bboxOf, inRing, type LatLng, type Ring } from "./geo.ts";
import { emitLot } from "./lots-import.ts";
import { ccDayArea, crewForPoint, setLot, type Actor } from "./parcel-status.ts";
import { siteCcIds } from "./queries.ts";

const M_LAT = 111_320;
/** Parcels this far round an alley's box: the ones backing onto it (45 m) and the ones that name it (80 m from a half's middle). */
const PARCEL_PAD_M = 90;

// #region halves
export interface FlagAlleyHalf {
  key: string;
  /** "Alley, Lawrence to Collingwood, west half" */
  name: string;
  /** [[lat, lng], ...] */
  line: Array<[number, number]>;
  geometry: LotGeometry;
  /** The half's middle. */
  lat: number;
  lng: number;
  /** The lot already made for this half (by its key, or a drawn lot over its middle), or null. */
  lotId: number | null;
}

type AlleyRow = typeof osmAlleys.$inferSelect;
type NameParcel = Pick<typeof parcels.$inferSelect, "lat" | "lng" | "streetName" | "crossStreet1" | "crossStreet2">;

const parcelsNear = (a: Pick<AlleyRow, "minLat" | "maxLat" | "minLng" | "maxLng">): NameParcel[] => {
  const dLat = PARCEL_PAD_M / M_LAT;
  const dLng = PARCEL_PAD_M / (M_LAT * Math.cos((a.minLat * Math.PI) / 180));
  return db
    .select({ lat: parcels.lat, lng: parcels.lng, streetName: parcels.streetName, crossStreet1: parcels.crossStreet1, crossStreet2: parcels.crossStreet2 })
    .from(parcels)
    .where(sql`${parcels.lat} between ${a.minLat - dLat} and ${a.maxLat + dLat} and ${parcels.lng} between ${a.minLng - dLng} and ${a.maxLng + dLng}`)
    .all();
};

/** "Alley, Lawrence to Collingwood, west half": the streets either side, as Draw lot names an alley, and the half by compass. */
export const halfName = (half: Pick<AlleyHalf, "line" | "side">, near: readonly NameParcel[]): string => {
  const ends = [half.line[0]!, half.line[half.line.length - 1]!].sort((a, b) => a[1] - b[1]);
  const n = alleyNames(ends, near);
  const streets = [n.betweenStreet1, n.betweenStreet2].filter((x): x is string => !!x);
  const where = streets.length === 2 ? `${streets[0]} to ${streets[1]}` : (streets[0] ?? null);
  const side: Record<HalfSide, string> = { north: "north half", south: "south half", east: "east half", west: "west half" };
  return [where ? `Alley, ${where}` : "Alley", side[half.side]].join(", ");
};

/** The halves of one cached alley way, named, with outlines. */
const halvesOf = (a: AlleyRow): Array<Omit<FlagAlleyHalf, "lotId">> => {
  const near = parcelsNear(a);
  return splitAlley(a.osmId, a.centerline, near).map((h) => {
    const [lat, lng] = halfMiddle(h.line);
    return { key: h.key, name: halfName(h, near), line: h.line, geometry: alleyOutline(h.line), lat, lng };
  });
};

/** Point inside a lot outline. */
const inGeometry = (p: LatLng, g: LotGeometry | null): boolean => {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((rings) => {
    const outer = rings[0];
    if (!outer) return false;
    const ring = (r: number[][]): Ring => r.map((q): [number, number] => [q[0] ?? 0, q[1] ?? 0]);
    return inRing(p, ring(outer)) && !rings.slice(1).some((h) => inRing(p, ring(h)));
  });
};

/** Drawn lots at the CC's site with no alley key: a hand-drawn alley lot over a half's middle is that half's lot. */
const drawnAt = (actor: Actor): Lot[] =>
  db
    .select()
    .from(lots)
    .where(and(eq(lots.eventId, actor.event.id), eq(lots.source, "drawn"), isNull(lots.alleyKey), inArray(lots.ccId, siteCcIds(actor.cc.id))))
    .all();

/** The lot of a half: by its key, else a hand-drawn lot over its middle. */
const lotForHalf = (actor: Actor, half: Pick<FlagAlleyHalf, "key" | "lat" | "lng">, drawn: readonly Lot[]): Lot | null =>
  db.select().from(lots).where(and(eq(lots.eventId, actor.event.id), eq(lots.alleyKey, half.key))).get() ?? drawn.find((l) => inGeometry(half, l.geometry)) ?? null;

/**
 * The alley halves in the CC's day area (a half counts when its middle is
 * inside), from the cache. Empty when the CC has no day area or no alleys
 * were ever fetched.
 */
export const alleyHalvesFor = (actor: Actor): FlagAlleyHalf[] => {
  const rings = ccDayArea(actor.cc, actor.day);
  const box = bboxOf(rings.flat().map(([lng, lat]) => ({ lat, lng })));
  if (!box) return [];
  const rows = db
    .select()
    .from(osmAlleys)
    .where(and(lte(osmAlleys.minLat, box[3]), gte(osmAlleys.maxLat, box[1]), lte(osmAlleys.minLng, box[2]), gte(osmAlleys.maxLng, box[0])))
    .all();
  const halves = rows.flatMap(halvesOf).filter((h) => rings.some((r) => inRing(h, r)));
  if (halves.length === 0) return [];
  const byKey = new Map<string, number>();
  const keys = halves.map((h) => h.key);
  for (let i = 0; i < keys.length; i += 500) {
    for (const l of db
      .select({ id: lots.id, alleyKey: lots.alleyKey })
      .from(lots)
      .where(and(eq(lots.eventId, actor.event.id), inArray(lots.alleyKey, keys.slice(i, i + 500))))
      .all()) {
      if (l.alleyKey) byKey.set(l.alleyKey, l.id);
    }
  }
  const drawn = drawnAt(actor);
  return halves.map((h) => ({ ...h, lotId: byKey.get(h.key) ?? drawn.find((l) => inGeometry(h, l.geometry))?.id ?? null }));
};
// #endregion

// #region flag
const bad = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });

/**
 * The Flag shutter on an alley half: finds the half's lot and sets its status,
 * or makes the lot as Draw lot does, with the crew of the rectangle holding the
 * half's middle (SPEC 21's rule for Todo on a bare parcel).
 */
export const flagAlley = (actor: Actor, key: string, status: "open" | "do_not_touch", by: string | null): { lot: Lot } => {
  if (actor.role !== "green" && actor.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
  const k = parseHalfKey(key);
  if (!k) throw bad("Alley not found");
  const row = db.select().from(osmAlleys).where(eq(osmAlleys.osmId, k.osmId)).get();
  const half = row ? halvesOf(row).find((h) => h.key === key) : undefined;
  if (!half) throw bad("Alley not found");
  if (!ccDayArea(actor.cc, actor.day).some((r) => inRing(half, r))) throw new TRPCError({ code: "FORBIDDEN", message: "Alley not at this command center" });
  // No await between the look-up and the insert: one flag at a time, two phones cannot make two lots.
  const found = lotForHalf(actor, half, drawnAt(actor));
  if (found) {
    const r = setLot(actor, { lotId: found.id, status }, by);
    return { lot: r.lot ?? found };
  }
  const lot = db
    .insert(lots)
    .values({
      eventId: actor.event.id,
      parcelId: null,
      address: half.name,
      lat: half.lat,
      lng: half.lng,
      source: "drawn",
      geometry: half.geometry,
      ccId: actor.cc.id,
      crewId: crewForPoint(actor.cc, actor.day, half, null),
      status,
      statusAt: Date.now(),
      statusByCrewId: null,
      alleyKey: half.key,
    })
    .returning()
    .get();
  emitLot(lot);
  return { lot };
};
// #endregion
