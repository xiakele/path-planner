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
- **Real-time delays** — trains observed running off-timetable (via the
  PANYNJ RidePATH feed, the same one panynj.gov uses) shift the search
  before ranking: a delayed train you can still catch stays catchable, tight
  transfers and arrivals reflect reality, and result cards show "on time" /
  "+5 min" badges with the timetable time struck through.
- **Transfer connections** — up to 2 transfers with a 3-minute minimum
  connection time, e.g. Journal Square → Newport → Hoboken.
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
3. Hit **Find trains**.

Each result card leads with the departure and arrival times plus the total
duration, the full itinerary with per-leg times and live status, and any
transfer waits; already-departed options appear dimmed ("departed X min ago"). Missed options
keep showing around midnight — including trains from the previous calendar
day's timetable — so you can see the last connection that would have made it
instead of an empty list.

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
- `src/app.js` is the UI; there is no framework and no build step.

## Development

```sh
pnpm install
pnpm dev              # serve locally at http://localhost:8080 (vercel dev —
                      # runs api/ too; needs a one-time `vercel link`)
pnpm test             # Node harnesses (search + real-time delay layers)
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
  the train's whole run. Early readings are distrusted (trains rarely beat
  the timetable by more than the ~3 minutes PANYNJ allows) — a projection
  between two trains reads as the earlier one running late, and anything
  earlier than that is dropped. Trains the feed can't vouch for are marked
  "unverified" while live data is available. When the feed is unreachable or
  stale (> 2 min), the app silently falls back to timetable times.
- 9 St & 23 St stations are closed nightly 12 AM–5 AM; overnight trains skip
  them, which the schedule reflects.
- Special-event timetables (holidays, planned outages) are not parsed — only
  the standard weekday / Saturday / Sunday schedules.

Not affiliated with the Port Authority of New York and New Jersey.
