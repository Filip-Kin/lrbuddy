/**
 * One parcel status (SPEC 21): Not todo, Todo, In progress, Done, Do not touch,
 * for every parcel in a CC's day area, edited from every role's map.
 *
 * Not todo is the absence of a lot row, or `not_todo` on a lot that has
 * history. Todo on a bare parcel creates the lot for the CC, with the crew
 * whose rectangle holds it. Who may write what:
 * - green and admin: anything at the CC, Do not touch included;
 * - driver: Todo, In progress, Done and Not todo on any lot at the CC's site
 *   and any parcel in the CC's day area;
 * - crew: the same four inside its own rectangle; a crew without a rectangle
 *   keeps the old rule (its own lots, lots at its CC, loose lots within 400 m).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import {
  assignments,
  crewAreas,
  crews,
  lotPhotos,
  lots,
  parcels,
  surveyTags,
  type CommandCenter,
  type Crew,
  type Day,
  type Event,
  type Lot,
  type LotGeometry,
  type LotGrade,
  type LotStatus,
} from "./db/schema.ts";
import { latestPosition } from "./dispatch.ts";
import { bboxOf, haversine, inRing, type LatLng, type Ring } from "./geo.ts";
import { emitLot, titleCase } from "./lots-import.ts";
import { isWork, newestTags } from "./parcels.ts";
import { siteCcIds } from "./queries.ts";
import { dayAreas, type AreaView } from "./routers/plan/areas.ts";
import { DAY_AREA_PAD_M, padRing } from "./routers/plan/print.ts";

/** A crew without a rectangle may still mark loose lots this close to its last position (SPEC 8). */
export const CREW_NEARBY_M = 400;
/** Most bare parcels one map asks for; the CC B day area holds about 1,500. */
export const MAX_BARE = 6000;

export type ActorRole = "admin" | "green" | "driver" | "crew";

export interface Actor {
  role: ActorRole;
  cc: CommandCenter;
  day: Day;
  event: Event;
  /** The crew row for a crew session. */
  crew: Crew | null;
}

const forbidden = (message: string): TRPCError => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message });

// #region areas
/** The polygon of an area as a ring, or null when it has none. */
const ringOf = (a: Pick<AreaView, "polygon">): Ring | null => {
  const r = a.polygon?.coordinates[0];
  if (!r || r.length < 4) return null;
  return r.map((p): [number, number] => [p[0] ?? 0, p[1] ?? 0]);
};

/** The CC's rectangles on its day that have an outline. */
export const ccAreas = (cc: CommandCenter, day: Day): Array<AreaView & { ring: Ring }> =>
  dayAreas(day.id).flatMap((a) => {
    const ring = a.ccId === cc.id ? ringOf(a) : null;
    return ring ? [{ ...a, ring }] : [];
  });

/**
 * The CC's day area (SPEC 19): every rectangle at the CC grown 60 m, else the
 * box of its work lots grown 60 m. Empty when the CC has neither.
 */
export const ccDayArea = (cc: CommandCenter, day: Day): Ring[] => {
  const areas = ccAreas(cc, day);
  if (areas.length > 0) return areas.map((a) => padRing(a.ring, DAY_AREA_PAD_M));
  const work = db
    .select({ lat: lots.lat, lng: lots.lng })
    .from(lots)
    .where(and(inArray(lots.ccId, siteCcIds(cc.id)), inArray(lots.status, ["open", "in_progress", "done", "do_not_touch"])))
    .all();
  const box = bboxOf(work);
  if (!box) return [];
  return [padRing([[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], DAY_AREA_PAD_M)];
};

/** The crew's own rectangle, or null when it has none. */
export const crewRect = (crew: Crew): Ring | null => {
  if (crew.areaId === null) return null;
  const a = db.select().from(crewAreas).where(eq(crewAreas.id, crew.areaId)).get();
  return a ? ringOf(a) : null;
};

const inAny = (p: LatLng, rings: readonly Ring[]): boolean => rings.some((r) => inRing(p, r));

/** Shoelace area in square metres, for picking the smallest of overlapping rectangles. */
const ringArea = (ring: Ring): number => {
  const lat0 = ring.reduce((n, p) => n + p[1], 0) / Math.max(ring.length, 1);
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * kx * (b[1] * 111320) - b[0] * kx * (a[1] * 111320);
  }
  return Math.abs(s / 2);
};

/**
 * The crew a new Todo at this point goes to: the crews of the smallest
 * rectangle at the CC that holds it. With several crews in it, the one
 * holding the parcel's block side, else the one with the nearest lot, else
 * the first. Null outside every rectangle.
 */
export const crewForPoint = (cc: CommandCenter, day: Day, p: LatLng, parcelId: string | null): number | null => {
  const holding = ccAreas(cc, day)
    .filter((a) => a.crewIds.length > 0 && inRing(p, a.ring))
    .sort((a, b) => ringArea(a.ring) - ringArea(b.ring));
  const area = holding[0];
  if (!area) return null;
  if (area.crewIds.length === 1) return area.crewIds[0]!;
  if (parcelId) {
    const key = db.select({ key: parcels.blockSideKey }).from(parcels).where(eq(parcels.parcelId, parcelId)).get()?.key;
    if (key) {
      const row = db
        .select({ crewId: assignments.crewId })
        .from(assignments)
        .where(and(eq(assignments.eventId, day.eventId), eq(assignments.blockSideKey, key)))
        .get();
      if (row?.crewId != null && area.crewIds.includes(row.crewId)) return row.crewId;
    }
  }
  const theirs = db
    .select({ crewId: lots.crewId, lat: lots.lat, lng: lots.lng })
    .from(lots)
    .where(inArray(lots.crewId, area.crewIds))
    .all();
  let best: { crewId: number; d: number } | null = null;
  for (const l of theirs) {
    if (l.crewId === null) continue;
    const d = haversine(p, l);
    if (!best || d < best.d) best = { crewId: l.crewId, d };
  }
  return best?.crewId ?? area.crewIds[0]!;
};
// #endregion

// #region bare parcels
export interface BareParcel {
  parcelId: string;
  address: string | null;
  lat: number;
  lng: number;
  geometry: LotGeometry;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Outline coordinates cut to 6 decimals (about 10 cm), which halves the payload of a day area. */
const slim = (g: LotGeometry): LotGeometry =>
  g.type === "Polygon"
    ? { type: "Polygon", coordinates: g.coordinates.map((r) => r.map((p) => p.map(round6))) }
    : { type: "MultiPolygon", coordinates: g.coordinates.map((poly) => poly.map((r) => r.map((p) => p.map(round6)))) };

/** Cached parcels with their centre inside any ring and no lot row in the event. */
const bareIn = (eventId: number, rings: readonly Ring[]): BareParcel[] => {
  if (rings.length === 0) return [];
  const box = bboxOf(rings.flat().map(([lng, lat]) => ({ lat, lng })));
  if (!box) return [];
  const [w, s, e, n] = box;
  const rows = db
    .select({ parcelId: parcels.parcelId, address: parcels.address, lat: parcels.lat, lng: parcels.lng, geometry: parcels.geometry })
    .from(parcels)
    .where(sql`${parcels.lat} between ${s} and ${n} and ${parcels.lng} between ${w} and ${e}`)
    .all()
    .filter((p) => inAny(p, rings));
  if (rows.length === 0) return [];
  const taken = new Set<string>();
  const ids = rows.map((r) => r.parcelId);
  for (let i = 0; i < ids.length; i += 500) {
    for (const l of db
      .select({ parcelId: lots.parcelId })
      .from(lots)
      .where(and(eq(lots.eventId, eventId), inArray(lots.parcelId, ids.slice(i, i + 500))))
      .all()) {
      if (l.parcelId) taken.add(l.parcelId);
    }
  }
  return rows
    .filter((r) => !taken.has(r.parcelId))
    .slice(0, MAX_BARE)
    .map((r) => ({ parcelId: r.parcelId, address: r.address ? titleCase(r.address) : null, lat: r.lat, lng: r.lng, geometry: slim(r.geometry) }));
};

/**
 * Bare parcels a role sees (SPEC 21, who sees which parcels): greens and admin
 * the whole day area, a crew only inside its own rectangle, drivers none.
 */
export const bareParcelsFor = (actor: Actor): BareParcel[] => {
  if (actor.role === "driver") return [];
  if (actor.role === "crew") {
    const rect = actor.crew ? crewRect(actor.crew) : null;
    return rect ? bareIn(actor.event.id, [rect]) : [];
  }
  return bareIn(actor.event.id, ccDayArea(actor.cc, actor.day));
};
// #endregion

// #region rules
/** Where a lot or parcel sits, for the permission check. */
interface Target {
  lot: Lot | null;
  parcelId: string | null;
  point: LatLng;
}

const crewPoint = (crew: Crew, cc: CommandCenter): LatLng => {
  const p = latestPosition("crew", crew.id);
  return p ? { lat: p.lat, lng: p.lng } : { lat: cc.lat, lng: cc.lng };
};

/** Throws when the actor may not touch the target at all. */
export const checkPlace = (actor: Actor, t: Target): void => {
  const site = siteCcIds(actor.cc.id);
  if (t.lot && t.lot.ccId !== null && !site.includes(t.lot.ccId)) throw forbidden("Lot not at this command center");
  if (actor.role === "green" || actor.role === "admin") return;
  if (actor.role === "driver") {
    if (t.lot && t.lot.ccId !== null) return;
    if (!inAny(t.point, ccDayArea(actor.cc, actor.day))) throw forbidden("Parcel not at this command center");
    return;
  }
  const crew = actor.crew;
  if (!crew) throw forbidden("Not allowed");
  const rect = crewRect(crew);
  if (rect) {
    if (!inRing(t.point, rect)) throw forbidden("Parcel outside this crew's area");
    return;
  }
  // No rectangle: the crew lots rule from before SPEC 21.
  const lot = t.lot;
  if (!lot) throw forbidden("Parcel outside this crew's area");
  const allowed = lot.crewId === crew.id || lot.ccId !== null || haversine(crewPoint(crew, actor.cc), lot) <= CREW_NEARBY_M;
  if (!allowed) throw forbidden("Lot not at this command center");
};

/** Do not touch is set and cleared by green shirts and admin only. */
const checkStatus = (actor: Actor, from: LotStatus | null, to: LotStatus): void => {
  if (actor.role === "green" || actor.role === "admin") return;
  if (to === "do_not_touch" || from === "do_not_touch") throw forbidden("Do not touch is for green shirts");
};

/** A lot nobody has worked on: still Todo, no live photo, no note. Not todo deletes it instead of keeping a row. */
const untouched = (lot: Lot): boolean => {
  if (lot.status !== "open") return false;
  if (lot.note && lot.note.trim() !== "") return false;
  // A deleted photo does not count: Undo on the Flag screen deletes its photo, then the lot.
  const photo = db.select({ id: lotPhotos.id }).from(lotPhotos).where(and(eq(lotPhotos.lotId, lot.id), isNull(lotPhotos.deletedAt))).limit(1).get();
  return !photo;
};
// #endregion

// #region write
export interface SetLotInput {
  lotId?: number | null;
  parcelId?: string | null;
  status?: LotStatus;
  /** Full day or Light; null clears it. */
  grade?: LotGrade | null;
  note?: string | null;
}

export interface SetLotResult {
  /** The lot after the write; null when the parcel is (now) Not todo with no row. */
  lot: Lot | null;
  deleted: boolean;
  /** The `clear` survey tag a delete added, so Paint's Undo can take it back. */
  clearedTagId?: number | null;
}

export interface SetLotOptions {
  /** Where lot.changed goes; Paint collects them and emits after its transaction. */
  emit?: (lot: Lot) => void;
}

const resolve = (actor: Actor, input: SetLotInput): Target & { parcel: typeof parcels.$inferSelect | null } => {
  if (input.lotId != null) {
    const lot = db.select().from(lots).where(eq(lots.id, input.lotId)).get();
    if (!lot || lot.eventId !== actor.event.id) throw notFound("Lot not found");
    return { lot, parcelId: lot.parcelId, point: { lat: lot.lat, lng: lot.lng }, parcel: null };
  }
  const pid = input.parcelId?.trim();
  if (!pid) throw new TRPCError({ code: "BAD_REQUEST", message: "Lot or parcel needed" });
  const lot = db.select().from(lots).where(and(eq(lots.eventId, actor.event.id), eq(lots.parcelId, pid))).get() ?? null;
  if (lot) return { lot, parcelId: pid, point: { lat: lot.lat, lng: lot.lng }, parcel: null };
  const parcel = db.select().from(parcels).where(eq(parcels.parcelId, pid)).get();
  if (!parcel) throw notFound("Parcel not found");
  return { lot: null, parcelId: pid, point: { lat: parcel.lat, lng: parcel.lng }, parcel };
};

/** The survey grade of a parcel when it is work, for a new lot's Full day or Light tag. */
const surveyGrade = (eventId: number, parcelId: string | null): LotGrade | null => {
  if (!parcelId) return null;
  const g = newestTags(eventId, [parcelId]).get(parcelId)?.grade;
  return isWork(g) ? g : null;
};

/**
 * A parcel the green took off the work list is cleared in the survey too, so
 * a later Publish does not put the lot back (SPEC 16: clear removes it).
 */
const clearSurvey = (actor: Actor, lot: Lot, by: string | null): number | null => {
  // Only a lot Publish wrote from the survey comes back on the next Publish.
  if (!lot.parcelId || lot.source !== "survey") return null;
  const newest = db
    .select()
    .from(surveyTags)
    .where(and(eq(surveyTags.eventId, actor.event.id), eq(surveyTags.parcelId, lot.parcelId)))
    .orderBy(desc(surveyTags.at), desc(surveyTags.id))
    .get();
  if (!newest || !isWork(newest.grade)) return null;
  return db
    .insert(surveyTags)
    .values({ eventId: actor.event.id, parcelId: lot.parcelId, grade: "clear", side: "tap", note: null, lat: null, lng: null, heading: null, by, at: Date.now() })
    .returning({ id: surveyTags.id })
    .get().id;
};

/**
 * Sets a parcel's status (and grade or note) for the actor, creating or
 * deleting the lot row as SPEC 21 says. Emits lot.changed for every write.
 */
export const setLot = (actor: Actor, input: SetLotInput, by: string | null = null, opts: SetLotOptions = {}): SetLotResult => {
  const emit = opts.emit ?? emitLot;
  const t = resolve(actor, input);
  checkPlace(actor, t);
  const now = Date.now();
  const statusBy = actor.role === "crew" && actor.crew ? actor.crew.id : null;
  const note = input.note === undefined ? undefined : input.note?.trim() || null;

  // #region bare parcel
  if (!t.lot) {
    const parcel = t.parcel!;
    const status = input.status ?? "open";
    if (status === "not_todo") return { lot: null, deleted: false };
    checkStatus(actor, null, status);
    const crewId = actor.role === "crew" && actor.crew ? actor.crew.id : crewForPoint(actor.cc, actor.day, t.point, parcel.parcelId);
    const lot = db
      .insert(lots)
      .values({
        eventId: actor.event.id,
        parcelId: parcel.parcelId,
        address: parcel.address ? titleCase(parcel.address) : null,
        lat: parcel.lat,
        lng: parcel.lng,
        source: "manual",
        geometry: parcel.geometry,
        ccId: actor.cc.id,
        crewId,
        status,
        grade: input.grade === undefined ? surveyGrade(actor.event.id, parcel.parcelId) : input.grade,
        statusByCrewId: statusBy,
        statusAt: now,
        note: note ?? null,
      })
      .returning()
      .get();
    emit(lot);
    return { lot, deleted: false };
  }
  // #endregion

  const lot = t.lot;
  const status = input.status ?? lot.status;
  checkStatus(actor, lot.status, status);
  // A drawn lot (SPEC 24) is never deleted this way: its outline exists nowhere else.
  if (status === "not_todo" && lot.status !== "not_todo" && lot.source !== "drawn" && untouched(lot) && note === undefined) {
    db.delete(lots).where(eq(lots.id, lot.id)).run();
    const clearedTagId = clearSurvey(actor, lot, by);
    emit(lot);
    return { lot: null, deleted: true, clearedTagId };
  }
  const set: Partial<typeof lots.$inferInsert> = {};
  if (status !== lot.status) {
    set.status = status;
    set.statusAt = now;
    set.statusByCrewId = statusBy;
  }
  if (input.grade !== undefined && input.grade !== lot.grade) set.grade = input.grade;
  if (note !== undefined && note !== lot.note) set.note = note;
  // A loose lot (no CC yet) marked here joins this CC; a Todo with no crew goes to the rectangle's crew.
  if (lot.ccId === null && Object.keys(set).length > 0) set.ccId = actor.cc.id;
  if (status === "open" && lot.status !== "open" && lot.crewId === null) set.crewId = crewForPoint(actor.cc, actor.day, t.point, lot.parcelId);
  if (Object.keys(set).length === 0) return { lot, deleted: false };
  const updated = db.update(lots).set(set).where(eq(lots.id, lot.id)).returning().get();
  emit(updated);
  return { lot: updated, deleted: false };
};
// #endregion

// #region visibility
/** Lots a crew sees on its map and list: inside its rectangle, or the old rule without one. */
export const lotsInCrewRect = (crew: Crew, eventId: number, cc: CommandCenter): Lot[] | null => {
  const rect = crewRect(crew);
  if (!rect) return null;
  const box = bboxOf(rect.map(([lng, lat]) => ({ lat, lng })));
  if (!box) return [];
  const site = siteCcIds(cc.id);
  const today = new Set(db.select({ id: crews.id }).from(crews).where(eq(crews.dayId, crew.dayId)).all().map((r) => r.id));
  return db
    .select()
    .from(lots)
    .where(and(eq(lots.eventId, eventId), sql`${lots.lat} between ${box[1]} and ${box[3]} and ${lots.lng} between ${box[0]} and ${box[2]}`))
    .all()
    .filter((l) => (l.ccId === null || site.includes(l.ccId)) && inRing(l, rect))
    .map((l) => (l.crewId !== null && !today.has(l.crewId) ? { ...l, crewId: null } : l));
};
// #endregion
