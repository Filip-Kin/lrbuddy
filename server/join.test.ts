import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-join-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.OSRM_URL = "off";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const { createSession, setSessionName, cleanPhone } = await import("./auth.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const world = () => {
  db.delete(s.events).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const cc = setup.createCc({ dayId: day.id, name: "East", lat: 42.37, lng: -82.99 });
  return { day, cc };
};

describe("crew join name and mobile", () => {
  test("fills a blank lead phone and lead name", () => {
    const { day, cc } = world();
    const crew = setup.createCrew({ dayId: day.id, ccId: cc.id, companyId: null, token: "join-test-01" });
    const session = createSession({ role: "crew", crewId: crew.id, ccId: cc.id });
    expect(setSessionName(session.id, "Jordan", "313 555 0199")).toBe("Jordan");
    expect(db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()).toMatchObject({ leadPhone: "313 555 0199", leadName: "Jordan" });
  });

  test("never overwrites an imported number", () => {
    const { day, cc } = world();
    const crew = setup.createCrew({ dayId: day.id, ccId: cc.id, companyId: null, leadName: "Pat", leadPhone: "313-555-0100", token: "join-test-02" });
    const session = createSession({ role: "crew", crewId: crew.id, ccId: cc.id });
    setSessionName(session.id, "Sam", "313-555-0142");
    expect(db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()).toMatchObject({ leadPhone: "313-555-0100", leadName: "Pat" });
  });

  test("a number with too few digits is not stored", () => {
    expect(cleanPhone("555")).toBeNull();
    expect(cleanPhone("(313) 555-0100")).toBe("(313) 555-0100");
  });
});
