const CONFIG = (() => {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Config');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const cfg = {};
  rows.forEach(([k, v]) => cfg[k] = v);
  return cfg;
})();

function processSiteVisits() {
  const ss = SpreadsheetApp.getActive();
  const subSheet = ss.getSheetByName('Submissions');
  const photoSheet = ss.getSheetByName('Photos');

  const subData = subSheet.getDataRange().getValues();
  const subCol = buildColumnMap(subData[0]);

  // Phase 1 — process parents (folder creation)
  const parentById = {};
  for (let i = 1; i < subData.length; i++) {
    const row = subData[i];
    const id = row[subCol.site_visit_id];
    if (!id) continue;
    parentById[id] = {
      rowNum: i + 1,
      driveFolderId: row[subCol.drive_folder_id],
      status: row[subCol.status]
    };
    if (row[subCol.status]) continue;

    try {
      const projectTitle = sanitizeFolderName(row[subCol.project_title]);
      const leaf = formatLeafFolderName(row[subCol.created_at]);
      const folder = getOrCreateProjectFolder(projectTitle, leaf);
      const lat = row[subCol.gps_lat];
      const lng = row[subCol.gps_lng];
      const mapsLink = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';

      writeRow(subSheet, subCol, i + 1, {
        status: 'Filed',
        drive_folder_id: folder.getId(),
        drive_folder_url: folder.getUrl(),
        gps_maps_link: mapsLink
      });
      parentById[id].driveFolderId = folder.getId();
      parentById[id].status = 'Filed';
    } catch (e) {
      writeRow(subSheet, subCol, i + 1, {
        status: 'Error',
        script_notes: String(e).slice(0, 500)
      });
      parentById[id].status = 'Error';
    }
  }

  // Phase 2 — process photos (move + sequential rename)
  const photoData = photoSheet.getDataRange().getValues();
  const photoCol = buildColumnMap(photoData[0]);

  const filedCountByParent = {};
  const pendingByParent = {};
  for (let i = 1; i < photoData.length; i++) {
    const row = photoData[i];
    const pid = row[photoCol.site_visit_id];
    if (!pid) continue;
    if (row[photoCol.status] === 'Filed') {
      filedCountByParent[pid] = (filedCountByParent[pid] || 0) + 1;
    } else if (!row[photoCol.status]) {
      if (!pendingByParent[pid]) pendingByParent[pid] = [];
      pendingByParent[pid].push({
        rowNum: i + 1,
        photoCell: row[photoCol.photo],
        capturedAt: row[photoCol.captured_at]
      });
    }
  }

  Object.keys(pendingByParent).forEach(pid => {
    const parent = parentById[pid];
    if (!parent || parent.status !== 'Filed' || !parent.driveFolderId) return;

    const folder = DriveApp.getFolderById(parent.driveFolderId);
    const photos = pendingByParent[pid].sort((a, b) => {
      const ta = a.capturedAt instanceof Date ? a.capturedAt.getTime() : 0;
      const tb = b.capturedAt instanceof Date ? b.capturedAt.getTime() : 0;
      return ta - tb;
    });
    let seq = filedCountByParent[pid] || 0;

    photos.forEach(p => {
      try {
        const file = resolvePhotoFile(p.photoCell);
        if (!file) {
          writeRow(photoSheet, photoCol, p.rowNum, { status: 'Error' });
          return;
        }
        seq++;
        const ext = (file.getName().split('.').pop() || 'jpg').toLowerCase();
        const newName = `${String(seq).padStart(3, '0')}.${ext}`;
        file.setName(newName);
        file.moveTo(folder);
        writeRow(photoSheet, photoCol, p.rowNum, {
          status: 'Filed',
          final_drive_link: file.getUrl()
        });
      } catch (e) {
        writeRow(photoSheet, photoCol, p.rowNum, { status: 'Error' });
      }
    });
  });

  // Phase 3 — update photo_count on each Filed parent
  const photoData2 = photoSheet.getDataRange().getValues();
  const finalCount = {};
  for (let i = 1; i < photoData2.length; i++) {
    const r = photoData2[i];
    if (r[photoCol.status] === 'Filed') {
      const pid = r[photoCol.site_visit_id];
      finalCount[pid] = (finalCount[pid] || 0) + 1;
    }
  }
  Object.keys(parentById).forEach(pid => {
    const parent = parentById[pid];
    if (parent.status === 'Filed') {
      writeRow(subSheet, subCol, parent.rowNum, { photo_count: finalCount[pid] || 0 });
    }
  });
}

function sanitizeFolderName(name) {
  return String(name || '').replace(/[\/\\:*?"<>|]/g, '').trim() || 'Untitled';
}

function formatLeafFolderName(createdAt) {
  const d = createdAt instanceof Date ? createdAt : new Date();
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm');
}

function getOrCreateProjectFolder(projectTitle, leaf) {
  const root = DriveApp.getFolderById(CONFIG.SITE_VISITS_ROOT_FOLDER_ID);
  return getOrCreateChild(getOrCreateChild(root, projectTitle), leaf);
}

function getOrCreateChild(parent, name) {
  const existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}

function resolvePhotoFile(cellValue) {
  if (!cellValue) return null;
  const filename = String(cellValue).split('/').pop();
  const matches = DriveApp.getFilesByName(filename);
  return matches.hasNext() ? matches.next() : null;
}

function buildColumnMap(headers) {
  const map = {};
  headers.forEach((header, idx) => {
    if (!header) return;
    const key = String(header).trim().toLowerCase()
      .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (key && !(key in map)) map[key] = idx;
  });
  return map;
}

function writeRow(sheet, colMap, rowNum, updates) {
  Object.entries(updates).forEach(([key, value]) => {
    const colIdx = colMap[key];
    if (colIdx !== undefined) sheet.getRange(rowNum, colIdx + 1).setValue(value);
  });
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processSiteVisits').timeBased().everyMinutes(5).create();
}
