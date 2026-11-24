// Send to beam: the legs are picked by clicking them, the beam is laid under
// the picks, and what reaches the beam form is whole pounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { beamUnderPickedLegs, toBeamPointLoads, forBeamForm, wholePoundsOnLeg } from '../src/scaffold/legloads.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools, TOOLS } = await import('../src/scaffold/workspace/tools.js');

const leg = (id, x, y, deadLb = 100, liveLb = 50) => ({ id, x, y, deadLb, liveLb });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || 'value'}: ${a} is not ${b}`);
const at = (laid, id) => laid.located.find(r => r.leg.id === id);

// --- the beam under the picked legs ------------------------------------------

test('a row of legs: the beam runs under them from the leftmost, in whatever order they were clicked', () => {
  const laid = beamUnderPickedLegs([leg('c', 14, 0), leg('a', 0, 0), leg('b', 7, 0)], 20);
  assert.deepEqual(laid.beam.origin, [0, 0], 'the left support is under the leftmost leg');
  assert.deepEqual(laid.beam.dir, [1, 0], 'left to right, though the first click was the right-hand leg');
  assert.equal(laid.beam.spanFt, 20);
  assert.equal(laid.directed, true);
  assert.deepEqual(laid.located.map(r => [r.leg.id, r.locationFt]), [['c', 14], ['a', 0], ['b', 7]]);
  assert.ok(laid.located.every(r => r.onBeam && r.onSpan));
});

test('a beam running front to back starts at the front leg', () => {
  const laid = beamUnderPickedLegs([leg('back', 5, 3), leg('front', 5, 0)], 6);
  assert.deepEqual(laid.beam.dir, [0, 1]);
  assert.deepEqual(laid.beam.origin, [5, 0]);
  assert.equal(at(laid, 'front').locationFt, 0);
  assert.equal(at(laid, 'back').locationFt, 3);
});

test('the first leg can stand in from the left support, and the rest move along with it', () => {
  const picks = [leg('a', 0, 0), leg('b', 7, 0), leg('c', 14, 0), leg('d', 21, 0)];
  const flush = beamUnderPickedLegs(picks, 20);
  assert.deepEqual(flush.located.map(r => r.locationFt), [0, 7, 14, 21]);
  assert.deepEqual(flush.located.map(r => r.onSpan), [true, true, true, false], 'the fourth stands past a 20 ft beam');

  const inboard = beamUnderPickedLegs(picks, 20, { firstLegFt: 3 });
  assert.deepEqual(inboard.beam.origin, [-3, 0], 'the beam slid 3 ft to the left under the legs');
  assert.deepEqual(inboard.located.map(r => r.locationFt), [3, 10, 17, 24]);
  assert.deepEqual(inboard.located.map(r => r.onSpan), [true, true, true, false]);
  // Nonsense for the distance is no distance.
  for (const bad of [-2, NaN, undefined, null]) {
    assert.deepEqual(beamUnderPickedLegs(picks, 20, { firstLegFt: bad }).beam.origin, [0, 0]);
  }
});

test('a leg that is not in line with the rest is flagged, not sent', () => {
  const laid = beamUnderPickedLegs([leg('a', 0, 0), leg('b', 7, 0), leg('c', 14, 0), leg('stray', 7, 3)], 20);
  assert.equal(at(laid, 'stray').onBeam, false);
  const { imported, skipped } = toBeamPointLoads(laid.located);
  assert.deepEqual(imported.map(e => e.legId), ['a', 'b', 'c']);
  assert.deepEqual(skipped.map(e => e.legId), ['stray']);
});

test('the line through the most legs is the beam, even if the first click was on another row', () => {
  const laid = beamUnderPickedLegs([leg('other', 0, 3), leg('a', 0, 0), leg('b', 7, 0), leg('c', 14, 0)], 20);
  assert.deepEqual(laid.beam.dir, [1, 0]);
  assert.deepEqual(laid.beam.origin, [0, 0]);
  assert.deepEqual(laid.located.map(r => r.onBeam), [false, true, true, true]);
});

test('two whole rows picked at once: the row of the first leg picked is the beam, the other is left out', () => {
  const row = (name, y) => [0, 7, 14, 21, 28].map((x, i) => leg(`${name}${i}`, x, y));
  const frontFirst = beamUnderPickedLegs([...row('f', 0), ...row('b', 3)], 20);
  assert.deepEqual(toBeamPointLoads(frontFirst.located).imported.map(e => e.legId), ['f0', 'f1', 'f2']);
  assert.ok(frontFirst.located.filter(r => r.leg.id.startsWith('b')).every(r => !r.onBeam), 'the back row is not in line');
  assert.deepEqual(frontFirst.located.filter(r => r.onBeam && !r.onSpan).map(r => r.leg.id), ['f3', 'f4'], 'and two of the front row stand past the end');

  const backFirst = beamUnderPickedLegs([...row('b', 3), ...row('f', 0)], 20);
  assert.deepEqual(toBeamPointLoads(backFirst.located).imported.map(e => e.legId), ['b0', 'b1', 'b2']);
});

test('legs a few inches out of line still stand on the beam', () => {
  const laid = beamUnderPickedLegs([leg('a', 0, 0), leg('b', 7, 0.3), leg('c', 14, 0)], 20);
  assert.ok(laid.located.every(r => r.onBeam));
  near(at(laid, 'b').perpFt, 0.3, 'how far off the line');
  assert.equal(beamUnderPickedLegs([leg('a', 0, 0), leg('b', 7, 0.7), leg('c', 14, 0)], 20).located.filter(r => r.onBeam).length, 2, 'but not eight inches out');
});

test('a row set at an angle is measured along its own line', () => {
  const laid = beamUnderPickedLegs([leg('a', 0, 0), leg('c', 6, 8), leg('b', 3, 4)], 12);
  near(laid.beam.dir[0], 0.6); near(laid.beam.dir[1], 0.8);
  near(at(laid, 'b').locationFt, 5); near(at(laid, 'c').locationFt, 10);
  assert.ok(laid.located.every(r => r.onBeam && r.onSpan));
});

test('one leg alone goes on the beam where the first-leg distance puts it', () => {
  const laid = beamUnderPickedLegs([leg('only', 4, 9)], 20, { firstLegFt: 6 });
  assert.equal(laid.directed, false, 'one leg gives the beam no direction of its own');
  assert.equal(laid.located[0].locationFt, 6);
  assert.ok(laid.located[0].onBeam && laid.located[0].onSpan);
});

test('no legs, no beam; and a beam needs a span', () => {
  assert.deepEqual(beamUnderPickedLegs([], 20), { beam: null, located: [], directed: false });
  assert.throws(() => beamUnderPickedLegs([leg('a', 0, 0)], 0), /span/);
  assert.throws(() => beamUnderPickedLegs(null, 20), /array/);
});

// --- what the beam form is given ----------------------------------------------

test('the beam form gets whole pounds and feet to the hundredth, not the fractions the takeoff works in', () => {
  // The leg that read "P3 = 2,103.8769 lbs" on the beam diagram.
  const sent = forBeamForm({ legId: 'S3', deadLb: 603.8769, liveLb: 1500, locationFt: 10.000000000000002, perpFt: 0, onSpan: true, onBeam: true });
  assert.deepEqual(sent, { legId: 'S3', deadLb: 604, liveLb: 1500, locationFt: 10 });
  assert.deepEqual(forBeamForm({ legId: 'S1', deadLb: 396.0527, liveLb: 750, locationFt: 0 }), { legId: 'S1', deadLb: 396, liveLb: 750, locationFt: 0 });
  assert.equal(forBeamForm({ legId: 'x', deadLb: 10, liveLb: 0, locationFt: 7 / 3 }).locationFt, 2.33);
});

test('dead and live are rounded apart, and the tag on the leg in the builder is their sum', () => {
  const l = { id: 'S1', deadLb: 281.4, liveLb: 450.4 };
  const sent = forBeamForm({ legId: l.id, ...l, locationFt: 0 });
  assert.equal(sent.deadLb + sent.liveLb, 731);
  assert.equal(wholePoundsOnLeg(l), 731, 'not 732, which is what rounding the sum would give');
});

// --- clicking legs --------------------------------------------------------------

const W = 1000, H = 800;
/** Six legs in two rows, seen from straight above as the builder opens. */
function fromAbove() {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const [x, y] of [[0, 0], [7, 0], [14, 0], [0, 3], [7, 3], [14, 3]]) s.addStandard(x, y, 9.84375);
  const ids = [...s.standards.keys()];
  const top = s.baseOffsetFt() + 9.84375;
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 5000);
  camera.up.set(0, 1, 0);
  camera.position.set(7, 1.5, 60);
  camera.lookAt(7, 1.5, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const bounds = () => ({ left: 0, top: 0, width: W, height: H });
  const el = { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: bounds, parentElement: { getBoundingClientRect: bounds, appendChild() {} } };
  const engine = {
    scene: new THREE.Scene(), renderer: { domElement: el }, camera, invalidate() {},
    raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), panLock: false, _modifiers: { space: false },
    setPointerFromEvent(e) { this.pointer.set((e.clientX / W) * 2 - 1, -(e.clientY / H) * 2 + 1); },
  };
  const picks = [], boxes = [], previews = [], tags = [];
  const t = new Tools(engine, s, {
    getContentMeshes: () => [], getNodeMeshes: () => [], getLegTags: () => tags,
    onLegPick: id => picks.push(id), onLegBox: (legIds, modifiers) => boxes.push({ legIds, modifiers }),
    onPreview: (tool, count, info) => previews.push({ tool, count, info }),
  });
  t.setTool('beam');
  t._marqueeBox = { dataset: {}, style: {} }; // the box drawn while dragging, without a page to draw it on
  const screen = p => { const v = new THREE.Vector3(...p).project(camera); return { clientX: ((v.x + 1) / 2) * W, clientY: ((1 - v.y) / 2) * H, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, buttons: 0 }; };
  return { s, t, ids, top, el, picks, boxes, previews, tags, screen };
}

test('Send to beam is a tool of its own, apart from the tools that place parts', () => {
  assert.equal(TOOLS.includes('beam'), false, 'not one of the placing tools in the bar');
  const { t } = fromAbove();
  assert.equal(t.tool, 'beam');
});

test('from above, where a leg is a dot, clicking the dot picks the leg', () => {
  const { t, ids, top, picks, screen } = fromAbove();
  t._act(screen([7, 0, top]));
  assert.deepEqual(picks, [ids[1]]);
  // A few pixels off is still that leg.
  const off = screen([14, 3, top]); off.clientX += 8;
  t._act(off);
  assert.equal(picks[1], ids[5]);
  // Out in the middle of a bay there is no leg: the click picks nothing.
  t._act(screen([3.5, 1.5, top]));
  assert.equal(picks[2], null);
});

test('only legs are picked: a ledger under the click is not in the way, and is not taken', () => {
  const { s, t, ids, top, screen } = fromAbove();
  const ledger = s.addLedger([0, 0, top - 1], [7, 0, top - 1]);
  const mid = screen([3.5, 0, top - 1]);
  t.engine.setPointerFromEvent(mid);
  assert.equal(t._pickStandard(mid), null, 'half way along the ledger there is no leg');
  // With Select in hand the same click takes the ledger.
  t.setTool('select');
  t.engine.setPointerFromEvent(mid);
  assert.deepEqual(t._pickCandidates(mid), [ledger.id]);
  // And at the ledger's end, where it meets a leg, Send to beam takes the leg.
  t.setTool('beam');
  assert.equal(t._pickStandard(screen([7, 0, top - 1])), ids[1]);
});

test('a leg\'s load tag stands for its leg', () => {
  const { t, ids, top, tags, screen } = fromAbove();
  // Most of a foot to the side of the leg: off the leg itself, on its tag.
  const onTag = screen([7.8, 0, top + 1.1]);
  assert.equal(t._pickStandard(onTag), null, 'with no tag there, that is a miss');
  const tag = new THREE.Sprite(new THREE.SpriteMaterial());
  tag.scale.set(1.9, 0.48, 1);
  tag.position.set(7, 0, top + 1.1);
  tag.userData.legId = ids[1];
  tag.updateMatrixWorld();
  tags.push(tag);
  assert.equal(t._pickStandard(onTag), ids[1]);
});

test('the leg under the pointer lights up, with a hand over it, before any click', () => {
  const { t, ids, top, el, previews, screen } = fromAbove();
  t._onMove(screen([7, 3, top]));
  assert.equal(t.ghostGroup.children.length, 1, 'one column, round that leg');
  assert.deepEqual([t.ghostGroup.children[0].position.x, t.ghostGroup.children[0].position.y], [7, 3]);
  assert.equal(el.style.cursor, 'pointer');
  assert.deepEqual(previews.at(-1), { tool: 'beam', count: 1, info: { id: ids[4] } });

  t._onMove(screen([3.5, 1.5, top]));
  assert.equal(t.ghostGroup.children.length, 0, 'nothing lit between legs');
  assert.equal(el.style.cursor, '');
  assert.deepEqual(previews.at(-1), { tool: 'beam', count: 0, info: { id: null } });

  // Leaving the tool leaves no hand behind.
  t._onMove(screen([7, 3, top]));
  t.setTool('select');
  assert.equal(el.style.cursor, '');
  assert.equal(t.ghostGroup.children.length, 0);
});

test('a box dragged round a row takes its legs for the beam, and selects nothing', () => {
  const { t, ids, top, boxes, picks, screen } = fromAbove();
  const a = screen([-1, -1, top]), b = screen([15, 1, top]);
  // Pressed at the lower left of the front row and let go at its upper right.
  t._onDown({ ...a, button: 0 });
  t._onMove({ ...b, buttons: 1 });
  t._onUp({ ...b, button: 0 });
  assert.equal(boxes.length, 1);
  assert.deepEqual([...boxes[0].legIds].sort(), [ids[0], ids[1], ids[2]].sort(), 'the front row');
  assert.deepEqual(boxes[0].modifiers, { ctrlKey: false });
  assert.equal(t.selection.size, 0, 'nothing is selected by it');
  assert.deepEqual(picks, [], 'and a drag is not a click');
});
