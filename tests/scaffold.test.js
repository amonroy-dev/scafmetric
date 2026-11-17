import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tubeWeightPerFoot,
  tubeWeightLb,
  STANDARD_TUBE,
  STEEL_DENSITY_LB_FT3,
  resolveComponents,
} from '../src/scaffold/catalog.js';
import { buildScaffold } from '../src/scaffold/model.js';
import { beamFromSupports, locateLegOnBeam, mapLegsToBeam, toBeamPointLoads } from '../src/scaffold/legloads.js';

test('standard tube self-weight matches 1.9in OD x 0.12in wall + 20% at 490 lb/ft^3', () => {
  // ID = 1.9 - 2*0.12 = 1.66; A = pi/4 (1.9^2 - 1.66^2)
  const id = 1.9 - 2 * 0.12;
  const area = (Math.PI / 4) * (1.9 ** 2 - id ** 2);
  const perInch = area * (STEEL_DENSITY_LB_FT3 / 1728);
  const expected = perInch * 12 * 1.2; // +20%
  const actual = tubeWeightPerFoot(STANDARD_TUBE);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  // Sanity band: a 1.9in x 0.12in steel tube is ~2.28 lb/ft bare, ~2.74 with +20%.
  assert.ok(actual > 2.6 && actual < 2.9, `standard per-foot out of band: ${actual}`);
});

test('tubeWeightLb scales linearly with length', () => {
  const w10 = tubeWeightLb(STANDARD_TUBE, 10);
  const w5 = tubeWeightLb(STANDARD_TUBE, 5);
  assert.ok(Math.abs(w10 - 2 * w5) < 1e-9);
  assert.equal(tubeWeightLb(STANDARD_TUBE, 0), 0);
});

test('tubeWeightPerFoot rejects impossible geometry', () => {
  assert.throws(() => tubeWeightPerFoot({ outsideDiameterIn: 1, wallThicknessIn: 0.5 }));
  assert.throws(() => tubeWeightPerFoot({ outsideDiameterIn: -1, wallThicknessIn: 0.1 }));
});

test('resolveComponents fills defaults and keeps the standard settled', () => {
  const c = resolveComponents({ ledger: { wallThicknessIn: 0.1 } });
  assert.equal(c.standard.settled, true);
  assert.equal(c.ledger.wallThicknessIn, 0.1);
  assert.equal(c.ledger.outsideDiameterIn, 1.9); // default retained
  assert.equal(c.plank.settled, false);
});

test('scaffold leg loads sum to totals and tributary areas cover the footprint', () => {
  const s = buildScaffold({ baysX: [7, 7], baysY: [7], liftHeightFt: 6.5, lifts: 2, liveLoadPsf: 25 });
  assert.equal(s.legs.length, 3 * 2); // 3 x-lines, 2 y-lines
  const sumDead = s.legs.reduce((a, l) => a + l.deadLb, 0);
  const sumLive = s.legs.reduce((a, l) => a + l.liveLb, 0);
  assert.ok(Math.abs(sumDead - s.totals.deadLb) < 1e-9);
  assert.ok(Math.abs(sumLive - s.totals.liveLb) < 1e-9);
  // Footprint 14ft x 7ft = 98 ft^2; tributary areas (1 planked level) must sum to it.
  assert.ok(Math.abs(s.footprintFt2 - 98) < 1e-9, `footprint ${s.footprintFt2}`);
  // Live total = footprint * psf (one planked level)
  assert.ok(Math.abs(sumLive - 98 * 25) < 1e-6, `live ${sumLive}`);
});

test('every leg carries at least its own standard self-weight as dead', () => {
  const s = buildScaffold({ baysX: [7], baysY: [7], liftHeightFt: 6.5, lifts: 3 });
  const standardOnly = tubeWeightPerFoot(STANDARD_TUBE) * s.heightFt;
  for (const leg of s.legs) {
    assert.ok(leg.deadLb >= standardOnly - 1e-9, `${leg.id} dead ${leg.deadLb} < standard ${standardOnly}`);
  }
});

test('beamFromSupports yields a unit direction and correct span', () => {
  const beam = beamFromSupports([0, 0], [20, 0]);
  assert.ok(Math.abs(beam.spanFt - 20) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...beam.dir) - 1) < 1e-12);
});

test('leg distance from left support is exact and off-beam legs are flagged', () => {
  const beam = beamFromSupports([0, 0], [14, 0], { offToleranceFt: 0.5 });
  // On the beam line at x=7
  const on = locateLegOnBeam({ id: 'A', x: 7, y: 0, deadLb: 100, liveLb: 50 }, beam);
  assert.ok(Math.abs(on.locationFt - 7) < 1e-12);
  assert.ok(on.onSpan && on.onBeam);
  // Off to the side (y=3) -> off beam
  const off = locateLegOnBeam({ id: 'B', x: 7, y: 3, deadLb: 1, liveLb: 1 }, beam);
  assert.ok(!off.onBeam && Math.abs(off.perpFt - 3) < 1e-12);
  // Past the right support -> off span
  const past = locateLegOnBeam({ id: 'C', x: 20, y: 0, deadLb: 1, liveLb: 1 }, beam);
  assert.ok(!past.onSpan && Math.abs(past.locationFt - 20) < 1e-12);
});

test('toBeamPointLoads keeps dead/live separate and excludes off-beam legs by default', () => {
  const beam = beamFromSupports([0, 0], [14, 0]);
  const legs = [
    { id: 'A', x: 0, y: 0, deadLb: 300, liveLb: 1200 },
    { id: 'B', x: 7, y: 0, deadLb: 300, liveLb: 1200 },
    { id: 'C', x: 7, y: 5, deadLb: 999, liveLb: 999 }, // off beam
  ];
  const located = mapLegsToBeam(legs, beam);
  const { imported, skipped } = toBeamPointLoads(located);
  assert.equal(imported.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].legId, 'C');
  assert.deepEqual(
    imported.map(e => [e.deadLb, e.liveLb, e.locationFt]),
    [[300, 1200, 0], [300, 1200, 7]],
  );
  // includeOffBeam brings the off-beam leg through
  const all = toBeamPointLoads(located, { includeOffBeam: true });
  assert.equal(all.imported.length, 3);
});
