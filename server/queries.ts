import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import {
  commandCenters,
  companies,
  crews,
  days,
  events,
  greenShirts,
  positions,
  requests,
  requestTypes,
  routes,
  trucks,
  type Event,
  type PositionKind,
  type Request,
  type RequestType,
} from "./db/schema.ts";
import { crewLabel, legEtaAt } from "./dispatch.ts";

/**
 * Every CC row of the event that is the same site as this one: same name, any
 * case, any day. Lots belong to a site, not to one day's CC row, so lots placed
 * at Day 1's CC North are at Day 2's CC North too.
 */
export const siteCcIds = (ccId: number): number[] => {
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  if (!cc) return [];
  const day = db.select().from(days).where(eq(days.id, cc.dayId)).get();
  if (!day) return [cc.id];
  return db
    .select({ id: commandCenters.id })
    .from(commandCenters)
    .innerJoin(days, eq(days.id, commandCenters.dayId))
    .where(and(eq(days.eventId, day.eventId), sql`lower(${commandCenters.name}) = ${cc.name.toLowerCase()}`))
    .all()
    .map((r) => r.id);
};

/** Crew ids on the day, for telling a lot's crew from today apart from one left over from another day. */
export const crewIdsOnDay = (dayId: number): Set<number> =>
  new Set(db.select({ id: crews.id }).from(crews).where(eq(crews.dayId, dayId)).all().map((r) => r.id));

export const activeEvent = (): Event | undefined => db.select().from(events).where(eq(events.active, true)).get();

export const catalogFor = (eventId: number, includeInactive = false): RequestType[] =>
  db
    .select()
    .from(requestTypes)
    .where(includeInactive ? eq(requestTypes.eventId, eventId) : and(eq(requestTypes.eventId, eventId), eq(requestTypes.active, true)))
    .orderBy(requestTypes.sort, requestTypes.id)
    .all();

export interface RequestView extends Request {
  typeKey: string;
  typeLabel: string;
  unit: RequestType["unit"];
  priority: number;
  crewNumber: number | null;
  crewName: string | null;
  leadName: string | null;
  leadPhone: string | null;
  companyId: number | null;
  companyName: string | null;
  truckName: string | null;
  /** Seconds from the route's computation to this stop; null when not on a route. */
  etaS: number | null;
  /** Absolute ETA in unix ms; null when not on a route. */
  etaAt: number | null;
}

/** Joins everything a request card shows. */
export const requestViews = (rows: readonly Request[], now = Date.now()): RequestView[] => {
  if (rows.length === 0) return [];
  const typeIds = [...new Set(rows.map((r) => r.typeId))];
  const crewIds = [...new Set(rows.map((r) => r.crewId).filter((x): x is number => x !== null))];
  const truckIds = [...new Set(rows.map((r) => r.truckId).filter((x): x is number => x !== null))];
  const types = new Map(db.select().from(requestTypes).where(inArray(requestTypes.id, typeIds)).all().map((t) => [t.id, t]));
  const crewRows =
    crewIds.length === 0
      ? []
      : db
          .select({ crew: crews, company: companies })
          .from(crews)
          .leftJoin(companies, eq(companies.id, crews.companyId))
          .where(inArray(crews.id, crewIds))
          .all();
  const crewMap = new Map(crewRows.map((c) => [c.crew.id, c]));
  const truckMap = new Map(
    truckIds.length === 0 ? [] : db.select().from(trucks).where(inArray(trucks.id, truckIds)).all().map((t) => [t.id, t]),
  );
  const routeMap = new Map(
    truckIds.length === 0 ? [] : db.select().from(routes).where(inArray(routes.truckId, truckIds)).all().map((r) => [r.truckId, r]),
  );
  return rows.map((r) => {
    const t = types.get(r.typeId);
    const c = r.crewId !== null ? crewMap.get(r.crewId) : undefined;
    const route = r.truckId !== null ? routeMap.get(r.truckId) : undefined;
    const truck = r.truckId !== null ? truckMap.get(r.truckId) : undefined;
    const leg = route?.legs.find((l) => l.requestIds.includes(r.id));
    const active = r.status === "assigned" || r.status === "en_route";
    return {
      ...r,
      typeKey: t?.key ?? "",
      typeLabel: t?.label ?? "Item",
      unit: t?.unit ?? "each",
      priority: t?.priority ?? 2,
      crewNumber: c?.crew.number ?? null,
      crewName: c ? crewLabel(c.crew) : null,
      leadName: c?.crew.leadName ?? null,
      leadPhone: c?.crew.leadPhone ?? null,
      companyId: c?.company?.id ?? null,
      companyName: c?.company?.name ?? null,
      truckName: truck?.name ?? null,
      etaS: active && leg ? leg.etaS : null,
      etaAt: active && leg && route && truck ? legEtaAt(route, leg, truck, now) : null,
    };
  });
};

export const requestsWhere = (where: ReturnType<typeof and>, limit = 500): RequestView[] =>
  requestViews(db.select().from(requests).where(where).orderBy(desc(requests.createdAt)).limit(limit).all());

export interface LatestPosition {
  refId: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  heading: number | null;
  at: number;
}

/** Latest position per entity. One query per id; fine for a CC's few dozen crews and trucks. */
export const latestPositions = (kind: PositionKind, ids: readonly number[]): Map<number, LatestPosition> => {
  const out = new Map<number, LatestPosition>();
  for (const id of ids) {
    const p = db
      .select()
      .from(positions)
      .where(and(eq(positions.kind, kind), eq(positions.refId, id)))
      .orderBy(desc(positions.at))
      .limit(1)
      .get();
    if (p) out.set(id, { refId: id, lat: p.lat, lng: p.lng, accuracy: p.accuracy, heading: p.heading, at: p.at });
  }
  return out;
};

export const ccCard = (ccId: number) => {
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  if (!cc) return null;
  const day = db.select().from(days).where(eq(days.id, cc.dayId)).get() ?? null;
  const greens = db.select().from(greenShirts).where(eq(greenShirts.ccId, ccId)).orderBy(greenShirts.id).all();
  return { cc, day, greenShirts: greens };
};

export type CcCard = NonNullable<ReturnType<typeof ccCard>>;
