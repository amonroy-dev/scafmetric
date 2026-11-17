import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { deriveBom, bomToCsv, formatFeetInches, CATEGORY_ORDER,
  woodSillWeightLb, screwJackWeightLb, baseCollarWeightLb } from '../src/scaffold/workspace/bom.js';

const SEG = 6.5625;

function bay(opts = {}) {
  const s = new ScaffoldState({ snapStep: 1, ...opts });
  const b = 7;
  for (const [x, y] of [[0, 0], [b, 0], [0, b], [b, b]]) s.addStandard(x, y, SEG);
  return s;
}

test('formatFeetInches renders feet and inches', () => {
  assert.equal(formatFeetInches(7), '7 ft 0 in');
  assert.equal(formatFeetInches(6.5), '6 ft 6 in');
  assert.equal(formatFeetInches(0.5), '6 in');
  assert.equal(formatFeetInches(NaN), '—');
});

test('an empty model produces an empty BOM', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const bom = deriveBom(s);
  assert.equal(bom.lineItems.length, 0);
  assert.equal(bom.summary.totalQuantity, 0);
  assert.equal(bom.summary.totalWeightLb, 0);
});

test('standards and bases are counted per leg', () => {
  const s = bay();
  const bom = deriveBom(s);
  const std = bom.lineItems.find(r => r.category === 'Standards');
  assert.equal(std.quantity, 4, 'four standard segments');
  const jack = bom.lineItems.find(r => r.description.startsWith('Screw jack'));
  assert.equal(jack.quantity, 4, 'one jack per leg');
  const sill = bom.lineItems.find(r => r.description.startsWith('Wood sill'));
  assert.equal(sill.quantity, 4);
  const collar = bom.lineItems.find(r => r.description.startsWith('Base collar'));
  assert.equal(collar.quantity, 4);
});

test('disabling sill and collar removes those lines', () => {
  const s = bay({ showWoodSill: false, showBaseCollar: false });
  const bom = deriveBom(s);
  assert.ok(!bom.lineItems.some(r => r.description.startsWith('Wood sill')));
  assert.ok(!bom.lineItems.some(r => r.description.startsWith('Base collar')));
  assert.ok(bom.lineItems.some(r => r.description.startsWith('Screw jack')));
});

test('same-length ledgers group into one line with summed weight', () => {
  const s = bay();
  const n = s.nodes().filter(x => x.level === 1);
  const at = (x, y) => n.find(p => p.x === x && p.y === y);
  s.addLedger([0, 0, at(0, 0).z], [7, 0, at(7, 0).z]);
  s.addLedger([0, 7, at(0, 7).z], [7, 7, at(7, 7).z]);
  const bom = deriveBom(s);
  const led = bom.lineItems.filter(r => r.category === 'Ledgers');
  assert.equal(led.length, 1, 'grouped into a single 7 ft line');
  assert.equal(led[0].quantity, 2);
  assert.ok(Math.abs(led[0].totalWeightLb - led[0].unitWeightLb * 2) < 0.02);
});

test('planks are itemised per board by width and length', () => {
  const s = bay();
  const n = s.nodes().filter(x => x.level === 1);
  const a = n.find(p => p.x === 0 && p.y === 0), b = n.find(p => p.x === 7 && p.y === 7);
  s.addPlank([a.x, a.y, a.z], [b.x, b.y, b.z]);
  const bom = deriveBom(s);
  const planks = bom.lineItems.filter(r => r.category === 'Planks');
  assert.ok(planks.length >= 1);
  const boards = planks.reduce((t, r) => t + r.quantity, 0);
  assert.equal(boards, s.plankBoards([...s.planks.values()][0]).length);
  assert.ok(planks.every(r => /\d+ in x /.test(r.description)));
});

test('side brackets appear in the BOM', () => {
  const s = bay();
  const node = s.nodes().find(x => x.level === 1);
  s.addBracket(node, [1, 0], 3);
  const bom = deriveBom(s);
  const brk = bom.lineItems.find(r => r.category === 'Brackets');
  assert.ok(brk, 'bracket line present');
  assert.equal(brk.quantity, 1);
  assert.ok(brk.totalWeightLb > 0);
});

test('summary totals match the line items and categories are ordered', () => {
  const s = bay();
  const n = s.nodes().filter(x => x.level === 1);
  s.addLedger([0, 0, n[0].z], [7, 0, n[0].z]);
  const bom = deriveBom(s);
  const qty = bom.lineItems.reduce((a, r) => a + r.quantity, 0);
  const wt = bom.lineItems.reduce((a, r) => a + r.totalWeightLb, 0);
  assert.equal(bom.summary.totalQuantity, qty);
  assert.ok(Math.abs(bom.summary.totalWeightLb - wt) < 0.05);
  assert.equal(bom.summary.lineItemCount, bom.lineItems.length);
  const idx = bom.lineItems.map(r => CATEGORY_ORDER.indexOf(r.category));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'sorted by category order');
});

test('procedural part weights are positive and sane', () => {
  assert.ok(woodSillWeightLb() > 0 && woodSillWeightLb() < 5);
  assert.ok(screwJackWeightLb(6) > screwJackWeightLb(0), 'extension adds weight');
  assert.ok(baseCollarWeightLb() > 0 && baseCollarWeightLb() < 20);
});

test('CSV export has a header and one row per line item', () => {
  const s = bay();
  const bom = deriveBom(s);
  const csv = bomToCsv(bom).split('\n');
  assert.ok(csv[0].startsWith('Category,Description,Qty'));
  assert.equal(csv.length, bom.lineItems.length + 2, 'header + rows + total');
});
