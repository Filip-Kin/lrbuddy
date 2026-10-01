/**
 * Planning portal data (SPEC 16): the assessor parcel cache, block sides and
 * survey tags. Parcels come from the same layer as the lot outlines in
 * lots-import.ts, with the street and cross-street fields the block sides need.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { parcels, surveyTags, type LotGeometry, type ParcelRow, type SurveyGrade, type SurveyTag } from "./db/schema.ts";
import { haversine, bboxAround, normalizeBBox, type BBox, type LatLng } from "./geo.ts";
import { PARCEL_URL, USER_AGENT, asGeometry, geometryCenter, titleCase, type DlbaOptions } from "./lots-import.ts";

// #region rules
/**
 * The B&B lead's survey rules, with the labels the portal shows. `high` is a
 * crew for the whole half day, `low` is light work, and a block side with 10
 * or more work parcels is the dark band.
 */
export const SURVEY_RULES = {
  grades: {
    high: "High",
    low: "Low",
    clear: "Clear",
  },
  gradeMeaning: {
    high: "Half day for a crew",
    low: "Light work",
    clear: "No work",
  },
  /** Work parcels on one block side at which the band turns dark. */
  darkAt: 10,
  /** Default per-crew capacity: 10 work parcels, or 5 high ones. */
  perCrewParcels: 10,
  perCrewHigh: 5,
} as const;

export const BANDS = ["none", "light", "mid", "dark"] as const;
export type Band = (typeof BANDS)[number];

export const BAND_LABELS: Record<Band, string> = {
  none: "0",
  light: "1 to 4",
  mid: "5 to 9",
  dark: "10+",
};

/** Colour band of a block side by its work count: 0 grey, 1 to 4 light, 5 to 9 mid, 10 and up dark. */
export const bandFor = (workCount: number): Band => (workCount <= 0 ? "none" : workCount < 5 ? "light" : workCount < SURVEY_RULES.darkAt ? "mid" : "dark");

/**
 * Crews a set of work parcels needs: a crew takes `perCrewParcels` low
 * parcels, or `perCrewHigh` high ones, so a high parcel costs twice a low one
 * at the defaults.
 */
export const crewsNeeded = (high: number, low: number, perCrewParcels: number = SURVEY_RULES.perCrewParcels, perCrewHigh: number = SURVEY_RULES.perCrewHigh): number => {
  if (high + low === 0) return 0;
  return Math.ceil(low / Math.max(1, perCrewParcels) + high / Math.max(1, perCrewHigh) - 1e-9);
};
// #endregion

// #region block side key
export type Parity = "odd" | "even";

export interface KeyInput {
  streetName: string | null;
  streetNumber: number | null;
  streetPrefix?: string | null;
  crossStreet1?: string | null;
  crossStreet2?: string | null;
  address?: string | null;
}

const norm = (v: string | null | undefined): string | null => {
  const s = v?.replace(/\s+/g, " ").trim().toUpperCase();
  return s ? s : null;
};

const ADDRESS = /^\s*(\d+)[A-Z]?\s+(.+?)\s*$/i;

export const parityOf = (n: number | null | undefined): Parity | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Math.abs(Math.trunc(n)) % 2 === 1 ? "odd" : "even";

/**
 * One side of one block: street, the two cross streets in name order (the
 * layer lists them either way round), and the parity of the house number.
 * "GARLAND|E CANFIELD ST|MACK AVE|odd". Without cross streets the house
 * number's hundred stands in for the block, "MCCLELLAN|3700|odd", since one
 * street can run for miles and the layer leaves many cross streets blank.
 * Null when there is no street or no house number.
 */
export const blockSideKey = (p: KeyInput): string | null => {
  const m = p.address ? ADDRESS.exec(p.address) : null;
  const street = [norm(p.streetPrefix), norm(p.streetName)].filter((x): x is string => x !== null).join(" ") || norm(m?.[2]);
  const number = p.streetNumber ?? (m ? Number(m[1]) : null);
  const parity = parityOf(number);
  if (!street || !parity || number === null) return null;
  const crosses = [norm(p.crossStreet1), norm(p.crossStreet2)].filter((x): x is string => x !== null && x !== street).sort();
  if (crosses.length > 0) return [street, ...crosses, parity].join("|");
  return [street, String(Math.floor(Math.abs(Math.trunc(number)) / 100) * 100), parity].join("|");
};

export interface KeyParts {
  street: string;
  fromCross: string | null;
  toCross: string | null;
  /** Hundred block (3700) when the side has no cross streets, else null. */
  block: number | null;
  parity: Parity;
}

const HUNDRED = /^\d+$/;

export const parseKey = (key: string): KeyParts => {
  const parts = key.split("|");
  const parity: Parity = parts[parts.length - 1] === "odd" ? "odd" : "even";
  const mid = parts.slice(1, -1);
  const block = mid.length === 1 && HUNDRED.test(mid[0] ?? "") ? Number(mid[0]) : null;
  if (block !== null) return { street: parts[0] ?? key, fromCross: null, toCross: null, block, parity };
  return { street: parts[0] ?? key, fromCross: mid[0] ?? null, toCross: mid[1] ?? null, block: null, parity };
};

/** "Garland, E Canfield St to Mack Ave, odd" or "Mcclellan, 3700 block, odd" for tables and sheets. */
export const blockSideLabel = (key: string): string => {
  const k = parseKey(key);
  const street = titleCase(k.street);
  const span =
    k.fromCross && k.toCross ? `${titleCase(k.fromCross)} to ${titleCase(k.toCross)}` : k.fromCross ? `at ${titleCase(k.fromCross)}` : k.block !== null ? `${k.block} block` : null;
  return [street, span, k.parity].filter(Boolean).join(", ");
};
// #endregion

// #region fetch and cache
const PAGE = 1000;
const OUT_FIELDS = [
  "parcel_id",
  "address",
  "street_name",
  "street_number",
  "street_prefix",
  "cross_street_1",
  "cross_street_2",
  "property_class",
  "property_class_description",
  "taxpayer_1",
  "is_improved",
  "pct_pre_claimed",
  "sale_date",
].join(",");

interface Feature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}
interface Collection {
  features?: Feature[];
  properties?: { exceededTransferLimit?: boolean };
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null);
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const dateOnly = (v: unknown): string | null => {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
  return null;
};

export type ParcelInput = Omit<ParcelRow, "fetchedAt" | "blockSideKey">;

/** One layer feature to a cache row, or null without an id or a polygon. */
export const featureToParcel = (f: Feature): ParcelInput | null => {
  const p = f.properties ?? {};
  const parcelId = str(p.parcel_id);
  const geometry = asGeometry(f.geometry ?? null);
  if (!parcelId || !geometry) return null;
  const address = str(p.address);
  const number = numOrNull(p.street_number);
  const improved = numOrNull(p.is_improved);
  return {
    parcelId,
    address: address === null ? null : titleCase(address),
    ...geometryCenter(geometry),
    geometry,
    streetName: str(p.street_name),
    streetNumber: number === null ? null : Math.trunc(number),
    streetPrefix: str(p.street_prefix),
    crossStreet1: str(p.cross_street_1),
    crossStreet2: str(p.cross_street_2),
    propertyClass: str(p.property_class),
    propertyClassDescription: str(p.property_class_description),
    taxpayer1: str(p.taxpayer_1),
    isImproved: improved === null ? null : improved !== 0,
    pctPreClaimed: numOrNull(p.pct_pre_claimed),
    saleDate: dateOnly(p.sale_date),
  };
};

/** Every parcel in the bbox, any class, with outlines; envelope query paged 1000 at a time (the layer's cap). */
export const fetchParcelsInBBox = async (bbox: BBox, opts: DlbaOptions = {}): Promise<ParcelInput[]> => {
  const [xmin, ymin, xmax, ymax] = normalizeBBox(bbox);
  const out: ParcelInput[] = [];
  const limit = opts.limit ?? Infinity;
  let offset = 0;
  for (;;) {
    const qs = new URLSearchParams({
      geometry: `${xmin},${ymin},${xmax},${ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: OUT_FIELDS,
      outSR: "4326",
      f: "geojson",
      orderByFields: "parcel_id",
      resultOffset: String(offset),
      resultRecordCount: String(Math.min(PAGE, limit - out.length)),
    });
    const res = await (opts.fetchImpl ?? fetch)(`${PARCEL_URL}?${qs.toString()}`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Parcel query returned ${res.status}`);
    const body = (await res.json()) as Collection;
    if (body.error) throw new Error(`Parcel query error: ${body.error.message ?? "unknown"}`);
    const feats = body.features ?? [];
    for (const f of feats) {
      const p = featureToParcel(f);
      if (!p) continue;
      out.push(p);
      if (out.length >= limit) return out;
    }
    const more = body.exceededTransferLimit ?? body.properties?.exceededTransferLimit ?? false;
    if (!more || feats.length === 0) return out;
    offset += feats.length;
  }
};

/** Writes parcels into the cache, replacing what was there for the same id. */
export const upsertParcels = (rows: readonly ParcelInput[], now = Date.now()): number => {
  db.transaction((tx) => {
    for (const r of rows) {
      const { parcelId, ...rest } = r;
      const set = { ...rest, blockSideKey: blockSideKey(r), fetchedAt: now };
      tx.insert(parcels)
        .values({ parcelId, ...set })
        .onConflictDoUpdate({ target: parcels.parcelId, set })
        .run();
    }
  });
  return rows.length;
};

/** Pulls the bbox from the layer into the cache. */
export const loadParcelsBBox = async (bbox: BBox, opts: DlbaOptions = {}): Promise<{ fetched: number }> => {
  const rows = await fetchParcelsInBBox(bbox, opts);
  upsertParcels(rows);
  return { fetched: rows.length };
};

/** Cached parcels in the bbox, up to `limit`. */
export const cachedParcelsInBBox = (bbox: BBox, limit = 5000): ParcelRow[] => {
  const [w, s, e, n] = normalizeBBox(bbox);
  return db
    .select()
    .from(parcels)
    .where(and(sql`${parcels.lat} between ${s} and ${n}`, sql`${parcels.lng} between ${w} and ${e}`))
    .limit(limit)
    .all();
};

/** Cached parcels whose centre is within `radiusM` of the point, nearest first. */
export const parcelsNear = (p: LatLng, radiusM: number, limit = 200): Array<ParcelRow & { distanceM: number }> =>
  cachedParcelsInBBox(bboxAround(p, radiusM), 20_000)
    .map((r) => ({ ...r, distanceM: haversine(p, r) }))
    .filter((r) => r.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);

/** Rows for a list of ids, 500 per query. */
export const parcelsById = (ids: readonly string[]): ParcelRow[] => {
  const out: ParcelRow[] = [];
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    out.push(...db.select().from(parcels).where(inArray(parcels.parcelId, list.slice(i, i + 500))).all());
  }
  return out;
};
// #endregion

// #region survey tags
/** The newest tag per parcel for the event (latest `at`, then latest id). */
export const newestTags = (eventId: number, parcelIds?: readonly string[]): Map<string, SurveyTag> => {
  const out = new Map<string, SurveyTag>();
  const take = (rows: SurveyTag[]): void => {
    for (const t of rows) if (!out.has(t.parcelId)) out.set(t.parcelId, t);
  };
  const order = [desc(surveyTags.at), desc(surveyTags.id)];
  if (parcelIds === undefined) {
    take(db.select().from(surveyTags).where(eq(surveyTags.eventId, eventId)).orderBy(...order).all());
    return out;
  }
  const list = [...new Set(parcelIds)];
  for (let i = 0; i < list.length; i += 500) {
    take(
      db
        .select()
        .from(surveyTags)
        .where(and(eq(surveyTags.eventId, eventId), inArray(surveyTags.parcelId, list.slice(i, i + 500))))
        .orderBy(...order)
        .all(),
    );
  }
  return out;
};

export const isWork = (g: SurveyGrade | null | undefined): g is "high" | "low" => g === "high" || g === "low";
// #endregion

// #region block sides
export interface BlockSideParcel {
  parcelId: string;
  blockSideKey: string | null;
  lat: number;
  lng: number;
  /** Newest survey grade, null when never surveyed. */
  grade: SurveyGrade | null;
}

export interface BlockSide extends KeyParts {
  key: string;
  label: string;
  parcelCount: number;
  surveyed: number;
  high: number;
  low: number;
  clear: number;
  /** high + low */
  workCount: number;
  band: Band;
  center: LatLng;
  bbox: BBox;
}

/**
 * Block sides from parcels and their newest grades. Only sides with at least
 * one surveyed parcel are listed; every parcel on such a side counts toward
 * `parcelCount`. Sorted by work count, most first, then by street.
 */
export const aggregateBlockSides = (rows: readonly BlockSideParcel[]): BlockSide[] => {
  const groups = new Map<string, BlockSideParcel[]>();
  for (const r of rows) {
    if (!r.blockSideKey) continue;
    const g = groups.get(r.blockSideKey);
    if (g) g.push(r);
    else groups.set(r.blockSideKey, [r]);
  }
  const out: BlockSide[] = [];
  for (const [key, list] of groups) {
    let high = 0;
    let low = 0;
    let clear = 0;
    for (const r of list) {
      if (r.grade === "high") high++;
      else if (r.grade === "low") low++;
      else if (r.grade === "clear") clear++;
    }
    const surveyed = high + low + clear;
    if (surveyed === 0) continue;
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const r of list) {
      w = Math.min(w, r.lng);
      e = Math.max(e, r.lng);
      s = Math.min(s, r.lat);
      n = Math.max(n, r.lat);
    }
    const workCount = high + low;
    out.push({
      key,
      label: blockSideLabel(key),
      ...parseKey(key),
      parcelCount: list.length,
      surveyed,
      high,
      low,
      clear,
      workCount,
      band: bandFor(workCount),
      center: { lat: (s + n) / 2, lng: (w + e) / 2 },
      bbox: [w, s, e, n],
    });
  }
  return out.sort((a, b) => b.workCount - a.workCount || a.street.localeCompare(b.street) || a.key.localeCompare(b.key));
};

/** Cached parcels on the given block sides, without outlines. */
export const parcelsOnSides = (keys: readonly string[]): Array<Pick<ParcelRow, "parcelId" | "blockSideKey" | "lat" | "lng" | "address">> => {
  const out: Array<Pick<ParcelRow, "parcelId" | "blockSideKey" | "lat" | "lng" | "address">> = [];
  const list = [...new Set(keys)];
  for (let i = 0; i < list.length; i += 500) {
    out.push(
      ...db
        .select({ parcelId: parcels.parcelId, blockSideKey: parcels.blockSideKey, lat: parcels.lat, lng: parcels.lng, address: parcels.address })
        .from(parcels)
        .where(inArray(parcels.blockSideKey, list.slice(i, i + 500)))
        .all(),
    );
  }
  return out;
};

/** Every block side the event's survey has touched, joined with the newest tag per parcel. */
export const blockSides = (eventId: number): BlockSide[] => {
  const tags = newestTags(eventId);
  if (tags.size === 0) return [];
  const keys = new Set<string>();
  for (const p of parcelsById([...tags.keys()])) if (p.blockSideKey) keys.add(p.blockSideKey);
  const rows = parcelsOnSides([...keys]).map((p) => ({ ...p, grade: tags.get(p.parcelId)?.grade ?? null }));
  return aggregateBlockSides(rows);
};

/** Work parcels (newest grade high or low) on the given block sides, with outlines and grades. */
export const workParcelsOnSides = (eventId: number, keys: readonly string[]): Array<ParcelRow & { grade: "high" | "low" }> => {
  const ids = parcelsOnSides(keys).map((p) => p.parcelId);
  const tags = newestTags(eventId, ids);
  const out: Array<ParcelRow & { grade: "high" | "low" }> = [];
  for (const p of parcelsById(ids)) {
    const g = tags.get(p.parcelId)?.grade;
    if (isWork(g)) out.push({ ...p, grade: g });
  }
  return out;
};
// #endregion

// #region areas
/** Axis-aligned rectangle around the points, padded `padM` metres, as a closed GeoJSON ring. */
export const areaAround = (pts: readonly LatLng[], padM = 15): { type: "Polygon"; coordinates: number[][][] } | null => {
  if (pts.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of pts) {
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  const dLat = padM / 111320;
  const dLng = padM / (111320 * Math.cos(((s + n) / 2) * (Math.PI / 180)));
  w -= dLng;
  e += dLng;
  s -= dLat;
  n += dLat;
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
};

/** Every vertex of a parcel outline, for padding an area around whole parcels rather than their centres. */
export const outlinePoints = (g: LotGeometry): LatLng[] => {
  const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
  const out: LatLng[] = [];
  for (const ring of rings) for (const pt of ring) if (pt[0] !== undefined && pt[1] !== undefined) out.push({ lng: pt[0], lat: pt[1] });
  return out;
};
// #endregion

// #region oriented areas
/**
 * Direction of the main axis the points spread along, in radians from east
 * toward north (local metres). Points along one street give the street's
 * direction, which on a turned street grid is not east-west.
 */
export const mainAxis = (pts: readonly LatLng[]): number => {
  if (pts.length < 2) return 0;
  const lat0 = pts.reduce((n, p) => n + p.lat, 0) / pts.length;
  const lng0 = pts.reduce((n, p) => n + p.lng, 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const x = (p.lng - lng0) * kx;
    const y = (p.lat - lat0) * 111320;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
};

/**
 * The parallelogram around the points with sides along two grid directions
 * (radians from east toward north, see `mainAxis`), padded `padM` metres
 * along the first direction and `padAcrossM` (default the same) along the
 * second, as a closed GeoJSON ring. With `across` a right angle off `along`
 * it is a turned rectangle; Detroit's avenues cross its streets at less than
 * a right angle, and a block there is a parallelogram.
 */
export const gridAreaAround = (
  pts: readonly LatLng[],
  along: number,
  across: number,
  padM = 15,
  padAcrossM = padM,
): { type: "Polygon"; coordinates: number[][][] } | null => {
  if (pts.length === 0) return null;
  const lat0 = pts.reduce((n, p) => n + p.lat, 0) / pts.length;
  const lng0 = pts.reduce((n, p) => n + p.lng, 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ux = Math.cos(along);
  const uy = Math.sin(along);
  const wx = Math.cos(across);
  const wy = Math.sin(across);
  const det = ux * wy - uy * wx;
  if (Math.abs(det) < 0.2) return null;
  // Distance between parallel sides is the coordinate times |det|, so a pad in coordinates is metres / |det|.
  const padA = padM / Math.abs(det);
  const padB = padAcrossM / Math.abs(det);
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (const p of pts) {
    const x = (p.lng - lng0) * kx;
    const y = (p.lat - lat0) * 111320;
    const a = (x * wy - y * wx) / det;
    const b = (ux * y - uy * x) / det;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
  }
  a0 -= padA;
  a1 += padA;
  b0 -= padB;
  b1 += padB;
  const back = (a: number, b: number): number[] => [lng0 + (a * ux + b * wx) / kx, lat0 + (a * uy + b * wy) / 111320];
  const ring = [back(a0, b0), back(a1, b0), back(a1, b1), back(a0, b1)];
  return { type: "Polygon", coordinates: [[...ring, ring[0]!]] };
};

/** The rectangle around the points with its long sides at `theta`, padded `padM` metres. */
export const orientedAreaAround = (pts: readonly LatLng[], theta: number, padM = 15): { type: "Polygon"; coordinates: number[][][] } | null =>
  gridAreaAround(pts, theta, theta + Math.PI / 2, padM);
// #endregion
