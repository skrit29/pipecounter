// app.js — PipeCounter web app
import { loadModel, detectPipes } from './detector.js';
import { applyRelativeSizes, buildSizeBreakdown } from './pipeBreakdown.js';

// FP16 model (52MB). The old INT8 build was 26MB but dynamic quantisation
// wrecked the box-regression head — measured against FP32, box coordinates
// were off by up to 167px on a 640px input, which is what produced circles
// offset from their pipe, wrong radii, and duplicate detections at shifted
// positions. FP16 matches FP32 to 0.59px and correlates 1.00000 on
// confidence, at 1.6x the inference time. Downloaded once, then cached.
// Fetched from the `model-store` branch, which GitHub Pages does not publish.
//
// A ~50MB file inside the published tree has to be re-uploaded on every deploy,
// and that was consistently pushing the deployment past its timeout — fixes
// stopped reaching the live site entirely. Parking the model on a branch that
// is never published keeps the deployed site under a megabyte, so deploys are
// fast again, while raw.githubusercontent.com serves the file with
// Access-Control-Allow-Origin: * so the browser can fetch it cross-origin.
// It is still downloaded once and then cached in IndexedDB, so offline use is
// unchanged. The relative path stays as a fallback for local checkouts that
// have the model sitting next to the app.
const MODEL_URL   = [
  'https://raw.githubusercontent.com/skrit29/pipecounter/model-store/assets/models/pipe-counter-fp16.onnx',
  './assets/models/pipe-counter-fp16.onnx',
];
const SIZE_COLORS = { small: '#FF7A00', medium: '#FFD60A', large: '#39FF14' };

// Sensitivity slider maps 0..100 → confidence cutoff (%).
// Left (0)  = Low  sensitivity = high cutoff = fewer, surer detections.
// Right(100)= High sensitivity = low  cutoff = more, noisier detections.
const CUT_MIN = 6;    // cutoff at slider 100 (matches the detector's floor)
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
const addSizeRange  = document.getElementById('add-size-range');
const addSizePx     = document.getElementById('add-size-px');
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

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  clearResults();
  imageWrap.hidden = false;
  setStatus('Reading image…');

  // Decode with createImageBitmap rather than letting an <img> do it.
  //
  // Mobile browsers — old Android WebView especially — silently downsample
  // large JPEGs when decoding into an <img> to save memory. That is why the
  // crop screen looked so low-resolution there, and it also meant detection
  // ran on a shrunken image. createImageBitmap decodes at true size.
  let bmp = null;
  try {
    if ('createImageBitmap' in window) bmp = await createImageBitmap(file);
  } catch (_) { /* fall through to the <img> path below */ }

  const url = URL.createObjectURL(file);
  preview.onload = () => {
    preview.onload = null;      // don't re-fire when crop swaps the src
    sourceImg = bmp || preview; // full-resolution source for crop + detection
    setStatus('');
    setState('crop');
    waitForLayout(initCrop);
  };
  // Feed the preview from the decoded bitmap so the crop screen is sharp even
  // where the browser would have downsampled the file itself.
  preview.src = bmp ? previewURLFromBitmap(bmp) : url;
});

// Render the bitmap into a canvas capped at a sane display size. Keeps the
// crop view crisp without holding a full-resolution copy in the DOM.
function previewURLFromBitmap(bmp) {
  const MAXW = 1600;
  const scale = Math.min(1, MAXW / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(bmp, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', 0.92);
}

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
  // waitForLayout can fire after the user has already moved on (e.g. tapped
  // "Full Image" immediately). Never resurrect the crop box outside crop state.
  if (document.getElementById('sec-crop').hidden) return;
  crop = { x1: 0.05, y1: 0.05, x2: 0.95, y2: 0.95 };
  sizeCanvasToPreview(cropOverlayEl);
  cropOverlayEl.hidden = false;
  drawCrop();
}

// Backing-store scale factor. The canvas must be allocated at the DISPLAY's
// real pixel density or everything drawn on it is upscaled and looks soft —
// on a 3x phone that meant rendering at a third of the panel's resolution.
// When zoomed we supersample further, since CSS scales the canvas up too.
function canvasScale() {
  const dpr = window.devicePixelRatio || 1;
  // Hold the current scale steady during a pinch; reallocating the backing
  // store every frame would stutter. It re-sharpens when the gesture ends.
  if (pinch.active && overlayCanvas._ss) return overlayCanvas._ss;
  return dpr * Math.min(3, Math.max(1, zoom.scale));
}

// Size a canvas backing store to the preview's *layout* box, at device
// resolution. offsetWidth/Height ignore CSS transforms, unlike
// getBoundingClientRect. The context is then scaled so all drawing code can
// keep working in CSS-pixel units.
function sizeCanvasToPreview(canvas) {
  const ss   = canvasScale();
  const cssW = Math.max(1, preview.offsetWidth);
  const cssH = Math.max(1, preview.offsetHeight);
  canvas.width  = Math.round(cssW * ss);
  canvas.height = Math.round(cssH * ss);
  canvas.getContext('2d').setTransform(ss, 0, 0, ss, 0, 0);
  canvas._cssW = cssW; canvas._cssH = cssH; canvas._ss = ss;
}

function drawCrop() {
  const c = cropOverlayEl, ctx = c.getContext('2d');
  const w = c._cssW || c.width, h = c._cssH || c.height;
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
  const tx = 40 / Math.max(1, cropOverlayEl._cssW || cropOverlayEl.width);
  const ty = 40 / Math.max(1, cropOverlayEl._cssH || cropOverlayEl.height);
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
  // ImageBitmap exposes width/height; HTMLImageElement naturalWidth/Height.
  const sw = sourceImg.naturalWidth  || sourceImg.width;
  const sh = sourceImg.naturalHeight || sourceImg.height;
  const cx = Math.round(x1*sw), cy = Math.round(y1*sh);
  const cw = Math.round((x2-x1)*sw), ch = Math.round((y2-y1)*sh);
  if (cw < 32 || ch < 32) { setStatus('Crop area is too small.', true); return; }

  // Crop straight into a canvas at full source resolution and scan THAT —
  // no JPEG round-trip, so nothing is lost between cropping and detection.
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(sourceImg, cx, cy, cw, ch, 0, 0, cw, ch);

  cropOverlayEl.hidden = true;
  preview.onload = () => { preview.onload = null; startScan(tmp); };
  preview.src = tmp.toDataURL('image/jpeg', 0.92);   // display copy only
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
  // The ghost sits at the centre of the visible area and strokes scale with
  // zoom, so it has to be redrawn as the view moves.
  if (editMode === 'add' && !document.getElementById('sec-edit').hidden) renderOverlay();
}

function resetZoom() {
  zoom = { scale: 1, tx: 0, ty: 0 };
  zoomLayer.style.transform = '';
}

document.getElementById('reset-zoom-btn').addEventListener('click', () => {
  resetZoom();
  renderOverlay();   // drop the supersampled backing store back to 1x
});

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
    renderOverlay();          // re-allocate at the new zoom so circles sharpen
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

// ── Desktop: wheel to zoom, click-drag to pan, click to add/remove ────
let usedTouch = false;
let mouseDrag = null, mouseMoved = false;

overlayCanvas.addEventListener('touchstart', () => { usedTouch = true; }, { passive: true });

overlayCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r  = imageWrap.getBoundingClientRect();
  const ox = e.clientX - r.left, oy = e.clientY - r.top;
  const s  = Math.min(6, Math.max(1, zoom.scale * Math.exp(-e.deltaY * 0.0018)));
  const k  = s / zoom.scale;
  // Keep the point under the cursor fixed while scaling
  zoom.tx = ox - (ox - zoom.tx) * k;
  zoom.ty = oy - (oy - zoom.ty) * k;
  zoom.scale = s;
  if (s <= 1.02) resetZoom(); else applyZoom();
  renderOverlay();
}, { passive: false });

overlayCanvas.addEventListener('mousedown', e => {
  mouseDrag  = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty };
  mouseMoved = false;
});
window.addEventListener('mousemove', e => {
  if (!mouseDrag) return;
  const dx = e.clientX - mouseDrag.x, dy = e.clientY - mouseDrag.y;
  if (Math.hypot(dx, dy) > 4) mouseMoved = true;
  if (zoom.scale > 1 && mouseMoved) {
    zoom.tx = mouseDrag.tx + dx;
    zoom.ty = mouseDrag.ty + dy;
    applyZoom();
  }
});
window.addEventListener('mouseup', () => { mouseDrag = null; });

overlayCanvas.addEventListener('click', e => {
  if (usedTouch) return;   // touch devices go through the tap handler
  if (mouseMoved) return;  // that was a pan, not a click
  handleTap(e.clientX, e.clientY);
});

// ══════════════════════════════════════════════════════════════════════
//  SCAN
// ══════════════════════════════════════════════════════════════════════

async function startScan(img) {
  scanImg     = img;
  cancelToken = { cancelled: false };
  cropOverlayEl.hidden = true;   // the crop box never belongs over results
  setState('scan');
  setProgress(0, 'Starting…');

  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}

  try {
    const mode = modeHigh.checked ? 'high' : 'standard';
    const found = await detectPipes(img, mode,
      pct => setProgress(pct, `Scanning… ${pct}%`), cancelToken,
      { enhance: document.getElementById('enhance-chk').checked });

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

  // Say how many more candidates exist below the cutoff, so it's obvious
  // when sliding right would actually reveal something.
  const more = rawPipes.filter(p => p.confidence < cutoff && !removedIds.has(p.id)).length;
  sensReadout.textContent = more > 0
    ? `${activePipes.length} shown · ${more} more →`
    : `${activePipes.length} pipes`;

  renderOverlay();
  renderBreakdown();
}

// ══════════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════════

function renderOverlay() {
  // If the element currently has no layout (backgrounded tab, pane hidden),
  // resizing the canvas to 1px would throw the drawing away. Skip and let
  // the resize/visibility handler redraw once real dimensions come back.
  if (preview.offsetWidth < 2) return;
  const ss = canvasScale();
  if (overlayCanvas._cssW !== preview.offsetWidth || overlayCanvas._ss !== ss) {
    sizeCanvasToPreview(overlayCanvas);
  }
  const W = overlayCanvas._cssW, H = overlayCanvas._cssH;
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Thinner strokes as you zoom in, so circles stay crisp
  const zs = zoom.scale;

  activePipes.forEach((pipe, i) => {
    const px  = (pipe.x / 100) * W;
    const py  = (pipe.y / 100) * H;
    const pr  = Math.max(3, (pipe.radius / 100) * W);
    const col = SIZE_COLORS[pipe.sizeCategory] ?? SIZE_COLORS.medium;

    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth   = Math.max(1, pr * 0.07) / zs;
    ctx.stroke();

    // Labels are sized in SCREEN pixels, not image pixels.
    //
    // The canvas lives inside the zoom layer, so anything drawn here is
    // magnified by the CSS transform. Sizing the number off the radius meant
    // zooming in blew the digits up along with the pipe, so they always
    // covered it. Dividing by the zoom keeps each number a constant size on
    // screen: zoom in and the pipe grows while the number does not, which is
    // what actually lets you check a detection.
    const label    = String(i + 1);
    const screenR  = pr * zs;                       // radius as it appears on screen
    // Too small to read, and at hundreds of pipes the digits become a solid
    // mat that hides the image entirely. Draw the ring only; zoom to label.
    if (screenR < 9) return;
    const fsScreen = Math.min(screenR * 0.5 / Math.sqrt(label.length), 15);
    const fs       = fsScreen / zs;                 // back into canvas units

    ctx.font         = `bold ${fs}px -apple-system, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    // Dark halo keeps the number readable over both bright and dark pipes.
    ctx.lineWidth   = Math.max(1, fsScreen * 0.18) / zs;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineJoin    = 'round';
    ctx.strokeText(label, px, py);
    ctx.fillStyle   = col;
    ctx.fillText(label, px, py);
  });

  if (editMode === 'add') drawAddPreview(ctx, zs);

  countLbl.textContent = activePipes.length;
}

// Dashed ghost circle showing exactly how big an added pipe will be,
// drawn at the centre of whatever part of the image is currently on screen
// so it sits right next to real pipes for comparison.
function drawAddPreview(ctx, zs) {
  const W = overlayCanvas._cssW, H = overlayCanvas._cssH;
  const s = zoom.scale;
  // Map the centre of the visible viewport back into canvas coordinates.
  const cx = ((imageWrap.clientWidth  / 2) - zoom.tx) / s;
  const cy = ((imageWrap.clientHeight / 2) - zoom.ty) / s;
  const pr = addRadiusPct() / 100 * W;
  if (!(pr > 0) || cx < 0 || cx > W || cy < 0 || cy > H) return;

  ctx.save();
  ctx.setLineDash([6 / zs, 5 / zs]);
  ctx.beginPath();
  ctx.arc(cx, cy, pr, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(57,255,20,0.14)';
  ctx.fill();
  ctx.strokeStyle = '#39FF14';
  ctx.lineWidth = Math.max(1.5, pr * 0.06) / zs;
  ctx.stroke();
  // Crosshair so the exact centre is unambiguous
  ctx.setLineDash([]);
  const t = Math.max(4, pr * 0.3);
  ctx.beginPath();
  ctx.moveTo(cx - t, cy); ctx.lineTo(cx + t, cy);
  ctx.moveTo(cx, cy - t); ctx.lineTo(cx, cy + t);
  ctx.lineWidth = 1.5 / zs;
  ctx.stroke();
  ctx.restore();
}

// Radius (as % of image width) for the size currently chosen in Add mode.
function addRadiusPct() {
  const w  = scanImg?.naturalWidth || scanImg?.width || 1000;
  const px = Math.max(2, +addSizeInput.value || 2);
  return (px / 2) / w * 100;
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
  if (!document.getElementById('sec-edit').hidden) renderOverlay();  // show/hide ghost
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
  const gesture = matchMedia('(pointer: coarse)').matches
    ? 'Pinch to zoom · drag to pan.'
    : 'Scroll wheel to zoom · drag to pan · Fit to reset.';
  editHint.textContent = editMode === 'remove'
    ? `Tap a ${removeSize === 'any' ? '' : removeSize + ' '}circle to remove it. ${gesture}`
    : `Tap the image to add a ${addSizeInput.value}px pipe. ${gesture}`;
}

// ── Add-size picker (slider + number + live preview) ──────────────────
let detectedMedianPx = 40;

function initAddSizeDefault() {
  const w = scanImg?.naturalWidth || scanImg?.width || 1000;
  if (rawPipes.length) {
    const diams = rawPipes.map(p => (p.radius / 100) * w * 2).sort((a, b) => a - b);
    detectedMedianPx = Math.max(2, Math.round(diams[Math.floor(diams.length / 2)]));
    addSizeHint.textContent = `Detected average: ${detectedMedianPx} px · image is ${w} px wide`;
  } else {
    addSizeHint.textContent = `Image is ${w} px wide`;
  }
  // Range covers a useful span around the real pipe size in this image.
  addSizeRange.max = Math.max(40, Math.round(detectedMedianPx * 4));
  setAddSize(detectedMedianPx);
}

function setAddSize(px) {
  const v = Math.max(2, Math.round(px));
  addSizeInput.value = v;
  addSizeRange.value = Math.min(v, +addSizeRange.max);
  addSizePx.textContent = v;
  updateHint();
  if (!document.getElementById('sec-edit').hidden) renderOverlay();  // refresh ghost
}

addSizeRange.addEventListener('input', () => setAddSize(+addSizeRange.value));
addSizeInput.addEventListener('input', () => setAddSize(+addSizeInput.value || 2));
document.getElementById('size-minus').addEventListener('click', () => setAddSize((+addSizeInput.value || 2) - 2));
document.getElementById('size-plus') .addEventListener('click', () => setAddSize((+addSizeInput.value || 0) + 2));
document.getElementById('size-match').addEventListener('click', () => setAddSize(detectedMedianPx));

// ── Tap → add or remove ───────────────────────────────────────────────
function handleTap(clientX, clientY) {
  // getBoundingClientRect includes the zoom transform, so this maps the
  // screen point back into image percentage space correctly at any zoom.
  const r = overlayCanvas.getBoundingClientRect();
  const tapX = ((clientX - r.left) / r.width)  * 100;
  const tapY = ((clientY - r.top)  / r.height) * 100;
  if (tapX < 0 || tapX > 100 || tapY < 0 || tapY > 100) return;

  const aspect = overlayCanvas._cssH / overlayCanvas._cssW;

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
    manualPipes.push({
      x: tapX, y: tapY,
      radius: addRadiusPct(),
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
    const label = String(i + 1);
    const fs    = Math.max(10, Math.round(pr * 0.55 / Math.sqrt(label.length)));
    ctx.font         = `bold ${fs}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth    = Math.max(1, fs * 0.18);
    ctx.strokeStyle  = 'rgba(0,0,0,0.8)';
    ctx.lineJoin     = 'round';
    ctx.strokeText(label, px, py);
    ctx.fillStyle    = col;
    ctx.fillText(label, px, py);
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

// Keep canvases correct when the viewport changes (rotation, tab restored…)
function relayoutCanvases() {
  if (preview.offsetWidth < 2) return;
  if (!document.getElementById('sec-edit').hidden) { sizeCanvasToPreview(overlayCanvas); renderOverlay(); }
  else if (!document.getElementById('sec-crop').hidden) { sizeCanvasToPreview(cropOverlayEl); drawCrop(); }
}
window.addEventListener('resize', relayoutCanvases);
window.addEventListener('orientationchange', () => setTimeout(relayoutCanvases, 200));
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(relayoutCanvases, 60); });

// ── Helpers ────────────────────────────────────────────────────────────
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className   = 'status' + (isError ? ' error' : '');
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
