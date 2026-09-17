// Journey search over the parsed PATH timetable (data/schedule.json).
//
// A journey is a chain of up to MAX_TRANSFERS + 1 legs, each leg being a ride
// on one scheduled trip between two of its stops. Every journey is attributed
// to a specific first train (the one boarded at the origin), which is what the
// UI shows as "the train to catch".
//
// Absolute time model (minutes from today's midnight):
//   - today's table at base 0, tomorrow's table at base 1440 (a PATH table is
//     per calendar day, so Saturday 00:10 runs Friday night);
//   - a trip whose arrival is earlier on the clock than its departure crosses
//     midnight and shifts forward once.

export const TRANSFER_MIN = 3; // minimum minutes to change trains
export const MAX_TRANSFERS = 2; // maximum number of transfers in a journey
const GRACE = 1; // minutes: a trip this close to "now" still counts as catchable
const CONTEXT_MAX_MIN = 180; // how long after its arrival a missed journey stays useful context

export function dayKeyFor(date) {
  const dow = date.getDay();
  if (dow === 6) return "saturday";
  if (dow === 0) return "sunday";
  return "weekday";
}

function toMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10);
}

// All trips of one calendar day, with stop times shifted to absolute minutes.
// `adjust` (from realtime.js's buildDelays, keyed by the raw trip arrays)
// optionally shifts a trip's whole run by its observed real-time delay.
// Exported for departures.js's board, which reuses the same trip model.
export function collectTrips(schedule, date, base, adjust) {
  const out = [];
  for (const line of schedule.days[dayKeyFor(date)] ?? []) {
    for (const trip of line.trips) {
      const mins = trip.map((t) => (t === null ? null : toMinutes(t)));
      const first = mins.find((t) => t !== null);
      let times = mins.map((t) => (t === null ? null : base + t + (t < first ? 1440 : 0)));
      const delay = adjust?.get(trip);
      if (delay) times = times.map((t) => (t === null ? null : t + delay));
      out.push({ line, stops: line.stops, times, raw: trip });
    }
  }
  return out;
}

// Relay-style relaxation: starting from `alights` (station -> arrival), find
// the earliest reachable time at every station using at most `budget` more
// legs. Each pass may only board trips using the previous pass's arrivals, so
// a path can never exceed the leg budget. Exported for departures.js's
// route-scoped board, which asks the same reachability question.
export function continuation(allTrips, alights, budget) {
  const best = new Map(); // station -> { time, pred: {trip, board, alight} | chain node }
  for (const [station, node] of alights) best.set(station, node);

  for (let pass = 0; pass < budget; pass++) {
    // Boarding decisions use a snapshot, so a station reached in this pass
    // can only be departed from in the next one
    const snap = new Map(best);
    for (const trip of allTrips) {
      const { stops, times } = trip;
      // Board at the first stop we can already have reached in time; that
      // boarding dominates any later one on the same trip
      let board = -1;
      for (let b = 0; b < stops.length; b++) {
        if (times[b] === null) continue;
        const reached = snap.get(stops[b]);
        if (reached !== undefined && reached.time + TRANSFER_MIN <= times[b]) {
          board = b;
          break;
        }
      }
      if (board === -1) continue;
      for (let s = board + 1; s < stops.length; s++) {
        if (times[s] === null) continue;
        const station = stops[s];
        const cur = best.get(station);
        if (cur === undefined || times[s] < cur.time) {
          best.set(station, { time: times[s], pred: { trip, board, alight: s, first: false } });
        }
      }
    }
  }
  return best;
}

// One reconstructed leg ({trip, board, alight}) in the shape the UI uses:
// line identity, endpoints, the trip's observed real-time delay (undefined =
// no live match) and every stop the train actually calls at between boarding
// and alighting, each with its (delay-adjusted) time — the fuel for the
// stop-by-stop popup. Stops with a null time (stations this trip skips) are
// omitted. Exported for departures.js, which builds the same legs for its
// route-scoped board.
export function toLeg({ trip: t, board, alight }, adjust) {
  const stops = [];
  for (let k = board; k <= alight; k++) {
    if (t.times[k] === null) continue;
    stops.push({ stop: t.stops[k], time: t.times[k] });
  }
  return {
    line: t.line,
    board: { stop: t.stops[board], time: t.times[board] },
    alight: { stop: t.stops[alight], time: t.times[alight] },
    delay: adjust?.get(t.raw),
    stops,
  };
}

// Walk the predecessor chain from `to` back to the first leg's alighting
// node. Exported for departures.js's route-scoped board (same chain walk).
export function reconstruct(best, from, to) {
  const legs = [];
  let station = to;
  for (;;) {
    const node = best.get(station)?.pred;
    if (!node || legs.length > MAX_TRANSFERS + 1) return null;
    legs.unshift({ trip: node.trip, board: node.board, alight: node.alight });
    if (node.first) break;
    station = node.trip.stops[node.board];
    if (station === from) return null; // chained back to the origin mid-journey
  }
  return legs;
}

// A journey loops when a ride after the first calls again at the origin
// (e.g. 9 St -> 14 St, then the JSQ-bound train back through 9 St): the
// rider returns to their starting station mid-journey. Whenever that
// happens, boarding the same returning train at the origin directly is an
// equal alternative — found independently by the per-first-trip search —
// so looping continuations are dropped. Only stops the train actually
// calls at count: one passing a closed origin without stopping (overnight
// 9 St / 23 St) can be a legitimate, even the only, way out. Exported for
// departures.js's route-scoped board, which prunes the same shape.
export function loopsThroughOrigin(legs, origin) {
  // The first leg boards at the origin by construction and a line's stops
  // are unique, so only later rides can return to it
  for (let li = 1; li < legs.length; li++) {
    const { trip: t, board, alight } = legs[li];
    for (let k = board; k <= alight; k++) {
      if (t.times[k] !== null && t.stops[k] === origin) return true;
    }
  }
  return false;
}

// Returns up to 3 journeys: the ones arriving at `to` latest while still no
// later than the entered time (interpreted as the next occurrence). First
// legs that already departed are always included as dimmed "missed" context;
// with enough catchable options the latest-departure-first ranking keeps
// them out of the top 3, so they surface only when you've missed the last
// connection (typically around midnight, when the deadline rolls to the
// next day but the trains that would have made it are already gone).
// Journeys also never call again at the origin — looping continuations are
// pruned (see loopsThroughOrigin).
//
// `adjust` (optional, from realtime.js's buildDelays) shifts trips by their
// observed real-time delays before searching, so catchability, transfers and
// arrivals reflect reality; legs carry the applied `delay` (undefined =
// timetable-only, 0 = matched and on time) plus their per-stop times
// (see toLeg) for the stop-by-stop popup.
export function findJourneys(schedule, from, to, enteredMinutes, mNow, adjust) {
  if (from === to) return [];
  const target = enteredMinutes < mNow ? enteredMinutes + 1440 : enteredMinutes;

  // Yesterday's table is collected too (at base -1440) so that just after
  // midnight the before-midnight trains can still appear as missed context —
  // a PATH table is per calendar day, so those trips belong to yesterday
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const allTrips = [
    ...collectTrips(schedule, yesterday, -1440, adjust),
    ...collectTrips(schedule, today, 0, adjust),
    ...collectTrips(schedule, tomorrow, 1440, adjust),
  ];

  const seen = new Map(); // departure minute -> journey (dedupe, keep the simplest)

  for (const trip of allTrips) {
    const i = trip.stops.indexOf(from);
    if (i < 0) continue;
    const depAbs = trip.times[i];
    if (depAbs === null) continue;
    // A missed first leg is context, not a suggestion. Base-independent:
    // tomorrow's trips all depart at >= 1440 > mNow, so only yesterday's and
    // today's can ever read as departed.
    const departed = depAbs < mNow - GRACE;

    // Every stop after the origin is a potential alighting point, including
    // the destination itself (plain direct rides fall out of the same path)
    const alights = new Map();
    for (let k = i + 1; k < trip.stops.length; k++) {
      if (trip.times[k] === null) continue;
      alights.set(trip.stops[k], {
        time: trip.times[k],
        pred: { trip, board: i, alight: k, first: true },
      });
    }

    const best = continuation(allTrips, alights, MAX_TRANSFERS);
    const arrival = best.get(to);
    if (!arrival || arrival.time > target) continue;
    // Context that completed long ago (yesterday evening's leftovers) is
    // noise, not help — only keep journeys that arrived within the last
    // CONTEXT_MAX_MIN (catchable ones always arrive in the future, so this
    // only prunes missed context)
    if (arrival.time < mNow - CONTEXT_MAX_MIN) continue;

    const legs = reconstruct(best, from, to);
    if (!legs) continue;
    // A continuation that rides away and back through the origin is a loop:
    // the returning train boards at the origin directly and surfaces as its
    // own journey, so the looping one is dropped
    if (loopsThroughOrigin(legs, from)) continue;

    const journey = {
      legs: legs.map((l) => toLeg(l, adjust)),
      depAbs,
      arrAbs: arrival.time,
      departed,
    };

    // Different first trains can produce the same routing; per departure
    // minute keep the journey with the fewest legs (then the earliest
    // arrival) so the results read as distinct alternatives
    const key = journey.depAbs;
    const prev = seen.get(key);
    if (
      !prev ||
      journey.legs.length < prev.legs.length ||
      (journey.legs.length === prev.legs.length && journey.arrAbs < prev.arrAbs)
    ) {
      seen.set(key, journey);
    }
  }

  // Drop journeys dominated by another one (a departure that is later or
  // equal, arriving earlier or equal, with no more legs — i.e. strictly
  // better on some axis and worse on none); dominated options only waste a
  // backup slot
  const all = [...seen.values()];
  const result = all.filter((a) => {
    return !all.some(
      (b) =>
        b !== a &&
        b.depAbs >= a.depAbs &&
        b.arrAbs <= a.arrAbs &&
        b.legs.length <= a.legs.length &&
        (b.depAbs > a.depAbs || b.arrAbs < a.arrAbs || b.legs.length < a.legs.length),
    );
  });

  // Latest catchable departure first — "which train should I catch" reads
  // naturally, and on ties prefer the faster journey (earlier arrival, then
  // fewer legs)
  result.sort(
    (a, b) => b.depAbs - a.depAbs || a.arrAbs - b.arrAbs || a.legs.length - b.legs.length,
  );
  return result.slice(0, 3);
}
