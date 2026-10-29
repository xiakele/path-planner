// Node harness for src/realtime.js and its integration with src/search.js.
// No test framework in this repo — plain assertions, run with
// `pnpm test:realtime`. All clocks are injected (fixed mNow / nowMs), so
// results are reproducible regardless of when the harness runs.
//
// The clock is fixed and shared with search; synthetic schedules fill all
// day types so midnight tests can reuse the same train arrays across days.

import {
  buildRealtimeModel,
  normalizeRt,
  MATCH_TOLERANCE_MIN,
  MAX_EARLY_MIN,
  DUPLICATE_ENTRY_MIN,
  RT_HORIZON_MIN,
  STALE_AFTER_MS,
} from "../src/realtime.js";
import { collectTrips, findJourneys, toLeg } from "../src/search.js";
import { minimumCostMatching } from "../src/matching.js";

let failures = 0;
let checks = 0;

function check(name, cond) {
  checks++;
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

// Fixed clock: "now" is 10:00 AM in the absolute-minute model
const M_NOW = 600;
const NOW_MS = new Date(2026, 9, 28, 10, 0).getTime();
const MIDNIGHT_MS = NOW_MS - M_NOW * 60000;

// Absolute minutes -> a projected feed timestamp consistent with the clock
function at(absMin) {
  return MIDNIGHT_MS + absMin * 60000;
}

// Inspect an occurrence explicitly: a raw weekday trip can exist on several
// calendar days, but only one occurrence may inherit these predictions.
function delayOf(model, trip, base = 0, index = 0) {
  return model?.trips.get(trip)?.get(base)?.[index]?.delay;
}

// A feed entry at a station (timetable code) for a train toward `target`
function entry(target, colors, projectedAbsMin, opts = {}) {
  return {
    target,
    secondsToArrival: String(Math.round((at(projectedAbsMin) - NOW_MS) / 1000)),
    lineColor: colors,
    headSign: opts.headSign ?? "",
    // lastUpdated "now" so projected = lastUpdated + secondsToArrival
    lastUpdatedMs: NOW_MS,
  };
}

function mkLine(name, color, stops, trips) {
  return { name, color, stops, trips };
}

// Synthetic lines modeled on the real timetable: two same-terminus lines via
// Exchange Place (color disambiguation) and a JSQ–33 St line
function mkSchedule() {
  const lines = [
    // HOB 595, NEW 601, EXC 606, WTC 610
    mkLine(
      "Hoboken - World Trade Center",
      "#65C100",
      ["HOB", "NEW", "EXC", "WTC"],
      [
        ["09:55", "10:01", "10:06", "10:10"],
        ["10:25", "10:31", "10:36", "10:40"],
      ],
    ),
    // NWK 590, HAR 594, JSQ 599, GRO 603, EXC 607, WTC 611
    mkLine(
      "Newark - World Trade Center",
      "#D93A30",
      ["NWK", "HAR", "JSQ", "GRO", "EXC", "WTC"],
      [["09:50", "09:54", "09:59", "10:03", "10:07", "10:11"]],
    ),
    // JSQ 598, GRO 602, NEW 607, CHR 612, ... 33S 623
    mkLine(
      "Journal Square - 33 Street",
      "#FF9900",
      ["JSQ", "GRO", "NEW", "CHR", "09S", "14S", "23S", "33S"],
      [["09:58", "10:02", "10:07", "10:12", "10:15", "10:17", "10:19", "10:23"]],
    ),
    // Overnight run crossing midnight (23:50 -> 00:05)
    mkLine(
      "Hoboken - World Trade Center (night)",
      "#65C100",
      ["HOB", "NEW", "EXC", "WTC"],
      [["23:50", "23:56", "00:01", "00:05"]],
    ),
  ];
  return {
    generatedAt: new Date(NOW_MS).toISOString(),
    source: "fixture",
    days: { weekday: lines, saturday: lines, sunday: lines },
  };
}

console.log("normalizeRt");
{
  const raw = {
    fetchedAt: NOW_MS - 5000,
    stations: {
      // feed naming GRV/EXP must map to timetable GRO/EXC
      GRV: [entry("WTC", "D93A30", 610)],
      EXP: [
        {
          target: "WTC",
          secondsToArrival: "not-a-number",
          lineColor: "65C100",
          headSign: "",
          lastUpdatedMs: NOW_MS,
        },
      ],
      JSQ: [entry("33S", "4D92FB,FF9900", 608)],
    },
  };
  const rt = normalizeRt(raw, NOW_MS);
  check("maps feed station codes to timetable codes", rt.stations.GRO && rt.stations.JSQ);
  check("drops entries with unparseable secondsToArrival", !rt.stations.EXC);
  check(
    "expands combined-service color lists",
    rt.stations.JSQ[0].colors.join(",") === "#4D92FB,#FF9900",
  );
  check(
    "computes the projected arrival timestamp",
    Math.abs(rt.stations.GRO[0].projectedMs - at(610)) < 1000,
  );

  check(
    "returns null for a stale snapshot",
    normalizeRt({ ...raw, fetchedAt: NOW_MS - STALE_AFTER_MS - 1 }, NOW_MS) === null,
  );
  check("returns null for a malformed snapshot", normalizeRt(null, NOW_MS) === null);
  check(
    "returns null when no entries survive",
    normalizeRt({ fetchedAt: NOW_MS, stations: {} }, NOW_MS) === null,
  );
}

console.log("buildRealtimeModel");
const schedule = mkSchedule();
const hobWtc = schedule.days.weekday[0];
const nwkWtc = schedule.days.weekday[1];
const jsq33 = schedule.days.weekday[2];
{
  // Same station (EXC), same terminus (WTC): green +4, red on time — colors
  // must disambiguate the two lines; the JSQ combined-service entry pairs
  // the orange line, the GRO entry is beyond tolerance
  const rt = normalizeRt(
    {
      fetchedAt: NOW_MS,
      stations: {
        EXP: [entry("WTC", "65C100", 610), entry("WTC", "D93A30", 607)],
        JSQ: [entry("33S", "4D92FB,FF9900", 603)], // vs timetable 598 -> +5
        GRO: [entry("33S", "FF9900", 622)], // vs timetable 602 -> +20, beyond tolerance
      },
    },
    NOW_MS,
  );
  check(
    "returns null without a snapshot",
    buildRealtimeModel(schedule, null, M_NOW, NOW_MS) === null,
  );
  const delays = buildRealtimeModel(schedule, rt, M_NOW, NOW_MS);
  check(
    "green HOB–WTC trip picks up the green entry's +4 delay",
    delayOf(delays, hobWtc.trips[0]) === 4,
  );
  check(
    "red NWK–WTC trip pairs with the red entry (on time -> 0)",
    delayOf(delays, nwkWtc.trips[0]) === 0,
  );
  check(
    "orange JSQ–33S pairs via a combined-service color list",
    delayOf(delays, jsq33.trips[0]) === 5,
  );
}
{
  // Tolerance: an entry 20 min off the timetable time must not pair
  check("tolerance constant is below 20", MATCH_TOLERANCE_MIN < 20);
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { NEW: [entry("WTC", "65C100", 621)] } }, // vs timetable 601
    NOW_MS,
  );
  const delays = buildRealtimeModel(schedule, rt, M_NOW, NOW_MS);
  check("no pairing beyond the tolerance", !delays.trips.has(hobWtc.trips[0]));
}
{
  // Horizon: a trip departing beyond RT_HORIZON_MIN must not be adjusted
  const far = mkSchedule();
  far.days.weekday[0].trips = [["10:55", "11:01", "11:06", "11:10"]]; // NEW 661
  check("horizon constant is below 61", RT_HORIZON_MIN < 61);
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { NEW: [entry("WTC", "65C100", 656)] } },
    NOW_MS,
  );
  const delays = buildRealtimeModel(far, rt, M_NOW, NOW_MS);
  check("no pairing beyond the horizon", !delays.trips.has(far.days.weekday[0].trips[0]));
}
{
  // One feed entry must not be claimed by two trips: the nearer timetable
  // trip wins, the other keeps timetable times
  const dup = mkSchedule();
  dup.days.weekday[0].trips = [
    ["09:55", "10:01", "10:06", "10:10"], // NEW 601
    ["09:57", "10:03", "10:08", "10:12"], // NEW 603
  ];
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { NEW: [entry("WTC", "65C100", 604)] } },
    NOW_MS,
  );
  const delays = buildRealtimeModel(dup, rt, M_NOW, NOW_MS);
  check("nearer trip claims the entry", delayOf(delays, dup.days.weekday[0].trips[1]) === 1);
  check("other trip stays unpaired", !delays.trips.has(dup.days.weekday[0].trips[0]));
}

console.log("no-early clamp");
{
  // Trains never meaningfully run early (PANYNJ allows ~3 min): a pairing on
  // the early side beyond MAX_EARLY_MIN is a misread — typically a leftover
  // duplicate listing posing as the next trip — and must not become a
  // phantom "N min early" delay
  check("early clamp constant is at most 3", MAX_EARLY_MIN <= 3);
  const early = mkSchedule();
  early.days.weekday[0].trips = [["10:04", "10:10", "10:15", "10:19"]]; // NEW 610
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { NEW: [entry("WTC", "65C100", 600)] } }, // 10 min "early"
    NOW_MS,
  );
  const delays = buildRealtimeModel(early, rt, M_NOW, NOW_MS);
  check(
    "no pairing on the early side beyond the clamp",
    !delays.trips.has(early.days.weekday[0].trips[0]),
  );
  // A couple of minutes early is plausible and still pairs
  const rt2 = normalizeRt(
    { fetchedAt: NOW_MS, stations: { NEW: [entry("WTC", "65C100", 608)] } }, // 2 min early
    NOW_MS,
  );
  const delays2 = buildRealtimeModel(early, rt2, M_NOW, NOW_MS);
  check(
    "slightly early pairings survive the clamp",
    delayOf(delays2, early.days.weekday[0].trips[0]) === -2,
  );
}

console.log("duplicate feed listings collapse");
{
  // The same physical train listed twice at one station (same terminus, a
  // shared color, within DUPLICATE_ENTRY_MIN) collapses in normalizeRt —
  // otherwise the leftover copy pairs with the neighboring timetable trip
  // and poses as a phantom train
  check("duplicate window constant is at most 2", DUPLICATE_ENTRY_MIN <= 2);
  const raw = {
    fetchedAt: NOW_MS,
    stations: { NEW: [entry("WTC", "65C100", 612), entry("WTC", "#65C100", 613)] },
  };
  const rt = normalizeRt(raw, NOW_MS);
  check("duplicate listings collapse to one entry", rt.stations.NEW.length === 1);

  // Two genuinely distinct lines toward the same terminus share no color
  // and must never merge (green HOB–WTC and red NWK–WTC both call at EXC)
  const raw2 = {
    fetchedAt: NOW_MS,
    stations: { EXP: [entry("WTC", "65C100", 610), entry("WTC", "D93A30", 610)] },
  };
  const rt2 = normalizeRt(raw2, NOW_MS);
  check("distinct same-terminus lines stay separate", rt2.stations.EXC.length === 2);

  // End to end: with the copies collapsed, the green trip timetabled at
  // 10:01 must stay unpaired instead of claiming the leftover (+11 phantom
  // "late"); only the 10:11 trip — the entry's real owner — pairs
  const pair = mkSchedule();
  pair.days.weekday[0].trips = [
    ["09:55", "10:01", "10:06", "10:10"], // NEW 601
    ["10:05", "10:11", "10:16", "10:20"], // NEW 611
  ];
  const delays = buildRealtimeModel(pair, rt, M_NOW, NOW_MS);
  check(
    "the earlier trip does not claim the leftover copy",
    !delays.trips.has(pair.days.weekday[0].trips[0]),
  );
  check("the entry's owner still pairs", delayOf(delays, pair.days.weekday[0].trips[1]) === 1);
}

console.log("findJourneys + real-time adjustments");
{
  // A train that left Newport 9 min ago but is running 15 min late (observed
  // at Exchange Place, still ahead) becomes catchable again, with the delay
  // surfaced on the leg
  const late = mkSchedule();
  late.days.weekday[0].trips = [["09:50", "09:51", "09:56", "10:00"]]; // NEW 591, EXC 596, WTC 600
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { EXP: [entry("WTC", "65C100", 611)] } }, // vs EXC 596 -> +15
    NOW_MS,
  );
  const adjust = buildRealtimeModel(late, rt, M_NOW, NOW_MS);

  const scheduled = findJourneys(late, "NEW", "WTC", 630, M_NOW, null, NOW_MS);
  check(
    "without delays the train reads as departed",
    scheduled.length === 1 && scheduled[0].departed === true,
  );
  check("unadjusted stops carry no delay", scheduled[0].legs[0].board.delay === undefined);

  const adjusted = findJourneys(late, "NEW", "WTC", 630, M_NOW, adjust, NOW_MS);
  check("delayed train becomes catchable", adjusted.length === 1 && adjusted[0].departed === false);
  check(
    "journey times shift by the delay",
    adjusted[0].depAbs === 606 && adjusted[0].arrAbs === 615,
  );
  check(
    "boarding reports the estimated delay",
    adjusted[0].legs[0].board.delay === 15 && adjusted[0].legs[0].board.source === "estimated",
  );

  // Arrival past the entered target: the delay can also price a journey out
  const tight = findJourneys(late, "NEW", "WTC", 605, M_NOW, adjust, NOW_MS);
  check("delayed arrival beyond the target is excluded", tight.length === 0);
}
{
  // Overnight trip (23:50 -> 00:05) crossing midnight picks up its delay on
  // the absolute timeline
  const night = mkSchedule();
  const nightLine = night.days.weekday[3];
  const nightNow = 1432; // 23:52
  const nightMidnight = NOW_MS - nightNow * 60000;
  const nightEntry = {
    target: "WTC",
    secondsToArrival: String(Math.round((nightMidnight + 1442 * 60000 - NOW_MS) / 1000)),
    lineColor: "65C100",
    headSign: "",
    lastUpdatedMs: NOW_MS,
  };
  const rt = normalizeRt({ fetchedAt: NOW_MS, stations: { NEW: [nightEntry] } }, NOW_MS);
  const adjust = buildRealtimeModel(night, rt, nightNow, NOW_MS);
  check("overnight trip is matched across midnight", delayOf(adjust, nightLine.trips[0]) === 6); // 1436 -> 1442

  const j = findJourneys(night, "NEW", "WTC", 1455, nightNow, adjust, NOW_MS);
  check("overnight journey shifted by its delay", j.length === 1 && j[0].arrAbs === 1445 + 6);
}
{
  // Just before midnight the running trains belong to tomorrow's table
  // (base 1440), even when both days share a dayKey and thus the same trip
  // arrays — the base-0 reading of a 00:13 stop time is "this morning" and
  // must not be paired
  const am = mkSchedule();
  const line = am.days.weekday[0];
  line.trips = [["00:07", "00:13", "00:18", "00:22"]]; // NEW 00:13
  const mNowAM = 1438; // 23:58
  const amMidnight = NOW_MS - mNowAM * 60000;
  const amEntry = {
    target: "WTC",
    secondsToArrival: String(Math.round((amMidnight + 1453 * 60000 - NOW_MS) / 1000)), // 00:13, on time
    lineColor: "65C100",
    headSign: "",
    lastUpdatedMs: NOW_MS,
  };
  const rt = normalizeRt({ fetchedAt: NOW_MS, stations: { NEW: [amEntry] } }, NOW_MS);
  const adjust = buildRealtimeModel(am, rt, mNowAM, NOW_MS);
  check(
    "post-midnight trip matched via tomorrow's table",
    delayOf(adjust, line.trips[0], 1440) === 0,
  );
  check(
    "tomorrow's prediction does not leak into today's copy",
    delayOf(adjust, line.trips[0]) === undefined,
  );

  const j = findJourneys(am, "NEW", "WTC", 1465, mNowAM, adjust, NOW_MS);
  // The catchable 00:13 train plus, as dimmed context, the overnight train
  // that left NEW at 23:56 and also arrives by the deadline
  check(
    "post-midnight journey carries the live pairing",
    j.length === 2 &&
      j[0].depAbs === 1453 &&
      !j[0].departed &&
      j[0].legs[0].board.delay === 0 &&
      j[1].depAbs === 1436 &&
      j[1].departed,
  );
}
{
  // Just AFTER midnight the still-running overnight train belongs to
  // yesterday's table (base -1440): its mid-run stops (EXC 00:01 = abs 1)
  // must still pair with feed entries projected in the early-morning window
  const am2 = mkSchedule();
  const nightLine = am2.days.weekday[3]; // 23:50 -> 00:05 overnight trip
  const mNow2 = 5; // 00:05
  const midnight2 = NOW_MS - mNow2 * 60000;
  const entry2 = {
    target: "WTC",
    secondsToArrival: String(Math.round((midnight2 + 7 * 60000 - NOW_MS) / 1000)), // 00:07 at EXC
    lineColor: "65C100",
    headSign: "",
    lastUpdatedMs: NOW_MS,
  };
  const rt2 = normalizeRt({ fetchedAt: NOW_MS, stations: { EXP: [entry2] } }, NOW_MS);
  const adjust2 = buildRealtimeModel(am2, rt2, mNow2, NOW_MS);
  check(
    "running train matched via yesterday's table",
    delayOf(adjust2, nightLine.trips[0], -1440) === 6,
  ); // EXC 1 -> 7
  check(
    "yesterday's prediction does not leak into tonight",
    delayOf(adjust2, nightLine.trips[0]) === undefined,
  );
}

console.log("minimum-cost maximum assignment");
{
  // Compare the optimizer with exhaustive enumeration for every 3x3 edge
  // subset, including disconnected graphs and assignments needing reversal.
  const edges = Array.from({ length: 9 }, (_, i) => ({
    left: Math.floor(i / 3),
    right: i % 3,
    cost: (i * 7 + 3) % 11,
    tieCost: (Math.floor(i / 3) - (i % 3)) ** 2,
  }));
  let optimal = true;
  for (let mask = 0; mask < 512; mask++) {
    const candidates = edges.filter((_, i) => mask & (1 << i));
    let best = { count: -1, cost: Infinity, tie: Infinity };
    function enumerate(left, used, count, cost, tie) {
      if (left === 3) {
        if (
          count > best.count ||
          (count === best.count && (cost < best.cost || (cost === best.cost && tie < best.tie)))
        )
          best = { count, cost, tie };
        return;
      }
      enumerate(left + 1, used, count, cost, tie);
      for (const edge of candidates) {
        if (edge.left !== left || used.has(edge.right)) continue;
        enumerate(
          left + 1,
          new Set([...used, edge.right]),
          count + 1,
          cost + edge.cost,
          tie + edge.tieCost,
        );
      }
    }
    enumerate(0, new Set(), 0, 0, 0);
    const actual = minimumCostMatching(3, 3, candidates);
    if (
      actual.length !== best.count ||
      actual.reduce((s, e) => s + e.cost, 0) !== best.cost ||
      actual.reduce((s, e) => s + e.tieCost, 0) !== best.tie
    )
      optimal = false;
  }
  check("all 512 small graphs agree with the exhaustive optimum", optimal);
  const precision = minimumCostMatching(1, 2, [
    { left: 0, right: 0, cost: 0.1, tieCost: 10000 },
    { left: 0, right: 1, cost: 0.2, tieCost: 0 },
  ]);
  check("ordering never outweighs even a fractional primary cost", precision[0].right === 0);
  check("empty graphs return no matches", minimumCostMatching(0, 2, []).length === 0);
}

// Make isolated one-service fixtures so assignment expectations are explicit.
function matchingFixture(scheduled, projected) {
  const clock = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const line = mkLine(
    "Journal Square - WTC",
    "#D93A30",
    ["JSQ", "WTC"],
    scheduled.map((m) => [clock(m), clock(m + 20)]),
  );
  const sched = { days: { weekday: [line], saturday: [line], sunday: [line] } };
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { JSQ: projected.map((m) => entry("WTC", "D93A30", m)) } },
    NOW_MS,
  );
  return { line, sched, rt, model: buildRealtimeModel(sched, rt, M_NOW, NOW_MS) };
}

{
  const { line, model } = matchingFixture([600, 605, 610, 625, 640], [603, 608, 624, 637]);
  check(
    "user example leaves 10:00 unmatched and selects -2/-2/-1/-3",
    line.trips.map((t) => delayOf(model, t) ?? "unknown").join(",") === "unknown,-2,-2,-1,-3",
  );
  const better = matchingFixture([600, 604], [603, 607]);
  check(
    "greedy counterexample finds +3/+3, not +7/-1",
    better.line.trips.every((t) => delayOf(better.model, t) === 3),
  );
  const coverage = matchingFixture([600, 604], [603, 619]);
  check(
    "coverage takes priority over the cheapest individual match",
    coverage.line.trips.map((t) => delayOf(coverage.model, t)).join(",") === "3,15",
  );
  const tied = matchingFixture([600, 604], [607, 611]);
  check(
    "equal-cost assignments preserve chronological order",
    tied.line.trips.map((t) => delayOf(tied.model, t)).join(",") === "7,7",
  );
  const repeated = buildRealtimeModel(tied.sched, tied.rt, M_NOW, NOW_MS);
  check(
    "tie-breaking is stable across rebuilds",
    tied.line.trips.every((t) => delayOf(tied.model, t) === delayOf(repeated, t)),
  );
  const precise = matchingFixture([600], [600 + 20 / 60]);
  check(
    "sub-minute predictions are retained for routing",
    Math.abs(delayOf(precise.model, precise.line.trips[0]) - 1 / 3) < 1e-9,
  );
  check(
    "a model rejects a stale normalized snapshot too",
    buildRealtimeModel(precise.sched, precise.rt, M_NOW, NOW_MS + STALE_AFTER_MS + 1) === null,
  );
  const bounds = matchingFixture([603, 625], [600, 640]);
  check(
    "exact -3 and +15 boundaries remain eligible",
    bounds.line.trips.map((t) => delayOf(bounds.model, t)).join(",") === "-3,15",
  );
}

console.log("stop-specific predictions and missing-stop estimates");
{
  const line = mkLine(
    "Journal Square - WTC",
    "#D93A30",
    ["JSQ", "GRO", "NEW", "EXC", "WTC"],
    [["10:00", "10:05", null, "10:15", "10:20"]],
  );
  const sched = { days: { weekday: [line], saturday: [line], sunday: [line] } };
  const rt = normalizeRt(
    {
      fetchedAt: NOW_MS,
      stations: {
        JSQ: [entry("WTC", "D93A30", 602)],
        WTC: [entry("WTC", "D93A30", 628)],
      },
    },
    NOW_MS,
  );
  const model = buildRealtimeModel(sched, rt, M_NOW, NOW_MS);
  const trip = collectTrips(sched, new Date(NOW_MS), 0, model)[0];
  const leg = toLeg({ trip, board: 0, alight: 4 });
  check(
    "boarding and terminal retain their independent live offsets",
    leg.board.delay === 2 &&
      leg.alight.delay === 8 &&
      leg.board.source === "live" &&
      leg.alight.source === "live",
  );
  check(
    "missing stops interpolate using scheduled travel time",
    trip.times.join(",") === "602,608.5,,621.5,628",
  );
  check(
    "skipped stops remain omitted",
    leg.stops.length === 4 && !leg.stops.some((s) => s.stop === "NEW"),
  );
  check(
    "interpolated stops are explicitly estimated",
    leg.stops[1].source === "estimated" && leg.stops[1].scheduledTime === 605,
  );
  const journey = findJourneys(sched, "JSQ", "WTC", 630, 603.5, model, NOW_MS)[0];
  check(
    "terminal delay does not make a departed boarding prediction catchable",
    journey.departed && journey.depAbs === 602 && journey.arrAbs === 628,
  );
  check(
    "arrival deadline uses the terminal's own prediction",
    findJourneys(sched, "JSQ", "WTC", 627, M_NOW, model, NOW_MS).length === 0,
  );
  const terminalRt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { WTC: [entry("WTC", "D93A30", 628)] } },
    NOW_MS,
  );
  const terminalModel = buildRealtimeModel(sched, terminalRt, M_NOW, NOW_MS);
  const terminalTrip = collectTrips(sched, new Date(NOW_MS), 0, terminalModel)[0];
  check(
    "terminal-only fallback is estimated at boarding, not claimed live",
    terminalTrip.times[0] === 608 && terminalTrip.predictions[0].source === "estimated",
  );
  const plain = collectTrips(sched, new Date(NOW_MS), 0)[0];
  check(
    "no observations retain timetable times and source",
    toLeg({ trip: plain, board: 0, alight: 4 }).board.source === "timetable" &&
      plain.times[0] === 600,
  );
}

console.log("conflicting observations and compatible services");
{
  const line = mkLine(
    "Journal Square - WTC",
    "#D93A30",
    ["JSQ", "GRO", "WTC"],
    [["10:00", "10:05", "10:10"]],
  );
  const green = mkLine("Hoboken - WTC", "#65C100", ["JSQ", "WTC"], [["10:00", "10:10"]]);
  const sched = {
    days: { weekday: [line, green], saturday: [line, green], sunday: [line, green] },
  };
  const rt = normalizeRt(
    {
      fetchedAt: NOW_MS,
      stations: {
        JSQ: [entry("WTC", "D93A30", 610)],
        // Older prediction says the train reaches the next stop before it boards.
        GRO: [
          {
            ...entry("WTC", "D93A30", 607),
            lastUpdatedMs: NOW_MS - 60000,
            secondsToArrival: "480",
          },
        ],
      },
    },
    NOW_MS,
  );
  const model = buildRealtimeModel(sched, rt, M_NOW, NOW_MS);
  const trip = collectTrips(sched, new Date(NOW_MS), 0, model)[0];
  check(
    "newer anchor wins over backward-in-time older observation",
    trip.times.join(",") === "610,615,620" && trip.predictions[1].source === "estimated",
  );
  check(
    "rejected anchor remains assigned instead of becoming an extra",
    model.matchedEntries.get("GRO").size === 1,
  );
  const shared = normalizeRt(
    { fetchedAt: NOW_MS, stations: { JSQ: [entry("WTC", "D93A30,65C100", 603)] } },
    NOW_MS,
  );
  const sharedModel = buildRealtimeModel(sched, shared, M_NOW, NOW_MS);
  check(
    "one combined-color entry cannot claim two services",
    sharedModel.trips.size === 1 && sharedModel.matchedEntries.get("JSQ").size === 1,
  );
  const distinct = normalizeRt(
    {
      fetchedAt: NOW_MS,
      stations: { JSQ: [entry("WTC", "D93A30", 603), entry("WTC", "65C100", 603)] },
    },
    NOW_MS,
  );
  check(
    "distinct colors can both match at the same time",
    buildRealtimeModel(sched, distinct, M_NOW, NOW_MS).trips.size === 2,
  );
}

console.log("transfers use stop-local arrival and departure");
{
  const lines = [
    mkLine("JSQ - Newport", "#FF9900", ["JSQ", "NEW"], [["10:00", "10:10"]]),
    mkLine("Newport - Hoboken", "#65C100", ["NEW", "HOB"], [["10:15", "10:25"]]),
  ];
  const sched = { days: { weekday: lines, saturday: lines, sunday: lines } };
  const raw = {
    fetchedAt: NOW_MS,
    stations: {
      JSQ: [entry("NEW", "FF9900", 602)],
      NEW: [entry("NEW", "FF9900", 618), entry("HOB", "65C100", 620)],
      HOB: [entry("HOB", "65C100", 630)],
    },
  };
  const model = buildRealtimeModel(sched, normalizeRt(raw, NOW_MS), M_NOW, NOW_MS);
  check(
    "two-minute transfer fails despite an earlier boarding offset",
    findJourneys(sched, "JSQ", "HOB", 640, M_NOW, model, NOW_MS).length === 0,
  );
  raw.stations.NEW[1] = entry("HOB", "65C100", 621);
  const catchable = buildRealtimeModel(sched, normalizeRt(raw, NOW_MS), M_NOW, NOW_MS);
  const journeys = findJourneys(sched, "JSQ", "HOB", 640, M_NOW, catchable, NOW_MS);
  check(
    "three-minute transfer succeeds using both station predictions",
    journeys.length === 1 &&
      journeys[0].legs[0].alight.time === 618 &&
      journeys[0].legs[1].board.time === 621 &&
      journeys[0].arrAbs === 630,
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
