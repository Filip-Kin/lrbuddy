import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSteps, trip } from "./osrm.ts";

/**
 * A real answer from router.project-osrm.org, recorded 2026-09-30: the CC East
 * corner to Montclair Street and on to Laura Street, with `steps=true`.
 */
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/osrm-trip-steps.json"), "utf8");

const origin = { lat: 42.3786, lng: -82.9911 };
const stops = [
  { lat: 42.3825, lng: -82.987 },
  { lat: 42.376, lng: -82.995 },
];

const recorded = (seen: string[]): typeof fetch =>
  Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      seen.push(String(input));
      return new Response(FIXTURE, { headers: { "content-type": "application/json" } });
    },
    { preconnect: () => undefined },
  );

describe("osrm steps", () => {
  test("the trip call asks for steps", async () => {
    const seen: string[] = [];
    await trip(origin, stops, null, { osrmUrl: "https://osrm.test", fetchImpl: recorded(seen) });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).searchParams.get("steps")).toBe("true");
  });

  test("each leg keeps its manoeuvres, without the depart step", async () => {
    const r = await trip(origin, stops, null, { osrmUrl: "https://osrm.test", fetchImpl: recorded([]) });
    expect(r.engine).toBe("osrm");
    expect(r.order).toEqual([0, 1]);
    expect(r.legs).toHaveLength(2);
    const first = r.legs[0]!.steps;
    expect(first.map((m) => [m.type, m.modifier, m.name])).toEqual([
      ["turn", "right", "East Canfield Street"],
      ["turn", "left", "Montclair Street"],
      ["arrive", "right", "Montclair Street"],
    ]);
    // A manoeuvre sits at the sum of the steps before it: 64 m of depart, then 421 m of Canfield.
    expect(first[0]!.atM).toBeCloseTo(64.2, 0);
    expect(first[1]!.atM).toBeCloseTo(64.2 + 421, 0);
    expect(first[0]!.lat).toBeCloseTo(42.379204, 5);
    expect(first[0]!.lng).toBeCloseTo(-82.991209, 5);
    const second = r.legs[1]!.steps;
    expect(second[0]).toMatchObject({ type: "turn", modifier: "right", name: "East Canfield Street" });
    expect(second[second.length - 1]!.type).toBe("arrive");
    // Unnamed alleys keep an empty name rather than undefined.
    expect(second.every((m) => typeof m.name === "string")).toBe(true);
  });

  test("straight name changes and depart are dropped, turns kept", () => {
    const out = parseSteps([
      { distance: 50, name: "A St", maneuver: { type: "depart", modifier: "left", location: [0, 0] } },
      { distance: 100, name: "B St", maneuver: { type: "new name", modifier: "straight", location: [0, 0.001] } },
      { distance: 30, name: "", ref: "M 3", maneuver: { type: "turn", modifier: "slight left", location: [0, 0.002] } },
      { distance: 0, name: "", maneuver: { type: "arrive", location: [0, 0.003] } },
    ]);
    expect(out).toEqual([
      { type: "turn", modifier: "slight left", name: "M 3", lat: 0.002, lng: 0, atM: 150 },
      { type: "arrive", modifier: null, name: "", lat: 0.003, lng: 0, atM: 180 },
    ]);
  });

  test("the fallback has no steps", async () => {
    const r = await trip(origin, stops, null, { osrmUrl: "off" });
    expect(r.engine).toBe("fallback");
    expect(r.legs.every((l) => l.steps.length === 0)).toBe(true);
  });
});
