# LR Buddy

Field app for Life Remodeled's Six Day Project. Crews on vacant lots ask for
water, gas, tools and trash bags from their phones. Trucks get the requests as
stops on a computed route. Green shirts at each command center see every crew,
truck, lot and request on one map and can step in. Admins set up the event,
import lots from the Detroit Land Bank and import crews. The planning portal at
`/plan` is where staff survey the area months ahead, pick the block sides, hand
them to companies and crews, and print each crew's sheet with its maps.

The contract is [`docs/SPEC.md`](docs/SPEC.md). Calls made while building are in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

Stack: Bun, TypeScript, tRPC v11 (subscriptions over SSE), Drizzle on
`bun:sqlite`, React 18, wouter, Tailwind v4, Leaflet. One process serves the
API and the web build from one origin.

## Roles and how they sign in

Everyone signs in once with a name and mobile number (a texted six-digit code)
or with Google, then gets a role in one of two ways: a printed QR grants it on
the spot, or a request on the Access screen waits for a green shirt (or admin)
to approve it.

| Role | QR on the print sheets | Screens |
|---|---|---|
| Crew (red shirt) | Crew sheet, `/j/<token>` | Map, Request, Requests, Lots, Command center, Settings |
| Driver | CC sheet, one per truck, `/t/<truck code>` | Queue, Map, Stock, Settings |
| Green shirt | CC sheet, `/g/<green code>` | Map, Requests, Lots, Photos, Crews, Trucks, Broadcast, Stats, Access |
| Admin | none; an admin membership (Access request, invite, or `/admin/people`) | Event, Day, Companies, Crews, Lots, Photos, Catalog, Export, Green view, Access, Invite, People, and the planning portal (Plan) |

Green shirts approve requests for their CC at `/access` (a count shows in the
nav); admin sees every CC and every Admin request at `/admin/access`. There is no
password and nothing is typed: a truck code, green code or crew token works only
through its `/t`, `/g` or `/j` link. Admins (any role and scope) and green shirts
(their own CC) make invite links `/i/<token>` on the Invite screen; admins add and
remove admins on `/admin/people`, and the last admin stays.

The first admin is one row, inserted by hand after that person has signed in once:

    INSERT INTO memberships (user_id, role, status, requested_at, decided_at, note) SELECT id, 'admin', 'approved', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, 'SQL' FROM users WHERE phone = '+1XXXXXXXXXX';

## Sign-in setup (Firebase)

Phone and Google sign-in run on Firebase Authentication; the server verifies
each ID token with the Admin SDK and keeps its own `users` and `memberships`.

Local, with no real project and no SMS:

```sh
docker compose up -d                                   # Auth emulator on :9099 (FIREBASE_AUTH_PORT moves it)
# in .env:
#   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
#   VITE_FIREBASE_EMULATOR=http://127.0.0.1:9099
bun run build && bun run seed && bun run start
```

The emulator accepts any number and never texts it; the code it "sent" is at
`http://127.0.0.1:9099/emulator/v1/projects/demo-lrbuddy/verificationCodes`.
`scripts/access.py` drives the whole flow against it (phone sign-in, a red shirt
request, the green approval, the QR joins).

Production needs, once:

1. A Firebase project on the **Blaze** plan. Phone sign-in on the free plan is
   capped at a few SMS a day.
2. Authentication, Sign-in method: enable **Phone** and **Google**.
3. Authentication, Settings, Authorized domains: add `lrbuddy.filipkin.com`.
4. Project settings, General: register a web app and paste its config into
   `PROD_CONFIG` in `web/src/lib/firebaseConfig.ts` (the API key is a client
   identifier, not a secret). Until then the build reads `VITE_FIREBASE_CONFIG`
   (build arg in the Dockerfile).
5. Project settings, Service accounts: generate a key and set its JSON, on one
   line, as `FIREBASE_SERVICE_ACCOUNT` on Coolify.

The server refuses to start without `FIREBASE_SERVICE_ACCOUNT` or
`FIREBASE_AUTH_EMULATOR_HOST`: there is no sign-in, and no QR sign-in, without a
Firebase user.

## Planning portal

Admin only, at `/plan`. A left rail on a laptop (the same hamburger as everywhere
else on a phone) with the event picker, Survey, Blocks, Assignments, Print and a
link back to the field app.

1. **Survey** (`/plan/survey`). Load parcels: draw a rectangle on the map and the
   assessor layer's parcels for that area land in a cache shared by every event.
   Tag parcels High, Low or Clear, either by clicking them on the laptop map or by
   driving. **Drive mode** (`/plan/survey/drive`) is the phone screen: the map
   follows the GPS dot heading up, and the Left and Right buttons tag the nearest
   parcel on that side (one tap Low, a second tap within 3 s High, long press for
   the grade sheet with a note and a before photo). Taps queue while offline.
2. **Blocks** (`/plan/blocks`). Parcels group into block sides (street, the two
   cross streets, odd or even). The map colours each side by its work count
   (0, 1 to 4, 5 to 9, 10+) and the table sorts them; the totals bar turns work
   into crews needed with an editable per-crew capacity.
3. **Assignments** (`/plan/assignments`). Pick a day and a CC, add the companies
   coming that day with their headcount, **Build crews** (one per 10 people,
   "Ford 1", "Ford 2"), select block sides with the rectangle and **Assign** them
   to a company or crew. **Publish to field app** writes the lots and each crew's
   area; publishing again updates and leaves done lots alone.
4. **Print** (`/plan/print`). One Letter page per crew (QR, overview map of the
   CC's area, detail map of the crew's lots with addresses and grades, lot list,
   green shirts, the sign-in code) and one per CC (codes, trucks, crews). The
   Print button waits for every map tile.

The rectangle tool is the same everywhere (Survey, Assignments, green Lots, admin
Lots): two clicks along the street, a third for the width, then corner, edge and
rotate handles. It exists because the east side's streets run on a diagonal.

## Run it

```sh
bun install
cp .env.example .env          # set SESSION_SECRET and FIREBASE_AUTH_EMULATOR_HOST
bun run seed                  # demo event; prints every QR join link, writes $DATA_DIR/seed-codes.json
bun run dev                   # server on :3000 with watch, vite on :5173
```

Production style, one process:

```sh
bun run build                 # web build into web/dist
bun run start                 # API and web/dist on $PORT
```

`bun run seed` wipes and recreates the event "Demo 2026": two CCs (East and West), three
trucks, twelve crews, Day 4's CC Webb with two trucks and twenty crews, 300 Land Bank lots with parcel outlines
(150 generated lots when the Land Bank does not answer), eight requests and one
broadcast. For the portal it caches the assessor parcels for the seed area (about
19,000; the first seed takes about a minute), tags a survey by "Kelsey" and gives
the twelve crews block sides and areas, without publishing.

Every green code, truck code and crew token is generated on each run, the same way the admin
pages make them. The seed prints the QR join links (`/g/<code>`, `/t/<code>`, `/j/<token>`) and
writes them to `$DATA_DIR/seed-codes.json` (role, day, cc, name, code, path, link), where the
scripts and the e2e suite read them. That file stays in the data folder, never in the repo.
The seed also keeps an admin user (Firebase uid `seed-admin`, the `admin` row of that file) with
an admin membership, which the scripts and the e2e suite sign in as through the fake Auth emulator.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite file `lrbuddy.db`. `/data` in the container. |
| `SESSION_SECRET` | required | Long random string. The server refuses to start without it. |
| `PUBLIC_URL` | `http://localhost:3000` | Used in join links and QR codes. `https` turns on Secure cookies. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | empty | Web Push keys (`bunx web-push generate-vapid-keys`). Without them the Notifications switch reads "Not set up on this server". |
| `VAPID_SUBJECT` | `mailto:me@filipkin.com` | |
| `OSRM_URL` | `https://router.project-osrm.org` | Routing. `off` uses straight lines at 25 km/h. |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front that append to `X-Forwarded-For`. Set `1` behind Coolify so the sign-in limit counts per client, not per proxy. |
| `WEB_DIST` | `web/dist` | Serve the web build from another folder. |
| `FIREBASE_SERVICE_ACCOUNT` | required in production | Firebase service-account JSON on one line. This or the next is required. |
| `FIREBASE_AUTH_EMULATOR_HOST` | required locally | `127.0.0.1:9099` (docker compose) or `127.0.0.1:9297` (fake-auth.ts) instead of a real project. |
| `FIREBASE_PROJECT_ID` | `demo-lrbuddy` | Project id when running against the emulator. |
| `VITE_FIREBASE_CONFIG` | empty | Build time. Firebase web config as JSON, for hosts other than production. |
| `VITE_FIREBASE_EMULATOR` | empty | Build time. Emulator URL for the browser, `http://127.0.0.1:9099`. |

## Checks

```sh
bun run typecheck && bun test && bun run build
PY=/home/filip/pit-podcast-automation/.venv/bin/python
bun tests/e2e/support/fake-auth.ts 9297 &      # fake Auth emulator: any uid signs in, no SMS
bun run seed && FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9297 bun run start &
$PY scripts/gate.py http://127.0.0.1:3000      # release gate, must exit 0
$PY scripts/story.py http://127.0.0.1:3000     # full flow across all four roles, on a fresh seed
$PY scripts/access.py http://127.0.0.1:3000 http://127.0.0.1:9099   # sign-in and approvals, real emulator (docker compose) only
bun run shots http://127.0.0.1:3000 crew /,/requests --link "$(jq -r '.[] | select(.name=="FORD 1") | .path' data/seed-codes.json)"
```

The scripts sign in through the fake Auth emulator: admin as the seed's admin user, everyone else
as a fresh user who opens a QR link from `$DATA_DIR/seed-codes.json` (`SEED_CODES` names another
file), so run them with the `DATA_DIR` the server was seeded into. `story.py` changes data (one request, one green stop, a Land Bank import); run
`bun run seed` again afterwards. Screenshots land in
`/home/filip/preview-shots/lrbuddy/`.

## End-to-end tests

```sh
bun run e2e                                   # whole suite, phone (390x844) and laptop (1440x900)
bun run e2e tests/e2e/specs/driver.e2e.ts     # one file
bun run e2e --project=phone -g "Paint"        # one test, one size
```

Playwright with the system Chromium (`/usr/bin/chromium`, no browser download). The run builds
the web bundle into a temp folder, seeds two fresh databases there, starts two servers on free
ports, runs `tests/e2e/specs/*.e2e.ts` and deletes the folder. It never touches `./data` or
production. `E2E_KEEP=1` keeps the folder and the server logs; `E2E_WORKERS` sets the parallelism
(6).

- Offline. `tests/e2e/support/offline.ts` is preloaded into the seed and the servers and answers
  ArcGIS (Land Bank and parcel layers), Overpass, OSRM and World Imagery from a made-up street grid
  (`fake-world.ts`) around CC East, CC West and CC Webb. Browsers get a blank tile for Esri and
  nothing else outside; any other outside request fails the test.
- Two servers, each with its own database, both with Firebase on through the fake Auth emulator
  (`support/fake-auth.ts`): the main one, and one for the access request tests. Admin is the seed's
  admin user; everyone else signs in as a fresh user and opens a QR or invite link.
- The phone and laptop projects run at the same time on one server, each in its own lane of the
  seed (`support/lanes.ts`). Each test puts back what it changes where the app allows it
  (broadcasts and events have no delete); the databases are thrown away at the end.
- Bugs the suite found are in `tests/e2e/FOUND.md`, each with a `test.fixme` repro in
  `specs/found.e2e.ts`.

## Deploy

`docker build .` builds a two-stage `oven/bun:1` image (build arg `NPM_REGISTRY`
points installs at a local npm cache). The image runs migrations at boot,
listens on 3000, keeps its database in the `/data` volume and answers
`GET /health` with `{ ok, version, db }`. Production is Coolify at
`lrbuddy.filipkin.com`: built on `nas-builder`, run on the cloud host, 512 MB
memory limit, persistent volume at `/data`.

```sh
docker build -t lrbuddy .
docker run -e SESSION_SECRET=... -e PUBLIC_URL=https://lrbuddy.filipkin.com \
  -p 3000:3000 -v lrbuddy-data:/data lrbuddy
```

Coolify: `ADMIN_PASSWORD` is no longer read; delete it from the app's environment.
