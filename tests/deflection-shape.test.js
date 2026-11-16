import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBeam } from '../src/beam.js';
import { MODEL, unitsPerInch, deflectedShape, dropUnits, autoScale, fitsDrawing, drawnPoints } from '../src/deflection-shape.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
// W16X31, 20 ft, 1,031 lb/ft service load including self-weight, adjusted 0.8 EI.
const uniform = () => analyzeBeam({ spanFt: 20, uniformLoadPlf: 1031, pointLoads: [], Eksi: 29000, Iin4: 375, stiffnessFactor: 0.8 });

test('horizontal and vertical scales match at 1×: the span is drawn 566 units long', () => {
  close(unitsPerInch(20), 566 / 240);
  close(dropUnits(1, 20, 1), 566 / 240);
  close(dropUnits(0.5, 20, 10, 0.5), 0.5 * 0.5 * 10 * 566 / 240);
});

test('peak matches the closed-form midspan deflection 5wL⁴/384EI divided by the stiffness factor', () => {
  const shape = deflectedShape(uniform());
  const w = 1031 / 12, L = 240, EI = 29000 * 1000 * 375;
  close(shape.peak.xFt, 10, 1e-9);
  close(shape.peak.deflectionIn, 5 * w * L ** 4 / (384 * EI) / 0.8, 1e-12);
  close(deflectedShape(uniform(), { basis: 'nominalDeflectionIn' }).peak.deflectionIn, 5 * w * L ** 4 / (384 * EI), 1e-12);
});

test('every drawn station is the engine value, including point-load stations and the peak', () => {
  const analysis = analyzeBeam({ spanFt: 20, uniformLoadPlf: 231, pointLoads: [{ loadLb: 3000, locationFt: 6.3 }], Eksi: 29000, Iin4: 510, stiffnessFactor: 0.8 });
  const shape = deflectedShape(analysis);
  for (const point of shape.points) assert.equal(point.deflectionIn, analysis.at(point.xFt).reducedDeflectionIn);
  assert.ok(shape.points.some(p => p.xFt === 6.3), 'point-load station sampled');
  assert.ok(shape.points.some(p => p.xFt === analysis.maxDeflection.xFt), 'peak station sampled');
  assert.equal(shape.peak.deflectionIn, analysis.maxDeflection.reducedDeflectionIn);
  assert.ok(shape.points.every((p, i, all) => i === 0 || p.xFt > all[i - 1].xFt), 'stations strictly increasing');
  close(shape.points[0].deflectionIn, 0); close(shape.points.at(-1).deflectionIn, 0);
});

test('drawn points sit on the supports, scale exactly, and are linear in the load fraction', () => {
  const shape = deflectedShape(uniform());
  const full = drawnPoints(shape, 25), half = drawnPoints(shape, 25, 0.5), none = drawnPoints(shape, 25, 0);
  close(full[0][0], MODEL.left); close(full.at(-1)[0], MODEL.right);
  close(full[0][1], MODEL.beamY); close(full.at(-1)[1], MODEL.beamY, 1e-9);
  const mid = full.findIndex(([, y], i) => shape.points[i].xFt === 10);
  close(full[mid][1] - MODEL.beamY, shape.peak.deflectionIn * 566 / 240 * 25);
  full.forEach(([, y], i) => { close(half[i][1] - MODEL.beamY, (y - MODEL.beamY) / 2); close(none[i][1], MODEL.beamY); });
});

test('auto picks the largest standard factor within the target; oversize factors are flagged', () => {
  const peak = deflectedShape(uniform()).peak.deflectionIn;            // ≈ 0.4266 in → ≈ 1.006 units at 1×
  assert.equal(autoScale(peak, 20), 25);                               // 25.2 units ≤ 40; 50× would be 50.3
  assert.ok(fitsDrawing(peak, 20, 50));                                // 50.3 ≤ 60
  assert.ok(!fitsDrawing(peak, 20, 100));                              // 100.6 > 60
  assert.equal(autoScale(0, 20), 1);
  assert.equal(autoScale(30, 20), 0.5);                                // very large deflection is reduced, never clipped
});
