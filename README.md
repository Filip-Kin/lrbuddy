# LR Buddy

Field app for Life Remodeled's Six Day Project: crews request supplies, trucks
deliver them on a computed route, green shirts run each command center, admins
set up the event. The contract is [`docs/SPEC.md`](docs/SPEC.md); decisions made
while building are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

Bun, TypeScript, tRPC v11 over SSE, Drizzle on `bun:sqlite`, React 18, wouter,
Tailwind v4, Leaflet.

```sh
bun install
cp .env.example .env          # set SESSION_SECRET and ADMIN_PASSWORD
bun run seed                  # demo event; prints codes and crew join links
bun run dev                   # server on :3000, vite on :5173
bun run typecheck && bun test && bun run build
bun run start                 # serves web/dist and the API on $PORT
bun run shots http://localhost:3000 crew --token demo-crew-03 /,/requests
```

Seed logins: admin uses `ADMIN_PASSWORD`; green `EAST01` / `WEST01`; drivers
`TRUCK1`..`TRUCK3`; crews open `/j/demo-crew-01`..`/j/demo-crew-12`.

Deploy: `docker build .` (two-stage `oven/bun:1`, `NPM_REGISTRY` build arg),
volume at `/data`, health check `GET /health`.
