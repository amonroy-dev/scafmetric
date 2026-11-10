import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beamSelfWeight } from '../src/beam-self-weight.js';
import { analyzeBeam } from '../src/beam.js';

test('beam self-weight comes from the section and is converted from lb/ft to kip/ft', () => {
 assert.equal(beamSelfWeight({ W:31 }), 0.031);
 assert.equal(beamSelfWeight({ W:35 }), 0.035);
 const r = analyzeBeam({ spanFt:20, uniformLoadPlf:beamSelfWeight({ W:31 })*1000, Eksi:29000, Iin4:375 });
 assert.equal(r.reactions.leftLb,310);
 assert.equal(r.maxMoment.momentKipFt,1.55);
});
test('missing or invalid beam weight is rejected', () => {
 for (const W of [undefined, 0, -1, NaN, Infinity]) assert.throws(() => beamSelfWeight({ W }));
 assert.throws(() => beamSelfWeight(null));
});
