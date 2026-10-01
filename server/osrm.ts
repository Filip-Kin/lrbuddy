import { haversine, type LatLng } from "./geo.ts";
import type { Manoeuvre, RouteEngine } from "./db/schema.ts";

export interface TripLeg {
  /** Seconds for this leg alone. */
  durationS: number;
  /** Metres for this leg alone. */
  distanceM: number;
  /** Manoeuvres along the leg; empty from the fallback. */
  steps: Manoeuvre[];
}

export interface TripResult {
  /** Indices into `stops`, in visit order. Excludes the origin and the destination. */
  order: number[];
  /** One leg per hop: origin to first stop, stop to stop, last stop to destination. */
  legs: TripLeg[];
  /** [[lat, lng], ...] */
  geometry: Array<[number, number]>;
  distanceM: number;
  durationS: number;
  engine: RouteEngine;
}

export interface TripOptions {
  osrmUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 25 km/h in m/s: the fallback's city driving guess. */
const FALLBACK_SPEED = 25000 / 3600;

/** Nearest-neighbour ordering from the origin with straight lines. */
export const fallbackTrip = (origin: LatLng, stops: readonly LatLng[], destination: LatLng | null): TripResult => {
  const left = stops.map((_, i) => i);
  const order: number[] = [];
  let at = origin;
  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < left.length; k++) {
      const s = stops[left[k]!]!;
      const d = haversine(at, s);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const idx = left.splice(best, 1)[0]!;
    order.push(idx);
    at = stops[idx]!;
  }
  const path: LatLng[] = [origin, ...order.map((i) => stops[i]!)];
  if (destination) path.push(destination);
  const legs: TripLeg[] = [];
  for (let i = 1; i < path.length; i++) {
    const d = haversine(path[i - 1]!, path[i]!);
    legs.push({ distanceM: d, durationS: d / FALLBACK_SPEED, steps: [] });
  }
  return {
    order,
    legs,
    geometry: path.map((p) => [p.lat, p.lng]),
    distanceM: legs.reduce((a, l) => a + l.distanceM, 0),
    durationS: legs.reduce((a, l) => a + l.durationS, 0),
    engine: "fallback",
  };
};

interface OsrmStep {
  distance: number;
  name?: string;
  ref?: string;
  maneuver: { type: string; modifier?: string; location: [number, number] };
}

interface OsrmTripResponse {
  code: string;
  waypoints?: Array<{ waypoint_index: number; trips_index: number }>;
  trips?: Array<{
    distance: number;
    duration: number;
    geometry: { type: string; coordinates: Array<[number, number]> };
    legs: Array<{ distance: number; duration: number; steps?: OsrmStep[] }>;
  }>;
}

/** Steps that tell the driver nothing: leaving the start, and a street changing name on a straight road. */
const QUIET_TYPES = new Set(["depart", "new name", "continue", "notification"]);

/**
 * OSRM leg steps as manoeuvres, each with its distance from the start of the
 * leg. A step's distance is the road after its manoeuvre, so a manoeuvre sits
 * at the sum of the steps before it. Straight-on name changes are dropped.
 */
export const parseSteps = (steps: readonly OsrmStep[] | undefined): Manoeuvre[] => {
  const out: Manoeuvre[] = [];
  let at = 0;
  for (const st of steps ?? []) {
    const m = st.maneuver;
    const modifier = m.modifier ?? null;
    const quiet = m.type === "depart" || (QUIET_TYPES.has(m.type) && (modifier === null || modifier === "straight"));
    if (!quiet && Array.isArray(m.location) && m.location.length === 2) {
      out.push({ type: m.type, modifier, name: (st.name || st.ref || "").trim(), lat: m.location[1], lng: m.location[0], atM: at });
    }
    at += Number.isFinite(st.distance) ? st.distance : 0;
  }
  return out;
};

const isTripResponse = (v: unknown): v is OsrmTripResponse =>
  typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string";

/**
 * OSRM `/trip` from the origin through every stop, optionally ending at
 * `destination`. Falls back to nearest neighbour on any failure or after the
 * timeout (4 s by default).
 */
export const trip = async (
  origin: LatLng,
  stops: readonly LatLng[],
  destination: LatLng | null,
  opts: TripOptions,
): Promise<TripResult> => {
  if (stops.length === 0 && !destination) {
    return { order: [], legs: [], geometry: [[origin.lat, origin.lng]], distanceM: 0, durationS: 0, engine: "fallback" };
  }
  if (opts.osrmUrl === "off" || opts.osrmUrl === "") return fallbackTrip(origin, stops, destination);

  const pts: LatLng[] = [origin, ...stops];
  if (destination) pts.push(destination);
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const params = new URLSearchParams({
    source: "first",
    roundtrip: "false",
    overview: "full",
    geometries: "geojson",
    steps: "true",
  });
  if (destination) params.set("destination", "last");
  const url = `${opts.osrmUrl}/trip/v1/driving/${coords}?${params.toString()}`;

  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      headers: { "user-agent": "lrbuddy/1.0 (me@filipkin.com)" },
    });
    if (!res.ok) return fallbackTrip(origin, stops, destination);
    const body: unknown = await res.json();
    if (!isTripResponse(body) || body.code !== "Ok" || !body.waypoints || !body.trips || body.trips.length !== 1) {
      return fallbackTrip(origin, stops, destination);
    }
    const t = body.trips[0]!;
    // waypoint_index is where input i sits in the trip; invert it.
    const byTripPos: number[] = new Array<number>(pts.length);
    body.waypoints.forEach((w, i) => {
      byTripPos[w.waypoint_index] = i;
    });
    const order: number[] = [];
    for (const inputIdx of byTripPos) {
      if (inputIdx === undefined) return fallbackTrip(origin, stops, destination);
      if (inputIdx >= 1 && inputIdx <= stops.length) order.push(inputIdx - 1);
    }
    if (order.length !== stops.length) return fallbackTrip(origin, stops, destination);
    return {
      order,
      legs: t.legs.map((l) => ({ distanceM: l.distance, durationS: l.duration, steps: parseSteps(l.steps) })),
      geometry: t.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distanceM: t.distance,
      durationS: t.duration,
      engine: "osrm",
    };
  } catch {
    return fallbackTrip(origin, stops, destination);
  }
};
