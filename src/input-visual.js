/* Beam input illustration. The drawing is schematic; field values come from the same
   controls consumed by the analysis. Position coordinates are measured from A. */
const $ = id => document.getElementById(id);
const escapeText = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
const numeric = id => { const value = $(id)?.value?.trim(); return value ? Number(value) : NaN; };
const fields = [
 ['span','01','Distance between supports','ft'], ['dead-load','02','Dead load D','kip/ft'], ['live-load','03','Live load L','kip/ft'],
 ['brace-locations','04','Lateral brace locations','ft from A'], ['section','05','Selected W section',''], ['self-weight','06','Beam self-weight · calculated',''],
 ['elastic-modulus','07','Elastic modulus E','ksi'], ['inertia','08','Strong-axis inertia Iₓ','in⁴'], ['stiffness-factor','09','Stiffness factor','× EI'],
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
  return document.querySelector(`.uniform-load-row ${selector}`) || document.querySelector('.load-type') || $('add-load');
 }
 return $(id);
}
export function drawSchematic() {
 const container = $('schematic'); if (!container) return;
 const span = numeric('span'), validSpan = Number.isFinite(span) && span > 0;
 const rawBraces = $('brace-locations')?.value || '';
 const tokens = rawBraces.split(',').map(v => v.trim()).filter(Boolean);
 const parsed = tokens.map(Number);
 const validBraces = validSpan && parsed.every(v => Number.isFinite(v) && v >= 0 && v <= span);
 const braces = validBraces ? (tokens.length ? [...new Set(parsed)].sort((a,b)=>a-b) : [0, span]) : [];
 const x = v => 77 + v / span * 566;
 const braceTicks = braces.map(v => `<path class="in-brace" d="M${x(v)} 136v-19"/><circle class="in-brace-dot" cx="${x(v)}" cy="138" r="3.5"/>`).join('');
 // Show positions in a separate text line; dense positions otherwise collide.
 const braceList = !validBraces ? 'Check brace locations' : !tokens.length ? `End restraints assumed at 0 and ${fmt(span)} ft` : braces.map(fmt).join(', ') + ' ft from A';
 const dead = numeric('dead-load'), live = numeric('live-load');
 const loadValid = Number.isFinite(dead) && dead >= 0 && Number.isFinite(live) && live >= 0;
 const anyLoad = loadValid && (dead > 0 || live > 0 || Boolean($('section')?.value));
 const arrows = anyLoad ? Array.from({length:11}, (_,i) => { const a=77+i*56.6;return `<path d="M${a} 64v54m-5-8 5 8 5-8"/>`; }).join('') : '';
 // Point-load arrows track the entered positions. Invalid or blank rows are
 // omitted from the preview and are validated when analysis is run.
 const pointLoads = [...document.querySelectorAll('.point-load-row')].map((row,index) => {
  const magnitude = row.querySelector('.point-load')?.value.trim();
  const location = row.querySelector('.point-location')?.value.trim();
  return { index, magnitude: magnitude === '' || magnitude == null ? NaN : Number(magnitude), location: location === '' || location == null ? NaN : Number(location) };
 }).filter(p => p.magnitude > 0 && Number.isFinite(p.magnitude) && Number.isFinite(p.location) && validSpan && p.location >= 0 && p.location <= span);
 const pointArrows = pointLoads.map(p => `<g class="input-hotspot" role="button" tabindex="0" data-point-index="${p.index}" aria-label="Edit point load ${p.index+1}: ${fmt(p.magnitude)} kip at ${fmt(p.location)} ft"><title>${fmt(p.magnitude)} kip at ${fmt(p.location)} ft</title><rect class="input-hit-area" x="${x(p.location)-13}" y="77" width="26" height="52" rx="4" fill="transparent" stroke="none"/><path d="M${x(p.location)} 80v45m-6-8 6 8 6-8" fill="none" stroke="#ffa41b" stroke-width="3"/></g>`).join('');
 container.innerHTML = `<div class="input-drawings"><div class="input-elevation"><div class="input-scroll" role="region" aria-label="Interactive beam model">
 <svg class="input-beam" viewBox="0 0 720 266" role="group" aria-label="Simply supported beam with downward uniform and point loads and lateral brace locations, schematic not to scale.">
 <defs><pattern id="input-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#22304b" stroke-width=".5"/></pattern></defs><rect width="720" height="266" fill="url(#input-grid)"/>
 <g class="in-load">${arrows}${anyLoad?'<path d="M77 64H643"/>':''}</g>${pointArrows}
 ${editTarget('dead-load',155,14,190,36,'uniform dead load',`<text class="in-text" x="250" y="37" text-anchor="middle">Dead · ${loadValid ? fmt(dead) : '—'} kip/ft</text>`)}
 ${editTarget('live-load',365,14,190,36,'uniform live load',`<text class="in-text" x="460" y="37" text-anchor="middle">Live · ${loadValid ? fmt(live) : '—'} kip/ft</text>`)}
 <path class="in-beam" d="M77 138H643"/><g class="in-support"><path d="M77 144l-14 23h28zM643 144l-14 23h28zM58 172h38M624 180h38"/><circle cx="634" cy="174" r="3"/><circle cx="652" cy="174" r="3"/></g>${braceTicks}
 ${editTarget('section',80,129,560,18,'beam size')}
 <path class="in-dim" d="M77 186v37M643 186v37M77 211H643M77 206v10M643 206v10"/>
 ${editTarget('span',295,219,130,35,'span',`<text class="in-dimtext" x="360" y="242" text-anchor="middle">${validSpan ? fmt(span) : '—'} ft span</text>`)}
 <text class="in-note" x="77" y="193" text-anchor="middle">A</text><text class="in-note" x="643" y="193" text-anchor="middle">B</text>
 </svg></div>${pointLoads.length ? `<div class="model-point-list">${pointLoads.map(p => `<button type="button" data-point-index="${p.index}" aria-label="Edit point load ${p.index+1}"><span>P${p.index+1}</span> ${fmt(p.magnitude)} kip <small>at ${fmt(p.location)} ft</small></button>`).join('')}</div>` : ''}<div class="input-brace-summary"><button type="button" data-field="brace-locations" class="model-restraints">${escapeText(braceList)}</button><span>Self-weight included${pointLoads.length ? ` · ${pointLoads.length} point load${pointLoads.length === 1 ? '' : 's'}` : ''}</span></div></div>
 <div class="input-section"><svg class="input-section-svg" viewBox="0 0 300 200" role="group" aria-label="Wide-flange section, major-axis bending"><path class="in-section-shape" d="M74 30H226V49H166V151H226V170H74V151H134V49H74Z"/><path class="in-axis" d="M51 100H249"/><text class="in-note" x="42" y="104">x</text><text class="in-note" x="253" y="104">x</text>${editTarget('section',65,20,170,160,'beam size')}</svg><span class="section-name">${escapeText(fieldValue('section'))}</span></div></div>`;
 const focused = modelFieldId(document.activeElement);
 container.querySelectorAll('[data-field]').forEach(el => el.classList.toggle('is-active', el.dataset.field === focused));
}
export function bindSchematic() {
 const container=$('schematic'); if (!container) return;
 const activate=target=>{const marker=target.closest('[data-field], [data-point-index]'); if(!marker) return; const field=marker.hasAttribute('data-point-index') ? document.querySelectorAll('.point-load-row')[Number(marker.dataset.pointIndex)]?.querySelector('.point-load') : editableField(marker.dataset.field); if(field && !field.disabled) { for(let parent=field.parentElement;parent;parent=parent.parentElement) if(parent.tagName==='DETAILS') parent.open=true; field.focus(); }};
 container.addEventListener('click',e=>activate(e.target));
 container.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('.input-hotspot')){e.preventDefault();activate(e.target);}});
 document.addEventListener('focusin',e=>container.querySelectorAll('[data-field]').forEach(el=>el.classList.toggle('is-active',el.dataset.field===modelFieldId(e.target))));
 document.addEventListener('focusout',e=>{if(fields.some(field=>field[0]===modelFieldId(e.target))) container.querySelectorAll('.is-active').forEach(el=>el.classList.remove('is-active'));});
}
