/* Data-driven visual explanations and synchronized response diagrams. */
const $ = id => document.getElementById(id);
const num = (n, d=2) => Number.isFinite(n) ? Number(n).toLocaleString('en-US', {maximumFractionDigits:d}) : '—';
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
