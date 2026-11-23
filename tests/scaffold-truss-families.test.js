// The three truss families (light, heavy, truss), drawn as the frames
// ScaffoldPro's centerline view draws, and placed as it places them: one click
// from a rosette to the one a truss length away along a run, R for the next,
// Shift for the face.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { TRUSS_FRAMES } from '../src/scaffold/workspace/trussframes.js';
import { TRUSS_FAMILIES, trussFrameFor, trussWorldMembers, trussMemberLengthFt, buildTruss } from '../src/scaffold/workspace/parts.js';
import { CATALOG, CATEGORY_TOOL, CATEGORIES } from '../src/scaffold/workspace/catalog.js';
import { buildCenterlineModel, LAYERS } from '../src/scaffold/workspace/dxf.js';
import { deriveBom } from '../src/scaffold/workspace/bom.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function toolsFor(state) {
  const el = { addEventListener() {}, removeEventListener() {} };
  return new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, state);
}

test('every frame is a connected truss hanging below a level top chord', () => {
  for (const family of TRUSS_FAMILIES) {
    for (const f of TRUSS_FRAMES[family]) {
      const name = `${family} ${f.lengthFt} ft`;
      const ss = f.nodes.map(n => n[0]), ds = f.nodes.map(n => n[1]);
      assert.ok(Math.abs(Math.min(...ss) + f.lengthFt / 2) < 0.01 && Math.abs(Math.max(...ss) - f.lengthFt / 2) < 0.01, `${name}: ends at the rosettes`);
      assert.ok(Math.max(...ds) <= 1e-9, `${name}: nothing above the top chord`);
      assert.ok(Math.abs(Math.min(...ds) + f.depthFt) < 0.01, `${name}: as deep as stated`);
      // One piece: every node reachable from the first through members.
      const adj = new Map(f.nodes.map((_, i) => [i, []]));
      for (const [a, b] of f.members) { adj.get(a).push(b); adj.get(b).push(a); }
      const seen = new Set([0]); const queue = [0];
      while (queue.length) for (const n of adj.get(queue.shift())) if (!seen.has(n)) { seen.add(n); queue.push(n); }
      assert.equal(seen.size, f.nodes.length, `${name}: one connected frame`);
      assert.ok(f.members.some(m => m[2] === 'chord'), `${name}: has chords`);
    }
  }
});

test('the three families are different trusses', () => {
  const depth = fam => trussFrameFor(fam, 7).depthFt;
  assert.ok(depth('light') < depth('heavy') && depth('heavy') < depth('truss'), 'light is shallowest, the lattice truss deepest');
  assert.ok(Math.abs(depth('truss') - 1.641) < 1e-3, 'lattice truss chords 1.641 ft apart');
  assert.ok(TRUSS_FRAMES.light[0].members.some(m => m[4] > 0), 'light trusses have flat bar webs');
  assert.ok(trussMemberLengthFt(7, 'truss') > trussMemberLengthFt(7, 'heavy'), 'more steel in the lattice truss');
  assert.ok(trussMemberLengthFt(7, 'light') > 7, 'and every truss is more than its one chord');
});

test('a truss is fitted between its rosettes and hangs straight down', () => {
  const a = [0, 0, 10], b = [0, 7, 10];
  for (const family of TRUSS_FAMILIES) {
    const members = trussWorldMembers(a, b, family);
    const pts = members.flatMap(m => [m.a, m.b]);
    assert.ok(pts.every(p => Math.abs(p[0]) < 1e-9), `${family}: stays in the plane of the span`);
    assert.ok(pts.some(p => Math.abs(p[1]) < 1e-6 && Math.abs(p[2] - 10) < 1e-6), `${family}: lands on the first rosette`);
    assert.ok(pts.some(p => Math.abs(p[1] - 7) < 1e-6 && Math.abs(p[2] - 10) < 1e-6), `${family}: and on the second`);
    assert.ok(Math.max(...pts.map(p => p[2])) <= 10 + 1e-9, `${family}: nothing above the rosettes`);
    assert.equal(buildTruss(a, b, null, family).length, members.length, `${family}: one mesh per member`);
  }
});

test('the catalog offers the three families under generic names, all on the Truss tool', () => {
  const fams = ['lightTrusses', 'heavyTrusses', 'trusses'];
  assert.deepEqual(fams.map(k => CATALOG[k].label), ['Light trusses', 'Heavy trusses', 'Trusses']);
  for (const k of fams) {
    assert.ok(CATEGORIES.includes(k));
    assert.equal(CATEGORY_TOOL[k], 'truss');
    const frames = TRUSS_FRAMES[CATALOG[k].family].map(f => f.lengthFt);
    assert.deepEqual(CATALOG[k].parts.map(p => p.lengthFt).sort((x, y) => x - y), frames, `${k}: a size for every frame`);
    for (const p of CATALOG[k].parts) assert.ok(!/U[HD]*T\d/i.test(p.id + p.label), 'no part numbers');
  }
});

function grid() {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const x of [0, 7, 14, 21]) for (const y of [0, 5]) s.addStandard(x, y, 9.84375);
  const t = toolsFor(s);
  t._batchFillLedgers(2);
  t.setCatalog('trusses', 'trs-7');
  const node = (x, y, l) => s.nodes().find(q => q.x === x && q.y === y && q.level === l);
  return { s, t, node };
}

test('one click runs the truss to the rosette its own length away along the run', () => {
  const { s, t, node } = grid();
  const span = t._trussSpan(node(0, 0, 4));
  assert.deepEqual(span.b.slice(0, 2), [7, 0], '7 ft truss: the next standard along the front run');
  t._nearestNode = () => node(0, 0, 4);
  t._act({ clientX: 0, clientY: 0, shiftKey: false });
  assert.equal(s.trusses.size, 1);
  assert.equal([...s.trusses.values()][0].family, 'truss');
  // No rosette is 10 ft away on this grid, and a truss never cuts a bay corner
  // to corner even when the diagonal happens to match its length.
  t.setCatalog('trusses', 'trs-10');
  assert.equal(t._trussSpan(node(0, 0, 4)), null);
  t.setCatalog('trusses', 'trs-14');
  assert.deepEqual(t._trussSpan(node(0, 0, 4)).b.slice(0, 2), [14, 0], 'a 14 ft truss spans past the standard between');
});

test('R steps to the next rosette the truss can reach', () => {
  const { t, node } = grid();
  const mid = node(7, 0, 4);
  const first = t._trussSpan(mid);
  assert.equal(first.choices, 2, 'left or right along the run');
  t.trussTurn = 1;
  const second = t._trussSpan(mid);
  assert.notDeepEqual(first.b, second.b);
  t.trussTurn = 2;
  assert.deepEqual(t._trussSpan(mid).b, first.b, 'and round again');
});

test('Shift fills the face end to end, once, as one undo step', () => {
  const { s, t, node } = grid();
  t.setCatalog('heavyTrusses', 'htr-7');
  const span = t._trussSpan(node(7, 0, 4));
  const steps = s._history.length;
  assert.equal(t._batchFillTrusses(span), 3, 'three 7 ft bays along the front');
  assert.equal(s._history.length, steps + 1);
  assert.ok([...s.trusses.values()].every(x => x.family === 'heavy' && x.a[1] === 0 && x.b[1] === 0), 'it does not turn the corner');
  assert.equal(t._trussSpan(node(7, 0, 4)), null, 'a span that already has a truss is not offered again');
});

test('the line view, DXF and parts list carry each family', () => {
  const { s, t, node } = grid();
  for (const [cat, part, y] of [['lightTrusses', 'ltr-7', 0], ['trusses', 'trs-7', 5]]) {
    t.setCatalog(cat, part);
    const span = t._trussSpan(node(0, y, 4));
    s.addTruss(span.a, span.b, t._trussFamily());
  }
  const [light, lattice] = [...s.trusses.values()];
  const model = buildCenterlineModel(s);
  const count = id => model.segments.filter(x => x.layer === LAYERS.truss && x.id === id).length;
  assert.equal(count(light.id), trussFrameFor('light', 7).members.length);
  assert.equal(count(lattice.id), trussFrameFor('truss', 7).members.length);
  const lines = deriveBom(s).lineItems.filter(r => r.category === 'Trusses').map(r => r.description);
  assert.ok(lines.some(d => d.startsWith('Light truss')) && lines.some(d => d.startsWith('Truss ')), lines.join(' | '));
  // A truss saved before families existed still draws, as the lattice truss.
  assert.equal(trussWorldMembers([0, 0, 0], [7, 0, 0], undefined).length, trussFrameFor('truss', 7).members.length);
});
