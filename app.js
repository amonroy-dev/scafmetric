import { analyzeBeam } from './src/beam.js';
import { normalizePointLoads, pointLoadsForAnalysis } from './src/point-loads.js';
import { beamSelfWeight } from './src/beam-self-weight.js';
import { summarizeChecks, formatUtilization, describeUtilization } from './src/check-verdict.js';
import { checkDeflection } from './src/deflection-check.js';
import { suggestBeamSize } from './src/suggest-beam-size.js';
import { canConsiderLateralBracing } from './src/bracing-suggestion.js';
import { initializeBracingHelp } from './src/bracing-help.js';
import { checkFlexure } from './src/strength-flexure.js';
import { checkMajorAxisShear } from './src/strength-shear.js';
import { strengthComparisonLoads } from './src/strength-comparison.js';
import { requestedLoadComparison } from './src/load-comparison.js';
import { drawSchematic as drawBeamSchematic, bindSchematic } from './src/input-visual.js';
import { drawCharts, clearCharts } from './src/visuals.js';
import { parseFlangeBracing } from './src/bracing.js';
import { renderCalculationReport } from './src/calculation-report.js';
import { createDeflectionView } from './src/deflection-view.js';
import { initializeStepWizard } from './src/step-wizard.js';

const $ = id => document.getElementById(id);
const bracingHelp = initializeBracingHelp();
const fmt = (n, digits = 3) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const ratio = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
// Display units: forces in lbs, moments in lb-ft, distributed loads in lb/ft and
// stresses in psi; deflections stay in inches. The engine itself works in kips.
const lb = (kipValue, digits = 0) => fmt(kipValue * 1000, digits);
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let sections = [], record = null;
const emptyMetrics = $('results').innerHTML;
const emptyCharts = new Map(['shear-chart', 'moment-chart', 'deflection-chart'].map(id => [id, $(id).innerHTML]));
const deflectionView = createDeflectionView({ panel: document.querySelector('.drawing-panel'), button: $('animate-deflection'), select: $('deflection-scale'), readout: $('deflection-readout'), status: $('deflection-status') });
deflectionView.clear();
function drawSchematic() {
 syncUniformLoads();
 drawBeamSchematic({analysis:record?.analysis ?? null});
 $('model-section').textContent = $('section').value || 'Choose a section';
 $('model-span').textContent = `${$('span').value || '—'} ft span`;
 try {
  const bracing = readBracing();
  $('bracing-summary').textContent = `Max. unbraced length · Top ${fmt(Math.max(...bracing.top.segments))} ft · Bottom ${fmt(Math.max(...bracing.bottom.segments))} ft`;
 } catch (error) { $('bracing-summary').textContent = error.message; }
}
function revealField(field) {
 for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
}
function syncUniformLoads() {
 for (const [field, selector] of [['dead-load', '.uniform-dead'], ['live-load', '.uniform-live']]) {
  const values = [...document.querySelectorAll('.uniform-load-row')].map(row => {
   const value = row.querySelector(selector).value.trim();
   return value === '' ? NaN : Number(value);
  });
  // Invalid rows stay invalid even if another row would offset their value.
  $(field).value = values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((sum, value) => sum + value / 1000, 0) : 'NaN';
 }
}
function setLoadType(row) {
 const isPoint = row.dataset.loadType === 'point';
 row.classList.toggle('point-load-row', isPoint);
 row.classList.toggle('uniform-load-row', !isPoint);
 for (const [selector, active] of [['.uniform-fields', !isPoint], ['.point-fields', isPoint]]) {
  const fields = row.querySelector(selector);
  fields.hidden = !active;
  for (const input of fields.querySelectorAll('input')) {
   input.disabled = !active;
   input.required = active;
  }
 }
}
function labelLoadRows() {
 let point = 0, uniform = 0;
 document.querySelectorAll('.load-row').forEach(row => {
  const isPoint = row.dataset.loadType === 'point';
  const label = isPoint ? `P${++point}` : `U${++uniform}`;
  row.dataset.loadId = label;
  row.querySelector('.load-number').textContent = label;
  row.querySelector('.load-kind').textContent = isPoint ? 'Point load' : 'Uniform load';
  row.querySelector('.remove-load').setAttribute('aria-label', `Remove ${isPoint ? 'point' : 'uniform'} load ${label}`);
  row.querySelector('.uniform-dead').setAttribute('aria-label', `${label} dead load, pounds per foot`);
  row.querySelector('.uniform-live').setAttribute('aria-label', `${label} live load, pounds per foot`);
  row.querySelector('.point-dead').setAttribute('aria-label', `${label} point dead load, pounds`);
  row.querySelector('.point-live').setAttribute('aria-label', `${label} point live load, pounds`);
  row.querySelector('.point-location').setAttribute('aria-label', `${label} position from left support, feet`);
 });
}
let loadSequence = 0;
function addLoad({type = 'uniform', dead = 0, live = 0} = {}) {
 const row = $('load-template').content.firstElementChild.cloneNode(true);
 const id = ++loadSequence;
 row.dataset.loadType = type;
 for (const name of ['uniform-dead', 'uniform-live', 'point-dead', 'point-live', 'point-location']) row.querySelector(`.${name}`).id = `${name}-${id}`;
 row.querySelector('.uniform-dead').value = dead;
 row.querySelector('.uniform-live').value = live;
 row.querySelector('.point-dead').value = dead;
 row.querySelector('.point-live').value = live;
 setLoadType(row);
 $('load-rows').append(row);
 labelLoadRows();
 return row;
}
function updateSafetyFactor() {
 const selection = $('load-comparison').value;
 const custom = selection === 'custom';
 $('custom-safety-row').hidden = !custom;
 $('custom-safety-factor').disabled = !custom;
 $('custom-safety-factor').required = custom;
 $('safety-factor-note').textContent = {
  none: 'AISC ASD · service loads, no additional factor.',
  four: '4:1 illustrative comparison. Does not establish OSHA compliance.',
  custom: 'Custom live-load comparison, shown alongside AISC ASD.'
 }[selection];
}

const propUnits = { W:'lb/ft', A:'in²', d:'in', bf:'in', tw:'in', tf:'in', Ix:'in⁴', Sx:'in³', Zx:'in³', Iy:'in⁴', Sy:'in³', Zy:'in³', J:'in⁴', Cw:'in⁶', rx:'in', ry:'in', rts:'in', ho:'in' };
function selected() { return sections.find(s => s.AISC_Manual_Label === $('section').value); }
function properties() {
 const s = selected(); if (!s) return;
 $('inertia').value = s.Ix;
 try { $('self-weight').value = `${fmt(beamSelfWeight(s) * 1000, 4)} lb/ft`; } catch { $('self-weight').value = 'Section weight unavailable'; }
 const keys = Object.keys(propUnits);
 $('section-properties').innerHTML = keys.filter(k => s[k] != null).map(k => `<div><span>${escape(k)}</span><strong>${escape(s[k])} <small>${propUnits[k]}</small></strong></div>`).join('');
 invalidate();
}
function invalidate() {
 if (!record) return;
 record = null;
 document.querySelector('.drawing-panel')?.classList.remove('has-results', 'is-scanning');
 deflectionView.clear();
 $('verdict').innerHTML = '<div class="verdict-card verdict-incomplete"><strong class="verdict-title">Inputs changed</strong><p class="verdict-detail">Calculate again to update your beam check.</p></div>';
 $('results').innerHTML = emptyMetrics;
 $('suggestion').innerHTML = '';
 $('report').disabled = true;
 $('calculation-report').innerHTML = '';
 clearCharts();
 for (const [id, html] of emptyCharts) $(id).innerHTML = html;
}
function readBracing() {
 return parseFlangeBracing({top:$('top-brace-locations').value, bottom:$('bottom-brace-locations').value, spanFt:Number($('span').value)});
}
function memberChecks({section, analysis, pointLoads, topBracesFt, bottomBracesFt, Eksi, dead, live, self, comparison}) {
 if (!$('enable-capacity').checked) return { status: 'not_requested' };
 const missing = [];
 if (!$('capacity-confirmed').checked) missing.push('Confirm the steel-check assumptions for this beam.');
 if (Eksi !== 29000) missing.push('Set E to 29,000,000 psi for this AISC check.');
 if (missing.length) return { status:'not_evaluated', reason:missing.join(' ') };
 const demandKip = Math.max(Math.abs(analysis.maxShear.shearLb), Math.abs(analysis.minShear.shearLb))/1000;
 let flexure;
 try { flexure = { status:'evaluated', ...checkFlexure({section, analysis, topBracesFt, bottomBracesFt, cbMethod:$('cb-method').value, Eksi, Fyksi:50, confirmedLateralBracing:true, confirmedScope:true}) }; }
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
   const bendingAnalysis = analyzeBeam({ ...analysis.input, uniformLoadPlf:bendingLoad * 1000, pointLoads: pointLoadsForAnalysis(pointLoads, sf / 1.67) });
   bending = { status:'evaluated', ...checkFlexure({ section, analysis:bendingAnalysis, topBracesFt, bottomBracesFt, cbMethod:$('cb-method').value, Eksi, Fyksi:50, confirmedLateralBracing:true, confirmedScope:true }) };
  } catch (e) { bending = {status:'not_evaluated', reason:e instanceof Error ? e.message : 'Outside supported scope.'}; }
  try { const shearAnalysis = analyzeBeam({ ...analysis.input, uniformLoadPlf:shearLoad * 1000, pointLoads: pointLoadsForAnalysis(pointLoads, sf / 1.5) }); shearing = checkMajorAxisShear({section, FyKsi:50, Eksi, demandKip:Math.max(Math.abs(shearAnalysis.maxShear.shearLb), Math.abs(shearAnalysis.minShear.shearLb))/1000}); }
  catch (e) { shearing = {status:'not_evaluated', reason:e instanceof Error ? e.message : 'Outside supported scope.'}; }
  extra = {sf, bendingLoad, shearLoad, bending, shearing};
 }
 return {status:'evaluated', flexure, shear, extra, dead, live, self, pointLoads, section, spanFt:analysis.input.spanFt, comparisonSelection:$('load-comparison').value, cbMethod:$('cb-method').value};
}
function calculationRow(label, equation, result, reference = '') {
 return `<div class="capacity-row"><span class="capacity-label">${label}</span><span class="capacity-equation">${equation}</span><strong class="capacity-value">${result}</strong><span class="capacity-reference">${reference}</span></div>`;
}
function deadLoadRows({dead, self}) {
 return calculationRow('Beam self-weight', 'Included once in uniform DL', `${lb(self,3)} lb/ft`)
  + calculationRow('Uniform DL', `Entered DL + beam self-weight = ${lb(dead,3)} + ${lb(self,3)}`, `${lb(dead+self,3)} lb/ft`);
}
function comparisonLoadRows({dead, live, self, pointLoads = []}, sf, divisor, label) {
 const multiplier = sf / divisor;
 let html = '';
 if (dead > 0 || live > 0 || !pointLoads.length) {
  html += calculationRow(`${label} uniform LL`, `${lb(live,3)} × (${fmt(sf,8)} / ${divisor.toFixed(2)})`, `${lb(live*multiplier,1)} lb/ft`)
   + calculationRow(`${label} uniform load`, `DL + LL = ${lb(dead+self,3)} + ${lb(live*multiplier,1)}`, `${lb(dead+self+live*multiplier,1)} lb/ft`);
 }
 for (const point of pointLoads) {
  const name = escape(point.id);
  html += calculationRow(`${name} ${label.toLowerCase()} LL`, `${lb(point.liveKip,3)} × (${fmt(sf,8)} / ${divisor.toFixed(2)})`, `${lb(point.liveKip*multiplier,1)} lbs`)
   + calculationRow(`${name} ${label.toLowerCase()} load`, `DL + LL = ${lb(point.deadKip,3)} + ${lb(point.liveKip*multiplier,1)}; x = ${fmt(point.locationFt,3)} ft`, `${lb(point.deadKip+point.liveKip*multiplier,1)} lbs`);
 }
 return html;
}
function memberChecksHtml(check) {
 if (check.status === 'not_requested') return '<div class="calculation-detail"><h3>Steel member strength</h3><p>Not evaluated. Select the optional AISC member checks and confirm their assumptions to evaluate the supported limit states.</p></div>';
 if (check.status === 'not_evaluated') return `<div class="calculation-detail"><h3>Steel member strength</h3><p><strong>Additional information required.</strong> ${escape(check.reason)}</p></div>`;
 const f = check.flexure, sh = check.shear, props = check.section;
 let flex = `<p class="capacity-note"><strong>Bending: not evaluated.</strong> ${escape(f.reason || 'Outside supported scope.')}</p>`;
 if (f.status === 'evaluated') {
  const g = f.governingSegment;
  const rows = f.segments.map(seg => `<tr><td>${fmt(seg.startFt,3)}–${fmt(seg.endFt,3)}</td><td>${fmt(seg.LbFt,3)}</td><td>${ratio(seg.Cb)}</td><td>${lb(seg.MmaxKipFt)}</td><td>${lb(seg.MnKipFt)}</td><td>${lb(seg.allowableKipFt)}</td><td>${ratio(seg.utilization)}</td><td>${escape(seg.limitState)}</td></tr>`).join('');
  const c = f.compactness, flb = f.flangeLocalBuckling;
  let cbEquation = 'Specified';
  if (check.cbMethod === 'quarter') cbEquation = g.MmaxKipFt === 0 ? 'Zero moment: C<sub>b</sub> = 1.0' : `(12.5 × ${lb(g.MmaxKipFt)}) / (2.5 × ${lb(g.MmaxKipFt)} + 3 × ${lb(g.MaKipFt)} + 4 × ${lb(g.MbKipFt)} + 3 × ${lb(g.McKipFt)})`;
  const nominalEq = g.limitState === 'flange local buckling'
   ? (flb.equation === 'F3-1' ? `M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub> / 12)(λ − λ<sub>pf</sub>)/(λ<sub>rf</sub> − λ<sub>pf</sub>); flange local buckling governs` : `0.9Ek<sub>c</sub>S<sub>x</sub> / (12λ²); flange local buckling governs`)
   : g.ltbRegime === 'yielding'
   ? `M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12 = 50,000 × ${fmt(props.Zx,3)} / 12`
   : g.ltbRegime === 'inelastic LTB'
    ? `min[M<sub>p</sub>, C<sub>b</sub>(M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub> / 12)(L<sub>b</sub> − L<sub>p</sub>)/(L<sub>r</sub> − L<sub>p</sub>))]`
    : 'min(M<sub>p</sub>, F<sub>cr</sub>S<sub>x</sub> / 12); F<sub>cr</sub> per F2-4';
  const nominalRef = g.limitState === 'flange local buckling' ? `AISC ${flb.equation}` : g.ltbRegime === 'yielding' ? 'AISC F2-1' : g.ltbRegime === 'inelastic LTB' ? 'AISC F2-2' : 'AISC F2-3, F2-4';
  const flangeRow = c.flangeClass === 'compact'
   ? calculationRow('Flange compactness', 'b<sub>f</sub> / 2t<sub>f</sub> ≤ 0.38√(E / F<sub>y</sub>)', `${fmt(c.flangeRatio,3)} ≤ ${fmt(c.flangeLimit,3)}`, 'AISC B4.1b')
   : calculationRow('Flange compactness', `${c.flangeClass} flange: 0.38√(E / F<sub>y</sub>) &lt; b<sub>f</sub> / 2t<sub>f</sub> ${c.flangeClass === 'noncompact' ? '≤' : '&gt;'} 1.0√(E / F<sub>y</sub>)`, `${fmt(c.flangeLimit,3)} &lt; ${fmt(c.flangeRatio,3)} ${c.flangeClass === 'noncompact' ? '≤' : '&gt;'} ${fmt(c.flangeSlenderLimit,3)}`, 'AISC B4.1b, F3');
  const flbRow = flb ? calculationRow('Flange local buckling', flb.equation === 'F3-1' ? 'M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub> / 12)(λ − λ<sub>pf</sub>)/(λ<sub>rf</sub> − λ<sub>pf</sub>)' : `0.9Ek<sub>c</sub>S<sub>x</sub> / (12λ²); k<sub>c</sub> = ${fmt(flb.kc,3)}`, `${lb(flb.MnKipFt)} lb-ft`, `AISC ${flb.equation}`) : '';
  const cbRef = check.cbMethod === 'quarter' && g.MmaxKipFt !== 0 ? 'AISC F1-1' : '';
  flex = `<div class="capacity-section"><div class="capacity-heading"><h4>Flexure · major axis</h4><span>${g.utilization <= 1 ? 'Meets listed check' : 'Does not meet listed check'}</span></div>
  ${flangeRow}
  ${calculationRow('Web compactness', '(d − 2k) / t<sub>w</sub> ≤ 3.76√(E / F<sub>y</sub>)', `${fmt(f.compactness.webRatio,3)} ≤ ${fmt(f.compactness.webLimit,3)}`, 'AISC B4.1b')}
  ${calculationRow('Plastic moment', `F<sub>y</sub>Z<sub>x</sub> / 12 = 50,000 × ${fmt(props.Zx,3)} / 12`, `${lb(f.MpKipFt)} lb-ft`, 'AISC F2-1')}
  ${calculationRow('L<sub>p</sub>', '1.76r<sub>y</sub>√(E / F<sub>y</sub>) / 12', `${fmt(f.LpFt,3)} ft`, 'AISC F2-5')}
  ${calculationRow('L<sub>r</sub>', '1.95r<sub>ts</sub>E/(0.7F<sub>y</sub>) × √[J/(S<sub>x</sub>h<sub>o</sub>) + √((J/(S<sub>x</sub>h<sub>o</sub>))² + 6.76(0.7F<sub>y</sub>/E)²)] / 12', `${fmt(f.LrFt,3)} ft`, 'AISC F2-6')}
  ${flbRow}
  ${calculationRow('Governing segment', `${fmt(g.startFt,3)}–${fmt(g.endFt,3)} ft · ${escape(g.limitState)}`, `L<sub>b</sub> = ${fmt(g.LbFt,3)} ft`, '')}
  ${calculationRow('C<sub>b</sub>', cbEquation, ratio(g.Cb), cbRef)}
  ${g.ltbRegime === 'elastic LTB' && Number.isFinite(g.FcrKsi) ? calculationRow('Critical stress', 'C<sub>b</sub>π²E/(L<sub>b</sub>/r<sub>ts</sub>)² × √[1 + 0.078(J/(S<sub>x</sub>h<sub>o</sub>))(L<sub>b</sub>/r<sub>ts</sub>)²]', `${lb(g.FcrKsi)} psi`, 'AISC F2-4') : ''}
  ${calculationRow('Nominal moment', nominalEq, `${lb(g.MnKipFt)} lb-ft`, nominalRef)}
  ${calculationRow('Allowable moment', `M<sub>n</sub> / Ω<sub>b</sub> = ${lb(g.MnKipFt)} / 1.67`, `${lb(g.allowableKipFt)} lb-ft`, flb ? 'AISC F3' : 'AISC F2')}
  ${calculationRow('Moment ratio', `M / M<sub>allow</sub> = ${lb(g.MmaxKipFt)} / ${lb(g.allowableKipFt)}`, ratio(g.utilization), '')}
  <p class="capacity-scroll-hint">Swipe table to see all columns</p><div class="capacity-table-wrap"><table class="capacity-table"><caption>Unbraced segments · service load (moments in lb-ft)</caption><thead><tr><th>Segment (ft)</th><th>L<sub>b</sub> (ft)</th><th>C<sub>b</sub></th><th>M</th><th>M<sub>n</sub></th><th>M<sub>allow</sub></th><th>Ratio</th><th>Limit state</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
 }
 let shear = `<p class="capacity-note"><strong>Shear: not evaluated.</strong> ${escape(sh.reason || 'Outside supported scope.')}</p>`;
 if (sh.status === 'evaluated') shear = `<div class="capacity-section"><div class="capacity-heading"><h4>Shear · major axis</h4><span>${sh.meets ? 'Meets listed check' : 'Does not meet listed check'}</span></div>
 ${calculationRow('Web slenderness', 'h / t<sub>w</sub> ≤ 2.24√(E / F<sub>y</sub>)', `${fmt(sh.hOverTw,3)} ≤ ${fmt(sh.slendernessLimit,3)}`, 'AISC G2.1(a)')}
 ${calculationRow('Web area', `A<sub>w</sub> = d × t<sub>w</sub> = ${fmt(sh.dIn,3)} × ${fmt(sh.twIn,3)}`, `${fmt(sh.AwIn2,3)} in²`, 'AISC G2.1')}
 ${calculationRow('Nominal shear', `0.6F<sub>y</sub>A<sub>w</sub>C<sub>v1</sub> = 0.6 × 50,000 × ${fmt(sh.AwIn2,3)} × ${fmt(sh.Cv1,3)}`, `${lb(sh.nominalKip)} lbs`, 'AISC G2-1')}
 ${calculationRow('Allowable shear', `V<sub>n</sub> / Ω<sub>v</sub> = ${lb(sh.nominalKip)} / ${fmt(sh.omega,2)}`, `${lb(sh.allowableKip)} lbs`, 'AISC G2.1(a)')}
 ${calculationRow('Shear ratio', `V / V<sub>allow</sub> = ${lb(sh.demandKip)} / ${lb(sh.allowableKip)}`, ratio(sh.utilization), '')}</div>`;
 let extraHtml = '';
 if (check.extra) {
  const x = check.extra, fb = x.bending, vs = x.shearing;
  const bendRows = fb.status === 'evaluated' ? calculationRow('Moment ratio', `${lb(fb.governingSegment.MmaxKipFt)} / ${lb(fb.governingSegment.allowableKipFt)} lb-ft`, ratio(fb.governingSegment.utilization), fb.flangeLocalBuckling ? 'AISC F3' : 'AISC F2') : `<p class="capacity-note">Bending not evaluated: ${escape(fb.reason || 'Outside supported scope.')}</p>`;
  const shearRows = vs.status === 'evaluated' ? calculationRow('Shear ratio', `${lb(vs.demandKip)} / ${lb(vs.allowableKip)} lbs`, ratio(vs.utilization), 'AISC G2.1(a)') : `<p class="capacity-note">Shear not evaluated: ${escape(vs.reason || 'Outside supported scope.')}</p>`;
  extraHtml = `<div class="capacity-section"><h4>ASD — ${check.comparisonSelection === 'four' ? '4:1' : 'custom factor'} comparison</h4>
  ${deadLoadRows(check)}
  ${comparisonLoadRows(check, x.sf, 1.67, 'Bending')}
  ${fb.status === 'evaluated' ? calculationRow('Moment demand', `Peak combined moment, segment ${fmt(fb.governingSegment.startFt,3)}–${fmt(fb.governingSegment.endFt,3)} ft`, `${lb(fb.governingSegment.MmaxKipFt)} lb-ft`, '') : ''}
  ${bendRows}
  ${comparisonLoadRows(check, x.sf, 1.5, 'Shear')}
  ${vs.status === 'evaluated' ? calculationRow('Shear demand', 'Peak combined shear', `${lb(vs.demandKip)} lbs`, '') : ''}
  ${shearRows}</div>`;
 }
 return `<div class="capacity-checks"><h3>ASD — no additional factor</h3><p class="capacity-basis">AISC 360-16 ASD · A992 F<sub>y</sub> = 50,000 psi · nominal E = 29,000,000 psi · service 1.0D + 1.0L · C<sub>b</sub> ${check.cbMethod === 'quarter' ? 'quarter-point' : '= 1.0'}</p>${flex}${shear}${extraHtml}<p class="capacity-note"><strong>Not evaluated:</strong> bearing, local web forces, connections, axial force, torsion, brace design, and scaffold-specific requirements. The deflection limit is checked separately (see the verdict and the service analysis below). No overall adequacy is determined; verify section data independently.</p></div>`;
}
function run(e) {
 e.preventDefault(); $('error').textContent = '';
 try {
  if (!$('acknowledgement').checked) throw Error('Please acknowledge the preliminary-use notice before calculating.');
  const s = selected(); if (!s) throw Error('Select a beam section.');
  syncUniformLoads();
  // E is entered in psi; the analysis engine and the record keep it in ksi.
  const span=Number($('span').value), dead=Number($('dead-load').value), live=Number($('live-load').value), E=Number($('elastic-modulus').value)/1000, I=Number($('inertia').value), factor=Number($('stiffness-factor').value);
  if (dead < 0 || live < 0 || !Number.isFinite(dead+live)) throw Error('Loads must be finite, nonnegative numbers.');
  const pointLoads = normalizePointLoads([...document.querySelectorAll('.point-load-row')].map(row => {
   const dead = row.querySelector('.point-dead').value, live = row.querySelector('.point-live').value, location = row.querySelector('.point-location').value;
   if (dead === '' || live === '' || location === '') throw Error('Enter dead load, live load, and a location for each point load (use 0 for an unused load category).');
   return {id:row.dataset.loadId, deadKip:Number(dead)/1000, liveKip:Number(live)/1000, locationFt:Number(location)};
  }), span);
  const uniformLoads = [...document.querySelectorAll('.uniform-load-row')].map(row => ({id:row.dataset.loadId, deadKipFt:Number(row.querySelector('.uniform-dead').value)/1000, liveKipFt:Number(row.querySelector('.uniform-live').value)/1000}));
  const self = beamSelfWeight(s), total = dead+live+self, br = readBracing();
  const analysis = analyzeBeam({spanFt:span, uniformLoadPlf:total*1000, pointLoads:pointLoadsForAnalysis(pointLoads), Eksi:E, Iin4:I, stiffnessFactor:factor});
  const comparison = requestedLoadComparison({selection:$('load-comparison').value, customSafetyFactor:$('custom-safety-factor').value === '' ? NaN : Number($('custom-safety-factor').value), deadLoadKipFt:dead, liveLoadKipFt:live, selfWeightKipFt:self, spanFt:span});
  // Deflection is checked on every run, whether or not the AISC strength checks are on.
  const deflection = checkDeflection({analysis, limitRatio:Number($('deflection-limit').value)});
  const checks = {...memberChecks({section:s, analysis, pointLoads, topBracesFt:br.top.locations, bottomBracesFt:br.bottom.locations, Eksi:E, dead, live, self, comparison}), deflection};
  record = Object.freeze({comparison, checks, project:$('project').value || 'Untitled project', preparer:$('preparer').value || 'Not specified', section:s.AISC_Manual_Label, sectionProperties:s, span, dead, live, self, total, uniformLoads, pointLoads, E, I, factor, braces:br, analysis, timestamp:new Date().toISOString()});
  render(record); scanModel(); $('report').disabled = false;
  const resultsPanel = document.querySelector('.results-panel');
  resultsPanel.focus({preventScroll:true});
  if (window.matchMedia('(max-width: 760px)').matches) resultsPanel.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
 } catch(err) { invalidate(); $('error').textContent = err.message; }
}
// Segmented meters, in verdict order: percent of allowable for strength and percent
// of the selected limit for deflection. The bar caps at 100%; the label is rounded
// up to one decimal so it never contradicts the verdict.
function metersHtml(items) {
 if (!items.length) return '';
 return `<div class="meters" aria-label="Percent of allowable strength and of the deflection limit">${items.map(({label, utilization:value, kind}) => {
  const state = value > 1 ? 'over' : value > 0.9 ? 'near' : 'ok';
  return `<div class="meter meter-${state}${kind === 'deflection' ? ' meter-deflection' : ''}"><span class="meter-label">${escape(label)}</span><span class="meter-track" aria-hidden="true"><span class="meter-fill" style="--fill:${Math.min(Math.max(value, 0), 1).toFixed(4)}"></span></span><strong class="meter-value">${formatUtilization(value)}</strong></div>`;
 }).join('')}</div>`;
}
// Plain-language sag statement used whenever the deflection result is shown.
function sagText(d) {
 return `The beam sags <strong>${fmt(d.deflectionIn,4)} in</strong> at ${fmt(d.xFt,3)} ft under service load; the L/${d.limitRatio} limit for this ${fmt(d.spanFt,3)} ft span is <strong>${fmt(d.allowableIn,4)} in</strong>.`;
}
function verdictHtml(check) {
 const result = summarizeChecks(check);
 const d = check.deflection;
 const meters = metersHtml(result.items);
 if (result.status === 'incomplete') return `<div class="verdict-card verdict-incomplete"><strong class="verdict-title">Strength check pending</strong><p class="verdict-detail">${escape(result.detail)}</p>${meters}<button type="button" class="verdict-action" data-open-checks>Review settings</button></div>`;
 const notEvaluated = result.unavailable.length ? `<p class="verdict-detail">Not evaluated: ${escape(result.unavailable.join(' '))}</p>` : '';
 if (result.status === 'fail') {
  const strengthFailures = result.failed.filter(item => item.kind !== 'deflection');
  const deflectionFails = result.failed.some(item => item.kind === 'deflection');
  if (!strengthFailures.length) {
   // Deflection is the only failure: say so in plain words, because the strength meters look fine.
   const strong = check.status === 'evaluated' && !result.unavailable.length;
   return `<div class="verdict-card verdict-fail verdict-deflection"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">FAIL — deflection</strong><p class="verdict-detail"><strong>${strong ? 'Strong enough, but it bends too much.' : 'It bends too much.'}</strong> ${sagText(d)} Use a deeper or heavier section, a shorter span or less load, then calculate again.</p>${meters}${notEvaluated}</div>`;
  }
  const extra = deflectionFails ? `<br><strong>Deflection also fails.</strong> ${sagText(d)}` : '';
  return `<div class="verdict-card verdict-fail"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">${deflectionFails ? 'FAIL — strength and deflection' : 'FAIL — strength'}</strong><p class="verdict-detail"><strong>${escape(describeUtilization(strengthFailures[0], d))}</strong>${extra}</p>${meters}${notEvaluated}</div>`;
 }
 return `<div class="verdict-card verdict-pass"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">PASS — strength and deflection</strong><p class="verdict-detail"><strong>${escape(describeUtilization(result.governing, d))}</strong></p>${meters}</div>`;
}
function renderSuggestion(r) {
 const status = summarizeChecks(r.checks);
 if (status.status === 'incomplete' || status.unavailable?.length) { $('suggestion').innerHTML = ''; return; }
 const bracingOption = canConsiderLateralBracing(r.checks)
  ? '<div class="suggestion-bracing-actions"><button type="button" class="suggestion-bracing" data-review-bracing>Consider adding lateral bracing?</button><button type="button" class="bracing-help-trigger" data-open-bracing-help>What is lateral bracing?</button></div><div class="suggestion-or"><span>OR</span></div>'
  : '';
 let found;
 try {
  found = suggestBeamSize({sections, spanFt:r.span, deadLoadKipFt:r.dead, liveLoadKipFt:r.live, pointLoads:r.pointLoads,
   topBracesFt:r.braces.top.locations, bottomBracesFt:r.braces.bottom.locations, cbMethod:r.checks.cbMethod, Eksi:r.E,
   safetyFactor:r.comparison ? r.comparison.numerator : null,
   deflectionLimitRatio:r.checks.deflection.limitRatio, stiffnessFactor:r.factor,
   confirmedLateralBracing:true, confirmedScope:true});
 } catch {
  $('suggestion').innerHTML = ''; return;
 }
 if (found.status !== 'suggested') {
  $('suggestion').innerHTML = `<div class="suggestion-card">${bracingOption}<span class="suggestion-label">Suggested size</span><strong>No supported passing size found</strong><p>Review the loads and brace locations or consult an engineer.</p></div>`;
  return;
 }
 const name = found.section.AISC_Manual_Label;
 const button = name === r.section ? '<span class="suggestion-current">Currently selected</span>' : `<button type="button" class="suggestion-button" data-use-suggestion="${escape(name)}">Use ${escape(name)} →</button>`;
 $('suggestion').innerHTML = `<div class="suggestion-card">${bracingOption}<span class="suggestion-label">Suggested size</span><strong>${escape(name)} <small>· ${fmt(found.section.W, 3)} lb/ft</small></strong><p>Lowest weight among supported library sections passing the listed checks.</p>${button}</div>`;
}
function render(r) {
 const a = r.analysis; const max = a.maxDeflection;
 const dl = r.checks.deflection?.status === 'evaluated' ? r.checks.deflection : null;
 $('verdict').innerHTML = verdictHtml(r.checks);
 renderSuggestion(r);
 drawSchematic();
 drawCharts(a, {deflectionLimit:dl});
 let comparisonHtml = '';
 if (r.comparison && r.checks.status !== 'evaluated') {
  const multiplier = r.comparison.multiplier;
  const compared = analyzeBeam({ ...a.input, uniformLoadPlf:r.comparison.totalKipFt * 1000, pointLoads:pointLoadsForAnalysis(r.pointLoads, multiplier) });
  comparisonHtml = `<div class="capacity-checks"><h3>Safety factor comparison · illustrative</h3>${deadLoadRows(r)}${comparisonLoadRows(r, r.comparison.numerator, 1.67, 'Bending')}<p>Left reaction ${fmt(compared.reactions.leftLb, 0)} lbs; right reaction ${fmt(compared.reactions.rightLb, 0)} lbs; maximum moment ${lb(compared.maxMoment.momentKipFt)} lb-ft.</p><p>Not a verified OSHA combination or capacity check. Service diagrams remain unfactored.</p></div>`;
 }
 const basis = `<div class="capacity-checks analysis-basis"><h3>Service analysis</h3>
 ${calculationRow('Section', `${escape(r.section)} · E = ${lb(r.E)} psi`, `I<sub>x</sub> = ${fmt(r.I,3)} in⁴`, '')}
 ${deadLoadRows(r)}
 ${calculationRow('Uniform service load', `DL + LL = ${lb(r.dead+r.self,3)} + ${lb(r.live,3)}`, `${lb(r.total,3)} lb/ft`)}
 ${r.pointLoads.map(p => calculationRow(`${escape(p.id)} service load`, `DL + LL = ${lb(p.deadKip,3)} + ${lb(p.liveKip,3)}; x = ${fmt(p.locationFt,3)} ft`, `${lb(p.loadKip,3)} lbs`)).join('')}
 ${calculationRow('Left reaction', 'Combined loads', `${fmt(a.reactions.leftLb,0)} lbs`, '')}
 ${calculationRow('Right reaction', 'Combined loads', `${fmt(a.reactions.rightLb,0)} lbs`, '')}
 ${calculationRow('Maximum moment', `Combined loads at x = ${fmt(a.maxMoment.xFt,3)} ft`, `${lb(a.maxMoment.momentKipFt)} lb-ft`, '')}
 ${calculationRow('Nominal EI deflection', 'Elastic bending', `${fmt(max.nominalDeflectionIn,4)} in`, '')}
 ${calculationRow('Adjusted EI deflection', `Nominal deflection / ${fmt(r.factor,4)}`, `${fmt(max.reducedDeflectionIn,4)} in`, '')}
 ${dl ? calculationRow('Deflection limit', `δ ≤ L / ${dl.limitRatio} = ${fmt(r.span * 12,3)} / ${dl.limitRatio} in`, `${fmt(dl.allowableIn,4)} in · ${formatUtilization(dl.utilization)} ${dl.meets ? 'used' : '— exceeds'}`, 'Selected limit') : ''}
 ${calculationRow('Top flange braces', 'Compression flange; x from left support', `${r.braces.top.locations.map(x=>fmt(x,2)).join(', ')} ft`, 'AISC F2')}
 ${calculationRow('Bottom flange braces', 'Recorded separately; does not reduce top-flange Lb', `${r.braces.bottom.locations.map(x=>fmt(x,2)).join(', ')} ft`, '')}
 <p class="capacity-note">Beam bending only; shear deformation excluded. No overall adequacy or independent verification. Bearing, connections, and scaffold-specific capacity are not evaluated. AISC v15 section data is from a third-party mirror; verify against the official source.</p>
 <p class="capacity-note">Project: ${escape(r.project)} · Prepared by: ${escape(r.preparer)} · ${escape(r.timestamp)} · Engine 0.1.0</p></div>`;
 const kpi = (label, value, digits, unit, note = '', state = '') => `<div${state ? ` class="kpi-${state}"` : ''}><span>${label}</span><strong><span class="kpi-value" data-value="${value}" data-digits="${digits}">${fmt(value, digits)}</span> <small>${unit}</small></strong>${note}</div>`;
 const limitNote = dl ? `<em class="kpi-limit">${dl.meets ? 'Within' : 'Exceeds'} L/${dl.limitRatio} = ${fmt(dl.allowableIn,4)} in · ${formatUtilization(dl.utilization)}</em>` : '';
 $('results').innerHTML = `<p class="empty-state"><strong>Service load case: 1.0D + 1.0L</strong> — results and diagrams below.</p><div class="result-grid">${kpi('Left reaction', a.reactions.leftLb, 0, 'lbs')}${kpi('Right reaction', a.reactions.rightLb, 0, 'lbs')}${kpi('Maximum moment', a.maxMoment.momentKipFt * 1000, 0, 'lb-ft')}${kpi('Nominal EI deflection', max.nominalDeflectionIn, 4, 'in')}${kpi(`Adjusted EI deflection · ${fmt(r.factor,2)} EI`, max.reducedDeflectionIn, 4, 'in', limitNote, dl ? (dl.meets ? 'within' : 'over') : '')}</div>${comparisonHtml}<details class="result-details" open><summary>Strength checks &amp; calculation details</summary>${memberChecksHtml(r.checks)}${basis}</details>`;
 $('calculation-report').innerHTML = renderCalculationReport(r, {
  schematic:$('schematic').innerHTML,
  diagrams:['shear', 'moment', 'deflection'].map(name => ({name, html:$(`${name}-chart`).innerHTML}))
 });
 // Screen-only additions, made after the report snapshot so they never print.
 deflectionView.show(a, dl);
 document.querySelector('.drawing-panel')?.classList.add('has-results');
 countUp($('results'));
}
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Results count up to their exact formatted values; the final text is always fmt(value).
function countUp(container) {
 if (prefersReducedMotion()) return;
 const nodes = [...container.querySelectorAll('.kpi-value')];
 const start = performance.now(), duration = 650;
 const step = now => {
  const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
  for (const node of nodes) if (node.isConnected) node.textContent = fmt(Number(node.dataset.value) * (t < 1 ? eased : 1), Number(node.dataset.digits));
  if (t < 1) requestAnimationFrame(step);
 };
 requestAnimationFrame(step);
}
function scanModel() {
 const drawing = document.querySelector('.drawing-panel');
 if (!drawing || prefersReducedMotion()) return;
 drawing.classList.remove('is-scanning');
 void drawing.offsetWidth;
 drawing.classList.add('is-scanning');
}
function setLibraryStatus(online, text) {
 const status = $('library-status');
 if (!status) return;
 status.classList.toggle('is-online', online);
 status.classList.toggle('is-offline', !online);
 status.lastElementChild.textContent = text;
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
addLoad({dead: 200, live: 800});
updateSafetyFactor();
const stepWizard = initializeStepWizard({form:$('beam-form'), readBracing, invalidate, drawSchematic});
function addSelectedLoad() {
 const type = $('new-load-type').value;
 const row = addLoad({type});
 invalidate(); drawSchematic(); row.querySelector(type === 'point' ? '.point-dead' : '.uniform-dead').focus();
}
$('add-load').addEventListener('click', addSelectedLoad);
$('new-load-type').addEventListener('change', () => {
 $('load-rows').replaceChildren();
 addSelectedLoad();
});
$('load-rows').addEventListener('click', e => {
 const button = e.target.closest('.remove-load');
 if (!button) return;
 button.closest('.load-row').remove();
 labelLoadRows();
 invalidate(); drawSchematic(); $('add-load').focus();
});
$('beam-form').addEventListener('submit', e => { if (stepWizard.canSubmit()) run(e); else e.preventDefault(); });
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
$('beam-form').addEventListener('input', e => {
 if (e.target.id === 'new-load-type') return;
 invalidate(); drawSchematic();
});
$('section').addEventListener('change', () => {  properties(); drawSchematic(); });
$('enable-capacity').addEventListener('change', () => { $('capacity-fields').hidden = !$('enable-capacity').checked; invalidate(); });
$('load-comparison').addEventListener('change', () => {
 updateSafetyFactor();

 invalidate(); drawSchematic();
});
$('verdict').addEventListener('click', e => {
 if (!e.target.closest('[data-open-checks]')) return;
 revealField($('capacity-confirmed'));
 $('capacity-confirmed').focus();
});
$('suggestion').addEventListener('click', e => {
 if (e.target.closest('[data-review-bracing]')) {
  const target = document.querySelector('.brace-editor[data-flange="top"] .next-brace');
  bracingHelp.highlight();
  revealField(target);
  target.focus({preventScroll:true});
  target.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'center'});
  return;
 }
 const button = e.target.closest('[data-use-suggestion]');
 if (!button) return;
 const name = button.dataset.useSuggestion;
 if (!sections.some(section => section.AISC_Manual_Label === name)) return;
 $('section').value = name;

 properties();
 drawSchematic();
 revealField($('capacity-confirmed'));
 $('capacity-confirmed').focus({preventScroll:true});
 $('capacity-confirmed').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'center'});
});
$('report').addEventListener('click', () => { if (record) window.print(); });
fetch('./public/data/aisc-w-shapes-v15.json').then(r=>{if(!r.ok) throw Error('Section library failed to load.');return r.json();}).then(data=>{
 sections = data.sort((a,b)=>a.AISC_Manual_Label.localeCompare(b.AISC_Manual_Label,undefined,{numeric:true}));
 $('section').innerHTML = sections.map(s=>`<option value="${escape(s.AISC_Manual_Label)}">${escape(s.AISC_Manual_Label)}</option>`).join('');
 // A size chosen in the landing page's section library arrives as ?section=W14X22.
 const requested = new URLSearchParams(location.search).get('section');
 $('section').value = sections.some(s => s.AISC_Manual_Label === requested) ? requested : 'W16X31';
 properties(); drawSchematic();
 setLibraryStatus(true, `AISC v15 library · ${sections.length} W-shapes`);
}).catch(err=>{$('error').textContent = err.message + ' Run the app through a local web server.'; setLibraryStatus(false, 'Section library offline');});

for (const editor of document.querySelectorAll('.brace-editor')) {
 const flange = editor.dataset.flange;
 const list = editor.querySelector('.brace-list');
 const sync = () => {
  $(`${flange}-brace-locations`).value = [...list.querySelectorAll('input')].map(input => input.value).filter(value => value !== '').join(', ');
  invalidate(); drawSchematic();
 };
 const next = () => {
  const row = document.createElement('div'); row.className = 'brace-entry';
  const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = 'any'; input.placeholder = 'Position · ft'; input.setAttribute('aria-label', `${flange} flange brace position in feet`);
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove brace');
  remove.addEventListener('click', () => { row.remove(); sync(); }); input.addEventListener('input', sync);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (input.value !== '') next(); } });
  row.append(input, remove); list.append(row); input.focus();
  $('brace-cleared').textContent = '';
 };
 editor.querySelector('.next-brace').addEventListener('click', next);
}
// Brace stations are positions along one particular span, so a new span clears
// them instead of keeping stale or out-of-range positions. This listener runs on
// the field itself, before the form-level listener redraws the model.
let previousSpan = $('span').value;
$('span').addEventListener('input', () => {
 if ($('span').value === previousSpan) return;
 previousSpan = $('span').value;
 let cleared = false;
 for (const editor of document.querySelectorAll('.brace-editor')) {
  const list = editor.querySelector('.brace-list');
  if (list.childElementCount) { list.replaceChildren(); cleared = true; }
  $(`${editor.dataset.flange}-brace-locations`).value = '';
 }
 if (cleared) $('brace-cleared').textContent = 'Span changed, so the brace positions were cleared. Enter them again for the new span.';
});
