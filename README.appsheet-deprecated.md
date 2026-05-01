# Dancon Site Visit Photo Logger

Field photo capture for Dancon technicians — same stack as Dancon Receipts (AppSheet + Apps Script + Google Drive). The tech opens the app, types a project title, and captures photos at the site visit. Photos land in a structured Drive folder organized by project and visit.

## Status

**Not built yet.** This directory holds the build spec (this README) and the script that will run once the spreadsheet and AppSheet app are wired up.

## v1 scope

- Photos only (no video, no voice notes, no Gemini transcription).
- Tech types project title → photos captured in-app → Apps Script files them into `Site Visits/[Project Title]/[YYYY-MM-DD_HH-MM]/` on Drive.
- GPS captured once at parent creation, stored as plain `gps_lat`/`gps_lng` numbers + a generated Google Maps link.
- Notes optional, editable any time.
- 5-minute trigger model (eventually consistent, same as Receipts). No webhook.

## Stack

- **Capture:** Google AppSheet mobile app (iPhone + Android).
- **Glue:** Google Apps Script, time-based trigger every 5 minutes (`processSiteVisits`).
- **Storage:** Google Drive shared drive, under `Site Visits/`.
- **Source of truth:** Google Sheet `Dancon Site Visits - Data` with three tabs (`Submissions`, `Photos`, `Config`).

## Drive folder structure

```
Site Visits/
  [Project Title]/
    [YYYY-MM-DD_HH-MM]/
      001.jpg
      002.jpg
      ...
```

Project title is sanitized for filesystem chars (`/ \ : * ? " < > |` stripped). Time component on the leaf folder gives uniqueness for repeat visits the same day. Photos within a visit are renamed to a 3-digit sequence in `captured_at` order.

## Sheets schema

### `Submissions` — one row per visit

| Column | Type | Written by | Notes |
|---|---|---|---|
| `site_visit_id` | Text (PK) | AppSheet UUID | Foreign key for Photos |
| `status` | Text | Script | `Filed` / `Error` / blank |
| `created_at` | DateTime | AppSheet auto | `NOW()` |
| `tech_email` | Email | AppSheet auto | `USEREMAIL()` |
| `project_title` | Text | Tech input | "55 East 87th Street - Water Damage" |
| `gps_lat` | Number | AppSheet auto | `LATITUDE(HERE())` |
| `gps_lng` | Number | AppSheet auto | `LONGITUDE(HERE())` |
| `gps_maps_link` | URL | Script | `https://maps.google.com/?q=lat,lng` |
| `photo_count` | Number | Script | Count of `Filed` Photos rows |
| `notes` | LongText | Tech (optional) | Editable any time |
| `drive_folder_id` | Text | Script | |
| `drive_folder_url` | URL | Script | |
| `script_notes` | Text | Script | Errors / diagnostic |

`gps_lat`/`gps_lng` are stored as plain Numbers (not AppSheet's `LatLong` type) so a future PWA can write to the same sheet via the Sheets API without dealing with AppSheet's `"lat, lng"` string format.

### `Photos` — one row per image

| Column | Type | Written by | Notes |
|---|---|---|---|
| `photo_id` | Text (PK) | AppSheet UUID | |
| `site_visit_id` | Text (FK) | AppSheet | References `Submissions.site_visit_id` |
| `photo` | Image | AppSheet capture | Actual file in Drive |
| `status` | Text | Script | `Filed` / `Error` / blank |
| `captured_at` | DateTime | AppSheet auto | `NOW()` |
| `final_drive_link` | URL | Script | Link after move/rename |

### `Config`

| Key | Value |
|---|---|
| `SITE_VISITS_ROOT_FOLDER_ID` | Drive folder ID for `Site Visits/` root |

The script's `CONFIG` IIFE reads this tab on load.

## AppSheet spec

### `Submissions` table column behavior

| Column | Type | Key | Initial value | Editable | Show in form |
|---|---|---|---|---|---|
| `site_visit_id` | Text | yes | `UNIQUEID()` | No | Hidden |
| `status` | Text | | | No | Hidden |
| `created_at` | DateTime | | `NOW()` | No | Hidden |
| `tech_email` | Email | | `USEREMAIL()` | No | Hidden |
| `project_title` | Text | | | Yes | Yes (required) |
| `gps_lat` | Decimal | | `LATITUDE(HERE())` | No | Hidden |
| `gps_lng` | Decimal | | `LONGITUDE(HERE())` | No | Hidden |
| `gps_maps_link` | URL | | | No | Detail only |
| `photo_count` | Number | | | No | Detail only |
| `notes` | LongText | | | Yes | Yes (optional) |
| `drive_folder_id` | Text | | | No | Hidden |
| `drive_folder_url` | URL | | | No | Detail only |
| `script_notes` | Text | | | No | Hidden |

### `Photos` table column behavior

| Column | Type | Key | Initial value | Editable | Show in form |
|---|---|---|---|---|---|
| `photo_id` | Text | yes | `UNIQUEID()` | No | Hidden |
| `site_visit_id` | Ref → Submissions | | (set by parent action) | No | Hidden |
| `photo` | Image | | | Yes | Yes (camera capture) |
| `status` | Text | | | No | Hidden |
| `captured_at` | DateTime | | `NOW()` | No | Hidden |
| `final_drive_link` | URL | | | No | Detail only |

### Views

- **Site Visits** — Deck or Table view of `Submissions`, sorted by `created_at` DESC. Default landing view.
- **Site Visit Detail** — Detail view of a `Submissions` row. Inline child list of `Photos` (sorted by `captured_at` ASC). The system Edit action lets the tech add/edit `notes`.
- **Add Site Visit** — Form view: only `project_title` is shown; everything else is set by initial values.

### Actions

- **"Take Photo"** — Inline action on the Site Visit Detail view. Type: *Add a new row to another table using values from this row*. Target: `Photos`. Sets `site_visit_id` = `[site_visit_id]` of current row. Form has only the `photo` field visible so it auto-launches the camera on tap.

## Apps Script flow (`processSiteVisits`)

Runs every 5 minutes. Three phases per run:

1. **Parents** — for each `Submissions` row with blank `status`: sanitize project title, compute leaf folder name from `created_at`, get-or-create the Drive folder, write `drive_folder_id` / `drive_folder_url` / `gps_maps_link`, mark `status = Filed`.
2. **Photos** — for each `Photos` row with blank `status`: look up parent in-memory, skip if parent isn't Filed yet (will pick up next run), resolve the photo file via `DriveApp.getFilesByName` (global lookup), move it to the parent's folder, rename to `NNN.ext` where `NNN = (existing Filed children) + position-in-batch` padded to 3 digits, mark `status = Filed`.
3. **Photo count** — recount Filed children for each Filed parent, write back `photo_count`.

A photo whose parent isn't ready is left `status = blank` and re-evaluated next run. Errors set `status = Error`.

## Setup checklist

1. Create the `Site Visits/` root folder in the Dancon shared drive.
2. Create new Google Sheet `Dancon Site Visits - Data` with three tabs: `Submissions`, `Photos`, `Config`.
3. Add headers to each tab per the schema above.
4. Fill in the `Config` row: `SITE_VISITS_ROOT_FOLDER_ID` = (root folder ID from step 1).
5. Open Extensions → Apps Script in that sheet, paste `Code.gs`.
6. Run `installTrigger()` once from the Apps Script editor — authorize when prompted, this installs the 5-minute trigger.
7. Build the AppSheet app from the sheet, configure columns / views / action per spec.
8. Smoke test from a phone: create one Site Visit, take 2 photos, wait 5 minutes, verify Drive folder structure and that the sheet rows are marked `Filed` with the right links.

## v2 backlog (kept compatible by v1 design)

- **Video upload.** Workaround for now: tech records natively on iPhone, attaches via AppSheet's `File` column gallery picker. v2 adds a `Videos` child table parallel to `Photos`. No schema changes to `Submissions` — new tab + new "Add Video" action only.
- **Voice notes + Gemini transcription.** AppSheet supports in-app audio capture. v2 adds `voice_note_url` and `transcription` columns to `Submissions`; script transcribes via the same Gemini pattern as Receipts and drops a `.txt` file in the project folder.
- **PWA migration.** v1 schema is plain-data (Number lat/lng, UUID PKs, plain folder paths) so any PWA can write to the same sheet via the Sheets API and the same Drive via the Drive API. The Apps Script wouldn't have to change at all; only the capture surface swaps.

## Owner

Elona Sopiqoti — `elona@danconservices.com`
