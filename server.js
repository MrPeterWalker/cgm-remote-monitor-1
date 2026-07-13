// Lightweight Dexcom Share reader
// Exposes your current glucose reading as JSON and plain text,
// so ChatGPT / Gemini (or anything else) can fetch and read it aloud.
//
// It does NOT store any data. Every request goes live to Dexcom's
// Share service (the same one the Dexcom Share mobile app uses) using
// your own account credentials, then returns the latest reading.

const express = require("express");
// Use built-in fetch if available (Node 18+), otherwise fall back to node-fetch.
const fetch = global.fetch || require("node-fetch");
const app = express();

const PORT = process.env.PORT || 3000;

// ---- Required environment variables ----
const DEXCOM_USERNAME = process.env.DEXCOM_USERNAME;
const DEXCOM_PASSWORD = process.env.DEXCOM_PASSWORD;
const API_KEY = process.env.API_KEY; // your own secret, required on every request
const DEXCOM_SERVER = (process.env.DEXCOM_SERVER || "OUS").toUpperCase(); // "US" or "OUS"

// Dexcom's API always returns mg/dL. Set this to "mmol" to have /glucose/text
// (and the "display_value" field in /glucose) show mmol/L instead — standard
// in Australia, UK, and most countries outside the US.
const GLUCOSE_UNIT = (process.env.GLUCOSE_UNIT || "mmol").toLowerCase();

// The public Dexcom "application ID" used by the official Share client.
// This is not a secret — it's the same fixed ID every Dexcom Share
// integration (including Nightscout's bridge plugin) uses to talk to
// Dexcom's own service. Your account credentials are what authenticate you.
const APPLICATION_ID = "d8665ade-9673-4e27-9ff6-92db4ce13d13";

// Dexcom's Share servers expect requests to look like they're coming from
// the official mobile app. Without this header, login can silently fail
// and return an empty session instead of a clear error.
const DEXCOM_USER_AGENT = "Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0";

const BASE_URL =
  DEXCOM_SERVER === "OUS"
    ? "https://shareous1.dexcom.com/ShareWebServices/Services"
    : "https://share2.dexcom.com/ShareWebServices/Services";

if (!DEXCOM_USERNAME || !DEXCOM_PASSWORD || !API_KEY) {
  console.warn(
    "WARNING: DEXCOM_USERNAME, DEXCOM_PASSWORD, and API_KEY must all be set as environment variables."
  );
}

// Simple in-memory session cache so we don't log in to Dexcom on every
// single request (Dexcom rate-limits logins). Sessions last ~10 minutes.
let cachedSessionId = null;
let cachedSessionAt = 0;
const SESSION_TTL_MS = 9 * 60 * 1000;

async function loginByName() {
  const res = await fetch(
    `${BASE_URL}/General/LoginPublisherAccountByName`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": DEXCOM_USER_AGENT,
      },
      body: JSON.stringify({
        accountName: DEXCOM_USERNAME,
        password: DEXCOM_PASSWORD,
        applicationId: APPLICATION_ID,
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dexcom login failed (${res.status}): ${text}`);
  }

  const sessionId = await res.json();
  if (!sessionId || sessionId === "00000000-0000-0000-0000-000000000000") {
    return null; // signal caller to try the fallback flow
  }
  return sessionId;
}

// Some accounts (commonly newer G7 accounts) silently fail
// LoginPublisherAccountByName. This fallback authenticates to get an
// accountId first, then logs in with that accountId instead.
async function loginByAccountIdFallback() {
  const authRes = await fetch(
    `${BASE_URL}/General/AuthenticatePublisherAccount`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": DEXCOM_USER_AGENT,
      },
      body: JSON.stringify({
        accountName: DEXCOM_USERNAME,
        password: DEXCOM_PASSWORD,
        applicationId: APPLICATION_ID,
      }),
    }
  );

  if (!authRes.ok) {
    const text = await authRes.text().catch(() => "");
    throw new Error(`Dexcom authenticate failed (${authRes.status}): ${text}`);
  }

  const accountId = await authRes.json();
  if (!accountId || accountId === "00000000-0000-0000-0000-000000000000") {
    throw new Error(
      "Dexcom login returned an empty session — check your username/password."
    );
  }

  const loginRes = await fetch(
    `${BASE_URL}/General/LoginPublisherAccountById`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": DEXCOM_USER_AGENT,
      },
      body: JSON.stringify({
        accountId,
        password: DEXCOM_PASSWORD,
        applicationId: APPLICATION_ID,
      }),
    }
  );

  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => "");
    throw new Error(`Dexcom login-by-id failed (${loginRes.status}): ${text}`);
  }

  const sessionId = await loginRes.json();
  if (!sessionId || sessionId === "00000000-0000-0000-0000-000000000000") {
    throw new Error(
      "Dexcom login returned an empty session — check your username/password."
    );
  }
  return sessionId;
}

let lastLoginMethod = "not yet attempted";

async function loginToDexcom() {
  const sessionId = await loginByName();
  if (sessionId) {
    lastLoginMethod = "LoginPublisherAccountByName";
    return sessionId;
  }
  const fallbackSession = await loginByAccountIdFallback();
  lastLoginMethod = "AuthenticatePublisherAccount + LoginPublisherAccountById (fallback)";
  return fallbackSession;
}

async function getSessionId() {
  const now = Date.now();
  if (cachedSessionId && now - cachedSessionAt < SESSION_TTL_MS) {
    return cachedSessionId;
  }
  const sessionId = await loginToDexcom();
  cachedSessionId = sessionId;
  cachedSessionAt = now;
  return sessionId;
}

async function fetchReadings(minutes, maxCount) {
  let sessionId = await getSessionId();

  const url = (sid) =>
    `${BASE_URL}/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sid}&minutes=${minutes}&maxCount=${maxCount}`;

  let res = await fetch(url(sessionId), {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": DEXCOM_USER_AGENT },
  });

  // If the cached session expired server-side, log in again once and retry.
  if (res.status === 500 || res.status === 401) {
    cachedSessionId = null;
    sessionId = await getSessionId();
    res = await fetch(url(sessionId), {
      method: "POST",
      headers: { Accept: "application/json", "User-Agent": DEXCOM_USER_AGENT },
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dexcom read failed (${res.status}): ${text}`);
  }

  const readings = await res.json();
  if (!Array.isArray(readings) || readings.length === 0) {
    throw new Error("No glucose readings returned by Dexcom.");
  }
  return readings;
}

async function fetchLatestReading() {
  const readings = await fetchReadings(1440, 1);
  return readings[0];
}

// Dexcom's "WT" field looks like "Date(1625077760000)" — a Unix ms timestamp.
function parseDexcomDate(wt) {
  const match = /Date\((\d+)\)/.exec(wt || "");
  if (!match) return null;
  return new Date(parseInt(match[1], 10));
}

const TREND_MAP = {
  None: { arrow: "?", description: "unknown trend" },
  DoubleUp: { arrow: "⇈", description: "rising quickly" },
  SingleUp: { arrow: "↑", description: "rising" },
  FortyFiveUp: { arrow: "↗", description: "rising slightly" },
  Flat: { arrow: "→", description: "steady" },
  FortyFiveDown: { arrow: "↘", description: "falling slightly" },
  SingleDown: { arrow: "↓", description: "falling" },
  DoubleDown: { arrow: "⇊", description: "falling quickly" },
  NotComputable: { arrow: "?", description: "trend not available" },
  RateOutOfRange: { arrow: "?", description: "trend out of range" },
};

function buildPayload(reading) {
  const timestamp = parseDexcomDate(reading.WT || reading.ST || reading.DT);
  const minutesAgo = timestamp
    ? Math.round((Date.now() - timestamp.getTime()) / 60000)
    : null;
  const trendInfo = TREND_MAP[reading.Trend] || TREND_MAP.None;

  // Standard mg/dL -> mmol/L conversion factor, rounded to 1 decimal place
  // to match how mmol/L is normally displayed (e.g. 6.5, not 6.54321).
  const value_mmol = Math.round((reading.Value / 18.0182) * 10) / 10;

  const displayValue = GLUCOSE_UNIT === "mmol" ? value_mmol : reading.Value;
  const displayUnit = GLUCOSE_UNIT === "mmol" ? "mmol/L" : "mg/dL";

  return {
    value_mgdl: reading.Value,
    value_mmol,
    display_value: displayValue,
    display_unit: displayUnit,
    trend: reading.Trend,
    trend_arrow: trendInfo.arrow,
    trend_description: trendInfo.description,
    timestamp: timestamp ? timestamp.toISOString() : null,
    minutes_ago: minutesAgo,
  };
}

function requireApiKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "Missing or invalid API key." });
  }
  next();
}

app.get("/", (req, res) => {
  res.send("Dexcom reader is running. See /glucose and /glucose/text (both require ?key=).");
});

app.get("/debug", requireApiKey, (req, res) => {
  res.json({
    dexcom_server_setting: DEXCOM_SERVER,
    base_url_in_use: BASE_URL,
    username_configured: Boolean(DEXCOM_USERNAME),
    username_length: DEXCOM_USERNAME ? DEXCOM_USERNAME.length : 0,
    password_configured: Boolean(DEXCOM_PASSWORD),
    password_length: DEXCOM_PASSWORD ? DEXCOM_PASSWORD.length : 0,
    last_login_method: lastLoginMethod,
  });
});

app.get("/glucose", requireApiKey, async (req, res) => {
  try {
    const reading = await fetchLatestReading();
    res.json(buildPayload(reading));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get("/glucose/text", requireApiKey, async (req, res) => {
  try {
    const reading = await fetchLatestReading();
    const payload = buildPayload(reading);
    const ago =
      payload.minutes_ago === null
        ? ""
        : payload.minutes_ago <= 1
        ? "just now"
        : `${payload.minutes_ago} minutes ago`;
    const sentence = `Blood glucose is ${payload.display_value} ${payload.display_unit}, ${payload.trend_description}, as of ${ago}.`;
    res.type("text/plain").send(sentence);
  } catch (err) {
    console.error(err);
    res.status(502).type("text/plain").send(`Could not get a reading: ${err.message}`);
  }
});

app.get("/glucose/history", requireApiKey, async (req, res) => {
  try {
    // Dexcom readings arrive every 5 minutes, so 3 hours is ~36 readings.
    const minutes = parseInt(req.query.minutes, 10) || 180;
    const maxCount = Math.min(Math.ceil(minutes / 5) + 2, 288);
    const readings = await fetchReadings(minutes, maxCount);
    const points = readings
      .map(buildPayload)
      .filter((p) => p.timestamp)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(points);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get("/dashboard", requireApiKey, (req, res) => {
  const key = req.query.key;
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Glucose Monitor</title>
<style>
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  :root {
    --bg: #10151c;
    --card: #161c25;
    --line: #232b36;
    --text: #e8ecf1;
    --muted: #7c8797;
    --ok: #6ee7b7;
    --high: #f5a623;
    --low: #f87171;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
  }
  @font-face {
    font-family: 'IBM Plex Mono';
    src: local('IBM Plex Mono');
  }
  .card {
    width: min(92vw, 420px);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 40px 32px 32px;
    text-align: center;
  }
  .eyebrow {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 28px;
  }
  .ring-wrap {
    position: relative;
    width: 220px; height: 220px;
    margin: 0 auto 24px;
  }
  svg { transform: rotate(-90deg); }
  .ring-bg { fill: none; stroke: var(--line); stroke-width: 6; }
  .ring-fg {
    fill: none; stroke: var(--ok); stroke-width: 6; stroke-linecap: round;
    transition: stroke-dashoffset 1s linear, stroke 0.6s ease;
  }
  .center {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .value {
    font-family: 'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace;
    font-size: 56px; font-weight: 600; letter-spacing: -0.02em;
    transition: opacity 0.3s ease;
  }
  .unit { font-size: 13px; color: var(--muted); margin-top: 2px; }
  .trend-row {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    font-size: 15px; color: var(--text); margin-bottom: 6px;
  }
  .arrow { font-size: 20px; }
  .updated {
    font-size: 13px; color: var(--muted);
  }
  .graph-wrap {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
  }
  .graph-label {
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    text-align: left;
    margin-bottom: 10px;
  }
  .graph-empty {
    font-size: 13px;
    color: var(--muted);
    padding: 30px 0;
  }
  .graph-tick {
    font-size: 10px;
    fill: var(--muted);
    font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  }
  .next {
    font-size: 12px; color: var(--muted); margin-top: 18px;
    border-top: 1px solid var(--line); padding-top: 16px;
  }
  .error {
    color: var(--low); font-size: 14px; line-height: 1.5;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">Glucose Monitor</div>
    <div class="ring-wrap">
      <svg width="220" height="220" viewBox="0 0 220 220">
        <circle class="ring-bg" cx="110" cy="110" r="100"></circle>
        <circle class="ring-fg" id="ring" cx="110" cy="110" r="100"
          stroke-dasharray="628.3" stroke-dashoffset="0"></circle>
      </svg>
      <div class="center">
        <div class="value" id="value">--</div>
        <div class="unit" id="unit">loading</div>
      </div>
    </div>
    <div class="trend-row">
      <span class="arrow" id="arrow">→</span>
      <span id="trendDesc">connecting…</span>
    </div>
    <div class="updated" id="updated">&nbsp;</div>
    <div class="graph-wrap">
      <div class="graph-label">Past 3 hours</div>
      <div id="graph"></div>
    </div>
    <div class="next" id="next">Refreshing every 5 minutes</div>
  </div>

<script>
  const KEY = ${JSON.stringify(key)};
  const REFRESH_MS = 5 * 60 * 1000;
  const CIRCUMFERENCE = 628.3;
  const ring = document.getElementById('ring');
  let refreshTimer = null;
  let tickTimer = null;
  let lastFetchAt = Date.now();

  function bandColor(displayValue, unit) {
    // Rough clinical bands, works for either unit since we check the unit label.
    const mgdl = unit.startsWith('mmol') ? displayValue * 18.0182 : displayValue;
    if (mgdl < 70) return 'var(--low)';
    if (mgdl > 180) return 'var(--high)';
    return 'var(--ok)';
  }
  function setRingColor(displayValue, unit) {
    return bandColor(displayValue, unit);
  }

  async function fetchReading() {
    try {
      const res = await fetch('/glucose?key=' + encodeURIComponent(KEY));
      if (!res.ok) throw new Error('Server returned ' + res.status);
      const data = await res.json();

      document.getElementById('value').textContent = data.display_value;
      document.getElementById('unit').textContent = data.display_unit;
      document.getElementById('arrow').textContent = data.trend_arrow;
      document.getElementById('trendDesc').textContent = data.trend_description;
      document.getElementById('updated').textContent =
        data.minutes_ago === 0 ? 'Updated just now' : 'Updated ' + data.minutes_ago + ' min ago';

      const color = setRingColor(data.display_value, data.display_unit);
      ring.style.stroke = color;

      lastFetchAt = Date.now();
      resetRing();
    } catch (err) {
      document.getElementById('value').textContent = '--';
      document.getElementById('unit').textContent = '';
      document.getElementById('trendDesc').innerHTML =
        '<span class="error">Could not reach the sensor feed. Retrying automatically.</span>';
    }
  }

  function renderGraph(points) {
    const container = document.getElementById('graph');
    if (!points || points.length < 2) {
      container.innerHTML = '<div class="graph-empty">Not enough data yet</div>';
      return;
    }

    const W = 356, H = 120, PAD_X = 4, PAD_Y = 16;
    const unit = points[points.length - 1].display_unit;
    const isMmol = unit.startsWith('mmol');
    const lowLine = isMmol ? 3.9 : 70;
    const highLine = isMmol ? 10 : 180;
    const pad = isMmol ? 0.6 : 12;

    const values = points.map(function (p) { return p.display_value; });
    const times = points.map(function (p) { return new Date(p.timestamp).getTime(); });

    const rangeLow = Math.min(Math.min.apply(null, values), lowLine) - pad;
    const rangeHigh = Math.max(Math.max.apply(null, values), highLine) + pad;
    const minT = times[0];
    const maxT = times[times.length - 1] || minT + 1;

    function x(t) { return PAD_X + ((t - minT) / (maxT - minT || 1)) * (W - PAD_X * 2); }
    function y(v) { return H - PAD_Y - ((v - rangeLow) / (rangeHigh - rangeLow || 1)) * (H - PAD_Y * 2); }

    let linePath = '';
    let dots = '';
    points.forEach(function (p, i) {
      const px = x(new Date(p.timestamp).getTime());
      const py = y(p.display_value);
      linePath += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1) + ' ';
    });
    const last = points[points.length - 1];
    const lastColor = bandColor(last.display_value, last.display_unit);
    dots += '<circle cx="' + x(times[times.length - 1]).toFixed(1) + '" cy="' +
      y(last.display_value).toFixed(1) + '" r="4" fill="' + lastColor + '"></circle>';

    const areaPath = linePath + 'L' + x(maxT).toFixed(1) + ',' + (H - PAD_Y) +
      ' L' + x(minT).toFixed(1) + ',' + (H - PAD_Y) + ' Z';

    const lowY = y(lowLine).toFixed(1);
    const highY = y(highLine).toFixed(1);

    const startLabel = new Date(minT).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endLabel = new Date(maxT).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    container.innerHTML =
      '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="transform:none;overflow:visible;">' +
        '<line x1="' + PAD_X + '" y1="' + lowY + '" x2="' + (W - PAD_X) + '" y2="' + lowY + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,4"></line>' +
        '<line x1="' + PAD_X + '" y1="' + highY + '" x2="' + (W - PAD_X) + '" y2="' + highY + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,4"></line>' +
        '<path d="' + areaPath + '" fill="' + lastColor + '" fill-opacity="0.10" stroke="none"></path>' +
        '<path d="' + linePath.trim() + '" fill="none" stroke="' + lastColor + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>' +
        dots +
        '<text class="graph-tick" x="' + PAD_X + '" y="' + (H - 2) + '" text-anchor="start">' + startLabel + '</text>' +
        '<text class="graph-tick" x="' + (W - PAD_X) + '" y="' + (H - 2) + '" text-anchor="end">' + endLabel + '</text>' +
      '</svg>';
  }

  async function fetchHistory() {
    try {
      const res = await fetch('/glucose/history?key=' + encodeURIComponent(KEY) + '&minutes=180');
      if (!res.ok) throw new Error('Server returned ' + res.status);
      const points = await res.json();
      renderGraph(points);
    } catch (err) {
      document.getElementById('graph').innerHTML = '<div class="graph-empty">Could not load history.</div>';
    }
  }

  function resetRing() {
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = '0';
    // Force reflow so the transition re-applies cleanly next tick.
    void ring.offsetWidth;
    ring.style.transition = 'stroke-dashoffset 1s linear, stroke 0.6s ease';
  }

  function tick() {
    const elapsed = Date.now() - lastFetchAt;
    const fraction = Math.min(elapsed / REFRESH_MS, 1);
    ring.style.strokeDashoffset = String(CIRCUMFERENCE * fraction);
  }

  fetchReading();
  fetchHistory();
  refreshTimer = setInterval(function () { fetchReading(); fetchHistory(); }, REFRESH_MS);
  tickTimer = setInterval(tick, 1000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Dexcom reader listening on port ${PORT}`);
});
