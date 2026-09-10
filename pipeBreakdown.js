// Pipe size classification.
//
// Groups pipes as small / medium / large *relative to each other* within the
// same image.
//
// The hard part is not clustering — it is deciding whether more than one size
// is present at all. k-means always returns however many clusters you ask for,
// so running it on a single pipe size whose detected radii merely scatter a
// lot will happily cut that one population in half and paint it two colours.
// Detection noise on a difficult photo reaches 25-30% CV, which is wide enough
// to defeat any fixed spread threshold.
//
// So we first look for genuine MODES: peaks in the radius distribution that
// are separated by a real valley. One mode means one size, whatever the
// spread. Only when a true valley exists do we split.

const SIZE_NAMES = ['small', 'medium', 'large'];

// Fewer pipes than this can't support a distribution test.
const MIN_PIPES_TO_SPLIT = 8;
// The dip between two peaks must fall below this fraction of the smaller peak
// for them to count as separate sizes.
const VALLEY_RATIO = 0.60;
// Ignore bumps shorter than this fraction of the tallest peak.
const MIN_PEAK_HEIGHT = 0.15;
// Two modes closer together than this ratio are the same size in practice.
const MIN_MODE_SEPARATION = 1.25;

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const i  = (sortedAsc.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

export function classifyRelativeSizes(pipes) {
  if (!pipes.length) return [];
  if (pipes.length < MIN_PIPES_TO_SPLIT) return pipes.map(() => 'medium');

  const values = pipes.map(p => Math.log(Math.max(p.radius || 0.1, 0.1)));
  const sorted = [...values].sort((a, b) => a - b);

  // Histogram over a trimmed range so a couple of stray detections can't
  // stretch the axis and flatten the real structure into one bin.
  const lo = percentile(sorted, 0.02);
  const hi = percentile(sorted, 0.98);
  if (!(hi > lo)) return pipes.map(() => 'medium');

  const bins  = Math.max(8, Math.min(22, Math.round(Math.sqrt(pipes.length))));
  const width = (hi - lo) / bins;
  const hist  = new Array(bins).fill(0);
  for (const v of values) {
    const b = Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / width)));
    hist[b]++;
  }

  // Smooth so sampling noise doesn't manufacture peaks.
  const sm = hist.map((_, i) => {
    let sum = 0, wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= bins) continue;
      const w = [1, 2, 3, 2, 1][k + 2];
      sum += hist[j] * w; wsum += w;
    }
    return sum / wsum;
  });

  const centres = findModes(sm, lo, width);
  if (centres.length <= 1) return pipes.map(() => 'medium');

  const names = centres.length >= 3 ? SIZE_NAMES : ['small', 'large'];
  return values.map(v => names[nearestIndex(centres, v)]);
}

// Peaks separated by a genuine valley. Returns their positions in log space.
function findModes(sm, lo, width) {
  const bins = sm.length;
  const peaks = [];
  for (let i = 0; i < bins; i++) {
    const l = i > 0 ? sm[i - 1] : -Infinity;
    const r = i < bins - 1 ? sm[i + 1] : -Infinity;
    if (sm[i] >= l && sm[i] >= r && sm[i] > 0) peaks.push(i);
  }
  if (!peaks.length) return [];

  const tallest = Math.max(...peaks.map(i => sm[i]));
  const ranked  = peaks
    .filter(i => sm[i] >= MIN_PEAK_HEIGHT * tallest)
    .sort((a, b) => sm[b] - sm[a]);

  const accepted = [];
  for (const cand of ranked) {
    const distinct = accepted.every(acc => {
      const [a, b] = cand < acc ? [cand, acc] : [acc, cand];
      let valley = Infinity;
      for (let j = a; j <= b; j++) valley = Math.min(valley, sm[j]);
      return valley < VALLEY_RATIO * Math.min(sm[cand], sm[acc]);
    });
    if (distinct) accepted.push(cand);
    if (accepted.length === 3) break;
  }

  let centres = accepted
    .sort((a, b) => a - b)
    .map(i => lo + (i + 0.5) * width);

  // Collapse modes that are too close to be different pipe sizes.
  const out = [];
  for (const c of centres) {
    const prev = out[out.length - 1];
    if (prev != null && Math.exp(c - prev) < MIN_MODE_SEPARATION) {
      out[out.length - 1] = (prev + c) / 2;
    } else {
      out.push(c);
    }
  }
  return out;
}

function nearestIndex(centres, v) {
  let best = 0;
  for (let i = 1; i < centres.length; i++) {
    if (Math.abs(v - centres[i]) < Math.abs(v - centres[best])) best = i;
  }
  return best;
}

export function applyRelativeSizes(pipes) {
  const inferred = classifyRelativeSizes(pipes);
  return pipes.map((pipe, i) => ({
    ...pipe,
    sizeCategory: pipe.manualSize || pipe.sizeLocked ? pipe.sizeCategory : inferred[i],
  }));
}

export function buildSizeBreakdown(pipes) {
  const sized = applyRelativeSizes(pipes);
  return ['small', 'medium', 'large'].map(size => ({
    size,
    count: sized.filter(p => p.sizeCategory === size).length,
  }));
}
