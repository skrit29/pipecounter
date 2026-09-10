// detector.js — ONNX-based pipe detection, ported from PipeDetectorModule.kt
//
// Runs entirely in the browser via onnxruntime-web (WebAssembly backend).
// The model is loaded once and cached in IndexedDB for offline use.

const INPUT_SIZE             = 640;
const STANDARD_TILE_SIZE     = 1280;
const MAX_STANDARD_SIDE      = 1920;
const MAX_HIGH_SIDE          = 2560;
const CONFIDENCE_THRESHOLD   = 0.32;
const IOU_THRESHOLD          = 0.45;
const SMALLER_BOX_OVERLAP    = 0.88;
const NESTED_MAX_SIZE_RATIO  = 0.58;
const MIN_BOX_SIDE_MODEL_PX  = 4;
const MAX_ASPECT_RATIO       = 2.5;
const HIGH_RES_STRIDE_MULT   = 0.60;
const STANDARD_STRIDE_MULT   = 0.75;
const MAX_REGION_CANDIDATES  = 2000;

const DB_NAME    = 'PipeCounterDB';
const DB_VERSION = 1;
const STORE_NAME = 'models';
const MODEL_KEY  = 'pipe-counter';

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function getModelFromDB(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(MODEL_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function saveModelToDB(db, buffer) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(buffer, MODEL_KEY);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Model loading ─────────────────────────────────────────────────────────────

let _session = null;

/**
 * Load the ONNX model.  On the first call the model is fetched from `url`,
 * stored in IndexedDB, and the ONNX session is created.  Subsequent calls
 * (even offline) read the model bytes directly from IndexedDB.
 *
 * @param {string} url   URL of the .onnx file (relative or absolute)
 * @param {Function} onProgress  (0-100) called during the initial download
 */
export async function loadModel(url, onProgress) {
  if (_session) return _session;

  const db     = await openDB();
  let   buffer = await getModelFromDB(db);

  if (!buffer) {
    // First load: fetch with progress.
    onProgress?.(0);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch model: ${response.status}`);
    const total  = parseInt(response.headers.get('Content-Length') || '0');
    const reader = response.body.getReader();
    const chunks = [];
    let   loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total > 0) onProgress?.(Math.round(loaded / total * 80));
    }
    const all = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.length; }
    buffer = all.buffer;
    await saveModelToDB(db, buffer);
    onProgress?.(85);
  } else {
    onProgress?.(85);
  }

  // Point onnxruntime-web WASM files to the CDN so they load correctly.
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/';

  _session = await ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
  });
  onProgress?.(100);
  return _session;
}

// ── Main detection function ───────────────────────────────────────────────────

/**
 * Detect pipe ends in the given image.
 *
 * @param {HTMLImageElement|ImageBitmap} img
 * @param {'standard'|'high'} mode
 * @param {Function} onProgress   (0-100)
 * @param {{ cancelled: boolean }} cancelToken
 * @returns {Array<{x,y,radius,confidence}>}  coordinates as % of image size
 */
export async function detectPipes(img, mode, onProgress, cancelToken) {
  if (!_session) throw new Error('Model not loaded');

  const highRes      = mode === 'high';
  const maxSide      = highRes ? MAX_HIGH_SIDE : MAX_STANDARD_SIDE;
  const strideMult   = highRes ? HIGH_RES_STRIDE_MULT : STANDARD_STRIDE_MULT;
  const tileSize     = STANDARD_TILE_SIZE; // always 1280 — both modes

  // ── Pre-scale ──────────────────────────────────────────────────────────────
  const { canvas, ctx, ww, wh } = prescale(img, maxSide);
  const imageData = ctx.getImageData(0, 0, ww, wh);

  // ── Tile ───────────────────────────────────────────────────────────────────
  const regions  = buildTileRegions(ww, wh, tileSize, strideMult);
  const allBoxes = [];

  for (let i = 0; i < regions.length; i++) {
    if (cancelToken?.cancelled) throw new Error('cancelled');
    const boxes = await runTile(_session, imageData, ww, wh, regions[i]);
    allBoxes.push(...boxes);
    onProgress?.(Math.round(((i + 1) / regions.length) * 90));
  }

  if (cancelToken?.cancelled) throw new Error('cancelled');

  // ── Merge + NMS ────────────────────────────────────────────────────────────
  const selected = mergeDetections(allBoxes);

  // ── Convert to percentage coordinates ─────────────────────────────────────
  return selected.map(box => {
    const bw = box.x2 - box.x1;
    const bh = box.y2 - box.y1;
    return {
      x:          ((box.x1 + box.x2) / 2 / ww) * 100,
      y:          ((box.y1 + box.y2) / 2 / wh) * 100,
      radius:     (Math.sqrt(bw * bh) / 2 / ww) * 100,
      confidence: box.conf * 100,
    };
  });
}

// ── Pre-scale ─────────────────────────────────────────────────────────────────

function prescale(img, maxSide) {
  const srcW = img.naturalWidth  || img.width;
  const srcH = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const ww    = Math.max(1, Math.round(srcW * scale));
  const wh    = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width  = ww;
  canvas.height = wh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, ww, wh);
  return { canvas, ctx, ww, wh };
}

// ── Tile geometry ─────────────────────────────────────────────────────────────

function buildTileRegions(imgW, imgH, tileSize, strideMult) {
  const tw  = Math.min(tileSize, imgW);
  const th  = Math.min(tileSize, imgH);
  const ys  = tilePositions(imgH, th, strideMult);
  const xs  = tilePositions(imgW, tw, strideMult);
  const out = [];
  for (const y of ys) for (const x of xs) out.push({ x, y, w: tw, h: th });
  return out;
}

function tilePositions(imageSize, tileSize, strideMult) {
  if (imageSize <= tileSize) return [0];
  const stride    = Math.round(tileSize * strideMult);
  const positions = [];
  let   pos       = 0;
  while (pos < imageSize - tileSize) { positions.push(pos); pos += stride; }
  const last = imageSize - tileSize;
  if (positions[positions.length - 1] !== last) positions.push(last);
  return positions;
}

// ── Tile inference ────────────────────────────────────────────────────────────

async function runTile(session, imageData, imgW, imgH, region) {
  const { x, y, w, h } = region;
  const scale       = Math.min(INPUT_SIZE / w, INPUT_SIZE / h);
  const rsW         = Math.max(1, Math.round(w * scale));
  const rsH         = Math.max(1, Math.round(h * scale));
  const padL        = Math.round((INPUT_SIZE - rsW) / 2 - 0.1);
  const padT        = Math.round((INPUT_SIZE - rsH) / 2 - 0.1);
  const planeSize   = INPUT_SIZE * INPUT_SIZE;
  const input       = new Float32Array(3 * planeSize).fill(114 / 255);
  const pixels      = imageData.data; // RGBA flat array

  for (let ty = 0; ty < rsH; ty++) {
    const srcY = Math.min(imgH - 1, y + Math.floor(ty / scale));
    for (let tx = 0; tx < rsW; tx++) {
      const srcX   = Math.min(imgW - 1, x + Math.floor(tx / scale));
      const src    = (srcY * imgW + srcX) * 4;
      const dst    = (ty + padT) * INPUT_SIZE + (tx + padL);
      input[dst]                 = pixels[src]     / 255; // R
      input[planeSize + dst]     = pixels[src + 1] / 255; // G
      input[planeSize * 2 + dst] = pixels[src + 2] / 255; // B
    }
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds  = { [session.inputNames[0]]: tensor };
  const out    = await session.run(feeds);
  const ov     = out[session.outputNames[0]];
  const boxes  = decodeOutput(ov.data, ov.dims, w, h, scale, padL, padT);

  // Translate to full-image coordinates
  return nms(boxes, IOU_THRESHOLD).map(b => ({
    x1: b.x1 + x, y1: b.y1 + y, x2: b.x2 + x, y2: b.y2 + y, conf: b.conf,
  }));
}

// ── Output decoding ───────────────────────────────────────────────────────────

function decodeOutput(data, dims, tileW, tileH, scale, padL, padT) {
  const isV8 = dims && dims.length >= 3 && dims[1] < dims[2];
  return isV8
    ? decodeV8(data, dims, tileW, tileH, scale, padL, padT)
    : decodeV5(data,       tileW, tileH, scale, padL, padT);
}

function decodeV8(data, dims, tileW, tileH, scale, padL, padT) {
  const numRows = dims[1];           // 4 + nc, usually 5 for nc=1
  const numBoxes = dims[2];          // 8400
  const boxes  = [];
  for (let i = 0; i < numBoxes; i++) {
    let maxConf = 0;
    for (let c = 4; c < numRows; c++) {
      const v = data[c * numBoxes + i];
      if (v > maxConf) maxConf = v;
    }
    if (maxConf < CONFIDENCE_THRESHOLD) continue;
    const cx = data[0 * numBoxes + i];
    const cy = data[1 * numBoxes + i];
    const bw = data[2 * numBoxes + i];
    const bh = data[3 * numBoxes + i];
    if (!boxValid(bw, bh)) continue;
    const box = toImageBox(cx, cy, bw, bh, tileW, tileH, scale, padL, padT);
    if (box) boxes.push({ ...box, conf: maxConf });
  }
  return boxes.sort((a, b) => b.conf - a.conf).slice(0, MAX_REGION_CANDIDATES);
}

function decodeV5(data, tileW, tileH, scale, padL, padT) {
  const boxes = [];
  for (let off = 0; off + 6 <= data.length; off += 6) {
    const conf = data[off + 4] * data[off + 5];
    if (conf < CONFIDENCE_THRESHOLD) continue;
    const bw = data[off + 2], bh = data[off + 3];
    if (!boxValid(bw, bh)) continue;
    const box = toImageBox(data[off], data[off + 1], bw, bh, tileW, tileH, scale, padL, padT);
    if (box) boxes.push({ ...box, conf });
  }
  return boxes.sort((a, b) => b.conf - a.conf).slice(0, MAX_REGION_CANDIDATES);
}

function boxValid(bw, bh) {
  if (bw <= 0 || bh <= 0) return false;
  const asp = bw / bh;
  return asp <= MAX_ASPECT_RATIO && asp >= 1 / MAX_ASPECT_RATIO
    && bw >= MIN_BOX_SIDE_MODEL_PX && bh >= MIN_BOX_SIDE_MODEL_PX;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function toImageBox(cx, cy, bw, bh, tileW, tileH, scale, padL, padT) {
  const x1 = clamp((cx - bw / 2 - padL) / scale, 0, tileW);
  const y1 = clamp((cy - bh / 2 - padT) / scale, 0, tileH);
  const x2 = clamp((cx + bw / 2 - padL) / scale, 0, tileW);
  const y2 = clamp((cy + bh / 2 - padT) / scale, 0, tileH);
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

// ── NMS + cross-tile merge ────────────────────────────────────────────────────

function nms(boxes, threshold) {
  const kept = [];
  for (const b of boxes.sort((a, b2) => b2.conf - a.conf)) {
    if (!kept.some(k => iou(b, k) > threshold)) kept.push(b);
  }
  return kept;
}

function mergeDetections(boxes) {
  // Remove duplicates across tiles (smaller box heavily overlapping larger)
  const filtered = [];
  for (const b of boxes.sort((a, b2) => area(b2) - area(a))) {
    const dup = filtered.some(k =>
      k.conf >= b.conf * 0.85 &&
      intersectionOverSmaller(b, k) > SMALLER_BOX_OVERLAP &&
      !plausibleNested(b, k)
    );
    if (!dup) filtered.push(b);
  }
  return nms(filtered, IOU_THRESHOLD);
}

function plausibleNested(a, b) {
  const aA = area(a), aB = area(b);
  const ratio = Math.sqrt(Math.min(aA, aB) / Math.max(aA, aB));
  if (ratio > NESTED_MAX_SIZE_RATIO) return false;
  const smaller = aA <= aB ? a : b;
  const larger  = smaller === a ? b : a;
  const scx = (smaller.x1 + smaller.x2) / 2, scy = (smaller.y1 + smaller.y2) / 2;
  const lcx = (larger.x1  + larger.x2)  / 2, lcy = (larger.y1  + larger.y2)  / 2;
  const offset = Math.sqrt((scx - lcx) ** 2 + (scy - lcy) ** 2);
  return offset + Math.sqrt(area(smaller)) / 2 <= Math.sqrt(area(larger)) / 2 * 1.04;
}

function intersectionOverSmaller(a, b) {
  const i = interArea(a, b);
  return i / Math.max(Math.min(area(a), area(b)), 1e-10);
}
function iou(a, b) {
  const i = interArea(a, b);
  return i / Math.max(area(a) + area(b) - i, 1e-10);
}
function interArea(a, b) {
  return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) *
         Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
}
function area(b) { return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1); }
