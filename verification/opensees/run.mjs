// Check the builder's leg loads against OpenSees.
//
//   node verification/opensees/run.mjs            compare, and report
//   node verification/opensees/run.mjs --save     also rewrite reference/*.json
//
// Needs Python with openseespy (pip install openseespy). Point OPENSEES_PYTHON
// at the interpreter if it is not the `python` on the path.
//
// For every scaffold in cases.mjs this builds a structural model from the
// placed parts (model.mjs), has OpenSees solve it (solve.py), and sets the
// vertical reaction at each base beside the leg load the builder reports. The
// "pinned" solution is the load path a tributary takeoff assumes, so the
// builder must equal it to the pound. Where side brackets have a leg behind
// them the builder also levers their load against that leg, and there it must
// equal the "levered" solution, which does the same by statics. The "braced"
// and "rigid" solutions show how far a frame analysis moves from that.

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, beamUnderLegs } from './cases.mjs';
import { buildAnalysisModel } from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
const save = process.argv.includes('--save');
const python = process.env.OPENSEES_PYTHON || 'python';
// The builder must match the solution it is held to this closely, in pounds.
const TOLERANCE_LB = 0.01;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const built = {};
for (const [name, make] of Object.entries(CASES)) {
  const state = make();
  const model = buildAnalysisModel(state);
  built[name] = { state, model };
  writeFileSync(join(out, `${name}.model.json`), JSON.stringify(model));
}

const solved = spawnSync(python, [join(here, 'solve.py'), out], { encoding: 'utf8' });
if (solved.status !== 0) {
  console.error(solved.stdout, solved.stderr);
  throw new Error(`OpenSees did not run (${python}). Install it with: pip install openseespy`);
}

const lb = v => (Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2)).padStart(9);
let worst = 0;
const summary = [];

for (const [name, { state, model }] of Object.entries(built)) {
  const result = JSON.parse(readFileSync(join(out, `${name}.reactions.json`), 'utf8'));
  // What the builder is held to: the levered solution where there is one.
  const heldTo = result.variants.levered ? 'levered' : 'pinned';
  const pinned = result.variants[heldTo];
  const takeoff = state.takeoff();
  const legs = takeoff.legs.map(l => ({ id: l.id, x: l.x, y: l.y, deadLb: l.deadLb, liveLb: l.liveLb }));
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

  console.log(`\n=== ${name} ===`);
  for (const note of model.notes) console.log(`  note: ${note}`);
  console.log(`  weight in the model: dead ${model.totals.deadLb.toFixed(2)} lb, live ${model.totals.liveLb.toFixed(2)} lb`
    + (model.totals.unsupportedLb ? `, NOT CARRIED ${model.totals.unsupportedLb.toFixed(2)} lb` : ''));
  console.log(`  OpenSees reactions:  dead ${sum(pinned.dead).toFixed(2)} lb, live ${sum(pinned.live).toFixed(2)} lb (${heldTo})`);
  console.log(`  builder leg loads:   dead ${takeoff.totals.deadLb.toFixed(2)} lb, live ${takeoff.totals.liveLb.toFixed(2)} lb`);
  console.log('  leg        x      y |  dead: builder  OpenSees      diff |  live: builder  OpenSees      diff');
  let caseWorst = 0;
  for (const leg of legs) {
    const dDead = leg.deadLb - pinned.dead[leg.id], dLive = leg.liveLb - pinned.live[leg.id];
    caseWorst = Math.max(caseWorst, Math.abs(dDead), Math.abs(dLive));
    console.log(`  ${leg.id.padEnd(5)} ${String(leg.x).padStart(6)} ${String(leg.y).padStart(6)} |       ${lb(leg.deadLb)} ${lb(pinned.dead[leg.id])} ${lb(dDead)} |       ${lb(leg.liveLb)} ${lb(pinned.live[leg.id])} ${lb(dLive)}`);
  }
  worst = Math.max(worst, caseWorst);

  // What the leverage of the brackets does, against the plain tributary answer.
  if (heldTo === 'levered') {
    const plain = result.variants.pinned;
    let up = { lb: 0 }, down = { lb: 0 }, uplift = 0;
    for (const leg of legs) {
      const base = plain.dead[leg.id] + plain.live[leg.id];
      const moved = pinned.dead[leg.id] + pinned.live[leg.id] - base;
      if (moved > up.lb) up = { lb: moved, pct: 100 * moved / base, leg: leg.id };
      if (moved < down.lb) down = { lb: moved, pct: 100 * moved / base, leg: leg.id };
      if (pinned.dead[leg.id] + pinned.live[leg.id] < 0) uplift++;
    }
    console.log(`  leverage: ${up.leg} gains ${up.lb.toFixed(1)} lb (${up.pct.toFixed(1)}%), ${down.leg} loses ${(-down.lb).toFixed(1)} lb (${(-down.pct).toFixed(1)}%), ${uplift} leg(s) in uplift`);
  }

  // How far the frame solutions move from the one the builder is held to, as
  // the largest change in any leg's total (dead + live) load.
  const frames = {};
  for (const variant of ['braced', 'rigid']) {
    const v = result.variants[variant];
    if (!v || !v.dead || !v.live) continue;
    let most = { lb: 0, pct: 0, leg: null };
    for (const leg of legs) {
      const base = pinned.dead[leg.id] + pinned.live[leg.id];
      const moved = v.dead[leg.id] + v.live[leg.id] - base;
      if (Math.abs(moved) > Math.abs(most.lb)) most = { lb: moved, pct: base ? 100 * moved / base : 0, leg: leg.id };
    }
    frames[variant] = most;
    console.log(`  ${variant.padEnd(6)} frame: the leg that moves most is ${most.leg}, by ${most.lb.toFixed(1)} lb (${most.pct.toFixed(1)}% of its load)`);
  }
  summary.push({ name, legs: legs.length, worst: caseWorst, frames, heldTo });

  if (save) {
    const ref = {
      about: 'Vertical base reactions from OpenSees for the scaffold of this name in cases.mjs. Feet and pounds. Written by run.mjs --save.',
      opensees: result.opensees,
      legs: legs.map(l => ({ id: l.id, x: l.x, y: l.y })),
      totals: { deadLb: model.totals.deadLb, liveLb: model.totals.liveLb },
      variants: result.variants,
    };
    mkdirSync(join(here, 'reference'), { recursive: true });
    writeFileSync(join(here, 'reference', `${name}.json`), `${JSON.stringify(ref, null, 1)}\n`);
  }
}

let beamMatches = false;
// --- the beam under a row of those legs ---------------------------------------
// The other half of "the loads we provide": the legs become point loads on a
// beam, and the beam check reports its reactions, moment and deflection. The
// same beam is solved in OpenSees.
{
  const beamCase = beamUnderLegs(built['three-bay-run-braced'].state);
  const file = join(out, 'beam.json');
  writeFileSync(file, JSON.stringify(beamCase.input));
  const beamSolved = spawnSync(python, [join(here, 'solve_beam.py'), file], { encoding: 'utf8' });
  if (beamSolved.status !== 0) { console.error(beamSolved.stdout, beamSolved.stderr); throw new Error('OpenSees did not solve the beam'); }
  const ref = JSON.parse(readFileSync(join(out, 'beam.result.json'), 'utf8'));
  const a = beamCase.analysis;
  console.log('\n=== beam under the front legs of three-bay-run-braced ===');
  console.log(`  ${beamCase.input.spanFt} ft span, ${beamCase.input.uniformLoadPlf} plf self weight, legs at ${beamCase.input.pointLoads.map(p => `${p.locationFt} ft (${p.loadLb.toFixed(1)} lb)`).join(', ')}`);
  console.log(`  reactions, lb:   builder ${a.reactions.leftLb.toFixed(3)} / ${a.reactions.rightLb.toFixed(3)}   OpenSees ${ref.leftLb.toFixed(3)} / ${ref.rightLb.toFixed(3)}`);
  let worstMoment = 0, worstDeflection = 0;
  console.log('     x ft |  moment lb-in: builder     OpenSees |  deflection in: builder    OpenSees');
  for (const s of ref.stations) {
    const here_ = a.at(s.xFt);
    worstMoment = Math.max(worstMoment, Math.abs(here_.momentLbIn - s.momentLbIn));
    worstDeflection = Math.max(worstDeflection, Math.abs(here_.reducedDeflectionIn - s.deflectionIn));
    console.log(`  ${s.xFt.toFixed(2).padStart(7)} |          ${here_.momentLbIn.toFixed(2).padStart(12)} ${s.momentLbIn.toFixed(2).padStart(12)} |           ${here_.reducedDeflectionIn.toFixed(6).padStart(10)}  ${s.deflectionIn.toFixed(6).padStart(10)}`);
  }
  const worstReaction = Math.max(Math.abs(a.reactions.leftLb - ref.leftLb), Math.abs(a.reactions.rightLb - ref.rightLb));
  console.log(`  largest difference: reaction ${worstReaction.toExponential(1)} lb, moment ${worstMoment.toExponential(1)} lb-in, deflection ${worstDeflection.toExponential(1)} in`);
  const beamOk = worstReaction < 0.01 && worstMoment < 0.5 && worstDeflection < 1e-6;
  if (!beamOk) worst = Math.max(worst, 1);
  beamMatches = beamOk;
  if (save) {
    writeFileSync(join(here, 'reference', 'beam-under-front-legs.json'), `${JSON.stringify({
      about: 'A beam under the front legs of three-bay-run-braced, solved by OpenSees. Written by run.mjs --save.',
      input: beamCase.input, ...ref,
    }, null, 1)}\n`);
  }
}

console.log('\n=== summary ===');
for (const s of summary) {
  const frames = Object.entries(s.frames).map(([k, v]) => `${k} ${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(1)}%`).join(', ');
  console.log(`  ${s.name.padEnd(32)} ${String(s.legs).padStart(3)} legs   builder vs ${s.heldTo.padEnd(7)}: ${s.worst < TOLERANCE_LB ? 'matches' : `OFF BY ${s.worst.toFixed(2)} lb`}${frames ? `   frames: ${frames}` : ''}`);
}
console.log(`  beam under the front legs      reactions, moment and deflection: ${beamMatches ? 'match' : 'DO NOT MATCH'}`);
console.log(worst < TOLERANCE_LB
  ? `\nEvery leg, dead and live, matches OpenSees to within ${TOLERANCE_LB} lb, and so does the beam.`
  : `\nThe builder is off against OpenSees: see above.`);
if (save) console.log('Reference reactions written to verification/opensees/reference/.');
process.exitCode = worst < TOLERANCE_LB ? 0 : 1;
