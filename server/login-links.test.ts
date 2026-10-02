import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SPEC 26: there is no staff password and no /auth/login route. A truck
// code, a green code and a crew token sign in only through their own /t, /g
// and /j links, and like an invite /i/<token> only for a signed-in Firebase
// user: signed out, the link is remembered through sign-in, never signed in on
// the spot. Runs the real server on its own temp database, pointed at an
// emulator address nothing answers (nothing here signs in). Bun runs every test file in one process and the db
// module opens one $DATA_DIR for all of them, so the fixture is written by a
// child process with this test's DATA_DIR, not through an import here.

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-login-links-test-"));
const env = {
  ...process.env,
  DATA_DIR: dir,
  SESSION_SECRET: "test-secret",
  OSRM_URL: "off",
  // Bun reads the repo's .env too; set both so whatever it holds does not leak in.
  FIREBASE_SERVICE_ACCOUNT: "",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
};

const FIXTURE = `
const setup = await import("./server/setup.ts");
const { db } = await import("./server/db/index.ts");
const s = await import("./server/db/schema.ts");
const { eq } = await import("drizzle-orm");
const ev = setup.createEvent({ name: "Links", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get();
const cc = setup.createCc({ dayId: day.id, name: "East", lat: 42.37, lng: -82.99 });
const truck = setup.createTruck({ dayId: day.id, ccId: cc.id, name: "Truck 1" });
const crew = setup.createCrew({ dayId: day.id, ccId: cc.id, companyId: null });
const green = db.select().from(s.greenCodes).where(eq(s.greenCodes.ccId, cc.id)).get();
const now = Date.now();
const base = { role: "green", eventId: ev.id, dayId: day.id, ccId: cc.id, uses: 0, createdAt: now };
db.insert(s.invites).values({ ...base, token: "invite-live-0001", expiresAt: now + 3600000 }).run();
db.insert(s.invites).values({ ...base, token: "invite-old-00001", expiresAt: now - 1000 }).run();
db.insert(s.invites).values({ ...base, token: "invite-used-0001", maxUses: 1, uses: 1, expiresAt: now + 3600000 }).run();
db.insert(s.invites).values({ ...base, token: "invite-gone-0001", revokedAt: now, expiresAt: now + 3600000 }).run();
console.log(JSON.stringify({ truck: truck.code, green: green.code, crew: crew.token }));
`;
const made = Bun.spawnSync(["bun", "-e", FIXTURE], { cwd: ROOT, env });
if (made.exitCode !== 0) throw new Error(`fixture failed: ${made.stderr.toString()}`);
const codes = JSON.parse(made.stdout.toString().trim().split("\n").pop()!) as { truck: string; green: string; crew: string };
const truck = { code: codes.truck };
const crew = { token: codes.crew };
const greenCode = codes.green;

const port = 33000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  proc = Bun.spawn(["bun", "server/index.ts"], {
    cwd: ROOT,
    env: { ...env, PORT: String(port), PUBLIC_URL: base },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 250; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("server never answered /health");
}, 30_000);

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  rmSync(dir, { recursive: true, force: true });
});

const login = (code: string): Promise<Response> =>
  fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });

const open = (path: string): Promise<Response> => fetch(`${base}${path}`, { redirect: "manual" });

describe("no staff password", () => {
  test("POST /auth/login is gone: 404 for a password, a truck code, a green code and a crew token", async () => {
    for (const code of ["right-password", "change-me", truck.code, greenCode, crew.token]) {
      const res = await login(code);
      expect(res.status, code).toBe(404);
      expect(res.headers.get("set-cookie"), code).toBeNull();
    }
  });
});

describe("invite links", () => {
  test("signed out, a live invite is remembered and sends the phone to sign in", async () => {
    const res = await open("/i/invite-live-0001");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie") ?? "").toContain("lrb_join=invite%3Ainvite-live-0001");
  });

  test("expired, used, revoked and unknown invites are refused with their state", async () => {
    for (const [token, state] of [
      ["invite-old-00001", "expired"],
      ["invite-used-0001", "used"],
      ["invite-gone-0001", "revoked"],
      ["no-such-invite-1", "unknown"],
    ] as const) {
      const res = await open(`/i/${token}`);
      expect(res.headers.get("location"), token).toBe(`/link?state=${state}`);
      expect(res.headers.get("set-cookie"), token).toBeNull();
    }
  });
});

describe("QR links need a signed-in user", () => {
  test("signed out, /t, /g and /j are remembered for sign-in and sign nobody in", async () => {
    for (const [path, kind, value] of [
      [`/t/${truck.code}`, "truck", truck.code],
      [`/g/${greenCode}`, "cc", greenCode],
      [`/j/${crew.token}`, "crew", crew.token],
    ] as const) {
      const res = await open(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/login");
      const cookies = res.headers.get("set-cookie") ?? "";
      expect(cookies, path).toContain(`lrb_join=${kind}%3A${value}`);
      expect(cookies, path).not.toContain("lrb_session=");
    }
  });

  test("a link takes only its own kind", async () => {
    for (const path of [`/j/${truck.code}`, `/g/${truck.code}`, `/t/${greenCode}`, `/t/${crew.token}`]) {
      const res = await open(path);
      expect(res.headers.get("location"), path).toBe("/login?link=unknown");
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
  });
});
