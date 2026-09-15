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
function collectTrips(schedule, date, base, adjust) {
  const out = [];
  for (const line of schedule.days[dayKeyFor(date)] ?? []) {
    for (const trip of line.trips) {
      const mins = trip.map((t) => (t === null ? null : toMinutes(t)));
      const first = mins.find((t) => t !== null);
      let times = mins.map((t) => (t === null ? null : base + t + (t < first ? 1440 : 0)));
      const delay = adjust?.get(trip);
      if (delay) times = times.map((t) => (t === null ? null : t + delay));
      out.push({ line, stops: line.stops, times, base, raw: trip });
    }
  }
  return out;
}

// Relay-style relaxation: starting from `alights` (station -> arrival), find
// the earliest reachable time at every station using at most `budget` more
// legs. Each pass may only board trips using the previous pass's arrivals, so
// a path can never exceed the leg budget.
function continuation(allTrips, alights, budget) {
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

// Walk the predecessor chain from `to` back to the first leg's alighting node
function reconstruct(best, from, to) {
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

// Returns up to 3 journeys: the ones arriving at `to` latest while still no
// later than the entered time (interpreted as the next occurrence). First legs
// that already departed are included as "missed" context while the target is
// still today.
//
// `adjust` (optional, from realtime.js's buildDelays) shifts trips by their
// observed real-time delays before searching, so catchability, transfers and
// arrivals reflect reality; legs carry the applied `delay` (undefined =
// timetable-only, 0 = matched and on time).
export function findJourneys(schedule, from, to, enteredMinutes, mNow, adjust) {
  if (from === to) return [];
  const target = enteredMinutes < mNow ? enteredMinutes + 1440 : enteredMinutes;

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const allTrips = [
    ...collectTrips(schedule, today, 0, adjust),
    ...collectTrips(schedule, tomorrow, 1440, adjust),
  ];

  const seen = new Map(); // departure minute -> journey (dedupe, keep the simplest)

  for (const trip of allTrips) {
    const i = trip.stops.indexOf(from);
    if (i < 0) continue;
    const depAbs = trip.times[i];
    if (depAbs === null) continue;
    // A missed first leg is only shown as context while the target is today
    const departed = trip.base === 0 && depAbs < mNow - GRACE;
    if (departed && target > 1440) continue;

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

    const legs = reconstruct(best, from, to);
    if (!legs) continue;

    const journey = {
      legs: legs.map(({ trip: t, board, alight }) => ({
        line: t.line,
        board: { stop: t.stops[board], time: t.times[board] },
        alight: { stop: t.stops[alight], time: t.times[alight] },
        // observed real-time delay of this leg's trip (undefined = no match)
        delay: adjust?.get(t.raw),
      })),
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
