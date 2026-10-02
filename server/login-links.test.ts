import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SPEC 4: POST /auth/login takes only the staff password. A truck code, a
// green code and a crew token are refused there and sign in only through
// their own /t, /g and /j links. Runs the real server (Firebase off) on its
// own temp database. Bun runs every test file in one process and the db
// module opens one $DATA_DIR for all of them, so the fixture is written by a
// child process with this test's DATA_DIR, not through an import here.

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-login-links-test-"));
const env = {
  ...process.env,
  DATA_DIR: dir,
  SESSION_SECRET: "test-secret",
  ADMIN_PASSWORD: "right-password",
  OSRM_URL: "off",
  // Bun reads the repo's .env too; empty values keep Firebase off whatever it holds.
  FIREBASE_SERVICE_ACCOUNT: "",
  FIREBASE_AUTH_EMULATOR_HOST: "",
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

let ipSerial = 0;
/** Each call from its own client address, so the 20 a minute login limit never interferes. */
const login = (code: string): Promise<Response> =>
  fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ipSerial}` },
    body: JSON.stringify({ code }),
  });

const open = (path: string): Promise<Response> => fetch(`${base}${path}`, { redirect: "manual" });

const roleOf = async (res: Response): Promise<string> => {
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const me = await fetch(`${base}/trpc/shared.me`, { headers: { cookie } });
  const body = (await me.json()) as { result: { data: { json: { role: string } } } };
  return body.result.data.json.role;
};

describe("POST /auth/login takes only the staff password", () => {
  test("a truck code is refused", async () => {
    const res = await login(truck.code);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "Wrong password" });
  });

  test("a green code is refused", async () => {
    expect((await login(greenCode)).status).toBe(401);
    expect((await login(greenCode.toLowerCase())).status).toBe(401);
  });

  test("a crew token is refused", async () => {
    expect((await login(crew.token)).status).toBe(401);
  });

  test("the admin password signs in as admin", async () => {
    const res = await login("right-password");
    expect(res.status).toBe(200);
    expect(await roleOf(res)).toBe("admin");
  });
});

describe("the QR links still sign in", () => {
  test("/t/<truck code> signs in as the driver", async () => {
    const res = await open(`/t/${truck.code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await roleOf(res)).toBe("driver");
  });

  test("/g/<green code> signs in as the green shirt", async () => {
    const res = await open(`/g/${greenCode}`);
    expect(res.headers.get("location")).toBe("/");
    expect(await roleOf(res)).toBe("green");
  });

  test("/j/<crew token> signs in as the crew", async () => {
    const res = await open(`/j/${crew.token}`);
    expect(res.headers.get("location")).toBe("/");
    expect(await roleOf(res)).toBe("crew");
  });

  test("a link takes only its own kind, and never the admin password", async () => {
    for (const path of [`/j/${truck.code}`, `/g/${truck.code}`, `/t/${greenCode}`, `/t/${crew.token}`, "/j/right-password", "/t/right-password"]) {
      const res = await open(path);
      expect(res.headers.get("location"), path).toBe("/login?link=unknown");
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
  });
});
