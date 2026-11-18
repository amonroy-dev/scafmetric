// The base collar's rosette as lift 0, and side brackets as ScaffoldPro builds
// them: a framed bracket whose tip rosette ledgers and braces can use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { inchesToFeet, BASE_COLLAR, buildBaseAssembly } from '../src/scaffold/workspace/parts.js';
import { planBlock } from '../src/scaffold/workspace/planning.js';
import { buildCenterlineModel, LAYERS } from '../src/scaffold/workspace/dxf.js';
import { faceBraceTarget, nodesByColumn, planPerimeterBraces, buildFaceGraph } from '../src/scaffold/workspace/braces.js';
import { bracketWeightLb } from '../src/scaffold/workspace/bom.js';

// Tools listens on window and draws into a scene; neither needs a browser here.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function toolsFor(state) {
  const el = { addEventListener() {}, removeEventListener() {} };
  return new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, state);
}

const SEG = 9.84375; // 9 ft 10 1/8 in: six rosettes
const at = (s, x, y, level) => s.nodes().find(n => !n.bracketId && n.x === x && n.y === y && n.level === level);

test('the base collar carries lift 0, one rosette spacing below the standard\'s first', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  const collar = at(s, 0, 0, 0);
  const first = at(s, 0, 0, 1);
  assert.ok(collar, 'a node on the collar');
  assert.ok(Math.abs(first.z - (s.baseOffsetFt() + inchesToFeet(15.75))) < 1e-9, 'lift 1 is the standard\'s first rosette');
  assert.ok(Math.abs(first.z - collar.z - inchesToFeet(19.6875)) < 1e-9, 'one spacing apart');
  // ScaffoldPro: the collar's rosette is 3 1/16 in above the top of the jack.
  const jackTop = s.baseOffsetFt() - inchesToFeet(BASE_COLLAR.heightIn);
  assert.ok(Math.abs(collar.z - jackTop - inchesToFeet(3.0625)) < 1e-9);

  s.setBase({ showBaseCollar: false });
  assert.equal(s.nodes().filter(n => n.level === 0).length, 0, 'no collar, no lift 0');
  assert.ok(at(s, 0, 0, 1), 'the standard keeps its numbering');
});

test('a ledger can run between two collar rosettes', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  s.addStandard(7, 0, SEG);
  const t = toolsFor(s).ledgerTargetFor(at(s, 0, 0, 0));
  assert.ok(t && t.x === 7 && t.level === 0, 'targets the neighbour\'s collar');
});

test('the collar is drawn as a tube over the jack and a sleeve round the standard\'s foot', () => {
  const { meshes, topZ } = buildBaseAssembly({ x: 0, y: 0, jackExtensionIn: 6, showWoodSill: true, showBaseCollar: true });
  const collar = meshes.filter(m => m.userData.part === 'base-collar');
  assert.equal(collar.length, 2);
  const radii = collar.map(m => m.scale.x * 12 * 2).sort((a, b) => a - b);
  assert.ok(Math.abs(radii[0] - 1.9) < 1e-9 && Math.abs(radii[1] - 2.25) < 1e-9, `tube 1.9 in, sleeve 2.25 in, got ${radii}`);
  const sleeve = collar.find(m => Math.abs(m.scale.x * 24 - 2.25) < 1e-9);
  const bottom = sleeve.position.z - sleeve.scale.z / 2, top = sleeve.position.z + sleeve.scale.z / 2;
  assert.ok(bottom < topZ && top > topZ, 'the sleeve straddles the standard\'s base');
});

function bracketedPair(levels = [2]) {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const x of [0, 7]) { s.addStandard(x, 0, SEG); s.addStandard(x, 0, SEG); }
  for (const level of levels) for (const x of [0, 7]) s.addBracket(at(s, x, 0, level), [0, -1], 3);
  return s;
}

test('a side bracket adds a rosette at its tip, at the lift it hangs on', () => {
  const s = bracketedPair([2]);
  const tips = s.nodes().filter(n => n.bracketId);
  assert.equal(tips.length, 2);
  const host = at(s, 0, 0, 2);
  const tip = tips.find(n => Math.abs(n.x) < 1e-9);
  assert.ok(Math.abs(tip.y + 3) < 1e-9 && Math.abs(tip.z - host.z) < 1e-9, '3 ft out, level with its rosette');
  assert.equal(tip.level, 2);
});

test('a ledger from a bracket tip runs along the bracket row, not back to its standard', () => {
  const s = bracketedPair([2]);
  const tools = toolsFor(s);
  const tip = s.nodes().find(n => n.bracketId && Math.abs(n.x) < 1e-9);
  const t = tools.ledgerTargetFor(tip);
  assert.ok(t && t.bracketId && Math.abs(t.x - 7) < 1e-9, `targets the next tip, got ${JSON.stringify(t)}`);
  const fromHost = tools.ledgerTargetFor(at(s, 0, 0, 2));
  assert.ok(fromHost && !fromHost.bracketId && fromHost.x === 7, 'the standard still runs to its neighbour');
});

test('a brace can climb between bracket tips hung four lifts apart', () => {
  const s = bracketedPair([2, 6]);
  const faces = toolsFor(s)._faces();
  const row = faces.filter(f => f.tipRow);
  assert.equal(row.length, 1, 'one face along the row of tips');
  const t = faceBraceTarget(row[0], nodesByColumn(s.nodes()), 8, 'ascending');
  assert.ok(t, 'a diagonal fits');
  assert.deepEqual([t.levelA, t.levelB].sort(), [2, 6]);
  assert.ok(Math.abs(t.a[1] + 3) < 0.25 && Math.abs(t.b[1] + 3) < 0.25, 'on the tips, 3 ft out');
});

test('brackets at one lift add no brace faces and leave the standards\' perimeter alone', () => {
  const s = bracketedPair([2]);
  const faces = toolsFor(s)._faces();
  assert.equal(faces.filter(f => f.tipRow).length, 0, 'nothing to brace between single tips');
  const standards = [...s.standards.values()];
  const plain = planPerimeterBraces(buildFaceGraph(standards), s.nodes(), { standards, targetZ: 6 });
  const stacked = bracketedPair([2, 6]);
  const withRow = planPerimeterBraces(toolsFor(stacked)._faces(), stacked.nodes(), { standards: [...stacked.standards.values()], targetZ: 6 });
  assert.equal(withRow.length, plain.length + 1, 'the bracket row adds its own brace; the standards keep theirs');
});

test('the bracket tool cannot hang a bracket off another bracket\'s tip', () => {
  const s = bracketedPair([2]);
  const tools = toolsFor(s);
  tools.setTool('bracket');
  tools.categoryKey = 'brackets';
  const tip = s.nodes().find(n => n.bracketId);
  tools._nearestNode = () => tip;
  const before = s.brackets.size;
  tools._act({ clientX: 0, clientY: 0, shiftKey: false });
  assert.equal(s.brackets.size, before, 'nothing hung off the tip');
  // The same click on a standard's rosette does hang one, so the above is a
  // real refusal and not a tool that places nothing.
  tools._nearestNode = () => at(s, 7, 0, 4);
  tools._act({ clientX: 0, clientY: 0, shiftKey: false });
  assert.equal(s.brackets.size, before + 1, 'a standard\'s rosette takes a bracket');
});

test('a block starts at the base collar\'s rosette when there is one', () => {
  const opts = { x0: 0, y0: 0, x1: 14, y1: 7, heightFt: 19.7, standardLengthsFt: [9.84375, 6.5625], ledgerLengthsFt: [7], maxLevel: 12 };
  const withCollar = planBlock({ ...opts, startLevel: 0 });
  assert.deepEqual(withCollar.levels, [0, 4, 8, 12]);
  assert.ok(withCollar.braces.every(b => b.level % 4 === 0 && b.toLevel === b.level + 4), 'braces between ledgered lifts');
  assert.deepEqual(planBlock({ ...opts, startLevel: 1 }).levels, [1, 5, 9]);
});

test('the line view draws the base assembly and each bracket as its frame', () => {
  const s = bracketedPair([2]);
  const model = buildCenterlineModel(s);
  const jacks = model.segments.filter(x => x.layer === LAYERS.jack);
  assert.equal(jacks.length, 2, 'one base member per standard');
  assert.ok(jacks.every(j => j.start[2] === 0 && Math.abs(j.end[2] - s.baseOffsetFt()) < 1e-9), 'ground to the standard\'s foot');
  const k = [...s.brackets.values()][0];
  const bracket = model.segments.filter(x => x.layer === LAYERS.bracket && x.id === k.id);
  assert.equal(bracket.length, 7, 'chord (2), diagonal (2), post, socket (2)');
  assert.ok(Math.min(...bracket.flatMap(x => [x.start[2], x.end[2]])) < k.z - 2, 'the 3 ft bracket\'s diagonal fixes well below its rosette');
});

test('bracket weight follows the frame\'s tubing', () => {
  const s = new ScaffoldState({});
  assert.ok(bracketWeightLb(3.5, s) > bracketWeightLb(2, s));
  assert.ok(bracketWeightLb(2, s) > 0);
});
