import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "sa-key.json"), "utf8"));
const CAL_ID = process.env.CALENDAR_ID;
if (!CAL_ID) {
  throw new Error("Missing CALENDAR_ID environment variable.");
}

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

try {
  // Quick existence + permission check
  const meta = await calendar.calendars.get({ calendarId: CAL_ID });
  console.log("Calendar OK:", meta.data.summary, "-", meta.data.id);

  // List a couple of upcoming events
  const now = new Date().toISOString();
  const list = await calendar.events.list({
    calendarId: CAL_ID,
    timeMin: now,
    maxResults: 3,
    singleEvents: true,
    orderBy: "startTime",
  });
  console.log("Upcoming:", (list.data.items || []).map(e => e.summary));
} catch (err) {
  console.error(
    "Access check failed:",
    err?.response?.status,
    err?.response?.data || err.message
  );
}
