const express = require("express");
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { google } = require("googleapis");
require("dotenv").config(); 

// Admin SDK (uses this project's service account in Cloud Functions)
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

// Env (from functions/.env)
const CALENDAR_ID = process.env.BOOKING_CALENDAR_ID;
const TIMEZONE    = process.env.TIMEZONE || "Australia/Sydney";
const ADMIN_KEY   = process.env.ADMIN_KEY || ""; // used by DELETE
if (!CALENDAR_ID) {
  // Throw on cold start so we notice misconfig early
  throw new Error("BOOKING_CALENDAR_ID missing. Set it in functions/.env");
}

const app = express();
app.use(express.json());

// Google Calendar client via ADC
async function calendarClient() {
  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

const timeFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
});
const rangeLocal = (s, e) =>
  `${timeFmt.format(new Date(s))}–${timeFmt.format(new Date(e))}`;

async function hasConflict({ startISO, endISO, location }) {
  const startMs = new Date(startISO).getTime();
  const endMs   = new Date(endISO).getTime();

  const windowStart = new Date(startMs - 2 * 60 * 60 * 1000).toISOString();
  const windowEnd   = new Date(endMs   + 2 * 60 * 60 * 1000).toISOString();

  // Range on ONE field only (start_utc)
  const snap = await db
    .collection("bookings")
    .where("start_utc", ">=", windowStart)
    .where("start_utc", "<",  windowEnd)
    .orderBy("start_utc", "asc")
    .get();

  const oneHourMs = 60 * 60 * 1000;

  for (const doc of snap.docs) {
    const b  = doc.data();
    const bs = new Date(b.start_utc).getTime();
    const be = new Date(b.end_utc).getTime();
    const theirRange = rangeLocal(b.start_utc, b.end_utc);
    const yourRange  = rangeLocal(startISO, endISO);

    // Post-filter anything starting before windowStart but ending after it
    if (be <= new Date(windowStart).getTime()) continue;

    if (startMs < be && endMs > bs) {
      return { conflict: true, reason: `Overlaps existing session ${theirRange} at ${b.location}.` };
    }
    if (be === startMs && b.location !== location) {
      return { conflict: true, reason: `Need 60-min buffer: previous session ${theirRange} at ${b.location} ends exactly when your ${yourRange} at ${location} would start.` };
    }
    if (bs === endMs && b.location !== location) {
      return { conflict: true, reason: `Need 60-min buffer: next session ${theirRange} at ${b.location} starts exactly when your ${yourRange} at ${location} would end.` };
    }
    if (b.location !== location) {
      const startsTooSoonAfter = startMs >= be && (startMs - be) < oneHourMs;
      const endsTooCloseBefore = bs >= endMs   && (bs   - endMs) < oneHourMs;
      if (startsTooSoonAfter) {
        const mins = Math.round((startMs - be) / 60000);
        return { conflict: true, reason: `Need 60-min buffer: previous session ${theirRange} at ${b.location}; your ${yourRange} at ${location} starts only ${mins} min after.` };
      }
      if (endsTooCloseBefore) {
        const mins = Math.round((bs - endMs) / 60000);
        return { conflict: true, reason: `Need 60-min buffer: next session ${theirRange} at ${b.location} begins only ${mins} min after your ${yourRange} at ${location} ends.` };
      }
    }
  }
  return { conflict: false };
}

app.get("/api/_diag/env", (req, res) => {
  res.json({
    calendarIdPreview: (process.env.BOOKING_CALENDAR_ID || "").slice(0, 12) + "...",
    timeZone: process.env.TIMEZONE || null
  });
});

// List bookings
app.get("/api/bookings", async (req, res) => {
  try {
    const { from, to } = req.query;
    let ref = db.collection("bookings");

    if (from) ref = ref.where("start_utc", ">=", from);
    if (to)   ref = ref.where("start_utc", "<",  to);

    ref = ref.orderBy("start_utc", "asc");

    const snap = await ref.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/_diag/calendar", async (req, res) => {
  try {
    const calendar = await calendarClient();
    const meta = await calendar.calendars.get({ calendarId: CALENDAR_ID });
    res.json({ ok: true, id: meta.data.id, summary: meta.data.summary, timeZone: meta.data.timeZone });
  } catch (e) {
    console.error("Calendar diag failed:", e?.response?.data || e);
    res.status(502).json({ error: e?.response?.data || String(e) });
  }
});

// Create booking (+ Calendar)
app.post("/api/bookings", async (req, res) => {
  try {
    const { person_name, person_phone, location, start_local } = req.body;
    const phoneClean = (person_phone || "").toString().replace(/[^\d+]/g, "").slice(0,20)
    if (!person_name || !location || !start_local) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const startISO = new Date(start_local).toISOString();
    const endISO   = new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString();
    if (!isFinite(new Date(start_local).getTime())){
        return res.status(400).json({ error: "Invalid start time."})
    }

    if (startISO < new Date().toISOString()) {
      return res.status(400).json({ error: "You can’t book in the past." });
    }

    const check = await hasConflict({ startISO, endISO, location });
    if (check.conflict) return res.status(409).json({ error: check.reason });

    // Create Calendar event first
    const calendar = await calendarClient();
    const evt = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Private with ${person_name}`,
        description: `Booked via site.\nPhone: ${phoneClean || "n/a"}`,
        location,
        start: { dateTime: startISO, timeZone: TIMEZONE },
        end:   { dateTime: endISO,   timeZone: TIMEZONE },
      },
    });

    // Store booking in Firestore
    const docRef = await db.collection("bookings").add({
      person_name,
      person_phone: phoneClean || null,
      location,
      start_utc: startISO,
      end_utc: endISO,
      google_event_id: evt.data.id || null,
      created_at: Timestamp.now(),
    });

    console.log("Calendar:", evt.data.htmlLink);
    res.status(201).json({ id: docRef.id, calendarUrl: evt.data.htmlLink });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(500).json({ error: "Server error." });
  }
});

// Delete booking (+ Calendar) — admin only
app.delete("/api/bookings/:id", async (req, res) => {
  try {
    if (!ADMIN_KEY) return res.status(500).json({ error: "Server missing ADMIN_KEY" });
    const provided = req.get("X-Admin-Key");
    if (provided !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

    const id = req.params.id;
    const ref = db.collection("bookings").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Not found" });

    const { google_event_id } = snap.data() || {};
    if (google_event_id) {
      try {
        const calendar = await calendarClient();
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: google_event_id });
      } catch (err) {
        console.warn("Calendar delete failed:", err?.response?.data || err.message);
      }
    }

    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/_diag/firestore", async (req, res) => {
  try {
    const ref = await db.collection("bookings_diagnostics").add({
      ts: new Date().toISOString()
    });
    res.json({ ok: true, id: ref.id });
  } catch (e) {
    console.error("FS diag error:", e);
    res.status(500).json({ error: e.message });
  }
});

exports.api = onRequest({ region: "australia-southeast1" }, app);



