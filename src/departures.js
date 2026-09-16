// Departure board for one station: the next trains due to leave it.
//
// Rows come from the timetable (yesterday/today/tomorrow tables, same
// absolute-minute model as search.js), shifted by observed real-time delays
// from realtime.js's buildDelays. Feed entries at the station with no
// timetable counterpart become "live" extra rows (unscheduled trains the
// printed timetable doesn't know about).
//
// Pure ES module like search.js / realtime.js: no DOM access, explicit clock
// inputs, tested from Node (scripts/test-departures.mjs).

import { dayKeyFor } from "./search.js";
import { buildDelays, FEED_TO_SCHED, MATCH_TOLERANCE_MIN } from "./realtime.js";

export const DEPARTURES_WINDOW_MIN = 45; // board horizon: departures within this window of "now"
const GRACE_MIN = 5; // a departure this recently passed still shows (the train may be running late)

// "HH:MM" -> minutes since midnight (same parsing as search.js)
function toMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10);
}

// Return the board rows for `station`, sorted by nearest (delay-adjusted)
// departure first. Each row: { line, terminus, depAbs, delay, fromFeed } —
// `line` is null and `fromFeed` true for feed-only extras (which also carry
// the feed's color list), `delay` is undefined for timetable-only rows.
export function findDepartures(schedule, station, mNow, nowMs = Date.now(), rt = null) {
  const delays = rt ? buildDelays(schedule, rt, mNow, nowMs) : null;

  // Departures currently in the window span three tables: yesterday's
  // (base -1440), today's (base 0) and tomorrow's (base 1440) — a PATH table
  // is per calendar day, so the train leaving just after midnight belongs to
  // yesterday's table and the one about to leave after the next midnight to
  // tomorrow's (same rationale as realtime.js's buildDelays).
  const today = new Date(nowMs);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tables = [
    { dayKey: dayKeyFor(yesterday), base: -1440 },
    { dayKey: dayKeyFor(today), base: 0 },
    { dayKey: dayKeyFor(tomorrow), base: 1440 },
  ];

  const rows = [];
  // Every future departure at this station, delay-adjusted, without a window
  // limit: feed entries are matched against it to decide whether they belong
  // to a timetable train (even one beyond the board window) or are genuinely
  // unscheduled extras
  const known = []; // { depAbs, terminus, color }

  for (const { dayKey, base } of tables) {
    for (const line of schedule.days[dayKey] ?? []) {
      const s = line.stops.indexOf(station);
      // The line's final stop is an arrival, not a departure — terminal
      // stations get their departures from the lines that start there
      if (s < 0 || s === line.stops.length - 1) continue;
      const terminus = line.stops[line.stops.length - 1];
      const lineColor = line.color.toUpperCase();
      for (const trip of line.trips) {
        const mins = trip.map((t) => (t === null ? null : toMinutes(t)));
        const first = mins.find((t) => t !== null);
        if (first === undefined) continue;
        const t = mins[s];
        if (t === null) continue;
        // Absolute minutes with the same midnight shift as search.js's
        // collectTrips, then shifted by the trip's observed delay if any
        const abs = base + t + (t < first ? 1440 : 0);
        const delay = delays?.get(trip);
        const depAbs = abs + (delay ?? 0);
        // A timetable time already well past is gone for good — unless the
        // train is running late enough that its adjusted time is still ahead,
        // which the adjusted depAbs above already reflects
        if (depAbs < mNow - GRACE_MIN) continue;
        known.push({ depAbs, terminus, color: lineColor });
        if (depAbs > mNow + DEPARTURES_WINDOW_MIN) continue;
        rows.push({ line, terminus, depAbs, delay, fromFeed: false });
      }
    }
  }

  // Feed entries at this station with no timetable counterpart: extras the
  // printed schedule doesn't know about (added service, reroutes)
  const midnightMs = nowMs - mNow * 60000; // start of "today" in the absolute-minute model
  for (const e of rt?.stations[station] ?? []) {
    const terminus = FEED_TO_SCHED[e.target] ?? e.target;
    // An entry headed to this very station is an arrival here, not a
    // departure (happens at terminals, where every upcoming train is inbound)
    if (terminus === station) continue;
    const projected = (e.projectedMs - midnightMs) / 60000;
    const colors = e.colors.map((c) => c.toUpperCase());
    const hasTrip = known.some(
      (k) =>
        k.terminus === terminus &&
        colors.includes(k.color) &&
        Math.abs(k.depAbs - projected) <= MATCH_TOLERANCE_MIN,
    );
    if (hasTrip) continue;
    if (projected < mNow - GRACE_MIN || projected > mNow + DEPARTURES_WINDOW_MIN) continue;
    rows.push({
      line: null,
      terminus,
      depAbs: Math.round(projected),
      delay: undefined,
      fromFeed: true,
      colors: e.colors,
    });
  }

  // Nearest departure first — the board reads top-to-bottom as "what's next"
  rows.sort((a, b) => a.depAbs - b.depAbs);
  return rows;
}
