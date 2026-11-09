import { analyzeBeam } from './src/beam.js';
import { requestedLoadComparison } from './src/load-comparison.js';
import { drawSchematic, bindSchematic, drawCharts, clearCharts } from './src/visuals.js';

const $ = id => document.getElementById(id);
const fmt = (n, digits = 3) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let sections = [], record = null;
const propUnits = { W:'lb/ft', A:'in²', d:'in', bf:'in', tw:'in', tf:'in', Ix:'in⁴', Sx:'in³', Zx:'in³', Iy:'in⁴', Sy:'in³', Zy:'in³', J:'in⁴', Cw:'in⁶', rx:'in', ry:'in', rts:'in', ho:'in' };
function selected() { return sections.find(s => s.AISC_Manual_Label === $('section').value); }
function properties() {
 const s = selected(); if (!s) return;
 $('inertia').value = s.Ix;
 const keys = Object.keys(propUnits);
 $('section-properties').innerHTML = keys.filter(k => s[k] != null).map(k => `<div><span>${escape(k)}</span><strong>${escape(s[k])} <small>${propUnits[k]}</small></strong></div>`).join('');
 invalidate();
}
function invalidate() {
 if (!record) return;
 record = null;
 $('results').innerHTML = '<p class="empty-state">Inputs changed. Run the analysis again to update results and the report.</p>';
 $('report').disabled = true;
 clearCharts();
 for (const id of ['shear-chart','moment-chart','deflection-chart']) $(id).innerHTML = '';
}
function braces(value, span) {
 const list = value.split(',').map(s => s.trim()).filter(Boolean).map(Number);
 if (list.some(x => !Number.isFinite(x) || x < 0 || x > span)) throw Error('Brace locations must be numbers between 0 and the span.');
 if (!list.includes(0) || !list.includes(span)) throw Error('Confirm lateral restraints at both supports by including 0 and the span in brace locations.');
 const sorted = [...new Set(list)].sort((a,b)=>a-b);
 return { locations: sorted, segments: sorted.slice(1).map((x,i)=>x-sorted[i]) };
}
function schematic(r) {
 const x = v => 55 + 690 * v / r.span;
 const arrows = Array.from({length: 11}, (_,i) => `<path d="M${55+i*69} 38v38m-5-8 5 8 5-8"/>`).join('');
 const b = r.braces.locations.map(v => `<path d="M${x(v)} 83v17" stroke="#b96a42" stroke-width="4"/><text x="${x(v)}" y="117" text-anchor="middle" class="brace-label">${fmt(v,2)}′</text>`).join('');
 return `<svg viewBox="0 0 800 160" role="img" aria-label="Simply supported beam, full span uniform load, and lateral brace locations; schematic not to scale"><g fill="none" stroke="#224e50" stroke-width="2">${arrows}<path d="M55 85H745" stroke-width="7"/><path d="M55 89l-12 20h24zM745 89l-12 20h24z"/><path d="M43 112h24m666 0h24M55 132v10m690-10v10M55 137h690"/></g>${b}<text x="400" y="24" text-anchor="middle">Uniform downward load · ${fmt(r.total,4)} kip/ft</text><text x="400" y="154" text-anchor="middle">${fmt(r.span)} ft between vertical supports · orange ticks = lateral braces</text></svg>`;
}
function chart(result, key, unit, label) {
 const samples = Array.from({length:101},(_,i)=>result.at(result.input.spanFt*i/100));
 const vals = samples.map(p=>key === 'shearLb' ? p[key] / 1000 : p[key]); const max = Math.max(...vals.map(Math.abs), 1e-12); const x = i=>45+i*7.1, y=v=>65-48*v/max;
 const points = vals.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
 return `<svg viewBox="0 0 800 135" role="img" aria-label="${label} diagram, ${unit}"><path d="M45 65H755" stroke="#9ba9a4"/><polyline points="${points}" fill="none" stroke="#176c69" stroke-width="2.5"/><text x="45" y="124">0 ft</text><text x="755" y="124" text-anchor="end">${fmt(result.input.spanFt)} ft</text><text x="45" y="15">${label} · ${unit}</text><text x="755" y="15" text-anchor="end">range ${fmt(Math.min(...vals))} to ${fmt(Math.max(...vals))}</text></svg>`;
}
function run(e) {
 e.preventDefault(); $('error').textContent = '';
 try {
  if (!$('acknowledgement').checked) throw Error('Please acknowledge the preliminary-use notice before calculating.');
  const s = selected(); if (!s) throw Error('Select a beam section.');
  const span=Number($('span').value), dead=Number($('dead-load').value), live=Number($('live-load').value), E=Number($('elastic-modulus').value), I=Number($('inertia').value), factor=Number($('stiffness-factor').value);
  if (dead < 0 || live < 0 || !Number.isFinite(dead+live)) throw Error('Loads must be finite, nonnegative numbers.');
  const self = $('self-weight').checked ? s.W/1000 : 0, total = dead+live+self, br = braces($('brace-locations').value, span);
  const analysis = analyzeBeam({spanFt:span, uniformLoadPlf:total*1000, Eksi:E, Iin4:I, stiffnessFactor:factor});
  const comparison = requestedLoadComparison({selection:$('load-comparison').value, deadLoadKipFt:dead, liveLoadKipFt:live, selfWeightKipFt:self, spanFt:span});
  record = Object.freeze({comparison, project:$('project').value || 'Untitled project', preparer:$('preparer').value || 'Not specified', section:s.AISC_Manual_Label, span, dead, live, self, total, E, I, factor, braces:br, analysis, timestamp:new Date().toISOString()});
  render(record); $('report').disabled = false;
 } catch(err) { invalidate(); $('error').textContent = err.message; }
}
function render(r) {
 const a = r.analysis; const max = a.maxDeflection;
 drawSchematic();
 drawCharts(a);
 const comparisonHtml = r.comparison ? `<div class="calculation-detail"><h3>Optional load comparison — illustrative only</h3><p><strong>Not a verified OSHA or ASD load combination. Not a capacity or compliance check.</strong> The selected comparison uses the user-proposed ${fmt(r.comparison.numerator,1)} / 1.67 = ${fmt(r.comparison.multiplier,5)} multiplier on the entered live load only. It includes entered dead load and selected beam self-weight once.</p><p>1.0D + (${fmt(r.comparison.numerator,1)} / 1.67)L = ${fmt(r.dead,4)} + ${fmt(r.self,4)} + (${fmt(r.comparison.numerator,1)} / 1.67 × ${fmt(r.live,4)}) = <strong>${fmt(r.comparison.totalKipFt,4)} kip/ft</strong>. For this uniform load on a simply supported beam: reaction at each support = <strong>${fmt(r.comparison.reactionKip,3)} kip</strong>; maximum moment = <strong>${fmt(r.comparison.momentKipFt,3)} kip-ft</strong>.</p><p>The 1.67 divisor does not apply to every limit state, and the entered dead load may include applied loads that belong in the maximum intended load. The 2.5 basis for shoring is unverified. Engineering review is required. The diagrams and deflections remain the separate 1.0D + 1.0L service case.</p></div>` : '';
 $('results').innerHTML = `<p class="empty-state"><strong>Service load case: 1.0D + 1.0L</strong> — results and diagrams below.</p><div class="result-grid"><div><span>Support reaction · each</span><strong>${fmt(a.reactions.leftLb/1000)} <small>kip</small></strong></div><div><span>Maximum moment</span><strong>${fmt(a.maxMoment.momentKipFt)} <small>kip-ft</small></strong></div><div><span>Nominal EI deflection</span><strong>${fmt(max.nominalDeflectionIn,4)} <small>in</small></strong></div><div><span>Reduced EI deflection</span><strong>${fmt(max.reducedDeflectionIn,4)} <small>in</small></strong></div></div>${comparisonHtml}<div class="calculation-detail"><h3>Calculation basis</h3><p>Section ${escape(r.section)} · Span ${fmt(r.span)} ft · E = ${fmt(r.E)} ksi · Ix = ${fmt(r.I)} in⁴. Nominal section properties and weight are from a third-party mirror of AISC Shapes Database v15; verify against the official source. The inputs are user-selected and the beam is simply supported with full-span uniform downward loading.</p><p>1.0D + 1.0L: ${fmt(r.dead,4)} + ${fmt(r.live,4)} + ${fmt(r.self,4)} self-weight = <strong>${fmt(r.total,4)} kip/ft</strong>. Self-weight is included ${r.self ? 'once' : 'only if selected'}.</p><p>R = wL/2 = ${fmt(r.total,4)} × ${fmt(r.span)} / 2 = ${fmt(a.reactions.leftLb/1000)} kip. M = wL²/8 = ${fmt(a.maxMoment.momentKipFt)} kip-ft. Maximum bending deflection = 5wL⁴/(384EI), at ${fmt(max.xFt)} ft. The reduced value uses ${fmt(r.factor)}EI; the nominal value uses EI.</p><p>Lateral brace locations: ${r.braces.locations.map(x=>fmt(x,2)).join(', ')} ft. Segment lengths: ${r.braces.segments.map(x=>fmt(x,2)).join(', ')} ft. Braces are not vertical supports.</p><p><strong>Additional information required.</strong> Bending, shear, stability, bearing, connections and scaffold-specific capacity are not evaluated. No overall member adequacy is determined. Independent comparison not completed. The stiffness reduction is a selected standalone assumption, not a complete Direct Analysis Method. Shear deformation is excluded.</p><p>Project: ${escape(r.project)} · Prepared by: ${escape(r.preparer)} · ${escape(r.timestamp)} · Engine 0.1.0</p></div>`;
}
$('report').disabled = true;
$('beam-form').addEventListener('submit', run);
bindSchematic();
drawSchematic();
$('beam-form').addEventListener('input', () => { invalidate(); drawSchematic(); });
$('section').addEventListener('change', () => { properties(); drawSchematic(); });
$('report').addEventListener('click', () => { if (record) window.print(); });
fetch('./public/data/aisc-w-shapes-v15.json').then(r=>{if(!r.ok) throw Error('Section library failed to load.');return r.json();}).then(data=>{
 sections = data.sort((a,b)=>a.AISC_Manual_Label.localeCompare(b.AISC_Manual_Label,undefined,{numeric:true}));
 $('section').innerHTML = sections.map(s=>`<option value="${escape(s.AISC_Manual_Label)}">${escape(s.AISC_Manual_Label)}</option>`).join('');
 $('section').value = 'W16X31'; properties(); drawSchematic();
}).catch(err=>{$('error').textContent = err.message + ' Run the app through a local web server.';});
