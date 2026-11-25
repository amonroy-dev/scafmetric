// A chain is one connected scaffold. It can be picked up whole, moved, turned
// a quarter turn and copied, and set down against another chain it becomes
// part of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';
import { deriveBom } from '../src/scaffold/workspace/bom.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

function model() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  const block = (cx, cy, w = 14, d = 5, extra = {}) => {
    tools.tool = 'block';
    tools.blockSettings = { ...BLOCK_DEFAULTS, widthFt: w, depthFt: d, heightFt: 10, braceFrontBack: 'slash', ...extra };
    tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: cx, y: cy }, snapped: false, rotationSteps: 0 });
  };
  return { s, tools, block };
}
const count = s => [s.standards.size, s.ledgers.size, s.braces.size, s.planks.size, s.guardrails.size, s.stairs.size];
const everyId = s => [s.standards, s.ledgers, s.braces, s.planks, s.guardrails, s.stairs, s.brackets, s.trusses, s.plankPlacements, s.liveLoads].flatMap(m => [...m.keys()]);
const loads = s => s.takeoff().legs.map(l => Math.round(l.deadLb * 100) / 100).sort((a, b) => a - b);
const span = s => { const c = [...s.standards.values()]; return [Math.max(...c.map(p => p.x)) - Math.min(...c.map(p => p.x)), Math.max(...c.map(p => p.y)) - Math.min(...c.map(p => p.y))]; };

test('a chain is everything joined to a part: one block, or blocks that share standards', () => {
  const { s, block } = model();
  block(7, 2.5);
  block(60, 2.5);
  // (The second block re-lays the rails round that deck height, so the first block's parts are read after it.)
  const nearX = id => { const a = s._anchorsOf(id); return a && a.length && a[0][0] < 30; };
  const first = everyId(s).filter(nearX);
  const aLedger = [...s.ledgers.keys()][0];
  assert.deepEqual(s.chainOf([aLedger]).sort(), [...first].sort(), 'from one ledger: the whole of its block and none of the other');
  assert.equal(s.chainOf([[...s.braces.keys()][0]]).length, first.length, 'a brace is set off its face and still belongs');
  // A third block that shares the first one's end standards makes them one chain.
  block(21, 2.5);
  const joined = s.chainOf([aLedger]);
  assert.ok(joined.length > first.length);
  assert.equal(joined.filter(id => s.standards.has(id)).length, 10, 'six and six with two shared');
  // A standard on its own is a chain of one.
  const lone = s.addStandard(200, 200, 9.84375);
  assert.deepEqual(s.chainOf([lone.id]), [lone.id]);
});

test('moved, every part goes and the leg loads are what they were', () => {
  const { s, block } = model();
  block(7, 2.5);
  const before = { count: count(s), loads: loads(s), bom: deriveBom(s).summary.totalWeightLb };
  const ids = s.chainOf([[...s.standards.keys()][0]]);
  const moved = s.transformParts(ids, { dx: 30, dy: -12 });
  assert.equal(moved.length, ids.length);
  assert.deepEqual(count(s), before.count);
  assert.deepEqual(loads(s), before.loads);
  assert.equal(deriveBom(s).summary.totalWeightLb, before.bom);
  assert.equal(Math.min(...[...s.standards.values()].map(c => c.x)), 30);
  assert.equal(Math.min(...[...s.ledgers.values()].map(l => Math.min(l.a[1], l.b[1]))), -12);
  assert.equal(s.plankBays().every(d => d.x0 >= 30 && d.y0 >= -12), true);
  s.undo();
  assert.equal(Math.min(...[...s.standards.values()].map(c => c.x)), 0, 'one undo puts it all back');
});

test('turned a quarter turn about a standard it stands the other way, with nothing lost', () => {
  const { s, block } = model();
  block(7, 2.5);
  const before = { count: count(s), loads: loads(s) };
  assert.deepEqual(span(s), [14, 5]);
  s.transformParts(everyId(s), { steps: 1, pivot: { x: 0, y: 0 } });
  assert.deepEqual(span(s), [5, 14]);
  assert.deepEqual(count(s), before.count);
  assert.deepEqual(loads(s), before.loads);
  // Every ledger still runs between two standards, and every deck sits on four.
  const at = new Set([...s.standards.values()].map(c => `${Math.round(c.x * 100)},${Math.round(c.y * 100)}`));
  const on = (x, y) => at.has(`${Math.round(x * 100)},${Math.round(y * 100)}`);
  for (const l of s.ledgers.values()) assert.ok(on(l.a[0], l.a[1]) && on(l.b[0], l.b[1]));
  for (const d of s.plankBays()) assert.ok(on(d.x0, d.y0) && on(d.x1, d.y1));
  // Four quarter turns is where it started.
  for (let i = 0; i < 3; i++) s.transformParts(everyId(s), { steps: 1, pivot: { x: 0, y: 0 } });
  assert.deepEqual(span(s), [14, 5]);
  assert.equal(Math.min(...[...s.standards.values()].map(c => c.x)), 0);
});

test('set down against another chain it becomes part of it, as if built there', () => {
  // Built in place: two blocks sharing the standards at x = 14.
  const built = model();
  built.block(7, 2.5, 14, 5, { guardrails: false });
  built.block(21, 2.5, 14, 5, { guardrails: false });
  // Built apart, then moved up against it.
  const { s, block } = model();
  block(7, 2.5, 14, 5, { guardrails: false });
  block(61, 2.5, 14, 5, { guardrails: false });
  const far = s.chainOf([[...s.standards.values()].find(c => c.x > 50).id]);
  s.transformParts(far, { dx: -40, dy: 0 });
  assert.deepEqual(count(s), count(built.s), 'the shared standards and the ledgers between them are there once');
  assert.deepEqual(loads(s), loads(built.s));
  assert.equal(s.chainOf([[...s.standards.keys()][0]]).filter(id => s.standards.has(id)).length, 10, 'one chain now');
});

test('copied, the copy is a second scaffold with its own decks and loads', () => {
  const { s, block } = model();
  block(7, 2.5);
  for (const d of s.plankBays()) s.setDeckLiveLoad(d.id, 50);
  const before = { count: count(s), bom: deriveBom(s).summary.totalWeightLb, live: s.takeoff().legs.reduce((n, l) => n + l.liveLb, 0) };
  const original = everyId(s);
  const copies = s.transformParts(original, { dx: 40 }, true);
  assert.equal(copies.some(id => original.includes(id)), false, 'new ids');
  assert.deepEqual(count(s), before.count.map(n => n * 2));
  assert.ok(Math.abs(deriveBom(s).summary.totalWeightLb - 2 * before.bom) < 0.05);
  assert.ok(Math.abs(s.takeoff().legs.reduce((n, l) => n + l.liveLb, 0) - 2 * before.live) < 1e-6, 'the loads on its decks came too');
  assert.ok(before.live > 0);
});

test('a stair tower with a bracket and a standard in it moves as one', () => {
  const { s, tools } = model();
  tools.tool = 'stair';
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 0, y: 0 }, snapped: false, rotationSteps: 0 });
  const host = s.nodes().find(n => n.x === 7 && n.y === -3.5 && n.level === 4);
  const k = s.addBracket(host, [1, 0], 2);
  s.addStandardOnBracket(k.id, 3.28125);
  const before = { loads: loads(s), n: everyId(s).length };
  const chain = s.chainOf([[...s.stairs.keys()][0]]);
  assert.equal(chain.length, before.n, 'the bracket and the standard in it are on the chain');
  s.transformParts(chain, { dx: 10, dy: 10, steps: 1, pivot: { x: 0, y: 0 } });
  assert.equal(everyId(s).length, before.n);
  assert.deepEqual(loads(s), before.loads);
  const seated = [...s.standards.values()].find(c => c.bracketId);
  const moved = s.brackets.get(k.id);
  assert.deepEqual(moved.dir, [0, 1], 'the bracket turned with it');
  assert.ok(Math.abs(seated.x - moved.x) < 1e-6 && Math.abs(seated.y - (moved.y + 2)) < 1e-6, 'and its standard is still in its socket');
  for (const f of s.stairs.values()) assert.equal(f.lower.every(p => [...s.standards.values()].some(c => Math.abs(c.x - p[0]) < 1e-6 && Math.abs(c.y - p[1]) < 1e-6)), true);
});

test('Move picks the selection up: R turns it, it snaps onto a standard nearby, a click sets it down', () => {
  const { s, tools, block } = model();
  block(7, 2.5, 14, 5, { guardrails: false });
  block(61, 2.5, 14, 5, { guardrails: false });
  // No canvas here: the pointer is wherever the engine says the ground point is.
  let ground = { x: 0, y: 0 };
  tools.engine.setPointerFromEvent = () => {};
  tools.engine.groundPoint = () => ground;
  const far = s.chainOf([[...s.standards.values()].find(c => c.x > 50).id]);
  assert.equal(tools.beginCarry([], false), false, 'nothing selected, nothing picked up');
  assert.equal(tools.beginCarry(far, false), true);
  assert.equal(tools.carry.cols.length, 6);
  const pivot = tools.carry.pivot;
  // Within reach of the first block's end standard: it snaps on.
  ground = { x: pivot.x - 40 + 0.6, y: pivot.y + 0.4 };
  const p = tools._carryPlacement({});
  assert.equal(p.snapped, true);
  assert.deepEqual([p.dx, p.dy], [-40, 0]);
  tools.rotate();
  assert.equal(tools.carry.steps, 1);
  tools.rotate(); tools.rotate(); tools.rotate();
  tools._act({});
  assert.equal(tools.carry, null);
  assert.equal(s.standards.size, 10, 'joined: the two it landed on are shared');
  assert.equal(tools.selection.size > 0, true, 'what was moved stays selected');
});
