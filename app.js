// PATH Planner — find trains that arrive at a chosen station by a chosen time.
// Schedule data comes from data/schedule.json (refresh with pnpm update:schedule).

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

function dayKeyFor(date) {
  const dow = date.getDay();
  if (dow === 6) return "saturday";
  if (dow === 0) return "sunday";
  return "weekday";
}

// "12" -> 0, "1".."11" -> 1..11; plus meridiem offset
function pickedMinutes() {
  const hour = parseInt(pickerState.hour, 10);
  const minute = parseInt(pickerState.minute, 10);
  const h24 = (hour % 12) + (pickerState.meridiem === "PM" ? 12 : 0);
  return h24 * 60 + minute;
}

// ---------- route selects ----------

function reachableToStations(from) {
  const tos = new Set();
  for (const lines of Object.values(schedule.days)) {
    for (const line of lines) {
      const i = line.stops.indexOf(from);
      if (i >= 0) {
        for (const stop of line.stops.slice(i + 1)) tos.add(stop);
      }
    }
  }
  return tos;
}

function fillFromSelect() {
  for (const code of STATION_ORDER) {
    fromSelect.add(new Option(STATIONS[code], code));
  }
  fromSelect.value = "JSQ";
}

function fillToSelect() {
  const from = fromSelect.value;
  const reachable = reachableToStations(from);
  toSelect.options.length = 0;
  for (const code of STATION_ORDER) {
    if (code !== from && reachable.has(code)) {
      toSelect.add(new Option(STATIONS[code], code));
    }
  }
  if (![...toSelect.options].some((o) => o.value === "09S")) {
    toSelect.value = toSelect.options[0]?.value ?? "";
  } else {
    toSelect.value = "09S";
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

// Returns up to 3 candidates: the latest trips departing from `from` that
// arrive at `to` no later than the entered time (interpreted as the next
// occurrence). Two sources are searched:
//   - tonight's remaining service (today's table, departures still ahead),
//     plus recently departed trains as "missed" context;
//   - tomorrow's table, which also covers departures after tonight's midnight
//     (PATH tables are per calendar day, e.g. Saturday 00:10 runs Friday night).
function findTrains(from, to, enteredMinutes, mNow = nowMinutes()) {
  const GRACE = 1;
  const target = enteredMinutes < mNow ? enteredMinutes + 1440 : enteredMinutes;

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const candidates = [];

  // Collect every usable trip of `lines`, shifting the table's clock times by
  // `base` minutes into absolute time (0 = today, 1440 = tomorrow).
  const consider = (lines, base, { departed = false, futureOnly = false } = {}) => {
    for (const line of lines) {
      const i = line.stops.indexOf(from);
      const j = line.stops.indexOf(to);
      if (i < 0 || j < 0 || i >= j) continue;

      for (const trip of line.trips) {
        const dep = trip[i];
        const arr = trip[j];
        if (dep === null || arr === null) continue;

        const depMin = parseInt(dep.slice(0, 2), 10) * 60 + parseInt(dep.slice(3), 10);
        const arrMin = parseInt(arr.slice(0, 2), 10) * 60 + parseInt(arr.slice(3), 10);
        // Arrival earlier on the clock means the trip crosses midnight
        const arrAdj = arrMin < depMin ? arrMin + 1440 : arrMin;

        if (futureOnly && depMin < mNow - GRACE) continue;

        const depAbs = base + depMin;
        const arrAbs = base + arrAdj;

        if (arrAbs <= target) {
          candidates.push({ line, depAbs, arrAbs, departed });
        }
      }
    }
  };

  // Tonight: today's table, departures still ahead of "now"
  consider(schedule.days[dayKeyFor(today)] ?? [], 0, { futureOnly: true });
  // Tonight's already-departed trains — context only while the target is still today
  if (target <= 1440) {
    consider(schedule.days[dayKeyFor(today)] ?? [], 0, { departed: true });
  }
  // Tomorrow's table (also serves departures after midnight tonight)
  consider(schedule.days[dayKeyFor(tomorrow)] ?? [], 1440);

  // Latest-arriving trains first — the closest usable options to the target
  candidates.sort((a, b) => b.arrAbs - a.arrAbs);
  return candidates.slice(0, 3);
}

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
  const trains = findTrains(from, to, targetMinutes);
  const dayLabel = new Date().toLocaleDateString("en-US", { weekday: "long" });

  resultsTitle.innerHTML = `If you want to arrive at <span class="accent">${STATIONS[to]}</span> by ${fmtTime(targetMinutes)}…`;
  resultsSubtitle.textContent = `You can catch one of these trains from ${STATIONS[from]} (${dayLabel} schedule):`;

  resultList.innerHTML = "";
  resultsError.hidden = true;
  resultList.hidden = false;

  if (trains.length === 0) {
    resultsSubtitle.textContent = `There is no direct train from ${STATIONS[from]} that arrives by ${fmtTime(targetMinutes)}.`;
    resultsError.hidden = false;
    resultsError.textContent =
      "Try an earlier arrival time — or an earlier train leaves you time to spare.";
    return;
  }

  const mNow = nowMinutes();
  const suggestedIdx = trains.findIndex((t) => !t.departed);
  trains.forEach((train, idx) => {
    const { line, depAbs, arrAbs, departed } = train;
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
      <div class="time-list__meta">
        <span class="line-chip" style="--c:${line.color}"></span>
        <span class="line-name">${line.name}</span>
        <span class="arrival">arrives <b>${fmtTime(arrAbs)}</b> at ${STATIONS[to]}</span>
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
