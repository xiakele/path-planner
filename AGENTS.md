# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this is

Pure static site (no framework, no bundler, no build step): `index.html` at the
repo root is the static/Vercel entry point, code lives in `src/`, schedule data
in `data/`. The user-facing overview is in `README.md`.

- `src/app.js` — all UI (route selects, drum time picker, rendering).
- `src/search.js` — journey search; pure ES module with no DOM access, so it
  can be tested directly from Node.
- `scripts/update-schedule.mjs` — parses the PANYNJ timetables into
  `data/schedule.json`.

## Commands

- `pnpm dev` — local server (python http.server on :8080). There is no build step.
- `pnpm lint` / `pnpm format` / `pnpm format:check` — ESLint + Prettier; run
  `pnpm lint && pnpm format:check` before committing.
- `pnpm update:schedule` — re-fetch and re-parse panynj.gov into
  `data/schedule.json`; needs network access. Commit the refreshed snapshot
  when PATH schedules change.
- No test framework exists. Verify search logic with a Node harness, e.g.
  `node --input-type=module -e "import('./src/search.js')"` style scripts, and
  pass a fixed `mNow` to `findJourneys` so results are reproducible regardless
  of the current time. Verify UI changes in a real browser (agent-browser),
  including a ≤480px viewport.

## Gotchas

- `data/schedule.json` is generated output — never hand-edit (`.prettierignore`
  excludes it). `scripts/update-schedule.mjs` resolves it via `../data`
  relative to its own file; `src/app.js` fetches it **document-relative**, so
  `index.html` must stay at the repo root.
- `src/search.js` works in absolute minutes since today's midnight: today's
  timetable is base 0, tomorrow's is base 1440. PATH tables are per calendar
  day (Saturday 00:10 runs Friday night), and trips whose arrival is earlier
  on the clock than their departure cross midnight and shift forward once.
- Results are ranked by **latest catchable departure** (not arrival), deduped
  per departure minute, with dominated journeys pruned. Ranking/journey-shape
  constants: `TRANSFER_MIN = 3`, `MAX_TRANSFERS = 2` in `src/search.js`.
- Displayed times are `depAbs/arrAbs mod 1440`; the "(next day)" tag is driven
  by values ≥ 1440. Overnight trains intentionally skip 9 St / 23 St
  (stations close 12 AM–5 AM) — trust the data as printed.
- Route selects and drum columns share the `select-wrap` class; the drum's
  scroll + edge-fade styles are scoped to `.time-picker .select-wrap` on
  purpose (un-scoping visually clips the route picker). Keep that scoping.
- Text colors use the contrast tiers defined in `:root`
  (`--text-muted` / `--text-faint` / `--text-dim`) — use the vars, not literal
  grays.
