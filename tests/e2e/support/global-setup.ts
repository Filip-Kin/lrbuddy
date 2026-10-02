/**
 * Runs once before the suite: builds the web bundle into a temp folder, seeds two fresh databases
 * and starts two servers on free ports, both with the network faked (offline.ts):
 *
 * - main: Firebase off, the way production ran before SPEC 18. Every spec but access uses it.
 * - signin: Firebase on through a fake Auth emulator that answers the one call the Admin SDK makes
 *   (`accounts:lookup`), so a test can sign in with an unsigned ID token and reach the Access
 *   request and approval screens without SMS or Google.
 *
 * The returned function stops both servers and deletes the temp folder. URLs, the admin
 * password and each server's generated codes (`seed-codes.json` in its data folder, E2E_CODES
 * and E2E_SIGNIN_CODES) reach the workers through process.env.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as netServer } from "node:net";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PRELOAD = join(ROOT, "tests/e2e/support/offline.ts");
const ADMIN_PASSWORD = "e2e-admin-password";
const PROJECT_ID = "demo-lrbuddy";

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = netServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });

/** Only what the app reads; nothing from the caller's shell or the repo's .env leaks in. */
const baseEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  SESSION_SECRET: "e2e-session-secret-not-for-production",
  ADMIN_PASSWORD,
  TRUST_PROXY_HOPS: "1",
  // Bun also reads the repo's .env; set everything it might hold. Both hosts are answered by offline.ts.
  OSRM_URL: "https://router.project-osrm.org",
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  FIREBASE_SERVICE_ACCOUNT: "",
  FIREBASE_AUTH_EMULATOR_HOST: "",
  VITE_FIREBASE_CONFIG: "",
  VITE_FIREBASE_EMULATOR: "",
  ...extra,
});

const run = (label: string, args: string[], env: NodeJS.ProcessEnv): void => {
  const r = spawnSync("bun", args, { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${label} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  const blocked = `${r.stdout}${r.stderr}`.split("\n").filter((l) => l.includes("[e2e offline]"));
  if (blocked.length) throw new Error(`${label} tried to reach the network:\n${blocked.join("\n")}`);
};

const waitHealthy = async (url: string, proc: ChildProcess, log: () => string): Promise<void> => {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}):\n${log()}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server at ${url} never answered /health:\n${log()}`);
};

/** The Auth emulator's account lookup, answered for any uid with a live, enabled user. */
const fakeEmulator = (): Promise<{ server: Server; port: number }> =>
  new Promise((ok) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.includes("/accounts:lookup")) {
          const parsed = JSON.parse(body || "{}") as { localId?: string[] };
          const users = (parsed.localId ?? []).map((id) => ({ localId: id, disabled: false, createdAt: "1", lastLoginAt: "1", validSince: "1" }));
          res.end(JSON.stringify({ kind: "identitytoolkit#GetAccountInfoResponse", users }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 404, message: `e2e fake emulator: ${req.url}` } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });

interface Started {
  proc: ChildProcess;
  url: string;
  /** The seed's generated codes and links. */
  codes: string;
  log: () => string;
}

const start = async (name: string, dir: string, dist: string, extra: Record<string, string>): Promise<Started> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const data = join(dir, name);
  const env = baseEnv({ PORT: String(port), DATA_DIR: data, PUBLIC_URL: url, WEB_DIST: dist, ...extra });
  run(`seed (${name})`, ["--preload", PRELOAD, "server/seed.ts"], env);
  let out = "";
  const proc = spawn("bun", ["--preload", PRELOAD, "server/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const log = (): string => out;
  await waitHealthy(url, proc, log);
  return { proc, url, codes: join(data, "seed-codes.json"), log };
};

const stop = (p: ChildProcess): Promise<void> =>
  new Promise((ok) => {
    if (p.exitCode !== null) return ok();
    p.once("exit", () => ok());
    p.kill("SIGTERM");
    setTimeout(() => p.kill("SIGKILL"), 3000).unref();
  });

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), "lrbuddy-e2e-"));
  const dist = join(dir, "dist");
  let main: Started | null = null;
  let signin: Started | null = null;
  let emu: Server | null = null;
  const teardown = async (): Promise<void> => {
    const logs = [main && `# main\n${main.log()}`, signin && `# signin\n${signin.log()}`].filter(Boolean).join("\n");
    const blocked = logs.split("\n").filter((l) => l.includes("[e2e offline]"));
    await Promise.all([main && stop(main.proc), signin && stop(signin.proc)]);
    emu?.close();
    if (process.env.E2E_KEEP) writeFileSync(join(dir, "servers.log"), logs);
    else rmSync(dir, { recursive: true, force: true });
    if (blocked.length) {
      console.error(`\n[e2e] the server tried to reach the network ${blocked.length} times:\n${[...new Set(blocked)].join("\n")}`);
      process.exitCode = 1;
    }
  };
  try {
    run("web build", ["x", "vite", "build", "--config", "web/vite.config.ts", "--logLevel", "error"], baseEnv({ WEB_DIST: dist }));
    const fake = await fakeEmulator();
    emu = fake.server;
    [main, signin] = await Promise.all([
      start("main", dir, dist, {}),
      start("signin", dir, dist, { FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${fake.port}`, FIREBASE_PROJECT_ID: PROJECT_ID }),
    ]);
  } catch (err) {
    await teardown();
    throw err;
  }
  process.env.E2E_BASE_URL = main.url;
  process.env.E2E_SIGNIN_URL = signin.url;
  process.env.E2E_CODES = main.codes;
  process.env.E2E_SIGNIN_CODES = signin.codes;
  process.env.E2E_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.E2E_FIREBASE_PROJECT = PROJECT_ID;
  process.env.E2E_DIR = dir;
  return teardown;
}
