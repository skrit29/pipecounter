// app.js — PipeCounter web app
import { loadModel, detectPipes } from './detector.js';
import { applyRelativeSizes, buildSizeBreakdown } from './pipeBreakdown.js';

const MODEL_URL   = './assets/models/pipe-counter-int8.onnx';
const SIZE_COLORS = { small: '#FF7A00', medium: '#FFD60A', large: '#39FF14' };

// Sensitivity slider maps 0..100 → confidence cutoff (%).
// Left (0)  = Low  sensitivity = high cutoff = fewer, surer detections.
// Right(100)= High sensitivity = low  cutoff = more, noisier detections.
const CUT_MIN = 8;    // cutoff at slider 100
const CUT_MAX = 60;   // cutoff at slider 0
const sliderToCutoff = v => CUT_MIN + ((100 - v) / 100) * (CUT_MAX - CUT_MIN);

// ── DOM refs ─────────────────────────────────────────────────────────
const fileInput     = document.getElementById('file-input');
const preview       = document.getElementById('preview');
const zoomLayer     = document.getElementById('zoom-layer');
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
const sensSlider    = document.getElementById('sens-slider');
const sensReadout   = document.getElementById('sens-readout');
const removeOpts    = document.getElementById('remove-opts');
const addOpts       = document.getElementById('add-opts');
const addSizeInput  = document.getElementById('add-size');
const addSizeHint   = document.getElementById('add-size-hint');

// ── App state ─────────────────────────────────────────────────────────
let sourceImg   = null;   // full image element
let scanImg     = null;   // image actually scanned (possibly cropped)
let rawPipes    = [];     // every detection down to the 8% floor, with ids
let manualPipes = [];     // pipes the user added by hand
let nextManualId = 0;
let removedIds  = new Set();
let activePipes = [];     // what is currently drawn
let editMode    = 'remove';
let removeSize  = 'any';
let cancelToken = { cancelled: false };
let wakeLock    = null;

// Crop state
let crop = { x1: 0, y1: 0, x2: 1, y2: 1 };
let cropDrag = null, cropDragStart = null;

// Zoom / pan state
let zoom  = { scale: 1, tx: 0, ty: 0 };
let pinch = { active: false, startDist: 0, startScale: 1, ox: 0, oy: 0, startTx: 0, startTy: 0 };
let pan   = { active: false, startX: 0, startY: 0, startTx: 0, startTy: 0 };
let tapStart = null;

// ── Service Worker ────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

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
  clearResults();
  imageWrap.hidden = false;

  const url = URL.createObjectURL(file);
  preview.onload = () => {
    preview.onload = null;      // don't re-fire when crop swaps the src
    sourceImg = preview;
    setState('crop');
    waitForLayout(initCrop);
  };
  preview.src = url;
});

function waitForLayout(cb, tries = 0) {
  if (tries > 40) { cb(); return; }
  if (preview.offsetWidth > 0 && preview.offsetHeight > 0) cb();
  else requestAnimationFrame(() => waitForLayout(cb, tries + 1));
}

function clearResults() {
  rawPipes = []; manualPipes = []; activePipes = [];
  removedIds.clear();
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCanvas.hidden = true;
  cropOverlayEl.hidden = true;
  resetZoom();
}

// ══════════════════════════════════════════════════════════════════════
//  CROP TOOL
// ══════════════════════════════════════════════════════════════════════

function initCrop() {
  crop = { x1: 0.05, y1: 0.05, x2: 0.95, y2: 0.95 };
  sizeCanvasToPreview(cropOverlayEl);
  cropOverlayEl.hidden = false;
  drawCrop();
}

// Size a canvas backing store to the preview's *layout* box.
// offsetWidth/Height ignore CSS transforms, unlike getBoundingClientRect.
function sizeCanvasToPreview(canvas) {
  canvas.width  = Math.max(1, preview.offsetWidth);
  canvas.height = Math.max(1, preview.offsetHeight);
}

function drawCrop() {
  const c = cropOverlayEl, ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  const { x1, y1, x2, y2 } = crop;
  const [px1, py1, px2, py2] = [x1*w, y1*h, x2*w, y2*h];

  ctx.clearRect(0, 0, w, h);

  // Dim outside the crop box
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, py1);
  ctx.fillRect(0, py2, w, h - py2);
  ctx.fillRect(0, py1, px1, py2 - py1);
  ctx.fillRect(px2, py1, w - px2, py2 - py1);

  ctx.strokeStyle = '#39FF14';
  ctx.lineWidth = 2;
  ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);

  // Rule-of-thirds guides
  const cw = px2 - px1, ch = py2 - py1;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const t of [1/3, 2/3]) {
    ctx.moveTo(px1 + cw*t, py1); ctx.lineTo(px1 + cw*t, py2);
    ctx.moveTo(px1, py1 + ch*t); ctx.lineTo(px2, py1 + ch*t);
  }
  ctx.stroke();

  // Big, obvious corner handles
  [[px1,py1],[px2,py1],[px1,py2],[px2,py2]].forEach(([hx, hy]) => {
    ctx.beginPath();
    ctx.arc(hx, hy, 16, 0, Math.PI * 2);
    ctx.fillStyle = '#39FF14';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 16, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
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

function cropHandleAt(x, y) {
  const { x1, y1, x2, y2 } = crop;
  // Hit radius in normalised units, scaled off the canvas size so the
  // touch target is a comfortable ~40px regardless of image dimensions.
  const tx = 40 / Math.max(1, cropOverlayEl.width);
  const ty = 40 / Math.max(1, cropOverlayEl.height);
  const near = (px, py) => Math.abs(x - px) < tx && Math.abs(y - py) < ty;
  if (near(x1, y1)) return 'tl';
  if (near(x2, y1)) return 'tr';
  if (near(x1, y2)) return 'bl';
  if (near(x2, y2)) return 'br';
  if (x > x1 && x < x2 && y > y1 && y < y2) return 'body';
  return 'new';
}

function onCropStart(e) {
  e.preventDefault();
  const p = cropPos(e);
  cropDrag      = cropHandleAt(p.x, p.y);
  cropDragStart = { p, crop: { ...crop } };
  if (cropDrag === 'new') { crop = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }; drawCrop(); }
}

function onCropMove(e) {
  if (!cropDrag) return;
  e.preventDefault();
  const p  = cropPos(e);
  const dx = p.x - cropDragStart.p.x;
  const dy = p.y - cropDragStart.p.y;
  const r  = cropDragStart.crop;
  const S  = 0.05;
  if      (cropDrag === 'tl') { crop.x1=clamp(r.x1+dx,0,r.x2-S); crop.y1=clamp(r.y1+dy,0,r.y2-S); }
  else if (cropDrag === 'tr') { crop.x2=clamp(r.x2+dx,r.x1+S,1); crop.y1=clamp(r.y1+dy,0,r.y2-S); }
  else if (cropDrag === 'bl') { crop.x1=clamp(r.x1+dx,0,r.x2-S); crop.y2=clamp(r.y2+dy,r.y1+S,1); }
  else if (cropDrag === 'br') { crop.x2=clamp(r.x2+dx,r.x1+S,1); crop.y2=clamp(r.y2+dy,r.y1+S,1); }
  else if (cropDrag === 'body') {
    const bw = r.x2-r.x1, bh = r.y2-r.y1;
    crop.x1 = clamp(r.x1+dx, 0, 1-bw); crop.x2 = crop.x1+bw;
    crop.y1 = clamp(r.y1+dy, 0, 1-bh); crop.y2 = crop.y1+bh;
  } else {
    const sx = cropDragStart.p.x, sy = cropDragStart.p.y;
    crop.x1 = Math.min(sx, p.x); crop.x2 = Math.max(sx, p.x);
    crop.y1 = Math.min(sy, p.y); crop.y2 = Math.max(sy, p.y);
  }
  drawCrop();
}

function onCropEnd() { cropDrag = null; }

cropOverlayEl.addEventListener('mousedown',  onCropStart);
window       .addEventListener('mousemove',  onCropMove);
window       .addEventListener('mouseup',    onCropEnd);
cropOverlayEl.addEventListener('touchstart', onCropStart, { passive: false });
cropOverlayEl.addEventListener('touchmove',  onCropMove,  { passive: false });
cropOverlayEl.addEventListener('touchend',   onCropEnd);
cropOverlayEl.addEventListener('touchcancel',onCropEnd);

document.getElementById('reset-crop-btn').addEventListener('click', () => {
  crop = { x1: 0, y1: 0, x2: 1, y2: 1 };
  drawCrop();
});

document.getElementById('skip-crop-btn').addEventListener('click', () => {
  cropOverlayEl.hidden = true;
  startScan(sourceImg);
});

document.getElementById('apply-crop-btn').addEventListener('click', () => {
  const { x1, y1, x2, y2 } = crop;
  const sw = sourceImg.naturalWidth, sh = sourceImg.naturalHeight;
  const cx = Math.round(x1*sw), cy = Math.round(y1*sh);
  const cw = Math.round((x2-x1)*sw), ch = Math.round((y2-y1)*sh);
  if (cw < 32 || ch < 32) { setStatus('Crop area is too small.', true); return; }

  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(sourceImg, cx, cy, cw, ch, 0, 0, cw, ch);

  tmp.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const cropped = new Image();
    cropped.onload = () => {
      preview.src = url;               // show the cropped result
      cropOverlayEl.hidden = true;
      startScan(cropped);
    };
    cropped.src = url;
  }, 'image/jpeg', 0.95);
});

// ══════════════════════════════════════════════════════════════════════
//  ZOOM / PAN  (transforms the inner layer, clipped by .image-wrap)
// ══════════════════════════════════════════════════════════════════════

function applyZoom() {
  const W = imageWrap.clientWidth;
  const H = imageWrap.clientHeight;
  const s = zoom.scale;
  // Keep the scaled content covering the viewport box: tx ∈ [-W(s-1), 0]
  zoom.tx = Math.min(0, Math.max(-W * (s - 1), zoom.tx));
  zoom.ty = Math.min(0, Math.max(-H * (s - 1), zoom.ty));
  zoomLayer.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${s})`;
}

function resetZoom() {
  zoom = { scale: 1, tx: 0, ty: 0 };
  zoomLayer.style.transform = '';
}

document.getElementById('reset-zoom-btn').addEventListener('click', resetZoom);

overlayCanvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    tapStart = { x: t.clientX, y: t.clientY };
    if (zoom.scale > 1) {
      pan = { active: true, startX: t.clientX, startY: t.clientY,
              startTx: zoom.tx, startTy: zoom.ty };
    }
  } else if (e.touches.length === 2) {
    e.preventDefault();
    tapStart = null;            // two fingers is never a tap
    pan.active = false;
    const [t1, t2] = [e.touches[0], e.touches[1]];
    const r = imageWrap.getBoundingClientRect();
    pinch = {
      active: true,
      startDist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1,
      startScale: zoom.scale,
      ox: (t1.clientX + t2.clientX) / 2 - r.left,   // pinch centre, box-relative
      oy: (t1.clientY + t2.clientY) / 2 - r.top,
      startTx: zoom.tx, startTy: zoom.ty,
    };
  }
}, { passive: false });

overlayCanvas.addEventListener('touchmove', e => {
  if (pinch.active && e.touches.length === 2) {
    e.preventDefault();
    const [t1, t2] = [e.touches[0], e.touches[1]];
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const s    = Math.min(6, Math.max(1, pinch.startScale * (dist / pinch.startDist)));
    // Keep the point under the pinch centre stationary
    const k = s / pinch.startScale;
    zoom.scale = s;
    zoom.tx = pinch.ox - (pinch.ox - pinch.startTx) * k;
    zoom.ty = pinch.oy - (pinch.oy - pinch.startTy) * k;
    applyZoom();
  } else if (pan.active && e.touches.length === 1) {
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
    if (zoom.scale <= 1.02) resetZoom();
  }
  pan.active = false;

  // A tap = one finger, all fingers now lifted, barely moved.
  if (tapStart && e.touches.length === 0 && e.changedTouches.length === 1) {
    const t = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y);
    tapStart = null;
    if (moved <= 12) { e.preventDefault(); handleTap(t.clientX, t.clientY); }
    return;
  }
  tapStart = null;
}, { passive: false });

overlayCanvas.addEventListener('touchcancel', () => {
  pinch.active = false; pan.active = false; tapStart = null;
});

// Desktop
overlayCanvas.addEventListener('click', e => {
  if ('ontouchstart' in window) return;   // touch devices use the tap handler
  handleTap(e.clientX, e.clientY);
});

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
    const found = await detectPipes(img, mode,
      pct => setProgress(pct, `Scanning… ${pct}%`), cancelToken);

    // Keep every candidate; the sensitivity slider filters them live.
    rawPipes    = found.map((p, i) => ({ ...p, id: i }));
    manualPipes = [];
    removedIds.clear();

    setState('edit');
    sizeCanvasToPreview(overlayCanvas);
    overlayCanvas.hidden = false;
    initAddSizeDefault();
    refresh();
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
//  SENSITIVITY  (filters existing results — no re-scan)
// ══════════════════════════════════════════════════════════════════════

sensSlider.addEventListener('input', refresh);

function refresh() {
  const cutoff = sliderToCutoff(+sensSlider.value);
  const kept = rawPipes.filter(p => p.confidence >= cutoff && !removedIds.has(p.id));
  activePipes = applyRelativeSizes([...kept, ...manualPipes]);
  sensReadout.textContent = `${activePipes.length} pipes`;
  renderOverlay();
  renderBreakdown();
}

// ══════════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════════

function renderOverlay() {
  if (overlayCanvas.width !== preview.offsetWidth) sizeCanvasToPreview(overlayCanvas);
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // Thinner strokes as you zoom in, so circles stay crisp
  const zs = zoom.scale;

  activePipes.forEach((pipe, i) => {
    const px  = (pipe.x / 100) * overlayCanvas.width;
    const py  = (pipe.y / 100) * overlayCanvas.height;
    const pr  = Math.max(3, (pipe.radius / 100) * overlayCanvas.width);
    const col = SIZE_COLORS[pipe.sizeCategory] ?? SIZE_COLORS.medium;

    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(1, pr * 0.07) / zs;
    ctx.stroke();

    const fs = Math.max(7, Math.round(pr * 0.8));
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
    </div>`).join('') || '<p style="color:var(--muted);font-size:.9rem">No pipes at this sensitivity</p>';
}

// ══════════════════════════════════════════════════════════════════════
//  EDIT
// ══════════════════════════════════════════════════════════════════════

document.getElementById('btn-remove').addEventListener('click', () => setEditMode('remove'));
document.getElementById('btn-add').addEventListener('click',    () => setEditMode('add'));

function setEditMode(m) {
  editMode = m;
  document.getElementById('btn-remove').classList.toggle('active', m === 'remove');
  document.getElementById('btn-add').classList.toggle('active',    m === 'add');
  removeOpts.hidden = (m !== 'remove');
  addOpts.hidden    = (m !== 'add');
  updateHint();
}

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    removeSize = btn.dataset.size;
    updateHint();
  });
});

function updateHint() {
  editHint.textContent = editMode === 'remove'
    ? `Tap a ${removeSize === 'any' ? '' : removeSize + ' '}circle to remove it. Pinch to zoom · drag to pan.`
    : `Tap the image to add a ${addSizeInput.value}px pipe. Pinch to zoom · drag to pan.`;
}

// ── Add-size stepper ──────────────────────────────────────────────────
function initAddSizeDefault() {
  const w = scanImg?.naturalWidth || scanImg?.width || 1000;
  if (rawPipes.length) {
    const diams = rawPipes.map(p => (p.radius / 100) * w * 2).sort((a, b) => a - b);
    const med   = Math.round(diams[Math.floor(diams.length / 2)]);
    addSizeInput.value = Math.max(2, med);
    addSizeHint.textContent = `Detected average: ${med} px · image is ${w} px wide`;
  } else {
    addSizeHint.textContent = `Image is ${w} px wide`;
  }
  updateHint();
}

document.getElementById('size-minus').addEventListener('click', () => {
  addSizeInput.value = Math.max(2, (+addSizeInput.value || 2) - 2); updateHint();
});
document.getElementById('size-plus').addEventListener('click', () => {
  addSizeInput.value = (+addSizeInput.value || 0) + 2; updateHint();
});
addSizeInput.addEventListener('input', updateHint);

// ── Tap → add or remove ───────────────────────────────────────────────
function handleTap(clientX, clientY) {
  // getBoundingClientRect includes the zoom transform, so this maps the
  // screen point back into image percentage space correctly at any zoom.
  const r = overlayCanvas.getBoundingClientRect();
  const tapX = ((clientX - r.left) / r.width)  * 100;
  const tapY = ((clientY - r.top)  / r.height) * 100;
  if (tapX < 0 || tapX > 100 || tapY < 0 || tapY > 100) return;

  const aspect = overlayCanvas.height / overlayCanvas.width;

  if (editMode === 'remove') {
    let best = null, bestDist = Infinity;
    activePipes.forEach(pipe => {
      if (removeSize !== 'any' && pipe.sizeCategory !== removeSize) return;
      const d = Math.hypot(pipe.x - tapX, (pipe.y - tapY) * aspect);
      if (d < bestDist) { best = pipe; bestDist = d; }
    });
    if (best && bestDist < Math.max(best.radius * 2.5, 1.5)) {
      if (best.mid != null) manualPipes = manualPipes.filter(p => p.mid !== best.mid);
      else                  removedIds.add(best.id);
      refresh();
    }
  } else {
    const w  = scanImg?.naturalWidth || scanImg?.width || 1000;
    const px = Math.max(2, +addSizeInput.value || 2);
    // Radius as a percentage of image width, from the diameter in image pixels.
    manualPipes.push({
      x: tapX, y: tapY,
      radius: (px / 2) / w * 100,
      confidence: 100,
      mid: nextManualId++,
    });
    refresh();
  }
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
    const fs = Math.max(10, Math.round(pr * 0.8));
    ctx.font         = `bold ${fs}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = col;
    ctx.fillText(String(i + 1), px, py);
  });

  const label = `${activePipes.length} pipe ends`;
  const fs    = Math.max(20, Math.round(w * 0.045));
  ctx.font    = `bold ${fs}px sans-serif`;
  const tw    = ctx.measureText(label).width;
  const pad   = 12, bh = fs * 1.6;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(pad, pad, tw + pad * 2, bh);
  ctx.fillStyle = '#39FF14';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, pad * 2, pad + bh * 0.72);

  sc.toBlob(async blob => {
    const name = `pipes-${activePipes.length}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: label });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
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
  clearResults();
  sourceImg = null; scanImg = null;
  fileInput.value = '';
  preview.onload  = null;
  preview.removeAttribute('src');
  setStatus('Ready — tap Pick Image to start');
  setState('idle');
});

// Keep canvases correct when the viewport changes (rotation etc.)
window.addEventListener('resize', () => {
  if (!document.getElementById('sec-edit').hidden) { sizeCanvasToPreview(overlayCanvas); renderOverlay(); }
  else if (!document.getElementById('sec-crop').hidden) { sizeCanvasToPreview(cropOverlayEl); drawCrop(); }
});

// ── Helpers ────────────────────────────────────────────────────────────
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className   = 'status' + (isError ? ' error' : '');
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
