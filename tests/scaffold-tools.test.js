import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFaceGraph, perimeterFaces, isPerimeterFace, faceMatchesFilter, pickFace,
  faceBraceTarget, nodesByColumn, planPerimeterBraces, deltaLiftFor,
  MIN_SPAN_FT, MAX_SPAN_FT, PERP_OFFSET_FT, BRACE_DELTA_LIFT,
} from '../src/scaffold/workspace/braces.js';
import {
  buildPlankPreviewForLedger, computePlankBatchPreview, resolvePlankPlacement,
  plankRectFromPair, PLANK_MOUTHPIECE_TOTAL_IN,
} from '../src/scaffold/workspace/planks.js';
import { buildSupportPair } from '../src/scaffold/workspace/supportspan.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { planStandardSegmentsForHeight } from '../src/scaffold/workspace/planning.js';
import { CATALOG } from '../src/scaffold/workspace/catalog.js';

const SEG = 6.5625;
const Z = 10;

// --- brace faces ------------------------------------------------------------

function grid(nx, ny, pitch = 7) {
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    out.push({ id: `S${i}_${j}`, x: i * pitch, y: j * pitch });
  }
  return out;
}

test('a single bay of four standards gives four faces, all perimeter', () => {
  const faces = buildFaceGraph(grid(2, 2));
  assert.equal(faces.length, 4, 'four sides, no diagonals');
  for (const f of faces) assert.ok(Math.abs(f.spanFt - 7) < 1e-9, 'faces are bay-width, not diagonal');
  assert.equal(perimeterFaces(faces).length, 4);
});

test('face normals point away from the footprint centre', () => {
  const faces = buildFaceGraph(grid(2, 2));
  const cx = 3.5, cy = 3.5;
  for (const f of faces) {
    const midX = (f.ax + f.bx) / 2, midY = (f.ay + f.by) / 2;
    const outward = (midX - cx) * f.normX + (midY - cy) * f.normY;
    assert.ok(outward > 0, 'normal faces outward, which is what keeps ascending consistent');
  }
});

test('a third standard between two blocks the pair', () => {
  // Three in a row at 7 ft: the 0-to-14 pair must not become a face.
  const faces = buildFaceGraph([
    { id: 'A', x: 0, y: 0 }, { id: 'B', x: 7, y: 0 }, { id: 'C', x: 14, y: 0 },
  ]);
  const spans = faces.map(f => Math.round(f.spanFt * 1000) / 1000);
  assert.ok(spans.every(v => v === 7), `only adjacent pairs, got spans ${spans}`);
  assert.equal(faces.length, 2);
});

test('faces outside the diagonal span range are rejected', () => {
  assert.equal(buildFaceGraph([{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 1, y: 0 }]).length, 0, 'under min span');
  assert.equal(buildFaceGraph([{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 20, y: 0 }]).length, 0, 'over max span');
  assert.ok(MIN_SPAN_FT === 1.5 && MAX_SPAN_FT === 11);
  const ok = buildFaceGraph([{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 7, y: 0 }]);
  assert.equal(ok.length, 1);
});

test('interior faces of a 3x3 grid are not perimeter faces', () => {
  const faces = buildFaceGraph(grid(3, 3));
  const perim = perimeterFaces(faces);
  assert.ok(perim.length < faces.length, 'some faces are interior');
  // The middle horizontal run has rows above and below, so it is interior.
  const middle = faces.find(f =>
    Math.abs(f.dirX) > Math.abs(f.dirY) &&
    Math.abs((f.ay + f.by) / 2 - 7) < 1e-9 &&
    Math.abs((f.ax + f.bx) / 2 - 3.5) < 1e-9);
  assert.ok(middle, 'found the middle run');
  assert.equal(isPerimeterFace(middle, faces), false);
});

test('the face filter selects one elevation', () => {
  const faces = buildFaceGraph(grid(2, 2));
  const cx = 3.5, cy = 3.5;
  const count = f => faces.filter(x => faceMatchesFilter(x, f, cx, cy)).length;
  assert.equal(count('all'), 4);
  assert.equal(count('front'), 1);
  assert.equal(count('back'), 1);
  assert.equal(count('left'), 1);
  assert.equal(count('right'), 1);
  const front = faces.find(f => faceMatchesFilter(f, 'front', cx, cy));
  assert.ok((front.ay + front.by) / 2 <= cy, 'front is the low-y side');
});

test('a ray aimed at a face picks it, with the side it is seen from', () => {
  const standards = grid(2, 2);
  const faces = buildFaceGraph(standards);
  // Look at the y=0 run from outside (y negative), level with the bay.
  const picked = pickFace(
    { origin: [3.5, -20, 12], direction: [0, 1, 0] },
    faces, { filter: 'all', standards });
  assert.ok(picked, 'hit a face');
  assert.ok(Math.abs((picked.face.ay + picked.face.by) / 2) < 1e-9, 'hit the y=0 run');
  assert.equal(picked.side, 1, 'seen from outside');
  assert.ok(Math.abs(picked.cursorZ - 12) < 1e-9, 'cursor height carried through');
  assert.ok(picked.alongFt > 0 && picked.alongFt < 7, 'hit within the face, not past its end');
});

test('a ray that misses every face picks nothing', () => {
  const standards = grid(2, 2);
  const faces = buildFaceGraph(standards);
  assert.equal(pickFace({ origin: [3.5, -20, 12], direction: [0, -1, 0] }, faces, { standards }), null, 'aimed away');
  assert.equal(pickFace({ origin: [100, -20, 12], direction: [0, 1, 0] }, faces, { standards }), null, 'past the end');
});

test('deltaLift is four levels, signed by direction', () => {
  assert.equal(deltaLiftFor('ascending'), BRACE_DELTA_LIFT);
  assert.equal(deltaLiftFor('descending'), -BRACE_DELTA_LIFT);
  assert.equal(BRACE_DELTA_LIFT, 4);
});

function bracedState(nx = 2, ny = 2, segments = 2) {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const col of grid(nx, ny)) {
    for (let k = 0; k < segments; k++) s.addStandard(col.x, col.y, SEG);
  }
  return s;
}

test('a brace target climbs four levels and stands off the face', () => {
  const s = bracedState();
  const faces = buildFaceGraph([...s.standards.values()]);
  const byCol = nodesByColumn(s.nodes());
  const face = faces[0];
  const target = faceBraceTarget(face, byCol, 6, 'ascending');
  assert.ok(target, 'found a diagonal');
  assert.equal(target.levelB - target.levelA, 4, 'four rosette levels');
  assert.ok(target.b[2] > target.a[2], 'ascending climbs');

  // The brace is offset off the face plane so it clears the standards.
  const offA = (target.a[0] - face.ax) * face.normX + (target.a[1] - face.ay) * face.normY;
  assert.ok(Math.abs(offA - PERP_OFFSET_FT) < 1e-9, `stood off by ${PERP_OFFSET_FT} ft`);
});

test('descending braces run the other way and never go below level 0', () => {
  const s = bracedState();
  const byCol = nodesByColumn(s.nodes());
  const face = buildFaceGraph([...s.standards.values()])[0];
  const target = faceBraceTarget(face, byCol, 6, 'descending');
  assert.ok(target);
  assert.equal(target.levelA - target.levelB, 4);
  assert.ok(target.levelB >= 0, 'no negative lift');
  assert.ok(target.b[2] < target.a[2], 'descending drops');
});

test('a single-segment standard is too short for a diagonal without its collar, and says so', () => {
  const s = bracedState(2, 2, 1);
  s.setBase({ showBaseCollar: false });
  const byCol = nodesByColumn(s.nodes());
  const face = buildFaceGraph([...s.standards.values()])[0];
  const levels = [...byCol.values()][0].size;
  assert.ok(levels <= 4, `one 6.5625 ft segment carries ${levels} rosettes, fewer than the 5 a diagonal needs`);
  assert.equal(faceBraceTarget(face, byCol, 6, 'ascending'), null, 'no target rather than a silent wrong brace');
});

test('with its base collar, a single segment carries a diagonal from the collar rosette', () => {
  const s = bracedState(2, 2, 1);
  const byCol = nodesByColumn(s.nodes());
  const face = buildFaceGraph([...s.standards.values()])[0];
  assert.equal([...byCol.values()][0].size, 5, 'four rosettes on the tube and one on the collar');
  const t = faceBraceTarget(face, byCol, 3, 'ascending');
  assert.ok(t, 'a diagonal fits');
  assert.deepEqual([t.levelA, t.levelB], [0, 4], 'from the collar (lift 0) to lift 4');
});

test('the cursor height chooses which lift pair gets braced', () => {
  const s = bracedState(2, 2, 3);
  const byCol = nodesByColumn(s.nodes());
  const face = buildFaceGraph([...s.standards.values()])[0];
  const low = faceBraceTarget(face, byCol, 3, 'ascending');
  const high = faceBraceTarget(face, byCol, 15, 'ascending');
  assert.ok(low && high);
  assert.ok(high.levelA > low.levelA, 'aiming higher braces a higher lift');
  assert.ok(Math.abs(low.midZ - 3) < Math.abs(high.midZ - 3), 'low pick is the one nearest the low cursor');
});

test('SHIFT plans one brace per perimeter face and skips the interior', () => {
  const s = bracedState(3, 3, 2);
  const faces = buildFaceGraph([...s.standards.values()]);
  const plan = planPerimeterBraces(faces, s.nodes(), {
    standards: [...s.standards.values()], targetZ: 6, direction: 'ascending',
  });
  assert.equal(plan.length, perimeterFaces(faces).length, 'every perimeter face, nothing interior');
  assert.ok(plan.length < faces.length);
  const keys = new Set(plan.map(t => `${t.face.columnIdA}|${t.face.columnIdB}`));
  assert.equal(keys.size, plan.length, 'no face braced twice');
});

test('nth-bay stride and the face filter narrow the SHIFT fill', () => {
  const s = bracedState(4, 4, 2);
  const faces = buildFaceGraph([...s.standards.values()]);
  const standards = [...s.standards.values()];
  const all = planPerimeterBraces(faces, s.nodes(), { standards, targetZ: 6 });
  const every2 = planPerimeterBraces(faces, s.nodes(), { standards, targetZ: 6, nthBay: 2 });
  assert.ok(every2.length < all.length, 'stride places fewer');

  const frontOnly = planPerimeterBraces(faces, s.nodes(), { standards, targetZ: 6, filter: 'front' });
  assert.ok(frontOnly.length > 0 && frontOnly.length < all.length);
  for (const t of frontOnly) {
    assert.ok(Math.abs(t.face.dirX) > Math.abs(t.face.dirY), 'front faces run along x');
  }
});

test('isTaken keeps SHIFT from stacking a second brace on the same face', () => {
  const s = bracedState(2, 2, 2);
  const faces = buildFaceGraph([...s.standards.values()]);
  const standards = [...s.standards.values()];
  const first = planPerimeterBraces(faces, s.nodes(), { standards, targetZ: 6 });
  assert.ok(first.length > 0);
  const none = planPerimeterBraces(faces, s.nodes(), { standards, targetZ: 6, isTaken: () => true });
  assert.equal(none.length, 0, 'everything already braced means nothing to add');
});

// --- decks ------------------------------------------------------------------

function bayLedgers(zA = Z, zB = Z) {
  return [
    { id: 'L1', a: [0, 0, zA], b: [7, 0, zA] },
    { id: 'L2', a: [0, 7, zB], b: [7, 7, zB] },
  ];
}

test('a deck spans between the two ledgers, packed along them', () => {
  const ledgers = bayLedgers();
  const preview = buildPlankPreviewForLedger(ledgers[0], ledgers, 1, []);
  assert.ok(preview, 'bay decks');
  const boards = preview.deck.boards;
  assert.ok(boards.length >= 8, `9 in boards across a 7 ft ledger, got ${boards.length}`);

  // Every board spans the bay width, not the ledger length.
  for (const b of boards) {
    assert.ok(Math.abs(b.lengthFt - 7) < 0.05, `board length ${b.lengthFt} should be the 7 ft bay width`);
  }
  // Boards are packed along the ledger, so their centres spread in x.
  const xs = boards.map(b => b.center[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 4, 'boards sit side by side along the ledger');
  // And they all sit at one height, just under the ledger top.
  const zs = new Set(boards.map(b => Math.round(b.center[2] * 1e6)));
  assert.equal(zs.size, 1, 'one deck plane');
  assert.ok(boards[0].center[2] < Z, 'profile centre sits below the ledger centreline');
});

test('the packing span is the ledger less both mouthpieces', () => {
  assert.equal(PLANK_MOUTHPIECE_TOTAL_IN, 6);
  const short = buildPlankPreviewForLedger(
    { id: 'L1', a: [0, 0, Z], b: [2, 0, Z] },
    [{ id: 'L1', a: [0, 0, Z], b: [2, 0, Z] }, { id: 'L2', a: [0, 7, Z], b: [2, 7, Z] }],
    1, []);
  assert.ok(short, '2 ft ledger still decks');
  // 24 in less 6 in of mouthpiece leaves 18 in: two 9 in boards.
  assert.equal(short.deck.boards.length, 2);
});

test('a deck resolves to the footprint rectangle the BOM and guardrails need', () => {
  const ledgers = bayLedgers();
  const pair = buildSupportPair(ledgers[0], ledgers, 1);
  const rect = plankRectFromPair(pair);
  assert.equal(Math.round(rect.x0 * 1000) / 1000, 0);
  assert.equal(Math.round(rect.x1 * 1000) / 1000, 7);
  assert.equal(Math.round(rect.y0 * 1000) / 1000, 0);
  assert.equal(Math.round(rect.y1 * 1000) / 1000, 7);
  assert.equal(rect.z, Z);
});

test('the far side of a lone ledger has no bay to deck', () => {
  const ledgers = bayLedgers();
  assert.equal(buildPlankPreviewForLedger(ledgers[0], ledgers, -1, []), null);
  assert.equal(resolvePlankPlacement({ id: 'x', ledgerId: 'L1', sideSign: -1 }, ledgers), null);
});

test('SHIFT decks every bay along the run', () => {
  const ledgers = [];
  for (let i = 0; i < 3; i++) {
    ledgers.push({ id: `A${i}`, a: [i * 7, 0, Z], b: [i * 7 + 7, 0, Z] });
    ledgers.push({ id: `B${i}`, a: [i * 7, 7, Z], b: [i * 7 + 7, 7, Z] });
  }
  const previews = computePlankBatchPreview(ledgers[0], ledgers, 1, []);
  assert.equal(previews.length, 3);
  assert.deepEqual(previews.map(p => p.placement.ledgerId), ['A0', 'A1', 'A2']);
});

// --- deck integration with state -------------------------------------------

function fourLegBay() {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7]]) s.addStandard(x, y, SEG);
  const n = s.nodes().filter(v => v.level === 1);
  const at = (x, y) => n.find(p => p.x === x && p.y === y);
  const l1 = s.addLedger([0, 0, at(0, 0).z], [7, 0, at(7, 0).z]);
  const l2 = s.addLedger([0, 7, at(0, 7).z], [7, 7, at(7, 7).z]);
  return { s, l1, l2 };
}

test('decking a ledger side adds a bay once and only once', () => {
  const { s, l1 } = fourLegBay();
  assert.ok(s.addPlankOnLedger(l1.id, 1), 'decked');
  assert.equal(s.plankBays().length, 1);
  assert.equal(s.addPlankOnLedger(l1.id, 1), null, 'same side again is a no-op');
  assert.equal(s.addPlankOnLedger(l1.id, -1), null, 'no bay on the open side');
  assert.equal(s.addPlankOnLedger('nope', 1), null, 'unknown ledger');
});

test('a ledger-anchored deck carries dead load and feeds the BOM', () => {
  const { s, l1 } = fourLegBay();
  const before = s.takeoff().totals.deadLb;
  s.addPlankOnLedger(l1.id, 1);
  const after = s.takeoff().totals.deadLb;
  assert.ok(after > before, 'deck weight reaches the legs');

  const bay = s.plankBays()[0];
  assert.ok(Math.abs(bay.areaSqFt - 49) < 1e-6, '7 x 7 bay');
  assert.ok(bay.boards.length > 0);
});

test('guardrails and the uniform live load both see ledger-anchored decks', () => {
  const { s, l1 } = fourLegBay();
  s.addPlankOnLedger(l1.id, 1);
  s.liveLoadPsf = 25;
  assert.ok(Math.abs(s.takeoff().totals.liveLb - 49 * 25) < 1e-6, 'blanket psf over the resolved bay');
  assert.ok(s.generateGuardrails() > 0, 'rails find the deck outline');
});

test('removing the anchor ledger takes its deck with it', () => {
  const { s, l1, l2 } = fourLegBay();
  s.addPlankOnLedger(l1.id, 1);
  s.remove(l2.id);
  assert.equal(s.plankBays().length, 0, 'bay no longer closed, so nothing is decked');
  assert.equal(s.plankPlacements.size, 1, 'placement survives while its own ledger does');
  s.remove(l1.id);
  assert.equal(s.plankPlacements.size, 0, 'pruned with its anchor');
});

test('decks survive a snapshot round trip', () => {
  const { s, l1 } = fourLegBay();
  s.addPlankOnLedger(l1.id, 1);
  const snap = s.snapshot();
  const fresh = new ScaffoldState({ snapStep: 1 });
  fresh.restore(snap);
  assert.equal(fresh.plankPlacements.size, 1);
  assert.equal(fresh.plankBays().length, 1);
});

test('rectangle decks from the block tool still work alongside placements', () => {
  const { s, l1 } = fourLegBay();
  const n = s.nodes().filter(v => v.level === 1);
  const a = n.find(p => p.x === 0 && p.y === 0), d = n.find(p => p.x === 7 && p.y === 7);
  s.addPlank([a.x, a.y, a.z], [d.x, d.y, d.z]);
  s.addPlankOnLedger(l1.id, 1);
  assert.equal(s.plankBays().length, 2, 'both kinds of deck are reported');
});

// --- standard target height -------------------------------------------------

test('a typed height plans a stack from catalog sizes', () => {
  const lengths = CATALOG.standards.parts.map(p => p.lengthFt);
  const plan = planStandardSegmentsForHeight(19.6875, lengths);
  assert.ok(plan.length > 1, `expected a multi-segment stack, got ${plan}`);
  const total = plan.reduce((a, b) => a + b, 0);
  assert.ok(total <= 19.6875 + 1e-6, 'never overshoots the target');
  assert.ok(total > 19.6875 - 3, `gets close, got ${total}`);
  for (const len of plan) assert.ok(lengths.includes(len), 'only real catalog sizes');
});

test('a tall target stacks more segments than a short one', () => {
  const lengths = CATALOG.standards.parts.map(p => p.lengthFt);
  const short = planStandardSegmentsForHeight(7, lengths);
  const tall = planStandardSegmentsForHeight(40, lengths);
  const sum = p => p.reduce((a, b) => a + b, 0);
  assert.ok(sum(tall) > sum(short));
  assert.ok(tall.length >= short.length);
});

test('a stack planned for a height carries enough rosettes to brace', () => {
  const lengths = CATALOG.standards.parts.map(p => p.lengthFt);
  const plan = planStandardSegmentsForHeight(19.6875, lengths);
  const s = new ScaffoldState({ snapStep: 1 });
  for (const len of plan) { s.addStandard(0, 0, len); s.addStandard(7, 0, len); }
  const byCol = nodesByColumn(s.nodes());
  const face = buildFaceGraph([...s.standards.values()])[0];
  assert.ok(face, 'two standards 7 ft apart make a face');
  assert.ok(faceBraceTarget(face, byCol, 10, 'ascending'), 'a planned stack is tall enough to brace');
});
