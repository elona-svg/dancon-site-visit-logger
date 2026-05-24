# Site Visit Logger — progress log

> Live: https://elona-svg.github.io/dancon-site-visit-logger/
> Repo: https://github.com/elona-svg/dancon-site-visit-logger
> Source folder served by GitHub Pages: `docs/`
> Latest commit at the time of writing: see `git log -1`.

Update this file at the end of every working session so the next session
can pick up exactly where this one stopped.

## Current state (2026-05-24)

### Recently shipped — Fetch-based Drive chunk PUTs (SW v60)

Switched Google Drive resumable upload chunk PUTs from XHR to `fetch()`
for iOS WebKit PWA stability.

- `putResumableChunk` now uses `fetch(sessionUrl, { method: 'PUT',
  keepalive: true, ... })` instead of `XMLHttpRequest`.
- Preserved Drive resumable protocol handling: `2xx` final chunks parse
  file metadata, `308` chunks advance to the next byte range, and failed
  responses still throw for the retry/resume logic.
- Progress now advances after each accepted chunk, avoiding the XHR upload
  progress path that was stalling at byte 0 on iOS.

### Recently shipped — Network-stall upload handling (SW v59)

Fixed the retry UI and circuit-breaker behavior for weak 5G uploads.

- Upload stall errors (`Upload stalled`, resume-query timeout/network
  errors) now count as real network failures.
- The upload circuit breaker now pauses after the first real network
  failure, then probes Drive reachability and resumes automatically
  instead of walking every pending thumb into an error-looking state.
- Failed upload attempts remain stored as `pending` in IndexedDB with a
  retry delay, so refreshes show local captures as pending/queued rather
  than permanent red per-thumb failures.
- Legacy `error` rows from earlier builds are normalized to pending on
  project load, and the global button now reads "Retry Pending".

### Recently shipped — Drive/local queue reconciliation (SW v58)

Fixed the dangerous split-brain state where a capture could exist in
Google Drive but remain in IndexedDB as a pending local upload after an
app refresh or a lost final upload response.

- Before every queued upload starts, the app now checks the target Drive
  folder for an existing file with the same name, size, and MIME type.
  If found, it clears the local queue row instead of uploading a
  duplicate.
- Every live project media refresh reconciles the local queue against the
  Drive file list and removes matching local pending rows.
- Drive files now win over same-name local pending thumbs during the
  capture-screen merge, so one physical capture cannot appear as both a
  successful Drive file and a pending local upload.

### Recently shipped — Stable thumbnail upload badges (SW v57)

Fixed the capture screen flicker during uploads. Upload status/progress
changes no longer call the full thumb-strip renderer, so existing
thumbnail `<img>` nodes keep their original `src` and stay mounted until
the user leaves the folder or the thumb is otherwise structurally changed.

- `patchThumbByQueueId` now updates only the matching thumb's status UI
  in place: root `pending`/`queued` classes, `.thumb-state` text/hidden
  state, progress bar visibility/width, retry button visibility, and the
  local queue indicator.
- `thumbHtml` always renders stable status/progress/retry controls so
  later upload transitions mutate those controls instead of rebuilding
  the entire `.thumb` element.
- Error queue items are treated as pending for badge/retry display, and
  the pending warning counts every local queued item until upload success.

### Recently shipped — Reinstall warning, drop per-capture download popup (SW v56)

The v55 `<a download>` backup triggered an iOS download dialog on
EVERY capture — 20 photos = 20 popups. Unusable for field work. Reverted.

- Removed the `saveBlobLocally` call from
  [enqueueCapture](docs/js/app.js). IndexedDB remains the only local
  store for pending captures, which is fine as long as the PWA isn't
  reinstalled — and v55's auto-update fix means it shouldn't ever
  need to be.
- Removed `maybeShowBackupHint` (no longer relevant).
- `UI.saveBlobLocally` / `UI.saveBlobToCameraRoll` stay exported for
  any future explicit "save this one to my device" button.
- Strengthened the pending-uploads indicator: while items are queued,
  the project screen now also shows
  "⚠️ Do not reinstall the app until these finish uploading"
  right under the count, in an unmissable amber panel. Reinstall is
  the only path that wipes IDB; v55's auto-update means the user
  shouldn't ever reinstall, but the warning protects against habit.

### Recently shipped — Local backup + auto-update fix (SW v55)

**Two production-critical bugs found and fixed.**

**Bug 1 — Pending photos lost on reinstall.** [ui.js](docs/js/ui.js)
`saveBlobLocally` was defined but **NOT in the module export list** (the
`return { … }` at the bottom). Every call in
[app.js](docs/js/app.js) `enqueueCapture` was `window.UI?.saveBlobLocally`
which silently no-op'd. No local backup ever happened. When a tech
reinstalled the PWA to get an update, IndexedDB was wiped and every
queued photo was permanently lost.

Fix:
- Export `saveBlobLocally` from ui.js (the bug fix).
- Strip the share-sheet path out of it — that path popped iOS's share
  sheet per file, which is unusable for back-to-back captures. Use
  plain `<a download>` click instead; iOS saves to Files → Downloads,
  silently or with one allow-downloads tap.
- Move the `saveBlobLocally` call to BEFORE `queueAdd` in
  `enqueueCapture` so the backup hits the device-local Downloads
  folder before any upload attempt.
- Both photo AND video go through it now (was photo-only intent).
- New `maybeShowBackupHint()` shows a one-time toast on first capture:
  "Saving a backup copy to Files so it survives reinstall. Tap 'Allow'
  or 'Save' if iOS asks." Stored in `localStorage.backup_hint_shown`.
- New `UI.saveBlobToCameraRoll(blob, filename)` provides an explicit
  `navigator.share({files})` path for future "Save to Photos" buttons
  where the user wants Camera Roll specifically (one prompt per tap).

**Bug 2 — Auto-update never fired; reinstall was the only way to get
new code.** [index.html](docs/index.html) registered the service
worker at `'service-worker.js?v=v49'` — **hardcoded** to the v49
string from weeks ago and never updated since. Browser served the
cached v49 SW response forever, `updatefound` never fired, the in-
page refresh banner never appeared, techs had to manually reinstall
the PWA to get any code change. This is what caused the recurring
"reinstall to get the fix" loop today.

Fix:
- SW URL now uses `window.CONFIG.APP_VERSION` dynamically, so every
  release auto-busts the SW cache.
- v55 onwards: bumping APP_VERSION (which we already do per release)
  is enough — index.html picks it up, browser fetches a new SW, the
  existing `updatefound` → banner path fires automatically.

The combination means: techs see the orange refresh banner next time
they open the app after a deploy, AND any captures they already have
stay safe in Files → Downloads even if they wipe IDB.

### Recently shipped — Chunked PUT + stall detector (SW v54)

**Bug:** Photo uploads on 5G hung for the full 60s timeout with zero
bytes transferred, then retried once and failed the same way. Log
showed two back-to-back `Request timed out after 60000ms during PUT
at byte 0` failures per item — the TCP socket was effectively dead
but iOS kept it open until our timeout fired, and the entire 1.2 MB
PUT was attempted as a single request that never moved a byte.

**Fix in [drive.js](docs/js/drive.js):**

- **Chunked resumable PUTs.** 1.2 MB photos now upload in 256 KiB
  chunks instead of one big request. Drive's resumable protocol
  supports this natively (`Content-Range: bytes X-Y/total`, 308
  response means "more please"). On weak signal a small chunk has a
  much better chance of completing than a multi-megabyte single PUT,
  and a stalled chunk only costs that chunk — we resume from the next
  byte instead of restarting from zero.
- **Per-chunk stall detector.** Each chunk PUT installs a 3s interval
  that aborts the XHR if `xhr.upload.onprogress` hasn't fired in
  ≥15s. iOS reliably keeps dead sockets open until the full timeout
  fires; the stall detector kills them fast so the queue moves on.
- **3 attempts per chunk, 45s per attempt.** Failed-chunk path queries
  the server for received bytes and advances if the server got more
  than we tracked locally — avoids resending bytes already on Drive.

Worst-case per-chunk wait drops from 60s (full timeout, no progress)
to ~15s (stall detector). For a 1.2 MB photo that's 5 chunks × up to
15s each = ~75s worst case instead of 120s before, and any chunk that
DOES complete locks in that progress permanently.

### Recently shipped — Drive thumbnail auth fallback (SW v53)

**Bug:** Uploaded photos showed as blank grey squares in the gallery
and "Could not load image" in the viewer.

**Cause:** Drive's `thumbnailLink` points at `lh3.googleusercontent.com`,
which requires Google session cookies. Installed iOS PWAs run in a
webview with an isolated cookie jar (the same constraint that drove
the PKCE-via-Worker auth design in [auth_pwa.md](auth_pwa.md)), so
those img loads silently fail and the existing `onerror="display:none"`
just hid the broken images.

**Fix:**

- New `fetchDriveImageBlobUrl(fileId)` in [app.js](docs/js/app.js)
  fetches the file via the Drive API with our Bearer token
  (`/files/{fileId}?alt=media`) and serves it as a blob URL. Cached
  per fileId for the page lifetime so repeat renders are free.
- Photo thumbs (project strip + gallery cell) now carry `data-fid` and
  call a global `window.__driveThumbErr` handler that swaps the broken
  `lh3` URL to the authed blob URL on failure. Each img only retries
  once so a bad blob doesn't loop.
- Viewer's `loadCurrentImage` and `preloadDriveImage` reuse the shared
  cache via `window.__fetchDriveImageBlobUrl` so a thumb the gallery
  already authed-fetched opens instantly in full screen.
- Viewer no longer dead-ends on API failure — falls through to the
  `thumbnailLink` src as a last-resort fallback.
- Viewer's blob-URL cleanup on close skips URLs that came from the
  shared cache so it doesn't revoke URLs the gallery still needs.

Video thumbnail cells stay with the `display:none` fallback — fetching
the full video just to render a thumb would burn too much bandwidth;
the ▶ play overlay keeps the cell usable.

### Recently shipped — Resumable observability + fail-fast (SW v52)

**Bug:** After v50 shipped the resumable code, items were getting stuck
at 0% with only "starting" in the log panel and nothing after. Two
problems:

1. Inner retry loop was too patient — 5 attempts × 120s PUT timeout =
   up to 10 minutes per item before the outer startUpload catch saw a
   failure. While stuck, `consecutiveNetErrors` stayed at 0 so the
   circuit breaker never tripped.
2. The on-screen log panel only got entries from app.js, not drive.js.
   Resumable init, session creation, PUT attempts, and resume queries
   were all invisible to the tech.

**Fix:**

- `MAX_RESUME_ATTEMPTS` 5 → 2 in
  [drive.js resumablePutWithResume](docs/js/drive.js). Outer queue
  retries pick up the slack and surface to the breaker quickly.
- PUT timeout 120s → 60s, query timeout 20s → 15s, init POST timeout
  60s → 20s. Worst-case per-item time drops from ~10 min to ~2.5 min.
- New `onLog` callback on `uploadFile` /
  [uploadResumable](docs/js/drive.js). Drive emits `init-started`,
  `session-created`, `put-started` (with byte range and attempt),
  `put-failed`, `resume-from-byte`, `resume-query-failed`,
  `resume-complete`. App.js wraps `appendUploadLogEntry` as the
  callback so each milestone appears in the in-app log panel.

### Recently shipped — Viewer X ghost-click fix (SW v51)

**Bug:** Tapping X on a full-screen photo inside a project sent the tech
to the Sites home screen instead of returning to the project they were
in.

**Cause:** [viewer.js](docs/js/viewer.js) `closeCaptureListener` fires
on `pointerdown` in the capture phase and tears down the viewer DOM
immediately. The synthesized `click` that follows lands on whatever is
now under the finger — the project screen's "‹ Sites" back button in
the same top-left position — which runs `leaveProject()` and pops to
home.

**Fix:** New `armGhostClickSwallow()` helper installs a one-shot
capture-phase `click` listener that swallows the next click for 700ms
when `closeCaptureListener` triggers close. The X handler's own click
path is untouched (when X handles the click directly the DOM is gone
before any other element can claim it).

### Recently shipped — Network resilience (SW v50)

Diagnosed why uploads stall on weak signal: queue runner trusted
`navigator.onLine`, retried back-to-back with no pause, and multipart
uploads restarted from byte 0 on every failure. Four changes ship
together:

- **Network-error circuit breaker** ([app.js](docs/js/app.js)). After
  2 consecutive `Network error` failures the breaker opens: pump halts,
  watchdog stands down, and a 30s `HEAD` probe against
  `googleapis.com/drive/v3/about` polls until reachability returns. A
  successful upload OR a successful probe closes the breaker and
  resumes the pump. `navigator.onLine`'s online event also triggers a
  probe instead of optimistically resuming.
- **Degraded (orange) connection dot** ([app.js](docs/js/app.js)
  `getConnectionStatus` / `updateConnDotDOM`, [style.css](docs/css/style.css)).
  Third state distinct from reconnecting (amber, fast pulse) and
  offline (red). Tooltip: "Network unstable — uploads paused, retrying
  soon" so the tech knows it's the network, not the app.
- **5s pause between failed items** ([app.js startUpload finally](docs/js/app.js)).
  When `consecutiveNetErrors > 0`, the next pump waits 5s rather than
  firing the same millisecond — stops burning 15s-per-attempt back-to-
  back on a dead link.
- **All uploads are now resumable with byte-range resume**
  ([drive.js uploadFile / resumablePutWithResume](docs/js/drive.js)).
  Photos no longer take the multipart path. On any PUT failure we query
  the session (`PUT … Content-Range: bytes */<total>`) and resume from
  the last received byte instead of restarting. Up to 5 resume attempts
  with exponential backoff. Multipart is reserved for tiny metadata
  writes (notes.txt, visit_log.txt, marker) where the resumable round-
  trip is pure overhead.

Manual retry from a thumbnail force-closes an open circuit so the user
gets one optimistic attempt; if it fails the breaker simply re-trips.

## Current state (2026-05-22)

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
- Offline-first indexedDB-backed local queue. Captured photos/videos are saved locally immediately and persist across app restarts.
- Sequential single-file upload pipeline with per-thumb progress; items are only removed from local storage after confirmed Drive upload success.
- Auto-retry on reconnect, with pending/queued status shown instead of a hard "Failed" state.
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
- Login now uses a redirect-based Google OAuth flow instead of a popup,
  avoiding iOS popup blocker prompts and returning to the app via PKCE.

### Recently shipped — Offline-first reliability (SW v48)
- **Video thumbnail frames**. Fixed frame extraction by explicitly waiting
  for seeked events before canvas draw, with black fill background for
  safety. Extracts frame at up to 1 second instead of blurry black.
- **Offline app load**. Service worker now properly caches and serves
  `index.html` for navigation requests so the app loads completely offline.
- **Auth skips GIS when token valid**. `ensureTokenClient()` now checks if
  a cached token is fresh (>2min remaining) and skips loading GIS entirely,
  saving ~3s on startup when user is already logged in with a valid token.
- **Camera reconnect prompt once-per-session**. The "Camera needs to reconnect"
  message now only shows once per app open, preventing spam if the tech
  tries to open the camera multiple times. It no longer resets when the
  camera overlay closes, so it only appears for the actual iOS wake-from-idle bug.
- **Bulk delete toast consolidation**. Deleting multiple files now shows a
  single "X files deleted" success toast instead of one toast per file.
- **Update banner is the only refresh action needed**. The SW update
  banner now clearly says "App updated — tap to refresh" and reloads the app
  when tapped.
- **GitHub Pages cache-busting**. `index.html` now includes a no-cache
  meta tag, and the service worker is registered with a versioned URL so
  `service-worker.js` avoids stale GitHub Pages caching.
- **Deploy process**. After code changes in VS Code, commit and push to
  `main`; GitHub Pages serves `docs/` from the repo root, so every push to
  `main` updates the live site after GitHub Pages rebuilds.

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
