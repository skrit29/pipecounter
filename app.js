// app.js — PipeCounter web app
import { loadModel, detectPipes, setThreshold } from './detector.js';
import { applyRelativeSizes, buildSizeBreakdown } from './pipeBreakdown.js';

const MODEL_URL   = './assets/models/pipe-counter-int8.onnx';
const SIZE_COLORS = { small: '#FF7A00', medium: '#FFD60A', large: '#39FF14' };

// ── DOM refs ─────────────────────────────────────────────────────────
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
const confSlider    = document.getElementById('conf-slider');
const confVal       = document.getElementById('conf-val');

// ── App state ─────────────────────────────────────────────────────────
let sourceImg   = null;
let scanImg     = null;
let activePipes = [];
let editMode    = 'remove';
let editSize    = 'any';       // 'small' | 'any' | 'large'
let cancelToken = { cancelled: false };
let wakeLock    = null;

// Crop state
let crop = { x1: 0, y1: 0, x2: 1, y2: 1 };
let cropDrag = null, cropDragStart = null;

// Zoom / pan state (for edit overlay)
let zoom = { scale: 1, tx: 0, ty: 0 };
let pinch = { active: false, startDist: 0, startScale: 1,
              midX: 0, midY: 0, startTx: 0, startTy: 0 };
let pan   = { active: false, startX: 0, startY: 0, startTx: 0, startTy: 0 };

// Track touch start position for tap vs scroll disambiguation
let overlayTouchStart = null;

// ── Service Worker ────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── Confidence slider ─────────────────────────────────────────────────
const CONF_LABELS = [
  [5,  'Very High'],
  [15, 'High'],
  [25, 'Medium'],
  [35, 'Low'],
  [50, 'Very Low'],
];
function updateConfLabel(v) {
  let label = 'Medium';
  for (const [threshold, name] of CONF_LABELS) {
    if (v <= threshold) { label = name; break; }
    label = name;
  }
  confVal.textContent = label;
  // threshold = (100 - v) / 100 — high slider value → low threshold (more detections)
  setThreshold((100 - v) / 100);
}
confSlider.addEventListener('input', () => updateConfLabel(+confSlider.value));
updateConfLabel(+confSlider.value);   // apply initial value

// ── Load model ────────────────────────────────────────────────────────
setStatus('Loading AI model…');
loadModel(MODEL_URL, pct => {
  setStatus(pct < 100 ? `Loading AI model… ${pct}%` : '');
}).then(() => {
  setStatus('Ready — tap Pick Image to start');
}).catch(() => {
  setStatus('Model failed to load. Check connection and reload.', true);
});

// ── State machine ─────────────────────────────────────────────────────
function setState(s) {
  ['idle','crop','scan','edit'].forEach(n => {
    document.getElementById('sec-' + n).hidden = (n !== s);
  });
  imageWrap.hidden = (s === 'idle');
  if (s !== 'edit') resetZoom();
}
setState('idle');

// ══════════════════════════════════════════════════════════════════════
//  PICK IMAGE
// ══════════════════════════════════════════════════════════════════════

document.getElementById('pick-btn').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  // Clear previous results immediately
  activePipes = [];
  clearOverlayCanvas();
  cropOverlayEl.hidden  = true;
  preview.onload        = null;
  imageWrap.hidden      = false;

  const url = URL.createObjectURL(file);

  preview.onload = () => {
    preview.onload = null;          // prevent re-trigger when crop replaces src
    preview.hidden = false;         // must be visible for getBoundingClientRect
    sourceImg = preview;
    setState('crop');
    waitForLayout(initCrop);
  };
  preview.src = url;
  preview.hidden = true;            // hide old image while new one loads
});

function waitForLayout(cb, tries = 0) {
  if (tries > 30) { cb(); return; }
  const rect = preview.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) { cb(); }
  else { requestAnimationFrame(() => waitForLayout(cb, tries + 1)); }
}

// ══════════════════════════════════════════════════════════════════════
//  CROP TOOL
// ══════════════════════════════════════════════════════════════════════

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

  // Dim outside
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, py1);
  ctx.fillRect(0, py2, w, h - py2);
  ctx.fillRect(0, py1, px1, py2 - py1);
  ctx.fillRect(px2, py1, w - px2, py2 - py1);

  // Border
  ctx.strokeStyle = '#39FF14';
  ctx.lineWidth = 2;
  ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);

  // Rule-of-thirds grid
  const cw = px2 - px1, ch = py2 - py1;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const t of [1/3, 2/3]) {
    ctx.moveTo(px1 + cw*t, py1); ctx.lineTo(px1 + cw*t, py2);
    ctx.moveTo(px1, py1 + ch*t); ctx.lineTo(px2, py1 + ch*t);
  }
  ctx.stroke();

  // Corner handles
  [[px1, py1], [px2, py1], [px1, py2], [px2, py2]].forEach(([hx, hy]) => {
    ctx.beginPath();
    ctx.arc(hx, hy, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#39FF14';
    ctx.fill();
  });
}

function cropEventPos(e) {
  const r = cropOverlayEl.getBoundingClientRect();
  const t = e.touches?.[0] ?? e;
  return {
    x: Math.max(0, Math.min(1, (t.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (t.clientY - r.top)  / r.height)),
  };
}

function getCropHandle(x, y) {
  const { x1, y1, x2, y2 } = crop, T = 0.07;
  if (Math.hypot(x-x1, y-y1) < T) return 'tl';
  if (Math.hypot(x-x2, y-y1) < T) return 'tr';
  if (Math.hypot(x-x1, y-y2) < T) return 'bl';
  if (Math.hypot(x-x2, y-y2) < T) return 'br';
  if (x > x1 && x < x2 && y > y1 && y < y2) return 'body';
  return 'new';
}

function onCropStart(e) {
  e.preventDefault();
  const p = cropEventPos(e);
  cropDrag      = getCropHandle(p.x, p.y);
  cropDragStart = { p, crop: { ...crop } };
}
function onCropMove(e) {
  e.preventDefault();
  if (!cropDrag) return;
  const p  = cropEventPos(e);
  const dx = p.x - cropDragStart.p.x;
  const dy = p.y - cropDragStart.p.y;
  const r  = cropDragStart.crop;
  const S  = 0.05;
  if      (cropDrag === 'tl')   { crop.x1=clamp01(r.x1+dx,0,r.x2-S); crop.y1=clamp01(r.y1+dy,0,r.y2-S); }
  else if (cropDrag === 'tr')   { crop.x2=clamp01(r.x2+dx,r.x1+S,1); crop.y1=clamp01(r.y1+dy,0,r.y2-S); }
  else if (cropDrag === 'bl')   { crop.x1=clamp01(r.x1+dx,0,r.x2-S); crop.y2=clamp01(r.y2+dy,r.y1+S,1); }
  else if (cropDrag === 'br')   { crop.x2=clamp01(r.x2+dx,r.x1+S,1); crop.y2=clamp01(r.y2+dy,r.y1+S,1); }
  else if (cropDrag === 'body') {
    const bw = r.x2-r.x1, bh = r.y2-r.y1;
    crop.x1 = clamp01(r.x1+dx, 0, 1-bw); crop.x2 = crop.x1+bw;
    crop.y1 = clamp01(r.y1+dy, 0, 1-bh); crop.y2 = crop.y1+bh;
  } else {
    const sx = cropDragStart.p.x, sy = cropDragStart.p.y;
    crop.x1 = Math.min(sx, p.x); crop.x2 = Math.max(sx, p.x);
    crop.y1 = Math.min(sy, p.y); crop.y2 = Math.max(sy, p.y);
  }
  drawCrop();
}
function onCropEnd() { cropDrag = null; }

cropOverlayEl.addEventListener('mousedown',  onCropStart);
cropOverlayEl.addEventListener('mousemove',  onCropMove);
cropOverlayEl.addEventListener('mouseup',    onCropEnd);
cropOverlayEl.addEventListener('touchstart', onCropStart, { passive: false });
cropOverlayEl.addEventListener('touchmove',  onCropMove,  { passive: false });
cropOverlayEl.addEventListener('touchend',   onCropEnd);

document.getElementById('skip-crop-btn').addEventListener('click', () => {
  cropOverlayEl.hidden = true;
  startScan(sourceImg);
});

document.getElementById('apply-crop-btn').addEventListener('click', () => {
  const { x1, y1, x2, y2 } = crop;
  const sw = sourceImg.naturalWidth, sh = sourceImg.naturalHeight;
  const cx = Math.round(x1*sw), cy = Math.round(y1*sh);
  const cw = Math.round((x2-x1)*sw), ch = Math.round((y2-y1)*sh);
  if (cw < 32 || ch < 32) return;

  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  tmp.getContext('2d').drawImage(sourceImg, cx, cy, cw, ch, 0, 0, cw, ch);

  tmp.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const croppedImg = new Image();
    croppedImg.onload = () => {
      preview.src = url;
      cropOverlayEl.hidden = true;
      startScan(croppedImg);
    };
    croppedImg.src = url;
  }, 'image/jpeg', 0.95);
});

// ══════════════════════════════════════════════════════════════════════
//  ZOOM / PAN (edit mode only)
// ══════════════════════════════════════════════════════════════════════

function applyZoom() {
  const { scale, tx, ty } = zoom;
  // Clamp translation so the image stays on screen
  const rect   = imageWrap.getBoundingClientRect();
  const maxTx  = rect.width  * (scale - 1);
  const maxTy  = rect.height * (scale - 1);
  zoom.tx = Math.max(-maxTx, Math.min(0, tx));
  zoom.ty = Math.max(-maxTy, Math.min(0, ty));
  imageWrap.style.transformOrigin = '0 0';
  imageWrap.style.transform = `scale(${zoom.scale}) translate(${zoom.tx / zoom.scale}px, ${zoom.ty / zoom.scale}px)`;
}

function resetZoom() {
  zoom = { scale: 1, tx: 0, ty: 0 };
  imageWrap.style.transform = '';
}

// Pinch and pan on the overlay canvas (edit mode)
overlayCanvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    // Single finger: remember start for tap detection, or begin pan if zoomed
    const t = e.touches[0];
    overlayTouchStart = { x: t.clientX, y: t.clientY };
    if (zoom.scale > 1) {
      pan.active = true;
      pan.startX  = t.clientX;
      pan.startY  = t.clientY;
      pan.startTx = zoom.tx;
      pan.startTy = zoom.ty;
    }
  } else if (e.touches.length === 2) {
    overlayTouchStart = null;   // not a tap
    pan.active = false;
    pinch.active = true;
    const t1 = e.touches[0], t2 = e.touches[1];
    pinch.startDist  = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    pinch.startScale = zoom.scale;
    pinch.midX  = (t1.clientX + t2.clientX) / 2;
    pinch.midY  = (t1.clientY + t2.clientY) / 2;
    pinch.startTx = zoom.tx;
    pinch.startTy = zoom.ty;
    e.preventDefault();
  }
}, { passive: false });

overlayCanvas.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && pinch.active) {
    e.preventDefault();
    const t1 = e.touches[0], t2 = e.touches[1];
    const dist     = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const newScale = Math.min(5, Math.max(1, pinch.startScale * dist / pinch.startDist));
    // Zoom around the pinch midpoint
    const rect   = imageWrap.getBoundingClientRect();
    const originX = pinch.midX - rect.left;
    const originY = pinch.midY - rect.top;
    zoom.tx = originX - (originX - pinch.startTx) * (newScale / pinch.startScale);
    zoom.ty = originY - (originY - pinch.startTy) * (newScale / pinch.startScale);
    zoom.scale = newScale;
    applyZoom();
  } else if (e.touches.length === 1 && pan.active) {
    e.preventDefault();
    const t = e.touches[0];
    zoom.tx = pan.startTx + (t.clientX - pan.startX);
    zoom.ty = pan.startTy + (t.clientY - pan.startY);
    applyZoom();
  }
}, { passive: false });

overlayCanvas.addEventListener('touchend', e => {
  if (pinch.active && e.touches.length < 2) {
    pinch.active = false;
    // If we zoomed out to 1x, reset cleanly
    if (zoom.scale <= 1.02) resetZoom();
  }
  pan.active = false;

  // Determine if this was a tap (single touch, minimal movement)
  if (e.touches.length === 0 && overlayTouchStart && e.changedTouches.length === 1) {
    const t     = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - overlayTouchStart.x, t.clientY - overlayTouchStart.y);
    overlayTouchStart = null;
    if (moved <= 12) {
      // It was a tap — handle add/remove
      e.preventDefault();
      handleOverlayTap(t.clientX, t.clientY);
      return;
    }
  }
  overlayTouchStart = null;
}, { passive: false });

// Mouse click on overlay (desktop)
overlayCanvas.addEventListener('click', e => handleOverlayTap(e.clientX, e.clientY));

// ══════════════════════════════════════════════════════════════════════
//  SCAN
// ══════════════════════════════════════════════════════════════════════

async function startScan(img) {
  scanImg     = img;
  cancelToken = { cancelled: false };
  setState('scan');
  setProgress(0, 'Starting…');

  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}

  try {
    const mode = modeHigh.checked ? 'high' : 'standard';
    const raw  = await detectPipes(img, mode, pct => setProgress(pct, `Scanning… ${pct}%`), cancelToken);
    activePipes = applyRelativeSizes(raw);
    renderOverlay();
    renderBreakdown();
    setState('edit');
    setStatus('');
  } catch (err) {
    const cancelled = err.message === 'cancelled';
    setStatus(cancelled ? 'Cancelled.' : 'Scan failed: ' + err.message, !cancelled);
    setState('idle');
  } finally {
    try { await wakeLock?.release(); } catch (_) {}
    wakeLock = null;
  }
}

document.getElementById('cancel-btn').addEventListener('click', () => { cancelToken.cancelled = true; });
function setProgress(pct, label) { progressBar.style.width = pct + '%'; progressLbl.textContent = label; }

// ══════════════════════════════════════════════════════════════════════
//  RESULTS + EDIT
// ══════════════════════════════════════════════════════════════════════

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

    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(1.5, pr * 0.07);
    ctx.stroke();

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

// ── Edit mode toggle ───────────────────────────────────────────────────
document.getElementById('btn-remove').addEventListener('click', () => setEditMode('remove'));
document.getElementById('btn-add').addEventListener('click',    () => setEditMode('add'));

function setEditMode(m) {
  editMode = m;
  document.getElementById('btn-remove').classList.toggle('active', m === 'remove');
  document.getElementById('btn-add').classList.toggle('active',    m === 'add');
  updateEditHint();
}

// ── Size filter toggle ─────────────────────────────────────────────────
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editSize = btn.dataset.size;
    updateEditHint();
  });
});

function updateEditHint() {
  const sizeLabel = editSize === 'any' ? 'any size' : `${editSize} pipes`;
  editHint.textContent = editMode === 'remove'
    ? `Tap a circle to remove it (${sizeLabel}).  Pinch to zoom · drag to pan.`
    : `Tap to add a ${editSize === 'any' ? 'medium' : editSize} pipe.  Pinch to zoom · drag to pan.`;
}

// ── Tap handler ────────────────────────────────────────────────────────
function handleOverlayTap(clientX, clientY) {
  // clientX/clientY are screen coords. Adjust for zoom/pan via the canvas's
  // actual rendered bounds (getBoundingClientRect includes CSS transform).
  const rect   = overlayCanvas.getBoundingClientRect();
  const tapX   = ((clientX - rect.left) / rect.width)  * 100;
  const tapY   = ((clientY - rect.top)  / rect.height) * 100;
  const aspect = overlayCanvas.height / overlayCanvas.width;

  if (editMode === 'remove') {
    let best = -1, bestDist = Infinity;
    activePipes.forEach((pipe, i) => {
      // Apply size filter
      if (editSize !== 'any' && pipe.sizeCategory !== editSize) return;
      const dist = Math.hypot(pipe.x - tapX, (pipe.y - tapY) / aspect);
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best >= 0 && bestDist < activePipes[best].radius * 3) {
      activePipes.splice(best, 1);
      activePipes = applyRelativeSizes(activePipes);
      renderOverlay();
      renderBreakdown();
    }
  } else {
    // Add a new pipe at the tapped location
    const sizeToAdd = editSize === 'any' ? 'medium' : editSize;
    // Find a radius matching the requested size category
    const sameSize  = activePipes.filter(p => p.sizeCategory === sizeToAdd);
    const sorted    = [...activePipes].sort((a, b) => a.radius - b.radius);
    const medR      = sorted.length ? sorted[Math.floor(sorted.length / 2)].radius : 2;
    const useR      = sameSize.length
      ? sameSize.reduce((s, p) => s + p.radius, 0) / sameSize.length
      : medR;
    activePipes.push({ x: tapX, y: tapY, radius: useR, confidence: 100, sizeCategory: sizeToAdd });
    activePipes = applyRelativeSizes(activePipes);
    renderOverlay();
    renderBreakdown();
  }
}

function clearOverlayCanvas() {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCanvas.hidden = true;
}

// ══════════════════════════════════════════════════════════════════════
//  SHARE
// ══════════════════════════════════════════════════════════════════════

document.getElementById('share-btn').addEventListener('click', async () => {
  const w = scanImg.naturalWidth  || scanImg.width;
  const h = scanImg.naturalHeight || scanImg.height;
  const sc  = document.createElement('canvas');
  sc.width  = w; sc.height = h;
  const ctx = sc.getContext('2d');
  ctx.drawImage(scanImg, 0, 0, w, h);

  activePipes.forEach((pipe, i) => {
    const px  = (pipe.x / 100) * w;
    const py  = (pipe.y / 100) * h;
    const pr  = Math.max(6, (pipe.radius / 100) * w);
    const col = SIZE_COLORS[pipe.sizeCategory] ?? SIZE_COLORS.medium;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(2, pr * 0.07);
    ctx.stroke();
    const fs = Math.max(10, Math.round(pr * 0.75));
    ctx.font         = `bold ${fs}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = col;
    ctx.fillText(String(i + 1), px, py);
  });

  // Count badge top-left
  const label = `${activePipes.length} pipe ends`;
  const fs    = Math.max(20, Math.round(w * 0.045));
  ctx.font    = `bold ${fs}px sans-serif`;
  const tw    = ctx.measureText(label).width;
  const pad   = 12, bh = fs * 1.6;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(pad, pad, tw + pad * 2, bh);
  ctx.fillStyle = '#39FF14';
  ctx.fillText(label, pad * 2, pad + bh * 0.72);

  sc.toBlob(async blob => {
    const name = `pipes-${activePipes.length}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: label });
      } else {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('Share failed: ' + err.message, true);
    }
  }, 'image/jpeg', 0.92);
});

// ══════════════════════════════════════════════════════════════════════
//  NEW SCAN
// ══════════════════════════════════════════════════════════════════════

document.getElementById('new-scan-btn').addEventListener('click', () => {
  cancelToken.cancelled = true;
  activePipes   = [];
  sourceImg     = null;
  scanImg       = null;
  fileInput.value   = '';
  preview.onload    = null;
  preview.src       = '';
  preview.hidden    = true;
  clearOverlayCanvas();
  cropOverlayEl.hidden = true;
  setStatus('Ready — tap Pick Image to start');
  setState('idle');
});

// ── Helpers ────────────────────────────────────────────────────────────
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className   = 'status' + (isError ? ' error' : '');
}
function clamp01(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
