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

// All trips of one calendar day, with stop times shifted to absolute minutes
function collectTrips(schedule, date, base) {
  const out = [];
  for (const line of schedule.days[dayKeyFor(date)] ?? []) {
    for (const trip of line.trips) {
      const mins = trip.map((t) => (t === null ? null : toMinutes(t)));
      const first = mins.find((t) => t !== null);
      const times = mins.map((t) => (t === null ? null : base + t + (t < first ? 1440 : 0)));
      out.push({ line, stops: line.stops, times, base });
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
export function findJourneys(schedule, from, to, enteredMinutes, mNow) {
  if (from === to) return [];
  const target = enteredMinutes < mNow ? enteredMinutes + 1440 : enteredMinutes;

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const allTrips = [...collectTrips(schedule, today, 0), ...collectTrips(schedule, tomorrow, 1440)];

  const seen = new Map(); // arrival minute -> journey (dedupe, keep the simplest)

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
      })),
      depAbs,
      arrAbs: arrival.time,
      departed,
    };

    // Multiple routings can land on the same arrival minute; keep the one
    // with the fewest legs (then the latest departure) so the three results
    // read as distinct, sleep-calculator-style alternatives
    const key = journey.arrAbs;
    const prev = seen.get(key);
    if (
      !prev ||
      journey.legs.length < prev.legs.length ||
      (journey.legs.length === prev.legs.length && journey.depAbs > prev.depAbs)
    ) {
      seen.set(key, journey);
    }
  }

  // Latest-arriving journeys first — the closest usable options to the target
  const result = [...seen.values()];
  result.sort(
    (a, b) => b.arrAbs - a.arrAbs || a.legs.length - b.legs.length || b.depAbs - a.depAbs,
  );
  return result.slice(0, 3);
}
