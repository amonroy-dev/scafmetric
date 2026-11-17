import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trussMembers, trussMemberLengthFt, trussWorldMembers, TRUSS, bracketStrutDropFt, inchesToFeet } from '../src/scaffold/workspace/parts.js';
import { buildCenterlineModel, LAYERS } from '../src/scaffold/workspace/dxf.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { CATALOG } from '../src/scaffold/workspace/catalog.js';

const SEG = 6.5625;

test('truss is a 3-chord triangular frame, not a flat zig-zag', () => {
  const members = trussMembers();
  const chords = members.filter(m => m.chord);
  assert.equal(chords.length, 3, 'one top chord and two bottom chords');

  // the three chords sit at distinct cross-section corners
  const corners = chords.map(m => `${m.a[0].toFixed(4)},${m.a[2].toFixed(4)}`);
  assert.equal(new Set(corners).size, 3, 'chords form a triangle in section');

  // exactly one chord is the top (highest z), two share the bottom
  const zs = chords.map(m => m.a[2]).sort((a, b) => a - b);
  assert.ok(zs[0] === zs[1], 'two bottom chords at the same height');
  assert.ok(zs[2] > zs[1], 'one top chord above them');

  // every chord spans the full length in local Y
  for (const c of chords) {
    assert.equal(c.a[1], -0.5);
    assert.equal(c.b[1], 0.5);
  }
});

test('truss web has posts, ties and alternating diagonals over 5 panels', () => {
  const members = trussMembers();
  const web = members.filter(m => !m.chord);
  const n = TRUSS.panelCount;
  assert.equal(n, 5);
  // (n+1) stations x (2 posts + 1 tie) + n panels x 2 diagonals
  assert.equal(web.length, (n + 1) * 3 + n * 2);

  // cross ties are horizontal at the bottom, spanning the full base width
  const ties = web.filter(m => m.a[2] === m.b[2] && m.a[1] === m.b[1] && m.a[0] !== m.b[0]);
  assert.equal(ties.length, n + 1);
});

test('truss tubing length grows with span and is far more than a single tube', () => {
  const short = trussMemberLengthFt(5);
  const long = trussMemberLengthFt(10);
  assert.ok(long > short, 'longer span uses more tube');
  // 3 chords alone already exceed the span; the web adds much more
  assert.ok(short > 5 * 3, `expected well over 3x span, got ${short}`);
  assert.ok(trussMemberLengthFt(0) > 0, 'web members still have length at zero span');
});

test('truss world members keep the span and stay off the connection axis', () => {
  const a = [0, 0, 10], b = [7, 0, 10];
  const segs = trussWorldMembers(a, b);
  assert.equal(segs.length, trussMembers().length);
  // the top chord runs the full 7 ft
  const spans = segs.map(s => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]));
  assert.ok(spans.some(v => Math.abs(v - 7) < 1e-6), 'a chord spans the connection');
  // members are spread in z and across, so it reads as a 3D frame
  const zs = segs.flatMap(s => [s.a[2], s.b[2]]);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 0.5, 'truss has real depth');
  const ys = segs.flatMap(s => [s.a[1], s.b[1]]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.5, 'truss has real width');
});

test('truss catalog uses the real sizes', () => {
  const lengths = CATALOG.trusses.parts.map(p => p.lengthFt).sort((a, b) => a - b);
  assert.deepEqual(lengths, [5, 6, 7, 8, 10]);
});

test('bracket strut drops to a whole number of rosette spacings', () => {
  const spacing = inchesToFeet(19.6875);
  assert.ok(Math.abs(bracketStrutDropFt(2) - spacing) < 1e-9, 'short arm ties back one rosette');
  assert.ok(Math.abs(bracketStrutDropFt(3.5) - spacing * 2) < 1e-9, 'long arm ties back two');
});

test('skeleton/centerline model carries member ids and the truss frame', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  s.addStandard(7, 0, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  const t = s.addTruss([n[0].x, n[0].y, n[0].z], [n[1].x, n[1].y, n[1].z]);
  const model = buildCenterlineModel(s);

  const trussSegs = model.segments.filter(x => x.layer === LAYERS.truss);
  assert.equal(trussSegs.length, trussMembers().length, 'whole frame, not one line');
  for (const seg of trussSegs) assert.equal(seg.id, t.id, 'segments trace back for picking');

  const standards = model.segments.filter(x => x.layer === LAYERS.standard);
  assert.ok(standards.every(x => x.id), 'standards carry ids too');
});
