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
cp .env.example .env         # then set SESSION_SECRET and ADMIN_PASSWORD
bun run generate             # drizzle-kit, after a schema change
bun run seed                 # demo event, prints codes and join links
bun run dev                  # server on :3000 + vite on :5173
bun run typecheck && bun test && bun run build
bun run shots                # screenshots into /home/filip/preview-shots/lrbuddy
/home/filip/pit-podcast-automation/.venv/bin/python scripts/gate.py http://127.0.0.1:3000 <admin pw>   # release gate, must exit 0
```

Screenshot harness needs Playwright: use `/home/filip/pit-podcast-automation/.venv/bin/python scripts/shots.py`.
Chromium is at `/usr/bin/chromium`.
