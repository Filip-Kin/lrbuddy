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
| Admin | none; the Staff password link on `/login` (`ADMIN_PASSWORD`) | Event, Day, Companies, Crews, Lots, Photos, Catalog, Export, Green view, Access, and the planning portal (Plan) |

Green shirts approve requests for their CC at `/access` (a count shows in the
nav); admin sees every CC at `/admin/access`. The truck and green codes still
work in the Staff password field, and `POST /auth/login` still takes every code,
which is how the gate and the scripts sign in.

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

Without `FIREBASE_SERVICE_ACCOUNT` (or the emulator) the server runs as before
this feature: `/login` shows the staff password field and a crew QR signs the
phone straight into the crew.

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
cp .env.example .env          # set SESSION_SECRET and ADMIN_PASSWORD
bun run seed                  # demo event; prints every code and crew join link
bun run dev                   # server on :3000 with watch, vite on :5173
```

Production style, one process:

```sh
bun run build                 # web build into web/dist
bun run start                 # API and web/dist on $PORT
```

`bun run seed` wipes and recreates the event "Demo 2026": two CCs (codes `EAST01`,
`WEST01`, QR links `/g/EAST01`, `/g/WEST01`), three trucks (`TRUCK1`, `TRUCK2`,
`TRUCK3`, QR links `/t/TRUCK1` and so on), twelve crews
(`/j/demo-crew-01` to `/j/demo-crew-12`), 300 Land Bank lots with parcel outlines
(150 generated lots when the Land Bank does not answer), eight requests and one
broadcast. For the portal it caches the assessor parcels for the seed area (about
19,000; the first seed takes about a minute), tags a survey by "Kelsey" and gives
the twelve crews block sides and areas, without publishing.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite file `lrbuddy.db`. `/data` in the container. |
| `SESSION_SECRET` | required | Long random string. The server refuses to start without it. |
| `ADMIN_PASSWORD` | required | Admin login. |
| `PUBLIC_URL` | `http://localhost:3000` | Used in join links and QR codes. `https` turns on Secure cookies. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | empty | Web Push keys (`bunx web-push generate-vapid-keys`). Without them the Notifications switch reads "Not set up on this server". |
| `VAPID_SUBJECT` | `mailto:me@filipkin.com` | |
| `OSRM_URL` | `https://router.project-osrm.org` | Routing. `off` uses straight lines at 25 km/h. |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front that append to `X-Forwarded-For`. Set `1` behind Coolify so the login limit counts per client, not per proxy. |
| `WEB_DIST` | `web/dist` | Serve the web build from another folder. |
| `FIREBASE_SERVICE_ACCOUNT` | empty | Firebase service-account JSON on one line. Turns on phone and Google sign-in. |
| `FIREBASE_AUTH_EMULATOR_HOST` | empty | `127.0.0.1:9099` for the local emulator instead of a real project. |
| `FIREBASE_PROJECT_ID` | `demo-lrbuddy` | Project id when running against the emulator. |
| `VITE_FIREBASE_CONFIG` | empty | Build time. Firebase web config as JSON, for hosts other than production. |
| `VITE_FIREBASE_EMULATOR` | empty | Build time. Emulator URL for the browser, `http://127.0.0.1:9099`. |

## Checks

```sh
bun run typecheck && bun test && bun run build
PY=/home/filip/pit-podcast-automation/.venv/bin/python
$PY scripts/gate.py http://127.0.0.1:3000 <admin password>     # release gate, must exit 0
$PY scripts/story.py http://127.0.0.1:3000 <admin password>    # full flow across all four roles, on a fresh seed
$PY scripts/access.py http://127.0.0.1:3000 http://127.0.0.1:9099 <admin password>   # sign-in and approvals, emulator only
bun run shots http://127.0.0.1:3000 crew /,/requests --token demo-crew-01
```

`story.py` changes data (one request, one green stop, a Land Bank import); run
`bun run seed` again afterwards. Screenshots land in
`/home/filip/preview-shots/lrbuddy/`.

## Deploy

`docker build .` builds a two-stage `oven/bun:1` image (build arg `NPM_REGISTRY`
points installs at a local npm cache). The image runs migrations at boot,
listens on 3000, keeps its database in the `/data` volume and answers
`GET /health` with `{ ok, version, db }`. Production is Coolify at
`lrbuddy.filipkin.com`: built on `nas-builder`, run on the cloud host, 512 MB
memory limit, persistent volume at `/data`.

```sh
docker build -t lrbuddy .
docker run -e SESSION_SECRET=... -e ADMIN_PASSWORD=... -e PUBLIC_URL=https://lrbuddy.filipkin.com \
  -p 3000:3000 -v lrbuddy-data:/data lrbuddy
```
