import { describe, expect, test } from "bun:test";
import { placeOnTopEdge, shortAreaLabel } from "./areaLabel.ts";

describe("shortAreaLabel", () => {
  test("one crew, an override and several companies stay as they are", () => {
    expect(shortAreaLabel("GM 2")).toBe("GM 2");
    expect(shortAreaLabel("North strip")).toBe("North strip");
    expect(shortAreaLabel("FORD 1 & FORD 2")).toBe("FORD 1 & 2");
    expect(shortAreaLabel("GM 9 & FORD 2")).toBe("GM 9 & FORD 2");
  });

  test("a run of three or more crews of one company is a range", () => {
    const names = Array.from({ length: 13 }, (_, i) => `PISTONS ${i + 1}`);
    const joined = `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
    expect(shortAreaLabel(joined)).toBe("PISTONS 1-13");
    expect(shortAreaLabel("GM 9, GM 10 & GM 11")).toBe("GM 9-11");
  });

  test("one company, not a run: the company once, then the numbers", () => {
    expect(shortAreaLabel("GM 9, GM 10 & GM 12")).toBe("GM 9, 10 & 12");
    expect(shortAreaLabel("GM 12 & GM 13")).toBe("GM 12 & 13");
    expect(shortAreaLabel("General Motors 3 & General Motors 5")).toBe("General Motors 3 & 5");
  });
});

describe("placeOnTopEdge", () => {
  // A square in screen pixels, y down: top edge from (0,0) to (100,0).
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ];

  test("the top edge, left to right, inside below", () => {
    expect(placeOnTopEdge(square)).toEqual({ from: 0, angle: 0, length: 100, insideBelow: true });
  });

  test("a ring drawn the other way still reads left to right", () => {
    const p = placeOnTopEdge([...square].reverse())!;
    expect(p.angle).toBe(0);
    expect(p.length).toBe(100);
    expect(p.insideBelow).toBe(true);
  });

  test("a tilted rectangle takes its highest edge, turned to it and upright", () => {
    const t = (27 * Math.PI) / 180;
    const rot = ({ x, y }: { x: number; y: number }) => ({ x: x * Math.cos(t) - y * Math.sin(t), y: x * Math.sin(t) + y * Math.cos(t) });
    const p = placeOnTopEdge(square.map(rot))!;
    expect(Math.abs(Math.cos((p.angle * Math.PI) / 180))).toBeGreaterThan(0);
    expect(Math.cos((p.angle * Math.PI) / 180)).toBeGreaterThan(0);
    expect(p.insideBelow).toBe(true);
  });

  test("on a map turned upside down, the other long edge is on top and the text still reads upright", () => {
    const p = placeOnTopEdge(square, 180)!;
    // The bottom edge in map pixels is the top on screen; upright on screen means right to left in map pixels.
    expect(Math.round(Math.abs(p.angle))).toBe(180);
    expect(p.length).toBe(100);
    expect(p.insideBelow).toBe(true);
  });

  test("too few points: nowhere", () => {
    expect(placeOnTopEdge(square.slice(0, 2))).toBeNull();
  });
});
