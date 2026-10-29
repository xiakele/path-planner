// Real-time delay layer over the parsed PATH timetable (data/schedule.json).
//
// The PANYNJ feed (proxied by api/realtime.js) reports, per station, the
// upcoming trains: terminus, line colors and a projected arrival. It has no
// trip IDs. At each station we maximize the number of compatible matches,
// then minimize their total absolute timestamp offset. Each matched stop
// keeps its own prediction; missing stops interpolate/extrapolate estimates.
// Two guards keep mispairs out of the results: duplicate listings of one
// train collapse before pairing (DUPLICATE_ENTRY_MIN), and a pairing that
// would make a trip leave earlier than ~3 minutes (MAX_EARLY_MIN) is
// rejected outright — trains don't meaningfully run early.
//
// Pure ES module like search.js: no DOM access, explicit clock inputs, so it
// can be tested directly from Node (scripts/test-realtime.mjs).

import { collectTrips } from "./search.js";
import { minimumCostMatching } from "./matching.js";

// Max |projected - timetable| to pair a trip with a feed entry. Generous on
// purpose: delays are the whole point. The assignment minimizes total absolute
// offset across all compatible trains at a station, rather than claiming the
// closest individual pair first. Without train IDs it remains a heuristic.
export const MATCH_TOLERANCE_MIN = 15;
// A train never meaningfully runs early — the PANYNJ timetable note allows
// ~3 minutes. A pairing on the early side beyond this is a misread (most
// often a leftover duplicate feed listing posing as the next trip), not
// reality, so it is rejected outright instead of becoming a phantom
// "N min early" delay.
export const MAX_EARLY_MIN = 3;
// Feed entries this close at one station with the same terminus and a
// shared line color are the same physical train listed twice (the feed
// occasionally splits one train into several listings). The copies collapse
// before pairing — a leftover would otherwise be free to pair with a
// neighboring timetable trip as a phantom "early"/"late" train.
export const DUPLICATE_ENTRY_MIN = 2;
export const RT_HORIZON_MIN = 45; // only stop times within this window of "now" are pairable
export const STALE_AFTER_MS = 120000; // older snapshots are ignored (timetable-only fallback)
const GRACE_MIN = 5; // a stop time this recently passed can still be paired (the train may be delayed)

// The feed names two stations differently than the timetable (shared with
// departures.js's board builder)
export const FEED_TO_SCHED = { GRV: "GRO", EXP: "EXC" };

// Collapse duplicate listings of one physical train at a station: same
// terminus, a shared line color and a projected arrival within
// DUPLICATE_ENTRY_MIN of an already-kept entry (see the constant's note). A
// shared color is required so two genuinely distinct lines toward the same
// terminus (e.g. the two WTC services at Exchange Place) never merge.
function collapseDuplicateEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.projectedMs - b.projectedMs);
  const kept = [];
  for (const e of sorted) {
    const dup = kept.some(
      (k) =>
        k.target === e.target &&
        Math.abs(k.projectedMs - e.projectedMs) <= DUPLICATE_ENTRY_MIN * 60000 &&
        k.colors.some((c) => e.colors.some((d) => c.toUpperCase() === d.toUpperCase())),
    );
    if (!dup) kept.push(e);
  }
  return kept;
}

// Validate and slim a proxy snapshot (api/realtime.js shape): parse the
// entries, then collapse duplicate listings of the same physical train (see
// collapseDuplicateEntries). Returns null when the snapshot is unusable —
// too old or no parseable entries — so the caller falls back to pure
// timetable times.
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
        updatedMs: base, // resolve inconsistent stop predictions using source age
      });
    }
    if (list.length) stations[code] = collapseDuplicateEntries(list);
  }
  return Object.keys(stations).length > 0 ? { fetchedAt: raw.fetchedAt, stations } : null;
}

// Retain a monotone set of anchors, considering newer source observations
// first, then smaller offsets and earlier stop indices. Rejected observations
// remain assigned to this train (not invented as feed-only extra trains).
function stopPredictions(times, observations) {
  const anchors = [];
  const ranked = [...observations].sort(
    (a, b) =>
      b.updatedMs - a.updatedMs || Math.abs(a.delay) - Math.abs(b.delay) || a.index - b.index,
  );
  for (const anchor of ranked) {
    if (
      anchors.every((other) =>
        other.index < anchor.index ? other.time <= anchor.time : anchor.time <= other.time,
      )
    ) {
      anchors.push(anchor);
    }
  }
  anchors.sort((a, b) => a.index - b.index);
  return times.map((scheduledTime, index) => {
    if (scheduledTime === null) return null;
    const direct = anchors.find((a) => a.index === index);
    if (direct) return { time: direct.time, delay: direct.delay, source: "live" };
    const before = anchors.findLast((a) => a.index < index);
    const after = anchors.find((a) => a.index > index);
    let delay;
    if (before && after) {
      const span = times[after.index] - times[before.index];
      const fraction = span ? (scheduledTime - times[before.index]) / span : 0;
      delay = before.delay + fraction * (after.delay - before.delay);
    } else {
      delay = (before ?? after).delay;
    }
    return { time: scheduledTime + delay, delay, source: "estimated" };
  });
}

// One model shared by search and the board. `trips` is keyed by raw trip
// reference, then calendar-day base, then stop index: yesterday/tomorrow
// copies of a weekday trip must not inherit today's predictions.
// `matchedEntries` records assignments at every station, independently of
// whether that station's anchor survives the cross-stop consistency check.
export function buildRealtimeModel(schedule, rt, mNow, nowMs = Date.now()) {
  if (!rt || nowMs - rt.fetchedAt > STALE_AFTER_MS) return null;
  const midnightMs = nowMs - mNow * 60000;
  const byStation = new Map();
  const occurrences = [];
  for (const base of [-1440, 0, 1440]) {
    const date = new Date(nowMs);
    date.setDate(date.getDate() + base / 1440);
    for (const trip of collectTrips(schedule, date, base)) {
      const occurrence = { ...trip, base, observations: [] };
      occurrences.push(occurrence);
      trip.times.forEach((time, index) => {
        if (time === null || time < mNow - GRACE_MIN || time > mNow + RT_HORIZON_MIN) return;
        const station = trip.stops[index];
        if (!rt.stations[station]) return;
        if (!byStation.has(station)) byStation.set(station, []);
        byStation.get(station).push({ occurrence, index, time });
      });
    }
  }

  const matchedEntries = new Map();
  for (const [station, stops] of byStation) {
    stops.sort((a, b) => a.time - b.time);
    const entries = rt.stations[station]; // normalizeRt already sorts by projected arrival
    const candidates = [];
    stops.forEach(({ occurrence, time }, left) => {
      const terminus = occurrence.stops.at(-1);
      const color = occurrence.line.color.toUpperCase();
      entries.forEach((entry, right) => {
        if ((FEED_TO_SCHED[entry.target] ?? entry.target) !== terminus) return;
        if (!entry.colors.some((c) => c.toUpperCase() === color)) return;
        const offsetMs = entry.projectedMs - (midnightMs + time * 60000);
        if (offsetMs < -MAX_EARLY_MIN * 60000 || offsetMs > MATCH_TOLERANCE_MIN * 60000) return;
        candidates.push({ left, right, cost: Math.abs(offsetMs), tieCost: (left - right) ** 2 });
      });
    });
    const assigned = new Set();
    for (const { left, right } of minimumCostMatching(stops.length, entries.length, candidates)) {
      const { occurrence, index, time } = stops[left];
      const entry = entries[right];
      const projected = (entry.projectedMs - midnightMs) / 60000;
      occurrence.observations.push({
        index,
        time: projected,
        delay: projected - time,
        updatedMs: entry.updatedMs ?? rt.fetchedAt,
      });
      assigned.add(entry);
    }
    matchedEntries.set(station, assigned);
  }

  const trips = new Map();
  for (const { raw, base, times, observations } of occurrences) {
    if (!observations.length) continue;
    if (!trips.has(raw)) trips.set(raw, new Map());
    trips.get(raw).set(base, stopPredictions(times, observations));
  }
  return { trips, matchedEntries };
}
