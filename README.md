# Dancon Site Visit Logger (PWA)

Mobile-first field documentation app for IBX Emergency LLC dba Dancon Services.
Replaces the WhatsApp / camera-roll chaos with a structured Google Drive archive
organized by job site.

> The earlier AppSheet + Apps Script approach is archived in
> `README.appsheet-deprecated.md` and `Code.gs`. The PWA in `pwa/` is the
> current implementation.

## What it does

- Sign in with `@danconservices.com` Google Workspace account.
- Type a project name → folder created (or reused) under the shared
  **Site Visits** Drive folder
  (`10qzHqY5bY71_QQjNYqYv1l8SXC9Zfn4A`).
- Tap once to capture: photo, video, voice note, or text note. Everything
  uploads to the project folder immediately.
- Continuous in-app camera — shutter stays ready for the next shot.
- Tap a photo in the gallery to mark it up (arrows, circles, freehand);
  the annotated copy is saved alongside the original.
- GPS captured on first visit and saved as `gps.txt`.
- Every action appends a line to `visit_log.txt` for an audit trail.
- Files named `YYYY-MM-DD_HH-MM_FirstName_NNN.ext`.
- Offline-tolerant: captures queue in IndexedDB and retry when back online.

## Repo layout

```
pwa/
  index.html
  manifest.json
  service-worker.js
  css/style.css
  js/
    config.js     ← edit CLIENT_ID here
    db.js         ← IndexedDB queue + KV
    auth.js       ← Google Identity Services OAuth2
    drive.js      ← Drive API helpers (upload, list, append)
    capture.js    ← in-app camera (photo + video)
    audio.js      ← voice-note recorder
    notes.js      ← text-note modal
    annotate.js   ← canvas-based photo markup
    ui.js         ← formatters + toasts
    app.js        ← state, screens, queue runner
```

## Setup

### 1. Create the OAuth client

1. Go to <https://console.cloud.google.com> and pick (or create) a project
   for the workspace.
2. Enable the **Google Drive API** (APIs & Services → Library).
3. APIs & Services → **OAuth consent screen**:
   - User type: **Internal** (so it's restricted to `@danconservices.com`).
   - Add scopes: `.../auth/drive`, `openid`, `email`, `profile`.
4. APIs & Services → **Credentials** → Create credentials → **OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins:**
     - `https://<your-github-username>.github.io` (for GitHub Pages)
     - `http://localhost:8000` (for local testing)
   - No redirect URIs needed (the app uses the popup flow).
5. Copy the generated **Client ID** (looks like
   `1234567890-xxxxx.apps.googleusercontent.com`).

### 2. Wire the Client ID into the app

Edit `pwa/js/config.js`:

```js
window.CONFIG = {
  CLIENT_ID: 'PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com',
  ...
};
```

The `SITE_VISITS_FOLDER_ID` is already pinned to Dancon's existing folder.

### 3. Verify the shared folder

Make sure every `@danconservices.com` user that needs to use the app has at
least Editor access on the **Site Visits** folder
(`10qzHqY5bY71_QQjNYqYv1l8SXC9Zfn4A`). If it lives inside a Shared Drive,
add the team as members of that drive. The app uses the user's own
credentials — Drive enforces access on every call.

### 4. Deploy to GitHub Pages

```bash
cd ~/Documents/dancon-site-visit-logger
git init
git add pwa README.md
git commit -m "Initial PWA"
gh repo create dancon-site-visit-logger --public --source=. --push
```

In the repo's **Settings → Pages**:
- Source: `main` branch
- Folder: `/pwa`

A few minutes later the app is live at
`https://<user-or-org>.github.io/dancon-site-visit-logger/`.

> Don't forget to add this URL to the OAuth client's authorized origins.

### 5. Local testing

`getUserMedia` and Service Workers require HTTPS or localhost. Easiest:

```bash
cd ~/Documents/dancon-site-visit-logger/pwa
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

## Field usage

1. Open the app on iPhone Safari or Android Chrome and tap **Sign in**.
   Add to home screen the first time so it launches like a native app.
2. Type the project name (e.g. `55 East 87th — Water Damage`) and tap
   **Open**, or pick from the recent list. Folder is auto-created.
3. Use the four big tiles:
   - 📷 **Photo** — opens an in-app viewfinder. Big shutter button. Each
     photo uploads immediately; the camera stays ready for the next.
   - 🎥 **Video** — same viewfinder; tap to record, tap again to stop.
   - 🎙️ **Voice** — tap big mic, talk, tap stop. Uploads as audio.
   - 📝 **Note** — typed text appended to `notes.txt`.
4. Tap **Files** to see everything in the folder. Tap a photo to mark it
   up and save the annotated copy.
5. Tap **‹ Sites** to leave the project; the folder will be on top of the
   recent list next time.

## What lives in each project folder

```
Site Visits/<Project Name>/
  2026-05-01_14-32_Elona_001.jpg
  2026-05-01_14-32_Elona_002.jpg
  2026-05-01_14-35_Elona_003.mp4
  2026-05-01_14-37_Elona_004.webm     # voice note
  2026-05-01_14-39_Elona_annotated_005.jpg
  notes.txt
  visit_log.txt
  gps.txt
```

`visit_log.txt` example:

```
2026-05-01 14:32 — Elona Sopiqoti — captured GPS
2026-05-01 14:32 — Elona Sopiqoti — uploaded photo: 2026-05-01_14-32_Elona_001.jpg (612 KB)
2026-05-01 14:32 — Elona Sopiqoti — uploaded photo: 2026-05-01_14-32_Elona_002.jpg (587 KB)
2026-05-01 14:35 — Elona Sopiqoti — uploaded video: 2026-05-01_14-35_Elona_003.mp4 (8.4 MB)
2026-05-01 14:37 — Elona Sopiqoti — added text note
```

## Iterating

The service worker uses **network-first** caching keyed on the
`CACHE_VERSION` constant. After every deploy, bump `CACHE_VERSION` in
`pwa/service-worker.js` so installed clients pick up the new code on next
launch (or pull-to-refresh).

## Permissions reference

| Permission        | When prompted                | Why |
|-------------------|------------------------------|-----|
| Camera            | First Photo or Video tap     | Required for in-app capture |
| Microphone        | First Voice or Video tap     | Recording audio |
| Location (GPS)    | First time entering a project | One-shot save to `gps.txt` |
| Notifications     | Never                        | Not used |
