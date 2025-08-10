# Private Training Booking App for a Coach

This app is a simple booking site for my friend who runs grappling privates (1-1 coaching sessions) with conflict checks, travel buffer rules for sessions at different locations, and Google Calendar integration. Deployed on Firebase Hosting + Cloud Functions.

**Live app:** https://jude-kean-privates.web.app

## Features
- Mobile-friendly slot picker with only available times shown
- Prevents overlapping bookings + enforces 60-min buffer for different locations
- 1-hour fixed sessions
- Sends booking to a private Google Calendar
- Firestore-backed storage
- Admin delete endpoint (protected with `ADMIN_KEY`)

## Local Dev
```bash
# or use Firebase emulators (Functions + Hosting)
cd functions && npm i && cd ..
firebase emulators:start --only "functions,hosting"
