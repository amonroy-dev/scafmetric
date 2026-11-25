// Pulling an end: out a bay repeats the last bay and carries the end out, in a
// bay takes it away. The measure of it: a scaffold pulled to a size is the
// scaffold a block of that size would have been.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';
import { findEnd, pullEnd } from '../src/scaffold/workspace/pull.js';
import { deriveBom } from '../src/scaffold/workspace/bom.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

function built(widthFt, depthFt, extra = {}) {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  tools.blockSettings = { ...BLOCK_DEFAULTS, widthFt, depthFt, heightFt: 10, braceFrontBack: 'slash', braceLeftRight: 'slash', ...extra };
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: widthFt / 2, y: depthFt / 2 }, snapped: false, rotationSteps: 0 });
  return { s, tools };
}
const endAt = (tools, pick) => { const faces = tools._framing().faces; return findEnd(faces, faces.find(pick)); };
const rightEnd = f => f.outside && f.ax === f.bx && f.ax > 1;
const count = s => ({ standards: s.standards.size, ledgers: s.ledgers.size, braces: s.braces.size, decks: s.plankBays().length });
const railFt = s => Math.round(s.guardrailPieces().reduce((n, g) => n + g.lengthFt, 0) * 100) / 100;
const loads = s => s.takeoff().legs.map(l => `${l.x},${l.y}:${Math.round(l.deadLb * 100) / 100}`).sort();
const weight = s => deriveBom(s).summary.totalWeightLb;

test('an end is the whole straight outside face, with the bay behind it', () => {
  const { tools } = built(14, 12, { guardrails: false }); // two 7 ft bays by two 6 ft
  const end = endAt(tools, rightEnd);
  assert.deepEqual([end.n.x, end.n.y], [1, 0]);
  assert.equal(end.depthFt, 7);
  assert.equal(end.span[1] - end.span[0], 12, 'both faces of the end, not the one pointed at');
  assert.equal(end.bays, 2);
  assert.deepEqual(end.handle, { x: 15.5, y: 6 });
  const side = endAt(tools, f => f.outside && f.ay === f.by && f.ay > 1);
  assert.deepEqual([side.depthFt, side.span[1] - side.span[0]], [6, 14], 'a long side is an end too: pulled, the scaffold gets deeper');
  const oneBay = built(7, 5, { guardrails: false });
  assert.equal(endAt(oneBay.tools, rightEnd).bays, 1);
});

test('pulled out a bay it is the scaffold a longer block would have been', () => {
  for (const guardrails of [false, true]) {
    const { s, tools } = built(14, 5, { guardrails });
    const want = built(21, 5, { guardrails }).s;
    assert.equal(pullEnd(s, endAt(tools, rightEnd), 1), true);
    assert.deepEqual(count(s), count(want), `rails ${guardrails}`);
    assert.equal(railFt(s), railFt(want), 'the same rail round it, and none left across the deck where the end was');
    assert.deepEqual(loads(s), loads(want));
    assert.equal(weight(s), weight(want));
    s.undo();
    assert.equal(s.standards.size, 6, 'one undo');
  }
});

test('pulled in a bay it is the shorter one, and the last bay is never taken', () => {
  const { s, tools } = built(21, 5);
  const want = built(14, 5).s;
  assert.equal(pullEnd(s, endAt(tools, rightEnd), -1), true);
  assert.deepEqual(count(s), count(want));
  assert.equal(railFt(s), railFt(want));
  assert.deepEqual(loads(s), loads(want));
  assert.equal(pullEnd(s, endAt(tools, rightEnd), -1), true, 'down to one bay');
  assert.equal(s.standards.size, 4);
  assert.equal(pullEnd(s, endAt(tools, rightEnd), -1), false, 'and no further');
  assert.equal(s.standards.size, 4);
});

test('a side pulled out makes the scaffold a bay deeper', () => {
  const { s, tools } = built(14, 6, { guardrails: true });
  const want = built(14, 12, { guardrails: true }).s;
  pullEnd(s, endAt(tools, f => f.outside && f.ay === f.by && f.ay > 1), 1);
  assert.deepEqual(count(s), count(want));
  assert.equal(railFt(s), railFt(want));
  assert.deepEqual(loads(s), loads(want));
});

test('what was built on the last bay by hand goes out with it, and loads are copied', () => {
  const { s, tools } = built(14, 5, { guardrails: false });
  const z = s.liftZ(4);
  // A side bracket on each end standard pointing out of the end, a standard in one, and 50 psf on the last bay.
  const ks = [0, 5].map(y => s.addBracket({ x: 14, y, z }, [1, 0], 2));
  s.addStandardOnBracket(ks[0].id, 3.28125);
  const last = s.plankBays().find(d => d.x0 >= 7 - 1e-6);
  s.setDeckLiveLoad(last.id, 50);
  const liveBefore = s.takeoff().legs.reduce((n, l) => n + l.liveLb, 0);
  pullEnd(s, endAt(tools, rightEnd), 1);
  assert.deepEqual([...s.brackets.values()].map(k => k.x), [21, 21], 'the brackets are on the new end and not the old');
  const seated = [...s.standards.values()].filter(c => c.bracketId);
  assert.deepEqual(seated.map(c => [c.x, c.y]), [[23, 0]], 'with the standard that stood in one');
  assert.ok(Math.abs(s.takeoff().legs.reduce((n, l) => n + l.liveLb, 0) - 2 * liveBefore) < 1e-6, 'the new bay carries what the last one did');
  assert.equal(s.plankBays().length, 3);
});

test('an end another run meets keeps the standards that run stands on', () => {
  // A 14 x 5 run with a 7 x 5 block standing off the far half of its right-hand end... side by side along y.
  const { s, tools } = built(14, 5, { guardrails: false });
  tools.blockSettings = { ...tools.blockSettings, widthFt: 7, depthFt: 5 };
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 10.5, y: 7.5 }, snapped: false, rotationSteps: 0 });
  // The bottom face (y = 0) is a clean end 14 ft long; pull it in is refused (one bay deep there)...
  const bottom = endAt(tools, f => f.outside && f.ay === f.by && f.ay < 1);
  assert.equal(bottom.bays, 1);
  // ...and the left end (x = 0) pulled in takes the first bay, leaving the standards at x = 7 that the upper block also stands on.
  const left = endAt(tools, f => f.outside && f.ax === f.bx && f.ax < 1);
  assert.equal(pullEnd(s, left, -1), true);
  const at = [...s.standards.values()].map(c => `${c.x},${c.y}`).sort();
  assert.deepEqual(at, ['14,0', '14,10', '14,5', '7,0', '7,10', '7,5']);
});
