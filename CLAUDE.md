# Dancon Site Visit Logger — Claude Briefing

## What This App Is
A Progressive Web App (PWA) built for Dancon Services 
field technicians. It allows technicians to log site 
visits, capture photos and videos on job sites, tag 
locations via GPS, and automatically upload all media 
to Google Drive organized by job site.

## Who Uses It
- Field technicians (Denis, Elvis) working in NJ/NYC
- Job sites often have weak or no WiFi/signal
- App runs on iOS devices added to home screen as PWA
- Technicians are not technical — UI must be simple

## Tech Stack
- Pure PWA (HTML, CSS, JavaScript — no framework)
- Google Drive API for media storage
- Google Sheets (Code.gs) as the database backend
- PKCE OAuth2 auth flow for Google login
- Cloudflare Worker proxy (dancon-token-proxy) holds 
  OAuth client_secret server-side for security
- IndexedDB for local offline storage
- Service worker for offline support and caching

## Critical Rules — Always Follow These
1. Save every photo/video to IndexedDB locally BEFORE 
   any upload attempt — never lose media
2. Upload files sequentially (MAX_CONCURRENT_UPLOADS=1)
   never simultaneously — job site networks are weak
3. Keep failed uploads in pending queue and auto-retry 
   when signal returns — never show permanent failure
4. Always bump CACHE_VERSION in service-worker.js 
   when making any changes so iOS picks up the update
5. Always update PROGRESS.md after every session
6. Never expose the OAuth client_secret in client code
7. Test for JS errors before declaring anything done

> Reminder: after every session, commit and push changes with:
> `git add -A && git commit -m "description" && git push origin main`

## Never Break These
- PKCE auth flow — if this breaks nobody can log in
- IndexedDB persistence — this is the offline backup
- Service worker registration — PWA won't work without it
- Google Drive upload confirmation before clearing local

## Current State (as of 2026-05-22)
- Auth: working via Cloudflare Worker PKCE proxy
- Capture: photos and videos working on iOS
- Local backup: IndexedDB saves before upload
- Upload: sequential queue with auto-retry
- Pending count: visible on capture screen
- Video thumbnails: working
- Retry-all button: implemented

## Known Constraints
- iOS PWAs cannot auto-save to camera roll silently
- iOS drops camera link after app idle — show reconnect 
  message and prompt user to reopen camera
- Always hard-refresh once on iOS after deploy to drop 
  previous service worker

## How to Run Locally
cd docs && python3 -m http.server 8000
Then open http://localhost:8000

## Project Structure
- docs/ — all PWA files served to the browser
  - js/app.js — main app shell and shared state
  - js/capture.js — camera and media capture
  - js/drive.js — Google Drive upload logic
  - js/db.js — IndexedDB local storage
  - js/ui.js — UI rendering and components
  - service-worker.js — caching and offline support
  - index.html — app entry point
  - manifest.json — PWA manifest
- Code.gs — Google Apps Script backend
- PROGRESS.md — running log of all changes
- auth_pwa.md — auth flow documentation