import { describe, expect, test } from "bun:test";
import { decideTap, nextHeading, pickSides, type DriveParcel, type Fix } from "./drive.ts";
import { ahead, bearing, headingFrame } from "./geo.ts";
import { TagQueue, type TagInput } from "./queue.ts";

const fix = (lat: number, lng: number, extra: Partial<Fix> = {}): Fix => ({ lat, lng, accuracy: 5, heading: null, speed: null, at: 0, ...extra });

describe("geo", () => {
  test("a point to the east is on the right when heading north", () => {
    const p = { lat: 42.38, lng: -82.99 };
    const east = ahead(p, 90, 20);
    const f = headingFrame(p, 0, east);
    expect(f.lateral).toBeCloseTo(20, 0);
    expect(Math.abs(f.along)).toBeLessThan(0.5);
    expect(headingFrame(p, 180, east).lateral).toBeCloseTo(-20, 0);
  });
  test("bearing and ahead agree", () => {
    const p = { lat: 42.38, lng: -82.99 };
    expect(bearing(p, ahead(p, 37, 100))).toBeCloseTo(37, 1);
  });
});

describe("nextHeading", () => {
  test("GPS heading above 2 m/s", () => {
    expect(nextHeading(fix(42.38, -82.99, { speed: 5, heading: 123 }), null, null).heading).toBe(123);
  });
  test("bearing of the last two fixes when slow", () => {
    const a = { lat: 42.38, lng: -82.99 };
    const b = ahead(a, 300, 10);
    const r = nextHeading(fix(b.lat, b.lng, { speed: 1, heading: 10 }), a, null);
    expect(r.heading).toBeCloseTo(300, 0);
  });
  test("jitter under 3 m keeps the heading and the anchor", () => {
    const a = { lat: 42.38, lng: -82.99 };
    const b = ahead(a, 90, 1);
    const r = nextHeading(fix(b.lat, b.lng), a, 45);
    expect(r.heading).toBe(45);
    expect(r.anchor).toBe(a);
  });
});

describe("pickSides", () => {
  // A street running north at lng0; odd parcels 25 m west, even 25 m east, every 12 m.
  const at = { lat: 42.38, lng: -82.99 };
  const parcels: DriveParcel[] = [];
  for (let i = -3; i < 8; i++) {
    const c = ahead(at, 0, i * 12);
    const w = ahead(c, 270, 25);
    const e = ahead(c, 90, 25);
    parcels.push({ parcelId: `w${i}`, address: null, streetName: "GARLAND", ...w });
    parcels.push({ parcelId: `e${i}`, address: null, streetName: "GARLAND", ...e });
  }
  const far = ahead(ahead(at, 0, 10), 90, 80);
  parcels.push({ parcelId: "next-street", address: null, streetName: "BEWICK", ...far });
  const corner = ahead(ahead(at, 0, 30), 90, 12);
  parcels.push({ parcelId: "corner", address: null, streetName: "MACK", ...corner });

  test("heading north: west is left, east is right, nearest first", () => {
    const s = pickSides(parcels, at, 0);
    expect(s.left.map((c) => c.parcel.parcelId)).toEqual(["w0", "w1"]);
    expect(s.right.map((c) => c.parcel.parcelId)).toEqual(["e0", "e1"]);
  });
  test("heading south swaps the sides", () => {
    const s = pickSides(parcels, at, 180);
    expect(s.left[0]?.parcel.parcelId).toBe("e0");
    expect(s.right[0]?.parcel.parcelId).toBe("w0");
  });
  test("parcels over 40 m off the centreline and cross-street corners drop out", () => {
    const s = pickSides(parcels, ahead(at, 0, 26), 0);
    const ids = [...s.left, ...s.right].map((c) => c.parcel.parcelId);
    expect(ids).not.toContain("next-street");
    expect(ids).not.toContain("corner");
  });
});

describe("decideTap", () => {
  test("one tap low, second quick tap high on the same parcel even after moving on", () => {
    const first = decideTap("left", 1000, null, "a");
    expect(first).toEqual({ parcelId: "a", grade: "low" });
    expect(decideTap("left", 3500, { side: "left", parcelId: "a", grade: "low", at: 1000 }, "b")).toEqual({ parcelId: "a", grade: "high" });
  });
  test("after 3 s the next tap is a new low", () => {
    expect(decideTap("left", 4500, { side: "left", parcelId: "a", grade: "low", at: 1000 }, "b")).toEqual({ parcelId: "b", grade: "low" });
  });
  test("the other side never upgrades", () => {
    expect(decideTap("right", 1500, { side: "left", parcelId: "a", grade: "low", at: 1000 }, "c")).toEqual({ parcelId: "c", grade: "low" });
  });
  test("a third quick tap never downgrades the parcel just made high", () => {
    expect(decideTap("left", 1800, { side: "left", parcelId: "a", grade: "high", at: 1500 }, "a")).toBeNull();
    expect(decideTap("left", 1800, { side: "left", parcelId: "a", grade: "high", at: 1500 }, "b")).toEqual({ parcelId: "b", grade: "low" });
  });
  test("nothing on that side", () => {
    expect(decideTap("right", 1000, null, null)).toBeNull();
  });
});

describe("TagQueue", () => {
  const input = (parcelId: string): TagInput => ({ parcelId, grade: "low", side: "left", at: 1 });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  test("posts in order and keeps entries through a lost connection", async () => {
    const sent: string[] = [];
    let online = false;
    let id = 0;
    const q = new TagQueue({
      sendTag: async (i) => {
        if (!online) throw new Error("Failed to fetch");
        sent.push(i.parcelId);
        return { tagId: ++id };
      },
      sendUndo: async () => undefined,
      isRefusal: () => false,
      backoffMs: () => 10_000,
    });
    q.tag(input("a"));
    q.tag(input("b"));
    await flush();
    expect(q.pending).toBe(2);
    expect(q.stalled).toBe(true);
    online = true;
    q.kick();
    await flush();
    expect(sent).toEqual(["a", "b"]);
    expect(q.pending).toBe(0);
    q.dispose();
  });

  test("undo of a queued tag drops it; undo of a posted tag posts an undo", async () => {
    const calls: string[] = [];
    let online = false;
    const q = new TagQueue({
      sendTag: async (i) => {
        if (!online) throw new Error("offline");
        calls.push(`tag ${i.parcelId}`);
        return { tagId: 7 };
      },
      sendUndo: async (t) => {
        calls.push(`undo ${t}`);
      },
      isRefusal: () => false,
      backoffMs: () => 10_000,
    });
    q.tag(input("a"));
    const b = q.tag(input("b"));
    await flush();
    q.undo(b);
    expect(q.pending).toBe(1);
    online = true;
    q.kick();
    await flush();
    expect(calls).toEqual(["tag a"]);
    const c = q.tag(input("c"));
    await flush();
    q.undo(c);
    await flush();
    expect(calls).toEqual(["tag a", "tag c", "undo 7"]);
    q.dispose();
  });

  // Audit 2026-10-01: dispose (drive mode unmounting) cleared the retry timer, so
  // tags queued on a weak signal never posted once the admin left the screen.
  test("tags still queued keep posting after the screen is gone", async () => {
    const sent: string[] = [];
    let online = false;
    const q = new TagQueue({
      sendTag: async (i) => {
        if (!online) throw new Error("Failed to fetch");
        sent.push(i.parcelId);
        return { tagId: 1 };
      },
      sendUndo: async () => undefined,
      isRefusal: () => false,
      backoffMs: () => 20,
    });
    q.tag(input("a"));
    await flush();
    expect(q.pending).toBe(1);
    q.dispose();
    online = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual(["a"]);
    expect(q.pending).toBe(0);
  });

  test("a refusal drops that entry and the rest still post", async () => {
    const refused: string[] = [];
    const sent: string[] = [];
    const q = new TagQueue({
      sendTag: async (i) => {
        if (i.parcelId === "bad") throw new Error("Parcel not found");
        sent.push(i.parcelId);
        return { tagId: 1 };
      },
      sendUndo: async () => undefined,
      isRefusal: () => true,
      onRefused: (op) => refused.push(op.kind),
    });
    q.tag(input("bad"));
    q.tag(input("ok"));
    await flush();
    expect(refused).toEqual(["tag"]);
    expect(sent).toEqual(["ok"]);
    q.dispose();
  });
});
