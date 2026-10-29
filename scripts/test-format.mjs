// Fixed-clock formatting regressions: labels own their verbs and preserve the
// existing Math.round boundaries, independently of journey catchability.
import { departureText } from "../src/format.js";
import { findJourneys } from "../src/search.js";

let checks = 0;
let failures = 0;
function check(name, condition) {
  checks++;
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

console.log("complete departure phrases and rounding boundaries");
const now = 600;
for (const [seconds, expected] of [
  [0, "leaving now"],
  [29, "leaving now"],
  [30, "departs in <b>1 min</b>"],
  [31, "departs in <b>1 min</b>"],
  [-29, "leaving now"],
  [-30, "leaving now"],
  [-31, "<b>departed</b> 1 min ago"],
  [-45, "<b>departed</b> 1 min ago"],
  [-59, "<b>departed</b> 1 min ago"],
  [-60, "<b>departed</b> 1 min ago"],
  [-61, "<b>departed</b> 1 min ago"],
  [300, "departs in <b>5 min</b>"],
  [59 * 60, "departs in <b>59 min</b>"],
  [60 * 60, "departs in <b>1 h 0 min</b>"],
  [125 * 60, "departs in <b>2 h 5 min</b>"],
  [-60 * 60, "<b>departed</b> 1 h 0 min ago"],
  [-125 * 60, "<b>departed</b> 2 h 5 min ago"],
]) {
  check(`${seconds} seconds from now`, departureText(now + seconds / 60, now) === expected);
}
check(
  "next-day absolute times retain their relative offset",
  departureText(1441, 1439) === "departs in <b>2 min</b>",
);
check(
  "just-past-midnight departures retain their relative offset",
  departureText(1439, 1441) === "<b>departed</b> 2 min ago",
);
check(
  "yesterday's absolute times do not wrap to a future departure",
  departureText(-1, 1) === "<b>departed</b> 2 min ago",
);

console.log("catchability is independent of departure wording");
// Reproduce the screenshot's state: 45 seconds after the departure is still
// catchable under the search grace period, but its label must be past tense.
const lines = [
  {
    name: "JSQ - 33 St",
    color: "#FF9900",
    stops: ["JSQ", "09S", "33S"],
    trips: [["22:40", "23:06", "23:15"]],
  },
];
const schedule = { days: { weekday: lines, saturday: lines, sunday: lines } };
const nowMs = new Date(2026, 9, 28, 22, 40, 45).getTime();
const [journey] = findJourneys(schedule, "JSQ", "09S", 1400, 1360.75, null, nowMs);
check("one-minute catchability grace is preserved", journey && !journey.departed);
check(
  "grace-period departure has exactly one verb",
  departureText(journey.depAbs, 1360.75) === "<b>departed</b> 1 min ago",
);
const [missed] = findJourneys(schedule, "JSQ", "09S", 1400, 1361.1, null, nowMs);
check("missed context is still flagged after the grace period", missed?.departed === true);

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
