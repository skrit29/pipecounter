// app.js — PipeCounter web app
import { loadModel, detectPipes } from './detector.js';
import { applyRelativeSizes, buildSizeBreakdown } from './pipeBreakdown.js';

const MODEL_URL  = './assets/models/pipe-counter-int8.onnx';
const SIZE_COLORS = { small: '#FF7A00', medium: '#FFD60A', large: '#39FF14' };

// ── DOM refs ──────────────────────────────────────────────────────
const fileInput     = document.getElementById('file-input');
const preview       = document.getElementById('preview');
const cropOverlayEl = document.getElementById('crop-overlay');
const overlayCanvas = document.getElementById('overlay');
const statusEl      = document.getElementById('status');
const imageWrap     = document.getElementById('image-wrap');
const progressBar   = document.getElementById('progress-bar');
const progressLbl   = document.getElementById('progress-lbl');
const countLbl      = document.getElementById('count-lbl');
const breakdownEl   = document.getElementById('breakdown');
const editHint      = document.getElementById('edit-hint');
const modeHigh      = document.getElementById('mode-high');

// ── App state ──────────────────────────────────────────────────────
let modelReady  = false;
let sourceImg   = null;  // original picked image
let scanImg     = null;  // image passed to detectPipes (may be cropped)
let activePipes = [];    // current detected pipes (editable)
let editMode    = 'remove';
let cancelToken = { cancelled: false };
let wakeLock    = null;

// ── Crop state ────────────────────────────────────────────────────
let crop = { x1: 0, y1: 0, x2: 1, y2: 1 };
let cropDrag = null, cropDragStart = null;

// ── Service Worker ─────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── Load model immediately ─────────────────────────────────────────
setStatus('Loading AI model…');
loadModel(MODEL_URL, pct => {
  setStatus(pct < 100 ? `Loading AI model… ${pct}%` : '');
}).then(() => {
  modelReady = true;
  setStatus('Ready — tap Pick Image to start');
}).catch(() => {
  setStatus('Model failed to load. Check your connection and reload.', true);
});

// ── State visibility ──────────────────────────────────────────────
function setState(s) {
  ['idle','crop','scan','edit'].forEach(name => {
    document.getElementById('sec-' + name).hidden = (name !== s);
  });
  imageWrap.hidden = (s === 'idle');
}
setState('idle');

// ── Pick image ────────────────────────────────────────────────────
document.getElementById('pick-btn').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImg = img;
    preview.src = url;
    preview.hidden = false;
    overlayCanvas.hidden = true;

    // Small delay so the image has laid out before we read its size
    requestAnimationFrame(() => requestAnimationFrame(initCrop));
    setState('crop');
  };
  img.src = url;
});

// ══════════════════════════════════════════════════════════════════
//  CROP TOOL
// ══════════════════════════════════════════════════════════════════

function initCrop() {
  crop = { x1: 0, y1: 0, x2: 1, y2: 1 };
  const rect = preview.getBoundingClientRect();
  cropOverlayEl.width  = rect.width;
  cropOverlayEl.height = rect.height;
  cropOverlayEl.hidden = false;
  drawCrop();
}

function drawCrop() {
  const c = cropOverlayEl, ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  const { x1, y1, x2, y2 } = crop;
  const [px1, py1, px2, py2] = [x1*w, y1*h, x2*w, y2*h];

  ctx.clearRect(0, 0, w, h);

  // Dim outside crop
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0,   0,   w,   py1);
  ctx.fillRect(0,   py2, w,   h - py2);
  ctx.fillRect(0,   py1, px1, py2 - py1);
  ctx.fillRect(px2, py1, w-px2, py2 - py1);

  // Crop border
  ctx.strokeStyle = '#39FF14';
  ctx.lineWidth = 2;
  ctx.strokeRect(px1, py1, px2-px1, py2-py1);

  // Rule-of-thirds grid
  const cw = px2-px1, ch = py2-py1;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const t of [1/3, 2/3]) {
    ctx.moveTo(px1 + cw*t, py1); ctx.lineTo(px1 + cw*t, py2);
    ctx.moveTo(px1, py1 + ch*t); ctx.lineTo(px2, py1 + ch*t);
  }
  ctx.stroke();

  // Corner handles
  [[px1,py1],[px2,py1],[px1,py2],[px2,py2]].forEach(([hx,hy]) => {
    ctx.beginPath();
    ctx.arc(hx, hy, 14, 0, Math.PI*2);
    ctx.fillStyle = '#39FF14';
    ctx.fill();
  });
}

function cropPos(e) {
  const r = cropOverlayEl.getBoundingClientRect();
  const t = e.touches?.[0] ?? e;
  return {
    x: Math.max(0, Math.min(1, (t.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (t.clientY - r.top)  / r.height)),
  };
}

function cropHandle(x, y) {
  const { x1, y1, x2, y2 } = crop, T = 0.07;
  if (Math.hypot(x-x1, y-y1) < T) return 'tl';
  if (Math.hypot(x-x2, y-y1) < T) return 'tr';
  if (Math.hypot(x-x1, y-y2) < T) return 'bl';
  if (Math.hypot(x-x2, y-y2) < T) return 'br';
  if (x > x1 && x < x2 && y > y1 && y < y2) return 'body';
  return 'new';
}

cropOverlayEl.addEventListener('mousedown',  startCropDrag);
cropOverlayEl.addEventListener('mousemove',  moveCropDrag);
cropOverlayEl.addEventListener('mouseup',    endCropDrag);
cropOverlayEl.addEventListener('touchstart', startCropDrag, { passive: false });
cropOverlayEl.addEventListener('touchmove',  moveCropDrag,  { passive: false });
cropOverlayEl.addEventListener('touchend',   endCropDrag);

function startCropDrag(e) {
  e.preventDefault();
  const p = cropPos(e);
  cropDrag = cropHandle(p.x, p.y);
  cropDragStart = { p, crop: { ...crop } };
}

function moveCropDrag(e) {
  e.preventDefault();
  if (!cropDrag) return;
  const p  = cropPos(e);
  const dx = p.x - cropDragStart.p.x;
  const dy = p.y - cropDragStart.p.y;
  const r  = cropDragStart.crop;
  const S  = 0.05; // min crop size

  if      (cropDrag === 'tl')   { crop.x1 = clamp01(r.x1+dx, 0, r.x2-S); crop.y1 = clamp01(r.y1+dy, 0, r.y2-S); }
  else if (cropDrag === 'tr')   { crop.x2 = clamp01(r.x2+dx, r.x1+S, 1); crop.y1 = clamp01(r.y1+dy, 0, r.y2-S); }
  else if (cropDrag === 'bl')   { crop.x1 = clamp01(r.x1+dx, 0, r.x2-S); crop.y2 = clamp01(r.y2+dy, r.y1+S, 1); }
  else if (cropDrag === 'br')   { crop.x2 = clamp01(r.x2+dx, r.x1+S, 1); crop.y2 = clamp01(r.y2+dy, r.y1+S, 1); }
  else if (cropDrag === 'body') {
    const w = r.x2-r.x1, h = r.y2-r.y1;
    crop.x1 = clamp01(r.x1+dx, 0, 1-w); crop.x2 = crop.x1+w;
    crop.y1 = clamp01(r.y1+dy, 0, 1-h); crop.y2 = crop.y1+h;
  } else { // 'new'
    const sx = cropDragStart.p.x, sy = cropDragStart.p.y;
    crop.x1 = Math.min(sx, p.x); crop.x2 = Math.max(sx, p.x);
    crop.y1 = Math.min(sy, p.y); crop.y2 = Math.max(sy, p.y);
  }
  drawCrop();
}

function endCropDrag() { cropDrag = null; }

document.getElementById('skip-crop-btn').addEventListener('click', () => {
  cropOverlayEl.hidden = true;
  startScan(sourceImg);
});

document.getElementById('apply-crop-btn').addEventListener('click', () => {
  const { x1, y1, x2, y2 } = crop;
  const sw = sourceImg.naturalWidth, sh = sourceImg.naturalHeight;
  const cx = Math.round(x1*sw), cy = Math.round(y1*sh);
  const cw = Math.round((x2-x1)*sw), ch = Math.round((y2-y1)*sh);

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = cw; tmpCanvas.height = ch;
  tmpCanvas.getContext('2d').drawImage(sourceImg, cx, cy, cw, ch, 0, 0, cw, ch);

  tmpCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const cropped = new Image();
    cropped.onload = () => {
      preview.src = url;   // update preview to show cropped image
      cropOverlayEl.hidden = true;
      startScan(cropped);
    };
    cropped.src = url;
  }, 'image/jpeg', 0.95);
});

// ══════════════════════════════════════════════════════════════════
//  SCAN
// ══════════════════════════════════════════════════════════════════

async function startScan(img) {
  scanImg     = img;
  cancelToken = { cancelled: false };
  setState('scan');
  setProgress(0, 'Starting…');

  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}

  try {
    const mode     = modeHigh.checked ? 'high' : 'standard';
    const rawPipes = await detectPipes(img, mode, pct => setProgress(pct, `Scanning… ${pct}%`), cancelToken);
    activePipes    = applyRelativeSizes(rawPipes);
    renderOverlay();
    renderBreakdown();
    setState('edit');
    setStatus('');
  } catch (err) {
    const cancelled = err.message === 'cancelled';
    setStatus(cancelled ? 'Cancelled.' : 'Scan failed: ' + err.message, !cancelled);
    setState(cancelled ? 'idle' : 'idle');
  } finally {
    try { await wakeLock?.release(); } catch (_) {}
    wakeLock = null;
  }
}

document.getElementById('cancel-btn').addEventListener('click', () => {
  cancelToken.cancelled = true;
});

function setProgress(pct, label) {
  progressBar.style.width    = pct + '%';
  progressLbl.textContent    = label;
}

// ══════════════════════════════════════════════════════════════════
//  RESULTS + EDIT
// ══════════════════════════════════════════════════════════════════

function renderOverlay() {
  const rect = preview.getBoundingClientRect();
  overlayCanvas.width  = rect.width;
  overlayCanvas.height = rect.height;
  overlayCanvas.hidden = false;

  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  activePipes.forEach((pipe, i) => {
    const px  = (pipe.x / 100) * overlayCanvas.width;
    const py  = (pipe.y / 100) * overlayCanvas.height;
    const pr  = Math.max(4, (pipe.radius / 100) * overlayCanvas.width);
    const col = SIZE_COLORS[pipe.sizeCategory] ?? SIZE_COLORS.medium;

    // Thin circle
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(1.5, pr * 0.07);
    ctx.stroke();

    // Number in centre
    const fs = Math.max(8, Math.round(pr * 0.75));
    ctx.font         = `bold ${fs}px -apple-system, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = col;
    ctx.fillText(String(i + 1), px, py);
  });

  countLbl.textContent = activePipes.length;
}

function renderBreakdown() {
  const bd = buildSizeBreakdown(activePipes);
  breakdownEl.innerHTML = bd
    .filter(b => b.count > 0)
    .map(b => `<div class="bd-row">
      <span class="bd-dot" style="background:${SIZE_COLORS[b.size]}"></span>
      <span class="bd-label">${cap(b.size)}</span>
      <span class="bd-count">${b.count}</span>
    </div>`).join('') || '<p style="color:var(--muted);font-size:.9rem">No pipes detected</p>';
}

// ── Edit mode toggle ───────────────────────────────────────────────
document.getElementById('btn-remove').addEventListener('click', () => setEditMode('remove'));
document.getElementById('btn-add').addEventListener('click',    () => setEditMode('add'));

function setEditMode(mode) {
  editMode = mode;
  document.getElementById('btn-remove').classList.toggle('active', mode === 'remove');
  document.getElementById('btn-add').classList.toggle('active',    mode === 'add');
  editHint.textContent = mode === 'remove'
    ? 'Tap a circle on the image to remove it.'
    : 'Tap anywhere on the image to add a pipe.';
}

// ── Canvas click for remove / add ─────────────────────────────────
function handleOverlayTap(clientX, clientY) {
  const rect = overlayCanvas.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width)  * 100;
  const py = ((clientY - rect.top)  / rect.height) * 100;
  // radius is stored as % of image WIDTH; correct for aspect when measuring distance
  const aspect = overlayCanvas.height / overlayCanvas.width;

  if (editMode === 'remove') {
    let best = -1, bestDist = Infinity;
    activePipes.forEach((pipe, i) => {
      const dist = Math.hypot(pipe.x - px, (pipe.y - py) / aspect);
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best >= 0 && bestDist < activePipes[best].radius * 2.5) {
      activePipes.splice(best, 1);
      activePipes = applyRelativeSizes(activePipes);
      renderOverlay();
      renderBreakdown();
    }
  } else {
    // median radius of existing pipes, or a sensible default
    const sorted  = [...activePipes].sort((a, b) => a.radius - b.radius);
    const medR    = sorted.length ? sorted[Math.floor(sorted.length / 2)].radius : 2;
    activePipes.push({ x: px, y: py, radius: medR, confidence: 100 });
    activePipes = applyRelativeSizes(activePipes);
    renderOverlay();
    renderBreakdown();
  }
}

overlayCanvas.addEventListener('click', e => handleOverlayTap(e.clientX, e.clientY));
overlayCanvas.addEventListener('touchend', e => {
  e.preventDefault();
  const t = e.changedTouches[0];
  handleOverlayTap(t.clientX, t.clientY);
}, { passive: false });

// ── Share ──────────────────────────────────────────────────────────
document.getElementById('share-btn').addEventListener('click', async () => {
  // Draw image + circles into a full-resolution canvas
  const w = scanImg.naturalWidth  || scanImg.width;
  const h = scanImg.naturalHeight || scanImg.height;
  const sc = document.createElement('canvas');
  sc.width = w; sc.height = h;
  const ctx = sc.getContext('2d');
  ctx.drawImage(scanImg, 0, 0, w, h);

  activePipes.forEach((pipe, i) => {
    const px  = (pipe.x / 100) * w;
    const py  = (pipe.y / 100) * h;
    const pr  = Math.max(6, (pipe.radius / 100) * w);
    const col = SIZE_COLORS[pipe.sizeCategory] ?? SIZE_COLORS.medium;

    // Thin circle
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(2, pr * 0.07);
    ctx.stroke();

    // Number in centre
    const fs = Math.max(10, Math.round(pr * 0.75));
    ctx.font         = `bold ${fs}px -apple-system, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = col;
    ctx.fillText(String(i + 1), px, py);
  });

  // Count badge top-left
  const fs = Math.max(20, Math.round(w * 0.045));
  ctx.font = `bold ${fs}px -apple-system, sans-serif`;
  const label = `${activePipes.length} pipe ends`;
  const tw    = ctx.measureText(label).width;
  const pad   = 12, bh = fs * 1.5;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(pad, pad, tw + pad*2, bh);
  ctx.fillStyle = '#39FF14';
  ctx.fillText(label, pad*2, pad + bh * 0.72);

  sc.toBlob(async blob => {
    const name = `pipes-${activePipes.length}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: label });
      } else {
        // Fallback: trigger download
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('Share failed: ' + err.message, true);
    }
  }, 'image/jpeg', 0.92);
});

// ── New scan ───────────────────────────────────────────────────────
document.getElementById('new-scan-btn').addEventListener('click', () => {
  cancelToken.cancelled = true;
  activePipes   = [];
  sourceImg     = null;
  scanImg       = null;
  fileInput.value = '';
  preview.src   = '';
  preview.hidden = true;
  overlayCanvas.hidden  = true;
  cropOverlayEl.hidden  = true;
  setStatus('Ready — tap Pick Image to start');
  setState('idle');
});

// ── Helpers ────────────────────────────────────────────────────────
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className   = 'status' + (isError ? ' error' : '');
}

function clamp01(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
