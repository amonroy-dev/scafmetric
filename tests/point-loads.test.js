import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePointLoads, pointLoadsForAnalysis } from '../src/point-loads.js';
import { analyzeBeam } from '../src/beam.js';

test('mixed dead and live point loads preserve categories and service equilibrium', () => {
  const source = [{ id:'P1', deadKip:2, liveKip:3, locationFt:4 }, { id:'P2', deadKip:1, liveKip:1, locationFt:15 }];
  const before = structuredClone(source);
  const points = normalizePointLoads(source, 20);
  assert.deepEqual(points.map(p => p.loadKip), [5, 2]);
  assert.deepEqual(source, before);
  assert.notEqual(points[0], source[0]);
  const analysis = analyzeBeam({ spanFt:20, Eksi:29000, Iin4:375, pointLoads:pointLoadsForAnalysis(points) });
  // 5 kip at 4 ft and 2 kip at 15 ft on a 20 ft span: RA = 4.5 kip,
  // RB = 2.5 kip. These totals include D and LL exactly once at each station.
  assert.equal(analysis.reactions.leftLb, 4500);
  assert.equal(analysis.reactions.rightLb, 2500);
  assert.equal(analysis.equilibrium.forceResidualLb, 0);
});

test('comparison scales only point live load, using independent bending and shear factors', () => {
  const points = normalizePointLoads([{deadKip:2, liveKip:3, locationFt:4}], 20);
  const bending = pointLoadsForAnalysis(points, 4/1.67)[0].loadLb;
  const shear = pointLoadsForAnalysis(points, 4/1.5)[0].loadLb;
  assert.ok(Math.abs(bending - (2000 + 3000*4/1.67)) < 1e-9);
  assert.equal(shear, 10000);
  assert.deepEqual(pointLoadsForAnalysis(points, 0), [{loadLb:2000,locationFt:4}]);
  assert.equal(points[0].loadKip, 5);
});

test('dead-only, live-only and legacy records keep their intended categories', () => {
  const points = normalizePointLoads([{deadKip:2,locationFt:0}, {liveKip:3,locationFt:20}, {loadKip:4,locationFt:7}], 20);
  assert.deepEqual(points.map(p => [p.deadKip,p.liveKip,p.loadKip]), [[2,0,2],[0,3,3],[0,4,4]]);
  assert.deepEqual(pointLoadsForAnalysis(points, 2), [{loadLb:2000,locationFt:0},{loadLb:6000,locationFt:20},{loadLb:8000,locationFt:7}]);
  // A stored total cannot override the explicit category inputs.
  assert.equal(normalizePointLoads([{deadKip:2,liveKip:3,loadKip:99,locationFt:1}],20)[0].loadKip, 5);
});

test('invalid point categories, positions, multipliers and overflow are rejected', () => {
  for (const point of [null, {}, {deadKip:-1,liveKip:2,locationFt:1}, {deadKip:NaN,locationFt:1}, {liveKip:Infinity,locationFt:1}, {deadKip:null,locationFt:1}, {deadKip:undefined,liveKip:1,locationFt:1}, {loadKip:-1,locationFt:1}, {liveKip:1,locationFt:-1}, {liveKip:1,locationFt:21}, {liveKip:1,locationFt:NaN}, {deadKip:Number.MAX_VALUE,liveKip:Number.MAX_VALUE,locationFt:1}]) {
    assert.throws(() => normalizePointLoads([point],20), /Point loads/);
  }
  assert.throws(() => normalizePointLoads(null,20), /array/);
  for (const span of [0,-1,Infinity,NaN]) assert.throws(() => normalizePointLoads([],span), /span/);
  for (const multiplier of [-1,Infinity,NaN]) assert.throws(() => pointLoadsForAnalysis([],multiplier), /multiplier/);
  assert.throws(() => pointLoadsForAnalysis([{deadKip:0,liveKip:Number.MAX_VALUE,locationFt:1}]), /too large/);
  assert.throws(() => pointLoadsForAnalysis([{deadKip:0,liveKip:1e100,locationFt:1}],Number.MAX_VALUE), /too large/);
});
