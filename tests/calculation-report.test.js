import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBeam } from '../src/beam.js';
import { checkFlexure } from '../src/strength-flexure.js';
import { checkMajorAxisShear } from '../src/strength-shear.js';
import { renderCalculationReport } from '../src/calculation-report.js';

const section = { Type:'W', AISC_Manual_Label:'W16X31', W:31, A:9.13, d:15.9, bf:5.53, tf:.44, tw:.275, kdes:.842, Ix:375, Iy:12.4, Sx:47.2, Zx:54, ry:1.17, rts:1.42, J:.461, ho:15.5 };
function fixture({points=[],braces=[0,5,10,15,20],zero=false,factor=null,unconfirmed=false,cb='unity'}={}) {
 const dead=zero?0:.2, live=zero?0:.8, self=zero?0:.031, total=dead+live+self, span=20;
 const response=(w,multiplier=1)=>analyzeBeam({spanFt:span,uniformLoadPlf:w*1000,pointLoads:points.map(p=>({loadLb:p.loadKip*multiplier*1000,locationFt:p.locationFt})),Eksi:29000,Iin4:375,stiffnessFactor:.8});
 const analysis=response(total);
 const flex=a=>({status:'evaluated',...checkFlexure({section,analysis:a,bracesFt:braces,cbMethod:cb,Eksi:29000,Fyksi:50,confirmedLateralBracing:true,confirmedScope:true})});
 const shear=a=>checkMajorAxisShear({section,FyKsi:50,Eksi:29000,demandKip:Math.max(Math.abs(a.maxShear.shearLb),Math.abs(a.minShear.shearLb))/1000});
 const checks=unconfirmed?{status:'not_evaluated',reason:'Confirm the beam assumptions.'}:{status:'evaluated',section,flexure:flex(analysis),shear:shear(analysis),cbMethod:cb};
 if(factor&&!unconfirmed) checks.extra={sf:factor,bendingLoad:dead+self+factor/1.67*live,shearLoad:dead+self+factor/1.5*live,bending:flex(response(dead+self+factor/1.67*live,factor/1.67)),shearing:shear(response(dead+self+factor/1.5*live,factor/1.5))};
 return {project:'Bridge scaffold',preparer:'A. Contractor',timestamp:'2026-11-14T12:00:00.000Z',section:'W16X31',sectionProperties:section,span,dead,live,self,total,E:29000,I:375,factor:.8,uniformLoads:[{id:'U1',deadKipFt:dead,liveKipFt:live}],pointLoads:points,braces:{top:{locations:braces},bottom:{locations:[0,20]},locations:braces},analysis,checks,comparison:factor?{numerator:factor}:null};
}
function tableContaining(html,caption) {
 return html.slice(html.indexOf(`<caption>${caption}`)).split('</table>')[0];
}

test('full service report gives independently checked uniform-load results and every AISC segment',()=>{
 const html=renderCalculationReport(fixture());
 // Closed-form uniform-load benchmark: 1.031 kip/ft × 20 / 2 and wL²/8.
 assert.match(html,/10\.31 kip/);assert.match(html,/51\.55 kip-ft/);
 // Rounded W16x31 source gives 225/1.67 for Mp allowable and Lb=5 ft interpolation.
 assert.match(html,/225 kip-ft/);assert.match(html,/128\.840584/);
 assert.equal((html.match(/data-report-segment="Service-/g)||[]).length,4);
 for(const reference of ['Table B4.1b','F2-1','F2-2','F2-5','F2-6','G2-1','G2.1(a)']) assert.ok(html.includes(reference),reference);
 assert.match(html,/Euler–Bernoulli/);assert.match(html,/not AISC strength equations/);
 assert.match(html,/Top<\/td><td>0, 5, 10, 15, 20/);assert.match(html,/Bottom<\/td><td>0, 20/);
 assert.match(html,/J10/);assert.match(html,/Shear deformation is excluded/);
});

test('report includes yielding, inelastic and elastic formulas and all comparison segments',()=>{
 const html=renderCalculationReport(fixture({braces:[0,2,8,20],factor:4,cb:'quarter',points:[{id:'P1',loadKip:10,locationFt:5}]}));
 for(const reference of ['F1-1','F2-1','F2-2','F2-3','F2-4']) assert.ok(html.includes(reference),reference);
 assert.equal((html.match(/data-report-segment="Service-/g)||[]).length,3);
 assert.equal((html.match(/data-report-segment="Comparison-/g)||[]).length,3);
 assert.match(html,/17\.81 kip/);assert.match(html,/12\.81 kip/);
 assert.match(html,/23\.952096/);assert.match(html,/26\.666667/);
 assert.match(html,/Not a verified OSHA load combination/);
 assert.match(html,/Bending-comparison equilibrium/);assert.match(html,/Shear-comparison equilibrium/);
});

test('coincident and equal points retain individual IDs in every calculation schedule',()=>{
 const html=renderCalculationReport(fixture({factor:4,points:[{id:'P1',loadKip:5,locationFt:6},{id:'P2',loadKip:5,locationFt:6}]}));
 const reactionTables=html.split('<caption>Individual load contributions to reactions').slice(1).map(part=>part.split('</table>')[0]);
 assert.equal(reactionTables.length,3);
 for(const content of [...reactionTables,tableContaining(html,'Point-load terms used in the integration')]){
  assert.equal((content.match(/<td>P1<\/td>/g)||[]).length,1);
  assert.equal((content.match(/<td>P2<\/td>/g)||[]).length,1);
 }
});

test('support-applied point load remains in equilibrium but endpoint table only reports span-side shear',()=>{
 const r=fixture({zero:true,points:[{id:'P1',loadKip:8,locationFt:0}]});
 const html=renderCalculationReport(r);
 assert.equal(r.analysis.reactions.leftLb,8000);assert.equal(r.analysis.maxShear.shearLb,0);
 const response=tableContaining(html,'Response at supports, point loads and critical service stations');
 assert.match(response,/<tr><td>0<\/td><td>—<\/td><td>0<\/td>/);
 assert.match(response,/<tr><td>20<\/td><td>0<\/td><td>—<\/td>/);
 assert.match(html,/Point loads applied at supports are retained in reaction equilibrium/);
});

test('zero-load report stays finite and does not create spurious demand',()=>{
 const html=renderCalculationReport(fixture({zero:true,cb:'quarter'}));
 assert.doesNotMatch(html,/NaN|Infinity|undefined/);
 assert.match(html,/unloaded beam: δ = 0 at all stations/);
 assert.match(html,/Zero-moment interval: use Cb = 1\.0/);
 assert.match(html,/0 kip-ft at x = 0 ft/);
});

test('unconfirmed member checks show the reason and never fabricate numeric strengths or a pass',()=>{
 const html=renderCalculationReport(fixture({unconfirmed:true,factor:4}));
 assert.match(html,/Member checks incomplete/);assert.match(html,/Confirm the beam assumptions/);
 assert.match(html,/AISC member strength not evaluated/);
 assert.doesNotMatch(html,/data-report-segment=/);assert.doesNotMatch(html,/PASS —/);
 assert.match(html,/Service equilibrium/);assert.match(html,/Service deflection/);
});

test('project and point text is escaped; supplied SVG references are namespaced for printing',()=>{
 const r=fixture({points:[{id:'<P1>',loadKip:2,locationFt:4}]});r.project='<img src=x onerror=alert(1)>';r.preparer='A & B';
 const svg='<svg aria-labelledby="title desc"><title id="title">Beam</title><desc id="desc">Diagram</desc><defs><linearGradient id="fill"></linearGradient></defs><path id="beam" fill="url(#fill)"/><use href="#beam"/></svg>';
 const html=renderCalculationReport(r,{schematic:svg,diagrams:[{name:'Moment',html:svg.replaceAll('fill','moment-fill').replaceAll('beam','moment-beam').replaceAll('title','moment-title').replaceAll('desc','moment-desc')}]});
 assert.doesNotMatch(html,/<img src/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/A &amp; B/);assert.match(html,/&lt;P1&gt;/);
 assert.match(html,/id="report-fill"/);assert.match(html,/url\(#report-fill\)/);assert.match(html,/aria-labelledby="report-title report-desc"/);assert.match(html,/href="#report-beam"/);
 assert.match(html,/Moment — service load/);
});
