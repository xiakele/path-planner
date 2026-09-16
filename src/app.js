// PATH Planner — find trains that arrive at a chosen station by a chosen time.
// Schedule data comes from data/schedule.json (refresh with pnpm update:schedule).
// Journey search lives in search.js.

import { findJourneys } from "./search.js";
import { buildDelays, normalizeRt, STALE_AFTER_MS } from "./realtime.js";
import { DEPARTURES_WINDOW_MIN, findDepartures } from "./departures.js";

const STATIONS = {
  NWK: "Newark",
  HAR: "Harrison",
  JSQ: "Journal Square",
  GRO: "Grove Street",
  EXC: "Exchange Place",
  NEW: "Newport",
  HOB: "Hoboken",
  CHR: "Christopher Street",
  "09S": "9th Street",
  "14S": "14th Street",
  "23S": "23rd Street",
  "33S": "33rd Street",
  WTC: "World Trade Center",
};

// Display order (north-to-south along each corridor, terminals first)
const STATION_ORDER = [
  "NWK",
  "HAR",
  "JSQ",
  "GRO",
  "EXC",
  "NEW",
  "HOB",
  "CHR",
  "09S",
  "14S",
  "23S",
  "33S",
  "WTC",
];

const ITEM_H = 44;

let schedule = null;
let rt = null; // normalized real-time snapshot; null = timetable-only
let lastQuery = null; // { from, to, targetMinutes } of the rendered results
let lastBoard = null; // { station, to, mode } of the rendered departure board

const fromSelect = document.getElementById("fromSelect");
const toSelect = document.getElementById("toSelect");
const swapBtn = document.getElementById("swapBtn");
const destLabel = document.getElementById("destLabel");
const timePicker = document.getElementById("timePicker");
const nowTime = document.getElementById("nowTime");
const findBtn = document.getElementById("findBtn");
const departuresBtn = document.getElementById("departuresBtn");
const againBtn = document.getElementById("againBtn");
const resultsSection = document.getElementById("resultsSection");
const resultsTitle = document.getElementById("resultsTitle");
const resultsSubtitle = document.getElementById("resultsSubtitle");
const resultList = document.getElementById("resultList");
const resultsError = document.getElementById("resultsError");
const liveStatus = document.getElementById("liveStatus");
const departuresSection = document.getElementById("departuresSection");
const departuresTitle = document.getElementById("departuresTitle");
const departuresSubtitle = document.getElementById("departuresSubtitle");
const departuresList = document.getElementById("departuresList");
const departuresError = document.getElementById("departuresError");
const departuresLiveStatus = document.getElementById("departuresLiveStatus");
const departuresAgainBtn = document.getElementById("departuresAgainBtn");
const boardRouteOpt = document.getElementById("boardRouteOpt");
const boardAllOpt = document.getElementById("boardAllOpt");
const fetchedDate = document.getElementById("fetchedDate");

// ---------- helpers ----------

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Minutes since midnight (24h) -> "12:10 AM"
function fmtTime(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(mm)} ${ampm}`;
}

// Minutes -> "51 min" / "1 h 09 min"
function fmtDur(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
}

// Compact line names for the result cards ("JSQ – 33 St via HOB"): terminals
// as signed in the stations, shorter readable forms elsewhere; derived from
// the line's stops so timetable changes need no maintenance here, falling
// back to the full timetable name for anything unfamiliar
const SHORT_STOP = {
  NWK: "NWK",
  HAR: "HAR",
  JSQ: "JSQ",
  GRO: "Grove St",
  EXC: "Exchange Pl",
  NEW: "Newport",
  HOB: "HOB",
  CHR: "Christopher St",
  "09S": "9 St",
  "14S": "14 St",
  "23S": "23 St",
  "33S": "33 St",
  WTC: "WTC",
};

function lineShortName(line) {
  const a = SHORT_STOP[line.stops[0]];
  const b = SHORT_STOP[line.stops[line.stops.length - 1]];
  if (!a || !b) return line.name;
  const via = line.name.includes("(via Hoboken)") ? " via HOB" : "";
  return `${a} – ${b}${via}`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// "12" -> 0, "1".."11" -> 1..11; plus meridiem offset
function pickedMinutes() {
  const hour = parseInt(pickerState.hour, 10);
  const minute = parseInt(pickerState.minute, 10);
  const h24 = (hour % 12) + (pickerState.meridiem === "PM" ? 12 : 0);
  return h24 * 60 + minute;
}

// ---------- route selects ----------

function fillFromSelect() {
  for (const code of STATION_ORDER) {
    fromSelect.add(new Option(STATIONS[code], code));
  }
  fromSelect.value = "JSQ";
}

function fillToSelect() {
  const from = fromSelect.value;
  const previous = toSelect.value;
  toSelect.options.length = 0;
  // Every station is reachable from every other via transfers, so list them all
  for (const code of STATION_ORDER) {
    if (code !== from) {
      toSelect.add(new Option(STATIONS[code], code));
    }
  }
  // Keep the user's destination across "From" changes; only a From/To
  // collision needs a reset
  if (previous && previous !== from) {
    toSelect.value = previous;
  } else {
    toSelect.value = "09S" === from ? (toSelect.options[0]?.value ?? "") : "09S";
  }
  destLabel.textContent = STATIONS[toSelect.value] ?? toSelect.value;
}

// ---------- drum time picker ----------

const pickerState = { hour: "12", minute: "00", meridiem: "AM" };
const wraps = {};

function buildColumn(wrap, values, initialIndex) {
  const ul = wrap.querySelector(".select-options");
  ul.innerHTML = "";
  values.forEach((value, idx) => {
    const li = document.createElement("li");
    li.textContent = value;
    li.dataset.value = value;
    li.addEventListener("click", () => {
      wrap.scrollTo({ top: idx * ITEM_H, behavior: "smooth" });
    });
    ul.appendChild(li);
  });
  wrap.addEventListener("scroll", () => markActive(wrap, values), { passive: true });
  wrap.scrollTo({ top: initialIndex * ITEM_H, behavior: "instant" });
  markActive(wrap, values);
}

function markActive(wrap, values) {
  const idx = Math.max(0, Math.min(values.length - 1, Math.round(wrap.scrollTop / ITEM_H)));
  const value = values[idx];
  pickerState[wrap.dataset.col] = value;
  for (const [i, li] of wrap.querySelectorAll(".select-options li").entries()) {
    li.classList.toggle("active", i === idx);
  }
}

function initPicker() {
  for (const wrap of timePicker.querySelectorAll(".select-wrap")) {
    wraps[wrap.dataset.col] = wrap;
  }
  const hours = ["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
  const minutes = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

  // Default arrival: ~35 min from now, rounded up to the next 5-minute mark
  const def = Math.ceil((nowMinutes() + 35) / 5) * 5;
  const defH24 = Math.floor((def % 1440) / 60);
  const defMeridiem = defH24 >= 12 ? "PM" : "AM";
  const defHour = defH24 % 12 === 0 ? 12 : defH24 % 12;

  buildColumn(wraps.hour, hours, hours.indexOf(String(defHour)));
  buildColumn(wraps.minute, minutes, minutes.indexOf(pad2(def % 60)));
  buildColumn(wraps.meridiem, ["AM", "PM"], defMeridiem === "PM" ? 1 : 0);
}

// ---------- schedule lookup ----------

// Delegates to search.js (transfer-aware journey search). Journeys carry
// legs: [{line, board:{stop,time}, alight:{stop,time}}], plus depAbs / arrAbs
// (absolute minutes) and a `departed` flag for missed-context options.

function offsetText(depAbs, mNow) {
  const diff = Math.round(depAbs - mNow);
  if (Math.abs(diff) < 1) return "leaving now";
  if (diff > 0) {
    if (diff < 60) return `in <b>${diff} min</b>`;
    return `in <b>${Math.floor(diff / 60)} h ${diff % 60} min</b>`;
  }
  // Missed context can be hours old (yesterday's last trains); format the
  // long ones like the "in" branch does
  if (-diff >= 60) return `<b>departed</b> ${Math.floor(-diff / 60)} h ${-diff % 60} min ago`;
  return `<b>departed</b> ${-diff} min ago`;
}

// Badge for an observed delay (undefined = no live match, so no badge):
// on time (green) / late (gold) / early (muted). Shared by journey legs and
// the departure board rows.
function delayBadge(delay) {
  if (delay === undefined) return "";
  if (delay > 0) return `<span class="leg-badge leg-badge_late">+${delay} min</span>`;
  if (delay < 0) return `<span class="leg-badge leg-badge_early">${-delay} min early</span>`;
  return `<span class="leg-badge leg-badge_ontime">on time</span>`;
}

// ---------- real-time feed ----------

// Just above the proxy's 15 s response cache: every poll then returns fresh
// upstream-derived data, while polling faster would only re-download the
// identical cached payload
const POLL_MS = 16000;

// Poll the serverless proxy (api/realtime.js). On failure keep the last
// snapshot until it goes stale, so one dropped poll doesn't flip the results
// back to timetable times.
async function refreshRealtime() {
  try {
    const res = await fetch("api/realtime");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = normalizeRt(await res.json(), Date.now());
    if (next) rt = next;
  } catch {
    /* proxy missing (plain static serving) or unreachable: keep the last snapshot */
  }
  if (rt && Date.now() - rt.fetchedAt > STALE_AFTER_MS) rt = null;
  for (const el of visibleStatusEls()) updateLiveStatus(el);
}

// Which freshness pills are currently on screen (journey results, departure
// board, or neither) — only those need updating
function visibleStatusEls() {
  const els = [];
  if (!resultsSection.classList.contains("content-section_hidden")) els.push(liveStatus);
  if (!departuresSection.classList.contains("content-section_hidden")) {
    els.push(departuresLiveStatus);
  }
  return els;
}

// Freshness pill in a section header ("real-time · updated Ns ago" vs.
// timetable-only). The age is recomputed on every call, so the 1 s ticker
// below keeps it counting honestly between polls.
function updateLiveStatus(el) {
  if (rt) {
    const age = Math.max(0, Math.round((Date.now() - rt.fetchedAt) / 1000));
    el.innerHTML = "<span class='live-dot'></span>real-time · updated " + age + "s ago";
  } else {
    el.textContent = "timetable times only — real-time status unavailable";
  }
  el.hidden = false;
}

// 1 s ticker for the pills' age counters — a single text update per second;
// browsers throttle timers in hidden tabs, so it effectively idles there
function tickStatus() {
  if (document.hidden) return;
  for (const el of visibleStatusEls()) updateLiveStatus(el);
}

// ---------- rendering ----------

function renderResults(from, to, targetMinutes) {
  const mNow = nowMinutes();
  // Trips observed running off-timetable are shifted before searching, so
  // catchability, transfers and arrivals reflect real-time reality
  const adjust = buildDelays(schedule, rt, mNow);
  const journeys = findJourneys(schedule, from, to, targetMinutes, mNow, adjust);
  const dayLabel = new Date().toLocaleDateString("en-US", { weekday: "long" });

  // Keep the freshness pill in step with whatever is on screen (the 1 s
  // ticker covers it between polls)
  updateLiveStatus(liveStatus);

  resultsTitle.innerHTML = `If you want to arrive at <span class="accent">${STATIONS[to]}</span> by ${fmtTime(targetMinutes)}…`;
  resultsSubtitle.textContent = `You can catch one of these trains from ${STATIONS[from]} (${dayLabel} schedule):`;

  resultList.innerHTML = "";
  resultsError.hidden = true;
  resultList.hidden = false;

  if (journeys.length === 0) {
    resultsSubtitle.textContent = `Even with transfers, no connection from ${STATIONS[from]} arrives by ${fmtTime(targetMinutes)}.`;
    resultsError.hidden = false;
    resultsError.textContent = "No train gets you there that early — pick a later time.";
    return;
  }

  const suggestedIdx = journeys.findIndex((j) => !j.departed);
  if (suggestedIdx === -1) {
    resultsSubtitle.textContent = `No catchable train — these are the latest ones that would have arrived in time:`;
  }
  journeys.forEach((journey, idx) => {
    const { legs, depAbs, arrAbs, departed } = journey;
    const item = document.createElement("div");
    item.className =
      "time-list__item" +
      (idx === suggestedIdx ? " time-list__item_suggested" : "") +
      (departed ? " time-list__item_departed" : "");

    // Header: the departure is the headline; the (already delay-adjusted)
    // arrival and total duration follow at a smaller size. Each time carries
    // its own "(next day)" tag and a struck-through timetable "was" when its
    // leg is running off-timetable
    const depDelay = legs[0]?.delay;
    const arrDelay = legs[legs.length - 1]?.delay;
    const depWas = depDelay ? ` <s class="dep-was">${fmtTime(depAbs - depDelay)}</s>` : "";
    const arrWas = arrDelay ? ` <s class="arr-was">${fmtTime(arrAbs - arrDelay)}</s>` : "";
    const depNext = depAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
    const arrNext = arrAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
    item.innerHTML = `
      <div class="time-list__main">
        <span class="time-list__text">${fmtTime(depAbs)}${depWas}${depNext}</span>
        <span class="time-list__arr"><span class="arrow">→</span> ${fmtTime(arrAbs)}${arrWas}${arrNext}</span>
        <span class="dep-station">· ${fmtDur(arrAbs - depAbs)}</span>
        ${idx === suggestedIdx ? "<span class='tag'>suggested</span>" : ""}
      </div>
      <div class="time-list__legs">
        ${legs
          .map((leg, li) => {
            // Per-leg live badge from the matched feed entry; adjusted times
            // with the timetable time struck through when they differ
            const badge = delayBadge(leg.delay);
            const times = (t) =>
              leg.delay
                ? `<b>${fmtTime(t)}</b> <s class="leg-was">${fmtTime(t - leg.delay)}</s>`
                : `<b>${fmtTime(t)}</b>`;
            // Identity row (chip + short line name + badge), times below it —
            // nothing shares a line, so nothing gets cut off
            const legRow = `
          <div class="time-list__leg">
            <div class="leg-head">
              <span class="line-chip" style="--c:${leg.line.color}"></span>
              <span class="line-name">${lineShortName(leg.line)}</span>
              ${badge}
            </div>
            <div class="leg-times">${times(leg.board.time)} ${STATIONS[leg.board.stop]} → ${times(leg.alight.time)} ${STATIONS[leg.alight.stop]}</div>
          </div>`;
            if (li === legs.length - 1) return legRow;
            const wait = legs[li + 1].board.time - leg.alight.time;
            return `${legRow}
          <div class="time-list__transfer">transfer at ${STATIONS[leg.alight.stop]} · wait ${wait} min</div>`;
          })
          .join("")}
      </div>
      <div class="offset">${departed ? "" : "departs "}${offsetText(depAbs, mNow)}</div>
    `;
    resultList.appendChild(item);
  });
}

function showResults() {
  const from = fromSelect.value;
  const to = toSelect.value;
  if (!from || !to || from === to) return;

  destLabel.textContent = STATIONS[to];
  lastQuery = { from, to, targetMinutes: pickedMinutes() };
  renderResults(from, to, lastQuery.targetMinutes);
  // One view at a time: the departure board hides while results are up
  departuresSection.classList.add("content-section_hidden");
  resultsSection.classList.remove("content-section_hidden");
  setTimeout(() => {
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 50);
}

// ---------- departure board ----------

// Board for the "From" station. Two scopes, switched by the segmented control
// above the list:
//   route (default) — only trains that connect to the current "To" station
//     (direct or with transfers), each with the estimated arrival there;
//   all — everything leaving the station within the window.
// Rows come back nearest-departure-first, so the list reads top-to-bottom as
// "what's next".
function renderDepartures(board) {
  const { station, to, mode } = board;
  const mNow = nowMinutes();
  const rows =
    mode === "route"
      ? findDepartures(schedule, station, mNow, Date.now(), rt, to)
      : findDepartures(schedule, station, mNow, Date.now(), rt);
  const dayLabel = new Date().toLocaleDateString("en-US", { weekday: "long" });

  // Keep the freshness pill in step with whatever is on screen (the 1 s
  // ticker covers it between polls)
  updateLiveStatus(departuresLiveStatus);

  departuresTitle.innerHTML = `Next trains from <span class="accent">${STATIONS[station]}</span>`;
  departuresSubtitle.textContent =
    mode === "route"
      ? `Toward ${STATIONS[to]} — direct or with transfers, leaving within ${DEPARTURES_WINDOW_MIN} minutes (${dayLabel} schedule):`
      : `Leaving within ${DEPARTURES_WINDOW_MIN} minutes (${dayLabel} schedule):`;

  // Scope switch: the route option's label follows the current destination
  boardRouteOpt.textContent = `To ${STATIONS[to]}`;
  boardRouteOpt.setAttribute("aria-pressed", String(mode === "route"));
  boardAllOpt.setAttribute("aria-pressed", String(mode === "all"));

  departuresList.innerHTML = "";
  departuresError.hidden = true;
  departuresList.hidden = false;

  if (rows.length === 0) {
    if (mode === "route") {
      departuresSubtitle.textContent = `No trains leaving ${STATIONS[station]} in the next ${DEPARTURES_WINDOW_MIN} minutes connect to ${STATIONS[to]}.`;
      departuresError.textContent =
        "Try All trains for everything leaving the station, or Find trains for later connections.";
    } else {
      departuresSubtitle.textContent = `No trains are due from ${STATIONS[station]} in the next ${DEPARTURES_WINDOW_MIN} minutes.`;
      departuresError.textContent =
        "Late-night service runs rarely — the board refreshes automatically.";
    }
    departuresError.hidden = false;
    return;
  }

  for (const row of rows) {
    const departed = row.depAbs < mNow;
    const item = document.createElement("div");
    item.className = "time-list__item" + (departed ? " time-list__item_departed" : "");
    // Headline time (delay-adjusted, "(next day)" tag when past midnight)
    // with the timetable "was" struck through when the train runs late
    const was = row.delay ? ` <s class="dep-was">${fmtTime(row.depAbs - row.delay)}</s>` : "";
    const next = row.depAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
    // Route mode: the estimated arrival at the destination follows the
    // departure (connection-scan's earliest, transfer waits included), with
    // its own "was" when the arrival leg runs off-timetable
    let arrHtml = "";
    if (row.arrAbs !== undefined) {
      const arrDelay = row.legs[row.legs.length - 1]?.delay;
      const arrWas = arrDelay ? ` <s class="arr-was">${fmtTime(row.arrAbs - arrDelay)}</s>` : "";
      const arrNext = row.arrAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
      arrHtml = ` <span class="time-list__arr"><span class="arrow">→</span> ${fmtTime(row.arrAbs)}${arrWas}${arrNext}</span> <span class="dep-station">· ${fmtDur(row.arrAbs - row.depAbs)}</span>`;
    }
    // Feed-only extras have no line: a dashed chip in the feed's color and
    // the destination stand in for the line identity
    const chipColor = row.line ? row.line.color : (row.colors?.[0] ?? "");
    const chip = `<span class="line-chip${row.fromFeed ? " line-chip_feed" : ""}" style="--c:${chipColor}"></span>`;
    const name = row.line
      ? lineShortName(row.line)
      : `to ${STATIONS[row.terminus] ?? row.terminus}`;
    const badge = row.fromFeed
      ? `<span class="leg-badge leg-badge_live">live</span>`
      : delayBadge(row.delay);
    // Multi-leg rows: one compact line per change of trains, so a first leg
    // that isn't itself headed to the destination still makes sense
    let transfers = "";
    if (row.legs && row.legs.length > 1) {
      transfers = `<div class="time-list__legs">${row.legs
        .slice(0, -1)
        .map((leg, li) => {
          const nextLeg = row.legs[li + 1];
          const wait = Math.round(nextLeg.board.time - leg.alight.time);
          return `<div class="time-list__transfer">transfer at ${STATIONS[leg.alight.stop]} to ${lineShortName(nextLeg.line)} · wait ${wait} min</div>`;
        })
        .join("")}</div>`;
    }
    item.innerHTML = `
      <div class="time-list__main">
        <span class="time-list__text">${fmtTime(row.depAbs)}${was}${next}</span>${arrHtml}
        ${chip}<span class="line-name">${name}</span>
        ${badge}
      </div>
      ${transfers}
      <div class="offset">${departed ? "" : "departs "}${offsetText(row.depAbs, mNow)}</div>
    `;
    departuresList.appendChild(item);
  }
}

function showDepartures() {
  const station = fromSelect.value;
  const to = toSelect.value;
  if (!station || !to || station === to) return;

  // Fresh opens always start scoped to the current route; the switch toggles
  // within the open board (and the poll re-render keeps the chosen mode)
  lastBoard = { station, to, mode: "route" };
  renderDepartures(lastBoard);
  // One view at a time: journey results hide while the board is up
  resultsSection.classList.add("content-section_hidden");
  departuresSection.classList.remove("content-section_hidden");
  setTimeout(() => {
    departuresSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 50);
}

// Scope switch handler: re-render in place, no scrolling (the list is where
// the eye already is)
function setBoardMode(mode) {
  if (!lastBoard || lastBoard.mode === mode) return;
  lastBoard.mode = mode;
  renderDepartures(lastBoard);
}

// ---------- clock & polling ----------

function updateNowTime() {
  nowTime.textContent = fmtTime(nowMinutes());
}

// Every POLL_MS: refresh the clock, poll the real-time feed and, while a
// view is on screen, re-render it with the fresh snapshot (delays can turn a
// missed train catchable or vice versa; the board rolls forward with "now").
// Hidden tabs skip the poll; the visibilitychange handler in boot() catches
// up on return.
function tick() {
  updateNowTime();
  if (document.hidden) return;
  refreshRealtime().then(() => {
    if (document.hidden) return;
    if (lastQuery && !resultsSection.classList.contains("content-section_hidden")) {
      renderResults(lastQuery.from, lastQuery.to, lastQuery.targetMinutes);
    }
    if (lastBoard && !departuresSection.classList.contains("content-section_hidden")) {
      renderDepartures(lastBoard);
    }
  });
}

// ---------- boot ----------

async function boot() {
  const res = await fetch("data/schedule.json");
  schedule = await res.json();
  fetchedDate.textContent = new Date(schedule.generatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  fillFromSelect();
  fillToSelect();
  fromSelect.addEventListener("change", () => {
    fillToSelect();
  });
  toSelect.addEventListener("change", () => {
    destLabel.textContent = STATIONS[toSelect.value];
  });
  swapBtn.addEventListener("click", () => {
    const previousFrom = fromSelect.value;
    fromSelect.value = toSelect.value;
    fromSelect.dispatchEvent(new Event("change"));
    toSelect.value = previousFrom;
    toSelect.dispatchEvent(new Event("change"));
  });

  initPicker();
  updateNowTime();
  refreshRealtime(); // first poll; the pill fills in when results are shown
  setInterval(tick, POLL_MS);
  setInterval(tickStatus, 1000); // 1 s freshness ticker
  // Back from a background tab: catch up immediately if the snapshot has
  // aged past the proxy cache window, instead of waiting for the next tick
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (!rt || Date.now() - rt.fetchedAt > POLL_MS - 1000)) {
      tick();
    }
  });

  findBtn.addEventListener("click", showResults);
  departuresBtn.addEventListener("click", showDepartures);
  boardRouteOpt.addEventListener("click", () => setBoardMode("route"));
  boardAllOpt.addEventListener("click", () => setBoardMode("all"));
  againBtn.addEventListener("click", () => {
    timePicker.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  departuresAgainBtn.addEventListener("click", () => {
    document.querySelector(".route-picker").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

boot().catch((err) => {
  console.error(err);
  nowTime.textContent = "schedule failed to load";
});
