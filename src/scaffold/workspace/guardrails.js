// Guardrail planning. The boundary of the union of the decked rectangles is
// computed exactly as guardrailPlanning.ts does it (grid decomposition of the
// rectangle union, then collinear merge), and rails and posts are laid along
// that boundary. Pure math — unit-testable.

import { inchesToFeet } from './parts.js';

export const TOP_RAIL_IN = 42;
export const MID_RAIL_IN = 21;
export const MAX_POST_SPACING_FT = 7;

function roundTo(v, precision = 1000) { return Math.round(v * precision) / precision; }

function uniqSorted(values, tol = 1e-9) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return [];
  const out = [v[0]];
  for (let i = 1; i < v.length; i++) {
    if (Math.abs(v[i] - out[out.length - 1]) <= tol) continue;
    out.push(v[i]);
  }
  return out;
}

function mergeCollinear(segments, mergeTol = 1e-6) {
  const buckets = new Map();
  for (const s of segments) {
    if (s.kind === 'H') {
      const y = roundTo(s.y);
      const key = `H:${y}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ kind: 'H', y, x0: Math.min(s.x0, s.x1), x1: Math.max(s.x0, s.x1) });
    } else {
      const x = roundTo(s.x);
      const key = `V:${x}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ kind: 'V', x, y0: Math.min(s.y0, s.y1), y1: Math.max(s.y0, s.y1) });
    }
  }
  const out = [];
  for (const [key, list] of buckets) {
    if (!list.length) continue;
    const horizontal = key.startsWith('H:');
    const segs = list.slice().sort((a, b) => (horizontal ? a.x0 - b.x0 : a.y0 - b.y0));
    let cur = { ...segs[0] };
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      if (horizontal) {
        if (s.x0 <= cur.x1 + mergeTol) cur.x1 = Math.max(cur.x1, s.x1);
        else { out.push(cur); cur = { ...s }; }
      } else {
        if (s.y0 <= cur.y1 + mergeTol) cur.y1 = Math.max(cur.y1, s.y1);
        else { out.push(cur); cur = { ...s }; }
      }
    }
    out.push(cur);
  }
  return out;
}

/** Boundary of the union of axis-aligned rectangles, collinear-merged. */
export function computeRectUnionBoundarySegments(rects) {
  const clean = (rects || [])
    .map(r => ({
      xMin: Math.min(r.xMin, r.xMax), xMax: Math.max(r.xMin, r.xMax),
      yMin: Math.min(r.yMin, r.yMax), yMax: Math.max(r.yMin, r.yMax),
    }))
    .filter(r => [r.xMin, r.xMax, r.yMin, r.yMax].every(Number.isFinite))
    .filter(r => r.xMax - r.xMin > 1e-9 && r.yMax - r.yMin > 1e-9);
  if (!clean.length) return [];

  const xs = uniqSorted(clean.flatMap(r => [r.xMin, r.xMax]).map(v => roundTo(v)));
  const ys = uniqSorted(clean.flatMap(r => [r.yMin, r.yMax]).map(v => roundTo(v)));
  if (xs.length < 2 || ys.length < 2) return [];

  const nx = xs.length - 1, ny = ys.length - 1;
  const filled = Array.from({ length: nx }, () => Array.from({ length: ny }, () => false));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const cx = (xs[i] + xs[i + 1]) * 0.5;
      const cy = (ys[j] + ys[j + 1]) * 0.5;
      filled[i][j] = clean.some(r =>
        cx > r.xMin + 1e-9 && cx < r.xMax - 1e-9 && cy > r.yMin + 1e-9 && cy < r.yMax - 1e-9);
    }
  }

  const segs = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!filled[i][j]) continue;
      const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
      if (i === 0 || !filled[i - 1][j]) segs.push({ kind: 'V', x: x0, y0, y1 });
      if (i === nx - 1 || !filled[i + 1][j]) segs.push({ kind: 'V', x: x1, y0, y1 });
      if (j === 0 || !filled[i][j - 1]) segs.push({ kind: 'H', y: y0, x0, x1 });
      if (j === ny - 1 || !filled[i][j + 1]) segs.push({ kind: 'H', y: y1, x0, x1 });
    }
  }
  return mergeCollinear(segs);
}

/**
 * Rails and posts for the decked area at height deckZ.
 * Returns { rails:[{a,b}], posts:[{x,y,z0,z1}], segments }.
 */
export function planGuardrails(rects, deckZ, opts = {}) {
  const topRail = inchesToFeet(opts.topRailIn ?? TOP_RAIL_IN);
  const midRail = inchesToFeet(opts.midRailIn ?? MID_RAIL_IN);
  const maxPost = opts.maxPostSpacingFt ?? MAX_POST_SPACING_FT;
  const segments = computeRectUnionBoundarySegments(rects);
  const rails = [];
  const posts = [];
  const postKeys = new Set();

  const addPost = (x, y) => {
    const key = `${roundTo(x)}:${roundTo(y)}`;
    if (postKeys.has(key)) return;
    postKeys.add(key);
    posts.push({ x, y, z0: deckZ, z1: deckZ + topRail });
  };

  for (const s of segments) {
    const horizontal = s.kind === 'H';
    const a0 = horizontal ? s.x0 : s.y0;
    const a1 = horizontal ? s.x1 : s.y1;
    const fixed = horizontal ? s.y : s.x;
    const length = a1 - a0;
    if (length <= 1e-9) continue;

    for (const h of [topRail, midRail]) {
      rails.push(horizontal
        ? { a: [a0, fixed, deckZ + h], b: [a1, fixed, deckZ + h] }
        : { a: [fixed, a0, deckZ + h], b: [fixed, a1, deckZ + h] });
    }

    const count = Math.max(1, Math.ceil(length / maxPost));
    for (let i = 0; i <= count; i++) {
      const t = a0 + (length * i) / count;
      if (horizontal) addPost(t, fixed); else addPost(fixed, t);
    }
  }
  return { rails, posts, segments };
}

/** Deck rectangles from scaffold state, grouped by deck height. */
export function deckRectsByHeight(state) {
  const byZ = new Map();
  for (const p of state.plankBays()) {
    // A stair landing has rails of its own, open where the flights come and go.
    if (p.stair) continue;
    const z = roundTo(p.z);
    if (!byZ.has(z)) byZ.set(z, []);
    byZ.get(z).push({ xMin: p.x0, xMax: p.x1, yMin: p.y0, yMax: p.y1 });
  }
  return byZ;
}
