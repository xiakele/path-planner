// Node harness for src/search.js — focus: missed-train context behavior
// (departed first legs shown as dimmed context, including across midnight via
// yesterday's calendar-day table). No test framework — plain assertions, run
// with `pnpm test:search`. mNow is injected so results are reproducible; the
// fixture fills weekday/saturday/sunday with the same lines so the harness
// works on any calendar day (findJourneys resolves the real clock's
// yesterday/today/tomorrow internally).

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

function mkLine(name, color, stops, trips) {
  return { name, color, stops, trips };
}

// NEW stop times per trip: 05:16, 10:06, 10:36, 23:26, 23:46 (the last trip
// crosses midnight and reaches WTC at 00:05)
function mkSchedule() {
  const lines = [
    mkLine(
      "Hoboken - World Trade Center",
      "#65C100",
      ["HOB", "NEW", "EXC", "WTC"],
      [
        ["05:10", "05:16", "05:21", "05:25"], // early morning
        ["10:00", "10:06", "10:11", "10:15"], // midday
        ["10:30", "10:36", "10:41", "10:45"], // midday
        ["23:20", "23:26", "23:31", "23:35"], // late evening
        ["23:40", "23:46", "23:51", "00:05"], // crosses midnight
      ],
    ),
  ];
  return {
    generatedAt: new Date().toISOString(),
    source: "fixture",
    days: { weekday: lines, saturday: lines, sunday: lines },
  };
}

const schedule = mkSchedule();

console.log("missed context before midnight (next-day deadline)");
{
  // 23:57, deadline 12:35 AM: the trains that would have made it left NEW at
  // 23:26 and 23:46 — dimmed context instead of an empty result (this used
  // to return zero because departed trains were dropped for next-day targets)
  const js = findJourneys(schedule, "NEW", "WTC", 35, 1437);
  check("returns the missed connections", js.length === 2);
  check("latest missed departure first", js[0].depAbs === 1426 && js[1].depAbs === 1406);
  check(
    "all flagged departed",
    js.every((j) => j.departed),
  );
  check("midnight-crossing trip on the absolute timeline", js[0].arrAbs === 1445);
}

console.log("missed context after midnight (yesterday's table)");
{
  // 00:05, deadline 12:35 AM: both useful trains now belong to yesterday's
  // calendar-day table (base -1440) — the 23:46 one crossing midnight (arr
  // 00:05) and the 23:26 one (arr 23:35, half an hour ago); both must still
  // surface as context
  const js = findJourneys(schedule, "NEW", "WTC", 35, 5);
  check("yesterday's trains surface as context", js.length === 2);
  check("midnight-crossing trip leads", js[0].depAbs === -14 && js[0].arrAbs === 5);
  check("earlier missed train follows", js[1].depAbs === -34 && js[1].arrAbs === -25);
  check(
    "all flagged departed",
    js.every((j) => j.departed),
  );
  // Yesterday's midday trains (NEW at 10:06/10:36 -> abs ~-834/-804) arrived
  // 14+ h ago — hours-old context that must not appear
  check("hours-old context excluded", !js.some((j) => j.depAbs <= -800));
}

console.log("context freshness bound");
{
  // 23:59 deadline: the 23:20 train (arrived 23:35, 24 min ago) is fresh
  // context; the midday trains (arrived 8+ h ago) are noise and dropped
  const js = findJourneys(schedule, "NEW", "WTC", 1439, 1437);
  check("fresh missed context kept", js.length === 1 && js[0].depAbs === 1406);
  check("hours-old context dropped", !js.some((j) => j.depAbs === 600 || j.depAbs === 630));
}

console.log("next-day deadline mid-day stays catchable-only");
{
  // 2 PM, deadline 1:30 PM (rolls to tomorrow 1:30 PM): plenty of catchable
  // trains — departed ones must not crowd out the top 3
  const js = findJourneys(schedule, "NEW", "WTC", 810, 840);
  check("three catchable options, none departed", js.length === 3 && js.every((j) => !j.departed));
  check("latest departures first", js.map((j) => j.depAbs).join(",") === "2076,2046,1756");
}

console.log("truly impossible deadline returns zero");
{
  // 2 PM, deadline 2:10 PM: nothing arrives that fast, and the only trains
  // that did arrive (midday) are hours-old context — a genuine empty result
  const js = findJourneys(schedule, "NEW", "WTC", 850, 840);
  check("no journeys", js.length === 0);
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
