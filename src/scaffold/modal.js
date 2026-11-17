// Scaffold-to-beam modal controller.
//
// Presents a 3D scaffold the user configures, lets them pick the legs resting on
// a beam, and imports those legs' dead/live reactions into the beam analysis as
// point loads placed at their exact distance from the left support.

import { buildScaffold } from './model.js';
import { DEFAULT_COMPONENTS, DEFAULT_LIVE_LOAD_PSF } from './catalog.js';
import { beamFromSupports, mapLegsToBeam, toBeamPointLoads } from './legloads.js';
import { Scene3D } from './render3d.js';

const OFF_TOLERANCE_FT = 0.5;

const TEMPLATE = `
<div class="sfm-backdrop" data-sfm-close></div>
<div class="sfm-dialog" role="dialog" aria-modal="true" aria-labelledby="sfm-title">
  <header class="sfm-head">
    <div class="sfm-title-wrap">
      <span class="sfm-kicker">SCAFFOLD → BEAM</span>
      <h2 id="sfm-title">Leg load takeoff</h2>
    </div>
    <button type="button" class="sfm-x" data-sfm-close aria-label="Close">×</button>
  </header>
  <div class="sfm-body">
    <aside class="sfm-controls">
      <div class="sfm-group">
        <h3>Scaffold</h3>
        <div class="sfm-grid2">
          <label>Bays X<input type="number" id="sfm-bx" min="1" max="12" step="1" value="2"></label>
          <label>Bay width X<span class="sfm-unit"><input type="number" id="sfm-wx" min="1" step="any" value="7"><i>ft</i></span></label>
          <label>Bays Y<input type="number" id="sfm-by" min="1" max="12" step="1" value="1"></label>
          <label>Bay width Y<span class="sfm-unit"><input type="number" id="sfm-wy" min="1" step="any" value="7"><i>ft</i></span></label>
          <label>Lifts<input type="number" id="sfm-lifts" min="1" max="20" step="1" value="3"></label>
          <label>Lift height<span class="sfm-unit"><input type="number" id="sfm-lh" min="1" step="any" value="6.5"><i>ft</i></span></label>
        </div>
        <label class="sfm-row">Bracing
          <select id="sfm-braced">
            <option value="perimeter" selected>Perimeter</option>
            <option value="all">All faces</option>
            <option value="none">None</option>
          </select>
        </label>
        <label class="sfm-row">Live load<span class="sfm-unit"><input type="number" id="sfm-live" min="0" step="any" value="${DEFAULT_LIVE_LOAD_PSF}"><i>psf</i></span></label>
      </div>

      <details class="sfm-group sfm-assume">
        <summary>Component assumptions <span>editable · unverified</span></summary>
        <p class="sfm-note">Standard tube is 1.9″ OD × 0.12″ wall + 20% at 490 lb/ft³ (settled). Ledger, brace, and plank values below are provisional defaults — review before relying on the takeoff.</p>
        <div class="sfm-grid2">
          <label>Ledger OD<span class="sfm-unit"><input type="number" id="sfm-led-od" step="any" value="${DEFAULT_COMPONENTS.ledger.outsideDiameterIn}"><i>in</i></span></label>
          <label>Ledger wall<span class="sfm-unit"><input type="number" id="sfm-led-wall" step="any" value="${DEFAULT_COMPONENTS.ledger.wallThicknessIn}"><i>in</i></span></label>
          <label>Brace OD<span class="sfm-unit"><input type="number" id="sfm-br-od" step="any" value="${DEFAULT_COMPONENTS.brace.outsideDiameterIn}"><i>in</i></span></label>
          <label>Brace wall<span class="sfm-unit"><input type="number" id="sfm-br-wall" step="any" value="${DEFAULT_COMPONENTS.brace.wallThicknessIn}"><i>in</i></span></label>
          <label>Plank weight<span class="sfm-unit"><input type="number" id="sfm-plank" step="any" value="${DEFAULT_COMPONENTS.plank.areaWeightLbPerFt2}"><i>psf</i></span></label>
        </div>
      </details>

      <div class="sfm-group">
        <h3>Beam placement</h3>
        <div class="sfm-grid2">
          <label>Runs along
            <select id="sfm-axis"><option value="x" selected>X</option><option value="y">Y</option></select>
          </label>
          <label>Grid line<select id="sfm-line"></select></label>
        </div>
        <p class="sfm-note">Span taken from the beam workspace: <strong id="sfm-span">—</strong>. Left support sits at the first leg on this line.</p>
        <div class="sfm-actions-inline">
          <button type="button" class="sfm-btn" id="sfm-pick">Select legs on beam</button>
          <button type="button" class="sfm-btn ghost" id="sfm-clear">Clear</button>
        </div>
      </div>
    </aside>

    <div class="sfm-stage">
      <canvas id="sfm-canvas"></canvas>
      <div class="sfm-hint">Drag to orbit · Shift/right-drag to pan · Scroll to zoom · Click a leg to select</div>
    </div>

    <aside class="sfm-readout">
      <h3>Selected legs <span id="sfm-count">0</span></h3>
      <div class="sfm-table-wrap"><table class="sfm-table">
        <thead><tr><th>Leg</th><th>x<sub>L</sub> (ft)</th><th>Dead (lb)</th><th>Live (lb)</th></tr></thead>
        <tbody id="sfm-rows"></tbody>
      </table></div>
      <dl class="sfm-totals" id="sfm-totals"></dl>
      <p class="sfm-warn" id="sfm-warn" hidden></p>
    </aside>
  </div>
  <footer class="sfm-foot">
    <p class="sfm-disclaimer">Preliminary tributary-area takeoff. Dead and live are kept separate; verify before use.</p>
    <div class="sfm-foot-actions">
      <button type="button" class="sfm-btn ghost" data-sfm-close>Cancel</button>
      <button type="button" class="sfm-btn primary" id="sfm-import" disabled>Import to beam</button>
    </div>
  </footer>
</div>`;

export class ScaffoldModal {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = TEMPLATE;
    this.root.hidden = true;
    this.model = null;
    this.scene = null;
    this.selected = new Set();

    this.$ = id => this.root.querySelector(`#${id}`);
    this._bind();
  }

  _bind() {
    for (const el of this.root.querySelectorAll('[data-sfm-close]')) el.addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !this.root.hidden) this.close(); });

    const rebuildIds = ['sfm-bx', 'sfm-wx', 'sfm-by', 'sfm-wy', 'sfm-lifts', 'sfm-lh', 'sfm-braced', 'sfm-live',
      'sfm-led-od', 'sfm-led-wall', 'sfm-br-od', 'sfm-br-wall', 'sfm-plank'];
    for (const id of rebuildIds) this.$(id).addEventListener('input', () => this.rebuild());
    this.$('sfm-axis').addEventListener('change', () => { this.populateLines(); this.rebuild(); });
    this.$('sfm-line').addEventListener('change', () => this.refresh());

    this.$('sfm-pick').addEventListener('click', () => this.selectOnBeam());
    this.$('sfm-clear').addEventListener('click', () => { this.selected.clear(); this.refresh(); });
    this.$('sfm-import').addEventListener('click', () => this.importToBeam());
  }

  open() {
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    if (!this.scene) {
      this.scene = new Scene3D(this.$('sfm-canvas'), { onPickLeg: id => this.togglePick(id) });
    }
    // Canvas has real dimensions only now that the modal is visible.
    requestAnimationFrame(() => { this.scene.resize(); this.rebuild(true); });
  }

  close() {
    this.root.hidden = true;
    document.body.style.overflow = '';
  }

  _num(id, fallback) {
    const v = Number(this.$(id).value);
    return Number.isFinite(v) ? v : fallback;
  }

  config() {
    const bx = Math.max(1, Math.round(this._num('sfm-bx', 2)));
    const by = Math.max(1, Math.round(this._num('sfm-by', 1)));
    const wx = Math.max(0.5, this._num('sfm-wx', 7));
    const wy = Math.max(0.5, this._num('sfm-wy', 7));
    return {
      baysX: Array.from({ length: bx }, () => wx),
      baysY: Array.from({ length: by }, () => wy),
      lifts: Math.max(1, Math.round(this._num('sfm-lifts', 3))),
      liftHeightFt: Math.max(0.5, this._num('sfm-lh', 6.5)),
      bracedFaces: this.$('sfm-braced').value,
      liveLoadPsf: Math.max(0, this._num('sfm-live', DEFAULT_LIVE_LOAD_PSF)),
      components: {
        ledger: { outsideDiameterIn: this._num('sfm-led-od', 1.9), wallThicknessIn: this._num('sfm-led-wall', 0.12) },
        brace: { outsideDiameterIn: this._num('sfm-br-od', 1.9), wallThicknessIn: this._num('sfm-br-wall', 0.12) },
        plank: { areaWeightLbPerFt2: this._num('sfm-plank', 3.0) },
      },
    };
  }

  rebuild(reframe = false) {
    try {
      this.model = buildScaffold(this.config());
    } catch (err) {
      this.$('sfm-warn').hidden = false;
      this.$('sfm-warn').textContent = err.message;
      return;
    }
    // Prune selections that no longer exist.
    const ids = new Set(this.model.legs.map(l => l.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    this.populateLines();
    this.buildSceneGeometry();
    if (reframe) this.scene.frame(this.bbox());
    this.refresh();
  }

  populateLines() {
    if (!this.model) return;
    const axis = this.$('sfm-axis').value;
    const lines = axis === 'x' ? this.model.ys : this.model.xs;
    const sel = this.$('sfm-line');
    const prev = sel.value;
    sel.innerHTML = lines.map((_, i) => `<option value="${i}">Line ${i + 1}</option>`).join('');
    if (prev && Number(prev) < lines.length) sel.value = prev;
  }

  beamSpanFt() {
    const fromWorkspace = window.scafmetric?.getBeamSpanFt?.();
    if (fromWorkspace) return fromWorkspace;
    // Fall back to the footprint length along the chosen axis.
    const axis = this.$('sfm-axis').value;
    const lines = axis === 'x' ? this.model.xs : this.model.ys;
    return lines[lines.length - 1] - lines[0];
  }

  currentBeam() {
    const axis = this.$('sfm-axis').value;
    const lineIdx = Math.max(0, Math.min(Number(this.$('sfm-line').value) || 0,
      (axis === 'x' ? this.model.ys.length : this.model.xs.length) - 1));
    const span = this.beamSpanFt();
    const z = this.model.baseZ;
    if (axis === 'x') {
      const y = this.model.ys[lineIdx];
      const x0 = this.model.xs[0];
      return {
        beam: beamFromSupports([x0, y], [x0 + span, y], { offToleranceFt: OFF_TOLERANCE_FT }),
        draw: { a: [x0, y, z], b: [x0 + span, y, z] },
      };
    }
    const x = this.model.xs[lineIdx];
    const y0 = this.model.ys[0];
    return {
      beam: beamFromSupports([x, y0], [x, y0 + span], { offToleranceFt: OFF_TOLERANCE_FT }),
      draw: { a: [x, y0, z], b: [x, y0 + span, z] },
    };
  }

  bbox() {
    const m = this.model;
    return {
      min: [m.xs[0], m.ys[0], m.baseZ],
      max: [m.xs[m.nx - 1], m.ys[m.ny - 1], m.topZ],
    };
  }

  buildSceneGeometry() {
    const m = this.model;
    const z = m.baseZ;
    const grid = [];
    const pad = 3;
    const x0 = m.xs[0] - pad, x1 = m.xs[m.nx - 1] + pad;
    const y0 = m.ys[0] - pad, y1 = m.ys[m.ny - 1] + pad;
    const step = 1;
    for (let x = Math.floor(x0); x <= x1; x += step) grid.push([[x, y0, z], [x, y1, z]]);
    for (let y = Math.floor(y0); y <= y1; y += step) grid.push([[x0, y, z], [x1, y, z]]);

    const { draw } = this.currentBeam();
    this.scene.setScene({
      legs: m.legs.map(l => ({ id: l.id, base: [l.x, l.y, l.baseZ], top: [l.x, l.y, l.topZ], selected: this.selected.has(l.id) })),
      ledgers: m.ledgers.map(g => ({ a: g.a, b: g.b })),
      braces: m.braces.map(b => ({ a: b.a, b: b.b })),
      planks: m.planks.map(p => ({ quad: [[p.x0, p.y0, p.z], [p.x1, p.y0, p.z], [p.x1, p.y1, p.z], [p.x0, p.y1, p.z]] })),
      beam: draw,
      grid,
    });
  }

  togglePick(id) {
    if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    this.refresh();
  }

  selectOnBeam() {
    const { beam } = this.currentBeam();
    const located = mapLegsToBeam(this.model.legs, beam);
    this.selected = new Set(located.filter(r => r.onBeam && r.onSpan).map(r => r.leg.id));
    this.refresh();
  }

  located() {
    const { beam } = this.currentBeam();
    const legs = this.model.legs.filter(l => this.selected.has(l.id));
    return mapLegsToBeam(legs, beam);
  }

  refresh() {
    // Update selection highlight in the scene.
    if (this.scene?.scene?.legs) {
      for (const l of this.scene.scene.legs) l.selected = this.selected.has(l.id);
      this.scene._needsDraw = true;
    }
    this.$('sfm-span').textContent = `${round(this.beamSpanFt(), 3)} ft`;
    const located = this.model ? this.located() : [];
    located.sort((a, b) => a.locationFt - b.locationFt);
    this.$('sfm-count').textContent = String(located.length);

    const rows = located.map(r => {
      const warn = !(r.onSpan && r.onBeam);
      return `<tr class="${warn ? 'sfm-off' : ''}"><td>${r.leg.id}</td><td>${round(r.locationFt, 3)}</td><td>${round(r.leg.deadLb, 1)}</td><td>${round(r.leg.liveLb, 1)}</td></tr>`;
    }).join('');
    this.$('sfm-rows').innerHTML = rows || '<tr><td colspan="4" class="sfm-empty">No legs selected</td></tr>';

    const { imported, skipped } = toBeamPointLoads(located);
    const dead = imported.reduce((s, e) => s + e.deadLb, 0);
    const live = imported.reduce((s, e) => s + e.liveLb, 0);
    this.$('sfm-totals').innerHTML =
      `<div><dt>Importable</dt><dd>${imported.length}</dd></div>` +
      `<div><dt>Σ Dead</dt><dd>${round(dead, 1)} lb</dd></div>` +
      `<div><dt>Σ Live</dt><dd>${round(live, 1)} lb</dd></div>`;

    const warn = this.$('sfm-warn');
    if (skipped.length) {
      warn.hidden = false;
      warn.textContent = `${skipped.length} selected leg${skipped.length > 1 ? 's are' : ' is'} off the beam line or past the ${round(this.beamSpanFt(), 2)} ft span and will not be imported.`;
    } else {
      warn.hidden = true;
    }
    this.$('sfm-import').disabled = imported.length === 0;
    this._importable = imported;
  }

  importToBeam() {
    if (!window.scafmetric?.importScaffoldLoads) {
      this.$('sfm-warn').hidden = false;
      this.$('sfm-warn').textContent = 'Beam workspace is not ready to receive loads.';
      return;
    }
    const n = window.scafmetric.importScaffoldLoads(
      (this._importable || []).map(e => ({ legId: e.legId, deadLb: e.deadLb, liveLb: e.liveLb, locationFt: e.locationFt })),
    );
    this.close();
    window.dispatchEvent(new CustomEvent('scafmetric:loads-imported', { detail: { count: n } }));
  }
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
