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

console.log("leg stop sequences");
{
  // Legs carry every called stop between boarding and alighting with its
  // absolute (delay-adjusted) time — the fuel for the stop-by-stop popup.
  // A null stop time means the train skips that station: omitted.
  const sched = mkSchedule();
  // The 10:00 trip skips EXC and runs +5 (feed-observed) — NEW 10:11, WTC 10:20
  sched.days.weekday[0].trips[1] = ["10:00", "10:06", null, "10:15"];
  // Inject per-stop predictions for today's occurrence, not a trip-wide delay.
  const predictions = [600, 606, null, 615].map((t) =>
    t === null ? null : { time: t + 5, delay: 5, source: "live" },
  );
  const adjust = {
    trips: new Map([[sched.days.weekday[0].trips[1], new Map([[0, predictions]])]]),
  };
  const js = findJourneys(sched, "NEW", "WTC", 625, 600, adjust);
  check("one delay-adjusted journey", js.length === 1 && js[0].depAbs === 611);
  const leg = js[0].legs[0];
  check(
    "endpoints carry their own delay and provenance",
    leg.board.delay === 5 && leg.alight.delay === 5 && leg.board.source === "live",
  );
  check(
    "stops list the called stops only, delay-adjusted",
    leg.stops.map((s) => `${s.stop}@${s.time}`).join(",") === "NEW@611,WTC@620",
  );
  check(
    "board/alight agree with the first/last stop rows",
    leg.board.stop === "NEW" &&
      leg.board.time === 611 &&
      leg.alight.stop === "WTC" &&
      leg.alight.time === 620,
  );
}

console.log("loop-free connections");
{
  // The reported bug shape: from 9 St, riding the JSQ-ward leg to 14 St and
  // catching the return train — which calls at 9 St again en route to JSQ —
  // is a loop. The same return train boards 9 St directly, and that journey
  // is the one that must be offered
  const mkLines = () => [
    mkLine("9 Street - 14 Street", "#4D92FB", ["09S", "14S"], [["10:00", "10:02"]]),
    mkLine(
      "14 Street - Journal Square",
      "#FF9900",
      ["14S", "09S", "JSQ"],
      [["10:05", "10:07", "10:13"]],
    ),
  ];
  const lines = mkLines();
  const sched = {
    generatedAt: new Date().toISOString(),
    source: "fixture",
    days: { weekday: lines, saturday: lines, sunday: lines },
  };
  const js = findJourneys(sched, "09S", "JSQ", 620, 595);
  check("loopy continuation is pruned", !js.some((j) => j.depAbs === 600));
  check(
    "the direct ride on the returning train is offered",
    js.length === 1 && js[0].depAbs === 607 && js[0].legs.length === 1,
  );

  // Legitimate retrace kept: 33 St -> JSQ transfers to the WTC train, which
  // passes Grove Street again after the first leg already did — a shared
  // corridor, not a loop (the origin is never revisited), so it must stay
  const corridor = [
    mkLine(
      "33 Street - Journal Square",
      "#FF9900",
      ["33S", "GRO", "JSQ"],
      [["10:00", "10:04", "10:08"]],
    ),
    mkLine(
      "Journal Square - World Trade Center",
      "#D93A30",
      ["JSQ", "GRO", "EXC", "WTC"],
      [["10:15", "10:19", "10:22", "10:25"]],
    ),
  ];
  const corridorSched = {
    generatedAt: new Date().toISOString(),
    source: "fixture",
    days: { weekday: corridor, saturday: corridor, sunday: corridor },
  };
  const cj = findJourneys(corridorSched, "33S", "WTC", 630, 595);
  check(
    "shared-corridor retrace is kept",
    cj.length === 1 && cj[0].depAbs === 600 && cj[0].legs.length === 2 && cj[0].arrAbs === 625,
  );

  // A train passing the closed origin without stopping doesn't count as
  // returning to it: after midnight, riding 9 St -> 14 St to catch the
  // overnight JSQ-bound train (which skips 9 St) is the only way out and
  // must survive
  const nightLines = [
    mkLine("9 Street - 14 Street (night)", "#4D92FB", ["09S", "14S"], [["23:58", "00:02"]]),
    mkLine(
      "14 Street - Journal Square (night)",
      "#FF9900",
      ["14S", "09S", "JSQ"],
      [["00:10", null, "00:30"]],
    ),
  ];
  const nightSched = {
    generatedAt: new Date().toISOString(),
    source: "fixture",
    days: { weekday: nightLines, saturday: nightLines, sunday: nightLines },
  };
  const nj = findJourneys(nightSched, "09S", "JSQ", 35, 1436);
  check(
    "overnight escape via the closed origin survives",
    nj.length === 1 && nj[0].depAbs === 1438 && !nj[0].departed,
  );
  check(
    "escape journey keeps both legs and its arrival",
    nj[0].legs.length === 2 && nj[0].arrAbs === 1470,
  );
}

console.log("direct rides take precedence, with transfers as fallback");
{
  const nowMs = new Date(2026, 9, 28, 10).getTime();
  const makeSchedule = () => {
    // Every direct train has a faster transfer at NEW. Later feeder trips
    // would also outrank the directs if filtering happened after the top 3.
    const lines = [
      mkLine(
        "JSQ - WTC",
        "#D93A30",
        ["JSQ", "NEW", "WTC"],
        [
          ["10:00", "10:05", "10:30"],
          ["10:10", "10:15", "10:40"],
        ],
      ),
      mkLine(
        "JSQ - Newport",
        "#FF9900",
        ["JSQ", "NEW"],
        [
          ["10:03", "10:07"],
          ["10:13", "10:17"],
          ["10:23", "10:27"],
        ],
      ),
      mkLine(
        "Newport - WTC",
        "#65C100",
        ["NEW", "WTC"],
        [
          ["10:10", "10:15"],
          ["10:20", "10:25"],
          ["10:30", "10:35"],
        ],
      ),
    ];
    return { days: { weekday: lines, saturday: lines, sunday: lines } };
  };
  const sched = makeSchedule();
  const direct = findJourneys(sched, "JSQ", "WTC", 640, 600, null, nowMs);
  check(
    "direct routes exclude later-departing transfers before ranking",
    direct.length === 2 &&
      direct.every((j) => j.legs.length === 1) &&
      direct.map((j) => j.depAbs).join(",") === "610,600",
  );
  check(
    "a faster transfer cannot replace the same train's direct ride",
    direct.map((j) => j.arrAbs).join(",") === "640,630",
  );
  const tight = findJourneys(sched, "JSQ", "WTC", 625, 600, null, nowMs);
  check(
    "transfers remain when direct trains miss the deadline",
    tight.length > 0 && tight.every((j) => j.legs.length === 2 && j.arrAbs <= 625),
  );
  const missed = findJourneys(sched, "JSQ", "WTC", 640, 612, null, nowMs);
  check(
    "missed direct trains do not hide catchable transfers",
    missed.some((j) => !j.departed && j.legs.length === 2),
  );
  const predictions = new Map(
    sched.days.weekday[0].trips.map((trip) => [
      trip,
      new Map([
        [
          0,
          trip.map((time, index) => {
            const [h, m] = time.split(":").map(Number);
            const delay = index === 2 ? 12 : 0;
            return { time: h * 60 + m + delay, delay, source: "live" };
          }),
        ],
      ]),
    ]),
  );
  const delayed = findJourneys(sched, "JSQ", "WTC", 640, 600, { trips: predictions }, nowMs);
  check(
    "real-time arrival delays can restore the transfer fallback",
    delayed.length > 0 && delayed.every((j) => j.legs.length === 2),
  );
  for (const index of [0, 2]) {
    const skipped = makeSchedule();
    skipped.days.weekday[0].trips.forEach((trip) => {
      trip[index] = null;
    });
    const journeys = findJourneys(skipped, "JSQ", "WTC", 640, 600, null, nowMs);
    check(
      `skipped ${index === 0 ? "origin" : "destination"} does not count as direct service`,
      journeys.length > 0 && journeys.every((j) => j.legs.length === 2),
    );
  }
  const reversed = makeSchedule();
  reversed.days.weekday[0].stops.reverse();
  const backwards = findJourneys(reversed, "JSQ", "WTC", 640, 600, null, nowMs);
  check(
    "opposite-direction services do not suppress transfers",
    backwards.length > 0 && backwards.every((j) => j.legs.length === 2),
  );

  // The direct ride crosses midnight; the quicker transfer belongs to
  // tomorrow's calendar-day table and must not win merely by arriving first.
  const lines = [
    mkLine("JSQ - WTC", "#D93A30", ["JSQ", "NEW", "WTC"], [["23:58", "00:05", "00:20"]]),
    mkLine("JSQ - Newport", "#FF9900", ["JSQ", "NEW"], [["23:59", "00:03"]]),
    mkLine("Newport - WTC", "#65C100", ["NEW", "WTC"], [["00:08", "00:12"]]),
  ];
  const night = { days: { weekday: lines, saturday: lines, sunday: lines } };
  const overnight = findJourneys(night, "JSQ", "WTC", 25, 1435, null, nowMs);
  check(
    "direct preference survives a rolled midnight deadline",
    overnight.length === 1 &&
      overnight[0].legs.length === 1 &&
      overnight[0].depAbs === 1438 &&
      overnight[0].arrAbs === 1460,
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
