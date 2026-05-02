// Photo annotation overlay. Loads a Blob (or URL), lets the tech draw freehand,
// arrows, or circles, then saves a flattened JPEG back to the project folder.
window.Annotate = (function () {
  let imageBitmap = null;
  let cw = 0, ch = 0; // canvas pixel dims
  let displayW = 0, displayH = 0;
  let strokes = [];     // [{tool, color, width, points:[{x,y}], end?:{x,y}}]
  let drawing = false;
  let current = null;
  let tool = 'pen';
  let color = '#ef4444';
  let width = 6;
  let onSaveCb = null;
  let onCloseCb = null;

  const COLORS = ['#ef4444', '#fbbf24', '#10b981', '#3b82f6', '#000000', '#ffffff'];

  function root() { return document.getElementById('overlay-root'); }

  async function openWithBlob({ blob, onSave, onClose }) {
    onSaveCb = onSave;
    onCloseCb = onClose;
    strokes = [];

    try {
      imageBitmap = await createImageBitmap(blob);
    } catch (err) {
      window.UI.toast(`Could not load image: ${err.message}`, 'error');
      return;
    }
    cw = imageBitmap.width;
    ch = imageBitmap.height;
    render();
  }

  async function openWithUrl({ url, onSave, onClose }) {
    onSaveCb = onSave;
    onCloseCb = onClose;
    strokes = [];

    try {
      const res = await fetch(url, { credentials: 'omit' });
      const blob = await res.blob();
      imageBitmap = await createImageBitmap(blob);
    } catch (err) {
      window.UI.toast(`Could not load image: ${err.message}`, 'error');
      return;
    }
    cw = imageBitmap.width;
    ch = imageBitmap.height;
    render();
  }

  function render() {
    document.body.classList.add('camera-open');
    root().innerHTML = `
      <div class="annotate-overlay">
        <div class="annotate-top">
          <button class="cam-icon-btn" id="ann-close" aria-label="Close">✕</button>
          <div class="annotate-tools">
            ${['pen', 'arrow', 'circle'].map((t) => `
              <button class="tool-btn ${t === tool ? 'active' : ''}" data-tool="${t}">
                ${t === 'pen' ? '✎' : t === 'arrow' ? '→' : '○'}
              </button>
            `).join('')}
            <span class="tool-divider"></span>
            <button class="tool-btn" id="ann-undo" aria-label="Undo last stroke" title="Undo">↶</button>
            <button class="tool-btn" id="ann-clear" aria-label="Clear all" title="Clear all">⌫</button>
          </div>
          <button class="btn-primary" id="ann-save">Save</button>
        </div>

        <div class="annotate-canvas-wrap" id="ann-wrap">
          <canvas id="ann-canvas"></canvas>
        </div>

        <div class="annotate-bottom">
          <div class="color-row">
            ${COLORS.map((c) => `
              <button class="color-dot ${c === color ? 'active' : ''}" data-color="${c}" style="background:${c}"></button>
            `).join('')}
          </div>
          <div class="width-row">
            ${[3, 6, 12].map((w) => `
              <button class="width-btn ${w === width ? 'active' : ''}" data-width="${w}">
                <span style="width:${w}px;height:${w}px;background:${color};display:inline-block;border-radius:50%;"></span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    document.getElementById('ann-close').addEventListener('click', close);
    document.getElementById('ann-save').addEventListener('click', save);
    document.getElementById('ann-undo').addEventListener('click', undo);
    document.getElementById('ann-clear').addEventListener('click', clearAll);

    root().querySelectorAll('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => { tool = b.dataset.tool; render(); });
    });
    root().querySelectorAll('[data-color]').forEach((b) => {
      b.addEventListener('click', () => { color = b.dataset.color; render(); });
    });
    root().querySelectorAll('[data-width]').forEach((b) => {
      b.addEventListener('click', () => { width = parseInt(b.dataset.width, 10); render(); });
    });

    setupCanvas();
  }

  function setupCanvas() {
    const canvas = document.getElementById('ann-canvas');
    const wrap = document.getElementById('ann-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const ratio = cw / ch;
    if (wrapRect.width / wrapRect.height > ratio) {
      displayH = wrapRect.height;
      displayW = displayH * ratio;
    } else {
      displayW = wrapRect.width;
      displayH = displayW / ratio;
    }
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;
    canvas.width = cw;
    canvas.height = ch;
    redraw();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
  }

  function toCanvasCoords(ev) {
    const canvas = document.getElementById('ann-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (cw / rect.width);
    const y = (ev.clientY - rect.top) * (ch / rect.height);
    return { x, y };
  }

  function onPointerDown(ev) {
    ev.preventDefault();
    drawing = true;
    const p = toCanvasCoords(ev);
    current = { tool, color, width: width * (cw / displayW), points: [p] };
    if (tool !== 'pen') current.end = p;
    document.getElementById('ann-canvas').setPointerCapture(ev.pointerId);
  }
  function onPointerMove(ev) {
    if (!drawing || !current) return;
    const p = toCanvasCoords(ev);
    if (current.tool === 'pen') current.points.push(p);
    else current.end = p;
    redraw(current);
  }
  function onPointerUp(ev) {
    if (!drawing || !current) return;
    drawing = false;
    strokes.push(current);
    current = null;
    redraw();
  }

  function redraw(preview) {
    const canvas = document.getElementById('ann-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(imageBitmap, 0, 0, cw, ch);
    for (const s of strokes) drawStroke(ctx, s);
    if (preview) drawStroke(ctx, preview);
  }

  function drawStroke(ctx, s) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (s.tool === 'pen') {
      ctx.beginPath();
      s.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    } else if (s.tool === 'arrow' && s.end) {
      const a = s.points[0];
      const b = s.end;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(s.width * 3, 18);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (s.tool === 'circle' && s.end) {
      const a = s.points[0];
      const b = s.end;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2;
      const ry = Math.abs(b.y - a.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function undo() {
    strokes.pop();
    redraw();
  }

  function clearAll() {
    if (strokes.length === 0) return;
    if (!confirm('Clear all annotations? This cannot be undone.')) return;
    strokes = [];
    redraw();
  }

  async function save() {
    const canvas = document.getElementById('ann-canvas');
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    );
    if (!blob) {
      window.UI.toast('Could not encode annotated image', 'error');
      return;
    }
    if (onSaveCb) {
      try { await onSaveCb(blob); }
      catch (err) {
        window.UI.toast(`Annotation save failed: ${err.message}`, 'error');
        return;
      }
    }
    close();
  }

  function close() {
    root().innerHTML = '';
    document.body.classList.remove('camera-open');
    const cb = onCloseCb;
    onSaveCb = null;
    onCloseCb = null;
    imageBitmap = null;
    strokes = [];
    if (cb) cb();
  }

  return { openWithBlob, openWithUrl };
})();
