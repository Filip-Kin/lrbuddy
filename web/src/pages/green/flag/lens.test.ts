import { describe, expect, test } from "bun:test";
import { wideCameraId, zoomRangeOf } from "./lens.ts";

const cam = (deviceId: string, label: string) => ({ deviceId, kind: "videoinput", label });

describe("wide lens (SPEC 22)", () => {
  test("zoom range from capabilities", () => {
    expect(zoomRangeOf({ zoom: { min: 0.5, max: 10, step: 0.1 } })).toEqual({ min: 0.5, max: 10 });
    expect(zoomRangeOf({ width: { min: 1, max: 4000 } })).toBeNull();
    expect(zoomRangeOf({ zoom: { min: "1" } })).toBeNull();
    expect(zoomRangeOf(null)).toBeNull();
  });

  test("iOS labels: the ultra-wide wins over dual wide, front and telephoto never", () => {
    const list = [cam("f", "Front Camera"), cam("b", "Back Camera"), cam("t", "Back Telephoto Camera"), cam("d", "Back Dual Wide Camera"), cam("u", "Back Ultra Wide Camera")];
    expect(wideCameraId(list, "b")).toBe("u");
    expect(wideCameraId(list.filter((d) => d.deviceId !== "u"), "b")).toBe("d");
  });

  test("a 0.5 label counts; the open camera and microphones do not", () => {
    expect(wideCameraId([cam("b", "Back 1x"), cam("h", "Back 0.5x"), { deviceId: "m", kind: "audioinput", label: "Wide mic" }], "b")).toBe("h");
    expect(wideCameraId([cam("u", "Back Ultra Wide Camera")], "u")).toBeNull();
  });

  test("Android labels say nothing about the lens: no switch", () => {
    expect(wideCameraId([cam("0", "camera2 0, facing back"), cam("1", "camera2 1, facing front"), cam("2", "camera2 2, facing back")], "0")).toBeNull();
  });
});
