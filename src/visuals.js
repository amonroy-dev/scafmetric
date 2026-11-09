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
const specs=[['shear-chart','shearLb','Shear','kip'],['moment-chart','momentKipFt','Moment','kip-ft'],['deflection-chart','reducedDeflectionIn','Deflection','in']];
function valueAt(p,key){return key==='shearLb'?p[key]/1000:p[key];}
function makeChart(analysis,id,key,label,unit) {
 const L=analysis.input.spanFt, n=160, values=Array.from({length:n+1},(_,i)=>valueAt(analysis.at(L*i/n),key));
 const maxAbs=Math.max(...values.map(Math.abs),1e-10); const left=55,right=745,zero=100,scale=62/maxAbs;
 const x=i=>left+(right-left)*i/n, y=v=>zero-v*scale;
 const poly=values.map((v,i)=>`${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
 const area=`${left},${zero} ${poly} ${right},${zero}`;
 const minimum=Math.min(...values),maximum=Math.max(...values);
 $(id).innerHTML=`<svg class="response-svg" viewBox="0 0 800 190" role="img" aria-label="${label} diagram in ${unit}. Use the position slider to inspect values."><defs><pattern id="hatch-${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#a45035" stroke-width="1" opacity=".4"/></pattern><clipPath id="negative-${id}"><rect x="0" y="100" width="800" height="90"/></clipPath></defs><path class="chart-gridline" d="M55 38H745M55 69H745M55 131H745M55 162H745"/><polygon class="chart-fill" points="${area}"/><polygon fill="url(#hatch-${id})" clip-path="url(#negative-${id})" points="${area}"/><path class="chart-zero" d="M55 100H745"/><polyline class="chart-line" points="${poly}"/><polyline class="chart-negative" clip-path="url(#negative-${id})" points="${poly}"/><path class="chart-cursor" data-cursor-line d="M55 29V166"/><circle class="chart-point" data-cursor-point cx="55" cy="${y(values[0])}" r="5"/><text class="chart-axis" x="55" y="182">0 ft</text><text class="chart-axis" x="745" y="182" text-anchor="end">${num(L)} ft</text><text class="chart-axis" x="55" y="20">${label.toUpperCase()} / ${unit}</text><text class="chart-axis" x="745" y="20" text-anchor="end">MIN ${num(minimum,3)}  ·  MAX ${num(maximum,3)}</text></svg>`;
 return {id,key,y,left,right,zero};
}
export function drawCharts(analysis) {
 const panel=$('shear-chart').closest('.chart-grid');
 let control=$('diagram-controls');
 if(!control){control=document.createElement('div');control.id='diagram-controls';control.className='diagram-controls';panel.before(control);}
 control.innerHTML=`<div class="diagram-controls-header"><div><span>EXPLORE THE RESPONSE</span><strong>One position, three diagrams</strong></div><output id="diagram-position">x = 0 ft</output></div><label for="diagram-slider">Move along the beam <span>Use the slider, arrow keys, or tap a diagram</span></label><input type="range" id="diagram-slider" min="0" max="${analysis.input.spanFt}" step="${analysis.input.spanFt/1000}" value="0"><div class="diagram-readout" aria-live="polite"><span id="read-shear"></span><span id="read-moment"></span><span id="read-deflection"></span></div><p>Values are evaluated from the beam response at the selected position. Positive shear equals the left reaction minus downward loads to the left of the cut; positive moment is sagging and deflection is downward. Negative regions are hatched and dashed. Peak moment at ${num(analysis.maxMoment.xFt,3)} ft; peak deflection at ${num(analysis.maxDeflection.xFt,3)} ft.</p>`;
 const charts=specs.map(s=>makeChart(analysis,...s)); const slider=$('diagram-slider');
 function update(x) {x=Math.max(0,Math.min(analysis.input.spanFt,x));slider.value=x;const p=analysis.at(x);$('diagram-position').textContent=`x = ${num(x,3)} ft`; $('read-shear').textContent=`V ${num(p.shearLb/1000,3)} kip`; $('read-moment').textContent=`M ${num(p.momentKipFt,3)} kip-ft`; $('read-deflection').textContent=`δ ${num(p.reducedDeflectionIn,4)} in`;for(const c of charts){const px=c.left+(c.right-c.left)*x/analysis.input.spanFt;const py=c.y(valueAt(p,c.key));const svg=$(c.id).querySelector('svg');svg.querySelector('[data-cursor-line]').setAttribute('d',`M${px} 29V166`);const dot=svg.querySelector('[data-cursor-point]');dot.setAttribute('cx',px);dot.setAttribute('cy',py);}}
 slider.addEventListener('input',()=>update(Number(slider.value)));
 for(const c of charts) {const svg=$(c.id).querySelector('svg');svg.style.touchAction='pan-y';const move=e=>{const rect=svg.getBoundingClientRect(), vb=(e.clientX-rect.left)/rect.width*800;update((vb-c.left)/(c.right-c.left)*analysis.input.spanFt);};svg.addEventListener('pointerdown',e=>{svg.setPointerCapture(e.pointerId);move(e)});svg.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||e.buttons)move(e)});}
 update(0);
}
export function clearCharts() {const el=$('diagram-controls');if(el)el.remove();}
