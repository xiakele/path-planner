// Fetches PATH timetable pages from PANYNJ and parses the schedule tables
// into data/schedule.json. Run with: node scripts/update-schedule.mjs
// (or: pnpm update:schedule)

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SOURCES = {
  // The schedules hub page embeds its weekday / weekend / sunday child pages,
  // each holding one day-type's accordions with full timetable tables.
  hub: "https://www.panynj.gov/path/en/schedules-maps.model.json",
};

// Canonical station codes -> how the timetable header names them
const STATION_HEADER_MAP = {
  newark: "NWK",
  harrison: "HAR",
  jsq: "JSQ",
  "grove st": "GRO",
  "grove st.": "GRO",
  exchange: "EXC",
  wtc: "WTC",
  newport: "NEW",
  hoboken: "HOB",
  "chris st": "CHR",
  "9 st": "09S",
  "14 st": "14S",
  "23 st": "23S",
  "33 st": "33S",
};

// Line colors follow the RidePATH app / panynj.gov real-time widget
const LINE_COLORS = [
  { match: (stops) => stops.has("NWK") && stops.has("WTC"), color: "#D93A30" },
  { match: (stops) => stops.has("HOB") && stops.has("WTC"), color: "#65C100" },
  { match: (stops) => stops.has("HOB") && stops.has("33S"), color: "#4D92FB" },
  { match: (stops) => stops.has("JSQ") && stops.has("33S"), color: "#FF9900" },
];

const DAY_KEYS = {
  "weekday-schedules": "weekday",
  "weekend-schedules": "saturday",
  "sunday-schedules": "sunday",
};

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\xa0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "12:10 AM" -> "00:10"; "5:49 PM" -> "17:49"; "---" -> null
function parseTime(text) {
  const m = text.match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// Header cell like "9 St<br> Departure" or "Arrival at<br> 33 St" -> station code
function parseHeaderCell(html) {
  const text = stripTags(html)
    .replace(/departure$/i, "")
    .trim();
  const normalized = text.toLowerCase();
  if (STATION_HEADER_MAP[normalized]) return STATION_HEADER_MAP[normalized];
  // "Arrival at 33 St" / "Arrival at World Trade Center"
  const arrival = text.match(/^arrival at\s+(.+)$/i);
  if (arrival) {
    const dest = arrival[1].toLowerCase();
    if (STATION_HEADER_MAP[dest]) return STATION_HEADER_MAP[dest];
  }
  return null;
}

// Collect every Accordion component together with the page path it sits under
function collectAccordions(node, path = "", out = []) {
  if (Array.isArray(node)) {
    for (const v of node) collectAccordions(v, path, out);
  } else if (node && typeof node === "object") {
    if (node[":type"] === "portauthority/components/Accordion") out.push({ path, node });
    for (const [key, value] of Object.entries(node)) {
      collectAccordions(value, `${path}.${key}`, out);
    }
  }
  return out;
}

function parseTable(html, lineName) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/);
  if (!tableMatch) return null;
  const rows = [...tableMatch[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const parsed = rows.map((row) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1])),
  );
  // Drop empty spacer rows
  const dataRows = parsed.filter((cells) => cells.some((c) => c !== ""));
  if (dataRows.length < 2) return null;

  const header = dataRows[0];
  const stops = header.map((c) => {
    const code = parseHeaderCell(c);
    if (!code) throw new Error(`Unknown header cell "${c}" in "${lineName}"`);
    return code;
  });

  const trips = [];
  for (const cells of dataRows.slice(1)) {
    if (cells.length !== stops.length) {
      throw new Error(`Ragged row (${cells.length} != ${stops.length}) in "${lineName}"`);
    }
    trips.push(cells.map((c) => parseTime(c)));
  }
  return { stops, trips };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "path-web schedule updater" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log("Fetching source pages…");
  const hub = await fetchJson(SOURCES.hub);

  // Day tables appear under the hub's embedded schedule child pages. The same
  // accordions also exist on standalone pages, but the hub copy is authoritative.
  const seenName = new Set();
  const dayLines = { weekday: [], saturday: [], sunday: [] };

  for (const { path, node } of collectAccordions(hub)) {
    // Only keep accordions from the canonical schedule child pages
    const child = (path.match(/schedules-maps\/(\w[\w-]*-schedules)/) || [])[1];
    if (!child) continue;
    const dayKey = Object.entries(DAY_KEYS).find(([token]) => child.startsWith(token))?.[1];
    if (!dayKey) continue;
    // Skip special-event child pages (one-off weekends, holidays, outages)
    if (/weekend-apr|holiday|open-track|no-service|special/i.test(path)) continue;

    const name = stripTags(node.accordionLabel || "").trim();
    if (!name || !node.linkAriaLabel) continue;
    // The weekend page's accordion lists are duplicated (desktop/mobile copies)
    const dedupeKey = `${dayKey}|${name}`;
    if (seenName.has(dedupeKey)) continue;

    let tableHtml = null;
    for (const item of Object.values(node[":items"] || {})) {
      if (item && typeof item.text === "string" && item.text.includes("<table")) {
        tableHtml = item.text;
        break;
      }
    }
    if (!tableHtml) continue;

    let parsed;
    try {
      parsed = parseTable(tableHtml, name);
    } catch (err) {
      console.warn(`  ! skipped "${name}" (${dayKey}): ${err.message}`);
      continue;
    }
    if (!parsed || parsed.trips.length === 0) continue;

    const stops = new Set(parsed.stops);
    const color = LINE_COLORS.find((c) => c.match(stops))?.color || "#808080";
    seenName.add(dedupeKey);
    dayLines[dayKey].push({
      name,
      color,
      stops: parsed.stops,
      trips: parsed.trips,
    });
  }

  // Sanity output
  for (const [day, lines] of Object.entries(dayLines)) {
    console.log(`${day}: ${lines.length} lines`);
    for (const line of lines) {
      console.log(`   ${line.name.padEnd(45)} ${line.stops.join("-")} trips=${line.trips.length}`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "https://www.panynj.gov/path/en/schedules-maps.html",
    days: dayLines,
  };

  const outPath = fileURLToPath(new URL("../data/schedule.json", import.meta.url));
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
