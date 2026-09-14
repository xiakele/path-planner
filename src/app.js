// PATH Planner — find trains that arrive at a chosen station by a chosen time.
// Schedule data comes from data/schedule.json (refresh with pnpm update:schedule).
// Journey search lives in search.js.

import { findJourneys } from "./search.js";

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

const fromSelect = document.getElementById("fromSelect");
const toSelect = document.getElementById("toSelect");
const swapBtn = document.getElementById("swapBtn");
const destLabel = document.getElementById("destLabel");
const timePicker = document.getElementById("timePicker");
const nowTime = document.getElementById("nowTime");
const findBtn = document.getElementById("findBtn");
const againBtn = document.getElementById("againBtn");
const resultsSection = document.getElementById("resultsSection");
const resultsTitle = document.getElementById("resultsTitle");
const resultsSubtitle = document.getElementById("resultsSubtitle");
const resultList = document.getElementById("resultList");
const resultsError = document.getElementById("resultsError");
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
  return `<b>departed</b> ${-diff} min ago`;
}

// ---------- rendering ----------

function renderResults(from, to, targetMinutes) {
  const journeys = findJourneys(schedule, from, to, targetMinutes, nowMinutes());
  const dayLabel = new Date().toLocaleDateString("en-US", { weekday: "long" });

  resultsTitle.innerHTML = `If you want to arrive at <span class="accent">${STATIONS[to]}</span> by ${fmtTime(targetMinutes)}…`;
  resultsSubtitle.textContent = `You can catch one of these trains from ${STATIONS[from]} (${dayLabel} schedule):`;

  resultList.innerHTML = "";
  resultsError.hidden = true;
  resultList.hidden = false;

  if (journeys.length === 0) {
    resultsSubtitle.textContent = `Even with transfers, no connection from ${STATIONS[from]} arrives by ${fmtTime(targetMinutes)}.`;
    resultsError.hidden = false;
    resultsError.textContent =
      "Try an earlier arrival time — or an earlier train leaves you time to spare.";
    return;
  }

  const mNow = nowMinutes();
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

    const when =
      depAbs >= 1440 || arrAbs >= 1440 ? " <span class='dep-station'>(next day)</span>" : "";
    item.innerHTML = `
      <div class="time-list__main">
        <span class="time-list__text">${fmtTime(depAbs)}</span>
        <span class="dep-station">from ${STATIONS[from]}${when}</span>
        ${idx === suggestedIdx ? "<span class='tag'>suggested</span>" : ""}
      </div>
      <div class="time-list__legs">
        ${legs
          .map((leg, li) => {
            const legRow = `
          <div class="time-list__leg">
            <span class="line-chip" style="--c:${leg.line.color}"></span>
            <span class="line-name">${leg.line.name}</span>
            <span class="leg-times"><b>${fmtTime(leg.board.time)}</b> ${STATIONS[leg.board.stop]} → <b>${fmtTime(leg.alight.time)}</b> ${STATIONS[leg.alight.stop]}</span>
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
  renderResults(from, to, pickedMinutes());
  resultsSection.classList.remove("content-section_hidden");
  setTimeout(() => {
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 50);
}

// ---------- clock ----------

function updateNowTime() {
  nowTime.textContent = fmtTime(nowMinutes());
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
  setInterval(updateNowTime, 30000);

  findBtn.addEventListener("click", showResults);
  againBtn.addEventListener("click", () => {
    timePicker.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

boot().catch((err) => {
  console.error(err);
  nowTime.textContent = "schedule failed to load";
});
