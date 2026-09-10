// Pipe size classification — ported from the React Native app.
// Uses k-means clustering on log(radius) to classify pipes as
// small / medium / large relative to each other within the same image.

const SIZE_NAMES = ['small', 'medium', 'large'];

export function classifyRelativeSizes(pipes) {
  if (!pipes.length) return [];
  const values = pipes.map(pipe => Math.log(Math.max(pipe.radius || 0.1, 0.1)));
  const spread = Math.exp(Math.max(...values) - Math.min(...values));
  if (spread < 1.45 || pipes.length < 3) return pipes.map(() => 'medium');

  const clusterCount = spread >= 2.4 && pipes.length >= 6 ? 3 : 2;
  let centers = clusterCount === 3
    ? [Math.min(...values), values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)], Math.max(...values)]
    : [Math.min(...values), Math.max(...values)];

  for (let pass = 0; pass < 8; pass++) {
    const groups = centers.map(() => []);
    values.forEach(value => {
      let nearest = 0;
      for (let i = 1; i < centers.length; i++) {
        if (Math.abs(value - centers[i]) < Math.abs(value - centers[nearest])) nearest = i;
      }
      groups[nearest].push(value);
    });
    centers = centers.map((center, i) => groups[i].length
      ? groups[i].reduce((sum, v) => sum + v, 0) / groups[i].length
      : center);
  }

  const ordered = centers.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c);
  const names = clusterCount === 3 ? SIZE_NAMES : ['small', 'large'];
  const nameByIndex = Object.fromEntries(ordered.map((item, rank) => [item.i, names[rank]]));
  const classified = values.map(value => {
    let nearest = 0;
    for (let i = 1; i < centers.length; i++) {
      if (Math.abs(value - centers[i]) < Math.abs(value - centers[nearest])) nearest = i;
    }
    return nameByIndex[nearest];
  });

  // Pipes whose radii differ by less than 10% get the same size label.
  const orderedPipes = pipes
    .map((pipe, index) => ({ index, radius: Math.max(pipe.radius || 0.1, 0.1) }))
    .sort((a, b) => a.radius - b.radius);
  let anchor = orderedPipes[0];
  for (let i = 1; i < orderedPipes.length; i++) {
    const cur = orderedPipes[i];
    if ((cur.radius - anchor.radius) / anchor.radius < 0.1) {
      classified[cur.index] = classified[anchor.index];
    } else {
      anchor = cur;
    }
  }
  return classified;
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
