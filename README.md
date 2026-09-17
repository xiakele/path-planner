# PATH Planner

A single-page web app that answers one question: **"Which train should I catch
to arrive at my PATH station by a specific time?"**

Enter the time you need to arrive and PATH Planner shows the three latest
options — including transfer connections — with the departure time at your
origin and how far away each departure is from right now.

## Highlights

- **Arrive-by search** — the three latest catchable departures ranked by
  departure time (dominated options pruned), each attributed to a specific
  first train.
- **Live departure board** — a second button shows the next ~45 minutes of
  trains leaving the origin station, scoped by default to the route you
  picked: each row is a train that gets you to your destination (direct or
  with up to 2 transfers) with its estimated arrival there and the transfer
  path. A **To {destination} / All trains** switch flips to the full board.
  Real-time projected times, "on time" / "+5 min" badges, struck-through
  timetable times, feed-only extras the printed schedule doesn't know about,
  sorted nearest departure first and refreshed on every poll; two trains that
  end up departing the same minute collapse into one row.
- **Stop-by-stop details** — every result card and departure-board row is
  clickable: a popup lists each intermediate stop with its (delay-adjusted)
  ETA, transfer waits included, and live-refreshes on every poll. Live-only
  feed trains note that no timetable backs them.
- **Real-time delays** — trains observed running off-timetable (via the
  PANYNJ RidePATH feed, the same one panynj.gov uses) shift the search
  before ranking: a delayed train you can still catch stays catchable, tight
  transfers and arrivals reflect reality, and result cards show "on time" /
  "+5 min" badges with the timetable time struck through.
- **Transfer connections** — up to 2 transfers with a 3-minute minimum
  connection time, e.g. Journal Square → Newport → Hoboken. Connections
  never call again at your origin station (a ride out and back is replaced
  by the returning train boarded directly); a train merely passing a closed
  origin overnight doesn't count as a loop, so late-night escapes via
  9 St / 23 St still work.
- **Next-occurrence time logic** — if the entered time has already passed, the
  query rolls to the next day; late-night trips are kept on the correct
  calendar day (PATH tables are per calendar day, so Saturday 00:10 runs
  Friday night).
- **Full network coverage** — all 13 stations on both sides of the Hudson,
  using the weekday / Saturday / Sunday timetables including night service.
- **Clean, focused design** — dark night-sky gradient, drum-style time
  picker, soft gold accents, dark rounded result cards.

## Usage

1. Pick a route (defaults to Journal Square → 9th Street).
2. Pick the arrival time with the drum picker.
3. Hit **Find trains** — or **Live departures** for the departure board at
   the origin station instead. The board starts scoped to the trains that
   connect to your destination (with estimated arrivals); the
   **To {destination} / All trains** switch above the list flips to every
   train leaving the station. The two views swap; each has a ghost button
   to jump back to its picker.

Each result card leads with the departure and arrival times plus the total
duration, the full itinerary with per-leg times and live status, and any
transfer waits; already-departed options appear dimmed ("departed X min ago"). Missed options
keep showing around midnight — including trains from the previous calendar
day's timetable — so you can see the last connection that would have made it
instead of an empty list. Clicking (or Enter on) any card — results and board
rows alike — opens a popup with every stop along the way and its ETA.

## How it works

- `scripts/update-schedule.mjs` fetches the timetable content behind
  [panynj.gov/path/en/schedules-maps.html](https://www.panynj.gov/path/en/schedules-maps.html)
  and parses the printed timetable tables into `data/schedule.json`
  (weekday / Saturday / Sunday lines, every trip with per-station times).
- `src/search.js` searches that snapshot: it keeps every first-leg trip
  boarding at the origin, then uses a small connection-scan to find the
  earliest completion from each alighting point (≤ 2 transfers, ≥ 3-minute
  transfers), on an absolute timeline that spans yesterday, tonight and
  tomorrow so pre-/post-midnight trains resolve to the right calendar day
  (yesterday's trains can only ever appear as dimmed missed-train context).
- `api/realtime.js` is a Vercel serverless function that proxies the PANYNJ
  real-time feed (the upstream sends no CORS headers, so the browser can't
  fetch it directly), slims it down and caches it for 15 s; the browser
  polls it every 16 s (pausing in background tabs, catching up on return)
  and re-renders the results on each poll.
- `src/realtime.js` pairs feed entries with timetable trips — same station,
  same terminus, matching line color, nearest projected arrival within a
  tolerance — and produces per-trip delays that `search.js` applies before
  ranking.
- `src/departures.js` builds the live departure board: the timetable's next
  ~45 minutes at the origin station, delay-adjusted by the pairing above,
  plus feed entries with no timetable counterpart as "live" extra rows;
  nearest departure first. Scoped to a destination, it keeps only the first
  legs of viable journeys there (reusing `search.js`'s connection scan,
  capped at 2 hours end-to-end) and stamps each row with the estimated
  arrival and the transfer path.
- `src/app.js` is the UI; there is no framework and no build step.

## Development

```sh
pnpm install
pnpm dev              # serve locally at http://localhost:8080 (vercel dev —
                      # runs api/ too; needs a one-time `vercel link`)
pnpm test             # Node harnesses (search, real-time delays, departures)
pnpm update:schedule  # refresh data/schedule.json from panynj.gov
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm format:check
```

(`pnpm dev` hops through the `dev:stack` script because `vercel dev`
refuses to run when the `dev` script literally invokes `vercel dev` —
it thinks it would recurse.)

Without `vercel link`, `pnpm dev` still serves the site but `/api/realtime`
404s — the app falls back to timetable-only times (the results header says
so).

## Deployment

Deploy to Vercel with zero configuration: the static site plus the
`api/realtime.js` serverless function. (Serving the directory with a plain
static file server works too, minus the real-time layer.)

Schedule data changes a few times a year; re-run `pnpm update:schedule` and
commit the refreshed `data/schedule.json` when PATH announces new timetables.

## Notes

- The PANYNJ site warns trains may leave up to 3 minutes earlier or later
  than the times shown — treat tight connections accordingly.
- Real-time caveats: the feed has no trip IDs, so trip/entry pairing is a
  nearest-time heuristic; it only covers roughly the next 30–45 minutes
  (later journeys show timetable times); and an observed delay is applied to
  the train's whole run. Duplicate listings of one train are collapsed
  before pairing, and pairings that would make a train leave more than ~3
  minutes early are rejected outright (trains never meaningfully run early),
  so leftover feed entries can't pose as phantom trains. When the feed is
  unreachable or stale (> 2 min), the app silently falls back to timetable
  times. On the departure board, a feed entry only shows as a "live" extra
  when no timetable train matches it (same terminus, color, within the
  pairing tolerance) — same heuristic, same limits.
- The board's estimated arrivals are the connection scan's earliest outcome
  (up to 2 transfers, journey capped at 2 hours); an observed delay is
  assumed to hold along the whole run, so connecting legs inherit it.
- 9 St & 23 St stations are closed nightly 12 AM–5 AM; overnight trains skip
  them, which the schedule reflects.
- Special-event timetables (holidays, planned outages) are not parsed — only
  the standard weekday / Saturday / Sunday schedules.

Not affiliated with the Port Authority of New York and New Jersey.
