// Live loads placed on decked bays, attributed one way as RISA-3D attributes a
// one-way member area load: along the boards by default, or across them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLiveLoadPlacement, forEachLiveLoadMemberLoad, buildDeckLoadPreview, deckSpanIsSupported,
  connectedDecks, pickDeckWithRay, liveLoadsByDeck, DEFAULT_BAY_LIVE_LOAD_PSF,
} from '../src/scaffold/workspace/liveloads.js';
import { deckFrameFromRect, rectDeckRunsAlongX } from '../src/scaffold/workspace/planks.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';

const SEG = 6.5625;
const close = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, wanted ${b}`);

/**
 * One bay, `w` by `d` ft, as the Block tool lays it: a leg at each corner,
 * a ledger along all four sides at lift 1, and a rectangle deck on them.
 * `extraLegs` adds legs along the y = 0 side, which splits that ledger.
 */
function blockBay({ w = 7, d = 3, extraLegs = [] } = {}) {
  const s = new ScaffoldState({ snapStep: 0, components: { plank: { areaWeightLbPerFt2: 0 } } });
  const xs = [0, ...extraLegs, w];
  for (const x of xs) s.addStandard(x, 0, SEG);
  s.addStandard(0, d, SEG);
  s.addStandard(w, d, SEG);
  const z = s.liftZ(1);
  const ledgers = { front: [], back: null, left: null, right: null };
  for (let i = 0; i < xs.length - 1; i++) ledgers.front.push(s.addLedger([xs[i], 0, z], [xs[i + 1], 0, z]));
  ledgers.back = s.addLedger([0, d, z], [w, d, z]);
  ledgers.left = s.addLedger([0, 0, z], [0, d, z]);
  ledgers.right = s.addLedger([w, 0, z], [w, d, z]);
  const deck = s.addPlank([0, 0, z], [w, d, z]);
  return { s, z, deck, ledgers };
}
const liveAt = (s, x, y) => s.takeoff().legs.find(l => Math.abs(l.x - x) < 1e-6 && Math.abs(l.y - y) < 1e-6).liveLb;

/** What each ledger ends up carrying, by id. */
function memberLoads(s, load) {
  const ledgers = s.ledgerList();
  const resolved = resolveLiveLoadPlacement(load, ledgers, s.plankBays());
  const byLedger = new Map();
  let unsupported = 0;
  forEachLiveLoadMemberLoad(resolved, ledgers,
    (ledger, point, lb) => byLedger.set(ledger.id, (byLedger.get(ledger.id) || 0) + lb),
    (point, lb) => { unsupported += lb; });
  return { byLedger, unsupported, resolved };
}

test('light duty, 25 psf, is the load a bay gets unless another is typed', () => {
  assert.equal(DEFAULT_BAY_LIVE_LOAD_PSF, 25);
  const { s, deck } = blockBay();
  assert.equal(s.setDeckLiveLoad(deck.id).psf, 25);
});

test('a deck knows its rectangle and the way its boards run', () => {
  const long = { x0: 0, y0: 0, x1: 7, y1: 3, z: 6 };
  assert.equal(rectDeckRunsAlongX(long), true, 'boards run the long way');
  const f = deckFrameFromRect(long);
  assert.deepEqual([f.along, f.alongFt, f.across, f.acrossFt], [{ x: 1, y: 0 }, 7, { x: 0, y: 1 }, 3]);
  assert.deepEqual([f.center, f.z], [{ x: 3.5, y: 1.5 }, 6]);
  const tall = deckFrameFromRect({ x0: 0, y0: 0, x1: 3, y1: 7, z: 6 });
  assert.deepEqual([tall.along, tall.alongFt, tall.acrossFt], [{ x: 0, y: 1 }, 7, 3]);

  // A deck hung on a ledger runs from that ledger to its opposite.
  const s = new ScaffoldState({ snapStep: 0 });
  const front = s.addLedger([0, 0, 5], [3, 0, 5]);
  s.addLedger([0, 7, 5], [3, 7, 5]);
  s.addPlankOnLedger(front.id, 1);
  const hung = s.plankBays()[0].frame;
  close(hung.along.x, 0, 'boards run square to the ledger');
  close(hung.along.y, 1, 'toward the opposite ledger');
  assert.deepEqual([hung.alongFt, hung.acrossFt, hung.center, hung.z], [7, 3, { x: 1.5, y: 3.5 }, 5]);
});

test('a planked bay carries no live load until one is placed on it', () => {
  // Two decked bays side by side; only one is loaded.
  const s = new ScaffoldState({ snapStep: 0, components: { plank: { areaWeightLbPerFt2: 0 } } });
  for (const x of [0, 7, 14]) for (const y of [0, 3]) s.addStandard(x, y, SEG);
  const z = s.liftZ(1);
  for (const x of [0, 7, 14]) s.addLedger([x, 0, z], [x, 3, z]);
  const first = s.addPlank([0, 0, z], [7, 3, z]);
  s.addPlank([7, 0, z], [14, 3, z]);

  assert.equal(s.takeoff().totals.liveLb, 0, 'planked, not loaded: no live load at all');
  s.setDeckLiveLoad(first.id, 25);
  const t = s.takeoff();
  close(t.totals.liveLb, 21 * 25, 'the one loaded bay, and nothing for the other');
  close(liveAt(s, 14, 0), 0, 'a leg of the bay left unloaded');
  close(liveAt(s, 14, 3), 0, 'and its other leg');
});

test('by default the load spans along the boards, onto the ledgers at their ends', () => {
  const { s, deck, ledgers } = blockBay();
  const load = s.setDeckLiveLoad(deck.id, 25);
  assert.ok(load && load.deckId === deck.id && load.across === false);

  const patch = s.liveLoadPatches()[0];
  assert.deepEqual(patch.span, [1, 0], 'the span is the way the boards run');
  assert.deepEqual([patch.widthFt, patch.lengthFt, patch.areaSqFt, patch.totalLb], [7, 3, 21, 525]);

  const { byLedger, unsupported } = memberLoads(s, load);
  close(byLedger.get(ledgers.left.id), 262.5, 'half on the ledger under one end of the boards');
  close(byLedger.get(ledgers.right.id), 262.5, 'half on the ledger under the other');
  assert.equal(byLedger.has(ledgers.back.id), false, 'none on the ledgers the boards run beside');
  assert.equal(byLedger.has(ledgers.front[0].id), false);
  assert.equal(unsupported, 0);
});

test('turned across the boards, the same load goes to the other pair of ledgers', () => {
  const { s, deck, ledgers } = blockBay();
  const load = s.setDeckLiveLoad(deck.id, 25, true);
  const patch = s.liveLoadPatches()[0];
  assert.deepEqual(patch.span, [0, 1]);
  assert.deepEqual([patch.widthFt, patch.lengthFt, patch.totalLb], [3, 7, 525], 'same bay, same total');

  const { byLedger } = memberLoads(s, load);
  close(byLedger.get(ledgers.front[0].id), 262.5, 'half on one long ledger');
  close(byLedger.get(ledgers.back.id), 262.5, 'half on the other');
  assert.equal(byLedger.has(ledgers.left.id), false);
  assert.equal(byLedger.has(ledgers.right.id), false);
});

test('the direction changes which legs carry the load', () => {
  // A leg under the middle of the front ledger. Along the boards the load
  // lands on the end ledgers and that leg carries none of it; across them it
  // comes down the front ledgers and the middle leg takes the most.
  const along = blockBay({ extraLegs: [3.5] });
  along.s.setDeckLiveLoad(along.deck.id, 25, false);
  close(along.s.takeoff().totals.liveLb, 525, 'all of it reaches the legs');
  close(liveAt(along.s, 3.5, 0), 0, 'middle leg, along the boards');
  for (const [x, y] of [[0, 0], [7, 0], [0, 3], [7, 3]]) close(liveAt(along.s, x, y), 131.25, `corner ${x},${y}`);

  const across = blockBay({ extraLegs: [3.5] });
  across.s.setDeckLiveLoad(across.deck.id, 25, true);
  close(across.s.takeoff().totals.liveLb, 525, 'all of it reaches the legs');
  close(liveAt(across.s, 3.5, 0), 131.25, 'middle leg, across the boards');
  close(liveAt(across.s, 0, 0), 65.625, 'front corner');
  close(liveAt(across.s, 7, 0), 65.625, 'front corner');
  close(liveAt(across.s, 0, 3), 131.25, 'back corner');
  close(liveAt(across.s, 7, 3), 131.25, 'back corner');
});

test('each piece splits by how far the other ledger is, as a simply supported deck', () => {
  // A ledger across the bay 2 ft from one end: the short span and the long one
  // each share their own load, and the middle ledger takes half of both.
  const { s, z, deck, ledgers } = blockBay();
  const mid = s.addLedger([2, 0, z], [2, 3, z]);
  const { byLedger } = memberLoads(s, s.setDeckLiveLoad(deck.id, 100));
  close(byLedger.get(ledgers.left.id), 100 * 3 * 2 / 2, 'half of the 2 ft span');
  close(byLedger.get(mid.id), 100 * 3 * (2 + 5) / 2, 'half of each span');
  close(byLedger.get(ledgers.right.id), 100 * 3 * 5 / 2, 'half of the 5 ft span');
});

test('with no ledger one way along the span, the load goes two-way and none is lost', () => {
  const { s, deck, ledgers } = blockBay();
  const load = s.setDeckLiveLoad(deck.id, 25);
  s.remove(ledgers.right.id);
  assert.equal(s.liveLoads.size, 1, 'the deck is still there, so is its load');

  const { byLedger, unsupported } = memberLoads(s, load);
  const total = [...byLedger.values()].reduce((a, b) => a + b, 0);
  close(total, 525, 'all of it is carried');
  assert.equal(unsupported, 0);
  assert.ok(byLedger.get(ledgers.left.id) > 0, 'the end ledger that is left carries some');
  assert.ok(byLedger.get(ledgers.back.id) > 0 && byLedger.get(ledgers.front[0].id) > 0, 'and so do the ledgers either side');
  close(byLedger.get(ledgers.back.id), byLedger.get(ledgers.front[0].id), 'evenly, the bay being symmetric');
  close(s.takeoff().totals.liveLb, 525, 'and all of it reaches the legs');

  // No ledger at all under the deck: the load still weighs on the legs.
  for (const l of s.ledgerList()) s.remove(l.id);
  const bare = memberLoads(s, load);
  close(bare.unsupported, 525, 'nothing to carry it');
  close(s.takeoff().totals.liveLb, 525, 'so it goes to the nearest legs');
});

test('a bay with ledgers on two sides only carries its load one way only', () => {
  const s = new ScaffoldState({ snapStep: 0 });
  const front = s.addLedger([0, 0, 5], [3, 0, 5]);
  s.addLedger([0, 7, 5], [3, 7, 5]);
  s.addPlankOnLedger(front.id, 1);
  const deck = s.plankBays()[0];
  assert.equal(deckSpanIsSupported(deck, s.ledgerList(), false), true, 'along the boards: onto its two ledgers');
  assert.equal(deckSpanIsSupported(deck, s.ledgerList(), true), false, 'across: nothing there');

  const block = blockBay();
  const bay = block.s.plankBays()[0];
  assert.equal(deckSpanIsSupported(bay, block.s.ledgerList(), false), true);
  assert.equal(deckSpanIsSupported(bay, block.s.ledgerList(), true), true, 'four ledgers: either way');
});

test('a load on a hung deck matches the older ledger-anchored patch on the same bay', () => {
  const build = () => {
    const s = new ScaffoldState({ snapStep: 0, components: { plank: { areaWeightLbPerFt2: 0 } } });
    for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7]]) s.addStandard(x, y, SEG);
    const z = s.liftZ(1);
    const front = s.addLedger([0, 0, z], [7, 0, z]);
    s.addLedger([0, 7, z], [7, 7, z]);
    return { s, front };
  };
  const older = build();
  older.s.addLiveLoad(older.front.id, 1, 50);
  const now = build();
  const deck = now.s.addPlankOnLedger(now.front.id, 1);
  now.s.setDeckLiveLoad(deck.id, 50);

  const a = older.s.takeoff(), b = now.s.takeoff();
  close(b.placedLiveLb, a.placedLiveLb, 'same load');
  for (const leg of a.legs) close(liveAt(now.s, leg.x, leg.y), leg.liveLb, `leg ${leg.x},${leg.y}`);
});

test('loading a bay again changes its load; the same again changes nothing', () => {
  const { s, deck } = blockBay();
  const first = s.setDeckLiveLoad(deck.id, 25);
  assert.equal(s.setDeckLiveLoad(deck.id, 25), null, 'already loaded that way');
  assert.equal(s.liveLoads.size, 1);

  const heavier = s.setDeckLiveLoad(deck.id, 75);
  assert.equal(heavier.id, first.id, 'the same load, changed');
  assert.equal(s.liveLoads.size, 1, 'never two loads on one bay');
  close(s.takeoff().placedLiveLb, 21 * 75, 'new magnitude');

  const turned = s.setDeckLiveLoad(deck.id, 75, true);
  assert.equal(turned.id, first.id);
  assert.equal(s.liveLoads.get(first.id).across, true);
  assert.equal(s.setLiveLoadAcross(first.id, true), false, 'already across');
  assert.equal(s.setLiveLoadAcross(first.id, false), true);
  assert.equal(s.liveLoads.get(first.id).across, false);

  s.undo(); s.undo(); s.undo();
  assert.deepEqual([s.liveLoads.get(first.id).psf, s.liveLoads.get(first.id).across], [25, false], 'each change undoes');
  assert.equal(s.setDeckLiveLoad('no-such-deck', 25), null, 'a load needs a deck to sit on');
});

test('an older patch lying over a deck is replaced, not doubled', () => {
  const { s, deck, ledgers } = blockBay();
  const older = s.addLiveLoad(ledgers.left.id, -1, 50); // spans from the left ledger to the right one
  assert.ok(older, 'older patch placed');
  assert.equal(s.liveLoadsByDeck().get(deck.id).id, older.id, 'it counts as this deck\'s load');

  const load = s.setDeckLiveLoad(deck.id, 25);
  assert.equal(s.liveLoads.size, 1);
  assert.equal(s.liveLoads.has(older.id), false);
  assert.equal(load.deckId, deck.id);
  close(s.takeoff().placedLiveLb, 525, 'one load on the bay');
});

test('a load goes when its deck goes, and comes back with undo', () => {
  const { s, deck } = blockBay();
  s.setDeckLiveLoad(deck.id, 25);
  s.remove(deck.id);
  assert.equal(s.liveLoads.size, 0, 'no deck, no load');
  assert.equal(s.takeoff().totals.liveLb, 0);
  s.undo();
  assert.equal(s.liveLoads.size, 1);
  assert.equal(s.liveLoadPatches().length, 1);

  // A hung deck goes with its ledger, and its load with it.
  const h = new ScaffoldState({ snapStep: 0 });
  const front = h.addLedger([0, 0, 5], [3, 0, 5]);
  h.addLedger([0, 7, 5], [3, 7, 5]);
  const hung = h.addPlankOnLedger(front.id, 1);
  h.setDeckLiveLoad(hung.id, 25);
  h.remove(front.id);
  assert.equal(h.plankPlacements.size, 0);
  assert.equal(h.liveLoads.size, 0);
});

test('a run of bays is loaded in one step', () => {
  const s = new ScaffoldState({ snapStep: 0, components: { plank: { areaWeightLbPerFt2: 0 } } });
  const z = 5;
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(s.addPlank([i * 7, 0, z], [i * 7 + 7, 3, z]).id);
  const placed = s.setDeckLiveLoads(ids.map(deckId => ({ deckId, psf: 50, across: false })));
  assert.equal(placed.length, 3);
  assert.equal(s.liveLoads.size, 3);
  assert.equal(s.setDeckLiveLoads(ids.map(deckId => ({ deckId, psf: 50 }))).length, 0, 'nothing left to change');
  s.undo();
  assert.equal(s.liveLoads.size, 0, 'one undo takes the whole run back');
});

test('a load keeps its direction through a save and reload', () => {
  const { s, deck } = blockBay();
  s.setDeckLiveLoad(deck.id, 60, true);
  const fresh = new ScaffoldState({ snapStep: 0 });
  fresh.restore(s.snapshot());
  const ll = [...fresh.liveLoads.values()][0];
  assert.deepEqual([ll.deckId, ll.psf, ll.across], [deck.id, 60, true]);
  assert.deepEqual(fresh.liveLoadPatches()[0].span, [0, 1]);
  close(fresh.takeoff().placedLiveLb, 21 * 60, 'and its load');
});

test('SHIFT takes the decks joined edge to edge at that lift, and no others', () => {
  const rect = (id, x0, y0, x1, y1, z = 5) => ({ id, x0, y0, x1, y1, z });
  const decks = [
    rect('a', 0, 0, 7, 3), rect('b', 7, 0, 14, 3), rect('c', 14, 0, 21, 3),
    rect('d', 0, 3, 7, 6), rect('e', 7, 3, 14, 6),
    rect('corner', 21, 3, 28, 6),      // touches c at a corner only
    rect('above', 0, 0, 7, 3, 11.5),   // the same bay, a level up
    rect('island', 40, 0, 47, 3),
  ];
  const ids = connectedDecks(decks[0], decks).map(d => d.id);
  assert.equal(ids[0], 'a', 'the one pointed at comes first');
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(connectedDecks(decks[7], decks).map(d => d.id), ['island']);
});

test('the pointer picks the nearest deck its ray passes through', () => {
  const lower = { id: 'lower', frame: deckFrameFromRect({ x0: 0, y0: 0, x1: 7, y1: 3, z: 5 }) };
  const upper = { id: 'upper', frame: deckFrameFromRect({ x0: 0, y0: 0, x1: 7, y1: 3, z: 11.5 }) };
  const decks = [lower, upper];
  const down = (x, y) => ({ origin: { x, y, z: 50 }, direction: { x: 0, y: 0, z: -1 } });

  assert.equal(pickDeckWithRay(down(3.5, 1.5), decks).deck.id, 'upper', 'from above, the top deck');
  assert.equal(pickDeckWithRay({ origin: { x: 3.5, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, decks).deck.id, 'lower', 'from below, the bottom one');
  assert.equal(pickDeckWithRay(down(9, 1.5), decks), null, 'past the end of the deck');
  assert.equal(pickDeckWithRay(down(3.5, 3.4), decks), null, 'off its side');
  assert.equal(pickDeckWithRay({ origin: { x: -5, y: 1.5, z: 5 }, direction: { x: 1, y: 0, z: 0 } }, decks), null, 'level with the decks');
  // Slanting under the upper deck onto the lower one.
  const slant = { origin: { x: -10, y: 1.5, z: 10 }, direction: { x: 0.9, y: 0, z: -0.3 } };
  const hit = pickDeckWithRay(slant, decks);
  assert.equal(hit.deck.id, 'lower');
  assert.ok(hit.point.x > 0 && hit.point.x < 7);
});

test('the preview is the patch the load would draw', () => {
  const { s, deck } = blockBay();
  const bay = s.plankBays().find(d => d.id === deck.id);
  const along = buildDeckLoadPreview(bay, 40, false).liveLoad;
  assert.deepEqual([along.span, along.widthFt, along.lengthFt, along.psf, along.totalLb], [[1, 0], 7, 3, 40, 840]);
  const across = buildDeckLoadPreview(bay, 40, true).liveLoad;
  assert.deepEqual([across.span, across.widthFt, across.lengthFt], [[0, 1], 3, 7]);
  assert.ok(along.center[2] > bay.z, 'drawn just above the deck');
  assert.equal(liveLoadsByDeck([], [], [bay]).size, 0);
});
