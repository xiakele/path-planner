// PATH Planner — find trains that arrive at a chosen station by a chosen time.
// Schedule data comes from data/schedule.json (refresh with pnpm update:schedule).
// Journey search lives in search.js.

import { findJourneys } from "./search.js";
import { buildRealtimeModel, normalizeRt, STALE_AFTER_MS } from "./realtime.js";
import { DEPARTURES_WINDOW_MIN, findDepartures } from "./departures.js";
// One formatter owns the whole phrase, independent of each view's grace period.
import { departureText } from "./format.js";

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
// Stop detail popup, shared by the journey cards and the board rows (one
// dialog at page level, filled per click — see the popup section below)
const popup = document.getElementById("popup");
const popupBackdrop = document.getElementById("popupBackdrop");
const popupTitle = document.getElementById("popupTitle");
const popupBody = document.getElementById("popupBody");
const popupClose = document.getElementById("popupClose");

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

function nowMinutes(nowMs = Date.now()) {
  const d = new Date(nowMs);
  // Keep the same fractional clock as feed timestamps; round only for display.
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
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

// Badges describe the boarding stop, never a whole train. Inferred offsets
// are explicitly estimated; round only presentation, not routing inputs.
function delayBadge(delay, source) {
  if (delay === undefined) return "";
  const rounded = Math.round(delay);
  const prefix = source === "estimated" ? "est. " : "live · ";
  const text = rounded > 0 ? `+${rounded} min` : rounded < 0 ? `${-rounded} min early` : "on time";
  const style =
    source === "estimated"
      ? ""
      : rounded > 0
        ? " leg-badge_late"
        : rounded < 0
          ? ""
          : " leg-badge_ontime";
  return `<span class="leg-badge${style}">${prefix}${text}</span>`;
}

// Each endpoint/stop exposes its own evidence, including timetable-only
// fallbacks, so an estimated arrival cannot masquerade as a live prediction.
function timeSource(source = "timetable") {
  const text = source === "estimated" ? "est." : source === "live" ? "live" : "sched.";
  const title =
    source === "estimated"
      ? "Estimated from other stops"
      : source === "live"
        ? "Prediction at this stop"
        : "Timetable only";
  return ` <small class="time-source" title="${title}">${text}</small>`;
}

// Sub-minute shifts can round to the same displayed time; don't strike out
// an identical "was" time, but retain the full precision in the data model.
function wasTime(point, className) {
  if (!point || Math.round(point.time) === Math.round(point.scheduledTime)) return "";
  return ` <s class="${className}">${fmtTime(point.scheduledTime)}</s>`;
}

function pointTime(point) {
  return `<b>${fmtTime(point.time)}</b>${wasTime(point, "leg-was")}${timeSource(point.source)}`;
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

// ---------- stop detail popup ----------

// Open popup state: { kind: "journey" | "departure", key, item, listEl,
// restoreFocus } — `key` identifies the train across list re-renders, `item`
// is the journey/row currently displayed
let popupState = null;

// Timetable identities survive changed departure predictions. Feed-only
// entries have no train IDs, so their time/destination remain the fallback.
function journeyKey(j) {
  return `${j.legs[0].tripId}|${j.legs[0].board.stop}`;
}

function departureKey(row) {
  return row.id ?? `${row.depAbs}|${row.terminus}|feed`;
}

// "(next day)" tag for absolute minutes past midnight — same convention the
// cards use for their headline times
function nextDayTag(t) {
  return t >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
}

// One stop row of the timeline: colored dot, station name and its
// (delay-adjusted) ETA, with the timetable "was" struck through when the
// stop's own prediction differs. Origin/destination rows get highlighted.
function stopRow(point, color, endpoint) {
  const { stop, time } = point;
  const style = color ? ` style="--c:${color}"` : "";
  return `
      <div class="popup__stop${endpoint ? " popup__stop_endpoint" : ""}"${style}>
        <span class="popup__dot"></span>
        <span class="popup__name">${STATIONS[stop] ?? stop}</span>
        <span class="popup__time">${pointTime(point)}${nextDayTag(time)}</span>
      </div>`;
}

// Timeline for a chain of legs: each leg's identity row (chip + short name +
// live badge) followed by its stops with ETAs. A transfer station appears
// twice — arrival row closing the previous leg, departure row opening the
// next — with the "change to …" row between them, so the stated wait is
// verifiable against the on-screen times.
function legsTimelineHtml(legs) {
  let html = "";
  legs.forEach((leg, li) => {
    if (li > 0) {
      const wait = Math.round(leg.board.time - legs[li - 1].alight.time);
      html += `<div class="popup__transfer">change to ${lineShortName(leg.line)} · wait ${wait} min</div>`;
    }
    const last = li === legs.length - 1;
    html += `
      <div class="popup__leg">
        <div class="leg-head">
          <span class="line-chip" style="--c:${leg.line.color}"></span>
          <span class="line-name">${lineShortName(leg.line)}</span>
          ${delayBadge(leg.board.delay, leg.board.source)}
        </div>
        ${leg.stops
          .map((s, si) => {
            const endpoint = (li === 0 && si === 0) || (last && si === leg.stops.length - 1);
            return stopRow(s, leg.line.color, endpoint);
          })
          .join("")}
      </div>`;
  });
  return html;
}

// Journey result card: the headline mirrors the card itself (departure →
// arrival, "was" times struck through, "(next day)" tags, total duration),
// the body is the stop-by-stop timeline
function renderJourneyPopup(journey) {
  const { legs, depAbs, arrAbs } = journey;
  const depWas = wasTime(legs[0]?.board, "dep-was");
  const arrWas = wasTime(legs.at(-1)?.alight, "arr-was");
  popupTitle.innerHTML = `
    <b>${fmtTime(depAbs)}</b>${depWas}${timeSource(legs[0]?.board.source)}${nextDayTag(depAbs)}
    <span class="arrow">→</span>
    <b>${fmtTime(arrAbs)}</b>${arrWas}${timeSource(legs.at(-1)?.alight.source)}${nextDayTag(arrAbs)}
    <span class="dep-station">· ${fmtDur(arrAbs - depAbs)}</span>`;
  popupBody.innerHTML = legsTimelineHtml(legs);
}

// Departure board row: route-scoped rows and all-trains rows both carry
// legs (a connection path, or the single remaining ride to the terminus) and
// get the full timeline; feed-only extras have no timetable behind them, so
// the popup notes that instead of listing stops
function renderDeparturePopup(row) {
  const was = wasTime(row.legs?.[0]?.board, "dep-was");
  let arrHtml = "";
  if (row.arrAbs !== undefined) {
    const arrWas = wasTime(row.legs.at(-1)?.alight, "arr-was");
    arrHtml = ` <span class="arrow">→</span> <b>${fmtTime(row.arrAbs)}</b>${arrWas}${timeSource(row.legs.at(-1)?.alight.source)}${nextDayTag(row.arrAbs)} <span class="dep-station">· ${fmtDur(row.arrAbs - row.depAbs)}</span>`;
  }
  const terminusName = STATIONS[row.terminus] ?? row.terminus;
  if (row.fromFeed) {
    popupTitle.innerHTML = `<b>${fmtTime(row.depAbs)}</b>${nextDayTag(row.depAbs)} <span class="arrow">→</span> <b>to ${terminusName}</b>`;
    popupBody.innerHTML = `
      <div class="leg-head board-line">
        <span class="line-chip line-chip_feed" style="--c:${row.colors?.[0] ?? ""}"></span>
        <span class="line-name">to ${terminusName}</span>
        <span class="leg-badge leg-badge_live">live</span>
      </div>
      <p class="popup__note">Live-only train — no timetable behind it, so intermediate stops and ETAs are unavailable. It's bound for ${terminusName}.</p>`;
    return;
  }
  // All-trains rows have no destination arrival to headline — name the
  // terminus instead, matching the card's own line identity ("to …")
  const dirHtml = arrHtml || ` <span class="arrow">→</span> <b>to ${terminusName}</b>`;
  popupTitle.innerHTML = `<b>${fmtTime(row.depAbs)}</b>${was}${timeSource(row.source)}${nextDayTag(row.depAbs)}${dirHtml}`;
  popupBody.innerHTML = legsTimelineHtml(row.legs);
}

function renderPopupContent() {
  // Keep the scroll position across live-updates (the body scrolls when the
  // timeline outgrows the card, bottom-sheet style on small screens)
  const scrollTop = popupBody.scrollTop;
  if (popupState.kind === "journey") renderJourneyPopup(popupState.item);
  else renderDeparturePopup(popupState.item);
  popupBody.scrollTop = scrollTop;
}

function openPopup(kind, item, key, listEl) {
  popupState = { kind, key, item, listEl, restoreFocus: document.activeElement };
  renderPopupContent();
  popup.hidden = false;
  popupClose.focus();
}

function closePopup() {
  if (!popupState) return;
  const { restoreFocus, listEl } = popupState;
  popupState = null;
  popup.hidden = true;
  // The lists re-render on every poll, so the card that opened the popup may
  // already be gone — then park focus on the list it came from instead
  if (restoreFocus && restoreFocus.isConnected) {
    restoreFocus.focus();
  } else if (listEl) {
    listEl.tabIndex = -1; // make the list focusable just for this handoff
    listEl.focus({ preventScroll: true });
  }
}

// Live-update hook, called at the end of every list render (poll re-renders
// and board scope switches): when the popup is open over this list, find the
// same train in the fresh data and re-render its content in place, so delays
// stay current; a train that left the list closes the popup
function syncPopup(kind, items, keyOf) {
  if (!popupState || popupState.kind !== kind) return;
  const next = items.find((it) => keyOf(it) === popupState.key);
  if (!next) {
    closePopup();
    return;
  }
  popupState.item = next;
  renderPopupContent();
}

// Turn a result/board card into a button that opens the stop popup
function makeClickable(item, open) {
  item.classList.add("time-list__item_clickable");
  item.setAttribute("role", "button");
  item.setAttribute("tabindex", "0");
  item.addEventListener("click", open);
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
}

// ---------- rendering ----------

function renderResults(from, to, targetMinutes) {
  // One clock/model for both matching and routing, including day boundaries.
  const nowMs = Date.now();
  const mNow = nowMinutes(nowMs);
  const adjust = buildRealtimeModel(schedule, rt, mNow, nowMs);
  const journeys = findJourneys(schedule, from, to, targetMinutes, mNow, adjust, nowMs);
  // If the stop popup is open over this list, move it onto the fresh
  // journeys (a train that vanished closes it) — see syncPopup
  syncPopup("journey", journeys, journeyKey);
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
    const depWas = wasTime(legs[0]?.board, "dep-was");
    const arrWas = wasTime(legs.at(-1)?.alight, "arr-was");
    const depNext = depAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
    const arrNext = arrAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
    item.innerHTML = `
      <div class="time-list__main">
        <span class="time-list__text">${fmtTime(depAbs)}${depWas}${timeSource(legs[0]?.board.source)}${depNext}</span>
        <span class="time-list__arr"><span class="arrow">→</span> ${fmtTime(arrAbs)}${arrWas}${timeSource(legs.at(-1)?.alight.source)}${arrNext}</span>
        <span class="dep-station">· ${fmtDur(arrAbs - depAbs)}</span>
        ${idx === suggestedIdx ? "<span class='tag'>suggested</span>" : ""}
      </div>
      <div class="time-list__legs">
        ${legs
          .map((leg, li) => {
            // Boarding and alighting can have different offsets and sources.
            const badge = delayBadge(leg.board.delay, leg.board.source);
            // Identity row (chip + short line name + badge), times below it —
            // nothing shares a line, so nothing gets cut off
            const legRow = `
          <div class="time-list__leg">
            <div class="leg-head">
              <span class="line-chip" style="--c:${leg.line.color}"></span>
              <span class="line-name">${lineShortName(leg.line)}</span>
              ${badge}
            </div>
            <div class="leg-times">${pointTime(leg.board)} ${STATIONS[leg.board.stop]} → ${pointTime(leg.alight)} ${STATIONS[leg.alight.stop]}</div>
          </div>`;
            if (li === legs.length - 1) return legRow;
            const wait = Math.round(legs[li + 1].board.time - leg.alight.time);
            return `${legRow}
          <div class="time-list__transfer">transfer at ${STATIONS[leg.alight.stop]} · wait ${wait} min</div>`;
          })
          .join("")}
      </div>
      <div class="offset">${departureText(depAbs, mNow)}</div>
    `;
    // The whole card opens the stop-by-stop popup (click or Enter/Space)
    makeClickable(item, () => openPopup("journey", journey, journeyKey(journey), resultList));
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
  const nowMs = Date.now();
  const mNow = nowMinutes(nowMs);
  const rows =
    mode === "route"
      ? findDepartures(schedule, station, mNow, nowMs, rt, to)
      : findDepartures(schedule, station, mNow, nowMs, rt);
  // If the stop popup is open over this list, move it onto the fresh rows (a
  // train that left the window closes it) — see syncPopup
  syncPopup("departure", rows, departureKey);
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
    const was = wasTime(row.legs?.[0]?.board, "dep-was");
    const next = row.depAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
    // Route mode: the estimated arrival at the destination follows the
    // departure (connection-scan's earliest, transfer waits included), with
    // its own "was" when the arrival leg runs off-timetable
    let arrHtml = "";
    if (row.arrAbs !== undefined) {
      const arrWas = wasTime(row.legs.at(-1)?.alight, "arr-was");
      const arrNext = row.arrAbs >= 1440 ? " <span class='time-nextday'>(next day)</span>" : "";
      arrHtml = ` <span class="time-list__arr"><span class="arrow">→</span> ${fmtTime(row.arrAbs)}${arrWas}${timeSource(row.legs.at(-1)?.alight.source)}${arrNext}</span> <span class="dep-station">· ${fmtDur(row.arrAbs - row.depAbs)}</span>`;
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
      : delayBadge(row.delay, row.source);
    // Multi-leg rows: one compact line per change of trains, so a first leg
    // that isn't itself headed to the destination still makes sense
    let transfers = "";
    if (row.legs && row.legs.length > 1) {
      transfers = row.legs
        .slice(0, -1)
        .map((leg, li) => {
          const nextLeg = row.legs[li + 1];
          const wait = Math.round(nextLeg.board.time - leg.alight.time);
          return `<div class="time-list__transfer">transfer at ${STATIONS[leg.alight.stop]} to ${lineShortName(nextLeg.line)} · wait ${wait} min</div>`;
        })
        .join("");
    }
    // Line identity (chip + name + badge) on its own row under the headline
    // times, transfers tucked beneath it — same shape as the result cards
    item.innerHTML = `
      <div class="time-list__main">
        <span class="time-list__text">${fmtTime(row.depAbs)}${was}${next}</span>${arrHtml}
      </div>
      <div class="time-list__legs">
        <div class="leg-head board-line">
          ${chip}<span class="line-name">${name}</span>
          ${badge}
        </div>
        ${transfers}
      </div>
      <div class="offset">${departureText(row.depAbs, mNow)}</div>
    `;
    // The whole card opens the stop-by-stop popup (click or Enter/Space);
    // feed-only extras open it too, with a "no timetable" note instead of stops
    makeClickable(item, () => openPopup("departure", row, departureKey(row), departuresList));
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
  // Stop popup: backdrop or ✕ dismisses it; Esc closes and Tab stays inside
  // the dialog (the close button is its only control)
  popupBackdrop.addEventListener("click", closePopup);
  popupClose.addEventListener("click", closePopup);
  document.addEventListener("keydown", (e) => {
    if (!popupState) return;
    if (e.key === "Escape") closePopup();
    else if (e.key === "Tab") {
      e.preventDefault();
      popupClose.focus();
    }
  });
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
