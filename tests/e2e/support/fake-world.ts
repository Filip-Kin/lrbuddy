/**
 * A small made-up Detroit for the end-to-end suite, so the seed and the server never reach the
 * real ArcGIS layers, Overpass or OSRM. Three districts of rectangular parcels on a street grid:
 *
 * - East and West, around the seed's CC East and CC West (Day 1), inside the seed bbox.
 * - Webb, the Day 4 CC B area (`seed-ccb.ts`): the nine streets Tuxedo to Rochester between the
 *   avenues Dexter, Wildemere, Lawton and Linwood, with 3201 Webb on the odd side of the middle
 *   column, which is where the seed puts CC B.
 *
 * The answers copy the shapes the real services send (FeatureServer `f=json` and `f=geojson`,
 * Overpass `out geom;`, OSRM `/trip`), paged the same way. Everything is a pure function of the
 * request, so every run of the suite sees the same city.
 */

// #region geometry
const LAT_M = 1 / 111_320;
const LNG_M = 1 / (111_320 * Math.cos((42.375 * Math.PI) / 180));

export interface FakeParcel {
  parcelId: string;
  address: string;
  streetName: string;
  streetNumber: number;
  cross1: string;
  cross2: string;
  vacant: boolean;
  dlba: boolean;
  /** [west, south, east, north] */
  box: [number, number, number, number];
  lat: number;
  lng: number;
}

interface District {
  code: string;
  /** East-west streets, north to south. */
  streets: string[];
  /** Latitude of the northern street; the rest step south by `spacingM`. */
  northLat: number;
  spacingM: number;
  /** North-south avenues, west to east. */
  avenues: Array<{ name: string; lng: number }>;
  /** House number of the first lot in column 0; each column adds 100. */
  base: number;
  dlba: boolean;
}

const DISTRICTS: District[] = [
  {
    code: "21",
    streets: ["LAKEPOINTE", "BEACONSFIELD", "WAYBURN", "MARYLAND", "ALTER", "PHILIP", "MARLBOROUGH", "LYCASTE"],
    northLat: 42.3832,
    spacingM: 130,
    avenues: [
      { name: "OUTER DR", lng: -82.998 },
      { name: "CHATSWORTH", lng: -82.994 },
      { name: "HAVERHILL", lng: -82.99 },
      { name: "BALFOUR", lng: -82.986 },
    ],
    base: 14000,
    dlba: true,
  },
  {
    code: "22",
    streets: ["GRAYTON", "KENSINGTON", "BEDFORD", "GUILFORD", "BUCKINGHAM", "DEVONSHIRE", "AUDUBON", "BISHOP"],
    northLat: 42.3747,
    spacingM: 130,
    avenues: [
      { name: "CONNER", lng: -83.0275 },
      { name: "COPLIN", lng: -83.0235 },
      { name: "LAKEVIEW", lng: -83.0195 },
      { name: "ALGONQUIN", lng: -83.0155 },
    ],
    base: 4000,
    dlba: true,
  },
  {
    code: "16",
    streets: ["TUXEDO", "WEBB", "BURLINGAME", "LAWRENCE", "COLLINGWOOD", "CALVERT", "GLYNN", "BOSTON", "ROCHESTER"],
    northLat: 42.3835,
    spacingM: 132,
    avenues: [
      { name: "DEXTER", lng: -83.124 },
      { name: "WILDEMERE", lng: -83.1195 },
      { name: "LAWTON", lng: -83.1155 },
      { name: "LINWOOD", lng: -83.1115 },
    ],
    base: 3100,
    // The seed never asks the Land Bank about this area, so these stay for the admin import test.
    dlba: true,
  },
];

/** FNV-1a. */
export const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

const FRONT_M = 12;
const DEPTH_M = 44;
const HALF_STREET_M = 9;
const GAP_M = 0.4;

const build = (): FakeParcel[] => {
  const out: FakeParcel[] = [];
  for (const d of DISTRICTS) {
    let serial = 0;
    d.streets.forEach((street, si) => {
      const lat = d.northLat - si * d.spacingM * LAT_M;
      for (let col = 0; col + 1 < d.avenues.length; col++) {
        const a = d.avenues[col]!;
        const b = d.avenues[col + 1]!;
        const width = (b.lng - a.lng) / LNG_M - 2 * FRONT_M;
        const count = Math.floor(width / FRONT_M);
        for (const side of ["north", "south"] as const) {
          for (let k = 0; k < count; k++) {
            const west = a.lng + (FRONT_M + k * FRONT_M + GAP_M / 2) * LNG_M;
            const east = west + (FRONT_M - GAP_M) * LNG_M;
            const near = side === "north" ? lat + HALF_STREET_M * LAT_M : lat - HALF_STREET_M * LAT_M;
            const far = side === "north" ? near + DEPTH_M * LAT_M : near - DEPTH_M * LAT_M;
            const south = Math.min(near, far);
            const north = Math.max(near, far);
            const number = d.base + col * 100 + k * 2 + (side === "south" ? 1 : 0);
            serial++;
            const parcelId = `${d.code}${String(serial).padStart(6, "0")}.`;
            const h = hash(parcelId);
            const vacant = h % 10 < 4;
            out.push({
              parcelId,
              address: `${number} ${street}`,
              streetName: street,
              streetNumber: number,
              cross1: a.name,
              cross2: b.name,
              vacant,
              dlba: d.dlba && vacant && (h >>> 8) % 2 === 0,
              box: [west, south, east, north],
              lat: (south + north) / 2,
              lng: (west + east) / 2,
            });
          }
        }
      }
    });
  }
  return out;
};

export const PARCELS: readonly FakeParcel[] = build();
const BY_ID = new Map(PARCELS.map((p) => [p.parcelId, p]));

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const contains = (b: Box, lng: number, lat: number): boolean => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

const ring = (p: FakeParcel): number[][] => {
  const [w, s, e, n] = p.box;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
};
// #endregion

// #region ArcGIS
/** Which parcels an ArcGIS spatial filter plus `where` selects, in parcel id order. */
const select = (q: URLSearchParams): FakeParcel[] => {
  let rows: FakeParcel[] = [...PARCELS];
  const geometry = q.get("geometry");
  const type = q.get("geometryType");
  if (geometry) {
    if (type === "esriGeometryPoint") {
      const [lng, lat] = geometry.split(",").map(Number) as [number, number];
      rows = rows.filter((p) => contains(p.box, lng, lat));
    } else if (type === "esriGeometryPolygon") {
      const g = JSON.parse(geometry) as { rings: number[][][] };
      const pts = g.rings.flat();
      const box: Box = [
        Math.min(...pts.map((p) => p[0]!)),
        Math.min(...pts.map((p) => p[1]!)),
        Math.max(...pts.map((p) => p[0]!)),
        Math.max(...pts.map((p) => p[1]!)),
      ];
      rows = rows.filter((p) => overlaps(p.box, box));
    } else {
      const box = geometry.split(",").map(Number) as Box;
      rows = rows.filter((p) => overlaps(p.box, box));
    }
  }
  const where = q.get("where") ?? "";
  if (/parcel_id\s+IN\s*\(/i.test(where)) {
    const ids = new Set([...where.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'")));
    rows = rows.filter((p) => ids.has(p.parcelId));
  }
  if (where.includes("RESIDENTIAL-VACANT")) rows = rows.filter((p) => p.vacant);
  return rows.sort((a, b) => (a.parcelId < b.parcelId ? -1 : a.parcelId > b.parcelId ? 1 : 0));
};

const page = <T>(rows: T[], q: URLSearchParams, cap: number): { rows: T[]; more: boolean } => {
  const offset = Number(q.get("resultOffset") ?? 0);
  const count = Math.min(cap, Number(q.get("resultRecordCount") ?? cap));
  const slice = rows.slice(offset, offset + count);
  return { rows: slice, more: offset + slice.length < rows.length };
};

const parcelLayer = (q: URLSearchParams): unknown => {
  const rows = select(q);
  if (q.get("returnCountOnly") === "true") return { count: rows.length };
  const { rows: slice, more } = page(rows, q, 1000);
  return {
    type: "FeatureCollection",
    features: slice.map((p) => ({
      type: "Feature",
      id: hash(p.parcelId),
      geometry: { type: "Polygon", coordinates: [ring(p)] },
      properties: {
        parcel_id: p.parcelId,
        address: p.address,
        street_name: p.streetName,
        street_number: p.streetNumber,
        street_prefix: null,
        cross_street_1: p.cross1,
        cross_street_2: p.cross2,
        property_class: p.vacant ? "402" : "401",
        property_class_description: p.vacant ? "RESIDENTIAL-VACANT" : "RESIDENTIAL",
        taxpayer_1: p.dlba ? "DETROIT LAND BANK AUTHORITY" : "TAXPAYER",
        is_improved: p.vacant ? 0 : 1,
        pct_pre_claimed: 100,
        sale_date: null,
      },
    })),
    properties: { exceededTransferLimit: more },
  };
};

/** Land Bank rows in a stable shuffled order, so the seed's first 300 come from both districts. */
const dlbaLayer = (q: URLSearchParams): unknown => {
  const rows = select(q)
    .filter((p) => p.dlba)
    .sort((a, b) => hash(`dlba${a.parcelId}`) - hash(`dlba${b.parcelId}`));
  const { rows: slice, more } = page(rows, q, 2000);
  return {
    features: slice.map((p) => ({
      attributes: { name: p.address, parcel_id: p.parcelId, inventory_status_socrata: "Vacant Lot", longitude: p.lng, latitude: p.lat },
      geometry: { x: p.lng, y: p.lat },
    })),
    exceededTransferLimit: more,
  };
};
// #endregion

// #region Overpass
const streetTitle = (s: string): string => `${s.charAt(0)}${s.slice(1).toLowerCase()} St`;

const overpass = (query: string): unknown => {
  const m = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query);
  const [s, w, n, e] = m ? m.slice(1).map(Number) : [-90, -180, 90, 180];
  const box: Box = [w!, s!, e!, n!];
  const elements: unknown[] = [];
  let id = 0;
  for (const d of DISTRICTS) {
    const west = d.avenues[0]!.lng;
    const east = d.avenues[d.avenues.length - 1]!.lng;
    d.streets.forEach((street, si) => {
      id++;
      const lat = d.northLat - si * d.spacingM * LAT_M;
      if (query.includes('"oneway"') && si % 2 === 0 && overlaps([west, lat, east, lat], box)) {
        const geometry = Array.from({ length: 9 }, (_v, k) => ({ lat, lon: west + ((east - west) * k) / 8 }));
        elements.push({ type: "way", id: 9_000_000 + Number(d.code) * 100 + id, geometry, tags: { highway: "residential", oneway: si % 4 === 0 ? "yes" : "-1", name: streetTitle(street) } });
      }
      if (query.includes('"alley"') && si + 1 < d.streets.length) {
        const mid = lat - (d.spacingM / 2) * LAT_M;
        for (let col = 0; col + 1 < d.avenues.length; col++) {
          const a = d.avenues[col]!.lng + 14 * LNG_M;
          const b = d.avenues[col + 1]!.lng - 14 * LNG_M;
          if (!overlaps([a, mid, b, mid], box)) continue;
          elements.push({
            type: "way",
            id: 8_000_000 + Number(d.code) * 1000 + si * 10 + col,
            geometry: [
              { lat: mid, lon: a },
              { lat: mid, lon: b },
            ],
            tags: { highway: "service", service: "alley" },
          });
        }
      }
    });
  }
  return { version: 0.6, generator: "lrbuddy e2e fake", elements };
};
// #endregion

// #region OSRM
const metres = (a: [number, number], b: [number, number]): number => {
  const dy = (b[1] - a[1]) / LAT_M;
  const dx = (b[0] - a[0]) / LNG_M;
  return Math.hypot(dx, dy);
};

/** A trip in input order with an L-shaped path per leg and one turn in the middle of it. */
const osrmTrip = (url: URL): unknown => {
  const coords = decodeURIComponent(url.pathname.split("/driving/")[1] ?? "")
    .split(";")
    .map((c) => c.split(",").map(Number) as [number, number]);
  const legs: unknown[] = [];
  const geometry: Array<[number, number]> = [coords[0]!];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const corner: [number, number] = [b[0], a[1]];
    const d1 = metres(a, corner);
    const d2 = metres(corner, b);
    total += d1 + d2;
    geometry.push(corner, b);
    legs.push({
      distance: d1 + d2,
      duration: (d1 + d2) / 7,
      steps: [
        { distance: d1, name: "Webb St", maneuver: { type: "depart", location: a } },
        { distance: d2, name: "Lawton St", maneuver: { type: "turn", modifier: b[1] > a[1] ? "left" : "right", location: corner } },
        { distance: 0, name: "", maneuver: { type: "arrive", location: b } },
      ],
    });
  }
  return {
    code: "Ok",
    waypoints: coords.map((c, i) => ({ waypoint_index: i, trips_index: 0, location: c, name: "" })),
    trips: [{ distance: total, duration: total / 7, weight: total / 7, geometry: { type: "LineString", coordinates: geometry }, legs }],
  };
};
// #endregion

// #region dispatch
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/**
 * The fake answer for an outbound request, or null when nothing here serves that host.
 * `jpeg` is the tile the World Imagery requests get.
 */
export const fakeAnswer = async (url: URL, init: RequestInit | undefined, jpeg: () => Uint8Array<ArrayBuffer>): Promise<Response | null> => {
  if (url.hostname === "services2.arcgis.com") {
    if (url.pathname.includes("/DLBA_Owned_Properties/")) return json(dlbaLayer(url.searchParams));
    if (url.pathname.includes("/parcel_file_current/")) return json(parcelLayer(url.searchParams));
    return json({ error: { code: 400, message: "Unknown layer in the e2e fake" } });
  }
  if (url.hostname === "server.arcgisonline.com") {
    return new Response(jpeg(), { headers: { "content-type": "image/jpeg" } });
  }
  if (url.hostname.includes("overpass")) {
    let query = "";
    const body = init?.body;
    if (body instanceof URLSearchParams) query = body.get("data") ?? "";
    else if (typeof body === "string") query = new URLSearchParams(body).get("data") ?? body;
    return json(overpass(query));
  }
  if (url.pathname.includes("/trip/v1/driving/")) return json(osrmTrip(url));
  return null;
};

export const parcelById = (id: string): FakeParcel | undefined => BY_ID.get(id);
// #endregion
