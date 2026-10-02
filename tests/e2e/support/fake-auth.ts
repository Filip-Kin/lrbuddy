/**
 * A stand-in for the Firebase Auth emulator. In emulator mode the Admin SDK accepts an unsigned
 * ID token (alg "none") and only asks the emulator whether the account exists (`accounts:lookup`);
 * this answers that for any uid with a live, enabled user. So a test or a script signs a person in
 * with one POST to `/auth/firebase` (support/firebase.ts, scripts/seedcodes.py), no SMS or Google.
 *
 * global-setup.ts starts one for the e2e servers. For the gate and the scripts run it on its own
 * and point the server at it:
 *
 *   bun tests/e2e/support/fake-auth.ts 9297 &
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9297 PORT=3071 bun server/index.ts
 */
import { createServer, type Server } from "node:http";

export const startFakeAuth = (port = 0): Promise<{ server: Server; port: number }> =>
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
        res.end(JSON.stringify({ error: { code: 404, message: `fake Auth emulator: ${req.url}` } }));
      });
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      ok({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });

if (import.meta.main) {
  const { port } = await startFakeAuth(Number(process.argv[2] ?? 9297));
  process.stdout.write(`fake Auth emulator on 127.0.0.1:${port}\n`);
}
