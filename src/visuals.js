/* Data-driven visual explanations and synchronized response diagrams. */
const $ = id => document.getElementById(id);
const num = (n, d=2) => Number.isFinite(n) ? Number(n).toLocaleString('en-US', {maximumFractionDigits:d}) : '—';
const safe = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields = [
 ['span','01','Support distance','ft'], ['dead-load','02','Dead load','kip/ft'], ['live-load','03','Live load','kip/ft'],
 ['brace-locations','04','Lateral braces','ft from left'], ['section','05','Beam section',''], ['self-weight','06','Beam self-weight',''],
 ['elastic-modulus','07','Elastic modulus E','ksi'], ['inertia','08','Strong-axis inertia Ix','in⁴'], ['stiffness-factor','09','Stiffness factor','× EI']
];
const fieldValue = (id) => {const el=$(id);if(!el)return '—';if(id==='self-weight')return el.checked?'Included':'Excluded';return el.value || '—';};
function hotspot(field,x,y,n,text,extra='') {return `<g class="diagram-hotspot" data-field="${field}" role="button" tabindex="0" aria-label="Edit ${text}"><circle cx="${x}" cy="${y}" r="13"/><text x="${x}" y="${y+4}" text-anchor="middle">${n}</text>${extra}</g>`;}
export function drawSchematic() {
 const container = $('schematic'); if (!container) return;
 const span = Number(fieldValue('span')); const validSpan=Number.isFinite(span)&&span>0;
 const braceInput = fieldValue('brace-locations');
 const braces=validSpan?braceInput.split(',').map(x=>x.trim()).filter(Boolean).map(Number).filter(x=>Number.isFinite(x)&&x>=0&&x<=span):[];
 const ticks=[...new Set(braces)].map(v=>{let x=84+v/span*488;return `<path class="v-brace" d="M${x} 147v-20"/><circle class="v-brace-dot" cx="${x}" cy="145" r="4"/>`;}).join('');
 const arrows=Array.from({length:9},(_,i)=>{const x=100+i*57;return `<path d="M${x} 79v40m-5-7 5 7 5-7"/>`;}).join('');
 container.innerHTML=`<div class="visual-intro"><span>YOUR MODEL / 01</span><span>LIVE INPUT GUIDE · SCHEMATIC, NOT TO SCALE</span></div>
 <svg class="beam-visual" viewBox="0 0 900 285" role="group" aria-label="Beam input guide. Select a numbered marker to edit the corresponding input.">
 <defs><pattern id="visual-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#e8e5d8" stroke-width="1"/></pattern></defs>
 <rect x="0" y="0" width="900" height="285" fill="url(#visual-grid)"/>
 <text class="v-caption" x="38" y="32">ELEVATION  /  TWO END SUPPORTS</text><text class="v-caption" x="650" y="32">SECTION  /  STRONG AXIS</text>
 <g class="v-load">${arrows}<path d="M100 78H556"/></g>
 <text class="v-label" x="328" y="67" text-anchor="middle">D + L + SELECTED SELF-WEIGHT · FULL SPAN</text>
 <path class="v-beam" d="M84 146H572"/><path class="v-support" d="M84 151l-14 22h28zM572 151l-14 22h28zM66 178h36M554 184h36"/><circle class="v-support" cx="563" cy="178" r="3"/><circle class="v-support" cx="581" cy="178" r="3"/>${ticks}
 <path class="v-dimension" d="M84 190v32M572 190v32M84 211H572M84 206v10M572 206v10"/><text class="v-dimtext" x="328" y="235" text-anchor="middle">${validSpan?num(span):'—'} ft BETWEEN SUPPORTS</text>
 <text class="v-note" x="84" y="258">Left support · x = 0</text><text class="v-note" x="572" y="258" text-anchor="end">Right support · x = L</text>
 <path class="v-section" d="M696 74h112v17h-42v93h42v17H696v-17h42V91h-42z"/><path class="v-dimension" d="M678 137H824"/><text class="v-note" x="814" y="132">x</text><text class="v-note" x="750" y="226" text-anchor="middle">${safe(fieldValue('section'))} · bending about x–x</text>
 ${hotspot('span',328,211,'1','support distance')}${hotspot('dead-load',150,79,'2','dead load')}${hotspot('live-load',462,79,'3','live load')}${hotspot('brace-locations',205,146,'4','lateral braces')}${hotspot('section',750,100,'5','beam section')}${hotspot('self-weight',500,146,'6','beam self-weight')}${hotspot('elastic-modulus',688,109,'7','elastic modulus')}${hotspot('inertia',813,155,'8','moment of inertia')}${hotspot('stiffness-factor',750,184,'9','stiffness factor')}
 </svg><div class="visual-guide" aria-label="Inputs shown in the diagram">${fields.map(([id,n,title,unit])=>`<button type="button" class="guide-item" data-field="${id}"><span class="guide-number">${n}</span><span><strong>${title}</strong><small>${safe(fieldValue(id))}${unit?' '+unit:''}</small></span><span class="guide-arrow">↗</span></button>`).join('')}</div><p class="visual-footnote">On small screens, swipe the drawing sideways to see the full section. Select a numbered label to edit that input. Orange marks are lateral braces; they are not vertical supports. Material and stiffness labels are properties, not dimensions.</p>`;
 const focused = document.activeElement?.id;
 container.querySelectorAll('[data-field]').forEach(el=>el.classList.toggle('is-active',el.dataset.field===focused));
}
export function bindSchematic() {
 const container=$('schematic');
 const activate=target=>{const marker=target.closest('[data-field]');if(!marker)return;$(marker.dataset.field)?.focus();};
 container.addEventListener('click', e=>activate(e.target));
 container.addEventListener('keydown', e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('.diagram-hotspot')){e.preventDefault();activate(e.target);}});
 document.addEventListener('focusin', e=>{document.querySelectorAll('#schematic [data-field]').forEach(el=>el.classList.toggle('is-active',el.dataset.field===e.target.id));});
 document.addEventListener('focusout', e=>{if(fields.some(x=>x[0]===e.target.id)) document.querySelectorAll('#schematic .is-active').forEach(el=>el.classList.remove('is-active'));});
}
// Plot ordinate values in the units shown on each panel. The active web UI
// currently supplies a simply supported full-span uniform load; the point-load
// discontinuity is retained here for the engine's existing point-load case.
const specs = [
  ['shear-chart', 'shearLb', 'Shear force', 'V', 'kip'],
  ['moment-chart', 'momentKipFt', 'Bending moment', 'M', 'kip-ft'],
  ['deflection-chart', 'reducedDeflectionIn', 'Bending deflection', 'δ', 'in']
];
function valueAt(point, key) { return key === 'shearLb' ? point[key] / 1000 : point[key]; }
function graphSamples(analysis, key) {
  const L = analysis.input.spanFt, a = analysis.input.pointLocationFt;
  const xs = Array.from({length: 161}, (_, i) => L * i / 160);
  if (analysis.input.pointLoadLb > 0 && a > 0 && a < L) xs.push(a);
  return [...new Set(xs)].sort((x,y) => x-y).flatMap(x => {
    if (key === 'shearLb' && analysis.input.pointLoadLb > 0 && x === a && a > 0 && a < L) {
      return [analysis.at(x, 'left'), analysis.at(x, 'right')];
    }
    return [analysis.at(x, x === L ? 'left' : 'right')];
  });
}
function shearZeros(analysis) {
  const {spanFt:L, uniformLoadPlf:w, pointLoadLb:P, pointLocationFt:a} = analysis.input;
  if (w === 0) return [];
  const roots = [analysis.reactions.leftLb / w];
  if (P > 0) roots.push((analysis.reactions.leftLb - P) / w);
  return roots.filter((x,i) => x >= 0 && x <= L && (P === 0 || (i === 0 ? x <= a : x >= a)))
    .filter((x,i,all) => all.findIndex(y => Math.abs(x-y) < 1e-9) === i);
}
function extremes(analysis, key) {
  const zero = analysis.at(0);
  if (key === 'shearLb') return { min: analysis.minShear, max: analysis.maxShear };
  return { min: zero, max: key === 'momentKipFt' ? analysis.maxMoment : analysis.maxDeflection };
}
function labelValue(value, key) {
  const decimals = key === 'reducedDeflectionIn' ? 4 : 3;
  if (Number.isFinite(value) && value !== 0 && Math.abs(value) < 0.5 * 10 ** -decimals) return value.toExponential(3);
  return num(value, decimals);
}
function makeChart(analysis, id, key, label, symbol, unit) {
  const L = analysis.input.spanFt, pts = graphSamples(analysis, key), ext = extremes(analysis,key);
  const min = valueAt(ext.min,key), max = valueAt(ext.max,key);
  const allZero = min === 0 && max === 0;
  const maxAbs = allZero ? 1 : Math.max(Math.abs(min),Math.abs(max),1e-12);
  const left=83,right=689,zero=119,scale=68/maxAbs;
  // Deflection is positive downward so its graph follows the physical direction.
  const downPositive = key === 'reducedDeflectionIn';
  const x = ft => left+(right-left)*ft/L, y = value => zero+(downPositive ? value : -value)*scale;
  const poly=pts.map(p=>`${x(p.xFt).toFixed(3)},${y(valueAt(p,key)).toFixed(3)}`).join(' ');
  const area=`${left},${zero} ${poly} ${right},${zero}`;
  const zeros = key === 'shearLb' ? shearZeros(analysis) : [];
  const zeroMarks = zeros.filter(z=>z>1e-9 && z<L-1e-9).map(z=>`<circle class="chart-zero-mark" cx="${x(z)}" cy="${zero}" r="4"/>`).join('');
  const axisTicks = Array.from({length:5},(_,i)=>{const t=L*i/4;return `<path class="chart-tick" d="M${x(t)} 193v5"/><text class="chart-axis chart-x-tick" x="${x(t)}" y="219" text-anchor="middle">${num(t,3)}</text>`;}).join('');
  const maxDetail = allZero ? `0 ${unit} throughout span` : `${labelValue(max,key)} ${unit} at ${num(ext.max.xFt,3)} ft`;
  const minDetail = allZero ? `0 ${unit} throughout span` : key === 'shearLb' ? `${labelValue(min,key)} ${unit} at ${num(ext.min.xFt,3)} ft` : `0 ${unit} at both supports`;
  const zeroDetail = key === 'shearLb' && !allZero && zeros.length ? `Zero shear at ${zeros.map(z=>num(z,3)).join(', ')} ft.` : '';
  $(id).innerHTML = `<div class="response-figure"><div class="response-heading"><div><span class="response-kicker">SERVICE CASE / 1.0D + 1.0L</span><h3>${label}</h3></div><span class="response-unit">${symbol} / ${unit}</span></div>
  <svg class="response-svg" viewBox="0 0 720 244" role="img" aria-label="${label} diagram, ${unit}. Minimum ${minDetail}; maximum ${maxDetail}. ${zeroDetail} Use the shared position slider to inspect values.">
  <defs><pattern id="hatch-${id}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#ffa41b" stroke-width="2" opacity=".5"/></pattern><clipPath id="negative-${id}"><rect x="0" y="${downPositive ? 0 : zero}" width="720" height="${downPositive ? zero : 125}"/></clipPath></defs>
  <path class="chart-gridline" d="M${left} 51H${right}M${left} 85H${right}M${left} 153H${right}M${left} 187H${right}"/>
  <path class="chart-support-guide" d="M${left} 40V193M${right} 40V193"/>
  <polygon class="chart-fill" points="${area}"/><polygon fill="url(#hatch-${id})" clip-path="url(#negative-${id})" points="${area}"/>
  <path class="chart-zero" d="M${left} ${zero}H${right}"/><polyline class="chart-line" points="${poly}"/><polyline class="chart-negative" clip-path="url(#negative-${id})" points="${poly}"/>${zeroMarks}
  <path class="chart-cursor" data-cursor-line d="M${left} 38V193"/><circle class="chart-point" data-cursor-point cx="${left}" cy="${y(valueAt(pts[0],key))}" r="5"/>
  <text class="chart-axis chart-y-tick" x="72" y="56" text-anchor="end">${allZero ? '' : (downPositive ? '−' : '')+labelValue(maxAbs,key)}</text><text class="chart-axis chart-y-tick" x="72" y="124" text-anchor="end">0</text><text class="chart-axis chart-y-tick" x="72" y="191" text-anchor="end">${allZero ? '' : (downPositive ? '' : '−')+labelValue(maxAbs,key)}</text>${axisTicks}
  <text class="chart-axis chart-x-label" x="${(left+right)/2}" y="239" text-anchor="middle">DISTANCE FROM LEFT SUPPORT / ft</text></svg>
  <div class="response-extrema"><div><span>MAXIMUM</span><strong>${maxDetail}</strong></div><div><span>MINIMUM</span><strong>${minDetail}</strong></div></div>${zeroDetail ? `<p class="response-zero">${zeroDetail}</p>` : ''}</div>`;
  return {id,key,y,left,right};
}
export function drawCharts(analysis) {
 const panel=$('shear-chart').closest('.chart-grid');
 let control=$('diagram-controls');
 if(!control){control=document.createElement('div');control.id='diagram-controls';control.className='diagram-controls';panel.before(control);}
 control.innerHTML=`<div class="diagram-controls-header"><div><span>EXPLORE THE RESPONSE</span><strong>One position, three diagrams</strong></div><output id="diagram-position">x = 0 ft</output></div><label for="diagram-slider">Move along the beam <span>Drag, use arrow keys, or tap a diagram</span></label><input type="range" id="diagram-slider" min="0" max="${analysis.input.spanFt}" step="${analysis.input.spanFt/1000}" value="0" aria-describedby="diagram-instructions"><div class="diagram-readout" aria-live="polite"><span id="read-shear"></span><span id="read-moment"></span><span id="read-deflection"></span></div><p id="diagram-instructions">Service loads only. Positive shear equals the left reaction minus downward loads to the left of the cut; positive moment is sagging. Deflection is downward and uses reduced EI. Negative values use dashed lines and hatching. Curves connect sampled values from the response equations.</p>`;
 const charts=specs.map(s=>makeChart(analysis,...s)); const slider=$('diagram-slider');
 function update(x) {
   x=Math.max(0,Math.min(analysis.input.spanFt,x)); slider.value=x;
   const p=analysis.at(x, x===analysis.input.spanFt ? 'left' : 'right');
   $('diagram-position').textContent=`x = ${num(x,3)} ft`; $('read-shear').textContent=`V ${labelValue(p.shearLb/1000,'shearLb')} kip`; $('read-moment').textContent=`M ${labelValue(p.momentKipFt,'momentKipFt')} kip-ft`; $('read-deflection').textContent=`δ ${labelValue(p.reducedDeflectionIn,'reducedDeflectionIn')} in`;
   for(const c of charts){const px=c.left+(c.right-c.left)*x/analysis.input.spanFt;const py=c.y(valueAt(p,c.key));const svg=$(c.id).querySelector('svg');svg.querySelector('[data-cursor-line]').setAttribute('d',`M${px} 38V193`);const dot=svg.querySelector('[data-cursor-point]');dot.setAttribute('cx',px);dot.setAttribute('cy',py);}
 }
 slider.addEventListener('input',()=>update(Number(slider.value)));
 for(const c of charts) {
   const svg=$(c.id).querySelector('svg'); svg.style.touchAction='pan-y';
   const move=e=>{const rect=svg.getBoundingClientRect(), vb=(e.clientX-rect.left)/rect.width*720;update((vb-c.left)/(c.right-c.left)*analysis.input.spanFt);};
   svg.addEventListener('pointerdown',e=>{svg.setPointerCapture(e.pointerId);move(e)});
   svg.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||e.buttons)move(e)});
 }
 update(0);
}
export function clearCharts() {const el=$('diagram-controls');if(el)el.remove();}
