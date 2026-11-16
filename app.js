import { analyzeBeam } from './src/beam.js';
import { beamSelfWeight } from './src/beam-self-weight.js';
import { summarizeChecks, formatUtilization } from './src/check-verdict.js';
import { suggestBeamSize } from './src/suggest-beam-size.js';
import { checkFlexure } from './src/strength-flexure.js';
import { checkMajorAxisShear } from './src/strength-shear.js';
import { strengthComparisonLoads } from './src/strength-comparison.js';
import { requestedLoadComparison } from './src/load-comparison.js';
import { drawSchematic as drawBeamSchematic, bindSchematic } from './src/input-visual.js';
import { drawCharts, clearCharts } from './src/visuals.js';
import { parseFlangeBracing } from './src/bracing.js';
import { renderCalculationReport } from './src/calculation-report.js';
import { createDeflectionView } from './src/deflection-view.js';

const $ = id => document.getElementById(id);
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
 drawBeamSchematic();
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
// Changing a row's type starts it fresh, as if newly added, so values entered
// for the other type never linger hidden or reappear on switching back.
function resetLoadValues(row) {
 row.querySelector('.uniform-dead').value = '0';
 row.querySelector('.uniform-live').value = '0';
 row.querySelector('.point-load').value = '';
 row.querySelector('.point-location').value = '';
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
  let picker = row.querySelector('.row-load-type');
  if (!picker) { picker = document.createElement('select'); picker.className = 'row-load-type'; row.querySelector('.load-kind').replaceWith(picker); picker.innerHTML = '<option value="uniform">Uniform load</option><option value="point">Point load</option>'; picker.addEventListener('change', () => { row.dataset.loadType = picker.value; resetLoadValues(row); setLoadType(row); labelLoadRows(); invalidate(); drawSchematic(); }); }
  picker.value = isPoint ? 'point' : 'uniform'; picker.setAttribute('aria-label', `${label} load type`);
  row.querySelector('.remove-load').setAttribute('aria-label', `Remove ${isPoint ? 'point' : 'uniform'} load ${label}`);
  row.querySelector('.uniform-dead').setAttribute('aria-label', `${label} dead load, pounds per foot`);
  row.querySelector('.uniform-live').setAttribute('aria-label', `${label} live load, pounds per foot`);
  row.querySelector('.point-load').setAttribute('aria-label', `${label} point load, pounds`);
  row.querySelector('.point-location').setAttribute('aria-label', `${label} position from left support, feet`);
 });
}
let loadSequence = 0;
function addLoad({type = 'uniform', dead = 0, live = 0} = {}) {
 const row = $('load-template').content.firstElementChild.cloneNode(true);
 const id = ++loadSequence;
 row.dataset.loadType = type;
 for (const name of ['uniform-dead', 'uniform-live', 'point-load', 'point-location']) row.querySelector(`.${name}`).id = `${name}-${id}`;
 row.querySelector('.uniform-dead').value = dead;
 row.querySelector('.uniform-live').value = live;
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
function memberChecks({section, analysis, topBracesFt, bottomBracesFt, Eksi, dead, live, self, comparison}) {
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
   const bendingAnalysis = analyzeBeam({ ...analysis.input, uniformLoadPlf:bendingLoad * 1000, pointLoads: analysis.input.pointLoads.map(p => ({...p, loadLb: p.loadLb * sf / 1.67})) });
   bending = { status:'evaluated', ...checkFlexure({ section, analysis:bendingAnalysis, topBracesFt, bottomBracesFt, cbMethod:$('cb-method').value, Eksi, Fyksi:50, confirmedLateralBracing:true, confirmedScope:true }) };
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
  const rows = f.segments.map(seg => `<tr><td>${fmt(seg.startFt,3)}–${fmt(seg.endFt,3)}</td><td>${fmt(seg.LbFt,3)}</td><td>${ratio(seg.Cb)}</td><td>${lb(seg.MmaxKipFt)}</td><td>${lb(seg.MnKipFt)}</td><td>${lb(seg.allowableKipFt)}</td><td>${ratio(seg.utilization)}</td></tr>`).join('');
  let cbEquation = 'Specified';
  if (check.cbMethod === 'quarter') cbEquation = g.MmaxKipFt === 0 ? 'Zero moment: C<sub>b</sub> = 1.0' : `(12.5 × ${lb(g.MmaxKipFt)}) / (2.5 × ${lb(g.MmaxKipFt)} + 3 × ${lb(g.MaKipFt)} + 4 × ${lb(g.MbKipFt)} + 3 × ${lb(g.McKipFt)})`;
  const nominalEq = g.ltbRegime === 'yielding'
   ? `M<sub>p</sub> = F<sub>y</sub>Z<sub>x</sub> / 12 = 50,000 × ${fmt(props.Zx,3)} / 12`
   : g.ltbRegime === 'inelastic LTB'
    ? `min[M<sub>p</sub>, C<sub>b</sub>(M<sub>p</sub> − (M<sub>p</sub> − 0.7F<sub>y</sub>S<sub>x</sub> / 12)(L<sub>b</sub> − L<sub>p</sub>)/(L<sub>r</sub> − L<sub>p</sub>))]`
    : 'min(M<sub>p</sub>, F<sub>cr</sub>S<sub>x</sub> / 12); F<sub>cr</sub> per F2-4';
  const nominalRef = g.ltbRegime === 'yielding' ? 'AISC F2-1' : g.ltbRegime === 'inelastic LTB' ? 'AISC F2-2' : 'AISC F2-3, F2-4';
  const cbRef = check.cbMethod === 'quarter' && g.MmaxKipFt !== 0 ? 'AISC F1-1' : '';
  flex = `<div class="capacity-section"><div class="capacity-heading"><h4>Flexure · major axis</h4><span>${g.utilization <= 1 ? 'Meets listed check' : 'Does not meet listed check'}</span></div>
  ${calculationRow('Flange compactness', 'b<sub>f</sub> / 2t<sub>f</sub> ≤ 0.38√(E / F<sub>y</sub>)', `${fmt(f.compactness.flangeRatio,3)} ≤ ${fmt(f.compactness.flangeLimit,3)}`, 'AISC B4.1b')}
  ${calculationRow('Web compactness', '(d − 2k) / t<sub>w</sub> ≤ 3.76√(E / F<sub>y</sub>)', `${fmt(f.compactness.webRatio,3)} ≤ ${fmt(f.compactness.webLimit,3)}`, 'AISC B4.1b')}
  ${calculationRow('Plastic moment', `F<sub>y</sub>Z<sub>x</sub> / 12 = 50,000 × ${fmt(props.Zx,3)} / 12`, `${lb(f.MpKipFt)} lb-ft`, 'AISC F2-1')}
  ${calculationRow('L<sub>p</sub>', '1.76r<sub>y</sub>√(E / F<sub>y</sub>) / 12', `${fmt(f.LpFt,3)} ft`, 'AISC F2-5')}
  ${calculationRow('L<sub>r</sub>', '1.95r<sub>ts</sub>E/(0.7F<sub>y</sub>) × √[J/(S<sub>x</sub>h<sub>o</sub>) + √((J/(S<sub>x</sub>h<sub>o</sub>))² + 6.76(0.7F<sub>y</sub>/E)²)] / 12', `${fmt(f.LrFt,3)} ft`, 'AISC F2-6')}
  ${calculationRow('Governing segment', `${fmt(g.startFt,3)}–${fmt(g.endFt,3)} ft · ${escape(g.ltbRegime)}`, `L<sub>b</sub> = ${fmt(g.LbFt,3)} ft`, '')}
  ${calculationRow('C<sub>b</sub>', cbEquation, ratio(g.Cb), cbRef)}
  ${g.ltbRegime === 'elastic LTB' && Number.isFinite(g.FcrKsi) ? calculationRow('Critical stress', 'C<sub>b</sub>π²E/(L<sub>b</sub>/r<sub>ts</sub>)² × √[1 + 0.078(J/(S<sub>x</sub>h<sub>o</sub>))(L<sub>b</sub>/r<sub>ts</sub>)²]', `${lb(g.FcrKsi)} psi`, 'AISC F2-4') : ''}
  ${calculationRow('Nominal moment', nominalEq, `${lb(g.MnKipFt)} lb-ft`, nominalRef)}
  ${calculationRow('Allowable moment', `M<sub>n</sub> / Ω<sub>b</sub> = ${lb(g.MnKipFt)} / 1.67`, `${lb(g.allowableKipFt)} lb-ft`, 'AISC F2')}
  ${calculationRow('Moment ratio', `M / M<sub>allow</sub> = ${lb(g.MmaxKipFt)} / ${lb(g.allowableKipFt)}`, ratio(g.utilization), '')}
  <p class="capacity-scroll-hint">Swipe table to see all columns</p><div class="capacity-table-wrap"><table class="capacity-table"><caption>Unbraced segments · service load (moments in lb-ft)</caption><thead><tr><th>Segment (ft)</th><th>L<sub>b</sub> (ft)</th><th>C<sub>b</sub></th><th>M</th><th>M<sub>n</sub></th><th>M<sub>allow</sub></th><th>Ratio</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
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
  const bendRows = fb.status === 'evaluated' ? calculationRow('Moment ratio', `${lb(fb.governingSegment.MmaxKipFt)} / ${lb(fb.governingSegment.allowableKipFt)} lb-ft`, ratio(fb.governingSegment.utilization), 'AISC F2') : `<p class="capacity-note">Bending not evaluated: ${escape(fb.reason || 'Outside supported scope.')}</p>`;
  const shearRows = vs.status === 'evaluated' ? calculationRow('Shear ratio', `${lb(vs.demandKip)} / ${lb(vs.allowableKip)} lbs`, ratio(vs.utilization), 'AISC G2.1(a)') : `<p class="capacity-note">Shear not evaluated: ${escape(vs.reason || 'Outside supported scope.')}</p>`;
  extraHtml = `<div class="capacity-section"><h4>ASD — ${check.comparisonSelection === 'four' ? '4:1' : 'custom factor'} comparison</h4><p class="capacity-note"><strong>Illustrative only.</strong> Not a verified OSHA or ASD load combination; maximum intended load and failure-capacity basis require review.</p>
  ${calculationRow('Bending load', `D + self-weight + (SF / 1.67)L = ${lb(check.dead,2)} + ${lb(check.self,2)} + (${fmt(x.sf,8)} / 1.67 × ${lb(check.live,2)})`, `${lb(x.bendingLoad,1)} lb/ft`, '')}
  ${fb.status === 'evaluated' ? calculationRow('Moment demand', `Peak combined moment, segment ${fmt(fb.governingSegment.startFt,3)}–${fmt(fb.governingSegment.endFt,3)} ft`, `${lb(fb.governingSegment.MmaxKipFt)} lb-ft`, '') : ''}
  ${bendRows}
  <p class="capacity-note">Point loads are treated as live loads and multiplied by SF / 1.67 for bending and SF / 1.50 for shear.</p>
  ${calculationRow('Shear load', `D + self-weight + (SF / 1.50)L = ${lb(check.dead,2)} + ${lb(check.self,2)} + (${fmt(x.sf,8)} / 1.50 × ${lb(check.live,2)})`, `${lb(x.shearLoad,1)} lb/ft`, '')}
  ${vs.status === 'evaluated' ? calculationRow('Shear demand', 'Peak combined shear', `${lb(vs.demandKip)} lbs`, '') : ''}
  ${shearRows}</div>`;
 }
 return `<div class="capacity-checks"><h3>ASD — no additional factor</h3><p class="capacity-basis">AISC 360-16 ASD · A992 F<sub>y</sub> = 50,000 psi · nominal E = 29,000,000 psi · service 1.0D + 1.0L · C<sub>b</sub> ${check.cbMethod === 'quarter' ? 'quarter-point' : '= 1.0'}</p>${flex}${shear}${extraHtml}<p class="capacity-note"><strong>Not evaluated:</strong> bearing, local web forces, connections, axial force, torsion, deflection limits, brace design, and scaffold-specific requirements. No overall adequacy is determined; verify section data independently.</p></div>`;
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
  const pointLoads = [...document.querySelectorAll('.point-load-row')].map(row => {
   const load = row.querySelector('.point-load').value, location = row.querySelector('.point-location').value;
   if (load === '' || location === '') throw Error('Enter a load and location for each point load.');
   const loadKip = Number(load) / 1000, locationFt = Number(location);
   if (!Number.isFinite(loadKip) || loadKip < 0 || !Number.isFinite(locationFt) || locationFt < 0 || locationFt > span) throw Error('Point loads must be nonnegative and located between the supports.');
   return {id:row.dataset.loadId, loadKip, locationFt};
  });
  const uniformLoads = [...document.querySelectorAll('.uniform-load-row')].map(row => ({id:row.dataset.loadId, deadKipFt:Number(row.querySelector('.uniform-dead').value)/1000, liveKipFt:Number(row.querySelector('.uniform-live').value)/1000}));
  const self = beamSelfWeight(s), total = dead+live+self, br = readBracing();
  const analysis = analyzeBeam({spanFt:span, uniformLoadPlf:total*1000, pointLoads:pointLoads.map(p=>({loadLb:p.loadKip*1000, locationFt:p.locationFt})), Eksi:E, Iin4:I, stiffnessFactor:factor});
  const comparison = requestedLoadComparison({selection:$('load-comparison').value, customSafetyFactor:$('custom-safety-factor').value === '' ? NaN : Number($('custom-safety-factor').value), deadLoadKipFt:dead, liveLoadKipFt:live, selfWeightKipFt:self, spanFt:span});
  const checks = memberChecks({section:s, analysis, topBracesFt:br.top.locations, bottomBracesFt:br.bottom.locations, Eksi:E, dead, live, self, comparison});
  record = Object.freeze({comparison, checks, project:$('project').value || 'Untitled project', preparer:$('preparer').value || 'Not specified', section:s.AISC_Manual_Label, sectionProperties:s, span, dead, live, self, total, uniformLoads, pointLoads, E, I, factor, braces:br, analysis, timestamp:new Date().toISOString()});
  render(record); scanModel(); $('report').disabled = false;
  const resultsPanel = document.querySelector('.results-panel');
  resultsPanel.focus({preventScroll:true});
  if (window.matchMedia('(max-width: 760px)').matches) resultsPanel.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
 } catch(err) { invalidate(); $('error').textContent = err.message; }
}
// Demand-to-capacity ratios for each evaluated check, in the same order as the verdict.
function utilizationItems(check) {
 if (check?.status !== 'evaluated') return [];
 const items = [];
 const add = (name, result, flexure = false) => {
  const value = flexure ? result?.governingSegment?.utilization : result?.utilization;
  if (result?.status === 'evaluated' && Number.isFinite(value)) items.push({name, value});
 };
 add('Bending', check.flexure, true);
 add('Shear', check.shear);
 if (check.extra) {
  const label = check.comparisonSelection === 'four' ? '4:1' : 'Custom SF';
  add(`${label} bending`, check.extra.bending, true);
  add(`${label} shear`, check.extra.shearing);
 }
 return items;
}
// Segmented meters showing percent of allowable. The bar caps at 100%; the label
// is rounded up to one decimal so it never contradicts the verdict.
function metersHtml(check) {
 const items = utilizationItems(check);
 if (!items.length) return '';
 return `<div class="meters" aria-label="Percent of allowable strength">${items.map(({name, value}) => {
  const state = value > 1 ? 'over' : value > 0.9 ? 'near' : 'ok';
  return `<div class="meter meter-${state}"><span class="meter-label">${escape(name)}</span><span class="meter-track" aria-hidden="true"><span class="meter-fill" style="--fill:${Math.min(Math.max(value, 0), 1).toFixed(4)}"></span></span><strong class="meter-value">${formatUtilization(value)}</strong></div>`;
 }).join('')}</div>`;
}
function verdictHtml(check) {
 const result = summarizeChecks(check);
 const scope = '<p class="verdict-scope">These are preliminary bending and shear checks only. Bearing, connections, deflection limits, bracing and scaffold requirements need separate review.</p>';
 if (result.status === 'incomplete') return `<div class="verdict-card verdict-incomplete"><strong class="verdict-title">Strength check pending</strong><p class="verdict-detail">${escape(result.detail)}</p>${metersHtml(check)}<button type="button" class="verdict-action" data-open-checks>Review settings</button></div>`;
 const item = result.governing;
 const governing = `${escape(item.name)} · ${formatUtilization(item.utilization)} of allowable`;
 if (result.status === 'fail') return `<div class="verdict-card verdict-fail"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">FAIL — listed check</strong><p class="verdict-detail"><strong>${governing}</strong><br>Demand exceeds the allowable strength. Try a larger section or review the loads and brace locations, then calculate again.</p>${metersHtml(check)}${result.unavailable.length ? `<p class="verdict-detail">Other checks not evaluated: ${escape(result.unavailable.join(' '))}</p>` : ''}${scope}</div>`;
 return `<div class="verdict-card verdict-pass"><span class="verdict-label">STEEL CHECK</span><strong class="verdict-title">PASS — listed bending and shear checks</strong><p class="verdict-detail"><strong>${governing}</strong><br>The evaluated demand is within the allowable strength.</p>${metersHtml(check)}${scope}</div>`;
}
function renderSuggestion(r) {
 const status = summarizeChecks(r.checks);
 if (status.status === 'incomplete' || status.unavailable?.length) { $('suggestion').innerHTML = ''; return; }
 let found;
 try {
  found = suggestBeamSize({sections, spanFt:r.span, deadLoadKipFt:r.dead, liveLoadKipFt:r.live, pointLoads:r.pointLoads,
   topBracesFt:r.braces.top.locations, bottomBracesFt:r.braces.bottom.locations, cbMethod:r.checks.cbMethod, Eksi:r.E,
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
  comparisonHtml = `<div class="calculation-detail"><h3>Safety factor comparison · illustrative</h3><p>Live uniform and point loads × ${fmt(multiplier,5)} (SF / 1.67). Left reaction ${fmt(compared.reactions.leftLb, 0)} lbs; right reaction ${fmt(compared.reactions.rightLb, 0)} lbs; maximum moment ${lb(compared.maxMoment.momentKipFt)} lb-ft.</p><p>Not a verified OSHA combination or capacity check. Service diagrams remain unfactored.</p></div>`;
 }
 const basis = `<div class="capacity-checks analysis-basis"><h3>Service analysis</h3>
 ${calculationRow('Section', `${escape(r.section)} · E = ${lb(r.E)} psi`, `I<sub>x</sub> = ${fmt(r.I,3)} in⁴`, '')}
 ${calculationRow('Beam self-weight', 'AISC section weight', `${lb(r.self,2)} lb/ft`, '')}
 ${calculationRow('Uniform load', `D + self-weight + L = ${lb(r.dead,2)} + ${lb(r.self,2)} + ${lb(r.live,2)}`, `${lb(r.total,2)} lb/ft`, '')}
 ${calculationRow('Point loads', 'Live loads; positions measured from left support', r.pointLoads.length ? r.pointLoads.map(p=>`${lb(p.loadKip,2)} lbs at ${fmt(p.locationFt,3)} ft`).join('; ') : 'None', '')}
 ${calculationRow('Left reaction', 'Combined loads', `${fmt(a.reactions.leftLb,0)} lbs`, '')}
 ${calculationRow('Right reaction', 'Combined loads', `${fmt(a.reactions.rightLb,0)} lbs`, '')}
 ${calculationRow('Maximum moment', `Combined loads at x = ${fmt(a.maxMoment.xFt,3)} ft`, `${lb(a.maxMoment.momentKipFt)} lb-ft`, '')}
 ${calculationRow('Nominal EI deflection', 'Elastic bending', `${fmt(max.nominalDeflectionIn,4)} in`, '')}
 ${calculationRow('Adjusted EI deflection', `Nominal deflection / ${fmt(r.factor,4)}`, `${fmt(max.reducedDeflectionIn,4)} in`, '')}
 ${calculationRow('Top flange braces', 'Compression flange; x from left support', `${r.braces.top.locations.map(x=>fmt(x,2)).join(', ')} ft`, 'AISC F2')}
 ${calculationRow('Bottom flange braces', 'Recorded separately; does not reduce top-flange Lb', `${r.braces.bottom.locations.map(x=>fmt(x,2)).join(', ')} ft`, '')}
 <p class="capacity-note">Beam bending only; shear deformation excluded. No overall adequacy or independent verification. Bearing, connections, and scaffold-specific capacity are not evaluated. AISC v15 section data is from a third-party mirror; verify against the official source.</p>
 <p class="capacity-note">Project: ${escape(r.project)} · Prepared by: ${escape(r.preparer)} · ${escape(r.timestamp)} · Engine 0.1.0</p></div>`;
 const kpi = (label, value, digits, unit) => `<div><span>${label}</span><strong><span class="kpi-value" data-value="${value}" data-digits="${digits}">${fmt(value, digits)}</span> <small>${unit}</small></strong></div>`;
 $('results').innerHTML = `<p class="empty-state"><strong>Service load case: 1.0D + 1.0L</strong> — results and diagrams below.</p><div class="result-grid">${kpi('Left reaction', a.reactions.leftLb, 0, 'lbs')}${kpi('Right reaction', a.reactions.rightLb, 0, 'lbs')}${kpi('Maximum moment', a.maxMoment.momentKipFt * 1000, 0, 'lb-ft')}${kpi('Nominal EI deflection', max.nominalDeflectionIn, 4, 'in')}${kpi('Adjusted EI deflection · 0.8 EI', max.reducedDeflectionIn, 4, 'in')}</div>${comparisonHtml}<details class="result-details"><summary>Strength checks &amp; calculation details</summary>${memberChecksHtml(r.checks)}${basis}</details>`;
 $('calculation-report').innerHTML = renderCalculationReport(r, {
  schematic:$('schematic').innerHTML,
  diagrams:['shear', 'moment', 'deflection'].map(name => ({name, html:$(`${name}-chart`).innerHTML}))
 });
 // Screen-only additions, made after the report snapshot so they never print.
 deflectionView.show(a);
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
$('add-load').addEventListener('click', () => {
 const type = $('new-load-type').value;
 const row = addLoad({type});
 invalidate(); drawSchematic(); row.querySelector(type === 'point' ? '.point-load' : '.uniform-dead').focus();
});
$('load-rows').addEventListener('click', e => {
 const button = e.target.closest('.remove-load');
 if (!button) return;
 button.closest('.load-row').remove();
 labelLoadRows();
 invalidate(); drawSchematic(); $('add-load').focus();
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
