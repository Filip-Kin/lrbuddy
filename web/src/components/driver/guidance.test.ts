import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSteps } from "../../../../server/osrm.ts";
import { compass, manoeuvreAngle, manoeuvreLabel, nextManoeuvre, straightLine } from "./guidance.ts";

interface Fixture {
  trips: Array<{ geometry: { coordinates: Array<[number, number]> }; legs: Array<{ steps: Parameters<typeof parseSteps>[0] }> }>;
}
const fx = JSON.parse(readFileSync(join(import.meta.dir, "../../../../server/fixtures/osrm-trip-steps.json"), "utf8")) as Fixture;
const trip = fx.trips[0]!;
const line = trip.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
const leg0 = parseSteps(trip.legs[0]!.steps);
const leg1 = parseSteps(trip.legs[1]!.steps);

describe("next manoeuvre", () => {
  test("at the start, the first turn is next", () => {
    const n = nextManoeuvre(line, leg0, { lat: 42.378684, lng: -82.990866 });
    expect(n?.step.name).toBe("East Canfield Street");
    expect(manoeuvreLabel(n!.step)).toBe("Right");
    expect(n!.distanceM).toBeGreaterThan(40);
    expect(n!.distanceM).toBeLessThan(90);
  });

  test("it advances as the truck moves along Canfield", () => {
    // About halfway between the Canfield turn and the Montclair turn.
    const n = nextManoeuvre(line, leg0, { lat: 42.3801, lng: -82.989 });
    expect(n?.step.name).toBe("Montclair Street");
    expect(manoeuvreLabel(n!.step)).toBe("Left");
    expect(n!.distanceM).toBeGreaterThan(100);
    expect(n!.distanceM).toBeLessThan(330);
  });

  test("past the last turn, the arrival is next", () => {
    const n = nextManoeuvre(line, leg0, { lat: 42.3818, lng: -82.9873 });
    expect(n?.step.type).toBe("arrive");
    expect(manoeuvreAngle(n!.step)).toBeNull();
  });

  test("from the first stop the route starts again there, and the second leg's first turn is next", () => {
    // After Delivered the route is recomputed from the truck, so the line begins at the stop.
    const i = line.findIndex(([lat, lng]) => Math.abs(lat - 42.382272) < 1e-5 && Math.abs(lng + 82.9876) < 1e-5);
    expect(i).toBeGreaterThan(0);
    const n = nextManoeuvre(line.slice(i), leg1, { lat: 42.382272, lng: -82.9876 });
    expect(n?.step.name).toBe("East Canfield Street");
    expect(n!.distanceM).toBeGreaterThan(120);
  });

  test("no steps gives nothing", () => {
    expect(nextManoeuvre(line, [], { lat: 42.38, lng: -82.99 })).toBeNull();
  });
});

describe("words", () => {
  test("labels and angles", () => {
    expect(manoeuvreLabel({ type: "fork", modifier: "slight left" })).toBe("Keep left");
    expect(manoeuvreLabel({ type: "end of road", modifier: "right" })).toBe("Right");
    expect(manoeuvreAngle({ type: "turn", modifier: "sharp left" })).toBe(-135);
    expect(compass(44)).toBe("Northeast");
    expect(compass(359)).toBe("North");
  });

  test("straight line arrow turns with the heading", () => {
    const s = straightLine({ lat: 42.38, lng: -82.99 }, { lat: 42.39, lng: -82.99 }, 90);
    expect(s.bearing).toBeCloseTo(0, 3);
    expect(s.angle).toBeCloseTo(-90, 3);
    expect(s.distanceM).toBeGreaterThan(1100);
  });
});
