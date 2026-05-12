// Shared UI helpers: toasts, format functions, simple HTML escaping.
window.UI = (function () {
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtTimestampForFilename(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_` +
      `${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
  }

  function fmtDateTime(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtBytes(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  }

  function toast(message, kind = 'info', ms = 3500) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  // Trigger the device "save" sheet from a Blob. On iOS Safari this opens
  // the native share sheet (Save to Photos / Save to Files); on Chrome it
  // streams into the Downloads folder. Filename is honored by both.
  function downloadBlob(blob, filename) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (e) { /* ignore */ }
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }, 1000);
  }

  // Fixed banner pinned to the top of the viewport announcing a new
  // service-worker version. Tap → reload. Dismiss → hides until next
  // update cycle. Idempotent — calling twice doesn't stack banners.
  function showUpdateBanner(message) {
    if (document.getElementById('sw-update-banner')) return;
    const el = document.createElement('div');
    el.id = 'sw-update-banner';
    el.className = 'sw-update-banner';
    el.innerHTML = `
      <span class="sw-update-text">${message || 'App updated — tap to refresh'}</span>
      <button class="sw-update-refresh" type="button">Refresh</button>
      <button class="sw-update-dismiss" type="button" aria-label="Dismiss">✕</button>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    el.querySelector('.sw-update-refresh').addEventListener('click', () => {
      window.location.reload();
    });
    // Tapping anywhere on the banner (outside dismiss) also reloads.
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('sw-update-dismiss')) return;
      window.location.reload();
    });
    el.querySelector('.sw-update-dismiss').addEventListener('click', (ev) => {
      ev.stopPropagation();
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    });
  }

  return { escapeHtml, fmtTimestampForFilename, fmtDateTime, fmtBytes, fmtRelative, toast, downloadBlob, showUpdateBanner };
})();
