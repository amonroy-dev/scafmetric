import { analyzeBeam } from './beam.js';
import { summarizeChecks, formatUtilization } from './check-verdict.js';
import { normalizePointLoads, pointLoadsForAnalysis } from './point-loads.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value, digits = 6) => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : 'Not available';
const n = number;
// The engine works in kips. The report presents forces in lbs, moments in lb-ft,
// distributed loads in lb/ft and stresses in psi; deflections stay in inches.
const fromKips = value => number(value * 1000, 3);
const pounds = value => number(value, 3);
const ratio = value => number(value, 3);
const ref = text => `<span class="report-reference">${escape(text)}</span>`;
const row = (label, formula, substitution, result, reference = '') => `<div class="report-equation"><h4>${label}</h4><div class="report-formula">${formula}</div>${substitution ? `<div class="report-substitution">${substitution}</div>` : ''}<div class="report-answer">${result}</div>${reference ? ref(reference) : ''}</div>`;
const table = (caption, headings, rows) => `<table class="report-table"><caption>${caption}</caption><thead><tr>${headings.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const section = (title, body, className = '') => `<section class="report-section ${className}"><h2>${title}</h2>${body}</section>`;
const list = values => values.map(v => n(v)).join(', ');
const statusText = result => result?.status === 'evaluated' ? 'Evaluated' : `Not evaluated — ${escape(result?.reason || 'Not requested or assumptions not confirmed.')}`;

function deflectionSentence(d) {
 if (d?.status !== 'evaluated') return '';
 return `Maximum ${d.basis === 'nominalDeflectionIn' ? 'nominal' : 'adjusted'} deflection ${n(d.deflectionIn)} in at x = ${n(d.xFt)} ft; the selected L/${n(d.limitRatio)} limit for this ${n(d.spanFt)} ft span is ${n(d.allowableIn)} in (${formatUtilization(d.utilization)} of the limit — ${d.meets ? 'meets' : 'EXCEEDS'} the limit).`;
}
function reportStatus(checks) {
 const summary = summarizeChecks(checks || {status:'not_requested'});
 const sag = deflectionSentence(checks?.deflection);
 if (summary.status === 'incomplete') return `<strong>Member checks incomplete</strong><p>${escape(summary.detail)}</p>${sag ? `<p>${sag}</p>` : ''}`;
 const failsDeflection = summary.failed.some(item => item.kind === 'deflection');
 const failsStrength = summary.failed.some(item => item.kind !== 'deflection');
 const title = summary.status === 'pass' ? 'PASS — evaluated bending, shear and deflection checks only'
  : failsStrength && failsDeflection ? 'FAIL — strength and deflection exceed their limits'
  : failsDeflection ? 'FAIL — deflection exceeds the selected limit; strength alone does not make the beam acceptable'
  : 'FAIL — an evaluated member check exceeds its allowable';
 const g = summary.governing;
 return `<strong>${title}</strong><p>Governing: ${escape(g.name)}; ${g.kind === 'deflection' ? 'deflection / limit' : 'demand / allowable'} = ${formatUtilization(g.utilization)}.${summary.unavailable?.length ? ` ${escape(summary.unavailable.join(' '))}` : ''}</p>${sag ? `<p>${sag}</p>` : ''}`;
}
function pointIds(r) { return normalizePointLoads(r.pointLoads, r.span).map((p, i) => ({ ...p, id: p.id || `P${i + 1}` })); }
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
  [escape(u.id || `U${i+1}`), 'Uniform — dead', fromKips(u.deadKipFt), 'lb/ft', `0 to ${n(r.span)} ft`],
  [escape(u.id || `U${i+1}`), 'Uniform — live', fromKips(u.liveKipFt), 'lb/ft', `0 to ${n(r.span)} ft`]
 ]);
 rows.push(['SW','Uniform — beam self-weight',fromKips(r.self),'lb/ft',`0 to ${n(r.span)} ft`]);
 for (const p of pointIds(r)) rows.push(
  [escape(p.id),'Point — dead D',fromKips(p.deadKip),'lbs',`x = ${n(p.locationFt)} ft`],
  [escape(p.id),'Point — live LL',fromKips(p.liveKip),'lbs',`x = ${n(p.locationFt)} ft`]
 );
 return table('Applied loads — downward positive; x measured from left support A', ['ID','Type / category','Magnitude','Unit','Location'], rows)
 + row('Total distributed dead load', 'w<sub>DL</sub> = Σw<sub>D,applied</sub> + w<sub>SW</sub>', `${fromKips(r.dead)} + ${fromKips(r.self)}`, `${fromKips(r.dead+r.self)} lb/ft; includes beam self-weight once`)
 + row('Uniform service load', 'w<sub>service</sub> = w<sub>DL</sub> + w<sub>LL</sub>', `${fromKips(r.dead+r.self)} + ${fromKips(r.live)}`, `${fromKips(r.total)} lb/ft`)
 + `<p class="report-note">Beam self-weight is included once. Every point load has separate downward dead and live portions at the same position; its service total is D + LL. Service analysis uses 1.0D + 1.0L; this is the supported load case, not an envelope of all required project load combinations. Wind, snow, rain, and earthquake loads are not added or checked separately. Any such load entered as dead or live load is treated only as a downward static load.</p>`;
}
function bracingSchedule(r) {
 const top = r.braces.top?.locations || r.braces.locations;
 const bottom = r.braces.bottom?.locations || r.braces.locations;
 return table('Lateral restraint stations', ['Flange','x stations (ft)','Unbraced intervals (ft)'], [
  ['Top',list(top),top.slice(1).map((x,i)=>n(x-top[i])).join(', ')],
  ['Bottom',list(bottom),bottom.slice(1).map((x,i)=>n(x-bottom[i])).join(', ')]
 ]) + `<p>The current simply supported, downward-load model has sagging bending: the <strong>top flange is the compression flange</strong>. Top-flange stations define L<sub>b</sub> for the F2 checks. Bottom-flange restraints are recorded separately and do not shorten top-flange L<sub>b</sub>.</p><p class="report-note">End twist restraint is assumed at A and B. Entered lateral-brace connections are assumed rigid in the required restraint directions, and the connected tubes, members and supports are assumed to provide adequate brace strength and stiffness. Interior stations represent lateral restraints, not vertical supports. Brace strength, stiffness, connections and load-height effects are not designed here. Uplift, reverse curvature and negative-moment compression-flange switching are outside this model.</p>`;
}
function analysisSchedule(analysis, points, title) {
 const L = analysis.input.spanFt, w = analysis.input.uniformLoadPlf;
 const RA = analysis.reactions.leftLb, RB = analysis.reactions.rightLb;
 const actualPoints = analysis.input.pointLoads;
 const orderedPoints = [...(points || [])].sort((a,b)=>a.locationFt-b.locationFt);
 const rows = [['Uniform', pounds(w*L), n(L/2), pounds(w*L/2), pounds(w*L/2)]];
 actualPoints.forEach((p,i) => rows.push([escape(orderedPoints[i]?.id || `Point ${i+1}`), pounds(p.loadLb), n(p.locationFt), pounds(p.loadLb*(L-p.locationFt)/L), pounds(p.loadLb*p.locationFt/L)]));
 const pointForce = actualPoints.reduce((a,p)=>a+p.loadLb,0), pointMoment = actualPoints.reduce((a,p)=>a+p.loadLb*p.locationFt,0);
 return `<h3>${escape(title)}</h3>` + table('Individual load contributions to reactions', ['Load','Resultant (lbs)','x (ft)','R<sub>A</sub> (lbs)','R<sub>B</sub> (lbs)'], rows)
 + row('Right reaction', 'R<sub>B</sub> = [wL² / 2 + Σ(P<sub>i</sub>a<sub>i</sub>)] / L', `[${pounds(w)} × ${n(L)}² / 2 + ${pounds(pointMoment)}] / ${n(L)}`, `${pounds(RB)} lbs`, 'Static equilibrium: ΣM_A = 0')
 + row('Left reaction', 'R<sub>A</sub> = wL + ΣP<sub>i</sub> − R<sub>B</sub>', `${pounds(w)} × ${n(L)} + ${pounds(pointForce)} − ${pounds(RB)}`, `${pounds(RA)} lbs`, 'Static equilibrium: ΣF_y = 0')
 + row('Equilibrium residuals', 'R<sub>A</sub> + R<sub>B</sub> − wL − ΣP<sub>i</sub>; R<sub>B</sub>L − wL²/2 − ΣP<sub>i</sub>a<sub>i</sub>', '', `${n(analysis.equilibrium.forceResidualLb,7)} lbs; ${n(analysis.equilibrium.momentResidualLbIn/12,7)} lb-ft`);
}
function responseCalculations(r, analysis) {
 const L = analysis.input.spanFt, w = analysis.input.uniformLoadPlf, RA = analysis.reactions.leftLb;
 const points = analysis.input.pointLoads;
 const max = analysis.maxMoment, x = max.xFt;
 const pointTerm = points.reduce((sum,p)=>sum+p.loadLb*Math.max(x-p.locationFt,0),0);
 const locations = new Set([0,L,x,analysis.maxDeflection.xFt,...points.map(p=>p.locationFt)]);
 const rows = [...locations].sort((a,b)=>a-b).map(station=>{
  const left = analysis.at(station,'left'), right = analysis.at(station,'right');
  return [n(station),station===0?'—':pounds(left.shearLb),station===L?'—':pounds(right.shearLb),fromKips(right.momentKipFt),n(right.nominalDeflectionIn),n(right.reducedDeflectionIn)];
 });
 return row('Shear along the beam', 'V(x) = R<sub>A</sub> − wx − Σ<sub>aᵢ≤x</sub>P<sub>i</sub>', `V(x) = ${pounds(RA)} − ${pounds(w)}x − Σ<sub>aᵢ≤x</sub>P<sub>i</sub>`, 'lbs; x and aᵢ in ft. The left limit excludes a load exactly at x; the right limit includes it.', 'Static equilibrium of a cut section')
 + row('Moment along the beam', 'M(x) = R<sub>A</sub>x − wx²/2 − ΣP<sub>i</sub>⟨x − a<sub>i</sub>⟩', `M(x) = ${pounds(RA)}x − ${pounds(w)}x²/2 − ΣP<sub>i</sub>⟨x − a<sub>i</sub>⟩`, 'lb-ft; ⟨z⟩ = max(z, 0). Sagging is positive.', 'Static equilibrium of a cut section')
 + row('Maximum service moment', 'M<sub>max</sub> = max M(x) at supports, load stations and interior V(x) = 0 locations', `${pounds(RA)} × ${n(x)} − ${pounds(w)} × ${n(x)}²/2 − ${pounds(pointTerm)}`, `${fromKips(max.momentKipFt)} lb-ft at x = ${n(x)} ft`)
 + row('Maximum absolute service shear', 'V<sub>demand</sub> = max(|V<sub>max</sub>|, |V<sub>min</sub>|)', `max(|${pounds(analysis.maxShear.shearLb)}|, |${pounds(analysis.minShear.shearLb)}|)`, `${pounds(Math.max(Math.abs(analysis.maxShear.shearLb),Math.abs(analysis.minShear.shearLb)))} lbs`)
 + table('Response at supports, point loads and critical service stations', ['x (ft)','V left (lbs)','V right (lbs)','M (lb-ft)','δ nominal (in)','δ adjusted (in)'], rows)
 + `<p class="report-note">Endpoint shear is reported only on the span side: V(0+) and V(L−). Point loads applied at supports are retained in reaction equilibrium.</p>`;
}
function deflectionCalculations(r) {
 // Pounds and inches throughout: w in lb/in, P in lbs, E in psi, EI in lb-in².
 const a = r.analysis, L = r.span*12, w=r.total*1000/12, RA=a.reactions.leftLb, E=r.E*1000, EI=E*r.I;
 const points=a.input.pointLoads.map(p=>({P:p.loadLb,a:p.locationFt*12}));
 const endSum=points.reduce((sum,p)=>sum+p.P*(L-p.a)**3/6,0);
 const C=(RA*L**3/6-w*L**4/24-endSum)/L;
 const X=a.maxDeflection.xFt*12;
 const pointSum=points.reduce((sum,p)=>sum+p.P*Math.max(X-p.a,0)**3/6,0);
 const slopeSum=points.reduce((sum,p)=>sum+p.P*Math.max(X-p.a,0)**2/2,0);
 const orderedPoints=pointIds(r).sort((a,b)=>a.locationFt-b.locationFt);
 const contributions=points.map((p,i)=>[escape(orderedPoints[i].id),pounds(p.P),n(p.a),pounds(p.P*(L-p.a)**3/6),pounds(p.P*Math.max(X-p.a,0)**3/6)]);
 return `<p>Linear Euler–Bernoulli bending; prismatic member; simple supports δ(0) = δ(L) = 0. The following equations use <strong>pounds and inches</strong>. They are mechanics equations, not AISC strength equations.</p>`
 + row('Unit conversion and stiffness','L<sub>in</sub> = 12L; w<sub>in</sub> = w / 12; EI = E × Iₓ',`L = 12 × ${n(r.span)}; w = ${fromKips(r.total)} / 12; EI = ${pounds(E)} × ${n(r.I)}`,`${n(L)} in; ${pounds(w)} lb/in; ${pounds(EI)} lb-in²`)
 + (contributions.length ? table('Point-load terms used in the integration', ['Point','P (lbs)','a (in)','P(L−a)³/6 (lb-in³)','P⟨X−a⟩³/6 (lb-in³)'], contributions) : '')
 + row('Integration constant from right support boundary','C = [R<sub>A</sub>L³ / 6 − wL⁴ / 24 − ΣP<sub>i</sub>(L − a<sub>i</sub>)³ / 6] / L',`[${pounds(RA)} × ${n(L)}³/6 − ${pounds(w)} × ${n(L)}⁴/24 − ${pounds(endSum)}] / ${n(L)}`,`${pounds(C)} lb-in²`)
 + row('Deflection function','δ(X) = [CX − R<sub>A</sub>X³ / 6 + wX⁴ / 24 + ΣP<sub>i</sub>⟨X − a<sub>i</sub>⟩³ / 6] / EI','', 'Downward positive; X and aᵢ in inches.')
 + row('Maximum-deflection location','δ′(X) = [C − R<sub>A</sub>X² / 2 + wX³ / 6 + ΣP<sub>i</sub>⟨X − a<sub>i</sub>⟩² / 2] / EI = 0',`${pounds(C)} − ${pounds(RA)} × ${n(X)}²/2 + ${pounds(w)} × ${n(X)}³/6 + ${pounds(slopeSum)} ≈ 0`,`${n(X)} in = ${n(a.maxDeflection.xFt)} ft from A${r.total===0 && points.every(p=>p.P===0) ? '; unloaded beam: δ = 0 at all stations.' : '; solved by 80 bisection iterations.'}`)
 + row('Nominal maximum deflection','δ<sub>max</sub> = δ(X)',`[${pounds(C)} × ${n(X)} − ${pounds(RA)} × ${n(X)}³/6 + ${pounds(w)} × ${n(X)}⁴/24 + ${pounds(pointSum)}] / ${pounds(EI)}`,`${n(a.maxDeflection.nominalDeflectionIn)} in`)
 + row('Adjusted maximum deflection','EI<sub>adjusted</sub> = αEI; δ<sub>adjusted</sub> = δ<sub>nominal</sub> / α',`${n(r.factor)} × ${pounds(EI)}; ${n(a.maxDeflection.nominalDeflectionIn)} / ${n(r.factor)}`,`${pounds(r.factor*EI)} lb-in²; ${n(a.maxDeflection.reducedDeflectionIn)} in`)
 + deflectionLimitCheck(r.checks?.deflection, L)
 + `<p class="report-note">α = ${n(r.factor)} is an analysis stiffness assumption. It is not applied to AISC member strengths and is not a complete Direct Analysis Method. Shear deformation is excluded.</p>`;
}
function deflectionLimitCheck(d, spanIn) {
 if (d?.status !== 'evaluated') return `<p class="report-status">Deflection limit not evaluated — ${escape(d?.reason || 'No deflection limit was recorded.')}</p>`;
 const basis = d.basis === 'nominalDeflectionIn' ? 'nominal' : 'adjusted';
 return row('Deflection limit check', `δ<sub>${basis}</sub> ≤ δ<sub>allow</sub> = L<sub>in</sub> / ${n(d.limitRatio)}`, `δ<sub>${basis}</sub> = ${n(d.deflectionIn)} in at x = ${n(d.xFt)} ft; δ<sub>allow</sub> = ${n(spanIn)} / ${n(d.limitRatio)} = ${n(d.allowableIn)} in`, `δ / δ<sub>allow</sub> = ${ratio(d.utilization)} (${formatUtilization(d.utilization)} of the limit) — ${d.meets ? 'meets' : 'EXCEEDS'} the selected L/${n(d.limitRatio)} limit. Decisions use unrounded values.`, 'Selected serviceability criterion')
 + `<p class="report-note">The L/${n(d.limitRatio)} limit is a serviceability criterion selected for this preliminary beam calculation and is checked on the ${basis} deflection under the service load (1.0D + 1.0L, including self-weight). OSHA 29 CFR 1926.451(f)(16) specifies span / 60 for loaded platforms. ANSI/ASSP A10.8-2019 §5.1.1.3 limits platform-unit center deflection under design load to span / 60. These provisions do not establish this selected support-beam criterion. A qualified designer must confirm applicable project requirements. A beam can meet every strength check and still fail this limit.</p>`;
}
function flexureReport(f, r, label) {
 if (f?.status !== 'evaluated') return `<h3>${escape(label)} — flexure</h3><p class="report-status">${statusText(f)}</p>`;
 // Stresses in psi and moments in lb-ft; Fy·Zx/12 gives lb-ft directly from psi × in³.
 const p=r.sectionProperties||r.checks.section, E=r.E*1000, Fy=50000, c=f.compactness;
 const Lp=f.LpFt, Lr=f.LrFt, Mp=f.MpKipFt*1000, jr=p.J/(p.Sx*p.ho);
 const flb=f.flangeLocalBuckling, compactFlange=!c.flangeClass || c.flangeClass==='compact';
 const flangeRow = compactFlange
  ? row('Flange compactness','λ<sub>f</sub> = b<sub>f</sub> / (2t<sub>f</sub>) ≤ λ<sub>pf</sub> = 0.38√(E/F<sub>y</sub>)',`${n(p.bf)} / (2 × ${n(p.tf)}) ≤ 0.38√(${pounds(E)}/${pounds(Fy)})`,`${n(c.flangeRatio)} ≤ ${n(c.flangeLimit)} — compact`, 'AISC 360-16 Table B4.1b')
  : row('Flange compactness',`λ<sub>pf</sub> = 0.38√(E/F<sub>y</sub>) &lt; λ<sub>f</sub> = b<sub>f</sub> / (2t<sub>f</sub>) ${c.flangeClass==='noncompact'?'≤':'&gt;'} λ<sub>rf</sub> = 1.0√(E/F<sub>y</sub>)`,`λ<sub>f</sub> = ${n(p.bf)} / (2 × ${n(p.tf)}); λ<sub>pf</sub> = 0.38√(${pounds(E)}/${pounds(Fy)}); λ<sub>rf</sub> = 1.0√(${pounds(E)}/${pounds(Fy)})`,`${n(c.flangeLimit)} &lt; ${n(c.flangeRatio)} ${c.flangeClass==='noncompact'?'≤':'&gt;'} ${n(c.flangeSlenderLimit)} — ${c.flangeClass} flange; AISC F3 applies`, 'AISC 360-16 Table B4.1b');
 const flbRow = !flb ? '' : flb.equation==='F3-1'
  ? row('Compression-flange local buckling','M<sub>n,FLB</sub> = M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub>/12)(λ<sub>f</sub> − λ<sub>pf</sub>)/(λ<sub>rf</sub> − λ<sub>pf</sub>)',`${pounds(Mp)} − (${pounds(Mp)} − 0.7 × ${pounds(Fy)} × ${n(p.Sx)}/12)(${n(c.flangeRatio)} − ${n(c.flangeLimit)})/(${n(c.flangeSlenderLimit)} − ${n(c.flangeLimit)})`,`${fromKips(flb.MnKipFt)} lb-ft; independent of L<sub>b</sub> and C<sub>b</sub>, so it applies to every segment`, 'AISC 360-16 F3-1')
  : row('Compression-flange local buckling','M<sub>n,FLB</sub> = 0.9Ek<sub>c</sub>S<sub>x</sub> / (12λ<sub>f</sub>²); k<sub>c</sub> = 4/√(h/t<sub>w</sub>), 0.35 ≤ k<sub>c</sub> ≤ 0.76',`0.9 × ${pounds(E)} × ${n(flb.kc)} × ${n(p.Sx)} / (12 × ${n(c.flangeRatio)}²)`,`${fromKips(flb.MnKipFt)} lb-ft; independent of L<sub>b</sub> and C<sub>b</sub>, so it applies to every segment`, 'AISC 360-16 F3-2');
 const common = flangeRow
 + row('Web compactness','λ<sub>w</sub> = (d − 2k<sub>des</sub>) / t<sub>w</sub> ≤ λ<sub>pw</sub> = 3.76√(E/F<sub>y</sub>)',`(${n(p.d)} − 2 × ${n(p.kdes)}) / ${n(p.tw)} ≤ 3.76√(${pounds(E)}/${pounds(Fy)})`,`${n(c.webRatio)} ≤ ${n(c.webLimit)} — compact`, 'AISC 360-16 Table B4.1b')
 + row('Plastic moment','M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12',`${pounds(Fy)} × ${n(p.Zx)} / 12`,`${pounds(Mp)} lb-ft`, 'AISC 360-16 F2-1')
 + row('Limiting length Lp','L<sub>p</sub> = 1.76r<sub>y</sub>√(E/F<sub>y</sub>) / 12',`1.76 × ${n(p.ry)} × √(${pounds(E)}/${pounds(Fy)}) / 12`,`${n(Lp)} ft`, 'AISC 360-16 F2-5')
 + row('Section torsion term','j = Jc / (S<sub>x</sub>h<sub>o</sub>); c = 1 for doubly symmetric W sections',`${n(p.J)} × 1 / (${n(p.Sx)} × ${n(p.ho)})`,n(jr,9), 'AISC 360-16 F2')
 + row('Limiting length Lr','L<sub>r</sub> = 1.95r<sub>ts</sub>E/(0.7F<sub>y</sub>) × √[j + √(j² + 6.76(0.7F<sub>y</sub>/E)²)] / 12',`1.95 × ${n(p.rts)} × ${pounds(E)}/(0.7 × ${pounds(Fy)}) × √[${n(jr,9)} + √(${n(jr,9)}² + 6.76(0.7 × ${pounds(Fy)}/${pounds(E)})²)] / 12`,`${n(Lr)} ft`, 'AISC 360-16 F2-6')
 + flbRow;
 const schedule=table(`${escape(label)} — all top-flange unbraced segments`, ['Segment (ft)','Lb (ft)','Cb','M (lb-ft)','Mn (lb-ft)','Mn/Ωb (lb-ft)','D/C','Limit state'], f.segments.map(s=>[`${n(s.startFt)}–${n(s.endFt)}`,n(s.LbFt),n(s.Cb),fromKips(s.MmaxKipFt),fromKips(s.MnKipFt),fromKips(s.allowableKipFt),ratio(s.utilization),escape(s.limitState||s.ltbRegime)]));
 const segments=f.segments.map((s,index)=>{
  let html=`<section class="report-segment" data-report-segment="${escape(label)}-${index+1}"><h4>${escape(label)} · segment ${index+1}: x = ${n(s.startFt)} to ${n(s.endFt)} ft</h4>`;
  html+=row('Unbraced length and regime','L<sub>b</sub> = x<sub>end</sub> − x<sub>start</sub>',`${n(s.endFt)} − ${n(s.startFt)} = ${n(s.LbFt)} ft; Lp = ${n(Lp)} ft; Lr = ${n(Lr)} ft`,escape(s.ltbRegime), 'AISC 360-16 F2');
  html+=table('Segment moments — absolute values', ['Station','x (ft)','|M| (lb-ft)'],[['Quarter A',n(s.startFt+s.LbFt/4),fromKips(s.MaKipFt)],['Midpoint B',n(s.startFt+s.LbFt/2),fromKips(s.MbKipFt)],['Quarter C',n(s.startFt+3*s.LbFt/4),fromKips(s.McKipFt)],['Maximum in interval','Supports, load stations and V = 0 candidates',fromKips(s.MmaxKipFt)]]);
  html+= f.cbMethod==='quarter' && s.MmaxKipFt>0
   ? row('Moment-gradient factor','C<sub>b</sub> = 12.5M<sub>max</sub> / (2.5M<sub>max</sub> + 3M<sub>A</sub> + 4M<sub>B</sub> + 3M<sub>C</sub>)',`12.5 × ${fromKips(s.MmaxKipFt)} / (2.5 × ${fromKips(s.MmaxKipFt)} + 3 × ${fromKips(s.MaKipFt)} + 4 × ${fromKips(s.MbKipFt)} + 3 × ${fromKips(s.McKipFt)})`,n(s.Cb), 'AISC 360-16 F1-1')
   : row('Moment-gradient factor','C<sub>b</sub> = 1.0',f.cbMethod==='quarter'?'Zero-moment interval: use Cb = 1.0.':'User-selected conservative Cb = 1.0.',n(s.Cb), 'AISC 360-16 F1');
  const ltbLabel = flb ? 'Lateral-torsional buckling strength' : 'Nominal flexural strength', ltbMn = s.MnLtbKipFt ?? s.MnKipFt, sym = flb ? 'M<sub>n,LTB</sub>' : 'M<sub>n</sub>';
  if(s.ltbRegime==='yielding') html+=row(ltbLabel,`${sym} = M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12${flb ? ' (L<sub>b</sub> ≤ L<sub>p</sub>: lateral-torsional buckling does not apply)' : ''}`,`${pounds(Fy)} × ${n(p.Zx)} / 12`,`${fromKips(ltbMn)} lb-ft`, 'AISC 360-16 F2-1');
  else if(s.ltbRegime==='inelastic LTB') html+=row(ltbLabel,`${sym} = min{M<sub>p</sub>, C<sub>b</sub>[M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub>/12)(L<sub>b</sub>−L<sub>p</sub>)/(L<sub>r</sub>−L<sub>p</sub>)]}`,`min{${pounds(Mp)}, ${n(s.Cb)}[${pounds(Mp)} − (${pounds(Mp)} − 0.7 × ${pounds(Fy)} × ${n(p.Sx)}/12)(${n(s.LbFt)}−${n(Lp)})/(${n(Lr)}−${n(Lp)})]}`,`${fromKips(ltbMn)} lb-ft`, 'AISC 360-16 F2-2');
  else {
   const lbIn=s.LbFt*12, slenderness=lbIn/p.rts;
   html+=row('Elastic lateral-torsional buckling stress','F<sub>cr</sub> = C<sub>b</sub>π²E/(L<sub>b</sub>/r<sub>ts</sub>)² × √[1 + 0.078j(L<sub>b</sub>/r<sub>ts</sub>)²]',`${n(s.Cb)} × π² × ${pounds(E)} / (${n(lbIn)}/${n(p.rts)})² × √[1 + 0.078 × ${n(jr,9)} × (${n(lbIn)}/${n(p.rts)})²]; Lb/rts = ${n(slenderness)}`,`${fromKips(s.FcrKsi)} psi`, 'AISC 360-16 F2-4');
   html+=row(ltbLabel,`${sym} = min(M<sub>p</sub>, F<sub>cr</sub>S<sub>x</sub>/12)`,`min(${pounds(Mp)}, ${fromKips(s.FcrKsi)} × ${n(p.Sx)}/12)`,`${fromKips(ltbMn)} lb-ft`, 'AISC 360-16 F2-3');
  }
  if(flb) html+=row('Nominal flexural strength','M<sub>n</sub> = min(M<sub>n,LTB</sub>, M<sub>n,FLB</sub>)',`min(${fromKips(ltbMn)}, ${fromKips(s.MnFlbKipFt)})`,`${fromKips(s.MnKipFt)} lb-ft — governed by ${escape(s.limitState)}`, 'AISC 360-16 F3');
  html+=row('ASD allowable moment','M<sub>allow</sub> = M<sub>n</sub> / Ω<sub>b</sub>; Ω<sub>b</sub> = 1.67',`${fromKips(s.MnKipFt)} / ${n(f.omegaB)}`,`${fromKips(s.allowableKipFt)} lb-ft`, 'AISC 360-16 F1 / F2');
  html+=row('Segment demand / capacity','D/C = M<sub>max</sub> / M<sub>allow</sub>',`${fromKips(s.MmaxKipFt)} / ${fromKips(s.allowableKipFt)}`,`${ratio(s.utilization)} — ${s.utilization<=1?'meets':'exceeds'} listed flexural check. Decisions use unrounded values.`);
  return html+'</section>';
 }).join('');
 const g=f.governingSegment;
 return `<h3>${escape(label)} — major-axis flexure</h3><p>${compactFlange ? 'Compact, doubly symmetric rolled W section' : `Doubly symmetric rolled W section with a compact web and ${escape(c.flangeClass)} flanges (AISC F3: the lower of lateral-torsional buckling and flange local buckling)`}; A992 F<sub>y</sub> = 50,000 psi; nominal E = 29,000,000 psi. Top flange in compression; end twist restraint assumed.</p>${common}${schedule}${segments}<p><strong>Governing ${escape(label.toLowerCase())} flexural interval:</strong> ${n(g.startFt)}–${n(g.endFt)} ft; D/C = ${ratio(g.utilization)} (${formatUtilization(g.utilization)} of allowable).</p>`;
}
function shearReport(sh,label) {
 if(sh?.status!=='evaluated') return `<h3>${escape(label)} — shear</h3><p class="report-status">${statusText(sh)}</p>`;
 return `<h3>${escape(label)} — major-axis shear</h3>`
 + row('Rolled-I web slenderness','h/t<sub>w</sub> = (d−2k<sub>des</sub>)/t<sub>w</sub> ≤ 2.24√(E/F<sub>y</sub>)',`(${n(sh.dIn)} − 2 × ${n(sh.kdesIn)}) / ${n(sh.twIn)} ≤ 2.24√(${fromKips(sh.Eksi)}/${fromKips(sh.FyKsi)})`,`${n(sh.hOverTw)} ≤ ${n(sh.slendernessLimit)}; Cv1 = 1.0`, 'AISC 360-16 G2.1(a)')
 + row('Shear area','A<sub>w</sub> = dt<sub>w</sub>',`${n(sh.dIn)} × ${n(sh.twIn)}`,`${n(sh.AwIn2)} in²`, 'AISC 360-16 G2.1')
 + row('Nominal shear strength','V<sub>n</sub> = 0.6F<sub>y</sub>A<sub>w</sub>C<sub>v1</sub>',`0.6 × ${fromKips(sh.FyKsi)} × ${n(sh.AwIn2)} × ${n(sh.Cv1)}`,`${fromKips(sh.nominalKip)} lbs`, 'AISC 360-16 G2-1')
 + row('ASD allowable shear','V<sub>allow</sub> = V<sub>n</sub> / Ω<sub>v</sub>; Ω<sub>v</sub> = 1.50',`${fromKips(sh.nominalKip)} / ${n(sh.omega)}`,`${fromKips(sh.allowableKip)} lbs`, 'AISC 360-16 G2.1(a)')
 + row('Shear demand / capacity','D/C = V<sub>demand</sub> / V<sub>allow</sub>',`${fromKips(sh.demandKip)} / ${fromKips(sh.allowableKip)}`,`${ratio(sh.utilization)} — ${sh.meets?'meets':'exceeds'} listed shear check. Decisions use unrounded values.`);
}
function comparisonReport(r) {
 if(!r.comparison) return '';
 const sf=r.comparison.numerator, x=r.checks?.extra;
 const bendingLoad=r.dead+r.self+sf/1.67*r.live, shearLoad=r.dead+r.self+sf/1.5*r.live;
 const categorizedPoints=pointIds(r);
 const response=(w,multiplier)=>analyzeBeam({...r.analysis.input,uniformLoadPlf:w*1000,pointLoads:pointLoadsForAnalysis(categorizedPoints,multiplier)});
 const bend=response(bendingLoad,sf/1.67), shear=response(shearLoad,sf/1.5);
 const points=table('Requested point-load comparison values', ['Point','D (lbs)','LL (lbs)','Service D + LL (lbs)','Bending D + (SF/1.67)LL (lbs)','Shear D + (SF/1.50)LL (lbs)'],categorizedPoints.map(p=>[escape(p.id),fromKips(p.deadKip),fromKips(p.liveKip),fromKips(p.loadKip),fromKips(p.deadKip+p.liveKip*sf/1.67),fromKips(p.deadKip+p.liveKip*sf/1.5)]));
 const pointCalculations=categorizedPoints.map(p=>{
  const bendingLive=p.liveKip*sf/1.67, shearLive=p.liveKip*sf/1.5;
  return `<h3>${escape(p.id)} — point comparison at x = ${n(p.locationFt)} ft</h3>`
   + row(`${escape(p.id)} bending adjusted live load`,'P<sub>LL,adj,b</sub> = P<sub>LL</sub> × (SF/1.67)',`${fromKips(p.liveKip)} × (${n(sf)} / 1.67)`,`${fromKips(bendingLive)} lbs`)
   + row(`${escape(p.id)} bending dead + adjusted live`,'P<sub>b</sub> = P<sub>D</sub> + P<sub>LL,adj,b</sub>',`${fromKips(p.deadKip)} + ${fromKips(bendingLive)}`,`${fromKips(p.deadKip+bendingLive)} lbs at x = ${n(p.locationFt)} ft`)
   + row(`${escape(p.id)} shear adjusted live load`,'P<sub>LL,adj,v</sub> = P<sub>LL</sub> × (SF/1.50)',`${fromKips(p.liveKip)} × (${n(sf)} / 1.50)`,`${fromKips(shearLive)} lbs`)
   + row(`${escape(p.id)} shear dead + adjusted live`,'P<sub>v</sub> = P<sub>D</sub> + P<sub>LL,adj,v</sub>',`${fromKips(p.deadKip)} + ${fromKips(shearLive)}`,`${fromKips(p.deadKip+shearLive)} lbs at x = ${n(p.locationFt)} ft`);
 }).join('');
 return section(`Requested ${n(sf)}:1 comparison — illustrative`, `<p class="report-status"><strong>Not a verified OSHA load combination or compliance check.</strong> The selected factor is applied to entered live loads only. Service reactions, deflections and diagrams remain unfactored. This arithmetic comparison does not establish maximum intended load, failure capacity, scaffold capacity or approval for use.</p>`
 + row('Distributed dead load used in comparisons','w<sub>DL</sub> = Σw<sub>D,applied</sub> + w<sub>SW</sub>',`${fromKips(r.dead)} + ${fromKips(r.self)}`,`${fromKips(r.dead+r.self)} lb/ft; includes beam self-weight once`)
 + row('Bending uniform adjusted live load','w<sub>LL,adj,b</sub> = w<sub>LL</sub> × (SF/1.67)',`${fromKips(r.live)} × (${n(sf)} / 1.67)`,`${fromKips(r.live*sf/1.67)} lb/ft`)
 + row('Bending uniform comparison total','w<sub>b</sub> = w<sub>DL</sub> + w<sub>LL,adj,b</sub>',`${fromKips(r.dead+r.self)} + ${fromKips(r.live*sf/1.67)}`,`${fromKips(bendingLoad)} lb/ft`)
 + row('Shear uniform adjusted live load','w<sub>LL,adj,v</sub> = w<sub>LL</sub> × (SF/1.50)',`${fromKips(r.live)} × (${n(sf)} / 1.50)`,`${fromKips(r.live*sf/1.5)} lb/ft`)
 + row('Shear uniform comparison total','w<sub>v</sub> = w<sub>DL</sub> + w<sub>LL,adj,v</sub>',`${fromKips(r.dead+r.self)} + ${fromKips(r.live*sf/1.5)}`,`${fromKips(shearLoad)} lb/ft`)
 + (r.pointLoads.length?points:'')
 + pointCalculations
 + analysisSchedule(bend,pointIds(r),'Bending-comparison equilibrium')
 + row('Bending-comparison maximum','M(x) = R<sub>A</sub>x − wx²/2 − ΣP<sub>i</sub>⟨x−a<sub>i</sub>⟩',`R_A = ${pounds(bend.reactions.leftLb)} lbs; w = ${fromKips(bendingLoad)} lb/ft; x = ${n(bend.maxMoment.xFt)} ft`,`${fromKips(bend.maxMoment.momentKipFt)} lb-ft`)
 + analysisSchedule(shear,pointIds(r),'Shear-comparison equilibrium')
 + row('Shear-comparison maximum','V<sub>demand</sub> = max(|V<sub>max</sub>|, |V<sub>min</sub>|)',`max(|${pounds(shear.maxShear.shearLb)}|, |${pounds(shear.minShear.shearLb)}|)`,`${pounds(Math.max(Math.abs(shear.maxShear.shearLb),Math.abs(shear.minShear.shearLb)))} lbs`)
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
  ['Beam / span',`${escape(r.section)} / ${n(r.span)} ft`],['Supports','A: pin; B: roller; simply supported, no interior vertical supports'],['Loading','Downward full-span uniform loads and discrete point loads; x measured from A'],['Material / strength method','ASTM A992; Fy = 50,000 psi; AISC 360-16 ASD within listed scope'],['Analysis stiffness',`E = ${fromKips(r.E)} psi; Iₓ = ${n(r.I)} in⁴; α = ${n(r.factor)}`],['Units','Forces in lbs, moments in lb-ft, distributed loads in lb/ft, stresses in psi, lengths in ft; deflections and section dimensions in inches'],['Service force case','1.0D + 1.0L, including self-weight'],['Strength factors','Ωb = 1.67; Ωv = 1.50 for implemented G2.1(a) case'],['Deflection criterion',checks.deflection?.status==='evaluated'?`${checks.deflection.basis==='nominalDeflectionIn'?'Nominal':'Adjusted'} deflection ≤ L/${n(checks.deflection.limitRatio)} under 1.0D + 1.0L (selected serviceability limit)`:'Not evaluated']
 ]);
 const summary=table('Service results', ['Result','Value','Location'], [
  ['Left reaction',`${pounds(a.reactions.leftLb)} lbs`,'A'],['Right reaction',`${pounds(a.reactions.rightLb)} lbs`,'B'],['Maximum moment',`${fromKips(a.maxMoment.momentKipFt)} lb-ft`,`${n(a.maxMoment.xFt)} ft`],['Nominal maximum deflection',`${n(a.maxDeflection.nominalDeflectionIn)} in`,`${n(a.maxDeflection.xFt)} ft`],['Adjusted maximum deflection',`${n(a.maxDeflection.reducedDeflectionIn)} in`,`${n(a.maxDeflection.xFt)} ft`],
  ...(checks.deflection?.status==='evaluated'?[[`Deflection limit (L/${n(checks.deflection.limitRatio)})`,`${n(checks.deflection.allowableIn)} in`,`${formatUtilization(checks.deflection.utilization)} of the limit — ${checks.deflection.meets?'meets':'EXCEEDS'}`]]:[])
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
 + section('8. References, assumptions and limitations',`<ul><li><strong>ANSI/AISC 360-16, Specification for Structural Steel Buildings:</strong> Table B4.1b (flexural compactness); F1 and Eq. F1-1 (ASD flexural basis and Cb); F2 and Eqs. F2-1 through F2-6 (doubly symmetric I-section major-axis bending, yielding and lateral-torsional buckling); F3 and Eqs. F3-1 and F3-2 (compact web with noncompact or slender flanges: flange local buckling); G2.1(a) and Eq. G2-1 (implemented stocky-web shear case).</li><li><strong>AISC Shapes Database v15:</strong> section geometry from a third-party mirror; rounding may differ from commercial software or the authoritative database.</li><li><strong>Mechanics:</strong> static equilibrium, linear superposition and Euler–Bernoulli double integration for a prismatic simply supported beam. These response equations are distinct from AISC resistance provisions.</li><li><strong>Not evaluated:</strong> concentrated-force limit states in AISC J10 (including local flange/web behavior), bearing, connections, brace strength/stiffness, axial load, torsion, combined forces, destabilizing load-height effects, noncompact or slender webs (AISC F4 and F5), scaffold-specific requirements and all required project load combinations.</li><li><strong>Deflection limit:</strong> the selected span / n limit is a serviceability criterion for this preliminary calculation; applicable project requirements may differ. OSHA 29 CFR 1926.451(f)(16) and ANSI/ASSP A10.8-2019 §5.1.1.3 provide platform-deflection criteria of span / 60; these provisions do not establish the selected support-beam criterion.</li><li><strong>Point-load applicability:</strong> a valid global bending/shear result does not establish local capacity at a point load or support.</li><li><strong>Comparison with RISA:</strong> this report provides a traceable calculation format; it does not claim feature or result equivalence with RISA-3D. The stored benchmark uses selected W16×31 cases and rounded source properties.</li><li><strong>Precision:</strong> report values are rounded for readability; calculation decisions use unrounded values. No construction approval or independent verification is provided.</li></ul><p class="report-note">Scafmetric calculation engine 0.1.0 · Generated ${escape(r.timestamp||'')}.</p>`);
}
