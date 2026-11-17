// Scaffold model: a rectangular grid of standards (legs) joined by ledgers and
// braces, with a planked working deck. Produces (a) geometry for the 3D view and
// (b) a per-leg load takeoff that keeps DEAD and LIVE separate so they can be
// imported into the beam analysis independently.
//
// LOAD PATH (preliminary, tributary-area method — documented, not a code check):
//   Dead per leg = its full standard self-weight
//                + half of every ledger/brace framing into it
//                + tributary plank self-weight.
//   Live per leg = tributary deck area × live load (lb/ft²).
// Tributary deck area uses the standard quarter-bay rule: each leg carries a
// quarter of every bay cell it touches, so the legs' tributary areas sum exactly
// to the planked footprint. This is an approximation suitable for preliminary
// leg-reaction estimates, not a rigid-frame distribution.

import { tubeWeightPerFoot, resolveComponents, DEFAULT_LIVE_LOAD_PSF } from './catalog.js';

function gridLines(bays, origin) {
  const lines = [origin];
  for (const w of bays) {
    if (!Number.isFinite(w) || w <= 0) throw new Error('Every bay length must be a positive number of feet.');
    lines.push(lines[lines.length - 1] + w);
  }
  return lines;
}

// Half-bay tributary extent for the leg line at index `i` given the bay widths.
function tributaryExtent(bays, i) {
  const left = i > 0 ? bays[i - 1] / 2 : 0;
  const right = i < bays.length ? bays[i] / 2 : 0;
  return left + right;
}

export function buildScaffold(config = {}) {
  const baysX = config.baysX ?? [7, 7];
  const baysY = config.baysY ?? [7];
  const liftHeightFt = config.liftHeightFt ?? 6.5;
  const lifts = config.lifts ?? 3;
  const originX = config.originX ?? 0;
  const originY = config.originY ?? 0;
  const baseZ = config.baseZ ?? 0;
  const bracedFaces = config.bracedFaces ?? 'perimeter';
  const components = resolveComponents(config.components);
  const liveLoadPsf = config.liveLoadPsf ?? DEFAULT_LIVE_LOAD_PSF;

  if (!Array.isArray(baysX) || baysX.length < 1) throw new Error('A scaffold needs at least one bay in X.');
  if (!Array.isArray(baysY) || baysY.length < 1) throw new Error('A scaffold needs at least one bay in Y.');
  if (!Number.isFinite(liftHeightFt) || liftHeightFt <= 0) throw new Error('Lift height must be positive.');
  if (!Number.isInteger(lifts) || lifts < 1) throw new Error('A scaffold needs at least one lift.');
  if (!Number.isFinite(liveLoadPsf) || liveLoadPsf < 0) throw new Error('Live load (psf) must be finite and nonnegative.');

  const xs = gridLines(baysX, originX);
  const ys = gridLines(baysY, originY);
  const nx = xs.length; // leg lines in X
  const ny = ys.length; // leg lines in Y
  const heightFt = liftHeightFt * lifts;
  const topZ = baseZ + heightFt;

  // Planked levels: 1-based lift tops that carry a deck. Default = top level only.
  const plankedLevels = Array.isArray(config.plankedLevels) && config.plankedLevels.length
    ? config.plankedLevels.filter(l => Number.isInteger(l) && l >= 1 && l <= lifts)
    : [lifts];
  const nPlankedLevels = plankedLevels.length;

  const perFootStandard = tubeWeightPerFoot(components.standard);
  const perFootLedger = tubeWeightPerFoot(components.ledger);
  const perFootBrace = tubeWeightPerFoot(components.brace);
  const plankAreaWeight = components.plank.areaWeightLbPerFt2;

  // --- Legs (standards) -----------------------------------------------------
  const legs = [];
  const legIndex = new Map(); // "ix,iy" -> leg
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const leg = {
        id: `L${ix}-${iy}`,
        ix, iy,
        x: xs[ix],
        y: ys[iy],
        baseZ,
        topZ,
        heightFt,
        deadLb: perFootStandard * heightFt, // own standard self-weight
        liveLb: 0,
      };
      legs.push(leg);
      legIndex.set(`${ix},${iy}`, leg);
    }
  }
  const legAt = (ix, iy) => legIndex.get(`${ix},${iy}`);

  // --- Ledgers (horizontal tubes), at each lift level above the base --------
  const ledgers = [];
  const nLedgerLevels = lifts; // levels 1..lifts
  for (let level = 1; level <= lifts; level++) {
    const z = baseZ + level * liftHeightFt;
    // X-direction ledgers
    for (let iy = 0; iy < ny; iy++) {
      for (let b = 0; b < baysX.length; b++) {
        const a = legAt(b, iy), c = legAt(b + 1, iy);
        const lengthFt = baysX[b];
        const w = perFootLedger * lengthFt;
        a.deadLb += w / 2; c.deadLb += w / 2;
        ledgers.push({ z, a: [a.x, a.y, z], b: [c.x, c.y, z], lengthFt, axis: 'x' });
      }
    }
    // Y-direction ledgers
    for (let ix = 0; ix < nx; ix++) {
      for (let b = 0; b < baysY.length; b++) {
        const a = legAt(ix, b), c = legAt(ix, b + 1);
        const lengthFt = baysY[b];
        const w = perFootLedger * lengthFt;
        a.deadLb += w / 2; c.deadLb += w / 2;
        ledgers.push({ z, a: [a.x, a.y, z], b: [c.x, c.y, z], lengthFt, axis: 'y' });
      }
    }
  }

  // --- Braces (diagonal tubes) on vertical faces ----------------------------
  const braces = [];
  const faceBays = collectBracedFaces(bracedFaces, baysX, baysY, nx, ny);
  for (const face of faceBays) {
    const legA = legAt(face.a[0], face.a[1]);
    const legB = legAt(face.b[0], face.b[1]);
    const spanFt = face.axis === 'x' ? baysX[face.bay] : baysY[face.bay];
    const lengthFt = Math.hypot(spanFt, liftHeightFt);
    for (let lift = 0; lift < lifts; lift++) {
      const zLow = baseZ + lift * liftHeightFt;
      const zHigh = zLow + liftHeightFt;
      const w = perFootBrace * lengthFt;
      legA.deadLb += w / 2; legB.deadLb += w / 2;
      braces.push({ a: [legA.x, legA.y, zLow], b: [legB.x, legB.y, zHigh], lengthFt });
    }
  }

  // --- Planked deck: dead + live distributed by tributary area --------------
  const planks = [];
  let deckAreaFt2 = 0;
  for (const level of plankedLevels) {
    const z = baseZ + level * liftHeightFt;
    planks.push({ level, z, x0: xs[0], y0: ys[0], x1: xs[nx - 1], y1: ys[ny - 1] });
  }
  for (const leg of legs) {
    const tribX = tributaryExtent(baysX, leg.ix);
    const tribY = tributaryExtent(baysY, leg.iy);
    const tribAreaFt2 = tribX * tribY;
    deckAreaFt2 += tribAreaFt2; // accumulates to footprint (×1 level)
    leg.deadLb += tribAreaFt2 * plankAreaWeight * nPlankedLevels;
    leg.liveLb += tribAreaFt2 * liveLoadPsf * nPlankedLevels;
  }

  const totals = legs.reduce(
    (acc, leg) => ({ deadLb: acc.deadLb + leg.deadLb, liveLb: acc.liveLb + leg.liveLb }),
    { deadLb: 0, liveLb: 0 },
  );

  return {
    legs, ledgers, braces, planks,
    xs, ys, nx, ny, heightFt, baseZ, topZ,
    footprintFt2: deckAreaFt2,
    totals,
    config: { baysX, baysY, liftHeightFt, lifts, originX, originY, baseZ, bracedFaces, components, liveLoadPsf, plankedLevels },
  };
}

function collectBracedFaces(mode, baysX, baysY, nx, ny) {
  if (mode === 'none') return [];
  const faces = [];
  const addXFace = (iy) => { for (let b = 0; b < baysX.length; b++) faces.push({ axis: 'x', bay: b, a: [b, iy], b: [b + 1, iy] }); };
  const addYFace = (ix) => { for (let b = 0; b < baysY.length; b++) faces.push({ axis: 'y', bay: b, a: [ix, b], b: [ix, b + 1] }); };
  if (mode === 'all') {
    for (let iy = 0; iy < ny; iy++) addXFace(iy);
    for (let ix = 0; ix < nx; ix++) addYFace(ix);
    return faces;
  }
  // 'perimeter' (default)
  addXFace(0);
  if (ny > 1) addXFace(ny - 1);
  addYFace(0);
  if (nx > 1) addYFace(nx - 1);
  return faces;
}
