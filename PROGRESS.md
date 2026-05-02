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

### Recently shipped
- Audio playback in-app: VideoPlayer now accepts `kind: 'audio'` and
  renders an `<audio controls autoplay>` card; tapping a voice-note
  thumb opens the player instead of a new tab.
- iOS Add-to-Home-Screen hint banner: shown once on iPhone Safari
  when not running standalone, dismissible, flag persisted in IDB.
- GPS upload now routed through the regular upload queue, so a flaky
  network gets the same retry/backoff/persistence as photos. The
  on-screen GPS chip is set as soon as geolocation resolves so the
  tech sees their location immediately even if the upload is still
  pending.

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
