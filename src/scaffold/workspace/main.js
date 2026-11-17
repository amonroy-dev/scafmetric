// Scaffold workspace entry (bundled to dist/scaffold-app.js). Builds the modal,
// mounts the three.js engine, wires the placement toolbar/ViewCube, derives the
// leg-load takeoff, and imports selected legs into the beam analysis.

import * as THREE from 'three';
import { Engine } from './engine.js';
import { ViewCube } from './viewcube.js';
import { Tools, TOOLS } from './tools.js';
import { ScaffoldState, stateBounds } from './state.js';
import { tubeMesh, plankMesh, nodeMesh, makeMaterial, COLORS, RADII } from './builders.js';
import { DEFAULT_COMPONENTS, DEFAULT_LIVE_LOAD_PSF } from '../catalog.js';
import { beamFromSupports, mapLegsToBeam, toBeamPointLoads } from '../legloads.js';

const TOOL_META = {
  standard: { label: 'Standard', hint: 'Click the ground to place a vertical standard. Click an existing one to stack a lift.' },
  ledger: { label: 'Ledger', hint: 'Click two standard nodes at the same level to place a horizontal ledger.' },
  brace: { label: 'Brace', hint: 'Click two standard nodes to place a diagonal brace up one lift.' },
  plank: { label: 'Plank', hint: 'Click two standard nodes (opposite corners) to deck a bay.' },
  select: { label: 'Select', hint: 'Click a component to select it. Delete removes it.' },
  erase: { label: 'Erase', hint: 'Click a component to remove it.' },
};
const TOOL_ICON = { standard: '│', ledger: '─', brace: '╱', plank: '▭', select: '➤', erase: '⌫' };
const OFF_TOLERANCE_FT = 0.5;

const TEMPLATE = `
<div class="sfw-backdrop" data-sfw-close></div>
<div class="sfw-dialog" role="dialog" aria-modal="true" aria-label="Scaffold builder">
  <header class="sfw-head">
    <div><span class="sfw-kicker">SCAFFOLD → BEAM</span><h2>Scaffold builder</h2></div>
    <button type="button" class="sfw-x" data-sfw-close aria-label="Close">×</button>
  </header>
  <div class="sfw-body">
    <div class="sfw-toolbar" id="sfw-toolbar"></div>
    <div class="sfw-stage" id="sfw-stage">
      <div class="sfw-hint" id="sfw-hint"></div>
    </div>
    <aside class="sfw-side">
      <div class="sfw-group">
        <h3>Build</h3>
        <div class="sfw-grid2">
          <label>Lift height<span class="sfw-u"><input type="number" id="sfw-lh" min="1" step="any" value="6.5"><i>ft</i></span></label>
          <label>Snap<span class="sfw-u"><input type="number" id="sfw-snap" min="0" step="any" value="1"><i>ft</i></span></label>
          <label>Live load<span class="sfw-u"><input type="number" id="sfw-live" min="0" step="any" value="${DEFAULT_LIVE_LOAD_PSF}"><i>psf</i></span></label>
          <label>Plank wt<span class="sfw-u"><input type="number" id="sfw-plank" min="0" step="any" value="${DEFAULT_COMPONENTS.plank.areaWeightLbPerFt2}"><i>psf</i></span></label>
        </div>
        <div class="sfw-counts" id="sfw-counts"></div>
        <button type="button" class="sfw-btn ghost" id="sfw-clear">Clear all</button>
      </div>
      <div class="sfw-group">
        <h3>Beam &amp; import</h3>
        <div class="sfw-grid2">
          <label>Runs along<select id="sfw-axis"><option value="x">X</option><option value="y">Y</option></select></label>
          <label>Position<span class="sfw-u"><input type="number" id="sfw-pos" step="any" value="0"><i>ft</i></span></label>
        </div>
        <p class="sfw-note">Span from beam workspace: <strong id="sfw-span">—</strong>. Left support = first leg on the line.</p>
        <button type="button" class="sfw-btn" id="sfw-pick">Select legs on beam</button>
        <div class="sfw-totals" id="sfw-totals"></div>
        <div class="sfw-table-wrap"><table class="sfw-table"><thead><tr><th>Leg</th><th>x<sub>L</sub></th><th>Dead</th><th>Live</th></tr></thead><tbody id="sfw-rows"></tbody></table></div>
        <p class="sfw-warn" id="sfw-warn" hidden></p>
      </div>
    </aside>
  </div>
  <footer class="sfw-foot">
    <p class="sfw-disclaimer">Preliminary tributary takeoff · dead and live kept separate · generic tubes.</p>
    <div>
      <button type="button" class="sfw-btn ghost" data-sfw-close>Cancel</button>
      <button type="button" class="sfw-btn primary" id="sfw-import" disabled>Import to beam</button>
    </div>
  </footer>
</div>`;

class Workspace {
  constructor(root) {
    this.root = root;
    root.innerHTML = TEMPLATE;
    root.hidden = true;
    this.$ = id => root.querySelector(`#${id}`);
    this.engine = null;
    this.beamLegs = new Set();
    this._importable = [];
    for (const el of root.querySelectorAll('[data-sfw-close]')) el.addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) this.close(); });
  }

  open() {
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    if (!this.engine) this._init();
    requestAnimationFrame(() => { this.engine.resize(); this._frame(); });
  }
  close() { this.root.hidden = true; document.body.style.overflow = ''; }

  _init() {
    const stage = this.$('sfw-stage');
    this.engine = new Engine(stage);
    this.viewcube = new ViewCube(this.engine);
    stage.appendChild(this.viewcube.el);

    this.state = new ScaffoldState({
      liftHeightFt: Number(this.$('sfw-lh').value) || 6.5,
      snapStep: Number(this.$('sfw-snap').value) || 1,
      liveLoadPsf: Number(this.$('sfw-live').value) || DEFAULT_LIVE_LOAD_PSF,
      components: { plank: { areaWeightLbPerFt2: Number(this.$('sfw-plank').value) || 3 } },
      onChange: () => this._sync(),
    });

    this.contentGroup = new THREE.Group();
    this.nodeGroup = new THREE.Group();
    this.beamGroup = new THREE.Group();
    this.engine.scene.add(this.contentGroup, this.nodeGroup, this.beamGroup);

    this.mats = {
      standard: makeMaterial(COLORS.standard),
      ledger: makeMaterial(COLORS.ledger),
      brace: makeMaterial(COLORS.brace),
      plank: new THREE.MeshStandardMaterial({ color: COLORS.plank, roughness: 0.6, metalness: 0.3, transparent: true, opacity: 0.85 }),
      node: new THREE.MeshBasicMaterial({ color: COLORS.node }),
      selected: makeMaterial(COLORS.selected, { emissive: 0x7a4a00, emissiveIntensity: 0.6 }),
      beamLeg: makeMaterial(COLORS.selected, { emissive: 0x7a4a00, emissiveIntensity: 0.9 }),
    };

    this.tools = new Tools(this.engine, this.state, {
      getNodeMeshes: () => this.nodeGroup.children,
      getContentMeshes: () => this.contentGroup.children,
      onSelect: id => { this.selectedId = id; this._sync(); },
      onToolChange: name => this._applyToolUi(name),
    });

    this._buildToolbar();
    this._bindInputs();
    this.tools.setTool('standard');
    this._seedStarter();
    this._sync();
  }

  // A small starter bay so the user immediately sees something to work with.
  _seedStarter() {
    const b = 7;
    for (const [x, y] of [[0, 0], [b, 0], [0, b], [b, b]]) this.state.addStandard(x, y);
    // ledgers around the top of lift 1
    this.state.addLedger(0, 0, b, 0, 1); this.state.addLedger(0, b, b, b, 1);
    this.state.addLedger(0, 0, 0, b, 1); this.state.addLedger(b, 0, b, b, 1);
    this.state.addPlank(0, 0, b, b, 1);
  }

  _buildToolbar() {
    const bar = this.$('sfw-toolbar');
    bar.innerHTML = TOOLS.map(t =>
      `<button type="button" class="sfw-tool" data-tool="${t}" title="${TOOL_META[t].label}"><span class="sfw-tool-ico">${TOOL_ICON[t]}</span><span class="sfw-tool-lbl">${TOOL_META[t].label}</span></button>`).join('')
      + `<div class="sfw-views"><button type="button" data-view="iso">ISO</button><button type="button" data-view="top">TOP</button><button type="button" data-view="front">FRT</button><button type="button" data-view="right">RT</button></div>`;
    for (const btn of bar.querySelectorAll('[data-tool]')) btn.addEventListener('click', () => this.tools.setTool(btn.dataset.tool));
    for (const btn of bar.querySelectorAll('[data-view]')) btn.addEventListener('click', () => this.engine.setView(btn.dataset.view));
  }

  _applyToolUi(name) {
    for (const btn of this.$('sfw-toolbar').querySelectorAll('[data-tool]')) btn.classList.toggle('is-active', btn.dataset.tool === name);
    this.$('sfw-hint').textContent = TOOL_META[name].hint;
    // Nodes only matter for connect tools.
    this.nodeGroup.visible = name === 'ledger' || name === 'brace' || name === 'plank';
  }

  _bindInputs() {
    this.$('sfw-lh').addEventListener('input', e => { this.state.liftHeightFt = Number(e.target.value) || 6.5; this._sync(); });
    this.$('sfw-snap').addEventListener('input', e => { this.state.snapStep = Number(e.target.value) || 0; });
    this.$('sfw-live').addEventListener('input', e => { this.state.liveLoadPsf = Number(e.target.value) || 0; this._sync(); });
    this.$('sfw-plank').addEventListener('input', e => { this.state.components.plank.areaWeightLbPerFt2 = Number(e.target.value) || 0; this._sync(); });
    this.$('sfw-clear').addEventListener('click', () => { this.beamLegs.clear(); this.state.clear(); });
    this.$('sfw-axis').addEventListener('change', () => this._updateBeam());
    this.$('sfw-pos').addEventListener('input', () => this._updateBeam());
    this.$('sfw-pick').addEventListener('click', () => this._selectLegsOnBeam());
    this.$('sfw-import').addEventListener('click', () => this._import());
  }

  _frame() {
    const b = stateBounds(this.state);
    if (b) this.engine.frame(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)));
  }

  _sync() {
    if (!this.engine) return;
    this._rebuildContent();
    this._rebuildNodes();
    this._updateBeam();
    this._updateCounts();
  }

  _disposeGroup(group) {
    // Geometries and materials are shared singletons — only detach the meshes.
    group.clear();
  }

  _rebuildContent() {
    this._disposeGroup(this.contentGroup);
    const geo = this.state.geometry();
    for (const t of geo.tubes) {
      let mat = this.mats[t.kind];
      if (t.id === this.selectedId) mat = this.mats.selected;
      else if (t.kind === 'standard' && this.beamLegs.has(t.id)) mat = this.mats.beamLeg;
      const mesh = tubeMesh(t.a, t.b, RADII[t.kind] ?? 0.09, mat);
      mesh.userData = { id: t.id, kind: t.kind };
      this.contentGroup.add(mesh);
    }
    for (const p of geo.planks) {
      const mat = p.id === this.selectedId ? this.mats.selected : this.mats.plank;
      const mesh = plankMesh(p.x0, p.y0, p.x1, p.y1, p.z, mat);
      mesh.userData = { id: p.id, kind: 'plank' };
      this.contentGroup.add(mesh);
    }
  }

  _rebuildNodes() {
    this._disposeGroup(this.nodeGroup);
    for (const n of this.state.nodes()) {
      const mesh = nodeMesh([n.x, n.y, n.z], this.mats.node);
      mesh.userData = { node: n };
      this.nodeGroup.add(mesh);
    }
  }

  _updateCounts() {
    const s = this.state;
    this.$('sfw-counts').innerHTML =
      `<span>${s.standards.size} std</span><span>${s.ledgers.size} ldg</span><span>${s.braces.size} brc</span><span>${s.planks.size} plk</span>`;
  }

  _beamSpan() {
    const w = window.scafmetric?.getBeamSpanFt?.();
    return w || 20;
  }

  _currentBeam() {
    const axis = this.$('sfw-axis').value;
    const pos = Number(this.$('sfw-pos').value) || 0;
    const span = this._beamSpan();
    const legs = [...this.state.standards.values()];
    const onLine = legs.filter(l => Math.abs((axis === 'x' ? l.y : l.x) - pos) <= OFF_TOLERANCE_FT);
    const starts = onLine.map(l => (axis === 'x' ? l.x : l.y));
    const start = starts.length ? Math.min(...starts) : 0;
    if (axis === 'x') {
      return { beam: beamFromSupports([start, pos], [start + span, pos], { offToleranceFt: OFF_TOLERANCE_FT }), draw: { a: [start, pos, 0], b: [start + span, pos, 0] }, span };
    }
    return { beam: beamFromSupports([pos, start], [pos, start + span], { offToleranceFt: OFF_TOLERANCE_FT }), draw: { a: [pos, start, 0], b: [pos, start + span, 0] }, span };
  }

  _updateBeam() {
    if (!this.engine) return;
    this._disposeGroup(this.beamGroup);
    const { draw, span } = this._currentBeam();
    this.beamGroup.add(tubeMesh(draw.a, draw.b, 0.16, new THREE.MeshStandardMaterial({ color: COLORS.beam, emissive: 0x0b4f49, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.5 })));
    this.$('sfw-span').textContent = `${round(span, 3)} ft`;
    this._refreshTakeoff();
  }

  _legsForImport() {
    const takeoff = this.state.takeoff();
    const byId = new Map(takeoff.legs.map(l => [l.id, l]));
    const { beam } = this._currentBeam();
    const chosen = [...this.beamLegs].map(id => byId.get(id)).filter(Boolean);
    return mapLegsToBeam(chosen, beam);
  }

  _selectLegsOnBeam() {
    const { beam } = this._currentBeam();
    const located = mapLegsToBeam(this.state.takeoff().legs, beam);
    this.beamLegs = new Set(located.filter(r => r.onBeam && r.onSpan).map(r => r.leg.id));
    this._rebuildContent();
    this._refreshTakeoff();
  }

  _refreshTakeoff() {
    const located = this._legsForImport().sort((a, b) => a.locationFt - b.locationFt);
    this.$('sfw-rows').innerHTML = located.length
      ? located.map(r => `<tr class="${r.onSpan && r.onBeam ? '' : 'sfw-off'}"><td>${r.leg.id}</td><td>${round(r.locationFt, 2)}</td><td>${round(r.leg.deadLb, 0)}</td><td>${round(r.leg.liveLb, 0)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="sfw-empty">No legs selected — use “Select legs on beam”.</td></tr>';
    const { imported, skipped } = toBeamPointLoads(located);
    this._importable = imported;
    const dead = imported.reduce((s, e) => s + e.deadLb, 0), live = imported.reduce((s, e) => s + e.liveLb, 0);
    this.$('sfw-totals').innerHTML = `<div><dt>Legs</dt><dd>${imported.length}</dd></div><div><dt>ΣDead</dt><dd>${round(dead, 0)} lb</dd></div><div><dt>ΣLive</dt><dd>${round(live, 0)} lb</dd></div>`;
    const warn = this.$('sfw-warn');
    if (skipped.length) { warn.hidden = false; warn.textContent = `${skipped.length} selected leg(s) off the beam line or past the span — excluded.`; }
    else warn.hidden = true;
    this.$('sfw-import').disabled = imported.length === 0;
  }

  _import() {
    if (!window.scafmetric?.importScaffoldLoads) { this.$('sfw-warn').hidden = false; this.$('sfw-warn').textContent = 'Beam workspace not ready.'; return; }
    const n = window.scafmetric.importScaffoldLoads(this._importable.map(e => ({ legId: e.legId, deadLb: e.deadLb, liveLb: e.liveLb, locationFt: e.locationFt })));
    this.close();
    window.dispatchEvent(new CustomEvent('scafmetric:loads-imported', { detail: { count: n } }));
  }
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

// --- boot -------------------------------------------------------------------
const root = document.getElementById('scaffold-modal');
if (root) {
  const ws = new Workspace(root);
  for (const btn of document.querySelectorAll('[data-open-scaffold]')) btn.addEventListener('click', () => ws.open());
  window.addEventListener('scafmetric:loads-imported', e => {
    const n = e.detail?.count ?? 0;
    for (const btn of document.querySelectorAll('[data-open-scaffold]')) { btn.dataset.imported = String(n); }
  });
}
