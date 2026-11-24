import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSupportFrame, buildSupportPair, findOppositeSupportFrame, getLedgerSideSign,
  resolveLiveLoadPlacement, forEachLiveLoadContribution, distributeLedgerPointLoad,
  buildLiveLoadPreviewForLedger, buildLiveLoadInstances, computeLiveLoadBatchPreview,
  MIN_LEDGER_LENGTH_FT, MIN_OVERLAP_FT,
} from '../src/scaffold/workspace/liveloads.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';

const SEG = 6.5625;
const Z = 10;

// Two parallel 7 ft ledgers 7 ft apart: one 7x7 bay.
function bay(zA = Z, zB = Z) {
  return [
    { id: 'L1', a: [0, 0, zA], b: [7, 0, zA] },
    { id: 'L2', a: [0, 7, zB], b: [7, 7, zB] },
  ];
}

test('a frame needs real length and carries axis, perpendicular and lift', () => {
  assert.equal(getSupportFrame({ id: 'x', a: [0, 0, 5], b: [0.5, 0, 5] }), null, 'too short to support a bay');
  const f = getSupportFrame({ id: 'x', a: [0, 0, 5], b: [8, 0, 5] });
  assert.equal(f.lengthFt, 8);
  assert.equal(f.z, 5);
  assert.deepEqual([f.dir.x, f.dir.y], [1, 0]);
  assert.deepEqual([f.perp.x + 0, f.perp.y], [0, 1]); // +0 normalises -0
  assert.ok(MIN_LEDGER_LENGTH_FT > 0 && MIN_OVERLAP_FT > 0);
});

test('the opposite support is the nearest parallel ledger on the chosen side', () => {
  const ledgers = [
    { id: 'L1', a: [0, 0, Z], b: [7, 0, Z] },
    { id: 'near', a: [0, 7, Z], b: [7, 7, Z] },
    { id: 'far', a: [0, 14, Z], b: [7, 14, Z] },
    { id: 'behind', a: [0, -7, Z], b: [7, -7, Z] },
  ];
  const src = getSupportFrame(ledgers[0]);
  assert.equal(findOppositeSupportFrame(src, ledgers, 1).ledger.id, 'near', 'nearest wins');
  assert.equal(findOppositeSupportFrame(src, ledgers, -1).ledger.id, 'behind', 'other side');
});

test('no bay across a different lift, a skew ledger, or without overlap', () => {
  const src = getSupportFrame({ id: 'L1', a: [0, 0, Z], b: [7, 0, Z] });
  const other = { id: 'L2', a: [0, 7, Z + 5], b: [7, 7, Z + 5] };
  assert.equal(findOppositeSupportFrame(src, [src.ledger, other], 1), null, 'different lift');

  const skew = { id: 'L3', a: [0, 7, Z], b: [5, 11, Z] };
  assert.equal(findOppositeSupportFrame(src, [src.ledger, skew], 1), null, 'not parallel');

  const past = { id: 'L4', a: [40, 7, Z], b: [47, 7, Z] };
  assert.equal(findOppositeSupportFrame(src, [src.ledger, past], 1), null, 'no overlapping run');
});

test('a resolved patch covers the bay and sits just above the ledgers', () => {
  const ledgers = bay();
  const r = resolveLiveLoadPlacement({ id: 'p', ledgerId: 'L1', sideSign: 1, psf: 50 }, ledgers);
  assert.ok(r, 'bay resolves');
  assert.equal(Math.round(r.widthFt * 1000) / 1000, 7, 'spans the ledger offset');
  assert.equal(Math.round(r.lengthFt * 1000) / 1000, 7, 'runs the overlap');
  assert.equal(Math.round(r.areaSqFt), 49);
  assert.equal(Math.round(r.center[0] * 1000) / 1000, 3.5);
  assert.equal(Math.round(r.center[1] * 1000) / 1000, 3.5, 'centred between the two ledgers');
  assert.ok(r.center[2] > Z && r.center[2] < Z + 0.2, 'rests on the deck, not inside it');

  // Picking the other side of L1 finds nothing, so no patch.
  assert.equal(resolveLiveLoadPlacement({ id: 'p', ledgerId: 'L1', sideSign: -1, psf: 50 }, ledgers), null);
});

test('side sign follows which side of the ledger was clicked', () => {
  const l = { id: 'L1', a: [0, 0, Z], b: [7, 0, Z] };
  assert.equal(getLedgerSideSign(l, { x: 3.5, y: 2 }), 1);
  assert.equal(getLedgerSideSign(l, { x: 3.5, y: -2 }), -1);
});

test('one-way meshing conserves the total load and favours the near ledger', () => {
  const ledgers = bay();
  const psf = 50;
  const r = resolveLiveLoadPlacement({ id: 'p', ledgerId: 'L1', sideSign: 1, psf }, ledgers);
  let source = 0, target = 0, cells = 0;
  forEachLiveLoadContribution(r, c => { source += c.sourceLoadLb; target += c.targetLoadLb; cells++; });

  assert.ok(cells >= 49, `bay meshed into >=49 cells, got ${cells}`);
  assert.ok(Math.abs(source + target - 49 * psf) < 1e-6, 'all of the load is accounted for');
  // Symmetric bay: the two supporting ledgers take half each.
  assert.ok(Math.abs(source - target) < 1e-6, 'symmetric bay splits evenly');
});

test('an off-centre point load splits between the legs by lever arm', () => {
  const ledger = { id: 'L1', a: [0, 0, Z], b: [10, 0, Z] };
  const got = [];
  distributeLedgerPointLoad(ledger, { x: 2.5, y: 0 }, 100, (x, y, w) => got.push([x, w]));
  assert.equal(got.length, 2);
  const start = got.find(g => g[0] === 0), end = got.find(g => g[0] === 10);
  assert.equal(Math.round(start[1]), 75, 'near leg takes three quarters');
  assert.equal(Math.round(end[1]), 25);

  // Beyond the ends the reaction clamps rather than going negative.
  const clamped = [];
  distributeLedgerPointLoad(ledger, { x: 40, y: 0 }, 100, (x, y, w) => clamped.push(w));
  assert.ok(clamped.every(w => w >= 0), 'no negative reactions');
  assert.ok(Math.abs(clamped.reduce((a, b) => a + b, 0) - 100) < 1e-9);
});

test('a bay can only be loaded once per side, and previews respect that', () => {
  const ledgers = bay();
  const first = buildLiveLoadPreviewForLedger(ledgers[0], ledgers, 1, [], 50);
  assert.ok(first);
  assert.equal(first.liveLoad.totalLb, 49 * 50);
  const existing = [{ id: 'LL1', ledgerId: 'L1', sideSign: 1, psf: 50 }];
  assert.equal(buildLiveLoadPreviewForLedger(ledgers[0], ledgers, 1, existing, 50), null, 'already loaded');
  assert.equal(buildLiveLoadInstances(existing, ledgers).length, 1);
});

test('SHIFT batch walks the connected run of collinear ledgers', () => {
  // Three bays in a row: ledgers end to end on two lines.
  const ledgers = [];
  for (let i = 0; i < 3; i++) {
    ledgers.push({ id: `A${i}`, a: [i * 7, 0, Z], b: [i * 7 + 7, 0, Z] });
    ledgers.push({ id: `B${i}`, a: [i * 7, 7, Z], b: [i * 7 + 7, 7, Z] });
  }
  const previews = computeLiveLoadBatchPreview(ledgers[0], ledgers, 1, [], 75);
  assert.equal(previews.length, 3, 'all three bays along the run');
  assert.ok(previews.every(p => p.placement.psf === 75));
  const ids = previews.map(p => p.placement.ledgerId);
  assert.deepEqual(ids, ['A0', 'A1', 'A2'], 'ordered along the run');

  // A detached ledger far away is not part of the run.
  ledgers.push({ id: 'island', a: [100, 0, Z], b: [107, 0, Z] });
  ledgers.push({ id: 'island2', a: [100, 7, Z], b: [107, 7, Z] });
  assert.equal(computeLiveLoadBatchPreview(ledgers[0], ledgers, 1, [], 75).length, 3, 'island excluded');
});

// --- integration with the scaffold state ------------------------------------

function fourLegBay() {
  const s = new ScaffoldState({ snapStep: 1, components: { plank: { areaWeightLbPerFt2: 0 } } });
  for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7]]) s.addStandard(x, y, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  const at = (x, y) => n.find(p => p.x === x && p.y === y);
  const a = at(0, 0), b = at(7, 0), c = at(0, 7), d = at(7, 7);
  const l1 = s.addLedger([a.x, a.y, a.z], [b.x, b.y, b.z]);
  const l2 = s.addLedger([c.x, c.y, c.z], [d.x, d.y, d.z]);
  return { s, l1, l2 };
}

test('a bay carries live load only once one is placed on it', () => {
  const { s, l1 } = fourLegBay();
  assert.equal(s.takeoff().totals.liveLb, 0, 'nothing placed, nothing carried');

  const ll = s.addLiveLoad(l1.id, 1, 50);
  assert.ok(ll, 'placed');
  assert.equal(s.liveLoadPatches().length, 1);
  assert.ok(Math.abs(s.takeoff().totals.liveLb - 49 * 50) < 1e-6, 'the placed load, and only that');

  // The same side cannot be loaded twice; the empty side has no bay.
  assert.equal(s.addLiveLoad(l1.id, 1, 50), null);
  assert.equal(s.addLiveLoad(l1.id, -1, 50), null);
});

test('bay live load reaches the legs and totals the placed area', () => {
  const { s, l1 } = fourLegBay();
  s.addLiveLoad(l1.id, 1, 50);
  const { legs, totals, placedLiveLb } = s.takeoff();

  assert.equal(Math.round(placedLiveLb), 49 * 50);
  assert.ok(Math.abs(totals.liveLb - 49 * 50) < 1e-6, 'nothing lost on the way to the legs');
  assert.equal(legs.length, 4);
  // Symmetric bay on four legs: a quarter each.
  for (const leg of legs) assert.ok(Math.abs(leg.liveLb - 49 * 50 / 4) < 1e-6, `leg ${leg.id} got ${leg.liveLb}`);
});

test('two bays at different psf load their own legs', () => {
  const s = new ScaffoldState({ snapStep: 1, components: { plank: { areaWeightLbPerFt2: 0 } } });
  for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7], [0, 14], [7, 14]]) s.addStandard(x, y, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  const at = (x, y) => n.find(p => p.x === x && p.y === y);
  const mk = (p, q) => s.addLedger([p.x, p.y, p.z], [q.x, q.y, q.z]);
  const lo = mk(at(0, 0), at(7, 0));
  mk(at(0, 7), at(7, 7));
  const hi = mk(at(0, 14), at(7, 14));

  s.addLiveLoad(lo.id, 1, 25);   // walkway bay, y 0..7
  s.addLiveLoad(hi.id, -1, 100); // material bay, y 7..14

  const { legs, placedLiveLb } = s.takeoff();
  assert.equal(Math.round(placedLiveLb), 49 * 25 + 49 * 100);

  const live = xy => legs.find(l => l.x === xy[0] && l.y === xy[1]).liveLb;
  assert.ok(Math.abs(live([0, 0]) - 49 * 25 / 4) < 1e-6, 'walkway corner');
  assert.ok(Math.abs(live([0, 14]) - 49 * 100 / 4) < 1e-6, 'material corner');
  // The shared middle line carries a quarter of each bay.
  assert.ok(Math.abs(live([0, 7]) - (49 * 25 / 4 + 49 * 100 / 4)) < 1e-6, 'shared line sums both');
  assert.ok(live([0, 14]) > live([0, 0]), 'the heavier bay loads its legs harder');
});

test('planks bring no live load of their own', () => {
  const { s, l1 } = fourLegBay();
  const n = s.nodes().filter(v => v.level === 1);
  const a = n.find(p => p.x === 0 && p.y === 0), d = n.find(p => p.x === 7 && p.y === 7);
  s.addPlank([a.x, a.y, a.z], [d.x, d.y, d.z]);

  const bare = s.takeoff();
  assert.equal(bare.totals.liveLb, 0, 'a planked bay nobody loaded carries no live load');
  assert.equal(bare.placedLiveLb, 0);

  s.addLiveLoad(l1.id, 1, 50);
  assert.ok(Math.abs(s.takeoff().totals.liveLb - 49 * 50) < 1e-6, 'only what was placed');

  s.clearLiveLoads();
  assert.equal(s.takeoff().totals.liveLb, 0, 'and none again once it is taken off');
});

test('an older save that leaned on a blanket deck load opens with no live load', () => {
  const { s } = fourLegBay();
  const n = s.nodes().filter(v => v.level === 1);
  const a = n.find(p => p.x === 0 && p.y === 0), d = n.find(p => p.x === 7 && p.y === 7);
  s.addPlank([a.x, a.y, a.z], [d.x, d.y, d.z]);
  const saved = JSON.parse(s.snapshot());
  saved.liveLoadMode = 'uniform'; // what such a save recorded

  const fresh = new ScaffoldState({ snapStep: 1, liveLoadPsf: 25 });
  fresh.restore(JSON.stringify(saved));
  assert.equal(fresh.plankBays().length, 1, 'the planks are there');
  assert.equal(fresh.takeoff().totals.liveLb, 0, 'but nothing loads them until the Live load tool does');
});

test('patches survive undo/redo and a snapshot round trip', () => {
  const { s, l1 } = fourLegBay();
  s.addLiveLoad(l1.id, 1, 60);
  const snap = s.snapshot();

  s.undo();
  assert.equal(s.liveLoads.size, 0, 'undo removes the patch');
  assert.equal(s.takeoff().totals.liveLb, 0);
  s.redo();
  assert.equal(s.liveLoads.size, 1, 'redo brings it back');

  const fresh = new ScaffoldState({ snapStep: 1 });
  fresh.restore(snap);
  assert.equal(fresh.liveLoads.size, 1);
  assert.equal([...fresh.liveLoads.values()][0].psf, 60);
  assert.equal(fresh.liveLoadPatches().length, 1, 'resolves against the restored ledgers');
});

test('removing a supporting ledger drops its patch instead of leaving a ghost', () => {
  const { s, l1, l2 } = fourLegBay();
  s.addLiveLoad(l1.id, 1, 50);
  assert.equal(s.liveLoadPatches().length, 1);

  // Losing the opposite ledger leaves the placement but closes no bay.
  s.remove(l2.id);
  assert.equal(s.liveLoads.size, 1, 'placement kept — its own ledger is still there');
  assert.equal(s.liveLoadPatches().length, 0, 'but nothing is drawn or loaded');
  assert.equal(s.takeoff().totals.liveLb, 0);

  // Losing its own ledger prunes it outright.
  s.remove(l1.id);
  assert.equal(s.liveLoads.size, 0);
});

test('psf is editable per patch and clamped to zero', () => {
  const { s, l1 } = fourLegBay();
  const ll = s.addLiveLoad(l1.id, 1, 50);
  assert.ok(s.setLiveLoadPsf(ll.id, 125));
  assert.equal(Math.round(s.takeoff().placedLiveLb), 49 * 125);
  s.setLiveLoadPsf(ll.id, -5);
  assert.equal(s.liveLoads.get(ll.id).psf, 0);
  assert.equal(s.setLiveLoadPsf('nope', 10), false);
});

test('clear all and clear bay loads both take the live loads off', () => {
  const { s, l1 } = fourLegBay();
  s.addLiveLoad(l1.id, 1, 50);
  s.clearLiveLoads();
  assert.equal(s.liveLoads.size, 0);
  assert.equal(s.takeoff().totals.liveLb, 0);

  s.addLiveLoad(l1.id, 1, 50);
  s.clear();
  assert.equal(s.liveLoads.size, 0);
});

test('geometry exposes the patches for the renderer', () => {
  const { s, l1 } = fourLegBay();
  s.addLiveLoad(l1.id, 1, 50);
  const g = s.geometry();
  assert.equal(g.liveLoads.length, 1);
  const p = g.liveLoads[0];
  for (const k of ['id', 'center', 'rotationZ', 'lengthFt', 'widthFt', 'psf', 'areaSqFt', 'totalLb']) {
    assert.ok(k in p, `patch exposes ${k}`);
  }
});
