import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import Papa from "papaparse";
import { bus } from "./bus.ts";
import { db } from "./db/index.ts";
import { commandCenters, lots, type Lot, type LotGeometry, type LotSource } from "./db/schema.ts";
import { areaBBox, inArea, isRing, normalizeBBox, type Area } from "./geo.ts";
import { siteCcIds } from "./queries.ts";

export const DLBA_URL =
  "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/DLBA_Owned_Properties/FeatureServer/0/query";
export const USER_AGENT = "lrbuddy/1.0 (me@filipkin.com)";
const PAGE = 2000;

export interface LotInput {
  parcelId: string | null;
  address: string | null;
  lat: number;
  lng: number;
  geometry?: LotGeometry | null;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
}

/** "5125 IROQUOIS" to "5125 Iroquois", the way DLBA writes addresses. Mixed case is left alone. */
export const titleCase = (v: string): string =>
  /[a-z]/.test(v) ? v : v.toLowerCase().replace(/(^|[\s.-])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase());

// #region upsert
/** Inserts lots, updating address and position when the parcel is already there. */
export const upsertLots = (eventId: number, rows: readonly LotInput[], source: LotSource, ccId: number | null = null): ImportResult => {
  const res: ImportResult = { added: 0, updated: 0, skipped: 0 };
  let touched: Lot | null = null;
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
          .select({ id: lots.id, ccId: lots.ccId })
          .from(lots)
          .where(and(eq(lots.eventId, eventId), eq(lots.parcelId, parcelId)))
          .get();
        if (existing) {
          const set = {
            address,
            lat: r.lat,
            lng: r.lng,
            ...(r.geometry ? { geometry: r.geometry } : {}),
            ...(ccId !== null && existing.ccId === null ? { ccId } : {}),
          };
          const row = tx.update(lots).set(set).where(eq(lots.id, existing.id)).returning().get();
          if (row && ccId !== null && row.ccId === ccId) touched = row;
          res.updated++;
          continue;
        }
      }
      const row = tx
        .insert(lots)
        .values({ eventId, parcelId, address, lat: r.lat, lng: r.lng, source, status: "open", geometry: r.geometry ?? null, ccId })
        .returning()
        .get();
      if (ccId !== null) touched = row;
      res.added++;
    }
  });
  // One event is enough for the CC's screens to refetch.
  if (touched) emitLot(touched);
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

/**
 * ArcGIS spatial filter for an area: an envelope for a bbox, a polygon for a
 * ring (the oriented rectangle), so the services return what was drawn.
 */
const spatialFilter = (area: Area): Record<string, string> => {
  if (isRing(area)) {
    // Esri reads a counter-clockwise ring as a hole; outer rings go clockwise.
    let twice = 0;
    for (let i = 0, j = area.length - 1; i < area.length; j = i++) twice += (area[j]![0] - area[i]![0]) * (area[j]![1] + area[i]![1]);
    const ring = twice < 0 ? [...area].reverse() : area;
    return {
      geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPolygon",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
    };
  }
  const [xmin, ymin, xmax, ymax] = normalizeBBox(area);
  return {
    geometry: `${xmin},${ymin},${xmax},${ymax}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
};

/**
 * Pulls Land Bank lots inside the area (an envelope or a polygon ring),
 * paging until the service says it is done. Only lots whose point falls
 * inside the area are kept.
 */
export const fetchDlba = async (area: Area, opts: DlbaOptions = {}): Promise<LotInput[]> => {
  const out: LotInput[] = [];
  const limit = opts.limit ?? Infinity;
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      ...spatialFilter(area),
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
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inArea({ lat, lng }, area)) continue;
      out.push({ parcelId: str(f.attributes.parcel_id), address: str(f.attributes.name), lat, lng });
      if (out.length >= limit) return out;
    }
    if (!body.exceededTransferLimit || feats.length === 0) return out;
    offset += feats.length;
  }
};

/** DLBA lots in the area, then their parcel outlines. An outline failure keeps the lots. */
export const importDlba = async (
  eventId: number,
  area: Area,
  opts: DlbaOptions = {},
): Promise<ImportResult & { fetched: number; outlines: number }> => {
  const rows = await fetchDlba(area, opts);
  const res = upsertLots(eventId, rows, "dlba");
  const outlines = await attachOutlines(eventId, { fetchImpl: opts.fetchImpl }).catch(() => 0);
  return { ...res, fetched: rows.length, outlines };
};
// #endregion

// #region parcels
export const PARCEL_URL =
  "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/parcel_file_current/FeatureServer/0/query";
const PARCEL_BATCH = 100;
/** The layer's maxRecordCount. */
const PARCEL_PAGE = 1000;
export const VACANT_WHERE = "property_class_description='RESIDENTIAL-VACANT'";

export interface ParcelFeature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: { parcel_id?: unknown; address?: unknown } | null;
}
interface ParcelCollection {
  features?: ParcelFeature[];
  properties?: { exceededTransferLimit?: boolean };
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

export interface Parcel {
  parcelId: string;
  address: string | null;
  geometry: LotGeometry;
}

export const asGeometry = (g: ParcelFeature["geometry"]): LotGeometry | null => {
  if (!g || !Array.isArray(g.coordinates)) return null;
  if (g.type === "Polygon") return { type: "Polygon", coordinates: g.coordinates as number[][][] };
  if (g.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: g.coordinates as number[][][][] };
  return null;
};

const toParcel = (f: ParcelFeature): Parcel | null => {
  const id = str(f.properties?.parcel_id);
  const geometry = asGeometry(f.geometry);
  if (!id || !geometry) return null;
  const address = str(f.properties?.address);
  return { parcelId: id, address: address === null ? null : titleCase(address), geometry };
};

/** Centre of the outer ring's bounding box; good enough to place a pin on a city lot. */
export const geometryCenter = (g: LotGeometry): { lat: number; lng: number } => {
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0]?.[0];
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const pt of ring ?? []) {
    const [x, y] = pt as [number, number];
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return { lat: (s + n) / 2, lng: (w + e) / 2 };
};

const parcelQuery = async (params: Record<string, string>, opts: DlbaOptions): Promise<ParcelCollection> => {
  const qs = new URLSearchParams({ outSR: "4326", f: "geojson", outFields: "parcel_id,address", ...params });
  const res = await (opts.fetchImpl ?? fetch)(`${PARCEL_URL}?${qs.toString()}`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`Parcel query returned ${res.status}`);
  const body = (await res.json()) as ParcelCollection;
  if (body.error) throw new Error(`Parcel query error: ${body.error.message ?? "unknown"}`);
  return body;
};

const quote = (id: string): string => `'${id.replace(/'/g, "''")}'`;

/** Outlines for the given parcel ids, 100 per request. */
export const fetchParcelOutlines = async (parcelIds: readonly string[], opts: DlbaOptions = {}): Promise<Map<string, Parcel>> => {
  const out = new Map<string, Parcel>();
  const ids = [...new Set(parcelIds)];
  for (let i = 0; i < ids.length; i += PARCEL_BATCH) {
    const batch = ids.slice(i, i + PARCEL_BATCH);
    const body = await parcelQuery({ where: `parcel_id IN (${batch.map(quote).join(",")})` }, opts);
    for (const f of body.features ?? []) {
      const p = toParcel(f);
      if (p) out.set(p.parcelId, p);
    }
  }
  return out;
};

/** Stores outlines on every lot of the event that has a parcel id and no geometry yet. */
export const attachOutlines = async (eventId: number, opts: DlbaOptions = {}): Promise<number> => {
  const missing = db
    .select({ id: lots.id, parcelId: lots.parcelId })
    .from(lots)
    .where(and(eq(lots.eventId, eventId), isNotNull(lots.parcelId), isNull(lots.geometry)))
    .all();
  if (missing.length === 0) return 0;
  const found = await fetchParcelOutlines(
    missing.map((m) => m.parcelId).filter((x): x is string => x !== null),
    opts,
  );
  let n = 0;
  db.transaction((tx) => {
    for (const m of missing) {
      const p = m.parcelId ? found.get(m.parcelId) : undefined;
      if (!p) continue;
      tx.update(lots).set({ geometry: p.geometry }).where(eq(lots.id, m.id)).run();
      n++;
    }
  });
  return n;
};

/** The parcel under a point, or null. */
export const parcelAtPoint = async (lat: number, lng: number, opts: DlbaOptions = {}): Promise<Parcel | null> => {
  const body = await parcelQuery(
    {
      geometry: `${lng},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
    },
    opts,
  );
  for (const f of body.features ?? []) {
    const p = toParcel(f);
    if (p) return p;
  }
  return null;
};


/** How many residential vacant parcels touch the area; shown before an import. */
export const countVacantParcels = async (area: Area, opts: DlbaOptions = {}): Promise<number> => {
  const qs = new URLSearchParams({ ...spatialFilter(area), where: VACANT_WHERE, returnCountOnly: "true", f: "json" });
  const res = await (opts.fetchImpl ?? fetch)(`${PARCEL_URL}?${qs.toString()}`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`Parcel count returned ${res.status}`);
  const body = (await res.json()) as { count?: unknown; error?: { message?: string } };
  if (body.error || typeof body.count !== "number") throw new Error(`Parcel count error: ${body.error?.message ?? "no count"}`);
  return body.count;
};

/** Residential vacant parcels whose centre is in the area, with outlines, paged 1000 at a time. */
export const fetchVacantParcels = async (area: Area, opts: DlbaOptions = {}): Promise<LotInput[]> => {
  const out: LotInput[] = [];
  const limit = opts.limit ?? Infinity;
  let offset = 0;
  for (;;) {
    const body = await parcelQuery(
      {
        ...spatialFilter(area),
        where: VACANT_WHERE,
        resultOffset: String(offset),
        resultRecordCount: String(Math.min(PARCEL_PAGE, limit - out.length)),
        orderByFields: "parcel_id",
      },
      opts,
    );
    const feats = body.features ?? [];
    for (const f of feats) {
      const p = toParcel(f);
      if (!p) continue;
      const centre = geometryCenter(p.geometry);
      if (!inArea(centre, area)) continue;
      out.push({ parcelId: p.parcelId, address: p.address, geometry: p.geometry, ...centre });
      if (out.length >= limit) return out;
    }
    const more = body.exceededTransferLimit ?? body.properties?.exceededTransferLimit ?? false;
    if (!more || feats.length === 0) return out;
    offset += feats.length;
  }
};

export const importVacantParcels = async (eventId: number, area: Area, opts: DlbaOptions = {}): Promise<ImportResult & { fetched: number }> => {
  const rows = await fetchVacantParcels(area, opts);
  return { ...upsertLots(eventId, rows, "parcel"), fetched: rows.length };
};

/**
 * Fills parcel id, blank address and outline for lots placed by hand or CSV.
 * Rows with a parcel id get their outline by id; the rest by a point query,
 * six at a time. A point on no parcel stays a point lot. Never throws.
 */
export const resolveParcels = async (rows: readonly LotInput[], opts: DlbaOptions = {}): Promise<LotInput[]> => {
  const out = rows.map((r) => ({ ...r }));
  try {
    const byId = await fetchParcelOutlines(
      out.map((r) => r.parcelId).filter((x): x is string => !!x),
      opts,
    );
    for (const r of out) {
      const p = r.parcelId ? byId.get(r.parcelId) : undefined;
      if (p) {
        r.geometry = p.geometry;
        r.address = r.address ?? p.address;
      }
    }
  } catch {
    // Outlines are a nicety; the lots import without them.
  }
  const todo = out.filter((r) => !r.parcelId);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const r = todo[next++]!;
      try {
        const p = await parcelAtPoint(r.lat, r.lng, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
        if (p) {
          r.parcelId = p.parcelId;
          r.geometry = p.geometry;
          r.address = r.address ?? p.address;
        }
      } catch {
        // Leave it a point lot.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  return out;
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
    const rawLat = pick(r, "lat", "latitude");
    const rawLng = pick(r, "lng", "lon", "long", "longitude");
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    const problem = (name: string, raw: string | null, v: number, max: number): string | null => {
      if (raw === null) return `${name} missing`;
      if (!Number.isFinite(v)) return `${name} not a number`;
      if (Math.abs(v) > max) return `${name} out of range`;
      return null;
    };
    const problems = [problem("lat", rawLat, lat, 90), problem("lng", rawLng, lng, 180)].filter((x): x is string => x !== null);
    if (problems.length > 0) {
      errors.push(`Row ${i + 2}: ${problems.join(", ")}`);
      return;
    }
    rows.push({ address: pick(r, "address", "name"), lat, lng, parcelId: pick(r, "parcel_id", "parcel", "parcelid") });
  });
  return { rows, errors };
};

/** With `ccId`, new lots and lots with no CC go to that CC, the same as the rectangle imports. */
export const importLotsCsv = async (
  eventId: number,
  csv: string,
  opts: DlbaOptions = {},
  ccId: number | null = null,
): Promise<ImportResult & { errors: string[] }> => {
  const { rows, errors } = parseLotsCsv(csv);
  const resolved = await resolveParcels(rows, opts);
  return { ...upsertLots(eventId, resolved, "csv", ccId), errors };
};
// #endregion

// #region manual and assignment
/** Emits lot.changed scoped to the lot's CC and that CC's day. */
export const emitLot = (lot: Lot): void => {
  if (lot.ccId === null) {
    bus.emit("lot.changed", { ccId: null, dayId: null }, { lot });
    return;
  }
  // Every day's row of the site shows the lot.
  for (const id of siteCcIds(lot.ccId)) {
    const cc = db.select({ dayId: commandCenters.dayId }).from(commandCenters).where(eq(commandCenters.id, id)).get();
    bus.emit("lot.changed", { ccId: id, dayId: cc?.dayId ?? null }, { lot });
  }
};

/** Tap-to-add lot. Takes the parcel under the tap when there is one; a parcel already imported is returned as is. */
export const addManualLot = async (
  eventId: number,
  input: { lat: number; lng: number; address?: string | null; ccId?: number | null },
  opts: DlbaOptions = {},
): Promise<Lot> => {
  const [r] = await resolveParcels([{ parcelId: null, address: input.address?.trim() || null, lat: input.lat, lng: input.lng }], opts);
  if (r?.parcelId) {
    const existing = db
      .select()
      .from(lots)
      .where(and(eq(lots.eventId, eventId), eq(lots.parcelId, r.parcelId)))
      .get();
    if (existing) return existing;
  }
  const lot = db
    .insert(lots)
    .values({
      eventId,
      lat: input.lat,
      lng: input.lng,
      address: r?.address ?? null,
      parcelId: r?.parcelId ?? null,
      geometry: r?.geometry ?? null,
      ccId: input.ccId ?? null,
      source: "manual",
      status: "open",
    })
    .returning()
    .get();
  emitLot(lot);
  return lot;
};

/**
 * Sets the CC of the lots matching `where` (only lots with no CC when
 * `onlyUnassigned`). Clears the crew when the lot moves to another site; a
 * move between days' rows of one site keeps it. Emits one lot.changed per CC
 * that gained or lost lots, which is enough for every screen at that CC to
 * refetch.
 */
const assignLotsWhere = (where: SQL | undefined, ccId: number | null, onlyUnassigned: boolean): number => {
  const scoped = and(where, onlyUnassigned ? isNull(lots.ccId) : undefined);
  const before = db.selectDistinct({ ccId: lots.ccId }).from(lots).where(scoped).all();
  const site = ccId === null ? [] : siteCcIds(ccId);
  const sameSite = site.length > 0 ? sql`${lots.ccId} in (${sql.join(site.map((i) => sql`${i}`), sql`, `)})` : sql`${lots.ccId} is null`;
  const res = db
    .update(lots)
    .set({ ccId, crewId: sql`case when ${sameSite} then ${lots.crewId} else null end` })
    .where(scoped)
    .returning()
    .all();
  const first = res[0];
  if (first) {
    const touched = new Set<number>(before.map((b) => b.ccId).filter((c): c is number => c !== null && c !== ccId));
    for (const cc of touched) emitLot({ ...first, ccId: cc });
    emitLot(first);
  }
  return res.length;
};

/** Every lot of the event whose point is inside the area (an envelope or a ring) goes to the CC. */
export const assignLotsToCcInArea = (eventId: number, area: Area, ccId: number | null, onlyUnassigned = false): number => {
  const [w, s, e, n] = areaBBox(area);
  const box = and(eq(lots.eventId, eventId), sql`${lots.lng} between ${w} and ${e}`, sql`${lots.lat} between ${s} and ${n}`);
  if (!isRing(area)) return assignLotsWhere(box, ccId, onlyUnassigned);
  const ids = db.select({ id: lots.id, lat: lots.lat, lng: lots.lng }).from(lots).where(box).all().filter((l) => inArea(l, area)).map((l) => l.id);
  return ids.length ? assignLotsWhere(inArray(lots.id, ids), ccId, onlyUnassigned) : 0;
};

/** The given lots of the event go to the CC (the admin Lots page's selection). */
export const assignLotIdsToCc = (eventId: number, ids: readonly number[], ccId: number | null): number =>
  ids.length ? assignLotsWhere(and(eq(lots.eventId, eventId), inArray(lots.id, [...ids])), ccId, false) : 0;
// #endregion
