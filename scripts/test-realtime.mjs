// Node harness for src/realtime.js and its integration with src/search.js.
// No test framework in this repo — plain assertions, run with
// `pnpm test:realtime`. All clocks are injected (fixed mNow / nowMs), so
// results are reproducible regardless of when the harness runs.
//
// Fixture trick: findJourneys resolves "today" via the real clock, so the
// synthetic schedule fills weekday/saturday/sunday with the same lines and
// the tests work on any calendar day.

import {
  buildDelays,
  normalizeRt,
  MATCH_TOLERANCE_MIN,
  RT_HORIZON_MIN,
  STALE_AFTER_MS,
} from "../src/realtime.js";
import { findJourneys } from "../src/search.js";

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
const NOW_MS = Date.now();
const MIDNIGHT_MS = NOW_MS - M_NOW * 60000;

// Absolute minutes -> a projected feed timestamp consistent with the clock
function at(absMin) {
  return MIDNIGHT_MS + absMin * 60000;
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

console.log("buildDelays");
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
  check("returns null without a snapshot", buildDelays(schedule, null, M_NOW, NOW_MS) === null);
  const delays = buildDelays(schedule, rt, M_NOW, NOW_MS);
  check(
    "green HOB–WTC trip picks up the green entry's +4 delay",
    delays.get(hobWtc.trips[0]) === 4,
  );
  check(
    "red NWK–WTC trip pairs with the red entry (on time -> 0)",
    delays.get(nwkWtc.trips[0]) === 0,
  );
  check("orange JSQ–33S pairs via a combined-service color list", delays.get(jsq33.trips[0]) === 5);
}
{
  // Tolerance: an entry 20 min off the timetable time must not pair
  check("tolerance constant is below 20", MATCH_TOLERANCE_MIN < 20);
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { NEW: [entry("WTC", "65C100", 621)] } }, // vs timetable 601
    NOW_MS,
  );
  const delays = buildDelays(schedule, rt, M_NOW, NOW_MS);
  check("no pairing beyond the tolerance", !delays.has(hobWtc.trips[0]));
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
  const delays = buildDelays(far, rt, M_NOW, NOW_MS);
  check("no pairing beyond the horizon", !delays.has(far.days.weekday[0].trips[0]));
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
  const delays = buildDelays(dup, rt, M_NOW, NOW_MS);
  check("nearer trip claims the entry", delays.get(dup.days.weekday[0].trips[1]) === 1);
  check("other trip stays unpaired", !delays.has(dup.days.weekday[0].trips[0]));
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
  const adjust = buildDelays(late, rt, M_NOW, NOW_MS);

  const scheduled = findJourneys(late, "NEW", "WTC", 630, M_NOW);
  check(
    "without delays the train reads as departed",
    scheduled.length === 1 && scheduled[0].departed === true,
  );
  check("unadjusted legs carry no delay", scheduled[0].legs[0].delay === undefined);

  const adjusted = findJourneys(late, "NEW", "WTC", 630, M_NOW, adjust);
  check("delayed train becomes catchable", adjusted.length === 1 && adjusted[0].departed === false);
  check(
    "journey times shift by the delay",
    adjusted[0].depAbs === 606 && adjusted[0].arrAbs === 615,
  );
  check("leg reports the applied delay", adjusted[0].legs[0].delay === 15);

  // Arrival past the entered target: the delay can also price a journey out
  const tight = findJourneys(late, "NEW", "WTC", 605, M_NOW, adjust);
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
  const adjust = buildDelays(night, rt, nightNow, NOW_MS);
  check("overnight trip is matched across midnight", adjust.get(nightLine.trips[0]) === 6); // 1436 -> 1442

  const j = findJourneys(night, "NEW", "WTC", 1455, nightNow, adjust);
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
  const adjust = buildDelays(am, rt, mNowAM, NOW_MS);
  check("post-midnight trip matched via tomorrow's table", adjust.get(line.trips[0]) === 0);

  const j = findJourneys(am, "NEW", "WTC", 1465, mNowAM, adjust);
  // The catchable 00:13 train plus, as dimmed context, the overnight train
  // that left NEW at 23:56 and also arrives by the deadline
  check(
    "post-midnight journey carries the live pairing",
    j.length === 2 &&
      j[0].depAbs === 1453 &&
      !j[0].departed &&
      j[0].legs[0].delay === 0 &&
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
  const adjust2 = buildDelays(am2, rt2, mNow2, NOW_MS);
  check("running train matched via yesterday's table", adjust2.get(nightLine.trips[0]) === 6); // EXC 1 -> 7
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
