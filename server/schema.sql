PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_name  TEXT NOT NULL,
  person_email TEXT,
  location     TEXT NOT NULL,
  start_utc    TEXT NOT NULL, -- ISO string
  end_utc      TEXT NOT NULL, -- ISO string
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_bookings_location ON bookings(location);
