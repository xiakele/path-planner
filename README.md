# PATH Planner

A single-page web app that answers one question: **"Which train should I catch
to arrive at my PATH station by a specific time?"**

Enter the time you need to arrive and PATH Planner shows the three latest
options — including transfer connections — with the departure time at your
origin and how far away each departure is from right now.

## Highlights

- **Arrive-by search** — the three closest usable journeys ranked by arrival,
  each attributed to a specific first train.
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

Each result card shows the first train's departure with its offset from now
("in 12 min", or dimmed "departed X min ago" for the closest missed options),
the full itinerary with per-leg times, and any transfer waits.

## How it works

- `scripts/update-schedule.mjs` fetches the timetable content behind
  [panynj.gov/path/en/schedules-maps.html](https://www.panynj.gov/path/en/schedules-maps.html)
  and parses the printed timetable tables into `data/schedule.json`
  (weekday / Saturday / Sunday lines, every trip with per-station times).
- `src/search.js` searches that snapshot: it keeps every first-leg trip
  boarding at the origin, then uses a small connection-scan to find the
  earliest completion from each alighting point (≤ 2 transfers, ≥ 3-minute
  transfers), on an absolute timeline that spans tonight and tomorrow so
  post-midnight departures resolve to the right calendar day.
- `src/app.js` is the UI; there is no framework and no build step.

## Development

```sh
pnpm install
pnpm dev              # serve locally at http://localhost:8080
pnpm update:schedule  # refresh data/schedule.json from panynj.gov
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm format:check
```

## Deployment

The site is fully static — `index.html` plus `src/` and `data/`. Deploy to
Vercel with zero configuration (`vercel` auto-detects a static project), or
serve the directory with any static file server.

Schedule data changes a few times a year; re-run `pnpm update:schedule` and
commit the refreshed `data/schedule.json` when PATH announces new timetables.

## Notes

- The PANYNJ site warns trains may leave up to 3 minutes earlier or later
  than the times shown — treat tight connections accordingly.
- 9 St & 23 St stations are closed nightly 12 AM–5 AM; overnight trains skip
  them, which the schedule reflects.
- Special-event timetables (holidays, planned outages) are not parsed — only
  the standard weekday / Saturday / Sunday schedules.

Not affiliated with the Port Authority of New York and New Jersey.
