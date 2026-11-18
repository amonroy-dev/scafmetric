// Diagonal brace placement on bay FACES.
//
// Ported from ScaffoldPro's PlaceDiagonalTool.tsx. A brace is not picked by
// clicking a node: the tool builds a graph of vertical FACES (pairs of adjacent
// standards), you hover a face, and the lift pair whose midpoint is nearest the
// cursor height is the one that gets braced. SHIFT fills every perimeter face
// at that height.
//
// Pure math (no three.js, no DOM) so it is unit-testable; the ray/plane
// intersection itself lives in the tool layer.

export const MIN_SPAN_FT = 1.5;
export const MAX_SPAN_FT = 11.0;
// Braces sit just outside the face so they do not clash with the standards.
export const PERP_OFFSET_FT = 2.364 / 12;
// Reject a pair (A,B) when a third standard C lies between them, closer to the
// line AB than 55% of the span — this is what stops cross-bay diagonals.
export const ADJACENT_SPAN_FRAC = 0.55;
// How far to look for a parallel face when deciding perimeter vs interior.
export const PERIMETER_PERP_SEARCH = MAX_SPAN_FT * 1.2;
export const MAX_BATCH_BRACES = 128;
// A diagonal climbs four rosette levels.
export const BRACE_DELTA_LIFT = 4;

export const FACE_FILTERS = ['all', 'front', 'back', 'left', 'right'];
export const BRACE_DIRECTIONS = ['ascending', 'descending'];

/**
 * Faces between adjacent standards, normalised so each face normal points AWAY
 * from the footprint centroid. That keeps "ascending" visually consistent on
 * every face, however the scaffold is rotated. `centroid` overrides the
 * columns' own, for faces that must face away from the whole scaffold.
 */
export function buildFaceGraph(standards, centroid = null) {
  const cols = [...standards];
  if (cols.length < 2) return [];

  let sumX = 0, sumY = 0;
  for (const s of cols) { sumX += s.x; sumY += s.y; }
  const cx = centroid ? centroid.x : sumX / cols.length;
  const cy = centroid ? centroid.y : sumY / cols.length;

  const out = [];
  const seen = new Set();

  for (const sA of cols) {
    for (const sB of cols) {
      if (sA.id === sB.id) continue;
      const key = sA.id < sB.id ? `${sA.id}|${sB.id}` : `${sB.id}|${sA.id}`;
      if (seen.has(key)) continue;

      const dx = sB.x - sA.x;
      const dy = sB.y - sA.y;
      const span = Math.hypot(dx, dy);
      if (span < MIN_SPAN_FT || span > MAX_SPAN_FT) continue;
      seen.add(key);

      const dirX = dx / span;
      const dirY = dy / span;

      let blocked = false;
      for (const sC of cols) {
        if (sC.id === sA.id || sC.id === sB.id) continue;
        const ex = sC.x - sA.x;
        const ey = sC.y - sA.y;
        const t = ex * dirX + ey * dirY;
        if (t <= 0 || t >= span) continue;
        const perp = Math.abs(ex * -dirY + ey * dirX);
        if (perp < span * ADJACENT_SPAN_FRAC) { blocked = true; break; }
      }
      if (blocked) continue;

      const midX = (sA.x + sB.x) * 0.5;
      const midY = (sA.y + sB.y) * 0.5;
      const outDot = (midX - cx) * -dirY + (midY - cy) * dirX;
      const swap = outDot < 0;

      out.push({
        columnIdA: swap ? sB.id : sA.id,
        columnIdB: swap ? sA.id : sB.id,
        ax: (swap ? sB : sA).x, ay: (swap ? sB : sA).y,
        bx: (swap ? sA : sB).x, by: (swap ? sA : sB).y,
        dirX: swap ? -dirX : dirX,
        dirY: swap ? -dirY : dirY,
        normX: swap ? dirY : -dirY,
        normY: swap ? -dirX : dirX,
        spanFt: span,
      });
    }
  }
  return out;
}

/**
 * A face is on the perimeter when it does NOT have parallel faces on both
 * sides. An interior face is sandwiched between two rows.
 */
export function isPerimeterFace(face, allFaces) {
  let hasPos = false;
  let hasNeg = false;
  for (const other of allFaces) {
    if (other.columnIdA === face.columnIdA && other.columnIdB === face.columnIdB) continue;
    if (other.columnIdA === face.columnIdB && other.columnIdB === face.columnIdA) continue;
    if (Math.abs(face.dirX * other.dirX + face.dirY * other.dirY) < 0.85) continue;
    const dmX = (other.ax + other.bx - face.ax - face.bx) * 0.5;
    const dmY = (other.ay + other.by - face.ay - face.by) * 0.5;
    const perp = dmX * face.normX + dmY * face.normY;
    if (perp > 0 && perp < PERIMETER_PERP_SEARCH) hasPos = true;
    if (perp < 0 && perp > -PERIMETER_PERP_SEARCH) hasNeg = true;
    if (hasPos && hasNeg) return false;
  }
  return true;
}

export function perimeterFaces(faces) {
  return faces.filter(f => isPerimeterFace(f, faces));
}

export function footprintCentroid(standards) {
  const cols = [...standards];
  if (!cols.length) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const s of cols) { sx += s.x; sy += s.y; }
  return { x: sx / cols.length, y: sy / cols.length };
}

/** Keep only the faces on the chosen elevation. */
export function faceMatchesFilter(face, filter, cx, cy) {
  if (!filter || filter === 'all') return true;
  const midX = (face.ax + face.bx) * 0.5;
  const midY = (face.ay + face.by) * 0.5;
  const mainlyX = Math.abs(face.dirX) > Math.abs(face.dirY);
  if (filter === 'front') return mainlyX && midY <= cy;
  if (filter === 'back') return mainlyX && midY >= cy;
  if (filter === 'left') return !mainlyX && midX <= cx;
  if (filter === 'right') return !mainlyX && midX >= cx;
  return true;
}

export function deltaLiftFor(direction) {
  return direction === 'descending' ? -BRACE_DELTA_LIFT : BRACE_DELTA_LIFT;
}

/**
 * The brace on one face whose midpoint height is nearest `cursorZ`.
 * `nodesByColumn` maps a column id to its nodes keyed by level.
 * `isTaken(face, levelA, levelB)` lets the caller skip faces already braced.
 */
export function faceBraceTarget(face, nodesByColumn, cursorZ, direction, isTaken = null, sideSign = 1) {
  const delta = deltaLiftFor(direction);
  const byA = nodesByColumn.get(face.columnIdA);
  const byB = nodesByColumn.get(face.columnIdB);
  if (!byA || !byB) return null;

  const offX = face.normX * PERP_OFFSET_FT * sideSign;
  const offY = face.normY * PERP_OFFSET_FT * sideSign;

  let best = null;
  let bestZ = Infinity;
  for (const [levelA, posA] of byA) {
    const levelB = levelA + delta;
    if (levelB < 0) continue;
    const posB = byB.get(levelB);
    if (!posB) continue;
    if (isTaken && isTaken(face, levelA, levelB)) continue;
    const midZ = (posA.z + posB.z) * 0.5;
    const zDist = Math.abs(midZ - cursorZ);
    if (zDist >= bestZ) continue;
    bestZ = zDist;
    best = {
      face,
      levelA, levelB,
      a: [posA.x + offX, posA.y + offY, posA.z],
      b: [posB.x + offX, posB.y + offY, posB.z],
      spanFt: face.spanFt,
      midZ,
    };
  }
  return best;
}

/**
 * Faces along a row of side bracket tips, so a brace can climb between the
 * tip rosettes of brackets hung at two lifts.
 *
 * Only tips of brackets facing the same way pair up, only along the row
 * (square to the brackets), and only where a brace could actually go. A row of
 * brackets at a single lift therefore adds no faces, and never stands in front
 * of the standards' own face to swallow the cursor.
 *
 * `tipColumns` is [{ id, x, y, dir }]; `byColumn` comes from nodesByColumn.
 */
export function bracketTipFaces(tipColumns, byColumn, centroid) {
  const groups = new Map();
  for (const c of tipColumns) {
    const k = Math.round(Math.atan2(c.dir[1], c.dir[0]) * 180 / Math.PI);
    let g = groups.get(k);
    if (!g) groups.set(k, g = []);
    g.push(c);
  }
  const out = [];
  for (const cols of groups.values()) {
    if (cols.length < 2) continue;
    const len = Math.hypot(cols[0].dir[0], cols[0].dir[1]) || 1;
    const ox = cols[0].dir[0] / len, oy = cols[0].dir[1] / len;
    for (const f of buildFaceGraph(cols, centroid)) {
      if (Math.abs(f.dirX * ox + f.dirY * oy) > 0.2) continue; // along the row only
      if (!faceBraceTarget(f, byColumn, 0, 'ascending') && !faceBraceTarget(f, byColumn, 0, 'descending')) continue;
      out.push({ ...f, tipRow: true });
    }
  }
  return out;
}

/** Column id -> Map(level -> node), the shape the face lookups want. */
export function nodesByColumn(nodes) {
  const map = new Map();
  for (const n of nodes) {
    let inner = map.get(n.columnId);
    if (!inner) { inner = new Map(); map.set(n.columnId, inner); }
    inner.set(n.level, n);
  }
  return map;
}

/**
 * SHIFT fill: one brace per selected perimeter face, at the height nearest
 * `targetZ`. `nthBay` places on every nth face along each direction, as the
 * source does, so you can brace alternate bays.
 */
export function planPerimeterBraces(faces, nodes, opts = {}) {
  const {
    standards = [], filter = 'all', nthBay = 1, direction = 'ascending',
    targetZ = 0, isTaken = null, max = MAX_BATCH_BRACES,
  } = opts;

  const { x: cx, y: cy } = footprintCentroid(standards);
  const byColumn = nodesByColumn(nodes);
  const stride = Math.max(1, Math.floor(nthBay) || 1);

  const ordered = list => {
    const eligible = list.filter(f => faceMatchesFilter(f, filter, cx, cy));
    const xFaces = eligible
      .filter(f => Math.abs(f.dirX) >= Math.abs(f.dirY))
      .sort((a, b) => (a.ax + a.bx) - (b.ax + b.bx))
      .filter((_, i) => i % stride === 0);
    const yFaces = eligible
      .filter(f => Math.abs(f.dirX) < Math.abs(f.dirY))
      .sort((a, b) => (a.ay + a.by) - (b.ay + b.by))
      .filter((_, i) => i % stride === 0);
    return [...xFaces, ...yFaces];
  };
  // The standards' perimeter is judged among the standards' faces alone, so a
  // row of bracket tips outside does not make the face behind it "interior".
  // Bracket rows are outside by construction and always eligible.
  const own = faces.filter(f => !f.tipRow);
  const tipRows = faces.filter(f => f.tipRow);

  const out = [];
  for (const face of [...ordered(perimeterFaces(own)), ...ordered(tipRows)]) {
    if (out.length >= max) break;
    const target = faceBraceTarget(face, byColumn, targetZ, direction, isTaken);
    if (target) out.push(target);
  }
  return out;
}

/**
 * Ray/plane pick against the face graph: which face the cursor is over, which
 * way it is facing, and the height on that face.
 *
 * `ray` is { origin:[x,y,z], direction:[x,y,z] } in world feet.
 */
export function pickFace(ray, faces, opts = {}) {
  const { filter = 'all', standards = [] } = opts;
  const { x: cx, y: cy } = footprintCentroid(standards);
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;

  let best = null;
  let bestT = Infinity;

  for (const face of faces) {
    if (!faceMatchesFilter(face, filter, cx, cy)) continue;
    // Plane through A with the face normal; vertical, so z drops out.
    const denom = dx * face.normX + dy * face.normY;
    if (Math.abs(denom) < 1e-9) continue;
    const planeD = -(face.normX * face.ax + face.normY * face.ay);
    const t = -(ox * face.normX + oy * face.normY + planeD) / denom;
    if (t <= 0 || t >= bestT) continue;

    const hx = ox + dx * t;
    const hy = oy + dy * t;
    const along = (hx - face.ax) * face.dirX + (hy - face.ay) * face.dirY;
    if (along < 0 || along > face.spanFt) continue;

    bestT = t;
    best = {
      face,
      side: denom <= 0 ? 1 : -1,
      hit: [hx, hy, oz + dz * t],
      cursorZ: oz + dz * t,
      alongFt: along,
    };
  }
  return best;
}
