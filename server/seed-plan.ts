/**
 * Planning portal demo data for the seed (SPEC 16): the parcel cache for the
 * seed bbox, a survey tag on every seeded lot by "Kelsey" on 2026-07-14,
 * company attendance, and assignments for the day's crews, published so the
 * crews' lots and areas match the plan.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { assignments, companyDays, crews, lots, parcels, surveyTags, type Crew, type Lot, type LotGeometry } from "./db/schema.ts";
import { normalizeBBox, type BBox } from "./geo.ts";
import { areaAround, loadParcelsBBox, outlinePoints, upsertParcels, type ParcelInput } from "./parcels.ts";
import { publishAssignments } from "./routers/plan/assignments.ts";

/** 2026-07-14 10:00 in Detroit (EDT, UTC-4). */
const SURVEY_START = Date.UTC(2026, 6, 14, 14, 0, 0);
const FRESH_MS = 7 * 24 * 3600_000;

const square = (lat: number, lng: number): LotGeometry => {
  const dLat = 0.00009;
  const dLng = 0.00012;
  return {
    type: "Polygon",
    coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]],
  };
};

const ADDRESS = /^\s*(\d+)\s+(.+?)\s*$/;

/** Cache rows made from lots when the layer cannot be reached: street and number from the address, no cross streets. */
const parcelsFromLots = (rows: readonly Lot[]): ParcelInput[] =>
  rows.map((l) => {
    const m = l.address ? ADDRESS.exec(l.address) : null;
    return {
      parcelId: l.parcelId ?? `demo-${l.id}`,
      address: l.address,
      lat: l.lat,
      lng: l.lng,
      geometry: l.geometry ?? square(l.lat, l.lng),
      streetName: m?.[2]?.replace(/\s+St$/i, "").toUpperCase() ?? null,
      streetNumber: m ? Number(m[1]) : null,
      streetPrefix: null,
      crossStreet1: null,
      crossStreet2: null,
      propertyClass: "402",
      propertyClassDescription: "RESIDENTIAL-VACANT",
      taxpayer1: null,
      isImproved: false,
      pctPreClaimed: 0,
      saleDate: null,
    };
  });

/** Parcels for the bbox: kept when a recent load already covers it, else fetched; on failure made from the lots. */
const cacheParcels = async (bbox: BBox, eventLots: readonly Lot[]): Promise<string> => {
  const [w, s, e, n] = normalizeBBox(bbox);
  const have = db
    .select({ n: sql<number>`count(*)`, oldest: sql<number | null>`min(${parcels.fetchedAt})` })
    .from(parcels)
    .where(and(sql`${parcels.lat} between ${s} and ${n}`, sql`${parcels.lng} between ${w} and ${e}`))
    .get();
  const ids = eventLots.map((l) => l.parcelId).filter((x): x is string => x !== null);
  const covered = ids.length > 0 && db.select({ n: sql<number>`count(*)` }).from(parcels).where(inArray(parcels.parcelId, ids)).get()?.n === ids.length;
  if (have && have.n > 1000 && covered && have.oldest !== null && Date.now() - have.oldest < FRESH_MS) return `${have.n} parcels cached`;
  try {
    const r = await loadParcelsBBox(bbox, { timeoutMs: 30_000 });
    if (r.fetched > 0) return `${r.fetched} parcels loaded`;
  } catch (err) {
    console.warn("[seed] parcel layer failed, using parcels made from the lots:", err instanceof Error ? err.message : String(err));
  }
  const made = parcelsFromLots(eventLots);
  upsertParcels(made);
  db.transaction((tx) => {
    for (const l of eventLots) if (l.parcelId === null) tx.update(lots).set({ parcelId: `demo-${l.id}` }).where(eq(lots.id, l.id)).run();
  });
  return `${made.length} parcels made from lots`;
};

export interface SeedPlanResult {
  parcels: string;
  tags: number;
  assigned: number;
  /** Lots written or updated by the publish. */
  published: number;
  areas: number;
}

export const seedPlan = async (input: { eventId: number; dayId: number; bbox: BBox; crews: readonly Crew[] }): Promise<SeedPlanResult> => {
  const { eventId, dayId } = input;
  const before = db.select().from(lots).where(eq(lots.eventId, eventId)).all();
  const parcelNote = await cacheParcels(input.bbox, before);
  const eventLots = db.select().from(lots).where(eq(lots.eventId, eventId)).orderBy(lots.id).all();

  // #region survey tags
  // Every seeded lot: two thirds low, one third high. The other residential
  // vacant parcels on the block sides those lots sit on were driven too: a
  // few are work, the rest clear (see crewSides below).
  const withParcel = eventLots.filter((l): l is Lot & { parcelId: string } => l.parcelId !== null);
  const lotGrade = new Map(withParcel.map((l, i) => [l.parcelId, i % 3 === 0 ? ("high" as const) : ("low" as const)]));
  const sideKeys = [
    ...new Set(
      db
        .select({ key: parcels.blockSideKey })
        .from(parcels)
        .where(inArray(parcels.parcelId, [...lotGrade.keys()]))
        .all()
        .map((r) => r.key)
        .filter((k): k is string => k !== null),
    ),
  ];
  const driven = sideKeys.length
    ? db
        .select({ parcelId: parcels.parcelId, key: parcels.blockSideKey, num: parcels.streetNumber, lat: parcels.lat, lng: parcels.lng, cls: parcels.propertyClassDescription })
        .from(parcels)
        .where(inArray(parcels.blockSideKey, sideKeys))
        .all()
        .filter((r) => lotGrade.has(r.parcelId) || r.cls === "RESIDENTIAL-VACANT")
        .sort((a, b) => (a.key ?? "").localeCompare(b.key ?? "") || (a.num ?? 0) - (b.num ?? 0))
    : [];
  // Sides a seeded crew works on (they are assigned below) stay near the crew's own lots, so its sheet holds a
  // half day; the other sides are denser, so Blocks shows unassigned work in every band.
  const crewLotIds = new Set(withParcel.filter((l) => l.crewId !== null).map((l) => l.parcelId));
  const crewSides = new Set(driven.filter((r) => crewLotIds.has(r.parcelId)).map((r) => r.key).filter((k): k is string => k !== null));
  const sideOf = new Map<string, string | null>(driven.map((r) => [r.parcelId, r.key]));
  // Lots whose parcel has no block side still get their tag.
  const drivenIds = new Set(driven.map((r) => r.parcelId));
  const rest = withParcel.filter((l) => !drivenIds.has(l.parcelId)).map((l) => ({ parcelId: l.parcelId, lat: l.lat, lng: l.lng }));
  const route = [...driven, ...rest];
  db.transaction((tx) => {
    route.forEach((r, i) => {
      const k = (Number.parseInt(r.parcelId.replace(/\D/g, "").slice(-6) || "0", 10) * 2654435761) % 100;
      const key = sideOf.get(r.parcelId) ?? null;
      const dense = key !== null && !crewSides.has(key);
      const grade = lotGrade.get(r.parcelId) ?? (dense ? (k < 8 ? "high" : k < 35 ? "low" : "clear") : k < 2 ? "high" : k < 7 ? "low" : "clear");
      tx.insert(surveyTags)
        .values({ eventId, parcelId: r.parcelId, grade, side: i % 2 === 0 ? "left" : "right", lat: r.lat, lng: r.lng, by: "Kelsey", at: SURVEY_START + i * 12_000 })
        .run();
    });
  });
  // #endregion

  // #region company attendance from the crews
  const byCompany = new Map<number, Crew[]>();
  for (const c of input.crews) if (c.companyId !== null) byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), c]);
  for (const [companyId, list] of byCompany) {
    const ccIds = new Set(list.map((c) => c.ccId));
    db.insert(companyDays)
      .values({ companyId, dayId, ccId: ccIds.size === 1 ? list[0]!.ccId : null, headcount: list.reduce((n, c) => n + (c.headcount ?? 0), 0) })
      .run();
  }
  // #endregion

  // #region assignments: each block side goes to the crew with the most lots on it
  const keyOf = new Map(
    db
      .select({ parcelId: parcels.parcelId, key: parcels.blockSideKey })
      .from(parcels)
      .where(inArray(parcels.parcelId, withParcel.map((l) => l.parcelId)))
      .all()
      .map((r) => [r.parcelId, r.key]),
  );
  const votes = new Map<string, Map<number, number>>();
  for (const l of withParcel) {
    const key = keyOf.get(l.parcelId);
    if (!key || l.crewId === null) continue;
    const m = votes.get(key) ?? new Map<number, number>();
    m.set(l.crewId, (m.get(l.crewId) ?? 0) + 1);
    votes.set(key, m);
  }
  const crewById = new Map(input.crews.map((c) => [c.id, c]));
  let order = 1;
  let assigned = 0;
  for (const [key, m] of [...votes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [crewId] = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    const crew = crewById.get(crewId);
    if (!crew) continue;
    db.insert(assignments).values({ eventId, dayId, ccId: crew.ccId, companyId: crew.companyId, crewId, blockSideKey: key, order: order++ }).run();
    assigned++;
  }
  // #endregion

  // #region publish, as the Assignments page does, so lots and crew areas come from the assignments
  const published = publishAssignments(eventId, { dayId, resetAreas: true });
  // #endregion

  // #region areas: a crew with no assigned side gets one around its lots, padded 15 m
  let areas = published.areas;
  const afterPublish = db.select().from(lots).where(eq(lots.eventId, eventId)).all();
  const withArea = new Set(
    db
      .select({ id: crews.id })
      .from(crews)
      .where(and(inArray(crews.id, input.crews.map((c) => c.id)), sql`${crews.area} is not null`))
      .all()
      .map((r) => r.id),
  );
  for (const crew of input.crews) {
    if (withArea.has(crew.id)) continue;
    const mine = afterPublish.filter((l) => l.crewId === crew.id);
    const area = areaAround(mine.flatMap((l) => (l.geometry ? outlinePoints(l.geometry) : [{ lat: l.lat, lng: l.lng }])), 15);
    if (!area) continue;
    db.update(crews).set({ area }).where(eq(crews.id, crew.id)).run();
    areas++;
  }
  // #endregion

  return { parcels: parcelNote, tags: route.length, assigned, published: published.added + published.updated, areas };
};
