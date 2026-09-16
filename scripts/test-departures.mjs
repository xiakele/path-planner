// Node harness for src/departures.js (departure board builder).
// No test framework in this repo — plain assertions, run with
// `pnpm test:departures`. All clocks are injected (fixed mNow / nowMs), so
// results are reproducible regardless of when the harness runs.
//
// Fixture trick: the board resolves "today" via the real clock, so the
// synthetic schedule fills weekday/saturday/sunday with the same lines and
// the tests work on any calendar day.

import { DEPARTURES_WINDOW_MIN, findDepartures } from "../src/departures.js";
import { normalizeRt } from "../src/realtime.js";

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
function entry(target, colors, projectedAbsMin) {
  return {
    target,
    secondsToArrival: String(Math.round((at(projectedAbsMin) - NOW_MS) / 1000)),
    lineColor: colors,
    headSign: "",
    // lastUpdated "now" so projected = lastUpdated + secondsToArrival
    lastUpdatedMs: NOW_MS,
  };
}

function mkLine(name, color, stops, trips) {
  return { name, color, stops, trips };
}

// Synthetic lines modeled on the real timetable: a JSQ–33 St line, a NWK–WTC
// line through JSQ, and a HOB–WTC line that skips JSQ entirely
function mkSchedule() {
  const lines = [
    // JSQ 598, GRO 602, NEW 607, CHR 612, 09S 615, ... 33S 623
    mkLine(
      "Journal Square - 33 Street",
      "#FF9900",
      ["JSQ", "GRO", "NEW", "CHR", "09S", "14S", "23S", "33S"],
      [
        ["09:58", "10:02", "10:07", "10:12", "10:15", "10:17", "10:19", "10:23"],
        ["10:13", "10:17", "10:22", "10:27", "10:30", "10:32", "10:34", "10:38"],
      ],
    ),
    // NWK 590, HAR 594, JSQ 599, GRO 603, EXC 607, WTC 611
    mkLine(
      "Newark - World Trade Center",
      "#D93A30",
      ["NWK", "HAR", "JSQ", "GRO", "EXC", "WTC"],
      [["09:50", "09:54", "09:59", "10:03", "10:07", "10:11"]],
    ),
    // HOB 595, NEW 601, EXC 606, WTC 610 — no JSQ stop
    mkLine(
      "Hoboken - World Trade Center",
      "#65C100",
      ["HOB", "NEW", "EXC", "WTC"],
      [
        ["09:55", "10:01", "10:06", "10:10"],
        ["10:25", "10:31", "10:36", "10:40"],
      ],
    ),
  ];
  return {
    generatedAt: new Date(NOW_MS).toISOString(),
    source: "fixture",
    days: { weekday: lines, saturday: lines, sunday: lines },
  };
}

// Departure minutes of the fixture lines at JSQ (mNow = 600, window 45):
// orange 598 / 613, red 599 — green doesn't call at JSQ at all
console.log("window filtering & ordering");
{
  const rows = findDepartures(mkSchedule(), "JSQ", M_NOW, NOW_MS, null);
  check("window constant is 45", DEPARTURES_WINDOW_MIN === 45);
  check(
    "only JSQ-served lines appear",
    rows.every((r) => r.line.color !== "#65C100"),
  );
  check(
    "rows are the expected trips",
    rows.length === 3 && rows.every((r) => !r.fromFeed && r.delay === undefined),
  );
  // Nearest departure first, even though the 598 train left 2 min ago
  check("nearest departure is at the top", rows.map((r) => r.depAbs).join(",") === "598,599,613");
  check("the just-missed 598 train leads the board", rows[0].line.color === "#FF9900");
  check(
    "terminus is the line's last stop",
    rows.every((r) => r.terminus === "33S" || r.terminus === "WTC"),
  );
}

console.log("grace window");
{
  // Just-missed trains stay on the board as context; older ones drop off
  const sched = mkSchedule();
  sched.days.weekday[1].trips = [
    ["09:48", "09:52", "09:56", "10:00", "10:04", "10:08"], // JSQ 596, 4 min ago -> kept
    ["09:40", "09:44", "09:48", "09:52", "09:56", "10:00"], // JSQ 588, 12 min ago -> dropped
  ];
  const rows = findDepartures(sched, "JSQ", M_NOW, NOW_MS, null);
  check(
    "a departure 4 min ago still shows",
    rows.some((r) => r.depAbs === 596),
  );
  check("a departure 12 min ago is dropped", !rows.some((r) => r.depAbs === 588));
}

console.log("delay-adjusted board");
{
  // The red train's timetable JSQ time is 599; a feed entry at JSQ projects
  // 607 -> +8, so the board shows 607 with the delay stamped on the row and
  // the consumed entry must not duplicate as an extra
  const sched = mkSchedule();
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { JSQ: [entry("WTC", "D93A30", 607)] } },
    NOW_MS,
  );
  const rows = findDepartures(sched, "JSQ", M_NOW, NOW_MS, rt);
  const red = rows.find((r) => r.line.color === "#D93A30");
  check("delayed train shows the adjusted departure", red && red.depAbs === 607);
  check("row carries the observed delay", red && red.delay === 8);
  check(
    "a delayed train still sorts by its adjusted time",
    rows.map((r) => r.depAbs).join(",") === "598,607,613",
  );
  check(
    "the paired feed entry does not also appear as an extra",
    rows.filter((r) => r.fromFeed).length === 0,
  );
}

console.log("feed-only extras");
{
  // A green combined-service entry at JSQ with no timetable counterpart (the
  // green line doesn't call at JSQ) becomes a live extra row
  const sched = mkSchedule();
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { JSQ: [entry("33S", "65C100", 630)] } },
    NOW_MS,
  );
  const rows = findDepartures(sched, "JSQ", M_NOW, NOW_MS, rt);
  const extra = rows.find((r) => r.fromFeed);
  check("unscheduled feed entry becomes an extra row", extra !== undefined);
  check(
    "extra has no line but keeps its terminus",
    extra && extra.line === null && extra.terminus === "33S",
  );
  check("extra carries the projected minute", extra && extra.depAbs === 630);
  check("extra keeps the feed colors for the chip", extra && extra.colors.join(",") === "#65C100");
  check(
    "extra sorts into the board by its projected time",
    rows.map((r) => r.depAbs).join(",") === "598,599,613,630",
  );

  // An entry matching a timetable train beyond the board window is not an
  // extra: it belongs to that (future) train, the board just doesn't reach it
  const sched2 = mkSchedule();
  sched2.days.weekday[0].trips = [
    ["09:58", "10:02", "10:07", "10:12", "10:15", "10:17", "10:19", "10:23"],
    ["10:53", "10:57", "11:02", "11:07", "11:10", "11:12", "11:14", "11:18"], // JSQ 653, beyond the window
  ];
  const rt2 = normalizeRt(
    { fetchedAt: NOW_MS, stations: { JSQ: [entry("33S", "FF9900", 655)] } }, // 653 + 2
    NOW_MS,
  );
  const rows2 = findDepartures(sched2, "JSQ", M_NOW, NOW_MS, rt2);
  check("beyond-window train is not on the board", !rows2.some((r) => r.depAbs === 653));
  check(
    "its feed entry is not misread as an extra",
    !rows2.some((r) => r.fromFeed && r.depAbs === 655),
  );
}

console.log("terminal stations");
{
  // WTC is only ever a final stop: no line departs there, and the feed's
  // inbound trains (target WTC) are arrivals, not departures
  const sched = mkSchedule();
  const rt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { WTC: [entry("WTC", "D93A30", 611)] } },
    NOW_MS,
  );
  const rows = findDepartures(sched, "WTC", M_NOW, NOW_MS, rt);
  check("terminal station gets an empty board", rows.length === 0);
}

console.log("midnight boundaries");
{
  // Just before midnight, a train leaving at 00:13 belongs to tomorrow's
  // table (base 1440): the base-0 reading is "this morning" and must not
  // appear, the base-1440 one must
  const sched = mkSchedule();
  sched.days.weekday[1].trips = [["00:07", "00:11", "00:13", "00:17", "00:21", "00:25"]]; // JSQ 00:13
  const mNow = 1438; // 23:58
  const midnightMs = NOW_MS - mNow * 60000;
  const rt = normalizeRt(
    {
      fetchedAt: NOW_MS,
      stations: {
        JSQ: [
          {
            target: "WTC",
            secondsToArrival: String(Math.round((midnightMs + 1453 * 60000 - NOW_MS) / 1000)),
            lineColor: "D93A30",
            headSign: "",
            lastUpdatedMs: NOW_MS,
          },
        ],
      },
    },
    NOW_MS,
  );
  const rows = findDepartures(sched, "JSQ", mNow, NOW_MS, rt);
  const post = rows.find((r) => r.depAbs === 1453);
  check("post-midnight departure resolves via tomorrow's table", post !== undefined);
  check("post-midnight row carries its live pairing", post && post.delay === 0);
  check(
    "this morning's base-0 reading of the same trip is not on the board",
    !rows.some((r) => r.depAbs === 13),
  );
}

console.log("closed / unserved stations");
{
  // 09 St has service in the fixture but a station nothing serves (or a
  // service gap) must yield an empty board without crashing
  const sched = mkSchedule();
  check("mid-day gap is empty", findDepartures(sched, "CHR", 1200, NOW_MS, null).length === 0);
  check("night gap is empty", findDepartures(sched, "JSQ", 300, NOW_MS, null).length === 0);
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
