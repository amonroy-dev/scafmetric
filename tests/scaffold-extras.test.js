import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRectUnionBoundarySegments, planGuardrails, deckRectsByHeight, TOP_RAIL_IN, MID_RAIL_IN } from '../src/scaffold/workspace/guardrails.js';
import { buildCenterlineModel, buildDxf, LAYERS } from '../src/scaffold/workspace/dxf.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { inchesToFeet } from '../src/scaffold/workspace/parts.js';

const SEG = 6.5625;

test('boundary of a single rectangle is its four sides', () => {
  const segs = computeRectUnionBoundarySegments([{ xMin: 0, xMax: 10, yMin: 0, yMax: 5 }]);
  assert.equal(segs.length, 4);
  const h = segs.filter(s => s.kind === 'H'), v = segs.filter(s => s.kind === 'V');
  assert.equal(h.length, 2);
  assert.equal(v.length, 2);
  assert.deepEqual(h.map(s => s.y).sort((a, b) => a - b), [0, 5]);
});

test('two touching rectangles merge into one outline without an interior wall', () => {
  const segs = computeRectUnionBoundarySegments([
    { xMin: 0, xMax: 10, yMin: 0, yMax: 5 },
    { xMin: 10, xMax: 20, yMin: 0, yMax: 5 },
  ]);
  assert.ok(!segs.some(s => s.kind === 'V' && Math.abs(s.x - 10) < 1e-9), 'interior wall removed');
  const h = segs.filter(s => s.kind === 'H');
  assert.equal(h.length, 2);
  for (const s of h) { assert.equal(s.x0, 0); assert.equal(s.x1, 20); }
});

test('an L-shaped union keeps its reentrant corner', () => {
  const segs = computeRectUnionBoundarySegments([
    { xMin: 0, xMax: 10, yMin: 0, yMax: 5 },
    { xMin: 0, xMax: 5, yMin: 5, yMax: 10 },
  ]);
  assert.ok(segs.length >= 6, `L outline needs at least 6 runs, got ${segs.length}`);
  assert.ok(segs.some(s => s.kind === 'H' && Math.abs(s.y - 5) < 1e-9), 'step edge present');
});

test('degenerate input yields no boundary', () => {
  assert.deepEqual(computeRectUnionBoundarySegments([]), []);
  assert.deepEqual(computeRectUnionBoundarySegments([{ xMin: 0, xMax: 0, yMin: 0, yMax: 5 }]), []);
});

test('guardrails give a top and mid rail plus posts', () => {
  const { rails, posts } = planGuardrails([{ xMin: 0, xMax: 14, yMin: 0, yMax: 7 }], 10);
  assert.equal(rails.length, 8, 'two rails on each of four runs');
  const heights = [...new Set(rails.map(r => Math.round((r.a[2] - 10) * 1000) / 1000))].sort((a, b) => a - b);
  const expected = [inchesToFeet(MID_RAIL_IN), inchesToFeet(TOP_RAIL_IN)].map(v => Math.round(v * 1000) / 1000);
  assert.deepEqual(heights, expected);
  assert.ok(posts.length >= 4, 'at least the corners');
  for (const p of posts) assert.ok(Math.abs((p.z1 - p.z0) - inchesToFeet(TOP_RAIL_IN)) < 1e-9);
});

test('generateGuardrails builds rails around decks and clears cleanly', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7]]) s.addStandard(x, y, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  const a = n.find(p => p.x === 0 && p.y === 0), b = n.find(p => p.x === 7 && p.y === 7);
  s.addPlank([a.x, a.y, a.z], [b.x, b.y, b.z]);
  const count = s.generateGuardrails();
  assert.ok(count > 0);
  assert.equal(s.guardrails.size, count);
  assert.equal(s.generateGuardrails(), count, 'regenerating replaces rather than duplicating');
  s.clearGuardrails();
  assert.equal(s.guardrails.size, 0);
  assert.equal(deckRectsByHeight(s).size, 1);
});

test('move and copy shift whole stacks', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const a = s.addStandard(0, 0, SEG);
  s.addStandard(7, 0, SEG);
  s.transformStacks([a.id], 3, 4, false);
  assert.equal(s.standards.get(a.id).x, 3);
  assert.equal(s.standards.get(a.id).y, 4);
  const before = s.standards.size;
  const copied = s.transformStacks([a.id], 10, 0, true);
  assert.equal(s.standards.size, before + 1);
  assert.equal(s.standards.get(copied[0]).x, 13);
  assert.notEqual(copied[0], a.id);
});

test('centerline model emits one segment per lift and dedupes joints', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const st = s.addStandard(0, 0, SEG);
  s.addStandard(0, 0, SEG);
  s.addStandard(7, 0, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  s.addLedger([n[0].x, n[0].y, n[0].z], [n[1].x, n[1].y, n[1].z]);
  const model = buildCenterlineModel(s);
  const standards = model.segments.filter(x => x.layer === LAYERS.standard);
  assert.equal(standards.length, 3, 'two lifts on one column plus one on the other');
  assert.equal(model.segments.filter(x => x.layer === LAYERS.ledger).length, 1);
  assert.ok(model.points.length < model.segments.length * 2, 'shared splice joints deduped');
  assert.equal(s.standards.get(st.id).segments.length, 2);
});

test('DXF output is well formed and carries the members', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  const dxf = buildDxf(buildCenterlineModel(s));
  assert.ok(dxf.startsWith('0\r\nSECTION'), 'starts with a section');
  assert.ok(dxf.trimEnd().endsWith('EOF'), 'ends with EOF');
  assert.equal((dxf.match(/\bSECTION\b/g) || []).length, 3, 'header, tables, entities');
  assert.equal((dxf.match(/\bENDSEC\b/g) || []).length, 3);
  assert.ok(dxf.includes(LAYERS.standard));
  assert.ok(dxf.includes('LINE'));
  assert.ok(dxf.includes('POINT'));
  assert.equal(dxf.trimEnd().split('\r\n').length % 2, 0, 'group codes come in pairs');
});

test('DXF axis mapping can swap to Y-up', () => {
  const model = { segments: [{ start: [1, 2, 3], end: [4, 5, 6], layer: LAYERS.ledger }], points: [] };
  const yup = buildDxf(model, { includeJoints: false, axis: 'yup' });
  const lines = yup.trimEnd().split('\r\n');
  const i = lines.indexOf('10');
  assert.equal(lines[i + 1], '1.000000');
  assert.equal(lines[i + 3], '3.000000', 'z became y');
  assert.equal(lines[i + 5], '2.000000', 'y became z');
});

test('trusses are placed, counted and carry load', () => {
  const s = new ScaffoldState({ snapStep: 1, components: { plank: { areaWeightLbPerFt2: 0 } } });
  s.addStandard(0, 0, SEG);
  s.addStandard(12, 0, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  const before = s.takeoff().totals.deadLb;
  s.addTruss([n[0].x, n[0].y, n[0].z], [n[1].x, n[1].y, n[1].z]);
  assert.equal(s.trusses.size, 1);
  assert.ok(s.takeoff().totals.deadLb > before, 'truss adds dead load');
});
