# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this is

Static site + one serverless function (no framework, no bundler, no build
step): `index.html` at the repo root is the static/Vercel entry point, code
lives in `src/`, schedule data in `data/`, the real-time proxy in `api/`.
The user-facing overview is in `README.md`.

- `src/app.js` — all UI (route selects, drum time picker, rendering, the
  16 s real-time poll with a 1 s freshness ticker, paused in hidden tabs;
  the click-through stop popup shared by results and the board).
- `src/search.js` — journey search; pure ES module with no DOM access, so it
  can be tested directly from Node. `collectTrips` / `continuation` /
  `reconstruct` / `toLeg` are exported for `departures.js`'s board and the
  UI's leg rendering.
- `src/realtime.js` — pairs feed entries with timetable trips into per-trip
  delays; pure like search.js, tested by `scripts/test-realtime.mjs`.
- `src/departures.js` — live departure board at one station (timetable +
  delay merge, feed-only extras; optional route-scoped mode reusing
  search.js's connection machinery); pure like search.js, tested by
  `scripts/test-departures.mjs`.
- `api/realtime.js` — Vercel function proxying the PANYNJ RidePATH feed
  (upstream has no CORS headers); 15 s cache.
- `scripts/update-schedule.mjs` — parses the PANYNJ timetables into
  `data/schedule.json`.

## Commands

- `pnpm dev` — local server on :8080 via `vercel dev` (serves `api/` too;
  needs a one-time `vercel link`). Without linking, the site still works,
  just without real-time data. There is no build step.
- `pnpm test` — Node harnesses for the search, delay and departure-board
  layers (`scripts/test-search.mjs`, `scripts/test-realtime.mjs`,
  `scripts/test-departures.mjs`; fixed clocks, no framework; keep extending
  them when touching `src/search.js` / `src/realtime.js` /
  `src/departures.js`).
- `pnpm lint` / `pnpm format` / `pnpm format:check` — ESLint + Prettier; run
  `pnpm lint && pnpm format:check` before committing.
- `pnpm update:schedule` — re-fetch and re-parse panynj.gov into
  `data/schedule.json`; needs network access. Commit the refreshed snapshot
  when PATH schedules change.
- No test framework exists. Verify search/delay logic with the harness above
  or `node --input-type=module` scripts, passing a fixed `mNow` (and `nowMs`
  for realtime.js) so results are reproducible regardless of the current
  time. Verify UI changes in a real browser (agent-browser), including a
  ≤480px viewport.

## Gotchas

- `data/schedule.json` is generated output — never hand-edit (`.prettierignore`
  excludes it). `scripts/update-schedule.mjs` resolves it via `../data`
  relative to its own file; `src/app.js` fetches it **document-relative**, so
  `index.html` must stay at the repo root.
- `src/search.js` works in absolute minutes since today's midnight: yesterday's
  timetable is base -1440, today's is base 0, tomorrow's is base 1440 (PATH
  tables are per calendar day — Saturday 00:10 runs Friday night — so the
  three tables let pre-/post-midnight trains resolve to the right day; only
  today's and tomorrow's are ever catchable, yesterday's is missed-train
  context). Trips whose arrival is earlier on the clock than their departure
  cross midnight and shift forward once.
- Results are ranked by **latest catchable departure** (not arrival), deduped
  per departure minute, with dominated journeys pruned. Ranking/journey-shape
  constants: `TRANSFER_MIN = 3`, `MAX_TRANSFERS = 2` in `src/search.js`.
- Departed first legs are always kept as dimmed **missed-train context** —
  they only surface in the top 3 when catchable options run out (typically
  around midnight). Context is bounded to journeys that arrived within the
  last `CONTEXT_MAX_MIN` (180) minutes; catchable journeys are unaffected.
- Displayed times are `depAbs/arrAbs mod 1440`; the "(next day)" tag is driven
  by values ≥ 1440 (negative values from yesterday's table wrap to PM times).
  Overnight trains intentionally skip 9 St / 23 St
  (stations close 12 AM–5 AM) — trust the data as printed.
- Route selects and drum columns share the `select-wrap` class; the drum's
  scroll + edge-fade styles are scoped to `.time-picker .select-wrap` on
  purpose (un-scoping visually clips the route picker). Keep that scoping.
- Text colors use the contrast tiers defined in `:root`
  (`--text-muted` / `--text-faint` / `--text-dim`) — use the vars, not literal
  grays.
- Real-time layer: the feed calls Grove/Exchange `GRV`/`EXP` (timetable:
  `GRO`/`EXC`), `lineColor` may be a comma list for combined services, and
  there are no trip IDs — pairing is nearest-projected-arrival per
  (station, terminus, color) with a greedy global match
  (`src/realtime.js`). Two mispair guards sit on top: duplicate listings of
  one train (same terminus, shared color, within `DUPLICATE_ENTRY_MIN`)
  collapse in `normalizeRt`, and pairings that would make a trip leave more
  than `MAX_EARLY_MIN` (3) early are rejected — trains never meaningfully
  run early, so those are always misreads. `findJourneys` takes the
  resulting delay Map as an optional 6th arg and stamps `delay` on each leg
  (undefined = timetable only, 0 = on time). Legs/`depAbs`/`arrAbs` are
  then already delay-adjusted — render them as-is and derive "was" times
  as `time - delay`.
- Departure board (`src/departures.js`): rows are the delay-adjusted
  timetable departures at the station within `DEPARTURES_WINDOW_MIN` (45)
  of now, **nearest departure first** — the opposite of the journey
  results' latest-first ranking. A stop at a line's final station is an
  arrival, not a departure (skipped); feed entries that match no timetable
  train (same terminus, color, within `MATCH_TOLERANCE_MIN`) become
  "live" extra rows with `line: null`. The optional 6th arg `to` scopes
  the board to a destination: rows are first legs of journeys there
  (direct or ≤ `MAX_TRANSFERS`, via `search.js`'s exported
  `continuation`/`reconstruct`) carrying `arrAbs` + `legs`; journeys must
  complete within `MAX_JOURNEY_MIN` (120) of the first departure — the
  scan spans three calendar-day tables, and without the cap the next
  day's trains would pose as connections. Scoped extras are gated on
  `terminus === to`. Every timetable row (scoped or not) carries `legs`
  built by search.js's exported `toLeg`, each leg with per-stop
  `{stop, time}` pairs (delay-adjusted, skipped stops omitted) — scoped rows
  the connection path, all-trains rows the single remaining ride to the
  terminus; these power the click-through stop popup in `src/app.js` (one
  page-level dialog, live-refreshed by `syncPopup` on each re-render, closed
  when its train leaves the list). Feed-only extras carry no legs — their
  popup shows a no-timetable note instead. Timetable rows that land on the
  same adjusted departure minute (same line and terminus — a delayed train
  catching its line-mate, or a residual mispair) collapse into one row, the
  more plausible surviving (no badge → smaller |delay| → earlier scoped
  arrival), mirroring the results' per-minute dedupe. In `src/app.js` the
  results and departures sections are mutually exclusive views; the board opens in
  route-scoped mode and
  resets to it on every fresh open, while the scope switch and the poll
  re-render preserve the chosen mode. Hidden sections
  collapse via `height: 0` (see `.results.content-section_hidden`) so the
  visible one reclaims the space — keep that when adding more views.
