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
const DEXCOM_SERVER = (process.env.DEXCOM_SERVER || "US").toUpperCase(); // "US" or "OUS"

// The public Dexcom "application ID" used by the official Share client.
// This is not a secret — it's the same fixed ID every Dexcom Share
// integration (including Nightscout's bridge plugin) uses to talk to
// Dexcom's own service. Your account credentials are what authenticate you.
const APPLICATION_ID = "d8665ade-9673-4e27-9ff6-92db4ce13d13";

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

async function loginToDexcom() {
  const res = await fetch(
    `${BASE_URL}/General/LoginPublisherAccountByName`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
    throw new Error("Dexcom login returned an empty session — check your username/password.");
  }
  return sessionId;
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

async function fetchLatestReading() {
  let sessionId = await getSessionId();

  let res = await fetch(
    `${BASE_URL}/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=1440&maxCount=1`,
    { method: "POST", headers: { Accept: "application/json" } }
  );

  // If the cached session expired server-side, log in again once and retry.
  if (res.status === 500 || res.status === 401) {
    cachedSessionId = null;
    sessionId = await getSessionId();
    res = await fetch(
      `${BASE_URL}/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=1440&maxCount=1`,
      { method: "POST", headers: { Accept: "application/json" } }
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dexcom read failed (${res.status}): ${text}`);
  }

  const readings = await res.json();
  if (!Array.isArray(readings) || readings.length === 0) {
    throw new Error("No glucose readings returned by Dexcom.");
  }
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

  return {
    value_mgdl: reading.Value,
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
    const sentence = `Blood glucose is ${payload.value_mgdl} mg/dL, ${payload.trend_description}, as of ${ago}.`;
    res.type("text/plain").send(sentence);
  } catch (err) {
    console.error(err);
    res.status(502).type("text/plain").send(`Could not get a reading: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Dexcom reader listening on port ${PORT}`);
});
