// The scaffolds the leg-load check is run on.
//
// Each is built through the builder's own calls, the Block tool included, so
// what is checked is what a user gets. Between them they cover: one bay and
// many, one planked level and two, square bays and long ones, bracing, rails,
// brackets and trusses, a leg under the middle of a ledger, decks hung on
// ledgers with the Plank tool, loads turned across the boards, different loads
// side by side, and bays left unloaded.

import * as THREE from 'three';
import { ScaffoldState } from '../../src/scaffold/workspace/state.js';
import { CATALOG } from '../../src/scaffold/workspace/catalog.js';
import { analyzeBeam } from '../../src/beam.js';
import { beamFromSupports, mapLegsToBeam, toBeamPointLoads } from '../../src/scaffold/legloads.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../../src/scaffold/workspace/tools.js');

function toolsFor(state) {
  const el = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  return new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, camera: new THREE.PerspectiveCamera(), invalidate() {} }, state);
}

/** Blocks as the Block tool places them: [{ settings, at: [x, y], turns }]. */
function blocks(list) {
  const s = new ScaffoldState({ snapStep: 1 });
  const t = toolsFor(s);
  for (const { settings, at = [0, 0], turns = 0 } of list) {
    t.setBlockSettings({ widthFt: 7, depthFt: 3, heightFt: 10, plankedLevelsCount: 1, includeBaseDeck: false, guardrails: true, braceFrontBack: 'off', braceLeftRight: 'off', ...settings });
    t.placeBlockAt({ plan: t._blockPlan(), center: { x: at[0], y: at[1] }, snapped: false, rotationSteps: turns });
  }
  return s;
}

/** Load decks: `pick(deck)` returns { psf, across } or null to leave the bay unloaded. */
function load(s, pick) {
  const items = [];
  for (const deck of s.plankBays()) {
    const want = pick(deck);
    if (want) items.push({ deckId: deck.id, psf: want.psf, across: !!want.across });
  }
  s.setDeckLiveLoads(items);
  return s;
}
const everyBay = psf => () => ({ psf });

/** Standards at these plan points, each tall enough for a deck at lift 4. */
function bare(points) {
  const s = new ScaffoldState({ snapStep: 0 });
  const len = CATALOG.standards.parts.map(p => p.lengthFt).sort((a, b) => b - a)[0];
  for (const [x, y] of points) s.addStandard(x, y, len);
  return s;
}

export const CASES = {
  // The plainest thing there is: one 7 x 3 ft bay, decked, railed, loaded.
  'single-bay': () => load(blocks([{ settings: {} }]), everyBay(25)),

  // A run of three bays with bracing on every face, loaded throughout.
  'three-bay-run-braced': () => load(
    blocks([{ settings: { widthFt: 21, braceFrontBack: 'slash', braceLeftRight: 'backslash' } }]), everyBay(25)),

  // Two bays by two, two planked levels: 50 psf up top, 25 below, and one of
  // the lower bays turned to span across its boards.
  'two-by-two-two-levels': () => {
    const s = blocks([{ settings: { widthFt: 14, depthFt: 14, heightFt: 20, plankedLevelsCount: 2, braceFrontBack: 'slash' } }]);
    const top = Math.max(...s.plankBays().map(d => d.z));
    let turned = false;
    return load(s, deck => {
      if (Math.abs(deck.z - top) < 0.01) return { psf: 50 };
      const across = !turned;
      turned = true;
      return { psf: 25, across };
    });
  },

  // Two runs stepped by a bay's depth, meeting at one standard. Loaded 25 psf
  // on one run and 75 on the other.
  zigzag: () => load(
    blocks([{ settings: { widthFt: 28 } }, { settings: { widthFt: 28 }, at: [28, -3] }]),
    deck => ({ psf: deck.frame.center.y > -1 ? 25 : 75 })),

  // Six bays in a 3 x 2 grid with only the middle bay of one row loaded, so
  // most legs must come out with no live load at all.
  'one-bay-loaded-of-six': () => load(
    blocks([{ settings: { widthFt: 21, depthFt: 6 } }]),
    deck => (Math.abs(deck.frame.center.x) < 1 && deck.frame.center.y < 0 ? { psf: 75 } : null)),

  // A leg under the middle of the front ledger. Along the boards the load
  // lands on the end ledgers and that leg takes none; across them it takes
  // the most. The two cases differ only in the direction of the load.
  'mid-leg-load-along': () => midLeg(false),
  'mid-leg-load-across': () => midLeg(true),

  // Decks hung on ledgers with the Plank tool rather than laid by a block:
  // two bays, a 25 psf walkway beside a 75 psf loading bay.
  'hung-decks': () => {
    const s = bare([[0, 0], [7, 0], [14, 0], [0, 3], [7, 3], [14, 3]]);
    const z = s.liftZ(4);
    const across = [0, 7, 14].map(x => s.addLedger([x, 0, z], [x, 3, z]));
    for (const y of [0, 3]) for (const x of [0, 7]) s.addLedger([x, y, z], [x + 7, y, z]);
    // The boards run from each 3 ft ledger to the next: side -1 of a ledger
    // drawn toward +y is the +x side.
    const first = s.addPlankOnLedger(across[0].id, -1);
    const second = s.addPlankOnLedger(across[1].id, -1);
    s.setDeckLiveLoads([{ deckId: first.id, psf: 25 }, { deckId: second.id, psf: 75 }]);
    return s;
  },

  // A load placed the older way, hung between two ledgers with no planks under
  // it, as models saved before loads sat on decks still hold. The ledger it
  // hangs from has a leg under its far end only, the opposite one a leg under
  // its middle as well, so the two sides share the load unevenly.
  'older-ledger-patch': () => {
    const s = bare([[0, 0], [7, 0], [0, 3], [3.5, 3], [7, 3]]);
    const z = s.liftZ(4);
    const front = s.addLedger([0, 0, z], [7, 0, z]);
    s.addLedger([0, 3, z], [3.5, 3, z]);
    s.addLedger([3.5, 3, z], [7, 3, z]);
    // Side +1 of a ledger drawn toward +x is the +y side. The patch spans to
    // the nearer of the two back ledgers it overlaps, so it covers half the bay.
    s.addLiveLoad(front.id, 1, 60);
    return s;
  },

  // Dead load only: a braced bay with side brackets hung off one face and a
  // truss across the top, so every kind of part's weight is in the check.
  'brackets-and-truss': () => {
    const s = blocks([{ settings: { heightFt: 13, braceFrontBack: 'slash', braceLeftRight: 'slash' } }]);
    const nodes = s.nodes().filter(n => !n.bracketId);
    const at = (x, y, lift) => nodes.find(n => Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6 && n.level === lift);
    const xs = [...new Set([...s.standards.values()].map(c => c.x))].sort((a, b) => a - b);
    const ys = [...new Set([...s.standards.values()].map(c => c.y))].sort((a, b) => a - b);
    // The top rosette both back standards have, for the truss; a bracket one below it.
    const top = Math.max(...nodes.filter(n => Math.abs(n.x - xs[0]) < 1e-6 && Math.abs(n.y - ys[1]) < 1e-6).map(n => n.level));
    for (const x of xs) s.addBracket(at(x, ys[0], 4), [0, -1], 2);
    s.addBracket(at(xs[0], ys[1], top - 1), [0, 1], 3);
    const a = at(xs[0], ys[1], top), b = at(xs[1], ys[1], top);
    s.addTruss([a.x, a.y, a.z], [b.x, b.y, b.z], 'truss');
    return s;
  },
};

/**
 * A beam under the front row of a scaffold's legs, as Send to beam sets it up:
 * each leg a point load of its dead plus live load, where it stands along the
 * span, on a W12X26 carrying its own weight too. The supports sit a foot and a
 * half outside the end legs. Returns the beam check's input and its analysis.
 */
export function beamUnderLegs(state) {
  const { legs } = state.takeoff();
  const y = Math.min(...legs.map(l => l.y));
  const xs = legs.filter(l => Math.abs(l.y - y) < 1e-6).map(l => l.x);
  const beam = beamFromSupports([Math.min(...xs) - 1.5, y], [Math.max(...xs) + 1.5, y]);
  const { imported } = toBeamPointLoads(mapLegsToBeam(legs, beam));
  const input = {
    spanFt: beam.spanFt, uniformLoadPlf: 26, Eksi: 29000, Iin4: 204, stiffnessFactor: 0.8,
    pointLoads: imported.map(p => ({ loadLb: p.deadLb + p.liveLb, locationFt: p.locationFt })),
  };
  const analysis = analyzeBeam(input);
  // Compared at each leg, at midspan, at the ends and where the beam sags most.
  const stationsFt = [...new Set([0, beam.spanFt / 2, beam.spanFt, analysis.maxDeflection.xFt, ...input.pointLoads.map(p => p.locationFt)]
    .map(x => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);
  return { input: { ...input, stationsFt }, analysis };
}

function midLeg(across) {
  const s = bare([[0, 0], [3.5, 0], [7, 0], [0, 3], [7, 3]]);
  const z = s.liftZ(4);
  s.addLedger([0, 0, z], [3.5, 0, z]);
  s.addLedger([3.5, 0, z], [7, 0, z]);
  s.addLedger([0, 3, z], [7, 3, z]);
  s.addLedger([0, 0, z], [0, 3, z]);
  s.addLedger([7, 0, z], [7, 3, z]);
  const deck = s.addPlank([0, 0, z], [7, 3, z]);
  s.setDeckLiveLoad(deck.id, 50, across);
  return s;
}
