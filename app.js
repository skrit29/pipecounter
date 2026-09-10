// app.js — PipeCounter web app
import { loadModel, detectPipes } from './detector.js';
import { applyRelativeSizes, buildSizeBreakdown } from './pipeBreakdown.js';

const MODEL_URL = './assets/models/pipe-counter-int8.onnx';

const SIZE_COLORS = { small: '#FF7A00', medium: '#FFD60A', large: '#39FF14' };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const pickBtn      = document.getElementById('pick-btn');
const fileInput    = document.getElementById('file-input');
const preview      = document.getElementById('preview');
const modeStd      = document.getElementById('mode-std');
const modeHigh     = document.getElementById('mode-high');
const scanBtn      = document.getElementById('scan-btn');
const progressWrap = document.getElementById('progress-wrap');
const progressBar  = document.getElementById('progress-bar');
const progressLbl  = document.getElementById('progress-lbl');
const resultSec    = document.getElementById('result-section');
const countLbl     = document.getElementById('count-lbl');
const canvas       = document.getElementById('overlay');
const breakdownEl  = document.getElementById('breakdown');
const resetBtn     = document.getElementById('reset-btn');

let   selectedFile = null;
let   cancelToken  = { cancelled: false };
let   wakeLock     = null;

// ── Service Worker ─────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── Model pre-load ─────────────────────────────────────────────────────────────
// Begin loading the model immediately so it's ready when the user hits Scan.
let modelReady = false;
(async () => {
  try {
    await loadModel(MODEL_URL, pct => {
      if (pct < 100) setStatus(`Loading AI model… ${pct}%`);
    });
    modelReady = true;
    setStatus('Ready — tap "Pick Image" to start');
  } catch (e) {
    setStatus('Model failed to load. Check your connection and reload.', true);
  }
})();

// ── Image selection ────────────────────────────────────────────────────────────
pickBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  selectedFile = file;
  const url = URL.createObjectURL(file);
  preview.src = url;
  preview.hidden = false;
  scanBtn.disabled = false;
  resultSec.hidden = true;
  clearCanvas();
  setStatus('Image selected — choose resolution then tap Scan');
});

// ── Scan ───────────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  if (!selectedFile || !modelReady) return;
  cancelToken = { cancelled: false };

  scanBtn.disabled = true;
  pickBtn.disabled = true;
  resultSec.hidden = true;
  clearCanvas();

  // Request wake lock so the screen stays on during the scan.
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}

  showProgress(true);
  setProgress(0, 'Starting scan…');

  try {
    const mode = modeHigh.checked ? 'high' : 'standard';
    const img  = await loadImage(URL.createObjectURL(selectedFile));

    const rawPipes = await detectPipes(img, mode, pct => {
      setProgress(pct, `Scanning… ${pct}%`);
    }, cancelToken);

    setProgress(100, 'Drawing results…');
    const pipes = applyRelativeSizes(rawPipes);
    showResults(img, pipes);
  } catch (err) {
    if (err.message === 'cancelled') {
      setStatus('Scan cancelled');
    } else {
      setStatus('Scan failed: ' + err.message, true);
      console.error(err);
    }
  } finally {
    showProgress(false);
    scanBtn.disabled = false;
    pickBtn.disabled = false;
    try { await wakeLock?.release(); } catch (_) {}
    wakeLock = null;
  }
});

// ── Results ────────────────────────────────────────────────────────────────────
function showResults(img, pipes) {
  // Resize canvas to match the displayed image.
  const rect = preview.getBoundingClientRect();
  canvas.width  = rect.width;
  canvas.height = rect.height;
  canvas.hidden = false;

  const ctx = canvas.getContext('2d');
  pipes.forEach(pipe => {
    const px = (pipe.x / 100) * canvas.width;
    const py = (pipe.y / 100) * canvas.height;
    const pr = (pipe.radius / 100) * canvas.width;
    const color = SIZE_COLORS[pipe.sizeCategory] || SIZE_COLORS.medium;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(pr, 4), 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = Math.max(2, pr * 0.15);
    ctx.stroke();
  });

  countLbl.textContent = pipes.length;
  showBreakdown(pipes);
  resultSec.hidden = false;
  setStatus('');
  resultSec.scrollIntoView({ behavior: 'smooth' });
}

function showBreakdown(pipes) {
  const bd = buildSizeBreakdown(pipes);
  breakdownEl.innerHTML = bd
    .filter(b => b.count > 0)
    .map(b => `
      <div class="bd-row">
        <span class="bd-dot" style="background:${SIZE_COLORS[b.size]}"></span>
        <span class="bd-label">${cap(b.size)}</span>
        <span class="bd-count">${b.count}</span>
      </div>`)
    .join('') || '<div class="bd-row">No pipes detected</div>';
}

// ── Reset ──────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  cancelToken.cancelled = true;
  selectedFile = null;
  fileInput.value = '';
  preview.src = '';
  preview.hidden = true;
  canvas.hidden = true;
  scanBtn.disabled = true;
  resultSec.hidden = true;
  clearCanvas();
  setStatus('Ready — tap "Pick Image" to start');
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img  = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function clearCanvas() {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = true;
}

function showProgress(show) {
  progressWrap.hidden = !show;
}

function setProgress(pct, label) {
  progressBar.style.width = pct + '%';
  progressBar.setAttribute('aria-valuenow', pct);
  progressLbl.textContent = label;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = 'status' + (isError ? ' error' : '');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
