/**
 * Drawn lots (SPEC 24): an alley between backyards, a median, a corner dump,
 * anything the parcel layer has no outline for. A green or admin draws the
 * polygon; it becomes a `lots` row with source `drawn`, no parcel id, the
 * shape as its geometry, the centroid as its point and the name as its
 * address. After that it is a lot like any other.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { alleyNames } from "./alleys.ts";
import { db } from "./db/index.ts";
import { crews, lotPhotos, lots, type Lot, type LotGeometry, type LotStatus } from "./db/schema.ts";
import { emitLot } from "./lots-import.ts";
import { cachedParcelsInBBox } from "./parcels.ts";
import { checkPlace, crewForPoint, type Actor } from "./parcel-status.ts";

/** SPEC 24: at least this far across, so a stray double tap makes no lot. */
export const MIN_ACROSS_M = 10;
/** A shape this many times longer than wide is an alley and gets the streets' names. */
const ALLEY_RATIO = 3;
/** Parcels this far round the centre name the streets either side. */
const NAME_BOX_M = 150;
const M_LAT = 111_320;

const bad = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });

/** A drawn outline as the routers take it: one ring of [lng, lat], closed or not. */
export const drawnPolygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z
    .array(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3).max(201))
    .length(1),
});
export type DrawnPolygon = z.infer<typeof drawnPolygon>;

// #region shape
interface Shape {
  geometry: LotGeometry;
  lat: number;
  lng: number;
  /** Local metres round the centroid, for the alley test. */
  xy: Array<[number, number]>;
}

/** Closes the ring, drops repeats, checks three points and 10 m across, and finds the centroid. */
export const drawnShape = (polygon: DrawnPolygon): Shape => {
  const raw = polygon.coordinates[0]!.map(([lng, lat]): [number, number] => [lng, lat]);
  const pts = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1]![0] || p[1] !== raw[i - 1]![1]);
  if (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
  if (pts.length < 3) throw bad("Three points or more");
  const lat0 = pts.reduce((n, p) => n + p[1], 0) / pts.length;
  const lng0 = pts.reduce((n, p) => n + p[0], 0) / pts.length;
  const kx = M_LAT * Math.cos((lat0 * Math.PI) / 180);
  const local = pts.map(([lng, lat]): [number, number] => [(lng - lng0) * kx, (lat - lat0) * M_LAT]);
  let across = 0;
  for (const a of local) for (const b of local) across = Math.max(across, Math.hypot(a[0] - b[0], a[1] - b[1]));
  if (across < MIN_ACROSS_M) throw bad("Shape under 10 m across");
  // Area-weighted centroid; a shape with no area (all points on a line) is refused.
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < local.length; i++) {
    const p = local[i]!;
    const q = local[(i + 1) % local.length]!;
    const c = p[0] * q[1] - q[0] * p[1];
    a2 += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a2 / 2) < 1) throw bad("Shape has no area");
  cx /= 3 * a2;
  cy /= 3 * a2;
  const ring = [...pts, pts[0]!].map(([lng, lat]) => [lng, lat]);
  return {
    geometry: { type: "Polygon", coordinates: [ring] },
    lat: lat0 + cy / M_LAT,
    lng: lng0 + cx / kx,
    xy: local.map(([x, y]): [number, number] => [x - cx, y - cy]),
  };
};

/** The shape's long axis through its centre, as [[lat, lng], [lat, lng]] west end first, and its length and width. */
const axisOf = (s: Shape): { ends: Array<[number, number]>; length: number; width: number } => {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of s.xy) {
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u = [Math.cos(t), Math.sin(t)] as const;
  const along = s.xy.map(([x, y]) => x * u[0] + y * u[1]);
  const across = s.xy.map(([x, y]) => -x * u[1] + y * u[0]);
  const lo = Math.min(...along);
  const hi = Math.max(...along);
  const kx = M_LAT * Math.cos((s.lat * Math.PI) / 180);
  const at = (d: number): [number, number] => [s.lat + (u[1] * d) / M_LAT, s.lng + (u[0] * d) / kx];
  const ends = [at(lo), at(hi)].sort((a, b) => a[1] - b[1]);
  return { ends, length: hi - lo, width: Math.max(...across) - Math.min(...across) };
};
// #endregion

// #region name and crew
export interface DrawnSuggestion {
  /** "Alley, Lawrence to Collingwood" for a long thin shape, else "Lot". */
  name: string;
  /** The crew of the rectangle holding the centre (SPEC 21's rule), or null. */
  crewId: number | null;
}

/**
 * The name and crew the Save sheet starts with. An alley's streets are the
 * parcels' streets either side of its long axis; with the axis running west
 * to east, the street on its left (north) comes first.
 */
export const suggestDrawn = (actor: Actor, polygon: DrawnPolygon): DrawnSuggestion => {
  const s = drawnShape(polygon);
  const crewId = crewForPoint(actor.cc, actor.day, { lat: s.lat, lng: s.lng }, null);
  const axis = axisOf(s);
  if (axis.length < ALLEY_RATIO * Math.max(axis.width, 1)) return { name: "Lot", crewId };
  const dLat = NAME_BOX_M / M_LAT;
  const dLng = NAME_BOX_M / (M_LAT * Math.cos((s.lat * Math.PI) / 180));
  const parcels = cachedParcelsInBBox([s.lng - dLng, s.lat - dLat, s.lng + dLng, s.lat + dLat], 3000);
  const n = alleyNames(axis.ends, parcels);
  const streets = [n.betweenStreet1, n.betweenStreet2].filter((x): x is string => !!x);
  return { name: streets.length === 2 ? `Alley, ${streets[0]} to ${streets[1]}` : streets.length === 1 ? `Alley, ${streets[0]}` : "Alley", crewId };
};
// #endregion

// #region writes
const greenOnly = (actor: Actor): void => {
  if (actor.role !== "green" && actor.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
};

const crewHere = (actor: Actor, crewId: number | null): void => {
  if (crewId === null) return;
  const c = db.select({ ccId: crews.ccId }).from(crews).where(eq(crews.id, crewId)).get();
  if (!c || c.ccId !== actor.cc.id) throw bad("Crew not at this command center");
};

export interface DrawnInput {
  polygon: DrawnPolygon;
  name: string;
  status: LotStatus;
  crewId: number | null;
}

/** Save on the Draw lot sheet: a new lot at the actor's CC. */
export const createDrawnLot = (actor: Actor, input: DrawnInput): Lot => {
  greenOnly(actor);
  crewHere(actor, input.crewId);
  const s = drawnShape(input.polygon);
  const name = input.name.trim() || "Lot";
  const lot = db
    .insert(lots)
    .values({
      eventId: actor.event.id,
      parcelId: null,
      address: name,
      lat: s.lat,
      lng: s.lng,
      source: "drawn",
      geometry: s.geometry,
      ccId: actor.cc.id,
      crewId: input.crewId,
      status: input.status,
      statusAt: Date.now(),
      statusByCrewId: null,
    })
    .returning()
    .get();
  emitLot(lot);
  return lot;
};

const drawnLotOf = (actor: Actor, lotId: number): Lot => {
  const lot = db.select().from(lots).where(and(eq(lots.id, lotId), eq(lots.eventId, actor.event.id))).get();
  if (!lot) throw new TRPCError({ code: "NOT_FOUND", message: "Lot not found" });
  if (lot.source !== "drawn") throw bad("Only a drawn lot changes shape");
  checkPlace(actor, { lot, parcelId: null, point: { lat: lot.lat, lng: lot.lng } });
  return lot;
};

/** Edit shape: a new outline for a drawn lot; status, crew and photos stay. */
export const editDrawnShape = (actor: Actor, lotId: number, polygon: DrawnPolygon): Lot => {
  greenOnly(actor);
  drawnLotOf(actor, lotId);
  const s = drawnShape(polygon);
  const lot = db.update(lots).set({ geometry: s.geometry, lat: s.lat, lng: s.lng }).where(eq(lots.id, lotId)).returning().get();
  emitLot(lot);
  return lot;
};

/**
 * A drawn lot with history: a photo, deleted ones too, a note, work on it
 * (In progress or Done), or a status a crew set. It can only go Not todo.
 */
export const hasHistory = (lot: Lot): boolean =>
  lot.status === "in_progress" ||
  lot.status === "done" ||
  lot.statusByCrewId !== null ||
  !!lot.note?.trim() ||
  !!db.select({ id: lotPhotos.id }).from(lotPhotos).where(eq(lotPhotos.lotId, lot.id)).limit(1).get();

/** Delete lot from its sheet: refused once the lot has photos or history. */
export const deleteDrawnLot = (actor: Actor, lotId: number): { deleted: true } => {
  greenOnly(actor);
  const lot = drawnLotOf(actor, lotId);
  if (hasHistory(lot)) throw bad("Lot has photos or history. Set it Not todo.");
  db.delete(lots).where(eq(lots.id, lot.id)).run();
  emitLot(lot);
  return { deleted: true };
};
// #endregion
