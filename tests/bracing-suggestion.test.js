import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeBeam } from '../src/beam.js';
import { checkFlexure } from '../src/strength-flexure.js';
import { checkMajorAxisShear } from '../src/strength-shear.js';
import { checkDeflection } from '../src/deflection-check.js';
import { strengthComparisonLoads } from '../src/strength-comparison.js';
import { summarizeChecks } from '../src/check-verdict.js';
import { canConsiderLateralBracing } from '../src/bracing-suggestion.js';

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
