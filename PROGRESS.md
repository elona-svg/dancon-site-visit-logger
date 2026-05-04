# Site Visit Logger — progress log

> Live: https://elona-svg.github.io/dancon-site-visit-logger/
> Repo: https://github.com/elona-svg/dancon-site-visit-logger
> Source folder served by GitHub Pages: `docs/`
> Latest commit at the time of writing: see `git log -1`.

Update this file at the end of every working session so the next session
can pick up exactly where this one stopped.

## Current state (2026-05-02)

- Mobile-first PWA, installable to iPhone home screen.
- Google OAuth (GIS implicit flow), `@danconservices.com` only.
- Project folders auto-created/reused under shared Drive folder
  `10qzHqY5bY71_QQjNYqYv1l8SXC9Zfn4A`.
- Recent projects fetched from Drive on every login.
- Inline rename project: tap title → editable, conflict warning, Drive
  rename via PATCH.

### Capture
- Single big red **Open Camera** button on the project screen
  (gradient `#FF2222 → #CC0000`, white SVG camera icon).
- Tapping opens a fullscreen camera overlay with a **PHOTO | VIDEO**
  pill toggle and one iOS-style capture button (88px ring, 72px white
  inner circle in photo mode, red inner circle in video mode that
  animates to a 32px rounded square while recording, with a pulsing
  outer ring).
- Photos at native sensor resolution (no downscale), JPEG q=0.95.
- Video bitrate uncapped — full quality.
- Voice notes: separate modal recorder (camera detached so iOS releases
  the mic). Verbose `[voice]` logging in the console for debugging.

### Uploads
- IndexedDB-backed queue. Up to 3 parallel uploads with per-thumb
  progress + percentage, retry button on failure.
- Multipart + resumable both XHR-based for upload progress; 401 mid-
  upload triggers a silent token refresh + single retry inside the
  helper.
- Items left in `uploading` from a previous tab close are reset to
  `pending` on boot.

### Notes
- `notes.txt` cached fileId per folder; only a 404 invalidates the
  cache (transient errors propagate so we never create a duplicate).
- Inline notes history under the textarea.
- Per-note actions: ✎ **edit** (loads body into textarea, save
  replaces with `_(edited TS)_` marker) and 🗑 **delete** (Drive
  PATCH with the matching block removed).
- 📎 **Attach photo**: chooser → take new (single-shot fullscreen
  camera) or pick from project gallery. Attachment serialized as
  `[photo: filename]` and rendered as a tappable thumbnail.

### Other
- GPS chip on project screen (lat/lng + Maps link); captures once
  per folder into `gps.txt`.
- Photo viewer with prev/next arrows, swipe, position indicator,
  history-API back support; Annotate (with Clear-all) and Trash from
  inside the viewer.
- In-app video player with X / tap-outside / swipe-down / Back.
- Permission preflight: camera + mic asked **once** at first sign-in
  via a friendly card → single `getUserMedia({video,audio})` call;
  result cached in IDB so we never re-ask.

## Known follow-ups / nice-to-haves
- (none open at the moment — see git log for the most recent changes)

### Recently shipped — Project ownership marker (SW v20)
- **`.dancon-project` marker file** ([drive.js](docs/js/drive.js)).
  When a tech creates a project through the app, we now also write a
  hidden `.dancon-project` JSON file inside the new folder containing
  `{ createdAt, createdBy, appVersion, projectId }`. New helpers:
  `findProjectMarker(folderId)`, `createProjectMarker(folderId, payload)`,
  `listAllProjectMarkers()`.
- **Home list filtered to app-owned folders only** ([app.js](docs/js/app.js)
  `loadProjects`). We run two queries in parallel — every subfolder of
  Site Visits, and every `.dancon-project` marker we own — and keep
  only the folders whose IDs appear in some marker's `parents` array.
  Manually-created Drive folders are invisible to the app: no list
  entry, no GPS auto-capture, no caching.
- **One-time backfill migration** (app.js `runProjectMarkerMigration`).
  Runs once per device after first launch on this version (tracked by
  `markers.migrated.v1` in IDB). Walks every Site Visits subfolder
  without a marker, lists its top files, and stamps a `migrated: true`
  marker on any folder that already contains app-generated content
  (`visit_log.txt`, `notes.txt`, `gps.txt`, `gps.html`, or files
  matching `YYYY-MM-DD_HH-MM_…`). Folders with no app content stay
  unmarked.
- Marker stamping is also re-checked on `openOrCreateProject` — if a
  folder already has a marker (rename / reuse path) we skip the
  duplicate write.

### Recently shipped — Reliability sweep #2 (SW v19)
- **A: Auth decoupled from initial render** ([auth.js](docs/js/auth.js)).
  `Auth.init()` is now cache-only — restores user/token from IDB+LS and
  returns. The GIS script wait moved into `ensureTokenClient()` which
  is called lazily by `requestToken`. The boot path never blocks on
  GIS, so the home screen paints from cache even when GIS is slow to
  load after wake-from-idle.
- **B: No more silent sign-out on refresh failure** (auth.js). The
  `getAccessToken` failure path no longer clears `user`. Sign-out is
  now reserved for: explicit `Auth.signOut()`, OAuth `invalid_grant` /
  `unauthorized_client` (caught from `requestToken`), and a 7-day
  stale-token check at init time. Auth is also instrumented with a
  `tokenStatus` ('unknown' | 'valid' | 'refreshing' | 'failed') that
  the rest of the app subscribes to.
- **E: Heartbeat status dot** ([app.js](docs/js/app.js),
  [style.css](docs/css/style.css)). Fixed-position 10px dot at top-
  right; green = connected, yellow pulsing = reconnecting, red =
  offline. Hidden on the login screen.
- **Reconnect loop** (app.js). `tokenStatus === 'failed'` arms a 30-
  second background retry that calls `getAccessToken(true)` until it
  succeeds. The UI is never blocked.
- **F: Wake-from-idle handler** (app.js). On `visibilitychange` →
  visible after >5 min hidden, we proactively refresh the token + re-
  validate the cached project list / project media. Background only.
- **C: GPS as pinned location** (app.js). The new `loadPinnedLocation`
  reads from `project.{folderId}.pinnedLocation` in IDB; if empty it
  parses an existing `gps.txt` / legacy `gps.html` from Drive and
  populates the cache (one-time migration). `getCurrentPosition` is
  ONLY called from `captureLocationExplicit`, which fires on tap of
  the new "📍 Capture location" button or long-press of the pinned
  chip ("Update location" with a confirmation). The chip flips between
  capture-CTA orange and pinned-confirmed green based on state.
- **D: Camera permission recovery** ([capture.js](docs/js/capture.js)).
  `showDenied()` now picks platform-specific instructions
  (iOS-PWA / iOS-Safari / iOS-other / Android / desktop) and offers
  an **"I've enabled it"** retry button that re-runs `getUserMedia`
  inline. A separate `showWakeBug()` panel handles the case where
  `permissions.query` reports 'granted' but `getUserMedia` still
  rejects with NotAllowedError — that's the iOS wake-from-idle quirk;
  the message tells the tech to close + reopen the app.
- **G: Voice delete** (app.js `deleteThumb`). Long-press already
  surfaced trash for any thumb; now the delete path also: (a) closes
  any in-flight VideoPlayer holding this blob; (b) deletes the
  matching `_transcript.txt` sibling on Drive if present;
  (c) appends a `[DELETED voice recording <name>]` line to
  `visit_log.txt`; (d) updates the strip in place without a refresh.
- **H: Per-project cache-first** (app.js). New IDB key
  `project.{folderId}.cache` stores the file list. `enterProject` now
  calls `preloadProjectMediaFromCache` BEFORE `refreshProjectMedia`,
  so the gallery paints in <200ms; the live Drive fetch runs in the
  background and only re-renders when `fileListEqual` returns false.
  A subtle `.sync-dot` next to the "Captured" header pulses while
  syncing; the old "Loading…" line is replaced with a 3×2
  `.thumb-skeleton` shimmer on first-ever project opens.

### Recently shipped — Reliability sweep #1 (SW v18)
- **Token refresh** ([auth.js](docs/js/auth.js)): `requestTokenOnce` now
  has a 10s strict per-attempt timeout; `requestToken` wraps it with 5
  retries on exponential backoff (500/1000/2000/4000/8000ms = 6 total
  attempts). `getAccessToken` returns the cached token instantly when
  >2 minutes of life remain; a single in-flight `pendingRefresh` is
  shared by concurrent callers. Auth-side errors are filtered out of
  user-facing toasts (`friendlyErrorMessage` rewrites to "Sign-in is
  reconnecting — please try again in a moment").
- **Camera indicator** ([capture.js](docs/js/capture.js)): the 45s
  stream cache is removed entirely. Every `Camera.open` acquires a
  fresh stream; `close()` stops every track + nulls `videoEl.srcObject`
  synchronously. App.js adds a `beforeunload` listener as a final
  safety net alongside the existing `visibilitychange` / `pagehide`
  hooks.
- **GPS** ([app.js `runTwoStageGps`](docs/js/app.js)): rewritten to a
  two-stage parallel strategy. Stage 1 is `enableHighAccuracy:false`,
  5s timeout, 60s cache age — paints the chip immediately; if it fails
  it retries once with `maximumAge: 300000`. Stage 2 runs in parallel
  with `enableHighAccuracy:true`, 20s timeout, no cache; if it returns
  a tighter `accuracy` than stage 1, the gps file is silently rewritten
  in-place. Output is now `gps.txt` (Drive renders raw `.html` as code,
  per office team feedback). Format: `Location captured: <ts EDT>` /
  Tech / Latitude / Longitude / Accuracy / Google Maps.
- **Cache-first home** ([app.js `loadProjects`](docs/js/app.js)):
  reads `projects.cache` from IndexedDB on mount and paints instantly;
  `listProjectFolders` runs in parallel and only diffs into state when
  `projectsEqual` returns false. New schema is
  `{ projects: [{id, name, modifiedTime}], cachedAt }`. A subtle
  `.sync-dot` next to the "Recent sites" header pulses while syncing;
  the old "Loading…" line is replaced with a `.list-skeleton` shimmer
  on first-ever launch only.
- **Cross-platform install hint** ([app.js `showInstallHint`](docs/js/app.js)):
  replaces the iOS-only banner with a blocking install screen that
  picks instructions per platform. iOS Safari → Share/Add to Home
  Screen; Android Chrome → captures `beforeinstallprompt` and
  surfaces an Install button that calls `prompt()`; desktop Chrome /
  Edge → install icon in the address bar. Skipped automatically when
  `display-mode: standalone` is true. Dismissed flag now lives in
  `localStorage.install_hint_shown` so it survives IDB resets.

## How to keep iterating
- Local dev: `cd docs && python3 -m http.server 8000` → http://localhost:8000
- Bump `CACHE_VERSION` in `docs/service-worker.js` on each release.
- After deploys, hard-refresh once on iOS to drop the previous SW.

## Conventions
- All shared state and screens live in `docs/js/app.js`.
- Each subsystem is its own module: `auth`, `db`, `drive`, `capture`,
  `audio`, `notes`, `annotate`, `viewer`, `video-player`, `ui`.
- Render strategy in app.js: shell only re-renders on view change;
  same-view state changes use targeted DOM mutations to preserve
  focus and the live `<video>` element.
