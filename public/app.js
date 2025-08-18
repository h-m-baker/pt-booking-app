// DOM refs
const form = document.getElementById("booking-form");
const msg  = document.getElementById("msg");
const submitBtn = document.getElementById("submitBtn");
const slotsEl = document.getElementById("slots");
const dateInput = document.getElementById("date");
const locationSelect = document.querySelector('select[name="location"]');

// Weekly Schedule
// Keys are JS weekday numbers: 0=Sun, 1=Mon, ... 6=Sat
// Times are local "HH:MM" in 24h, start times for 1-hour sessions
const WEEKLY_SCHEDULE = {
  0: ["13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"], // Sun
  1: ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", "15:00"],  // Mon
  2: ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", "15:00"],  // Tue
  3: ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", "15:00"],  // Wed
  4: ["07:00", "07:30", "08:00", "08:30", "09:00", "15:00"],  // Thu
  5: ["07:00", "07:30", "08:00", "08:30", "09:00", "15:00"],  // Fri
  6: ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", 
      "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", 
      "14:00", "14:30", "15:00", "15:30", "16:00"],          // Sat
};

for (const k of Object.keys(WEEKLY_SCHEDULE)) {
  WEEKLY_SCHEDULE[k] = WEEKLY_SCHEDULE[k].map(t => t.trim());
}

// State
let selectedHHMM = null;  // "HH:MM" for the chosen slot

// UX helper
function showMsg(text, ok = true) {
  msg.innerHTML = text;
  msg.style.color = ok ? "black" : "red";
  msg.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Format helpers
const pad2 = (n) => String(n).padStart(2, "0");
function localYYYYMMDD(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}`;
}

// Build ISO string for local date + "HH:MM"
function toLocalISO(dateStr, hhmm) {
  // dateStr is "YYYY-MM-DD", hhmm is "HH:MM" (local)
  return new Date(`${dateStr}T${hhmm}`).toISOString();
}

function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// set min date once UI is ready
dateInput.setAttribute("min", todayYYYYMMDD());


// Fetch existing bookings for a given local date
async function fetchBookingsForDate(dateStr) {
  const startLocal = new Date(`${dateStr}T00:00`);
  const endLocal   = new Date(`${dateStr}T23:59`);

  const from = new Date(startLocal.getTime() - 2*60*60*1000).toISOString(); // -2h
  const to   = new Date(endLocal.getTime()   + 2*60*60*1000).toISOString(); // +2h

  const res = await fetch(`/api/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!res.ok) return [];
  return res.json(); // [{start_utc, end_utc, location, ...}, ...]
}

// Convert a booking row (UTC) into local start/end "HH:MM"
function bookingToLocalHHMM(b) {
  const s = new Date(b.start_utc);
  const e = new Date(b.end_utc);
  const sh = pad2(s.getHours()), sm = pad2(s.getMinutes());
  const eh = pad2(e.getHours()), em = pad2(e.getMinutes());
  return { startHHMM: `${sh}:${sm}`, endHHMM: `${eh}:${em}`, loc: b.location };
}

function requiredLeadHours(dateStr){
  const dow = new Date(`${dateStr}T12:00`).getDay();
  if (dow === 5 || dow === 6) return 24;
  return 8;
}

// Block slots that start within the next 24 hours (rolling)
// look at difference between date vs datestring
function isWithinNext24h(dateStr, hhmm) {
  const slotStartMs = new Date(`${dateStr}T${hhmm}`).getTime(); // local time -> ms
  const leadMs = requiredLeadHours(dateStr)*60*60*1000;
  // const nowPlus24h  = Date.now() + 24*60*60*1000;
  return slotStartMs < (Date.now() + leadMs);
}

// Full conflict check (overlap + 60-min travel rule) for chosen location
function violatesTravelRule(hhmm, chosenLoc, bookingsLocal) {
  const [h, m] = hhmm.split(":").map(Number);
  const slotStartMin = h*60 + m;
  const slotEndMin   = slotStartMin + 60;
  const oneHour = 60;

  for (const b of bookingsLocal) {
    const [bh, bm] = b.startHHMM.split(":").map(Number);
    const [eh, em] = b.endHHMM.split(":").map(Number);
    const bStart = bh*60 + bm;
    const bEnd   = eh*60 + em;

    // 1) Hard overlap
    if (slotStartMin < bEnd && slotEndMin > bStart) return true;

    // 2) Exact adjacency requires same location
    if (bEnd === slotStartMin && b.loc !== chosenLoc) return true;
    if (bStart === slotEndMin && b.loc !== chosenLoc) return true;

    // 3) Buffer < 60 min between different locations
    if (b.loc !== chosenLoc) {
      const startsTooSoonAfter = slotStartMin >= bEnd && (slotStartMin - bEnd) < oneHour;
      const endsTooCloseBefore = bStart >= slotEndMin && (bStart - slotEndMin) < oneHour;
      if (startsTooSoonAfter || endsTooCloseBefore) return true;
    }
  }
  return false;
}


// Check if a 1-hour slot starting at hh:mm overlaps any existing booking
function isTaken(hhmm, bookingsLocal) {
  // slot window [slotStart, slotEnd)
  const [h, m] = hhmm.split(":").map(Number);
  const slotStartMin = h*60 + m;
  const slotEndMin   = slotStartMin + 60;

  for (const b of bookingsLocal) {
    const [bh, bm] = b.startHHMM.split(":").map(Number);
    const [eh, em] = b.endHHMM.split(":").map(Number);
    const bStart = bh*60 + bm;
    const bEnd   = eh*60 + em;
    const overlaps = slotStartMin < bEnd && slotEndMin > bStart;
    if (overlaps) return true;
  }
  return false;
}

// Render the slot buttons for the chosen date & location
async function renderSlots() {
  slotsEl.innerHTML = "";
  selectedHHMM = null;

  const dateStr = dateInput.value;
  if (!dateStr) return;

  // Determine weekday (local)
  const d = new Date(`${dateStr}T12:00`); // midday guard avoids DST edge
  const weekday = d.getDay(); // 0..6
  const allowed = WEEKLY_SCHEDULE[weekday] || [];

  if (!allowed.length) {
    slotsEl.innerHTML = `<em>No sessions on this day.</em>`;
    return;
  }

  // Require a location to evaluate travel rule
  const chosenLoc = locationSelect ? (locationSelect.value || "").trim() : "";
  if (!chosenLoc) {
    for (const raw of allowed) {
      const hhmm = raw.trim();
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot-btn";
      btn.textContent = hhmm;
      btn.disabled = true; // disabled until location picked
      btn.title = "Select a location to see available times";
      slotsEl.appendChild(btn);
    }
    return;
  }

  // Fetch existing bookings (+/- 2h) and map to local HH:MM
  const bookings = (await fetchBookingsForDate(dateStr)).map(bookingToLocalHHMM);

  for (const raw of allowed) {
    const hhmm = raw.trim();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot-btn";
    btn.textContent = hhmm;

    // A) Block anything starting within the next 24 hours
    if (isWithinNext24h(dateStr, hhmm)) {
      btn.disabled = true;
      btn.title = "This time is inside the 24-hour window";
    }

    // B) Disable if already taken
    if (!btn.disabled && isTaken(hhmm, bookings)) {
      btn.disabled = true;
      btn.title = "This time is already booked";
    }

    // C) Disable if it would violate the 60-min travel rule for the selected location
    if (!btn.disabled && violatesTravelRule(hhmm, chosenLoc, bookings)) {
      btn.disabled = true;
      btn.title = "Not enough travel buffer from another session";
    }

    // D) Extra: block past times if same-day
    const today = localYYYYMMDD(new Date());
    if (!btn.disabled && dateStr === today) {
      const now = new Date();
      const nowMin = now.getHours()*60 + now.getMinutes();
      const [h, m] = hhmm.split(":").map(Number);
      const slotMin = h*60 + m;
      if (slotMin <= nowMin) {
        btn.disabled = true;
        btn.title = "This time has already passed";
      }
    }

    btn.addEventListener("click", () => {
      for (const b of slotsEl.querySelectorAll(".slot-btn")) b.classList.remove("selected");
      btn.classList.add("selected");
      selectedHHMM = hhmm;
    });

    slotsEl.appendChild(btn);
  }
}

// Re-render slots whenever date or location changes
// dateInput.addEventListener("change", renderSlots);
// if (locationSelect) locationSelect.addEventListener("change", renderSlots);

dateInput.addEventListener("input", () => {
  const min = dateInput.getAttribute("min");
  if (dateInput.value && dateInput.value < min) {
    dateInput.value = min;
  }
  renderSlots();
});

if (locationSelect) {
  locationSelect.addEventListener("change", () => {
    selectedHHMM = null;
    renderSlots();
  });
}

// Default date = today (or next weekday with availability)
(function setDefaultDate() {
  const today = new Date();
  dateInput.value = localYYYYMMDD(today);
  renderSlots();
})();

// Submit handler
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitBtn) submitBtn.disabled = true;
  msg.textContent = "";

  try {
    if (!selectedHHMM) {
      showMsg("Please select a time slot.", false);
      return;
    }

    if (!locationSelect.value) {
      showMsg("Please choose a location.", false);
      return;
    }

    const fd = new FormData(form);
    const dateStr = dateInput.value;
    const start_local = `${dateStr}T${selectedHHMM.trim()}`;

    const payload = {
      person_name:  fd.get("person_name"),
      person_phone: fd.get("phone") || "",
      location:     fd.get("location"),
      start_local,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      await res.json().catch(() => ({}));
      const loc = fd.get("location");
      const time = selectedHHMM.trim();
      const date = dateStr;
      showMsg(
        `Booked for ${time} on ${date} at ${loc}! Payment can be made on the day`, 
        true
      );
      form.reset();
      // Re-render slots to reflect the new booking
      renderSlots();

    } else {
      const { error } = await res.json().catch(() => ({ error: "Failed." }));
      showMsg(error || "Failed.", false);
      // If the server rejected due to travel buffer, the slot may be invalid for this location.
      // Re-render to stay in sync:
      renderSlots();
    }
  } catch (err) {
    showMsg("An error occurred.", false);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});
