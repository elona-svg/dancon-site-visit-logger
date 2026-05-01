// Text-note modal: large textarea, append-on-save to notes.txt in the project folder.
window.Notes = (function () {
  let onSaveCb = null;
  let onCloseCb = null;

  function root() { return document.getElementById('overlay-root'); }

  function open({ onSave, onClose }) {
    onSaveCb = onSave;
    onCloseCb = onClose;

    root().innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-sheet">
          <div class="modal-header">
            <h3>Text note</h3>
            <button class="modal-x" id="notes-x" aria-label="Close">✕</button>
          </div>
          <textarea
            id="notes-textarea"
            placeholder="Type a note — saved into notes.txt in the project folder."
            autofocus
          ></textarea>
          <div class="modal-actions">
            <button class="btn-primary" id="notes-save">Save note</button>
          </div>
        </div>
      </div>
    `;

    setTimeout(() => document.getElementById('notes-textarea')?.focus(), 50);
    document.getElementById('notes-x').addEventListener('click', close);
    document.getElementById('notes-save').addEventListener('click', save);
  }

  async function save() {
    const text = document.getElementById('notes-textarea').value.trim();
    if (!text) {
      close();
      return;
    }
    if (onSaveCb) {
      try { await onSaveCb(text); } catch (err) {
        window.UI.toast(`Note save failed: ${err.message}`, 'error');
        return;
      }
    }
    close();
  }

  function close() {
    root().innerHTML = '';
    const cb = onCloseCb;
    onSaveCb = null;
    onCloseCb = null;
    if (cb) cb();
  }

  return { open };
})();
