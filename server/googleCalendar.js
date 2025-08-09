import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath = path.join(__dirname, "sa-key.json");
const credentials = JSON.parse(fs.readFileSync(keyPath, "utf8"));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

export async function insertEvent({
  calendarId,
  summary,
  description,
  location,
  startISO,
  endISO,
  timeZone = "Australia/Sydney",
}) {
  const { data } = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: startISO, timeZone },
      end:   { dateTime: endISO,   timeZone },
    },
  });
  return data; // includes id, htmlLink
}
