// Vercel serverless function: thin proxy for the PANYNJ real-time feed.
//
// The upstream endpoint (the one panynj.gov's own schedule page uses) sends
// no CORS headers, so the browser can't fetch it directly. This function
// re-fetches it, slims the payload down to what the UI needs and serves it
// same-origin, cached for 15 s to match the upstream refresh cadence.

const UPSTREAM = "https://www.panynj.gov/bin/portauthority/ridepath.json";

export default async function handler(_req, res) {
  try {
    const src = await fetch(`${UPSTREAM}?timeStamp=${Date.now()}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!src.ok) throw new Error(`upstream HTTP ${src.status}`);
    const data = await src.json();

    // results[] -> { stationCode: [entry, ...] }, keeping feed naming for
    // station/target codes (GRV/EXP) — src/realtime.js maps them to the
    // timetable codes (GRO/EXC)
    const stations = {};
    for (const result of data.results ?? []) {
      if (!result.consideredStation) continue;
      const entries = [];
      for (const dest of result.destinations ?? []) {
        for (const m of dest.messages ?? []) {
          entries.push({
            target: m.target,
            secondsToArrival: m.secondsToArrival,
            lineColor: m.lineColor,
            headSign: m.headSign,
            lastUpdatedMs: Date.parse(m.lastUpdated ?? "") || null,
          });
        }
      }
      if (entries.length) stations[result.consideredStation] = entries;
    }

    res.setHeader("Cache-Control", "public, max-age=15");
    res.status(200).json({ fetchedAt: Date.now(), stations });
  } catch (err) {
    // no-store so the client's next poll retries immediately; until then the
    // UI falls back to timetable-only rendering
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(err) });
  }
}
