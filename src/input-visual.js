/* Beam input illustration. The drawing is schematic; field values come from the same
   controls consumed by the analysis. Position coordinates are measured from A. */
import { parseFlangeBracing } from './bracing.js';
const $ = id => document.getElementById(id);
const escapeText = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
const numeric = id => { const value = $(id)?.value?.trim(); return value ? Number(value) : NaN; };
const fields = [
 ['span','01','Distance between supports','ft'], ['dead-load','02','Dead load D','lb/ft'], ['live-load','03','Live load L','lb/ft'],
 ['top-brace-locations','04','Top flange braces','ft from A'], ['bottom-brace-locations','12','Bottom flange braces','ft from A'], ['section','05','Selected W section',''], ['self-weight','06','Beam self-weight · calculated',''],
 ['elastic-modulus','07','Elastic modulus E','psi'], ['inertia','08','Strong-axis inertia Iₓ','in⁴'], ['stiffness-factor','09','Stiffness factor','× EI'],
 ['load-comparison','10','Load comparison',''], ['custom-safety-factor','11','Custom safety factor',': 1']
];
function fieldValue(id) {
 const el = $(id); if (!el) return '—';
 if (id === 'self-weight') return el.value || 'Section weight unavailable';
 if (id === 'load-comparison') return el.selectedOptions[0]?.textContent ?? '—';
 return el.value.trim() || '—';
}
function editTarget(id, x, y, width, height, label, content = '') {
 return `<g class="input-hotspot input-edit-target" data-field="${id}" tabindex="0" role="button" aria-label="Edit ${escapeText(label)}"><title>Edit ${escapeText(label)}</title><rect class="input-hit-area" x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="transparent" stroke="none"/>${content}</g>`;
}
function modelFieldId(field) {
 if (field?.matches('.uniform-dead')) return 'dead-load';
 if (field?.matches('.uniform-live')) return 'live-load';
 return field?.id;
}
function editableField(id) {
 if (id === 'dead-load' || id === 'live-load') {
  const selector = id === 'dead-load' ? '.uniform-dead' : '.uniform-live';
  return document.querySelector(`.uniform-load-row ${selector}`) || $('new-load-type');
 }
 if (id === 'top-brace-locations' || id === 'bottom-brace-locations') return document.querySelector(`[data-flange="${id.split('-')[0]}"] input`) || document.querySelector(`[data-flange="${id.split('-')[0]}"] .next-brace`);
 return $(id);
}
// The same formatter and update path serve the full-load drawing and animation.
// Reactions come from the existing analysis; this view does not solve the beam.
export function updateSupportReactions(svg, analysis, loadFraction = 1) {
 if (!svg) return;
 const fraction = Number.isFinite(loadFraction) ? Math.min(1, Math.max(0, loadFraction)) : 1;
 for (const group of svg.querySelectorAll('[data-support-reaction]')) {
  const key = group.dataset.supportReaction;
  const value = analysis?.reactions?.[key];
  const available = Number.isFinite(value);
  const reaction = available ? value * fraction : null;
  const number = reaction === null ? '—' : reaction !== 0 && (Math.abs(reaction) < 0.1 || Math.abs(reaction) >= 1e9)
   ? reaction.toExponential(3) : (Object.is(reaction, -0) ? 0 : reaction).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const text = group.querySelector('[data-reaction-value]');
  const label = `${number} lbs`;
  text.textContent = label;
  if (available) text.dataset.reactionLb = String(reaction); else delete text.dataset.reactionLb;
  if (label.length > 10) { text.setAttribute('textLength', '134'); text.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
  else { text.removeAttribute('textLength'); text.removeAttribute('lengthAdjust'); }
  const name = key === 'leftLb' ? 'R1, left support' : 'R2, right support';
  group.setAttribute('aria-label', available ? `${name}: ${label} upward at ${Math.round(fraction * 100)}% of service load` : `${name}: reaction not calculated`);
  const arrow = group.querySelector('.in-reaction-arrow');
  arrow.setAttribute('transform', `translate(0 ${251 * (1 - fraction)}) scale(1 ${fraction})`);
  arrow.style.opacity = available ? String(fraction) : '0.35';
 }
}
export function drawSchematic({ analysis = null } = {}) {
 const container = $('schematic'); if (!container) return;
 const span = numeric('span'), validSpan = Number.isFinite(span) && span > 0;
 let bracing = null;
 try { bracing = parseFlangeBracing({top:$('top-brace-locations').value, bottom:$('bottom-brace-locations').value, spanFt:span}); } catch { /* Invalid inputs are identified beside the fields and validated on submit. */ }
 const x = v => 77 + v / span * 566;
 // End restraints at the supports are implied, so only interior braces are marked.
 // data-x-ft marks each element's station so the deflected-shape view can move it with the beam.
 const braceTicks = bracing ? bracing.top.locations.filter(v => v > 0 && v < span).map(v => `<g class="in-brace-mark" data-x-ft="${v}"><path class="in-brace" d="M${x(v)} 136v-13"/><circle class="in-brace-dot" cx="${x(v)}" cy="135" r="3"/></g>`).join('') + bracing.bottom.locations.filter(v => v > 0 && v < span).map(v => `<g class="in-brace-mark" data-x-ft="${v}"><path class="in-brace in-brace-bottom" d="M${x(v)} 142v13"/><circle class="in-brace-dot in-brace-bottom-dot" cx="${x(v)}" cy="142" r="3"/></g>`).join('') : '';
 // Show positions in a separate text line; dense positions otherwise collide.
 const braceLabel = flange => !bracing ? 'Check positions' : `${bracing[flange].locations.map(fmt).join(', ')} ft`;
 const dead = numeric('dead-load'), live = numeric('live-load');
 const loadValid = Number.isFinite(dead) && dead >= 0 && Number.isFinite(live) && live >= 0;
 // The uniform load is drawn only when a uniform row carries load. Its labels stay
 // while a value is being edited (invalid) so the entry can still be clicked.
 const hasUniformRow = Boolean(document.querySelector('.uniform-load-row'));
 const showUniform = hasUniformRow && (!loadValid || dead > 0 || live > 0);
 const anyLoad = showUniform && loadValid;
 const arrows = anyLoad ? Array.from({length:11}, (_,i) => { const a=77+i*56.6;return `<path data-x-ft="${span*i/10}" d="M${a} 64v54m-5-8 5 8 5-8"/>`; }).join('') : '';
 // Point-load arrows track the entered positions. Invalid or blank rows are
 // omitted from the preview and are validated when analysis is run.
 const pointLoads = [...document.querySelectorAll('.point-load-row')].map((row,index) => {
  const dead = row.querySelector('.point-dead')?.value.trim();
  const live = row.querySelector('.point-live')?.value.trim();
  const location = row.querySelector('.point-location')?.value.trim();
  const deadLb = dead === '' || dead == null ? NaN : Number(dead), liveLb = live === '' || live == null ? NaN : Number(live);
  return { index, deadLb, liveLb, magnitude:deadLb+liveLb, location: location === '' || location == null ? NaN : Number(location) };
 }).filter(p => p.deadLb >= 0 && p.liveLb >= 0 && p.magnitude > 0 && Number.isFinite(p.magnitude) && Number.isFinite(p.location) && validSpan && p.location >= 0 && p.location <= span);
 const pointArrows = pointLoads.map(p => `<g class="input-hotspot" role="button" tabindex="0" data-point-index="${p.index}" data-x-ft="${p.location}" aria-label="Edit point load ${p.index+1}: dead ${fmt(p.deadLb)} plus live ${fmt(p.liveLb)} equals ${fmt(p.magnitude)} lbs at ${fmt(p.location)} ft"><title>D ${fmt(p.deadLb)} + LL ${fmt(p.liveLb)} = ${fmt(p.magnitude)} lbs at ${fmt(p.location)} ft</title><rect class="input-hit-area" x="${x(p.location)-13}" y="77" width="26" height="52" rx="4" fill="transparent" stroke="none"/><path d="M${x(p.location)} 80v45m-6-8 6 8 6-8" fill="none" stroke="#ffa41b" stroke-width="3"/></g>`).join('');
 container.innerHTML = `<div class="input-drawings"><div class="input-elevation"><div class="input-scroll" role="region" aria-label="Interactive beam model">
 <svg class="input-beam" viewBox="0 0 720 310" role="group" aria-label="Simply supported beam with downward uniform and point loads and lateral brace locations. R1 is the upward left support reaction and R2 is the upward right support reaction under service load. Schematic not to scale.">
 <defs><pattern id="input-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#22304b" stroke-width=".5"/></pattern></defs><rect width="720" height="310" fill="url(#input-grid)"/>
 <g class="in-load">${arrows}${anyLoad?'<path data-load-bar d="M77 64H643"/>':''}</g>${pointArrows}
 ${showUniform ? editTarget('dead-load',155,14,190,36,'uniform dead load',`<text class="in-text" x="250" y="37" text-anchor="middle">Dead · ${loadValid ? fmt(dead*1000) : '—'} lb/ft</text>`) : ''}
 ${showUniform ? editTarget('live-load',365,14,190,36,'uniform live load',`<text class="in-text" x="460" y="37" text-anchor="middle">Live · ${loadValid ? fmt(live*1000) : '—'} lb/ft</text>`) : ''}
 <path class="in-beam" d="M77 138H643"/><g class="in-support"><path d="M77 144l-14 23h28zM643 144l-14 23h28zM58 172h38M624 180h38"/><circle cx="634" cy="174" r="3"/><circle cx="652" cy="174" r="3"/></g>${braceTicks}
 ${editTarget('section',80,129,560,18,'beam size')}
 <path class="in-dim" d="M77 186v37M643 186v37M77 211H643M77 206v10M643 206v10"/>
 ${editTarget('span',295,219,130,35,'span',`<text class="in-dimtext" x="360" y="242" text-anchor="middle">${validSpan ? fmt(span) : '—'} ft span</text>`)}
 <text class="in-note" x="77" y="193" text-anchor="middle">A</text><text class="in-note" x="643" y="193" text-anchor="middle">B</text>
 ${[['leftLb','R1',77],['rightLb','R2',643]].map(([key,name,station])=>`<g class="in-reaction" data-support-reaction="${key}" role="img"><path class="in-reaction-arrow" d="M${station} 251V231m-6 7 6-7 6 7" fill="none" stroke="#3dd9c9" stroke-width="2"/><text class="in-reaction-name" x="${station}" y="267" text-anchor="middle" font-size="14" fill="#ffc266">${name}</text><text class="in-reaction-value" data-reaction-value="${key}" x="${station}" y="293" text-anchor="middle" font-size="15" fill="#9ff3e9">— lbs</text></g>`).join('')}
 </svg></div>${pointLoads.length ? `<div class="model-point-list">${pointLoads.map(p => `<button type="button" data-point-index="${p.index}" aria-label="Edit point load ${p.index+1}"><span>P${p.index+1}</span> ${fmt(p.magnitude)} lbs <small>D ${fmt(p.deadLb)} + LL ${fmt(p.liveLb)} · at ${fmt(p.location)} ft</small></button>`).join('')}</div>` : ''}<div class="input-brace-summary"><div class="model-flange-braces"><button type="button" data-field="top-brace-locations" class="model-restraints">Top braces · ${escapeText(braceLabel('top'))}</button><button type="button" data-field="bottom-brace-locations" class="model-restraints">Bottom braces · ${escapeText(braceLabel('bottom'))}</button></div><span>Self-weight included${pointLoads.length ? ` · ${pointLoads.length} point load${pointLoads.length === 1 ? '' : 's'}` : ''}</span></div></div>
 <div class="input-section"><svg class="input-section-svg" viewBox="0 0 300 200" role="group" aria-label="Wide-flange section, major-axis bending"><path class="in-section-shape" d="M74 30H226V49H166V151H226V170H74V151H134V49H74Z"/><path class="in-axis" d="M51 100H249"/><text class="in-note" x="42" y="104">x</text><text class="in-note" x="253" y="104">x</text>${editTarget('section',65,20,170,160,'beam size')}</svg><span class="section-name">${escapeText(fieldValue('section'))}</span></div></div>`;
 updateSupportReactions(container.querySelector('.input-beam'), analysis);
 const focused = modelFieldId(document.activeElement);
 container.querySelectorAll('[data-field]').forEach(el => el.classList.toggle('is-active', el.dataset.field === focused));
}
export function bindSchematic() {
 const container=$('schematic'); if (!container) return;
 const activate=target=>{const marker=target.closest('[data-field], [data-point-index]'); if(!marker) return; const field=marker.hasAttribute('data-point-index') ? document.querySelectorAll('.point-load-row')[Number(marker.dataset.pointIndex)]?.querySelector('.point-dead') : editableField(marker.dataset.field); if(field && !field.disabled) { for(let parent=field.parentElement;parent;parent=parent.parentElement) if(parent.tagName==='DETAILS') parent.open=true; field.focus(); }};
 container.addEventListener('click',e=>activate(e.target));
 container.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('.input-hotspot')){e.preventDefault();activate(e.target);}});
 document.addEventListener('focusin',e=>container.querySelectorAll('[data-field]').forEach(el=>el.classList.toggle('is-active',el.dataset.field===modelFieldId(e.target))));
 document.addEventListener('focusout',e=>{if(fields.some(field=>field[0]===modelFieldId(e.target))) container.querySelectorAll('.is-active').forEach(el=>el.classList.remove('is-active'));});
}
