// Real-time delay layer over the parsed PATH timetable (data/schedule.json).
//
// The PANYNJ feed (proxied by api/realtime.js) reports, per station, the
// upcoming trains: terminus, line colors and a projected arrival. It has no
// trip IDs, so timetable trips are paired with feed entries heuristically:
// at a shared station, an entry whose terminus and colors fit the line and
// whose projected arrival is closest to the timetable time (within
// MATCH_TOLERANCE_MIN) is assumed to be that trip. The observed difference
// becomes the trip's delay and is applied to its whole run — a delay is
// assumed to hold along the entire trip, an approximation the README notes.
//
// Pure ES module like search.js: no DOM access, explicit clock inputs, so it
// can be tested directly from Node (scripts/test-realtime.mjs).

import { dayKeyFor } from "./search.js";

// Max |projected - timetable| to pair a trip with a feed entry. Generous on
// purpose: delays are the whole point, and the greedy global matching below
// (closest pairing claims first) keeps a large tolerance from mispairing two
// nearby trains as long as both have feed entries.
export const MATCH_TOLERANCE_MIN = 15;
export const RT_HORIZON_MIN = 45; // only stop times within this window of "now" are pairable
export const STALE_AFTER_MS = 120000; // older snapshots are ignored (timetable-only fallback)
const GRACE_MIN = 5; // a stop time this recently passed can still be paired (the train may be delayed)

// The feed names two stations differently than the timetable (shared with
// departures.js's board builder)
export const FEED_TO_SCHED = { GRV: "GRO", EXP: "EXC" };

// "HH:MM" -> minutes since midnight (same parsing as search.js)
function toMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10);
}

// Validate and slim a proxy snapshot (api/realtime.js shape). Returns null
// when the snapshot is unusable — too old or no parseable entries — so the
// caller falls back to pure timetable times.
export function normalizeRt(raw, nowMs) {
  if (!raw || typeof raw.fetchedAt !== "number" || nowMs - raw.fetchedAt > STALE_AFTER_MS) {
    return null;
  }
  const stations = {};
  for (const [feedCode, entries] of Object.entries(raw.stations ?? {})) {
    if (!Array.isArray(entries)) continue;
    const code = FEED_TO_SCHED[feedCode] ?? feedCode;
    const list = [];
    for (const e of entries) {
      const seconds = Number(e.secondsToArrival);
      if (!Number.isFinite(seconds) || seconds < 0) continue;
      // Projected arrival as an absolute timestamp: the feed counts from its
      // own lastUpdated, falling back to the proxy fetch time
      const base = Number.isFinite(e.lastUpdatedMs) ? e.lastUpdatedMs : raw.fetchedAt;
      list.push({
        target: e.target, // terminus station code (feed naming)
        // the feed may list combined services: "D93A30" or "4D92FB,FF9900"
        colors: String(e.lineColor ?? "")
          .split(",")
          .map((c) => c.trim().replace(/^#?/, "#")),
        projectedMs: base + seconds * 1000,
      });
    }
    if (list.length) stations[code] = list;
  }
  return Object.keys(stations).length > 0 ? { fetchedAt: raw.fetchedAt, stations } : null;
}

// Pair timetable trips with feed entries and return a Map from the trip
// array (by reference — the same arrays search.js keys on) to its observed
// delay in whole minutes. A matched on-time trip maps to 0; trips without a
// match are absent from the map. Returns null when there is no usable
// snapshot.
export function buildDelays(schedule, rt, mNow, nowMs = Date.now()) {
  if (!rt) return null;
  const midnightMs = nowMs - mNow * 60000; // start of "today" in the absolute-minute model
  const delays = new Map();

  // Trains currently running span three tables: yesterday's (base -1440),
  // today's (base 0) and tomorrow's (base 1440). PATH tables are per
  // calendar day, so the trains rolling just after midnight belong to
  // yesterday's table and the ones about to roll after the next midnight to
  // tomorrow's — even when the days share a dayKey and thus the same trip
  // arrays. The 50-minute pairing window below can only ever hold one base
  // of a given trip, so the three tables don't double-pair.
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

  // Pass 1: collect every plausible (trip, feed entry) pairing
  const candidates = []; // { trip, key, absDiff, delay }
  for (const { dayKey, base } of tables) {
    for (const line of schedule.days[dayKey] ?? []) {
      // Travel direction is encoded in the stop order, so the forward terminus
      // is simply the last stop
      const terminus = line.stops[line.stops.length - 1];
      const lineColor = line.color.toUpperCase();

      for (const trip of line.trips) {
        // Absolute minutes per stop, applying the same midnight shift as
        // search.js's collectTrips
        const mins = trip.map((t) => (t === null ? null : toMinutes(t)));
        const first = mins.find((t) => t !== null);
        if (first === undefined) continue;

        for (let s = 0; s < line.stops.length; s++) {
          const t = mins[s];
          if (t === null) continue;
          const abs = base + t + (t < first ? 1440 : 0);
          // The feed only lists the next ~30–45 min of trains, so only stop
          // times near "now" can be paired (a just-missed stop still counts:
          // the train may be running behind)
          if (abs < mNow - GRACE_MIN || abs > mNow + RT_HORIZON_MIN) continue;
          const entries = rt.stations[line.stops[s]];
          if (!entries) continue;
          for (let ei = 0; ei < entries.length; ei++) {
            const e = entries[ei];
            if ((FEED_TO_SCHED[e.target] ?? e.target) !== terminus) continue;
            // Colors disambiguate same-terminus lines (e.g. HOB–WTC vs
            // NWK–WTC, both listing "WTC" at Exchange Place); combined-service
            // entries list several colors, one of which must be this line's
            if (!e.colors.some((c) => c.toUpperCase() === lineColor)) continue;
            const projected = (e.projectedMs - midnightMs) / 60000;
            const diff = projected - abs;
            if (Math.abs(diff) > MATCH_TOLERANCE_MIN) continue;
            candidates.push({
              trip,
              key: `${line.stops[s]}|${ei}`,
              absDiff: Math.abs(diff),
              delay: Math.round(diff),
            });
          }
        }
      }
    }
  }

  // Pass 2: greedy global matching by confidence — the closest pairing
  // claims its trip and feed entry first, so one feed train can't inflate
  // two timetable trips and vice versa
  candidates.sort((a, b) => a.absDiff - b.absDiff);
  const usedEntries = new Set();
  const usedTrips = new Set();
  for (const c of candidates) {
    if (usedTrips.has(c.trip) || usedEntries.has(c.key)) continue;
    usedTrips.add(c.trip);
    usedEntries.add(c.key);
    delays.set(c.trip, c.delay); // 0 = matched and on time
  }
  return delays;
}
