import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScaffoldState, stateBounds } from '../src/scaffold/workspace/state.js';
import { tubeWeightPerFoot, STANDARD_TUBE } from '../src/scaffold/catalog.js';

test('placing a standard twice on the same column stacks a lift', () => {
  const s = new ScaffoldState({ liftHeightFt: 6.5, snapStep: 1 });
  s.addStandard(0, 0);
  s.addStandard(0.2, -0.1); // snaps to (0,0)
  assert.equal(s.standards.size, 1);
  assert.equal([...s.standards.values()][0].lifts, 2);
});

test('nodes exist at every lift level of each standard', () => {
  const s = new ScaffoldState({ liftHeightFt: 5, snapStep: 1 });
  const st = s.addStandard(3, 4); // 1 lift -> levels 0 and 1
  const nodes = s.nodes().filter(n => n.columnId === st.id);
  assert.deepEqual(nodes.map(n => n.z).sort((a, b) => a - b), [0, 5]);
});

test('takeoff keeps dead and live separate; live = planked area x psf', () => {
  const s = new ScaffoldState({ liftHeightFt: 6, snapStep: 1, liveLoadPsf: 25, components: { plank: { areaWeightLbPerFt2: 3 } } });
  const b = 7;
  for (const [x, y] of [[0, 0], [b, 0], [0, b], [b, b]]) s.addStandard(x, y);
  s.addPlank(0, 0, b, b, 1);
  const { legs, totals } = s.takeoff();
  assert.equal(legs.length, 4);
  // live total = 49 ft^2 * 25 psf = 1225, split across the 4 corner legs
  assert.ok(Math.abs(totals.liveLb - 49 * 25) < 1e-6, `live ${totals.liveLb}`);
  for (const leg of legs) assert.ok(Math.abs(leg.liveLb - (49 * 25) / 4) < 1e-6);
  // each leg dead >= its own standard self-weight (1 lift * 6 ft)
  const standardOnly = tubeWeightPerFoot(STANDARD_TUBE) * 6;
  for (const leg of legs) assert.ok(leg.deadLb >= standardOnly - 1e-9);
  // dead also includes plank dead (49*3) distributed
  assert.ok(totals.deadLb > 4 * standardOnly);
});

test('ledger weight is split half to each end column', () => {
  const s = new ScaffoldState({ liftHeightFt: 6, snapStep: 1, components: { plank: { areaWeightLbPerFt2: 0 } } });
  s.addStandard(0, 0); s.addStandard(10, 0);
  s.addLedger(0, 0, 10, 0, 1);
  const { legs } = s.takeoff();
  const a = legs.find(l => l.x === 0), b = legs.find(l => l.x === 10);
  const ledgerHalf = (b.deadLb - tubeWeightPerFoot(s.components.standard) * 6);
  assert.ok(ledgerHalf > 0);
  assert.ok(Math.abs(a.deadLb - b.deadLb) < 1e-9, 'symmetric split');
});

test('stateBounds spans the placed columns and max height', () => {
  const s = new ScaffoldState({ liftHeightFt: 6, snapStep: 1 });
  s.addStandard(0, 0); s.addStandard(14, 7); s.stack([...s.standards.values()][0].id, 2);
  const bb = stateBounds(s);
  assert.deepEqual(bb.min, [0, 0, 0]);
  assert.equal(bb.max[0], 14); assert.equal(bb.max[1], 7);
  assert.equal(bb.max[2], 18); // first standard now 3 lifts * 6
});

test('clear removes everything', () => {
  const s = new ScaffoldState();
  s.addStandard(0, 0); s.addLedger(0, 0, 7, 0, 1);
  s.clear();
  assert.equal(s.standards.size, 0);
  assert.equal(s.ledgers.size, 0);
  assert.equal(stateBounds(s), null);
});
