// Departure board for one station: the next trains due to leave it.
//
// Full board: rows come from the timetable (yesterday/today/tomorrow tables
// via search.js's collectTrips, shifted by observed real-time delays from
// realtime.js's buildDelays). Feed entries at the station with no timetable
// counterpart become "live" extra rows (unscheduled trains the printed
// timetable doesn't know about).
//
// Route-scoped board (optional `to`): only trains that can start a viable
// journey to `to` — the first legs of direct rides and of 1–2-transfer
// connections, using the same connection machinery as findJourneys
// (TRANSFER_MIN / MAX_TRANSFERS), bounded so the journey must complete
// within MAX_JOURNEY_MIN of the first departure (the scan spans three
// calendar-day tables; without the bound the next day's trains would pose
// as connections). Each row carries the earliest delay-adjusted arrival at
// `to` (arrAbs, transfer waits included) plus the reconstructed legs, so
// the UI can show the estimated arrival and the transfer path. Feed extras
// are kept only when their terminus is `to` itself (rideable, but no
// arrival estimate is possible).
//
// Pure ES module like search.js / realtime.js: no DOM access, explicit clock
// inputs, tested from Node (scripts/test-departures.mjs).

import { collectTrips, continuation, MAX_TRANSFERS, reconstruct, toLeg } from "./search.js";
import { buildDelays, FEED_TO_SCHED, MATCH_TOLERANCE_MIN } from "./realtime.js";

export const DEPARTURES_WINDOW_MIN = 45; // board horizon: departures within this window of "now"
export const MAX_JOURNEY_MIN = 120; // route-scoped cap: a connection must complete within this of its first departure
const GRACE_MIN = 5; // a departure this recently passed still shows (the train may be running late)

// Preference between two timetable rows departing the same adjusted minute:
// no live claim (pure timetable) beats any badge — a badge could be a mispair
// — then the smaller observed shift, then (scoped mode) the earlier
// estimated arrival
function rowBeatsRow(a, b) {
  const aClaim = a.delay === undefined ? 0 : 1;
  const bClaim = b.delay === undefined ? 0 : 1;
  if (aClaim !== bClaim) return aClaim < bClaim;
  if (aClaim) {
    const byShift = Math.abs(a.delay) - Math.abs(b.delay);
    if (byShift) return byShift < 0;
  }
  return (a.arrAbs ?? Infinity) < (b.arrAbs ?? Infinity);
}

// Return the board rows for `station`, sorted by nearest (delay-adjusted)
// departure first. Each row: { line, terminus, depAbs, delay, fromFeed, legs }
// — `line` is null and `fromFeed` true for feed-only extras (which also carry
// the feed's color list and have no legs — nothing to unfold), `delay` is
// undefined for timetable-only rows. Every timetable row carries `legs` with
// per-stop times: route-scoped rows the connection path (see the header
// note), all-trains rows the single remaining ride to the terminus. With
// `to`, rows are scoped to trains that connect there and also carry `arrAbs`.
// Timetable rows that land on the same adjusted departure minute (same line
// and terminus) collapse into one — see the dedupe block at the end.
export function findDepartures(schedule, station, mNow, nowMs = Date.now(), rt = null, to = null) {
  const delays = rt ? buildDelays(schedule, rt, mNow, nowMs) : null;

  // Delay-adjusted trips on the absolute timeline, spanning three calendar
  // days so pre-/post-midnight departures resolve to the right table — a
  // PATH table is per calendar day, so the train leaving just after midnight
  // belongs to yesterday's table and the one about to leave after the next
  // midnight to tomorrow's (same rationale as realtime.js's buildDelays)
  const today = new Date(nowMs);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const allTrips = [
    ...collectTrips(schedule, yesterday, -1440, delays),
    ...collectTrips(schedule, today, 0, delays),
    ...collectTrips(schedule, tomorrow, 1440, delays),
  ];

  const rows = [];
  // Every future departure at this station, delay-adjusted, without a window
  // limit: feed entries are matched against it to decide whether they belong
  // to a timetable train (even one beyond the board window) or are genuinely
  // unscheduled extras
  const known = []; // { depAbs, terminus, color }

  for (const trip of allTrips) {
    const s = trip.stops.indexOf(station);
    // The line's final stop is an arrival, not a departure — terminal
    // stations get their departures from the lines that start there
    if (s < 0 || s === trip.stops.length - 1) continue;
    const depAbs = trip.times[s];
    if (depAbs === null) continue;
    // A timetable time already well past is gone for good — unless the train
    // is running late enough that its adjusted time is still ahead, which
    // the adjusted depAbs above already reflects
    if (depAbs < mNow - GRACE_MIN) continue;
    const delay = delays?.get(trip.raw);
    const terminus = trip.stops[trip.stops.length - 1];
    known.push({ depAbs, terminus, color: trip.line.color.toUpperCase() });
    if (depAbs > mNow + DEPARTURES_WINDOW_MIN) continue;

    if (to) {
      // Scope to the current journey: keep the train only if a connection
      // (<= MAX_TRANSFERS, >= TRANSFER_MIN waits) reaches `to` after
      // boarding it within MAX_JOURNEY_MIN, and stamp the earliest arrival
      // plus the legs behind it
      const alights = new Map();
      for (let k = s + 1; k < trip.stops.length; k++) {
        if (trip.times[k] === null) continue;
        alights.set(trip.stops[k], {
          time: trip.times[k],
          pred: { trip, board: s, alight: k, first: true },
        });
      }
      const best = continuation(allTrips, alights, MAX_TRANSFERS);
      const arrival = best.get(to);
      if (!arrival) continue;
      // The scan spans three calendar-day tables, so without a bound a first
      // leg would "connect" to trains many hours out (e.g. only tomorrow's
      // shuttle) — cap the journey so a row is a connection worth boarding
      if (arrival.time > depAbs + MAX_JOURNEY_MIN) continue;
      const legs = reconstruct(best, station, to);
      if (!legs) continue;
      rows.push({
        line: trip.line,
        terminus,
        depAbs,
        delay,
        fromFeed: false,
        arrAbs: arrival.time,
        legs: legs.map((l) => toLeg(l, delays)),
      });
    } else {
      // All-trains row: no destination, so the "journey" is simply the ride
      // itself — a single leg spanning every stop from here to the terminus,
      // giving these cards the same stop-by-stop popup as scoped rows
      rows.push({
        line: trip.line,
        terminus,
        depAbs,
        delay,
        fromFeed: false,
        legs: [toLeg({ trip, board: s, alight: trip.stops.length - 1 }, delays)],
      });
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
    // Scoped board: an extra is only provably rideable toward `to` when it
    // ends there — the terminus is the only stop the feed reveals
    if (to && terminus !== to) continue;
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

  // Same-minute collisions: a delayed train (or a mispaired one) can depart
  // at the very minute a line-mate is scheduled to, and two indistinguishable
  // rows would render. Collapse timetable rows per (line, terminus, adjusted
  // departure minute), keeping the more plausible one (rowBeatsRow) — the
  // same per-minute rule the journey results apply. Feed extras pass through
  // untouched: by construction no timetable train matches them.
  const seenRows = new Map();
  const keptRows = [];
  for (const row of rows) {
    if (row.fromFeed) {
      keptRows.push(row);
      continue;
    }
    const key = `${row.line.color}|${row.terminus}|${row.depAbs}`;
    const prev = seenRows.get(key);
    if (!prev) {
      seenRows.set(key, row);
      keptRows.push(row);
    } else if (rowBeatsRow(row, prev)) {
      seenRows.set(key, row);
      keptRows[keptRows.indexOf(prev)] = row;
    }
  }
  rows.length = 0;
  rows.push(...keptRows);

  // Nearest departure first — the board reads top-to-bottom as "what's next"
  rows.sort((a, b) => a.depAbs - b.depAbs);
  return rows;
}
