// detector.js — ONNX-based pipe detection, ported from PipeDetectorModule.kt
//
// Runs entirely in the browser via onnxruntime-web (WebAssembly backend).
// The model is loaded once and cached in IndexedDB for offline use.

const INPUT_SIZE             = 640;
const STANDARD_TILE_SIZE     = 1280;
const MAX_STANDARD_SIDE      = 1920;
const MAX_HIGH_SIDE          = 2560;
// Detection floor. We deliberately keep everything down to a very low score
// and let the UI sensitivity slider filter the results afterwards, so the
// user can tune the count without paying for a re-scan.
const CONFIDENCE_THRESHOLD   = 0.06;
const IOU_THRESHOLD          = 0.45;
// Two detections whose centres are closer than this fraction of (r1 + r2)
// are the same pipe. r1+r2 is exactly the distance at which two pipe ends
// touch, so anything closer would have to physically overlap — impossible.
// The margin is wide: equal touching pipes sit at 1.0 of that sum while
// duplicates cluster below 0.65. Basing it on the SUM rather than the larger
// radius is what makes it correct for a small pipe beside a large one.
const CENTRE_DEDUP_FRAC      = 0.65;
const SMALLER_BOX_OVERLAP    = 0.88;
const NESTED_MAX_SIZE_RATIO  = 0.58;
const MIN_BOX_SIDE_MODEL_PX  = 4;
const MAX_ASPECT_RATIO       = 2.5;
const HIGH_RES_STRIDE_MULT   = 0.60;
// 0.75 is also measured: widening to 0.80 to save tiles lost detections at
// tile seams alongside the TARGET_OBJ_PX change above.
const STANDARD_STRIDE_MULT   = 0.75;
const MAX_REGION_CANDIDATES  = 2000;

// How large a pipe should appear inside the 640px model input.
//
// This is the single biggest driver of accuracy. Measured on one image by
// feeding the model the same pipes at three scales:
//     pipe ~36px in input -> 45 found, best confidence 0.39
//     pipe ~72px in input -> 67 found, best confidence 0.63
//     pipe ~144px in input -> 28 found, best confidence 0.80
// A fixed 1280px tile squeezed into 640 halves everything, so on a photo whose
// pipes are already small the model was being handed ~36px blobs and returned
// low-confidence guesses that looked random. Tile size is now derived from the
// measured pipe size so pipes always land near this target.
// 110 is measured, not guessed. Trying 95 to save tiles (and time) dropped
// this same image from 102 confident detections to 69 — the earlier "72px is
// good enough" figure came from a single small crop, not the full tiled scan.
// Do not lower this without re-running that comparison.
const TARGET_OBJ_PX          = 110;
const PROBE_CONF             = 0.12;
const MIN_TILE               = 320;
const MAX_TILE               = 1600;
const MAX_TILES_STANDARD     = 48;
const MAX_TILES_HIGH         = 96;

const DB_NAME    = 'PipeCounterDB';
const DB_VERSION = 1;
const STORE_NAME = 'models';
// Keyed by build. Changing this forces existing installs to fetch the new
// model instead of reusing the cached INT8 bytes from a previous version.
const MODEL_KEY  = 'pipe-counter-fp16';

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

// Resolves to null rather than hanging or throwing. IndexedDB can be blocked
// by another tab mid-upgrade, or unavailable entirely (private browsing, or
// storage disabled), and previously either case left the app stuck on
// "Loading AI model…" forever with no way out. The cache is an optimisation,
// never a requirement — if it isn't there we just fetch the model.
function openDB() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    // Never wait more than a few seconds on storage.
    setTimeout(() => done(null), 4000);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => done(req.result);
      req.onerror   = () => done(null);
      req.onblocked = () => done(null);
    } catch (_) {
      done(null);
    }
  });
}

async function getModelFromDB(db) {
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(MODEL_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

// Free the previous build's cached model so upgrading doesn't leave ~26MB
// of dead weight in the user's browser storage.
async function purgeOldModels(db) {
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result || []) if (k !== MODEL_KEY) store.delete(k);
        resolve();
      };
      req.onerror = () => resolve();
    } catch (_) { resolve(); }
  });
}

async function saveModelToDB(db, buffer) {
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(buffer, MODEL_KEY);
      req.onsuccess = () => resolve();
      req.onerror   = () => resolve();   // caching is best-effort
    } catch (_) { resolve(); }
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
  await purgeOldModels(db);
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

// Hand the main thread a turn between tiles so progress paints and Cancel
// stays responsive.
//
// Deliberately NOT setTimeout: browsers clamp timers to ~1s once a tab is
// backgrounded, so switching away mid-scan added a second of dead time per
// tile and a long scan slowed to a crawl. A MessageChannel message is a
// macrotask that is not subject to that clamp.
const _yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
function yieldToUI() {
  if (!_yieldChannel) return new Promise(r => setTimeout(r, 0));
  return new Promise(resolve => {
    _yieldChannel.port1.onmessage = () => resolve();
    _yieldChannel.port2.postMessage(0);
  });
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
export async function detectPipes(img, mode, onProgress, cancelToken, opts = {}) {
  if (!_session) throw new Error('Model not loaded');

  const highRes      = mode === 'high';
  const maxSide      = highRes ? MAX_HIGH_SIDE : MAX_STANDARD_SIDE;
  const strideMult   = highRes ? HIGH_RES_STRIDE_MULT : STANDARD_STRIDE_MULT;
  const maxTiles     = highRes ? MAX_TILES_HIGH : MAX_TILES_STANDARD;
  const enhance      = !!opts.enhance;

  // ── Pre-scale ──────────────────────────────────────────────────────────────
  // Contrast normalisation happens per tile inside runTile, not here — see
  // the comment there for why a global stretch cannot help a locally pale
  // region of an otherwise well-exposed photo.
  const { canvas, ww, wh } = prescale(img, maxSide);

  // ── Pass 1: probe for pipe size ────────────────────────────────────────────
  // A fixed tile size is the wrong thing to commit to before knowing how big
  // the pipes are. A couple of coarse tiles are enough to measure that: even
  // at low confidence the predicted box dimensions are accurate, it is only
  // the score that suffers when objects are small.
  const probeTile    = Math.min(STANDARD_TILE_SIZE, Math.max(ww, wh));
  const probeRegions = buildTileRegions(ww, wh, probeTile, 0.95);
  const probeBoxes   = [];
  for (let i = 0; i < probeRegions.length; i++) {
    if (cancelToken?.cancelled) throw new Error('cancelled');
    probeBoxes.push(...await runTile(_session, canvas, probeRegions[i], enhance));
    onProgress?.(Math.round(((i + 1) / probeRegions.length) * 12));
    await yieldToUI();
  }

  let tileSize = STANDARD_TILE_SIZE;
  const diam = probeBoxes
    .filter(b => b.conf >= PROBE_CONF)
    .map(b => Math.min(b.x2 - b.x1, b.y2 - b.y1))
    .sort((a, b) => a - b);
  if (diam.length >= 5) {
    const median = diam[Math.floor(diam.length / 2)];
    // Tile T is squeezed into INPUT_SIZE, so an object of size D appears at
    // D * INPUT_SIZE / T. Solve for the tile that puts it on TARGET_OBJ_PX.
    tileSize = clamp(Math.round(median * INPUT_SIZE / TARGET_OBJ_PX), MIN_TILE, MAX_TILE);
    // Small tiles on a big photo explode the tile count; back off until the
    // scan is a sane length, trading some accuracy for finishing at all.
    while (tileSize < MAX_TILE &&
           buildTileRegions(ww, wh, tileSize, strideMult).length > maxTiles) {
      tileSize = Math.round(tileSize * 1.25);
    }
  }

  // ── Pass 2: detect at the chosen scale ─────────────────────────────────────
  const regions  = buildTileRegions(ww, wh, tileSize, strideMult);
  const allBoxes = [];

  for (let i = 0; i < regions.length; i++) {
    if (cancelToken?.cancelled) throw new Error('cancelled');
    const boxes = await runTile(_session, canvas, regions[i], enhance);
    allBoxes.push(...boxes);
    onProgress?.(12 + Math.round(((i + 1) / regions.length) * 80));
    // Yield to the UI thread so progress paints and the app stays responsive
    await yieldToUI();
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
      // Inscribed circle of the box. sqrt(bw*bh) (the geometric mean) runs
      // larger than the pipe whenever the box isn't square, which drew the
      // ring around the pipe instead of on it.
      radius:     (Math.min(bw, bh) / 2 / ww) * 100,
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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
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

// Reusable offscreen canvas for letterboxing each tile to 640x640.
let _tileCanvas = null, _tileCtx = null;
function getTileCtx() {
  if (!_tileCanvas) {
    _tileCanvas = document.createElement('canvas');
    _tileCanvas.width  = INPUT_SIZE;
    _tileCanvas.height = INPUT_SIZE;
    _tileCtx = _tileCanvas.getContext('2d', { willReadFrequently: true });
  }
  return _tileCtx;
}

const CLAHE_GRID = 8;
const CLAHE_CLIP = 2.5;

/**
 * CLAHE — Contrast Limited Adaptive Histogram Equalisation — over one
 * sub-rectangle of an ImageData.
 *
 * A single stretch across a whole image, or even a whole 1280px tile, cannot
 * help here: a photo with a sunlit wall on one side and dark pipe openings on
 * the other already has a full tonal range, so any global measure says
 * "well exposed" and does nothing, while the pale pipes stay invisible.
 * Measured on exactly that layout: pale side 0/68 with a per-tile stretch.
 *
 * CLAHE equalises within a grid of small cells and interpolates between them,
 * so a washed-out patch is lifted regardless of how bright the rest of the
 * frame is. The clip limit stops flat areas turning into amplified noise.
 *
 * Luminance only, with one shared gain applied to R, G and B — equalising
 * channels independently rebalances colour and breaks a model tuned to the
 * blue of PVC pipe (measured 80/88 -> 9/88 when done per-channel).
 */
function claheRegion(imgData, x0, y0, w, h) {
  const p = imgData.data, W = imgData.width;
  const N = CLAHE_GRID;
  if (w < N * 4 || h < N * 4) return;

  const cw = Math.ceil(w / N), ch = Math.ceil(h / N);
  const maps = new Array(N * N);

  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const sx = x0 + gx * cw, sy = y0 + gy * ch;
      const ex = Math.min(sx + cw, x0 + w), ey = Math.min(sy + ch, y0 + h);
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = sy; y < ey; y++) {
        let i = (y * W + sx) * 4;
        for (let x = sx; x < ex; x++, i += 4) {
          hist[(p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0]++;
          n++;
        }
      }
      // Linear percentile stretch per cell, NOT histogram equalisation.
      // Equalisation's clip limit caps the achievable gain, and on a
      // washed-out patch it recovered nothing (0/88) where a plain linear
      // stretch of the same region recovered 26/88. Linear it is.
      const map = new Uint8Array(256);
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
      const span = hi - lo;
      // Only lift cells that contain NO genuinely dark tone (lo is already
      // bright). That is exactly the signature of a washed-out pipe end: a
      // properly exposed one always has a dark opening, and touching those
      // cost real detections — dark side fell 68/68 to 57/68 before this
      // gate, while the pale side still recovers fully with it.
      if (span < 4 || span >= 170 || lo < 90) {
        for (let v = 0; v < 256; v++) map[v] = v;   // identity: leave alone
      } else {
        const gain = 235 / span;
        for (let v = 0; v < 256; v++) map[v] = Math.min(255, Math.max(0, (v - lo) * gain)) | 0;
      }
      maps[gy * N + gx] = map;
    }
  }

  // Bilinear blend between neighbouring cell mappings to avoid block seams.
  for (let y = 0; y < h; y++) {
    const fy = y / ch - 0.5;
    let gy0 = Math.floor(fy);
    const wy = fy - gy0;
    gy0 = Math.max(0, Math.min(N - 1, gy0));
    const gy1 = Math.max(0, Math.min(N - 1, gy0 + 1));
    let i = ((y0 + y) * W + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const fx = x / cw - 0.5;
      let gx0 = Math.floor(fx);
      const wx = fx - gx0;
      gx0 = Math.max(0, Math.min(N - 1, gx0));
      const gx1 = Math.max(0, Math.min(N - 1, gx0 + 1));
      const L = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
      const top = maps[gy0 * N + gx0][L] + (maps[gy0 * N + gx1][L] - maps[gy0 * N + gx0][L]) * wx;
      const bot = maps[gy1 * N + gx0][L] + (maps[gy1 * N + gx1][L] - maps[gy1 * N + gx0][L]) * wx;
      const Ln  = top + (bot - top) * wy;
      const g   = L > 4 ? Ln / L : 1;
      p[i]     = Math.min(255, p[i]     * g);
      p[i + 1] = Math.min(255, p[i + 1] * g);
      p[i + 2] = Math.min(255, p[i + 2] * g);
    }
  }
}

async function runTile(session, srcCanvas, region, enhance) {
  const { x, y, w, h } = region;
  const scale = Math.min(INPUT_SIZE / w, INPUT_SIZE / h);
  const rsW   = Math.max(1, Math.round(w * scale));
  const rsH   = Math.max(1, Math.round(h * scale));
  const padL  = Math.floor((INPUT_SIZE - rsW) / 2);
  const padT  = Math.floor((INPUT_SIZE - rsH) / 2);

  // Letterbox the tile onto a 640x640 grey canvas. drawImage does proper
  // smooth (bilinear-ish) resampling — the old hand-rolled nearest-neighbour
  // loop aliased away small pipes, which is why they went undetected.
  const ctx = getTileCtx();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#727272';                       // 114,114,114 letterbox grey
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(srcCanvas, x, y, w, h, padL, padT, rsW, rsH);

  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  // Normalise contrast per TILE, not per image. A whole photo containing both
  // a bright wall and dark pipe openings already has a wide tonal range, so a
  // global stretch is a no-op and pale pipes stay invisible. Judged tile by
  // tile, a patch containing only washed-out pipes is correctly identified as
  // flat and stretched. Only the real image area is measured, never the
  // letterbox padding, which would otherwise skew the percentiles.
  if (enhance) claheRegion(imgData, padL, padT, rsW, rsH);
  const px        = imgData.data;
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  const input     = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    const s = i * 4;
    input[i]                 = px[s]     / 255; // R
    input[planeSize + i]     = px[s + 1] / 255; // G
    input[planeSize * 2 + i] = px[s + 2] / 255; // B
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds  = { [session.inputNames[0]]: tensor };
  const out    = await session.run(feeds);
  const ov     = out[session.outputNames[0]];
  const boxes  = decodeOutput(ov.data, ov.dims, w, h, scale, padL, padT);

  // Translate to full-image coordinates
  return dedupeByCentre(nms(boxes, IOU_THRESHOLD)).map(b => ({
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

// Centre-distance de-duplication.
//
// IoU is the wrong similarity measure for pipe ends. Two boxes on the SAME
// pipe, offset by half a radius because they came from differently-aligned
// tiles, score only ~0.35 IoU and ~0.6 intersection-over-smaller, so they slip
// past both gates and get drawn as two circles on one pipe. High-Res makes it
// worse because its 40% tile overlap detects each pipe several times.
//
// Centre distance is exact here: real pipe ends cannot overlap, so two
// distinct ends always have centres at least r1+r2 apart, and r1+r2 is always
// greater than CENTRE_DEDUP_FRAC * max(r1,r2). Anything closer than that
// therefore cannot be two different pipes.
function dedupeByCentre(boxes) {
  const kept = [];
  for (const b of boxes.slice().sort((a, b2) => b2.conf - a.conf)) {
    const bx = (b.x1 + b.x2) / 2, by = (b.y1 + b.y2) / 2;
    const br = Math.min(b.x2 - b.x1, b.y2 - b.y1) / 2;
    let dup = false;
    for (const k of kept) {
      const kx = (k.x1 + k.x2) / 2, ky = (k.y1 + k.y2) / 2;
      const kr = Math.min(k.x2 - k.x1, k.y2 - k.y1) / 2;
      if (Math.hypot(bx - kx, by - ky) < CENTRE_DEDUP_FRAC * (br + kr)) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(b);
  }
  return kept;
}

function mergeDetections(boxes) {
  // Remove duplicates across tiles.
  //
  // Ordered by CONFIDENCE, not area. Sorting by area meant the biggest box
  // won every overlap, so a large sloppy low-scoring box would suppress the
  // tight accurate one covering the same pipe — circles ended up drawn
  // larger than the pipe they sit on. Keeping the most confident box first
  // is both standard NMS behaviour and visibly tighter.
  // Centre distance handles both cases IoU could not: offset duplicates of
  // one pipe, and small spurious detections sitting inside a large pipe.
  return dedupeByCentre(boxes);
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
