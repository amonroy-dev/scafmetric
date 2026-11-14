import { analyzeBeam } from './src/beam.js';
import { beamSelfWeight } from './src/beam-self-weight.js';
import { summarizeChecks } from './src/check-verdict.js';
import { suggestBeamSize } from './src/suggest-beam-size.js';
import { checkFlexure } from './src/strength-flexure.js';
import { checkMajorAxisShear } from './src/strength-shear.js';
import { strengthComparisonLoads } from './src/strength-comparison.js';
import { requestedLoadComparison } from './src/load-comparison.js';
import { drawSchematic as drawBeamSchematic, bindSchematic } from './src/input-visual.js';
import { drawCharts, clearCharts } from './src/visuals.js';

const $ = id => document.getElementById(id);
const fmt = (n, digits = 3) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const ratio = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let sections = [], record = null;
const emptyMetrics = $('results').innerHTML;
const emptyCharts = new Map(['shear-chart', 'moment-chart', 'deflection-chart'].map(id => [id, $(id).innerHTML]));
function drawSchematic() {
 drawBeamSchematic();
 $('model-section').textContent = $('section').value || 'Choose a section';
 $('model-span').textContent = `${$('span').value || '—'} ft span`;
}
function revealField(field) {
 for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
}

const propUnits = { W:'lb/ft', A:'in²', d:'in', bf:'in', tw:'in', tf:'in', Ix:'in⁴', Sx:'in³', Zx:'in³', Iy:'in⁴', Sy:'in³', Zy:'in³', J:'in⁴', Cw:'in⁶', rx:'in', ry:'in', rts:'in', ho:'in' };
function selected() { return sections.find(s => s.AISC_Manual_Label === $('section').value); }
function properties() {
 const s = selected(); if (!s) return;
 $('inertia').value = s.Ix;
 try { $('self-weight').value = `${fmt(s.W, 4)} lb/ft (${fmt(beamSelfWeight(s), 7)} kip/ft)`; } catch { $('self-weight').value = 'Section weight unavailable'; }
 const keys = Object.keys(propUnits);
 $('section-properties').innerHTML = keys.filter(k => s[k] != null).map(k => `<div><span>${escape(k)}</span><strong>${escape(s[k])} <small>${propUnits[k]}</small></strong></div>`).join('');
 invalidate();
}
function invalidate() {
 if (!record) return;
 record = null;
 $('verdict').innerHTML = '<div class="verdict-card verdict-incomplete"><strong class="verdict-title">Inputs changed</strong><p class="verdict-detail">Calculate again to update your beam check.</p></div>';
 $('results').innerHTML = emptyMetrics;
 $('suggestion').innerHTML = '';
 $('report').disabled = true;
 clearCharts();
 for (const [id, html] of emptyCharts) $(id).innerHTML = html;
}
function braces(value, span) {
 const list = value.trim() ? value.split(',').map(s => s.trim()).filter(Boolean).map(Number) : [0, span];
 if (list.some(x => !Number.isFinite(x) || x < 0 || x > span)) throw Error('Brace locations must be numbers between 0 and the span.');
 if (!list.includes(0) || !list.includes(span)) throw Error('Confirm lateral restraints at both supports by including 0 and the span in brace locations.');
 const sorted = [...new Set(list)].sort((a,b)=>a-b);
 return { locations: sorted, segments: sorted.slice(1).map((x,i)=>x-sorted[i]) };
}
function memberChecks({section, analysis, bracesFt, Eksi, dead, live, self, comparison}) {
 if (!$('enable-capacity').checked) return { status: 'not_requested' };
 const missing = [];
 if (!$('capacity-confirmed').checked) missing.push('Confirm the steel-check assumptions for this beam.');
 if (Eksi !== 29000) missing.push('Set E to 29,000 ksi for this AISC check.');
 if (missing.length) return { status:'not_evaluated', reason:missing.join(' ') };
 const demandKip = Math.max(Math.abs(analysis.maxShear.shearLb), Math.abs(analysis.minShear.shearLb))/1000;
 let flexure;
 try { flexure = { status:'evaluated', ...checkFlexure({section, analysis, bracesFt, cbMethod:$('cb-method').value, Eksi, Fyksi:50, confirmedLateralBracing:true, confirmedScope:true}) }; }
 catch (e) { flexure = { status:'not_evaluated', reason:e instanceof Error ? e.message : 'This configuration is outside the supported bending scope.' }; }
 let shear;
 try { shear = checkMajorAxisShear({section, FyKsi:50, Eksi, demandKip}); }
 catch (e) { shear = { status:'not_evaluated', reason:e instanceof Error ? e.message : 'This configuration is outside the supported shear scope.' }; }
 let extra = null;
 if (comparison) {
  const sf = comparison.numerator;
  const comparisonLoads = strengthComparisonLoads({ dead, live, self, safetyFactor:sf });
  const bendingLoad = comparisonLoads.bending;
  const shearLoad = comparisonLoads.shear;
  let bending, shearing;
  try {
   const bendingAnalysis = analyzeBeam({ ...analysis.input, uniformLoadPlf:bendingLoad * 1000, pointLoads: analysis.input.pointLoads.map(p => ({...p, loadLb: p.loadLb * sf / 1.67})) });
   bending = { status:'evaluated', ...checkFlexure({ section, analysis:bendingAnalysis, bracesFt, cbMethod:$('cb-method').value, Eksi, Fyksi:50, confirmedLateralBracing:true, confirmedScope:true }) };
  } catch (e) { bending = {status:'not_evaluated', reason:e instanceof Error ? e.message : 'Outside supported scope.'}; }
  try { const shearAnalysis = analyzeBeam({ ...analysis.input, uniformLoadPlf:shearLoad * 1000, pointLoads: analysis.input.pointLoads.map(p => ({...p, loadLb: p.loadLb * sf / 1.5})) }); shearing = checkMajorAxisShear({section, FyKsi:50, Eksi, demandKip:Math.max(Math.abs(shearAnalysis.maxShear.shearLb), Math.abs(shearAnalysis.minShear.shearLb))/1000}); }
  catch (e) { shearing = {status:'not_evaluated', reason:e instanceof Error ? e.message : 'Outside supported scope.'}; }
  extra = {sf, bendingLoad, shearLoad, bending, shearing};
 }
 return {status:'evaluated', flexure, shear, extra, dead, live, self, section, spanFt:analysis.input.spanFt, comparisonSelection:$('load-comparison').value, cbMethod:$('cb-method').value};
}
function calculationRow(label, equation, result, reference = '') {
 return `<div class="capacity-row"><span class="capacity-label">${label}</span><span class="capacity-equation">${equation}</span><strong class="capacity-value">${result}</strong><span class="capacity-reference">${reference}</span></div>`;
}
function memberChecksHtml(check) {
 if (check.status === 'not_requested') return '<div class="calculation-detail"><h3>Steel member strength</h3><p>Not evaluated. Select the optional AISC member checks and confirm their assumptions to evaluate the supported limit states.</p></div>';
 if (check.status === 'not_evaluated') return `<div class="calculation-detail"><h3>Steel member strength</h3><p><strong>Additional information required.</strong> ${escape(check.reason)}</p></div>`;
 const f = check.flexure, sh = check.shear, props = check.section;
 let flex = `<p class="capacity-note"><strong>Bending: not evaluated.</strong> ${escape(f.reason || 'Outside supported scope.')}</p>`;
 if (f.status === 'evaluated') {
  const g = f.governingSegment;
  const rows = f.segments.map(seg => `<tr><td>${fmt(seg.startFt,3)}–${fmt(seg.endFt,3)}</td><td>${fmt(seg.LbFt,3)}</td><td>${ratio(seg.Cb)}</td><td>${fmt(seg.MmaxKipFt,3)}</td><td>${fmt(seg.MnKipFt,3)}</td><td>${fmt(seg.allowableKipFt,3)}</td><td>${ratio(seg.utilization)}</td></tr>`).join('');
  let cbEquation = 'Specified';
  if (check.cbMethod === 'quarter') cbEquation = g.MmaxKipFt === 0 ? 'Zero moment: C<sub>b</sub> = 1.0' : `(12.5 × ${fmt(g.MmaxKipFt,3)}) / (2.5 × ${fmt(g.MmaxKipFt,3)} + 3 × ${fmt(g.MaKipFt,3)} + 4 × ${fmt(g.MbKipFt,3)} + 3 × ${fmt(g.McKipFt,3)})`;
  const nominalEq = g.ltbRegime === 'yielding'
   ? `M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12 = 50 × ${fmt(props.Zx,3)} / 12`
   : g.ltbRegime === 'inelastic LTB'
    ? `min[M<sub>p</sub>, C<sub>b</sub>(M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub> / 12)(L<sub>b</sub> − L<sub>p</sub>)/(L<sub>r</sub> − L<sub>p</sub>))]`
    : 'min(M<sub>p</sub>, F<sub>cr</sub>S<sub>x</sub> / 12); F<sub>cr</sub> per F2-4';
  const nominalRef = g.ltbRegime === 'yielding' ? 'AISC F2-1' : g.ltbRegime === 'inelastic LTB' ? 'AISC F2-2' : 'AISC F2-3, F2-4';
  const cbRef = check.cbMethod === 'quarter' && g.MmaxKipFt !== 0 ? 'AISC F1-1' : '';
  flex = `<div class="capacity-section"><div class="capacity-heading"><h4>Flexure · major axis</h4><span>${g.utilization <= 1 ? 'Meets listed check' : 'Does not meet listed check'}</span></div>
  ${calculationRow('Flange compactness', 'b<sub>f</sub> / 2t<sub>f</sub> ≤ 0.38√(E / F<sub>y</sub>)', `${fmt(f.compactness.flangeRatio,3)} ≤ ${fmt(f.compactness.flangeLimit,3)}`, 'AISC B4.1b')}
  ${calculationRow('Web compactness', '(d − 2k) / t<sub>w</sub> ≤ 3.76√(E / F<sub>y</sub>)', `${fmt(f.compactness.webRatio,3)} ≤ ${fmt(f.compactness.webLimit,3)}`, 'AISC B4.1b')}
  ${calculationRow('Plastic moment', `F<sub>y</sub>Z<sub>x</sub> / 12 = 50 × ${fmt(props.Zx,3)} / 12`, `${fmt(f.MpKipFt,3)} kip-ft`, 'AISC F2-1')}
  ${calculationRow('L<sub>p</sub>', '1.76r<sub>y</sub>√(E / F<sub>y</sub>) / 12', `${fmt(f.LpFt,3)} ft`, 'AISC F2-5')}
  ${calculationRow('L<sub>r</sub>', '1.95r<sub>ts</sub>E/(0.7F<sub>y</sub>) × √[J/(S<sub>x</sub>h<sub>o</sub>) + √((J/(S<sub>x</sub>h<sub>o</sub>))² + 6.76(0.7F<sub>y</sub>/E)²)] / 12', `${fmt(f.LrFt,3)} ft`, 'AISC F2-6')}
  ${calculationRow('Governing segment', `${fmt(g.startFt,3)}–${fmt(g.endFt,3)} ft · ${escape(g.ltbRegime)}`, `L<sub>b</sub> = ${fmt(g.LbFt,3)} ft`, '')}
  ${calculationRow('C<sub>b</sub>', cbEquation, ratio(g.Cb), cbRef)}
  ${g.ltbRegime === 'elastic LTB' && Number.isFinite(g.FcrKsi) ? calculationRow('Critical stress', 'C<sub>b</sub>π²E/(L<sub>b</sub>/r<sub>ts</sub>)² × √[1 + 0.078(J/(S<sub>x</sub>h<sub>o</sub>))(L<sub>b</sub>/r<sub>ts</sub>)²]', `${fmt(g.FcrKsi,3)} ksi`, 'AISC F2-4') : ''}
  ${calculationRow('Nominal moment', nominalEq, `${fmt(g.MnKipFt,3)} kip-ft`, nominalRef)}
  ${calculationRow('Allowable moment', `M<sub>n</sub> / Ω<sub>b</sub> = ${fmt(g.MnKipFt,3)} / 1.67`, `${fmt(g.allowableKipFt,3)} kip-ft`, 'AISC F2')}
  ${calculationRow('Moment ratio', `M / M<sub>allow</sub> = ${fmt(g.MmaxKipFt,3)} / ${fmt(g.allowableKipFt,3)}`, ratio(g.utilization), '')}
  <p class="capacity-scroll-hint">Swipe table to see all columns</p><div class="capacity-table-wrap"><table class="capacity-table"><caption>Unbraced segments · service load (moments in kip-ft)</caption><thead><tr><th>Segment (ft)</th><th>L<sub>b</sub> (ft)</th><th>C<sub>b</sub></th><th>M</th><th>M<sub>n</sub></th><th>M<sub>allow</sub></th><th>Ratio</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
 }
 let shear = `<p class="capacity-note"><strong>Shear: not evaluated.</strong> ${escape(sh.reason || 'Outside supported scope.')}</p>`;
 if (sh.status === 'evaluated') shear = `<div class="capacity-section"><div class="capacity-heading"><h4>Shear · major axis</h4><span>${sh.meets ? 'Meets listed check' : 'Does not meet listed check'}</span></div>
 ${calculationRow('Web slenderness', 'h / t<sub>w</sub> ≤ 2.24√(E / F<sub>y</sub>)', `${fmt(sh.hOverTw,3)} ≤ ${fmt(sh.slendernessLimit,3)}`, 'AISC G2.1(a)')}
 ${calculationRow('Web area', `A<sub>w</sub> = d × t<sub>w</sub> = ${fmt(sh.dIn,3)} × ${fmt(sh.twIn,3)}`, `${fmt(sh.AwIn2,3)} in²`, 'AISC G2.1')}
 ${calculationRow('Nominal shear', `0.6F<sub>y</sub>A<sub>w</sub>C<sub>v1</sub> = 0.6 × 50 × ${fmt(sh.AwIn2,3)} × ${fmt(sh.Cv1,3)}`, `${fmt(sh.nominalKip,3)} kip`, 'AISC G2-1')}
 ${calculationRow('Allowable shear', `V<sub>n</sub> / Ω<sub>v</sub> = ${fmt(sh.nominalKip,3)} / ${fmt(sh.omega,2)}`, `${fmt(sh.allowableKip,3)} kip`, 'AISC G2.1(a)')}
 ${calculationRow('Shear ratio', `V / V<sub>allow</sub> = ${fmt(sh.demandKip,3)} / ${fmt(sh.allowableKip,3)}`, ratio(sh.utilization), '')}</div>`;
 let extraHtml = '';
 if (check.extra) {
  const x = check.extra, fb = x.bending, vs = x.shearing;
  const bendRows = fb.status === 'evaluated' ? calculationRow('Moment ratio', `${fmt(fb.governingSegment.MmaxKipFt,3)} / ${fmt(fb.governingSegment.allowableKipFt,3)} kip-ft`, ratio(fb.governingSegment.utilization), 'AISC F2') : `<p class="capacity-note">Bending not evaluated: ${escape(fb.reason || 'Outside supported scope.')}</p>`;
  const shearRows = vs.status === 'evaluated' ? calculationRow('Shear ratio', `${fmt(vs.demandKip,3)} / ${fmt(vs.allowableKip,3)} kip`, ratio(vs.utilization), 'AISC G2.1(a)') : `<p class="capacity-note">Shear not evaluated: ${escape(vs.reason || 'Outside supported scope.')}</p>`;
  extraHtml = `<div class="capacity-section"><h4>ASD — ${check.comparisonSelection === 'four' ? '4:1' : 'custom factor'} comparison</h4><p class="capacity-note"><strong>Illustrative only.</strong> Not a verified OSHA or ASD load combination; maximum intended load and failure-capacity basis require review.</p>
  ${calculationRow('Bending load', `D + self-weight + (SF / 1.67)L = ${fmt(check.dead,4)} + ${fmt(check.self,4)} + (${fmt(x.sf,8)} / 1.67 × ${fmt(check.live,4)})`, `${fmt(x.bendingLoad,4)} kip/ft`, '')}
  ${fb.status === 'evaluated' ? calculationRow('Moment demand', `Peak combined moment, segment ${fmt(fb.governingSegment.startFt,3)}–${fmt(fb.governingSegment.endFt,3)} ft`, `${fmt(fb.governingSegment.MmaxKipFt,3)} kip-ft`, '') : ''}
  ${bendRows}
  <p class="capacity-note">Point loads are treated as live loads and multiplied by SF / 1.67 for bending and SF / 1.50 for shear.</p>
  ${calculationRow('Shear load', `D + self-weight + (SF / 1.50)L = ${fmt(check.dead,4)} + ${fmt(check.self,4)} + (${fmt(x.sf,8)} / 1.50 × ${fmt(check.live,4)})`, `${fmt(x.shearLoad,4)} kip/ft`, '')}
  ${vs.status === 'evaluated' ? calculationRow('Shear demand', 'Peak combined shear', `${fmt(vs.demandKip,3)} kip`, '') : ''}
  ${shearRows}</div>`;
 }
 return `<div class="capacity-checks"><h3>ASD — no additional factor</h3><p class="capacity-basis">AISC 360-16 ASD · A992 F<sub>y</sub> = 50 ksi · nominal E = 29,000 ksi · service 1.0D + 1.0L · C<sub>b</sub> ${check.cbMethod === 'quarter' ? 'quarter-point' : '= 1.0'}</p>${flex}${shear}${extraHtml}<p class="capacity-note"><strong>Not evaluated:</strong> bearing, local web forces, connections, axial force, torsion, deflection limits, brace design, and scaffold-specific requirements. No overall adequacy is determined; verify section data independently.</p></div>`;
}
function run(e) {
 e.preventDefault(); $('error').textContent = '';
 try {
  if (!$('acknowledgement').checked) throw Error('Please acknowledge the preliminary-use notice before calculating.');
  const s = selected(); if (!s) throw Error('Select a beam section.');
  const span=Number($('span').value), dead=Number($('dead-load').value), live=Number($('live-load').value), E=Number($('elastic-modulus').value), I=Number($('inertia').value), factor=Number($('stiffness-factor').value);
  if (dead < 0 || live < 0 || !Number.isFinite(dead+live)) throw Error('Loads must be finite, nonnegative numbers.');
  const pointLoads = [...document.querySelectorAll('.point-load-row')].map(row => {
   const load = row.querySelector('.point-load').value, location = row.querySelector('.point-location').value;
   if (load === '' || location === '') throw Error('Enter a load and location for each point load.');
   const loadKip = Number(load), locationFt = Number(location);
   if (!Number.isFinite(loadKip) || loadKip < 0 || !Number.isFinite(locationFt) || locationFt < 0 || locationFt > span) throw Error('Point loads must be nonnegative and located between the supports.');
   return {loadKip, locationFt};
  });
  const self = beamSelfWeight(s), total = dead+live+self, br = braces($('brace-locations').value, span);
  const analysis = analyzeBeam({spanFt:span, uniformLoadPlf:total*1000, pointLoads:pointLoads.map(p=>({loadLb:p.loadKip*1000, locationFt:p.locationFt})), Eksi:E, Iin4:I, stiffnessFactor:factor});
  const comparison = requestedLoadComparison({selection:$('load-comparison').value, customSafetyFactor:$('custom-safety-factor').value === '' ? NaN : Number($('custom-safety-factor').value), deadLoadKipFt:dead, liveLoadKipFt:live, selfWeightKipFt:self, spanFt:span});
  const checks = memberChecks({section:s, analysis, bracesFt:br.locations, Eksi:E, dead, live, self, comparison});
  record = Object.freeze({comparison, checks, project:$('project').value || 'Untitled project', preparer:$('preparer').value || 'Not specified', section:s.AISC_Manual_Label, span, dead, live, self, total, pointLoads, E, I, factor, braces:br, analysis, timestamp:new Date().toISOString()});
  render(record); $('report').disabled = false;
  const resultsPanel = document.querySelector('.results-panel');
  resultsPanel.focus({preventScroll:true});
  if (window.matchMedia('(max-width: 760px)').matches) resultsPanel.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
 } catch(err) { invalidate(); $('error').textContent = err.message; }
}
function verdictHtml(check) {
 const result = summarizeChecks(check);
 const scope = '<p class="verdict-scope">These are preliminary bending and shear checks only. Bearing, connections, deflection limits, bracing and scaffold requirements need separate review.</p>';
 if (result.status === 'incomplete') return `<div class="verdict-card verdict-incomplete"><strong class="verdict-title">Strength check pending</strong><p class="verdict-detail">${escape(result.detail)}</p><button type="button" class="verdict-action" data-open-checks>Review settings</button></div>`;
 const item = result.governing;
 const governing = `${escape(item.name)} · ${fmt(item.utilization * 100, 4)}% of allowable (compared without rounding)`;
 if (result.status === 'fail') return `<div class="verdict-card verdict-fail"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">FAIL — listed check</strong><p class="verdict-detail"><strong>${governing}</strong><br>Demand exceeds the allowable strength. Try a larger section or review the loads and brace locations, then calculate again.</p>${result.unavailable.length ? `<p class="verdict-detail">Other checks not evaluated: ${escape(result.unavailable.join(' '))}</p>` : ''}${scope}</div>`;
 return `<div class="verdict-card verdict-pass"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">PASS — listed bending and shear checks</strong><p class="verdict-detail"><strong>${governing}</strong><br>The evaluated demand is within the allowable strength.</p>${scope}</div>`;
}
function renderSuggestion(r) {
 const status = summarizeChecks(r.checks);
 if (status.status === 'incomplete' || status.unavailable?.length) { $('suggestion').innerHTML = ''; return; }
 let found;
 try {
  found = suggestBeamSize({sections, spanFt:r.span, deadLoadKipFt:r.dead, liveLoadKipFt:r.live, pointLoads:r.pointLoads,
   bracesFt:r.braces.locations, cbMethod:r.checks.cbMethod, Eksi:r.E,
   safetyFactor:r.comparison ? r.comparison.numerator : null,
   confirmedLateralBracing:true, confirmedScope:true});
 } catch {
  $('suggestion').innerHTML = ''; return;
 }
 const scope = '<p>Screened for the listed bending and shear checks only, including any selected comparison. Verify this section’s properties. Deflection limits, depth, availability, bearing, connections, brace design and scaffold requirements are not checked.</p>';
 if (found.status !== 'suggested') {
  $('suggestion').innerHTML = `<div class="suggestion-card"><span class="suggestion-label">SIZE SCREEN</span><strong>No supported passing size found</strong><p>Review the loads and brace locations or consult an engineer.</p>${scope}</div>`;
  return;
 }
 const name = found.section.AISC_Manual_Label;
 const button = name === r.section ? '<span class="suggestion-current">Currently selected</span>' : `<button type="button" class="suggestion-button" data-use-suggestion="${escape(name)}">Use ${escape(name)} →</button>`;
 $('suggestion').innerHTML = `<div class="suggestion-card"><span class="suggestion-label">PRELIMINARY SIZE TO CONSIDER</span><strong>${escape(name)} <small>· ${fmt(found.section.W, 3)} lb/ft</small></strong><p>Lowest weight among supported library sections passing the listed checks.</p>${button}${scope}</div>`;
}
function render(r) {
 const a = r.analysis; const max = a.maxDeflection;
 $('verdict').innerHTML = verdictHtml(r.checks);
 renderSuggestion(r);
 drawSchematic();
 drawCharts(a);
 let comparisonHtml = '';
 if (r.comparison && r.checks.status !== 'evaluated') {
  const multiplier = r.comparison.multiplier;
  const compared = analyzeBeam({ ...a.input, uniformLoadPlf:r.comparison.totalKipFt * 1000, pointLoads:a.input.pointLoads.map(p => ({ ...p, loadLb:p.loadLb * multiplier })) });
  comparisonHtml = `<div class="calculation-detail"><h3>Safety factor comparison · illustrative</h3><p>Live uniform and point loads × ${fmt(multiplier,5)} (SF / 1.67). Left reaction ${fmt(compared.reactions.leftLb/1000)} kip; right reaction ${fmt(compared.reactions.rightLb/1000)} kip; maximum moment ${fmt(compared.maxMoment.momentKipFt)} kip-ft.</p><p>Not a verified OSHA combination or capacity check. Service diagrams remain unfactored.</p></div>`;
 }
 const lenIn = r.span * 12;
 const basis = `<div class="capacity-checks analysis-basis"><h3>Service analysis</h3>
 ${calculationRow('Section', `${escape(r.section)} · E = ${fmt(r.E,3)} ksi`, `I<sub>x</sub> = ${fmt(r.I,3)} in⁴`, '')}
 ${calculationRow('Beam self-weight', `Section weight / 1,000 = ${fmt(r.self * 1000,4)} / 1,000`, `${fmt(r.self,7)} kip/ft`, '')}
 ${calculationRow('Uniform load', `D + self-weight + L = ${fmt(r.dead,5)} + ${fmt(r.self,5)} + ${fmt(r.live,5)}`, `${fmt(r.total,5)} kip/ft`, '')}
 ${calculationRow('Point loads', 'Live loads; positions measured from left support', r.pointLoads.length ? r.pointLoads.map(p=>`${fmt(p.loadKip,3)} kip at ${fmt(p.locationFt,3)} ft`).join('; ') : 'None', '')}
 ${calculationRow('Left reaction', 'Combined loads', `${fmt(a.reactions.leftLb/1000,3)} kip`, '')}
 ${calculationRow('Right reaction', 'Combined loads', `${fmt(a.reactions.rightLb/1000,3)} kip`, '')}
 ${calculationRow('Maximum moment', `Combined loads at x = ${fmt(a.maxMoment.xFt,3)} ft`, `${fmt(a.maxMoment.momentKipFt,3)} kip-ft`, '')}
 ${calculationRow('Nominal EI deflection', 'Elastic bending', `${fmt(max.nominalDeflectionIn,4)} in`, '')}
 ${calculationRow('Adjusted EI deflection', `Nominal deflection / ${fmt(r.factor,4)}`, `${fmt(max.reducedDeflectionIn,4)} in`, '')}
 ${calculationRow('Lateral braces', 'Measured from left support; not vertical supports', `${r.braces.locations.map(x=>fmt(x,2)).join(', ')} ft`, '')}
 <p class="capacity-note">Beam bending only; shear deformation excluded. No overall adequacy or independent verification. Bearing, connections, and scaffold-specific capacity are not evaluated. AISC v15 section data is from a third-party mirror; verify against the official source.</p>
 <p class="capacity-note">Project: ${escape(r.project)} · Prepared by: ${escape(r.preparer)} · ${escape(r.timestamp)} · Engine 0.1.0</p></div>`;
 $('results').innerHTML = `<p class="empty-state"><strong>Service load case: 1.0D + 1.0L</strong> — results and diagrams below.</p><div class="result-grid"><div><span>Left reaction</span><strong>${fmt(a.reactions.leftLb/1000)} <small>kip</small></strong></div><div><span>Right reaction</span><strong>${fmt(a.reactions.rightLb/1000)} <small>kip</small></strong></div><div><span>Maximum moment</span><strong>${fmt(a.maxMoment.momentKipFt)} <small>kip-ft</small></strong></div><div><span>Nominal EI deflection</span><strong>${fmt(max.nominalDeflectionIn,4)} <small>in</small></strong></div><div><span>Adjusted EI deflection · 0.8 EI</span><strong>${fmt(max.reducedDeflectionIn,4)} <small>in</small></strong></div></div>${comparisonHtml}<details class="result-details"><summary>Strength checks &amp; calculation details</summary>${memberChecksHtml(r.checks)}${basis}</details>`;
}
$('report').disabled = true;
// A verified account's current acceptance covers the general preliminary-use
// notice. Guests and unavailable sessions retain the on-page acknowledgment.
fetch('/api/auth/session', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(session => {
 if (session?.authenticated === true && session.termsAccepted === true) {
  $('acknowledgement').checked = true;
  $('acknowledgement').closest('.acknowledgement').hidden = true;
 }
}).catch(() => {});
let pointLoadSequence = 0;
$('add-point-load').addEventListener('click', () => {
 const row = $('point-load-template').content.firstElementChild.cloneNode(true);
 const id = ++pointLoadSequence;
 row.querySelector('.point-load').id = `point-load-${id}`;
 row.querySelector('.point-location').id = `point-location-${id}`;
 row.querySelector('.point-load').setAttribute('aria-label', `Point load ${id}, kip`);
 row.querySelector('.point-location').setAttribute('aria-label', `Point load ${id} location from left support, feet`);
 $('point-loads').append(row);
 $('capacity-confirmed').checked = false;
 invalidate(); drawSchematic(); row.querySelector('.point-load').focus();
});
$('point-loads').addEventListener('click', e => {
 const button = e.target.closest('.remove-point-load');
 if (!button) return;
 button.closest('.point-load-row').remove();
 $('capacity-confirmed').checked = false;
 invalidate(); drawSchematic(); $('add-point-load').focus();
});
$('beam-form').addEventListener('submit', run);
$('beam-form').addEventListener('invalid', e => revealField(e.target), true);
const responseTabs = [...document.querySelectorAll('[data-response-tab]')];
function selectResponse(name, focus = false) {
 for (const tab of responseTabs) {
  const active = tab.dataset.responseTab === name;
  tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  document.getElementById(tab.getAttribute('aria-controls')).classList.toggle('is-active', active);
  if (active && focus) tab.focus();
 }
}
for (const [index, tab] of responseTabs.entries()) {
 tab.addEventListener('click', () => selectResponse(tab.dataset.responseTab));
 tab.addEventListener('keydown', e => {
  const target = e.key === 'ArrowRight' ? (index + 1) % responseTabs.length : e.key === 'ArrowLeft' ? (index + responseTabs.length - 1) % responseTabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? responseTabs.length - 1 : null;
  if (target === null) return;
  e.preventDefault(); selectResponse(responseTabs[target].dataset.responseTab, true);
 });
}

bindSchematic();
drawSchematic();
const confirmationInputs = new Set(['span', 'section', 'brace-locations', 'dead-load', 'live-load', 'elastic-modulus', 'inertia', 'stiffness-factor', 'load-comparison', 'custom-safety-factor', 'cb-method']);
$('beam-form').addEventListener('input', e => {
 if (confirmationInputs.has(e.target.id) || e.target.matches('.point-load, .point-location')) $('capacity-confirmed').checked = false;
 invalidate(); drawSchematic();
});
$('section').addEventListener('change', () => { $('capacity-confirmed').checked = false; properties(); drawSchematic(); });
$('enable-capacity').addEventListener('change', () => { $('capacity-fields').hidden = !$('enable-capacity').checked; invalidate(); });
$('load-comparison').addEventListener('change', () => {
 const custom = $('load-comparison').value === 'custom';
 $('custom-safety-row').hidden = !custom;
 $('custom-safety-factor').disabled = !custom;
 $('custom-safety-factor').required = custom;
 invalidate();
});
$('verdict').addEventListener('click', e => {
 if (!e.target.closest('[data-open-checks]')) return;
 revealField($('capacity-confirmed'));
 $('capacity-confirmed').focus();
});
$('suggestion').addEventListener('click', e => {
 const button = e.target.closest('[data-use-suggestion]');
 if (!button) return;
 const name = button.dataset.useSuggestion;
 if (!sections.some(section => section.AISC_Manual_Label === name)) return;
 $('section').value = name;
 $('capacity-confirmed').checked = false;
 properties();
 drawSchematic();
 revealField($('capacity-confirmed'));
 $('capacity-confirmed').focus({preventScroll:true});
 $('capacity-confirmed').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'center'});
});
let printDetails = null;
window.addEventListener('beforeprint', () => { if (printDetails !== null) return; printDetails = [...document.querySelectorAll('.output-column details')].filter(el => !el.open); printDetails.forEach(el => { el.open = true; }); });
window.addEventListener('afterprint', () => { if (printDetails === null) return; printDetails.forEach(el => { el.open = false; }); printDetails = null; });
$('report').addEventListener('click', () => { if (record) window.print(); });
fetch('./public/data/aisc-w-shapes-v15.json').then(r=>{if(!r.ok) throw Error('Section library failed to load.');return r.json();}).then(data=>{
 sections = data.sort((a,b)=>a.AISC_Manual_Label.localeCompare(b.AISC_Manual_Label,undefined,{numeric:true}));
 $('section').innerHTML = sections.map(s=>`<option value="${escape(s.AISC_Manual_Label)}">${escape(s.AISC_Manual_Label)}</option>`).join('');
 $('section').value = 'W16X31'; properties(); drawSchematic();
}).catch(err=>{$('error').textContent = err.message + ' Run the app through a local web server.';});
