import { analyzeBeam } from './beam.js';
import { summarizeChecks } from './check-verdict.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value, digits = 6) => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : 'Not available';
const n = number;
const ref = text => `<span class="report-reference">${escape(text)}</span>`;
const row = (label, formula, substitution, result, reference = '') => `<div class="report-equation"><h4>${label}</h4><div class="report-formula">${formula}</div>${substitution ? `<div class="report-substitution">${substitution}</div>` : ''}<div class="report-answer">${result}</div>${reference ? ref(reference) : ''}</div>`;
const table = (caption, headings, rows) => `<table class="report-table"><caption>${caption}</caption><thead><tr>${headings.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const section = (title, body, className = '') => `<section class="report-section ${className}"><h2>${title}</h2>${body}</section>`;
const list = values => values.map(v => n(v)).join(', ');
const statusText = result => result?.status === 'evaluated' ? 'Evaluated' : `Not evaluated — ${escape(result?.reason || 'Not requested or assumptions not confirmed.')}`;

function reportStatus(checks) {
 const summary = summarizeChecks(checks || {status:'not_requested'});
 if (summary.status === 'incomplete') return `<strong>Member checks incomplete</strong><p>${escape(summary.detail)}</p>`;
 return `<strong>${summary.status === 'fail' ? 'FAIL — an evaluated member check exceeds its allowable' : 'PASS — evaluated bending and shear checks only'}</strong><p>Governing: ${escape(summary.governing.name)}; demand / allowable = ${n(summary.governing.utilization)}.${summary.unavailable?.length ? ` ${escape(summary.unavailable.join(' '))}` : ''}</p>`;
}
function pointIds(r) { return r.pointLoads.map((p, i) => ({ ...p, id: p.id || `P${i + 1}` })); }
function sourceGeometry(r) {
 const s = r.sectionProperties || r.checks?.section || {};
 const entries = [
  ['W','Weight','lb/ft'],['A','Area','in²'],['d','Depth','in'],['bf','Flange width','in'],['tf','Flange thickness','in'],['tw','Web thickness','in'],['kdes','k (design)','in'],
  ['Ix','Iₓ (catalogue)','in⁴'],['Sx','Sₓ','in³'],['Zx','Zₓ','in³'],['Iy','Iᵧ','in⁴'],['ry','rᵧ','in'],['rts','rₜₛ','in'],['J','J','in⁴'],['ho','hₒ','in']
 ];
 const rows = entries.map(([key,label,unit]) => [label, n(s[key]), unit]);
 return table('Selected section properties — AISC Shapes Database v15 mirror', ['Property','Value','Unit'], rows) + `<p class="report-note">Catalogue section properties are reproduced from the application’s third-party AISC v15 data mirror. Verify against the authoritative AISC source. Analysis Iₓ = ${n(r.I)} in⁴${s.Ix !== r.I ? ' (overrides the catalogue value)' : ''}. Strength checks use the selected catalogue section properties.</p>`;
}
function loadSchedule(r) {
 const uniforms = r.uniformLoads || [{id:'U1',deadKipFt:r.dead,liveKipFt:r.live}];
 const rows = uniforms.flatMap((u,i) => [
  [escape(u.id || `U${i+1}`), 'Uniform — dead', n(u.deadKipFt), 'kip/ft', `0 to ${n(r.span)} ft`],
  [escape(u.id || `U${i+1}`), 'Uniform — live', n(u.liveKipFt), 'kip/ft', `0 to ${n(r.span)} ft`]
 ]);
 rows.push(['SW','Uniform — beam self-weight',n(r.self),'kip/ft',`0 to ${n(r.span)} ft`]);
 for (const p of pointIds(r)) rows.push([escape(p.id),'Point — live',n(p.loadKip),'kip',`x = ${n(p.locationFt)} ft`]);
 return table('Applied loads — downward positive; x measured from left support A', ['ID','Type / category','Magnitude','Unit','Location'], rows)
 + row('Uniform service load', 'w = Σw<sub>D</sub> + W / 1,000 + Σw<sub>L</sub>', `${n(r.dead)} + ${n(r.self * 1000)} / 1,000 + ${n(r.live)}`, `${n(r.total)} kip/ft`)
 + `<p class="report-note">Beam self-weight is included once. Point loads are entered as downward live loads. Service analysis uses 1.0D + 1.0L; this is the supported load case, not an envelope of all required project load combinations.</p>`;
}
function bracingSchedule(r) {
 const top = r.braces.top?.locations || r.braces.locations;
 const bottom = r.braces.bottom?.locations || r.braces.locations;
 return table('Lateral restraint stations', ['Flange','x stations (ft)','Unbraced intervals (ft)'], [
  ['Top',list(top),top.slice(1).map((x,i)=>n(x-top[i])).join(', ')],
  ['Bottom',list(bottom),bottom.slice(1).map((x,i)=>n(x-bottom[i])).join(', ')]
 ]) + `<p>The current simply supported, downward-load model has sagging bending: the <strong>top flange is the compression flange</strong>. Top-flange stations define L<sub>b</sub> for the F2 checks. Bottom-flange restraints are recorded separately and do not shorten top-flange L<sub>b</sub>.</p><p class="report-note">End twist restraint is assumed at A and B. Interior stations represent adequate lateral restraint of the stated flange; they are not vertical supports. Brace strength, stiffness, connections and load-height effects are not designed here. Uplift, reverse curvature and negative-moment compression-flange switching are outside this model.</p>`;
}
function analysisSchedule(analysis, points, title) {
 const L = analysis.input.spanFt, w = analysis.input.uniformLoadPlf / 1000;
 const RA = analysis.reactions.leftLb / 1000, RB = analysis.reactions.rightLb / 1000;
 const actualPoints = analysis.input.pointLoads;
 const orderedPoints = [...(points || [])].sort((a,b)=>a.locationFt-b.locationFt);
 const rows = [['Uniform', n(w*L), n(L/2), n(w*L/2), n(w*L/2)]];
 actualPoints.forEach((p,i) => rows.push([escape(orderedPoints[i]?.id || `Point ${i+1}`), n(p.loadLb/1000), n(p.locationFt), n(p.loadLb/1000*(L-p.locationFt)/L), n(p.loadLb/1000*p.locationFt/L)]));
 const pointForce = actualPoints.reduce((a,p)=>a+p.loadLb/1000,0), pointMoment = actualPoints.reduce((a,p)=>a+p.loadLb/1000*p.locationFt,0);
 return `<h3>${escape(title)}</h3>` + table('Individual load contributions to reactions', ['Load','Resultant (kip)','x (ft)','R<sub>A</sub> (kip)','R<sub>B</sub> (kip)'], rows)
 + row('Right reaction', 'R<sub>B</sub> = [wL² / 2 + Σ(P<sub>i</sub>a<sub>i</sub>)] / L', `[${n(w)} × ${n(L)}² / 2 + ${n(pointMoment)}] / ${n(L)}`, `${n(RB)} kip`, 'Static equilibrium: ΣM_A = 0')
 + row('Left reaction', 'R<sub>A</sub> = wL + ΣP<sub>i</sub> − R<sub>B</sub>', `${n(w)} × ${n(L)} + ${n(pointForce)} − ${n(RB)}`, `${n(RA)} kip`, 'Static equilibrium: ΣF_y = 0')
 + row('Equilibrium residuals', 'R<sub>A</sub> + R<sub>B</sub> − wL − ΣP<sub>i</sub>; R<sub>B</sub>L − wL²/2 − ΣP<sub>i</sub>a<sub>i</sub>', '', `${n(analysis.equilibrium.forceResidualLb/1000,10)} kip; ${n(analysis.equilibrium.momentResidualLbIn/12000,10)} kip-ft`);
}
function responseCalculations(r, analysis) {
 const L = analysis.input.spanFt, w = analysis.input.uniformLoadPlf/1000, RA = analysis.reactions.leftLb/1000;
 const points = analysis.input.pointLoads;
 const max = analysis.maxMoment, x = max.xFt;
 const pointTerm = points.reduce((sum,p)=>sum+p.loadLb/1000*Math.max(x-p.locationFt,0),0);
 const locations = new Set([0,L,x,analysis.maxDeflection.xFt,...points.map(p=>p.locationFt)]);
 const rows = [...locations].sort((a,b)=>a-b).map(station=>{
  const left = analysis.at(station,'left'), right = analysis.at(station,'right');
  return [n(station),station===0?'—':n(left.shearLb/1000),station===L?'—':n(right.shearLb/1000),n(right.momentKipFt),n(right.nominalDeflectionIn),n(right.reducedDeflectionIn)];
 });
 return row('Shear along the beam', 'V(x) = R<sub>A</sub> − wx − Σ<sub>aᵢ≤x</sub>P<sub>i</sub>', `V(x) = ${n(RA)} − ${n(w)}x − Σ<sub>aᵢ≤x</sub>P<sub>i</sub>`, 'kip; x and aᵢ in ft. The left limit excludes a load exactly at x; the right limit includes it.', 'Static equilibrium of a cut section')
 + row('Moment along the beam', 'M(x) = R<sub>A</sub>x − wx²/2 − ΣP<sub>i</sub>⟨x − a<sub>i</sub>⟩', `M(x) = ${n(RA)}x − ${n(w)}x²/2 − ΣP<sub>i</sub>⟨x − a<sub>i</sub>⟩`, 'kip-ft; ⟨z⟩ = max(z, 0). Sagging is positive.', 'Static equilibrium of a cut section')
 + row('Maximum service moment', 'M<sub>max</sub> = max M(x) at supports, load stations and interior V(x) = 0 locations', `${n(RA)} × ${n(x)} − ${n(w)} × ${n(x)}²/2 − ${n(pointTerm)}`, `${n(max.momentKipFt)} kip-ft at x = ${n(x)} ft`)
 + row('Maximum absolute service shear', 'V<sub>demand</sub> = max(|V<sub>max</sub>|, |V<sub>min</sub>|)', `max(|${n(analysis.maxShear.shearLb/1000)}|, |${n(analysis.minShear.shearLb/1000)}|)`, `${n(Math.max(Math.abs(analysis.maxShear.shearLb),Math.abs(analysis.minShear.shearLb))/1000)} kip`)
 + table('Response at supports, point loads and critical service stations', ['x (ft)','V left (kip)','V right (kip)','M (kip-ft)','δ nominal (in)','δ adjusted (in)'], rows)
 + `<p class="report-note">Endpoint shear is reported only on the span side: V(0+) and V(L−). Point loads applied at supports are retained in reaction equilibrium.</p>`;
}
function deflectionCalculations(r) {
 const a = r.analysis, L = r.span*12, w=r.total/12, RA=a.reactions.leftLb/1000, EI=r.E*r.I;
 const points=a.input.pointLoads.map(p=>({P:p.loadLb/1000,a:p.locationFt*12}));
 const endSum=points.reduce((sum,p)=>sum+p.P*(L-p.a)**3/6,0);
 const C=(RA*L**3/6-w*L**4/24-endSum)/L;
 const X=a.maxDeflection.xFt*12;
 const pointSum=points.reduce((sum,p)=>sum+p.P*Math.max(X-p.a,0)**3/6,0);
 const slopeSum=points.reduce((sum,p)=>sum+p.P*Math.max(X-p.a,0)**2/2,0);
 const orderedPoints=pointIds(r).sort((a,b)=>a.locationFt-b.locationFt);
 const contributions=points.map((p,i)=>[escape(orderedPoints[i].id),n(p.P),n(p.a),n(p.P*(L-p.a)**3/6),n(p.P*Math.max(X-p.a,0)**3/6)]);
 return `<p>Linear Euler–Bernoulli bending; prismatic member; simple supports δ(0) = δ(L) = 0. The following equations use <strong>kips and inches</strong>. They are mechanics equations, not AISC strength equations.</p>`
 + row('Unit conversion and stiffness','L<sub>in</sub> = 12L; w<sub>in</sub> = w / 12; EI = E × Iₓ',`L = 12 × ${n(r.span)}; w = ${n(r.total)} / 12; EI = ${n(r.E)} × ${n(r.I)}`,`${n(L)} in; ${n(w)} kip/in; ${n(EI)} kip-in²`)
 + (contributions.length ? table('Point-load terms used in the integration', ['Point','P (kip)','a (in)','P(L−a)³/6 (kip-in³)','P⟨X−a⟩³/6 (kip-in³)'], contributions) : '')
 + row('Integration constant from right support boundary','C = [R<sub>A</sub>L³ / 6 − wL⁴ / 24 − ΣP<sub>i</sub>(L − a<sub>i</sub>)³ / 6] / L',`[${n(RA)} × ${n(L)}³/6 − ${n(w)} × ${n(L)}⁴/24 − ${n(endSum)}] / ${n(L)}`,`${n(C)} kip-in²`)
 + row('Deflection function','δ(X) = [CX − R<sub>A</sub>X³ / 6 + wX⁴ / 24 + ΣP<sub>i</sub>⟨X − a<sub>i</sub>⟩³ / 6] / EI','', 'Downward positive; X and aᵢ in inches.')
 + row('Maximum-deflection location','δ′(X) = [C − R<sub>A</sub>X² / 2 + wX³ / 6 + ΣP<sub>i</sub>⟨X − a<sub>i</sub>⟩² / 2] / EI = 0',`${n(C)} − ${n(RA)} × ${n(X)}²/2 + ${n(w)} × ${n(X)}³/6 + ${n(slopeSum)} ≈ 0`,`${n(X)} in = ${n(a.maxDeflection.xFt)} ft from A${r.total===0 && points.every(p=>p.P===0) ? '; unloaded beam: δ = 0 at all stations.' : '; solved by 80 bisection iterations.'}`)
 + row('Nominal maximum deflection','δ<sub>max</sub> = δ(X)',`[${n(C)} × ${n(X)} − ${n(RA)} × ${n(X)}³/6 + ${n(w)} × ${n(X)}⁴/24 + ${n(pointSum)}] / ${n(EI)}`,`${n(a.maxDeflection.nominalDeflectionIn)} in`)
 + row('Adjusted maximum deflection','EI<sub>adjusted</sub> = αEI; δ<sub>adjusted</sub> = δ<sub>nominal</sub> / α',`${n(r.factor)} × ${n(EI)}; ${n(a.maxDeflection.nominalDeflectionIn)} / ${n(r.factor)}`,`${n(r.factor*EI)} kip-in²; ${n(a.maxDeflection.reducedDeflectionIn)} in`)
 + `<p class="report-note">α = ${n(r.factor)} is an analysis stiffness assumption. It is not applied to AISC member strengths and is not a complete Direct Analysis Method. Shear deformation is excluded. No deflection limit or serviceability pass/fail is evaluated.</p>`;
}
function flexureReport(f, r, label) {
 if (f?.status !== 'evaluated') return `<h3>${escape(label)} — flexure</h3><p class="report-status">${statusText(f)}</p>`;
 const p=r.sectionProperties||r.checks.section, E=r.E, Fy=50, c=f.compactness;
 const Lp=f.LpFt, Lr=f.LrFt, Mp=f.MpKipFt, jr=p.J/(p.Sx*p.ho);
 const common = row('Flange compactness','λ<sub>f</sub> = b<sub>f</sub> / (2t<sub>f</sub>) ≤ λ<sub>pf</sub> = 0.38√(E/F<sub>y</sub>)',`${n(p.bf)} / (2 × ${n(p.tf)}) ≤ 0.38√(${n(E)}/${n(Fy)})`,`${n(c.flangeRatio)} ≤ ${n(c.flangeLimit)} — compact`, 'AISC 360-16 Table B4.1b')
 + row('Web compactness','λ<sub>w</sub> = (d − 2k<sub>des</sub>) / t<sub>w</sub> ≤ λ<sub>pw</sub> = 3.76√(E/F<sub>y</sub>)',`(${n(p.d)} − 2 × ${n(p.kdes)}) / ${n(p.tw)} ≤ 3.76√(${n(E)}/${n(Fy)})`,`${n(c.webRatio)} ≤ ${n(c.webLimit)} — compact`, 'AISC 360-16 Table B4.1b')
 + row('Plastic moment','M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12',`${n(Fy)} × ${n(p.Zx)} / 12`,`${n(Mp)} kip-ft`, 'AISC 360-16 F2-1')
 + row('Limiting length Lp','L<sub>p</sub> = 1.76r<sub>y</sub>√(E/F<sub>y</sub>) / 12',`1.76 × ${n(p.ry)} × √(${n(E)}/${n(Fy)}) / 12`,`${n(Lp)} ft`, 'AISC 360-16 F2-5')
 + row('Section torsion term','j = Jc / (S<sub>x</sub>h<sub>o</sub>); c = 1 for doubly symmetric W sections',`${n(p.J)} × 1 / (${n(p.Sx)} × ${n(p.ho)})`,n(jr,9), 'AISC 360-16 F2')
 + row('Limiting length Lr','L<sub>r</sub> = 1.95r<sub>ts</sub>E/(0.7F<sub>y</sub>) × √[j + √(j² + 6.76(0.7F<sub>y</sub>/E)²)] / 12',`1.95 × ${n(p.rts)} × ${n(E)}/(0.7 × ${n(Fy)}) × √[${n(jr,9)} + √(${n(jr,9)}² + 6.76(0.7 × ${n(Fy)}/${n(E)})²)] / 12`,`${n(Lr)} ft`, 'AISC 360-16 F2-6');
 const schedule=table(`${escape(label)} — all top-flange unbraced segments`, ['Segment (ft)','Lb (ft)','Cb','M (kip-ft)','Mn (kip-ft)','Mn/Ωb (kip-ft)','D/C'], f.segments.map(s=>[`${n(s.startFt)}–${n(s.endFt)}`,n(s.LbFt),n(s.Cb),n(s.MmaxKipFt),n(s.MnKipFt),n(s.allowableKipFt),n(s.utilization)]));
 const segments=f.segments.map((s,index)=>{
  let html=`<section class="report-segment" data-report-segment="${escape(label)}-${index+1}"><h4>${escape(label)} · segment ${index+1}: x = ${n(s.startFt)} to ${n(s.endFt)} ft</h4>`;
  html+=row('Unbraced length and regime','L<sub>b</sub> = x<sub>end</sub> − x<sub>start</sub>',`${n(s.endFt)} − ${n(s.startFt)} = ${n(s.LbFt)} ft; Lp = ${n(Lp)} ft; Lr = ${n(Lr)} ft`,escape(s.ltbRegime), 'AISC 360-16 F2');
  html+=table('Segment moments — absolute values', ['Station','x (ft)','|M| (kip-ft)'],[['Quarter A',n(s.startFt+s.LbFt/4),n(s.MaKipFt)],['Midpoint B',n(s.startFt+s.LbFt/2),n(s.MbKipFt)],['Quarter C',n(s.startFt+3*s.LbFt/4),n(s.McKipFt)],['Maximum in interval','Supports, load stations and V = 0 candidates',n(s.MmaxKipFt)]]);
  html+= f.cbMethod==='quarter' && s.MmaxKipFt>0
   ? row('Moment-gradient factor','C<sub>b</sub> = 12.5M<sub>max</sub> / (2.5M<sub>max</sub> + 3M<sub>A</sub> + 4M<sub>B</sub> + 3M<sub>C</sub>)',`12.5 × ${n(s.MmaxKipFt)} / (2.5 × ${n(s.MmaxKipFt)} + 3 × ${n(s.MaKipFt)} + 4 × ${n(s.MbKipFt)} + 3 × ${n(s.McKipFt)})`,n(s.Cb), 'AISC 360-16 F1-1')
   : row('Moment-gradient factor','C<sub>b</sub> = 1.0',f.cbMethod==='quarter'?'Zero-moment interval: use Cb = 1.0.':'User-selected conservative Cb = 1.0.',n(s.Cb), 'AISC 360-16 F1');
  if(s.ltbRegime==='yielding') html+=row('Nominal flexural strength','M<sub>n</sub> = M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12',`${n(Fy)} × ${n(p.Zx)} / 12`,`${n(s.MnKipFt)} kip-ft`, 'AISC 360-16 F2-1');
  else if(s.ltbRegime==='inelastic LTB') html+=row('Nominal flexural strength','M<sub>n</sub> = min{M<sub>p</sub>, C<sub>b</sub>[M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub>/12)(L<sub>b</sub>−L<sub>p</sub>)/(L<sub>r</sub>−L<sub>p</sub>)]}',`min{${n(Mp)}, ${n(s.Cb)}[${n(Mp)} − (${n(Mp)} − 0.7 × ${n(Fy)} × ${n(p.Sx)}/12)(${n(s.LbFt)}−${n(Lp)})/(${n(Lr)}−${n(Lp)})]}`,`${n(s.MnKipFt)} kip-ft`, 'AISC 360-16 F2-2');
  else {
   const lbIn=s.LbFt*12, slenderness=lbIn/p.rts;
   html+=row('Elastic lateral-torsional buckling stress','F<sub>cr</sub> = C<sub>b</sub>π²E/(L<sub>b</sub>/r<sub>ts</sub>)² × √[1 + 0.078j(L<sub>b</sub>/r<sub>ts</sub>)²]',`${n(s.Cb)} × π² × ${n(E)} / (${n(lbIn)}/${n(p.rts)})² × √[1 + 0.078 × ${n(jr,9)} × (${n(lbIn)}/${n(p.rts)})²]; Lb/rts = ${n(slenderness)}`,`${n(s.FcrKsi)} ksi`, 'AISC 360-16 F2-4');
   html+=row('Nominal flexural strength','M<sub>n</sub> = min(M<sub>p</sub>, F<sub>cr</sub>S<sub>x</sub>/12)',`min(${n(Mp)}, ${n(s.FcrKsi)} × ${n(p.Sx)}/12)`,`${n(s.MnKipFt)} kip-ft`, 'AISC 360-16 F2-3');
  }
  html+=row('ASD allowable moment','M<sub>allow</sub> = M<sub>n</sub> / Ω<sub>b</sub>; Ω<sub>b</sub> = 1.67',`${n(s.MnKipFt)} / ${n(f.omegaB)}`,`${n(s.allowableKipFt)} kip-ft`, 'AISC 360-16 F1 / F2');
  html+=row('Segment demand / capacity','D/C = M<sub>max</sub> / M<sub>allow</sub>',`${n(s.MmaxKipFt)} / ${n(s.allowableKipFt)}`,`${n(s.utilization)} — ${s.utilization<=1?'meets':'exceeds'} listed flexural check. Decisions use unrounded values.`);
  return html+'</section>';
 }).join('');
 const g=f.governingSegment;
 return `<h3>${escape(label)} — major-axis flexure</h3><p>Compact, doubly symmetric rolled W section; A992 F<sub>y</sub> = 50 ksi; nominal E = 29,000 ksi. Top flange in compression; end twist restraint assumed.</p>${common}${schedule}${segments}<p><strong>Governing ${escape(label.toLowerCase())} flexural interval:</strong> ${n(g.startFt)}–${n(g.endFt)} ft; D/C = ${n(g.utilization)}.</p>`;
}
function shearReport(sh,label) {
 if(sh?.status!=='evaluated') return `<h3>${escape(label)} — shear</h3><p class="report-status">${statusText(sh)}</p>`;
 return `<h3>${escape(label)} — major-axis shear</h3>`
 + row('Rolled-I web slenderness','h/t<sub>w</sub> = (d−2k<sub>des</sub>)/t<sub>w</sub> ≤ 2.24√(E/F<sub>y</sub>)',`(${n(sh.dIn)} − 2 × ${n(sh.kdesIn)}) / ${n(sh.twIn)} ≤ 2.24√(${n(sh.Eksi)}/${n(sh.FyKsi)})`,`${n(sh.hOverTw)} ≤ ${n(sh.slendernessLimit)}; Cv1 = 1.0`, 'AISC 360-16 G2.1(a)')
 + row('Shear area','A<sub>w</sub> = dt<sub>w</sub>',`${n(sh.dIn)} × ${n(sh.twIn)}`,`${n(sh.AwIn2)} in²`, 'AISC 360-16 G2.1')
 + row('Nominal shear strength','V<sub>n</sub> = 0.6F<sub>y</sub>A<sub>w</sub>C<sub>v1</sub>',`0.6 × ${n(sh.FyKsi)} × ${n(sh.AwIn2)} × ${n(sh.Cv1)}`,`${n(sh.nominalKip)} kip`, 'AISC 360-16 G2-1')
 + row('ASD allowable shear','V<sub>allow</sub> = V<sub>n</sub> / Ω<sub>v</sub>; Ω<sub>v</sub> = 1.50',`${n(sh.nominalKip)} / ${n(sh.omega)}`,`${n(sh.allowableKip)} kip`, 'AISC 360-16 G2.1(a)')
 + row('Shear demand / capacity','D/C = V<sub>demand</sub> / V<sub>allow</sub>',`${n(sh.demandKip)} / ${n(sh.allowableKip)}`,`${n(sh.utilization)} — ${sh.meets?'meets':'exceeds'} listed shear check. Decisions use unrounded values.`);
}
function comparisonReport(r) {
 if(!r.comparison) return '';
 const sf=r.comparison.numerator, x=r.checks?.extra;
 const bendingLoad=r.dead+r.self+sf/1.67*r.live, shearLoad=r.dead+r.self+sf/1.5*r.live;
 const response=(w,multiplier)=>analyzeBeam({...r.analysis.input,uniformLoadPlf:w*1000,pointLoads:r.analysis.input.pointLoads.map(p=>({...p,loadLb:p.loadLb*multiplier}))});
 const bend=response(bendingLoad,sf/1.67), shear=response(shearLoad,sf/1.5);
 const points=table('Requested point-load comparison values', ['Point','Service P (kip)','Bending P × SF/1.67 (kip)','Shear P × SF/1.50 (kip)'],pointIds(r).map(p=>[escape(p.id),n(p.loadKip),n(p.loadKip*sf/1.67),n(p.loadKip*sf/1.5)]));
 return section(`Requested ${n(sf)}:1 comparison — illustrative`, `<p class="report-status"><strong>Not a verified OSHA load combination or compliance check.</strong> The selected factor is applied to entered live loads only. Service reactions, deflections and diagrams remain unfactored. This arithmetic comparison does not establish maximum intended load, failure capacity, scaffold capacity or approval for use.</p>`
 + row('Bending comparison load','w<sub>b</sub> = D + SW + (SF/1.67)L',`${n(r.dead)} + ${n(r.self)} + (${n(sf)}/1.67) × ${n(r.live)}`,`${n(bendingLoad)} kip/ft; point multiplier = ${n(sf/1.67)}`)
 + row('Shear comparison load','w<sub>v</sub> = D + SW + (SF/1.50)L',`${n(r.dead)} + ${n(r.self)} + (${n(sf)}/1.50) × ${n(r.live)}`,`${n(shearLoad)} kip/ft; point multiplier = ${n(sf/1.5)}`)
 + (r.pointLoads.length?points:'')
 + analysisSchedule(bend,pointIds(r),'Bending-comparison equilibrium')
 + row('Bending-comparison maximum','M(x) = R<sub>A</sub>x − wx²/2 − ΣP<sub>i</sub>⟨x−a<sub>i</sub>⟩',`R_A = ${n(bend.reactions.leftLb/1000)} kip; w = ${n(bendingLoad)} kip/ft; x = ${n(bend.maxMoment.xFt)} ft`,`${n(bend.maxMoment.momentKipFt)} kip-ft`)
 + analysisSchedule(shear,pointIds(r),'Shear-comparison equilibrium')
 + row('Shear-comparison maximum','V<sub>demand</sub> = max(|V<sub>max</sub>|, |V<sub>min</sub>|)',`max(|${n(shear.maxShear.shearLb/1000)}|, |${n(shear.minShear.shearLb/1000)}|)`,`${n(Math.max(Math.abs(shear.maxShear.shearLb),Math.abs(shear.minShear.shearLb))/1000)} kip`)
 + flexureReport(x?.bending,r,'Comparison') + shearReport(x?.shearing,'Comparison'), 'report-major');
}
function copyGraphic(html) {
 // Keep document-unique SVG paint IDs when both the screen view and report exist.
 const ids=new Map(); String(html||'').replace(/\bid="([^"]+)"/g,(_,id)=>ids.set(id,`report-${id}`));
 return String(html||'').replace(/\bid="([^"]+)"/g,(_,id)=>`id="${ids.get(id)}"`)
  .replace(/url\(#([^)]*)\)/g,(all,id)=>ids.has(id)?`url(#${ids.get(id)})`:all)
  .replace(/\b(aria-labelledby|aria-describedby)="([^"]+)"/g,(_,attribute,value)=>`${attribute}="${value.split(/\s+/).map(id=>ids.get(id)||id).join(' ')}"`)
  .replace(/\b(href|xlink:href)="#([^"]+)"/g,(all,attribute,id)=>ids.has(id)?`${attribute}="#${ids.get(id)}"`:all);
}

/** Produce a complete, self-contained calculation snapshot. Only evaluated limit
 * states have numeric strengths; no report content is inferred from live controls. */
export function renderCalculationReport(r, {schematic='',diagrams=[]} = {}) {
 if(!r?.analysis) return '';
 const a=r.analysis, checks=r.checks||{status:'not_requested'};
 const strengths=checks.status==='evaluated'
  ? flexureReport(checks.flexure,r,'Service')+shearReport(checks.shear,'Service')
  : `<p class="report-status"><strong>AISC member strength not evaluated.</strong> ${escape(checks.reason||'Member checks were not requested. Enable the checks and confirm the beam assumptions to include evaluated AISC calculations.')}</p><p>The service force and deflection calculations below remain available. No numeric member strength or pass is inferred.</p>`;
 const overview=table('Analysis basis', ['Item','Value'], [
  ['Beam / span',`${escape(r.section)} / ${n(r.span)} ft`],['Supports','A: pin; B: roller; simply supported, no interior vertical supports'],['Loading','Downward full-span uniform loads and discrete point loads; x measured from A'],['Material / strength method','ASTM A992; Fy = 50 ksi; AISC 360-16 ASD within listed scope'],['Analysis stiffness',`E = ${n(r.E)} ksi; Iₓ = ${n(r.I)} in⁴; α = ${n(r.factor)}`],['Service force case','1.0D + 1.0L, including self-weight'],['Strength factors','Ωb = 1.67; Ωv = 1.50 for implemented G2.1(a) case']
 ]);
 const summary=table('Service results', ['Result','Value','Location'], [
  ['Left reaction',`${n(a.reactions.leftLb/1000)} kip`,'A'],['Right reaction',`${n(a.reactions.rightLb/1000)} kip`,'B'],['Maximum moment',`${n(a.maxMoment.momentKipFt)} kip-ft`,`${n(a.maxMoment.xFt)} ft`],['Nominal maximum deflection',`${n(a.maxDeflection.nominalDeflectionIn)} in`,`${n(a.maxDeflection.xFt)} ft`],['Adjusted maximum deflection',`${n(a.maxDeflection.reducedDeflectionIn)} in`,`${n(a.maxDeflection.xFt)} ft`]
 ]);
 const graphics=diagrams.map(d=>`<figure class="report-diagram"><figcaption>${escape(d.name)} — service load</figcaption>${copyGraphic(d.html)}</figure>`).join('');
 return `<header class="report-header"><p class="report-brand">SCAFMETRIC · BEAM CALCULATION</p><h1>${escape(r.project||'Untitled project')}</h1><div class="report-meta"><span>Prepared by: ${escape(r.preparer||'Not specified')}</span><span>${escape(r.timestamp||'')}</span></div><p>${escape(r.section)} · ${n(r.span)} ft · AISC 360-16 ASD</p></header>`
 + `<div class="report-status">${reportStatus(checks)}<p>This report documents the implemented calculations. It is not a full member or scaffold design certification.</p></div>`
 + section('1. Model and results',overview+summary+(schematic?`<figure class="report-model"><figcaption>Beam arrangement — schematic</figcaption>${copyGraphic(schematic)}</figure>`:''))
 + section('2. Applied loads and lateral bracing',loadSchedule(r)+bracingSchedule(r))
 + section('3. Section properties',sourceGeometry(r))
 + section('4. Service equilibrium, shear and moment',analysisSchedule(a,pointIds(r),'Service equilibrium')+responseCalculations(r,a),'report-major')
 + section('5. Service deflection',deflectionCalculations(r))
 + section('6. AISC service member calculations',strengths,'report-major')
 + comparisonReport(r)
 + section('7. Service diagrams',graphics || '<p>No diagrams supplied.</p>','report-major')
 + section('8. References, assumptions and limitations',`<ul><li><strong>ANSI/AISC 360-16, Specification for Structural Steel Buildings:</strong> Table B4.1b (flexural compactness); F1 and Eq. F1-1 (ASD flexural basis and Cb); F2 and Eqs. F2-1 through F2-6 (compact doubly symmetric I-section major-axis bending); G2.1(a) and Eq. G2-1 (implemented stocky-web shear case).</li><li><strong>AISC Shapes Database v15:</strong> section geometry from a third-party mirror; rounding may differ from commercial software or the authoritative database.</li><li><strong>Mechanics:</strong> static equilibrium, linear superposition and Euler–Bernoulli double integration for a prismatic simply supported beam. These response equations are distinct from AISC resistance provisions.</li><li><strong>Not evaluated:</strong> concentrated-force limit states in AISC J10 (including local flange/web behavior), bearing, connections, brace strength/stiffness, axial load, torsion, combined forces, destabilizing load-height effects, deflection limits, noncompact/slender-section strength, scaffold-specific requirements and all required project load combinations.</li><li><strong>Point-load applicability:</strong> a valid global bending/shear result does not establish local capacity at a point load or support.</li><li><strong>Comparison with RISA:</strong> this report provides a traceable calculation format; it does not claim feature or result equivalence with RISA-3D. The stored benchmark uses selected W16×31 cases and rounded source properties.</li><li><strong>Precision:</strong> report values are rounded for readability; calculation decisions use unrounded values. No construction approval or independent verification is provided.</li></ul><p class="report-note">Scafmetric calculation engine 0.1.0 · Generated ${escape(r.timestamp||'')}.</p>`);
}
