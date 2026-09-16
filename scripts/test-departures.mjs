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

console.log("route-scoped board");
{
  // Dedicated fixture: red JSQ–WTC direct, orange JSQ–NEW–33S, and a short
  // NEW–HOB shuttle — so to=WTC is a direct ride and to=HOB needs exactly
  // one transfer off the orange line at Newport
  const mkRouteLine = (name, color, stops, trips) => ({ name, color, stops, trips });
  const mkRouteSchedule = () => {
    const lines = [
      mkRouteLine(
        "Journal Square - 33 Street",
        "#FF9900",
        ["JSQ", "NEW", "33S"],
        [
          ["09:58", "10:07", "10:23"],
          ["10:13", "10:22", "10:38"],
        ],
      ),
      mkRouteLine(
        "Newark - World Trade Center",
        "#D93A30",
        ["NWK", "JSQ", "WTC"],
        [["09:50", "09:59", "10:11"]],
      ),
      mkRouteLine("Newport - Hoboken", "#65C100", ["NEW", "HOB"], [["10:10", "10:16"]]),
    ];
    return {
      generatedAt: new Date(NOW_MS).toISOString(),
      source: "fixture",
      days: { weekday: lines, saturday: lines, sunday: lines },
    };
  };

  // Direct destination: only the red train boards JSQ and reaches WTC
  const direct = findDepartures(mkRouteSchedule(), "JSQ", M_NOW, NOW_MS, null, "WTC");
  check(
    "direct ride is scoped to the serving line",
    direct.length === 1 && direct[0].depAbs === 599,
  );
  check("direct row carries the arrival at the destination", direct[0].arrAbs === 611);
  check("direct row has a single leg", direct[0].legs.length === 1);
  check("nearest-first still holds when scoped", direct[0].depAbs < M_NOW + DEPARTURES_WINDOW_MIN);

  // Transfer destination: the orange 09:58 reaches NEW 10:07, transfers to
  // the 10:10 shuttle (3 min wait = TRANSFER_MIN) and arrives HOB 10:16;
  // the orange 10:13 misses the shuttle and the red train never reaches HOB
  const transfer = findDepartures(mkRouteSchedule(), "JSQ", M_NOW, NOW_MS, null, "HOB");
  check("transfer first leg is the only row", transfer.length === 1 && transfer[0].depAbs === 598);
  check("transfer row carries the post-connection arrival", transfer[0].arrAbs === 616);
  check("transfer row has two legs", transfer[0].legs.length === 2);
  check(
    "transfer row's legs board and alight at the right stops",
    transfer[0].legs[0].board.stop === "JSQ" &&
      transfer[0].legs[0].alight.stop === "NEW" &&
      transfer[0].legs[1].board.stop === "NEW" &&
      transfer[0].legs[1].alight.stop === "HOB",
  );
  check(
    "a first leg whose only connection is hours out (tomorrow's table) is excluded",
    !transfer.some((r) => r.depAbs === 613),
  );

  // Delay shifts the whole scoped row: a +5 on the red train moves both the
  // departure and the estimated arrival
  const lateRt = normalizeRt(
    { fetchedAt: NOW_MS, stations: { JSQ: [entry("WTC", "D93A30", 604)] } },
    NOW_MS,
  );
  const late = findDepartures(mkRouteSchedule(), "JSQ", M_NOW, NOW_MS, lateRt, "WTC");
  check(
    "delayed scoped row shifts departure and arrival",
    late.length === 1 && late[0].depAbs === 604 && late[0].arrAbs === 616,
  );
  check("delayed scoped row stamps the leg delay", late[0].legs[0].delay === 5);

  // Feed extras in the scoped board: only an entry headed to exactly the
  // destination is provably rideable; anything else is dropped
  const extraRt = normalizeRt(
    {
      fetchedAt: NOW_MS,
      stations: {
        JSQ: [entry("WTC", "65C100", 630), entry("33S", "FF9900", 635)],
      },
    },
    NOW_MS,
  );
  const extras = findDepartures(mkRouteSchedule(), "JSQ", M_NOW, NOW_MS, extraRt, "WTC");
  const wtcExtra = extras.find((r) => r.fromFeed);
  check(
    "extra headed to the destination is kept",
    wtcExtra !== undefined && wtcExtra.terminus === "WTC",
  );
  check("kept extra has no arrival estimate", wtcExtra && wtcExtra.arrAbs === undefined);
  check(
    "extra headed elsewhere is dropped",
    !extras.some((r) => r.fromFeed && r.terminus === "33S"),
  );

  // Unreachable destination: scoped board is empty while the full board at
  // the same station still lists trains (NEW has no line reaching WTC)
  const unreachable = findDepartures(mkRouteSchedule(), "NEW", M_NOW, NOW_MS, null, "WTC");
  check("unreachable destination yields an empty scoped board", unreachable.length === 0);
  const fullNew = findDepartures(mkRouteSchedule(), "NEW", M_NOW, NOW_MS, null);
  check("full board at the same station is unaffected", fullNew.length === 3);

  // Regression: the full-board call without `to` keeps its shape — no
  // arrAbs/legs leak into plain rows
  check(
    "full-board rows carry no route fields",
    fullNew.every((r) => r.arrAbs === undefined && !r.legs),
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
