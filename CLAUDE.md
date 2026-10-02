# LR Buddy

Field app for Life Remodeled's Six Day Project. Read `docs/SPEC.md` first; it is the contract.

## Rules for anyone editing this repo

- Bun only (`bun install`, `bun run`, `bun test`). TypeScript only. Never `any`; use `unknown` and narrow.
- Every user-visible string is a label, not a sentence. Load the `ui-copy` skill before writing one.
- Phone first. Below 860 px the nav is a hamburger. Before calling a screen done, run
  `bun run shots` and confirm `overflow_px=0` at 390 px.
- Do not add dependencies beyond `package.json` without writing why in the commit message.
- `reference/` is read-only source material copied from other projects. Never import from it.
- Commits: author Filip Kin <me@filipkin.com>, no Co-Authored-By lines, branch `main`.
- Do not bump the version per commit. One bump per release.
- No migration shims or back-compat code. Nothing has shipped yet; change the schema and regenerate.

## Commands

```
bun install
cp .env.example .env         # then set SESSION_SECRET and FIREBASE_AUTH_EMULATOR_HOST (no sign-in without Firebase)
bun run generate             # drizzle-kit, after a schema change
bun run seed                 # demo event, prints codes and join links
bun run dev                  # server on :3000 + vite on :5173
bun run typecheck && bun test && bun run build
bun run shots                # screenshots into /home/filip/preview-shots/lrbuddy
bun tests/e2e/support/fake-auth.ts 9297 &   # fake Auth emulator; run the server with FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9297
/home/filip/pit-podcast-automation/.venv/bin/python scripts/gate.py http://127.0.0.1:3000   # release gate, must exit 0
/home/filip/pit-podcast-automation/.venv/bin/python scripts/story.py http://127.0.0.1:3000  # end-to-end flow, all roles; reseed after
docker compose up -d         # Firebase Auth emulator for phone and Google sign-in (SPEC 18, README "Sign-in setup")
/home/filip/pit-podcast-automation/.venv/bin/python scripts/access.py http://127.0.0.1:3000 http://127.0.0.1:9099  # sign-in, request, approval, QR joins
```

On the NAS, port 3000 belongs to zwavejs2mqtt: run test servers with `PORT=3020`.
Shared controls (Button, Sheet, ConfirmSheet, Segmented, Chips, Switch, Skeleton, Panel, Settings rows,
StatusPill) live in `web/src/components`. Use them; do not add per-role copies.

There is no password anywhere (SPEC 26). Scripts and tests sign in through the fake Auth emulator:
admin as the seed's admin user (`seed-admin`), everyone else as a fresh user who opens a QR link.

Screenshot harness needs Playwright: use `/home/filip/pit-podcast-automation/.venv/bin/python scripts/shots.py`.
Chromium is at `/usr/bin/chromium`.
