/* Beam input illustration. The drawing is schematic; field values come from the same
   controls consumed by the analysis. Position coordinates are measured from A. */
const $ = id => document.getElementById(id);
const escapeText = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
const numeric = id => { const value = $(id)?.value?.trim(); return value ? Number(value) : NaN; };
const fields = [
 ['span','01','Distance between supports','ft'], ['dead-load','02','Dead load D','kip/ft'], ['live-load','03','Live load L','kip/ft'],
 ['brace-locations','04','Lateral brace locations','ft from A'], ['section','05','Selected W section',''], ['self-weight','06','Beam self-weight',''],
 ['elastic-modulus','07','Elastic modulus E','ksi'], ['inertia','08','Strong-axis inertia Iₓ','in⁴'], ['stiffness-factor','09','Stiffness factor','× EI'],
 ['load-comparison','10','Load comparison',''], ['custom-safety-factor','11','Custom safety factor',': 1']
];
function fieldValue(id) {
 const el = $(id); if (!el) return '—';
 if (id === 'self-weight') return el.checked ? 'Included' : 'Excluded';
 if (id === 'load-comparison') return el.selectedOptions[0]?.textContent ?? '—';
 return el.value.trim() || '—';
}
function hotspot(id, n, x, y, label) {
 return `<g class="input-hotspot" data-field="${id}" tabindex="0" role="button" aria-label="Edit ${escapeText(label)}"><circle cx="${x}" cy="${y}" r="13"/><text x="${x}" y="${y + 4}" text-anchor="middle">${n}</text></g>`;
}
export function drawSchematic() {
 const container = $('schematic'); if (!container) return;
 const span = numeric('span'), validSpan = Number.isFinite(span) && span > 0;
 const rawBraces = $('brace-locations')?.value || '';
 const tokens = rawBraces.split(',').map(v => v.trim()).filter(Boolean);
 const parsed = tokens.map(Number);
 const validBraces = validSpan && parsed.every(v => Number.isFinite(v) && v >= 0 && v <= span);
 const braces = validBraces ? [...new Set(parsed)].sort((a,b)=>a-b) : [];
 const x = v => 77 + v / span * 566;
 const braceTicks = braces.map(v => `<path class="in-brace" d="M${x(v)} 136v-19"/><circle class="in-brace-dot" cx="${x(v)}" cy="138" r="3.5"/>`).join('');
 // Show positions in a separate text line; dense positions otherwise collide.
 const braceList = braces.length ? braces.map(fmt).join(', ') + ' ft from A' : (validSpan && !tokens.length ? 'No braces entered' : 'Check brace locations');
 const dead = numeric('dead-load'), live = numeric('live-load');
 const loadValid = Number.isFinite(dead) && dead >= 0 && Number.isFinite(live) && live >= 0;
 const anyLoad = loadValid && (dead > 0 || live > 0 || $('self-weight')?.checked);
 const arrows = anyLoad ? Array.from({length:11}, (_,i) => { const a=77+i*56.6;return `<path d="M${a} 64v54m-5-8 5 8 5-8"/>`; }).join('') : '';
 const activeFields = fields.filter(([id]) => id !== 'custom-safety-factor' || $('load-comparison')?.value === 'custom');
 container.innerHTML = `<div class="input-visual-header"><div><span class="input-visual-kicker">MODEL / 01</span><strong>Beam geometry &amp; loading</strong></div><span>SCHEMATIC · NOT TO SCALE</span></div>
 <div class="input-drawings"><div class="input-elevation"><div class="input-drawing-label">ELEVATION · FULL-SPAN UNIFORM LOAD</div><div class="input-scroll" tabindex="0" role="region" aria-label="Beam drawing. Scroll horizontally if needed.">
 <svg class="input-beam" viewBox="0 0 720 266" role="group" aria-label="Simply supported beam, downward uniform load and lateral brace locations, schematic not to scale.">
 <defs><pattern id="input-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#22304b" stroke-width="1"/></pattern></defs><rect width="720" height="266" fill="url(#input-grid)"/>
 <g class="in-load">${arrows}${anyLoad?'<path d="M77 64H643"/>':''}</g>
 <text class="in-text" x="360" y="37" text-anchor="middle">${loadValid ? `D ${fmt(dead)} + L ${fmt(live)} kip/ft · self-weight ${$('self-weight')?.checked ? 'included' : 'excluded'}` : 'Enter valid nonnegative loads'}</text>
 <path class="in-beam" d="M77 138H643"/><g class="in-support"><path d="M77 144l-14 23h28zM643 144l-14 23h28zM58 172h38M624 180h38"/><circle cx="634" cy="174" r="3"/><circle cx="652" cy="174" r="3"/></g>${braceTicks}
 <path class="in-dim" d="M77 186v37M643 186v37M77 211H643M77 206v10M643 206v10"/>
 <text class="in-dimtext" x="360" y="237" text-anchor="middle">L = ${validSpan ? fmt(span) : '—'} ft · DISTANCE BETWEEN SUPPORTS</text><text class="in-note" x="77" y="193" text-anchor="middle">A · PIN</text><text class="in-note" x="643" y="193" text-anchor="middle">B · ROLLER</text>
 ${hotspot('span','1',360,211,'distance between supports')}${hotspot('dead-load','2',175,64,'dead load')}${hotspot('live-load','3',545,64,'live load')}${hotspot('brace-locations','4',255,138,'lateral brace locations')}${hotspot('self-weight','6',470,138,'beam self-weight')}
 </svg></div><p class="input-scroll-note">Teal ticks indicate lateral braces, not vertical supports. Use the input guide below for larger touch targets.</p><div class="input-brace-summary"><strong>BRACES / X</strong><span>${escapeText(braceList)}</span></div></div>
 <div class="input-section"><div class="input-drawing-label">SECTION · MAJOR-AXIS BENDING</div><svg class="input-section-svg" viewBox="0 0 300 200" role="group" aria-label="Illustration of selected wide-flange section, bending about its strong axis."><path class="in-section-shape" d="M74 30H226V49H166V151H226V170H74V151H134V49H74Z"/><path class="in-axis" d="M51 100H249"/><text class="in-note" x="42" y="104">x</text><text class="in-note" x="253" y="104">x</text><text class="in-note" x="150" y="190" text-anchor="middle">STRONG AXIS · X–X</text>${hotspot('section','5',150,38,'section')}${hotspot('inertia','8',229,100,'strong-axis moment of inertia')}</svg>
 <div class="input-properties"><button type="button" data-field="section"><span>SECTION</span><strong>${escapeText(fieldValue('section'))}</strong></button><button type="button" data-field="elastic-modulus"><span>07 / ELASTIC MODULUS E</span><strong>${escapeText(fieldValue('elastic-modulus'))} ksi</strong></button><button type="button" data-field="inertia"><span>08 / STRONG-AXIS Iₓ</span><strong>${escapeText(fieldValue('inertia'))} in⁴</strong></button><button type="button" data-field="stiffness-factor"><span>09 / STIFFNESS FACTOR</span><strong>${escapeText(fieldValue('stiffness-factor'))} × EI</strong></button></div></div></div>
 <div class="input-guide-heading"><strong>INPUT GUIDE</strong><span>Select any value to edit it</span></div><div class="input-guide" aria-label="Beam model input values">${activeFields.map(([id,n,title,unit])=>`<button type="button" class="input-guide-item" data-field="${id}"><span class="input-guide-number">${n}</span><span><strong>${escapeText(title)}</strong><small>${escapeText(fieldValue(id))}${unit ? ' '+unit : ''}</small></span><span class="input-guide-arrow" aria-hidden="true">↗</span></button>`).join('')}</div>
 <p class="input-explanation">This illustration shows the supported one-span model only. Brace ticks describe lateral restraint; they do not add vertical supports. Section and stiffness values are properties, not dimensions. The optional load comparison is separate from the service-load diagram.</p>`;
 const focused = document.activeElement?.id;
 container.querySelectorAll('[data-field]').forEach(el => el.classList.toggle('is-active', el.dataset.field === focused));
}
export function bindSchematic() {
 const container=$('schematic'); if (!container) return;
 const activate=target=>{const marker=target.closest('[data-field]'); if(!marker) return; const field=$(marker.dataset.field); if(field && !field.disabled) field.focus();};
 container.addEventListener('click',e=>activate(e.target));
 container.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('.input-hotspot')){e.preventDefault();activate(e.target);}});
 document.addEventListener('focusin',e=>container.querySelectorAll('[data-field]').forEach(el=>el.classList.toggle('is-active',el.dataset.field===e.target.id)));
 document.addEventListener('focusout',e=>{if(fields.some(field=>field[0]===e.target.id)) container.querySelectorAll('.is-active').forEach(el=>el.classList.remove('is-active'));});
}
