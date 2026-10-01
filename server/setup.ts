import { and, eq, max } from "drizzle-orm";
import { newCrewToken, uniqueCode } from "./auth.ts";
import { nextCrewName } from "./crew-name.ts";
import { db } from "./db/index.ts";
import {
  commandCenters,
  crews,
  days,
  events,
  greenCodes,
  greenShirts,
  requestTypes,
  trucks,
  truckStock,
  type CommandCenter,
  type Crew,
  type Event,
  type Truck,
  type Unit,
} from "./db/schema.ts";

/** SPEC 3 default catalog, in order, with the stock a new truck carries. */
export const DEFAULT_REQUEST_TYPES: ReadonlyArray<{
  key: string;
  label: string;
  unit: Unit;
  priority: number;
  tracksStock: boolean;
  defaultCapacity: number;
}> = [
  { key: "water", label: "Water", unit: "case", priority: 3, tracksStock: true, defaultCapacity: 30 },
  { key: "snacks", label: "Snacks", unit: "box", priority: 2, tracksStock: true, defaultCapacity: 12 },
  { key: "gas_mower", label: "Gas, mower", unit: "can", priority: 3, tracksStock: true, defaultCapacity: 6 },
  { key: "gas_trimmer", label: "Gas, weed whip", unit: "can", priority: 3, tracksStock: true, defaultCapacity: 6 },
  { key: "swap_mower", label: "Mower swap", unit: "each", priority: 2, tracksStock: true, defaultCapacity: 2 },
  { key: "swap_trimmer", label: "Weed whip swap", unit: "each", priority: 2, tracksStock: true, defaultCapacity: 2 },
  { key: "mower", label: "Mower", unit: "each", priority: 2, tracksStock: true, defaultCapacity: 2 },
  { key: "trimmer", label: "Weed whip", unit: "each", priority: 2, tracksStock: true, defaultCapacity: 3 },
  { key: "loppers", label: "Loppers", unit: "each", priority: 1, tracksStock: true, defaultCapacity: 6 },
  { key: "shovels", label: "Shovels", unit: "each", priority: 1, tracksStock: true, defaultCapacity: 6 },
  { key: "brooms", label: "Brooms", unit: "each", priority: 1, tracksStock: true, defaultCapacity: 6 },
  { key: "trash_bags", label: "Trash bags", unit: "roll", priority: 2, tracksStock: true, defaultCapacity: 12 },
  { key: "other", label: "Other", unit: "each", priority: 1, tracksStock: false, defaultCapacity: 0 },
];

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** New event with its days and the default catalog. Becomes active when `active` or when no event is active. */
export const createEvent = (input: { name: string; year: number; startDate: string; dayCount: number; active?: boolean }): Event => {
  return db.transaction((tx) => {
    const anyActive = tx.select({ id: events.id }).from(events).where(eq(events.active, true)).get();
    const makeActive = input.active ?? !anyActive;
    if (makeActive) tx.update(events).set({ active: false }).run();
    const ev = tx.insert(events).values({ name: input.name, year: input.year, active: makeActive }).returning().get();
    for (let i = 0; i < input.dayCount; i++) {
      tx.insert(days).values({ eventId: ev.id, date: addDays(input.startDate, i), label: `Day ${i + 1}`, sort: i + 1 }).run();
    }
    DEFAULT_REQUEST_TYPES.forEach((t, i) => {
      tx.insert(requestTypes).values({ eventId: ev.id, ...t, sort: i + 1, active: true }).run();
    });
    return ev;
  });
};

export const setActiveEvent = (eventId: number): void => {
  db.transaction((tx) => {
    tx.update(events).set({ active: false }).run();
    tx.update(events).set({ active: true }).where(eq(events.id, eventId)).run();
  });
};

export const eventIdOfDay = (dayId: number): number => {
  const d = db.select().from(days).where(eq(days.id, dayId)).get();
  if (!d) throw new Error("Day not found");
  return d.eventId;
};

/** New CC with its green code. */
export const createCc = (input: {
  dayId: number;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  notes?: string | null;
  letter?: string | null;
  code?: string;
}): CommandCenter => {
  const cc = db
    .insert(commandCenters)
    .values({ dayId: input.dayId, name: input.name, lat: input.lat, lng: input.lng, address: input.address ?? null, notes: input.notes ?? null, letter: input.letter ?? null })
    .returning()
    .get();
  db.insert(greenCodes).values({ ccId: cc.id, code: input.code ?? uniqueCode() }).run();
  return cc;
};

/** New truck with a stock row per tracked type, full at the default capacity. */
export const createTruck = (input: {
  dayId: number;
  ccId: number;
  name: string;
  driverName?: string | null;
  driverPhone?: string | null;
  code?: string;
}): Truck => {
  const eventId = eventIdOfDay(input.dayId);
  const truck = db
    .insert(trucks)
    .values({
      dayId: input.dayId,
      ccId: input.ccId,
      name: input.name,
      driverName: input.driverName ?? null,
      driverPhone: input.driverPhone ?? null,
      code: input.code ?? uniqueCode(),
      status: "idle",
    })
    .returning()
    .get();
  const types = db
    .select()
    .from(requestTypes)
    .where(and(eq(requestTypes.eventId, eventId), eq(requestTypes.tracksStock, true)))
    .all();
  for (const t of types) {
    db.insert(truckStock).values({ truckId: truck.id, typeId: t.id, qty: t.defaultCapacity, capacity: t.defaultCapacity }).run();
  }
  return truck;
};

export const nextCrewNumber = (dayId: number): number => {
  const r = db.select({ n: max(crews.number) }).from(crews).where(eq(crews.dayId, dayId)).get();
  return (r?.n ?? 0) + 1;
};

export const createCrew = (input: {
  dayId: number;
  ccId: number;
  companyId: number | null;
  leadName?: string | null;
  leadPhone?: string | null;
  headcount?: number | null;
  notes?: string | null;
  number?: number;
  /** A custom name; blank or absent takes the rule's name (`crew-name.ts`). */
  name?: string | null;
  token?: string;
}): Crew => {
  const number = input.number ?? nextCrewNumber(input.dayId);
  return db
    .insert(crews)
    .values({
      dayId: input.dayId,
      ccId: input.ccId,
      companyId: input.companyId,
      number,
      name: input.name?.trim() || nextCrewName({ dayId: input.dayId, companyId: input.companyId, number }),
      leadName: input.leadName ?? null,
      leadPhone: input.leadPhone ?? null,
      headcount: input.headcount ?? null,
      notes: input.notes ?? null,
      token: input.token ?? newCrewToken(),
    })
    .returning()
    .get();
};

/** Copies CCs (with green shirts), and trucks (with capacities) from the previous day. New codes. */
export const copySetupFromPreviousDay = (dayId: number): { ccs: number; trucks: number } => {
  const day = db.select().from(days).where(eq(days.id, dayId)).get();
  if (!day) throw new Error("Day not found");
  const prev = db
    .select()
    .from(days)
    .where(eq(days.eventId, day.eventId))
    .all()
    .filter((d) => d.sort < day.sort)
    .sort((a, b) => b.sort - a.sort)[0];
  if (!prev) return { ccs: 0, trucks: 0 };
  let ccCount = 0;
  let truckCount = 0;
  const prevCcs = db.select().from(commandCenters).where(eq(commandCenters.dayId, prev.id)).all();
  for (const pc of prevCcs) {
    const cc = createCc({ dayId, name: pc.name, lat: pc.lat, lng: pc.lng, address: pc.address, notes: pc.notes, letter: pc.letter });
    ccCount++;
    for (const g of db.select().from(greenShirts).where(eq(greenShirts.ccId, pc.id)).all()) {
      db.insert(greenShirts).values({ ccId: cc.id, name: g.name, phone: g.phone, roleLabel: g.roleLabel }).run();
    }
    for (const t of db.select().from(trucks).where(eq(trucks.ccId, pc.id)).all()) {
      const nt = createTruck({ dayId, ccId: cc.id, name: t.name, driverName: t.driverName, driverPhone: t.driverPhone });
      truckCount++;
      for (const s of db.select().from(truckStock).where(eq(truckStock.truckId, t.id)).all()) {
        db.update(truckStock)
          .set({ capacity: s.capacity, qty: s.capacity })
          .where(and(eq(truckStock.truckId, nt.id), eq(truckStock.typeId, s.typeId)))
          .run();
      }
    }
  }
  return { ccs: ccCount, trucks: truckCount };
};

/**
 * Gives every truck of the type's event a stock row for it, full at the
 * default capacity, where the truck has none. For items added, or switched to
 * tracking, after the trucks were set up. Returns the trucks that got a row.
 */
export const stockTypeOnTrucks = (typeId: number): number[] => {
  const type = db.select().from(requestTypes).where(eq(requestTypes.id, typeId)).get();
  if (!type || !type.tracksStock) return [];
  const eventTrucks = db
    .select({ id: trucks.id })
    .from(trucks)
    .innerJoin(days, eq(days.id, trucks.dayId))
    .where(eq(days.eventId, type.eventId))
    .all();
  const added: number[] = [];
  for (const t of eventTrucks) {
    const row = db
      .insert(truckStock)
      .values({ truckId: t.id, typeId, qty: type.defaultCapacity, capacity: type.defaultCapacity })
      .onConflictDoNothing()
      .returning({ truckId: truckStock.truckId })
      .get();
    if (row) added.push(row.truckId);
  }
  return added;
};
