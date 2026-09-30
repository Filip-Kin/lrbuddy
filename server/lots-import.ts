import { and, eq, sql } from "drizzle-orm";
import Papa from "papaparse";
import { bus } from "./bus.ts";
import { db } from "./db/index.ts";
import { commandCenters, lots, type Lot, type LotSource } from "./db/schema.ts";
import { normalizeBBox, type BBox } from "./geo.ts";

export const DLBA_URL =
  "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/DLBA_Owned_Properties/FeatureServer/0/query";
const USER_AGENT = "lrbuddy/1.0 (me@filipkin.com)";
const PAGE = 2000;

export interface LotInput {
  parcelId: string | null;
  address: string | null;
  lat: number;
  lng: number;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
}

// #region upsert
/** Inserts lots, updating address and position when the parcel is already there. */
export const upsertLots = (eventId: number, rows: readonly LotInput[], source: LotSource): ImportResult => {
  const res: ImportResult = { added: 0, updated: 0, skipped: 0 };
  db.transaction((tx) => {
    for (const r of rows) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) {
        res.skipped++;
        continue;
      }
      const parcelId = r.parcelId?.trim() || null;
      const address = r.address?.trim() || null;
      if (parcelId) {
        const existing = tx
          .select({ id: lots.id })
          .from(lots)
          .where(and(eq(lots.eventId, eventId), eq(lots.parcelId, parcelId)))
          .get();
        if (existing) {
          tx.update(lots).set({ address, lat: r.lat, lng: r.lng }).where(eq(lots.id, existing.id)).run();
          res.updated++;
          continue;
        }
      }
      tx.insert(lots).values({ eventId, parcelId, address, lat: r.lat, lng: r.lng, source, status: "open" }).run();
      res.added++;
    }
  });
  return res;
};
// #endregion

// #region DLBA
interface DlbaFeature {
  attributes: {
    name?: unknown;
    parcel_id?: unknown;
    inventory_status_socrata?: unknown;
    longitude?: unknown;
    latitude?: unknown;
  };
  geometry?: { x?: unknown; y?: unknown };
}

interface DlbaPage {
  features?: DlbaFeature[];
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null);

export interface DlbaOptions {
  /** Stop after this many lots. */
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Pulls Land Bank lots inside the bbox, paging until the service says it is done. */
export const fetchDlba = async (bbox: BBox, opts: DlbaOptions = {}): Promise<LotInput[]> => {
  const [xmin, ymin, xmax, ymax] = normalizeBBox(bbox);
  const out: LotInput[] = [];
  const limit = opts.limit ?? Infinity;
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      geometry: `${xmin},${ymin},${xmax},${ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "name,parcel_id,inventory_status_socrata,longitude,latitude",
      outSR: "4326",
      f: "json",
      resultOffset: String(offset),
      resultRecordCount: String(Math.min(PAGE, limit - out.length)),
    });
    const res = await (opts.fetchImpl ?? fetch)(`${DLBA_URL}?${params.toString()}`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Land Bank query returned ${res.status}`);
    const body = (await res.json()) as DlbaPage;
    if (body.error) throw new Error(`Land Bank query error: ${body.error.message ?? "unknown"}`);
    const feats = body.features ?? [];
    for (const f of feats) {
      const lat = Number.isFinite(num(f.attributes.latitude)) ? num(f.attributes.latitude) : num(f.geometry?.y);
      const lng = Number.isFinite(num(f.attributes.longitude)) ? num(f.attributes.longitude) : num(f.geometry?.x);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({ parcelId: str(f.attributes.parcel_id), address: str(f.attributes.name), lat, lng });
      if (out.length >= limit) return out;
    }
    if (!body.exceededTransferLimit || feats.length === 0) return out;
    offset += feats.length;
  }
};

export const importDlba = async (eventId: number, bbox: BBox, opts: DlbaOptions = {}): Promise<ImportResult & { fetched: number }> => {
  const rows = await fetchDlba(bbox, opts);
  return { ...upsertLots(eventId, rows, "dlba"), fetched: rows.length };
};
// #endregion

// #region CSV
const pick = (row: Record<string, string>, ...names: string[]): string | null => {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return null;
};

/** Parses `address, lat, lng[, parcel_id]` with a header row. Header names are case and space insensitive. */
export const parseLotsCsv = (csv: string): { rows: LotInput[]; errors: string[] } => {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });
  const rows: LotInput[] = [];
  const errors: string[] = [];
  parsed.data.forEach((r, i) => {
    const lat = Number(pick(r, "lat", "latitude"));
    const lng = Number(pick(r, "lng", "lon", "long", "longitude"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || pick(r, "lat", "latitude") === null) {
      errors.push(`Row ${i + 2}: lat and lng`);
      return;
    }
    rows.push({ address: pick(r, "address", "name"), lat, lng, parcelId: pick(r, "parcel_id", "parcel", "parcelid") });
  });
  return { rows, errors };
};

export const importLotsCsv = (eventId: number, csv: string): ImportResult & { errors: string[] } => {
  const { rows, errors } = parseLotsCsv(csv);
  return { ...upsertLots(eventId, rows, "csv"), errors };
};
// #endregion

// #region manual and assignment
/** Emits lot.changed scoped to the lot's CC and that CC's day. */
export const emitLot = (lot: Lot): void => {
  if (lot.ccId === null) {
    bus.emit("lot.changed", { ccId: null, dayId: null }, { lot });
    return;
  }
  const cc = db.select({ dayId: commandCenters.dayId }).from(commandCenters).where(eq(commandCenters.id, lot.ccId)).get();
  bus.emit("lot.changed", { ccId: lot.ccId, dayId: cc?.dayId ?? null }, { lot });
};

export const addManualLot = (eventId: number, input: { lat: number; lng: number; address?: string | null; ccId?: number | null }): Lot => {
  const lot = db
    .insert(lots)
    .values({
      eventId,
      lat: input.lat,
      lng: input.lng,
      address: input.address?.trim() || null,
      ccId: input.ccId ?? null,
      source: "manual",
      status: "open",
    })
    .returning()
    .get();
  emitLot(lot);
  return lot;
};

/** Sets the CC of every lot of the event inside the bbox. Clears the crew when the CC changes. */
export const assignLotsToCcByBBox = (eventId: number, bbox: BBox, ccId: number | null): number => {
  const [w, s, e, n] = normalizeBBox(bbox);
  const res = db
    .update(lots)
    .set({ ccId, crewId: sql`case when ${lots.ccId} is ${ccId} then ${lots.crewId} else null end` })
    .where(
      and(
        eq(lots.eventId, eventId),
        sql`${lots.lng} between ${w} and ${e}`,
        sql`${lots.lat} between ${s} and ${n}`,
      ),
    )
    .returning({ id: lots.id })
    .all();
  return res.length;
};
// #endregion
