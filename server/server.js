import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js";
import { insertEvent } from "./googleCalendar.js";

const CAL_ID = process.env.CALENDAR_ID;
if (!CAL_ID) throw new Error("Missing CALENDAR_ID environment variable.");
const TIMEZONE = "Australia/Sydney";

const timeFmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit'
});
const rangeLocal = (sISO, eISO) => {
  const s = new Date(sISO), e = new Date(eISO);
  return `${timeFmt.format(s)}–${timeFmt.format(e)}`;
};


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// Helpers
const toISO = (d) => new Date(d).toISOString();

// Conflict logic:
// 1) No overlap with existing [start,end]
// 2) If new start == existing end (or vice versa), allowed only if same location.
// 3) If consecutive but different locations, require 60 min gap between end and next start.
function hasConflict({ startISO, endISO, location }) {
  // window: +/- 2 hours around the new event
  const stmt = db.prepare(`
    SELECT *
    FROM bookings
    WHERE julianday(end_utc)   > julianday(?) - (2.0/24)
      AND julianday(start_utc) < julianday(?) + (2.0/24)
  `);
  const rows = stmt.all(startISO, endISO);

  const start = new Date(startISO).getTime();
  const end   = new Date(endISO).getTime();
  const oneHourMs = 60 * 60 * 1000;

  for (const b of rows) {
    const bs = new Date(b.start_utc).getTime();
    const be = new Date(b.end_utc).getTime();
    const theirRange = rangeLocal(b.start_utc, b.end_utc);
    const yourRange  = rangeLocal(startISO, endISO);

    // Overlap (half-open intervals [start, end))
    if (start < be && end > bs) {
      return { conflict: true, reason: `Overlaps existing session ${theirRange} at ${b.location}.` };
    }

    // Exact adjacency: require same location
    if (be === start && b.location !== location) {
      return { conflict: true, reason: `Need to account for travel time: previous session ${theirRange} at ${b.location} ends exactly when your ${yourRange} at ${location} would start.` };
    }
    if (bs === end && b.location !== location) {
      return { conflict: true, reason: `Need to accounf for travel time: next session ${theirRange} at ${b.location} starts exactly when your ${yourRange} at ${location} would end.` };
    }

    // Close but not overlapping: enforce 60 minutes if locations differ
    if (b.location !== location) {
      const startsTooSoonAfter = start >= be && (start - be) < oneHourMs;
      const endsTooCloseBefore = bs >= end   && (bs   - end) < oneHourMs;
      if (startsTooSoonAfter) {
        const mins = Math.round((start - be) / 60000);
        return { conflict: true, reason: `Need to account for travel time: previous session ${theirRange} at ${b.location}; your ${yourRange} at ${location} starts only ${mins} min after.` };
      }
      if (endsTooCloseBefore) {
        const mins = Math.round((bs - end) / 60000);
        return { conflict: true, reason: `Need to account for travel time: next session ${theirRange} at ${b.location} begins only ${mins} min after your ${yourRange} at ${location} ends.` };
      }
    }
  }
  return { conflict: false };
}


app.get("/api/bookings", (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(
    `SELECT * FROM bookings
     WHERE (? IS NULL OR start_utc >= ?)
       AND (? IS NULL OR end_utc   <= ?)
     ORDER BY start_utc ASC`
  ).all(from || null, from || null, to || null, to || null);
  res.json(rows);
});

app.post("/api/bookings", (req, res) => {
  try {
    const { person_name, person_email, location, start_local, tz } = req.body;
    if (!person_name || !location || !start_local) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const startISO = new Date(start_local).toISOString();
    const endISO   = new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString();

    const { conflict, reason } = hasConflict({ startISO, endISO, location });
    if (conflict) return res.status(409).json({ error: reason });

    const ins = db.prepare(`
      INSERT INTO bookings (person_name, person_email, location, start_utc, end_utc)
      VALUES (@person_name, @person_email, @location, @start_utc, @end_utc)
    `);
    const info = ins.run({
      person_name,
      person_email: person_email || null,
      location,
      start_utc: startISO,
      end_utc: endISO
    });

    insertEvent({
    calendarId: CAL_ID,
    summary: `Private with ${person_name}`,
    description: `Booked via site.\nEmail: ${person_email || "n/a"}`,
    location,
    startISO,
    endISO,
    timeZone: TIMEZONE,
  })
    .then(evt => console.log("Calendar event created:", evt.htmlLink))
    .catch(err => console.error("Calendar insert failed:", err?.response?.data || err.message));

    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
