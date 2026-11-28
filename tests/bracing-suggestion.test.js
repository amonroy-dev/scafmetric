import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeBeam } from '../src/beam.js';
import { checkFlexure } from '../src/strength-flexure.js';
import { checkMajorAxisShear } from '../src/strength-shear.js';
import { checkDeflection } from '../src/deflection-check.js';
import { strengthComparisonLoads } from '../src/strength-comparison.js';
import { summarizeChecks } from '../src/check-verdict.js';
import { canConsiderLateralBracing, suggestBraceSpacing, braceLocationsAt, MIN_BRACE_SPACING_FT, MAX_BRACE_SPACING_FT } from '../src/bracing-suggestion.js';
import { screeningInputs, screenSection } from '../src/suggest-beam-size.js';
import { resolveFlangeBracing } from '../src/bracing.js';

const sections = JSON.parse(readFileSync(new URL('../public/data/aisc-w-shapes-v15.json', import.meta.url)));
function fixture({name='W16X31',braces=[0,20],sf=null}={}) {
  const section = sections.find(item => item.AISC_Manual_Label === name);
  const response = load => analyzeBeam({spanFt:20,uniformLoadPlf:load*1000,Eksi:29000,Iin4:section.Ix,stiffnessFactor:.8});
  const flexure = analysis => ({status:'evaluated',...checkFlexure({section,analysis,bracesFt:braces,cbMethod:'unity',Eksi:29000,Fyksi:50,confirmedLateralBracing:true,confirmedScope:true})});
  const shear = analysis => checkMajorAxisShear({section,Eksi:29000,FyKsi:50,demandKip:Math.max(Math.abs(analysis.maxShear.shearLb),Math.abs(analysis.minShear.shearLb))/1000});
  const dead=.2, live=.8, self=section.W/1000;
  const service = response(dead+live+self);
  const checks = {status:'evaluated',flexure:flexure(service),shear:shear(service),deflection:checkDeflection({analysis:service,limitRatio:240})};
  if (sf !== null) {
    const loads = strengthComparisonLoads({dead,live,self,safetyFactor:sf});
    checks.comparisonSelection = 'custom';
    checks.extra = {bending:flexure(response(loads.bending)),shearing:shear(response(loads.shear))};
  }
  return checks;
}

test('unbraced W16X31 bending failure can prompt a lateral-bracing review', () => {
  const checks=fixture();
  assert.equal(checks.flexure.governingSegment.limitState,'elastic LTB');
  assert.ok(checks.flexure.governingSegment.utilization > 1);
  assert.ok(checks.flexure.governingSegment.MmaxKipFt < checks.flexure.MpKipFt/checks.flexure.omegaB);
  assert.equal(canConsiderLateralBracing(checks),true);
  // The default 4:1 comparison is also below this section's fully braced cap.
  assert.equal(canConsiderLateralBracing(fixture({sf:4})),true);
});

test('LTB failure beyond the yielding ceiling cannot be resolved by added lateral braces', () => {
  const checks=fixture({sf:6});
  assert.ok(checks.extra.bending.governingSegment.limitState.endsWith('LTB'));
  assert.ok(checks.extra.bending.governingSegment.MmaxKipFt > checks.extra.bending.MpKipFt/checks.extra.bending.omegaB);
  assert.ok(summarizeChecks(checks).failed.every(item=>item.name.endsWith(' bending')));
  assert.equal(canConsiderLateralBracing(checks),false);
});

test('noncompact-flange local-buckling ceiling suppresses a misleading bracing option', () => {
  const checks=fixture({name:'W21X48',sf:10.57});
  const f=checks.extra.bending;
  assert.ok(f.governingSegment.limitState.endsWith('LTB'));
  assert.ok(f.governingSegment.MmaxKipFt < f.MpKipFt/f.omegaB);
  assert.ok(f.governingSegment.MmaxKipFt > f.flangeLocalBuckling.MnKipFt/f.omegaB);
  assert.ok(summarizeChecks(checks).failed.every(item=>item.name.endsWith(' bending')));
  assert.equal(canConsiderLateralBracing(checks),false);
  const braced=fixture({name:'W21X48',sf:10.57,braces:[0,2,4,6,8,10,12,14,16,18,20]});
  assert.equal(braced.extra.bending.governingSegment.limitState,'flange local buckling');
  assert.equal(canConsiderLateralBracing(braced),false);
});

test('deflection, shear and incomplete checks suppress the lateral-bracing prompt', () => {
  const base=fixture();
  assert.equal(canConsiderLateralBracing({...base,deflection:{...base.deflection,utilization:1.1,meets:false}}),false);
  assert.equal(canConsiderLateralBracing({...base,shear:{...base.shear,utilization:1.1,meets:false}}),false);
  assert.equal(canConsiderLateralBracing({...base,shear:{status:'not_evaluated',reason:'Unsupported'}}),false);
  assert.equal(canConsiderLateralBracing({...base,comparisonSelection:'four'}),false);
  assert.equal(canConsiderLateralBracing({...base,status:'not_requested'}),false);
  assert.equal(canConsiderLateralBracing(null),false);
});

test('passing beam and deflection-only failure do not prompt lateral bracing', () => {
  const checks=fixture({braces:[0,5,10,15,20]});
  assert.equal(summarizeChecks(checks).status,'pass');
  assert.equal(canConsiderLateralBracing(checks),false);
  assert.equal(canConsiderLateralBracing({...checks,deflection:{...checks.deflection,utilization:1.2,meets:false}}),false);
});

test('missing capacities or segment data cannot produce a bracing suggestion', () => {
  const base=fixture();
  for (const changed of [{MpKipFt:NaN},{MpKipFt:0},{omegaB:0},{omegaB:Infinity},{flangeLocalBuckling:{MnKipFt:undefined}},{segments:[]},{segments:null},{segments:[{...base.flexure.segments[0],MmaxKipFt:NaN}]}]) {
    assert.equal(canConsiderLateralBracing({...base,flexure:{...base.flexure,...changed}}),false);
  }
});

// --- suggestBraceSpacing: the spacing to suggest, checked the way the calculator checks it.

const W = name => sections.find(item => item.AISC_Manual_Label === name);
// The calculator's defaults: 20 ft, 200 lb/ft dead and 800 lb/ft live, the 4:1
// comparison, L/240 at 0.8 EI, Cb = 1.
const beam = { spanFt:20, deadLoadKipFt:.2, liveLoadKipFt:.8, safetyFactor:4, deflectionLimitRatio:240, stiffnessFactor:.8, cbMethod:'unity', Eksi:29000, confirmedLateralBracing:true, confirmedScope:true };
// Whether the calculator's own checks pass this section with braces at `at` (both flanges).
const passesWith = (name, at, input = beam) => screenSection(W(name), screeningInputs(input), resolveFlangeBracing({spanFt:input.spanFt, bracesFt:[0, ...at, input.spanFt]})).passes;

test('braces are laid out from the left support and stop short of the right one', () => {
  assert.deepEqual(braceLocationsAt(5, 20), [5, 10, 15]);
  assert.deepEqual(braceLocationsAt(6, 20), [6, 12, 18]);
  assert.deepEqual(braceLocationsAt(10, 20), [10]);
  assert.deepEqual(braceLocationsAt(10.5, 21), [10.5]);
});

test('braces are never suggested wider than 5 ft O.C., even where 8 ft would pass', () => {
  assert.equal(MAX_BRACE_SPACING_FT, 5);
  assert.equal(passesWith('W16X31', []), false);
  assert.equal(passesWith('W16X31', [8, 16]), true);
  const result = suggestBraceSpacing({ section:W('W16X31'), ...beam });
  assert.deepEqual({...result}, { spacingFt:5, locationsFt:[5, 10, 15], midspan:false });
  assert.equal(passesWith('W16X31', [5, 10, 15]), true);
  // One brace at midspan would carry the service loads alone; still 5 ft O.C.
  const service = { ...beam, safetyFactor:null };
  assert.equal(passesWith('W16X31', [10], service), true);
  assert.deepEqual([...suggestBraceSpacing({ section:W('W16X31'), ...service }).locationsFt], [5, 10, 15]);
});

test('a beam that 5 ft O.C. does not hold is braced closer', () => {
  const heavier = { ...beam, liveLoadKipFt:1 };
  assert.equal(passesWith('W16X31', braceLocationsAt(5, 20), heavier), false);
  const result = suggestBraceSpacing({ section:W('W16X31'), ...heavier });
  assert.deepEqual({...result}, { spacingFt:4, locationsFt:[4, 8, 12, 16], midspan:false });
  assert.equal(passesWith('W16X31', [4, 8, 12, 16], heavier), true);
});

test('the spacing holds wherever the crew starts measuring', () => {
  const span22 = { ...beam, spanFt:22, liveLoadKipFt:.6 };
  assert.equal(passesWith('W16X31', [], span22), false);
  const result = suggestBraceSpacing({ section:W('W16X31'), ...span22 });
  assert.deepEqual({...result}, { spacingFt:5, locationsFt:[5, 10, 15, 20], midspan:false });
  // 5 ft O.C. laid out from the left support, and from the right one.
  assert.equal(passesWith('W16X31', [5, 10, 15, 20], span22), true);
  assert.equal(passesWith('W16X31', [2, 7, 12, 17], span22), true);
});

test('a computed Cb does not widen the spacing past what holds for every layout', () => {
  const quarter = { ...beam, cbMethod:'quarter', liveLoadKipFt:1 };
  // Braces at 5, 10 and 15 ft pass with Cb computed for each segment...
  assert.equal(passesWith('W16X31', [5, 10, 15], quarter), true);
  // ...but 5 ft O.C. laid out as 2.5, 7.5, 12.5 and 17.5 leaves a bay across
  // midspan of nearly uniform moment, where Cb is about 1, and that fails.
  assert.equal(passesWith('W16X31', [2.5, 7.5, 12.5, 17.5], quarter), false);
  const result = suggestBraceSpacing({ section:W('W16X31'), ...quarter });
  assert.equal(result.spacingFt, 4);
  assert.equal(passesWith('W16X31', [4, 8, 12, 16], quarter), true);
  assert.equal(passesWith('W16X31', [2, 6, 10, 14, 18], quarter), true);
});

test('on a span of 10 ft or less, one brace at midspan is offered as such', () => {
  const ten = { ...beam, spanFt:10, liveLoadKipFt:3.25 };
  assert.equal(passesWith('W16X31', [], ten), false);
  assert.deepEqual({...suggestBraceSpacing({ section:W('W16X31'), ...ten })}, { spacingFt:5, locationsFt:[5], midspan:true });
  assert.equal(passesWith('W16X31', [5], ten), true);
  // Half of a 9 ft span is not a whole number of feet: midspan comes before 4 ft O.C.
  const nine = { ...beam, spanFt:9, liveLoadKipFt:4.25 };
  assert.equal(passesWith('W16X31', [], nine), false);
  assert.deepEqual({...suggestBraceSpacing({ section:W('W16X31'), ...nine })}, { spacingFt:4.5, locationsFt:[4.5], midspan:true });
  assert.equal(passesWith('W16X31', [4.5], nine), true);
});

test('no bracing is suggested for the W8X10 under four scaffold legs', () => {
  // The landing page example: it sags 2.9 in against 1 in, and is over even fully braced.
  const legs = [[.429, 1.575, 1], [.545, 3.15, 7], [.545, 3.15, 13], [.429, 1.575, 19]].map(([deadKip, liveKip, locationFt]) => ({deadKip, liveKip, locationFt}));
  const input = { ...beam, deadLoadKipFt:0, liveLoadKipFt:0, pointLoads:legs };
  assert.equal(suggestBraceSpacing({ section:W('W8X10'), ...input }), null);
  assert.equal(passesWith('W8X10', braceLocationsAt(MIN_BRACE_SPACING_FT, 20), input), false);
  // The same legs on a W14X22 can be braced: 5 ft O.C.
  assert.deepEqual([...suggestBraceSpacing({ section:W('W14X22'), ...input }).locationsFt], [5, 10, 15]);
  assert.equal(passesWith('W14X22', [5, 10, 15], input), true);
});

test('bracing is not suggested when deflection or shear fails, even if bending could be fixed', () => {
  // Bending alone is fixed at 5 ft O.C.; a stricter deflection limit is not.
  const strict = { ...beam, deflectionLimitRatio:1000 };
  assert.equal(screenSection(W('W16X31'), screeningInputs(strict), resolveFlangeBracing({spanFt:20, bracesFt:[0, 5, 10, 15, 20]})).bendingRatio <= 1, true);
  assert.equal(suggestBraceSpacing({ section:W('W16X31'), ...strict }), null);
  // A 95 kip load 1 ft from a support: shear fails, and so does unbraced
  // bending, which braces 2 ft apart would carry.
  const heavy = { ...beam, deadLoadKipFt:0, liveLoadKipFt:0, safetyFactor:null, deflectionLimitRatio:null, pointLoads:[{deadKip:0, liveKip:95, locationFt:1}] };
  const ratios = at => screenSection(W('W16X31'), screeningInputs(heavy), resolveFlangeBracing({spanFt:20, bracesFt:[0, ...at, 20]}));
  assert.ok(ratios([]).bendingRatio > 1 && ratios([]).shearRatio > 1);
  assert.ok(ratios(braceLocationsAt(2, 20)).bendingRatio <= 1);
  assert.equal(suggestBraceSpacing({ section:W('W16X31'), ...heavy }), null);
});

test('2 ft O.C. braces every library W shape fully, so the search never needs closer', () => {
  const lpFt = s => 1.76 * s.ry * Math.sqrt(29000 / 50) / 12;
  const shapes = sections.filter(s => s.Type === 'W');
  assert.ok(shapes.length > 200);
  assert.ok(shapes.every(s => lpFt(s) > MIN_BRACE_SPACING_FT));
});

test('the bracing suggestion needs the same confirmed assumptions as the size suggestion', () => {
  assert.throws(() => suggestBraceSpacing({ section:W('W16X31'), ...beam, confirmedScope:false }), /assumptions/);
  assert.throws(() => suggestBraceSpacing({ section:W('W16X31'), ...beam, Eksi:28000 }), /29,000/);
});
