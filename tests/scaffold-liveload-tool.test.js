// The Live load tool: point at a planked bay and click. The load runs along
// the boards, R turns it across them, SHIFT takes the whole platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { liveLoadArrowLayout, liveLoadArrows } from '../src/scaffold/workspace/parts.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

const W = 800, H = 600;
const SEG = 9.84375;

/** Looking straight down on the model, as the Top view does. */
function topCamera() {
  const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 500);
  cam.up.set(0, 1, 0);
  cam.position.set(10, 3, 100);
  cam.lookAt(10, 3, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

function toolsFor(state) {
  const camera = topCamera();
  const el = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  const engine = {
    scene: new THREE.Scene(), renderer: { domElement: el }, camera, invalidate() {},
    pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(),
    setPointerFromEvent(e) { this.pointer.set((e.clientX / W) * 2 - 1, -(e.clientY / H) * 2 + 1); },
  };
  const calls = { preview: [], rotate: [], bulk: [] };
  const t = new Tools(engine, state, {
    getContentMeshes: () => [],
    onPreview: (tool, count, info) => calls.preview.push({ tool, count, info }),
    onRotate: (tool, value) => calls.rotate.push({ tool, value }),
    onBulkFill: (n, label) => calls.bulk.push({ n, label }),
  });
  t.setTool('liveload');
  const at = (x, y, extra = {}) => {
    const v = new THREE.Vector3(x, y, 0).project(camera);
    return { clientX: (v.x + 1) / 2 * W, clientY: (1 - v.y) / 2 * H, shiftKey: false, buttons: 0, ...extra };
  };
  return {
    t, calls, at,
    hover: (x, y, extra) => t._onMove(at(x, y, extra)),
    click: (x, y, extra) => { const e = at(x, y, extra); t._onMove(e); t._act(e); t._updateGhost(e); },
    lastPreview: () => calls.preview[calls.preview.length - 1],
  };
}

/**
 * A platform as the Block tool lays it: `bays` bays of 7 x 3 ft in a row, a
 * leg at every corner, ledgers all round each bay, a rectangle deck on each.
 */
function platform(bays = 3) {
  const s = new ScaffoldState({ snapStep: 0, components: { plank: { areaWeightLbPerFt2: 0 } } });
  for (let i = 0; i <= bays; i++) for (const y of [0, 3]) s.addStandard(i * 7, y, SEG);
  const z = s.liftZ(4);
  const decks = [];
  for (let i = 0; i <= bays; i++) s.addLedger([i * 7, 0, z], [i * 7, 3, z]);
  for (let i = 0; i < bays; i++) {
    s.addLedger([i * 7, 0, z], [i * 7 + 7, 0, z]);
    s.addLedger([i * 7, 3, z], [i * 7 + 7, 3, z]);
    decks.push(s.addPlank([i * 7, 0, z], [i * 7 + 7, 3, z]));
  }
  return { s, z, decks };
}
const loadOn = (s, deck) => [...s.liveLoads.values()].find(l => l.deckId === deck.id) || null;

test('pointing at a planked bay previews its load; a click places it along the boards', () => {
  const { s, decks } = platform();
  const { t, hover, click, lastPreview } = toolsFor(s);

  hover(3.5, 1.5);
  assert.ok(t.ghostGroup.children.length > 0, 'a ghost of the load and its arrows');
  assert.deepEqual([lastPreview().count, lastPreview().info.psf, lastPreview().info.across], [1, 25, false]);

  click(3.5, 1.5);
  const load = loadOn(s, decks[0]);
  assert.ok(load, 'the bay pointed at is loaded');
  assert.deepEqual([load.psf, load.across], [25, false], '25 psf, along the boards');
  assert.equal(s.liveLoads.size, 1, 'and only that bay');
  assert.deepEqual(s.liveLoadPatches()[0].span, [1, 0], 'the boards run the long way, and so does the load');

  // The bay is loaded, so there is nothing more to preview on it; the two
  // bays beside it were not clicked and carry nothing.
  assert.equal(lastPreview().count, 0, 'nothing more to do here');
  assert.equal(t.ghostGroup.children.length, 0);
  assert.ok(Math.abs(s.takeoff().totals.liveLb - 21 * 25) < 1e-6, 'only the bay clicked is loaded');

  // Off the decks there is nothing to load.
  hover(3.5, 12);
  assert.deepEqual([lastPreview().count, lastPreview().info.miss, lastPreview().info.decks], [0, true, 3]);
  click(3.5, 12);
  assert.equal(s.liveLoads.size, 1);
});

test('R turns the load across the boards, and it stays turned until R again', () => {
  const { s, decks } = platform();
  const { t, calls, hover, click, lastPreview } = toolsFor(s);

  hover(3.5, 1.5);
  const value = t.rotate();
  assert.deepEqual(value, { across: true, oneWayOnly: false });
  assert.deepEqual(calls.rotate.at(-1), { tool: 'liveload', value });
  assert.equal(lastPreview().info.across, true, 'the preview turned at once, without the mouse moving');

  click(3.5, 1.5);
  click(10.5, 1.5);
  assert.deepEqual([loadOn(s, decks[0]).across, loadOn(s, decks[1]).across], [true, true], 'the next bay is turned too');
  assert.deepEqual(s.liveLoadPatches()[0].span, [0, 1]);

  t.rotate();
  click(17.5, 1.5);
  assert.equal(loadOn(s, decks[2]).across, false, 'R again puts it back along the boards');

  // Pointing at a loaded bay with the load turned the other way changes it.
  hover(3.5, 1.5);
  assert.deepEqual([lastPreview().count, lastPreview().info.changing], [1, true]);
  click(3.5, 1.5);
  assert.equal(loadOn(s, decks[0]).across, false);
  assert.equal(s.liveLoads.size, 3, 'changed in place, not added again');

  // Picking the tool afresh starts along the boards again.
  t.rotate();
  assert.equal(t.liveLoadAcross, true);
  t.setTool('liveload');
  assert.equal(t.liveLoadAcross, false);
});

test('a bay with ledgers on two sides only keeps its load along the boards', () => {
  const s = new ScaffoldState({ snapStep: 0 });
  const z = 6;
  const front = s.addLedger([0, 0, z], [3, 0, z]);
  s.addLedger([0, 7, z], [3, 7, z]);
  const deck = s.addPlankOnLedger(front.id, 1);
  const { t, click, hover, lastPreview } = toolsFor(s);

  hover(1.5, 3.5);
  assert.deepEqual(t.rotate(), { across: true, oneWayOnly: true }, 'R is refused for this bay');
  assert.deepEqual([lastPreview().info.across, lastPreview().info.oneWayOnly], [false, true]);
  click(1.5, 3.5);
  assert.equal(loadOn(s, deck).across, false);
  assert.deepEqual(s.liveLoadPatches()[0].span.map(v => Math.round(v) + 0), [0, 1], 'toward its two ledgers'); // + 0 normalises -0
});

test('SHIFT loads the whole platform in one step', () => {
  const { s, z } = platform(3);
  // A second platform a lift up, over the first bay only: not part of the first.
  const upper = s.addPlank([0, 0, z + 6.5625], [7, 3, z + 6.5625]);
  const { t, calls, hover, click } = toolsFor(s);
  t.liveLoadPsf = 50;

  // Point at the middle bay, which only the lower platform covers.
  hover(10.5, 1.5, { shiftKey: true });
  assert.equal(calls.preview.at(-1).count, 3, 'all three bays of the platform');
  assert.equal(t._pendingBatch.count, 3, 'Enter would place the same three');

  click(10.5, 1.5, { shiftKey: true });
  assert.equal(s.liveLoads.size, 3);
  assert.ok([...s.liveLoads.values()].every(l => l.psf === 50 && l.deckId !== upper.id));
  assert.deepEqual(calls.bulk.at(-1), { n: 3, label: 'live load' });
  s.undo();
  assert.equal(s.liveLoads.size, 0, 'one undo takes the whole platform back');

  // From above, the pointer lands on the upper deck where there is one.
  click(3.5, 1.5);
  assert.deepEqual([...s.liveLoads.values()].map(l => l.deckId), [upper.id]);
});

test('clicking a loaded bay with another load typed changes it; the same load does nothing', () => {
  const { s, decks } = platform(1);
  const { t, click } = toolsFor(s);
  click(3.5, 1.5);
  const before = s.version;
  click(3.5, 1.5);
  assert.equal(s.version, before, 'no edit, so nothing to undo');

  t.liveLoadPsf = 75;
  click(3.5, 1.5);
  assert.equal(s.liveLoads.size, 1);
  assert.equal(loadOn(s, decks[0]).psf, 75);
  assert.ok(Math.abs(s.takeoff().placedLiveLb - 21 * 75) < 1e-6);
});

test('the arrows run along the span, short of the ledgers at each end', () => {
  const { s, decks } = platform(1);
  s.setDeckLiveLoad(decks[0].id, 25);
  const patch = s.liveLoadPatches()[0];
  const arrows = liveLoadArrowLayout(patch);
  assert.ok(arrows.length >= 1 && arrows.length <= 3);
  for (const { from, to } of arrows) {
    assert.equal(from[1], to[1], 'along the boards');
    assert.ok(from[0] > 0 && from[0] < 0.5 && to[0] < 7 && to[0] > 6.5, 'from one ledger to the other, just inside them');
  }
  assert.equal(liveLoadArrows(patch).length, arrows.length * 3, 'a shaft and two heads each');

  s.setDeckLiveLoad(decks[0].id, 25, true);
  const turned = liveLoadArrowLayout(s.liveLoadPatches()[0]);
  assert.equal(turned.length, 3, 'more of them across the long side');
  for (const { from, to } of turned) {
    assert.ok(Math.abs(from[0] - to[0]) < 1e-9, 'across the boards');
    assert.ok(from[1] > 0 && to[1] < 3);
  }
});
