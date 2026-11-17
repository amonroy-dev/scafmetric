// Scaffold workspace entry (bundled to dist/scaffold-app.js).

import * as THREE from 'three';
import { Engine } from './engine.js';
import { ViewCube } from './viewcube.js';
import { Tools, TOOLS } from './tools.js';
import { ScaffoldState, stateBounds } from './state.js';
import {
  MATERIALS, verticalTube, tubeBetween, buildBaseAssembly,
  STANDARD_TUBE_OD_IN, rosetteDisk, plankBoard, PLANK_MATERIAL,
} from './parts.js';
import { CATALOG, CATEGORIES, DEFAULT_PART, CATEGORY_TOOL, getPart } from './catalog.js';
import { DEFAULT_COMPONENTS, DEFAULT_LIVE_LOAD_PSF } from '../catalog.js';
import { beamFromSupports, mapLegsToBeam, toBeamPointLoads } from '../legloads.js';
import { deriveBom, bomToCsv } from './bom.js';
import { KEYS, RETENTION_NOTICE, save as saveWip, load as loadWip, purgeExpired, debounce, formatSavedAt, loadServerWorkspace, saveServerWorkspace, pickNewer } from '../store.js';
import { buildSideBracket, buildTruss, GUARDRAIL_OD_IN } from './parts.js';
import { exportScaffoldDxf, buildCenterlineModel, LAYERS } from './dxf.js';

const TOOL_META = {
  select: { label: 'Select', icon: '⬚', hint: 'Click to select (shift to add). Drag L-to-R = window, R-to-L = crossing; Ctrl+drag adds. Delete removes.' },
  block: { label: 'Block', icon: '▦', hint: 'Drag a rectangle on the ground to lay out a whole block: bays, standards, ledgers, perimeter bracing and a deck.' },
  standard: { label: 'Standard', icon: '│', hint: 'Click the ground to set a standard on its base. Click an existing leg to stack another segment.' },
  ledger: { label: 'Ledger', icon: '─', hint: 'ONE click on a rosette node runs a ledger to the nearest open standard. SHIFT+click fills every bay at that level.' },
  brace: { label: 'Brace', icon: '╱', hint: 'ONE click places a diagonal to the next standard, 4 rosette levels up. SHIFT+click braces every bay at that level.' },
  truss: { label: 'Truss', icon: '⬟', hint: 'Click two rosette nodes to span a truss between them.' },
  bracket: { label: 'Bracket', icon: '⊢', hint: 'Click a rosette node to hang a side bracket, drawn from generic tubing. The arm points away from the scaffold.' },
  plank: { label: 'Plank', icon: '▭', hint: 'Click two rosette nodes on opposite corners to deck a bay with best-fit 9 in / 6 in boards.' },
  erase: { label: 'Erase', icon: '⌫', hint: 'Click a component to remove it.' },
};
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
    <div class="sfw-stage" id="sfw-stage"><div class="sfw-hint" id="sfw-hint"></div></div>
    <aside class="sfw-side">
      <div class="sfw-group">
        <h3>Catalog</h3>
        <label>Category<select id="sfw-cat"></select></label>
        <label class="sfw-mt">Size<select id="sfw-part"></select></label>
        <p class="sfw-note" id="sfw-partnote"></p>
      </div>
      <div class="sfw-group">
        <h3>Base</h3>
        <label>Block height<span class="sfw-u"><input type="number" id="sfw-blockh" min="2" step="any" value="19.7"><i>ft</i></span></label>
        <label class="sfw-mt">Screw jack extension<span class="sfw-u"><input type="number" id="sfw-jack" min="0" max="12" step="0.25" value="6"><i>in</i></span></label>
        <label class="sfw-check"><input type="checkbox" id="sfw-sill" checked><span>Wood sill</span></label>
        <label class="sfw-check"><input type="checkbox" id="sfw-collar" checked><span>Base collar</span></label>
        <div class="sfw-counts" id="sfw-counts"></div>
        <button type="button" class="sfw-btn ghost" id="sfw-clear">Clear all</button>
      </div>
      <div class="sfw-group">
        <h3>Loads</h3>
        <div class="sfw-grid2">
          <label>Live load<span class="sfw-u"><input type="number" id="sfw-live" min="0" step="any" value="${DEFAULT_LIVE_LOAD_PSF}"><i>psf</i></span></label>
          <label>Plank wt<span class="sfw-u"><input type="number" id="sfw-plank" min="0" step="any" value="${DEFAULT_COMPONENTS.plank.areaWeightLbPerFt2}"><i>psf</i></span></label>
        </div>
      </div>
      <div class="sfw-group">
        <h3>Selection</h3>
        <div id="sfw-props" class="sfw-props"></div>
        <div class="sfw-actions-row">
          <button type="button" class="sfw-btn ghost" id="sfw-move">Move</button>
          <button type="button" class="sfw-btn ghost" id="sfw-copy">Copy</button>
        </div>
      </div>
      <div class="sfw-group">
        <h3>Guardrails</h3>
        <div class="sfw-actions-row">
          <button type="button" class="sfw-btn" id="sfw-rails">Add to decks</button>
          <button type="button" class="sfw-btn ghost" id="sfw-rails-clear">Clear</button>
        </div>
      </div>
      <div class="sfw-group">
        <h3>Views <button type="button" class="sfw-mini" id="sfw-view-save">SAVE</button></h3>
        <div id="sfw-views" class="sfw-views-list"></div>
      </div>
      <div class="sfw-group">
        <h3>Bill of materials <button type="button" class="sfw-mini" id="sfw-bom-csv">CSV</button></h3>
        <div class="sfw-table-wrap sfw-bom-wrap"><table class="sfw-table sfw-bom"><thead><tr><th>Item</th><th>Qty</th><th>Wt (lb)</th></tr></thead><tbody id="sfw-bom-rows"></tbody></table></div>
        <div class="sfw-totals" id="sfw-bom-total"></div>
        <button type="button" class="sfw-btn ghost sfw-mt" id="sfw-dxf">Export DXF centerlines</button>
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
    <p class="sfw-disclaimer">Preliminary tributary takeoff · dead and live kept separate · generic tubes.<br><span class="sfw-retain" id="sfw-retain"></span></p>
    <div>
      <button type="button" class="sfw-btn ghost" data-sfw-close>Cancel</button>
      <button type="button" class="sfw-btn primary" id="sfw-import" disabled>Import to beam</button>
    </div>
  </footer>
</div>`;

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(6,11,20,0.82)';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = '#ffa41b'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 253, 61);
  g.fillStyle = '#ffd79a';
  g.font = 'bold 30px monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.9, 0.48, 1);
  return sp;
}

class Workspace {
  constructor(root) {
    this.root = root;
    root.innerHTML = TEMPLATE;
    root.hidden = true;
    this.$ = id => root.querySelector(`#${id}`);
    this.engine = null;
    this.beamLegs = new Set();
    this.selection = [];
    this.showLegLoads = true;
    this._importable = [];
    for (const el of root.querySelectorAll('[data-sfw-close]')) el.addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') {
        // Escape cancels the in-progress action only. It must never close the
        // builder, which previously dumped the user back to the beam form.
        e.preventDefault();
        if (this.tools) { this.tools.pending = null; this.tools._clearGhost(); this.tools._clearOverlay(); this.tools.transformHook = null; }
        this._transform = null;
        this.$('sfw-hint').textContent = 'Action cancelled. Close with the × button; your model is saved.';
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) this.state?.redo(); else this.state?.undo();
        this.selection = [];
        this._sync();
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        this.state?.redo();
        this.selection = [];
        this._sync();
      }
    });
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
    this.engine.onProjectionChange = mode => {
      const btn = this.root.querySelector('[data-toggle="ortho"]');
      if (btn) btn.classList.toggle('is-on', mode === 'orthographic');
    };
    this.viewcube = new ViewCube(this.engine, 92, { onHome: () => { this.engine.setView('home'); this._frame(); } });
    stage.appendChild(this.viewcube.el);

    this.state = new ScaffoldState({
      snapStep: 1,
      liveLoadPsf: Number(this.$('sfw-live').value) || DEFAULT_LIVE_LOAD_PSF,
      components: { plank: { areaWeightLbPerFt2: Number(this.$('sfw-plank').value) || 3 } },
      jackExtensionIn: Number(this.$('sfw-jack').value) || 0,
      onChange: () => this._sync(),
    });

    this.contentGroup = new THREE.Group();
    this.nodeGroup = new THREE.Group();
    this.beamGroup = new THREE.Group();
    this.labelGroup = new THREE.Group();
    this.engine.scene.add(this.contentGroup, this.nodeGroup, this.beamGroup, this.labelGroup);
    this.nodeActiveMat = new THREE.MeshStandardMaterial({ color: 0x3dd9c9, emissive: 0x135f57, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.4 });
    this.beamMat = new THREE.MeshStandardMaterial({ color: 0x3dd9c9, emissive: 0x0b4f49, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.5 });

    this.engine.raycaster.params.Line = { threshold: 0.25 };
    this.tools = new Tools(this.engine, this.state, {
      getNodeMeshes: () => this.nodeGroup.children,
      getContentMeshes: () => this.contentGroup.children,
      onSelectionChange: ids => { this.selection = ids; this._rebuildContent(); this._refreshProps(); },
      onToolChange: name => this._applyToolUi(name),
      onBulkFill: (n, tool) => {
        if (tool === 'block') {
          this.$('sfw-hint').textContent = n
            ? `Block placed: ${n} standards with ledgers, bracing and a deck.`
            : 'Drag a larger rectangle to lay out a block.';
        } else {
          this.$('sfw-hint').textContent = n
            ? `Added ${n} ${tool}${n > 1 ? 's' : ''} across every bay at that level.`
            : 'Nothing to add at that level — place more standards first.';
        }
      },
    });

    this.tools.blockHeightFt = Math.max(2, Number(this.$('sfw-blockh').value) || 19.7);
    this._persist = debounce(() => {
      const snapshot = this.state.snapshot();
      saveWip(KEYS.scaffold, snapshot);
      const el = this.$('sfw-retain');
      if (el) el.textContent = `${RETENTION_NOTICE} Saved just now.`;
      // Best-effort mirror to the signed-in account; never blocks the UI.
      saveServerWorkspace({ scaffold: snapshot }).then(ok => {
        if (ok && el) el.textContent = `${RETENTION_NOTICE} Saved to your account just now.`;
      });
    }, 800);
    this.$('sfw-bom-csv').addEventListener('click', () => this._downloadBom());
    this._buildToolbar();
    this._buildCatalogUi();
    this._bindInputs();
    this.tools.setCatalog('standards', DEFAULT_PART.standards);
    // Restore work in progress if it is still within the retention window.
    purgeExpired();
    const wip = loadWip(KEYS.scaffold);
    const el = this.$('sfw-retain');
    if (wip && wip.data) {
      try { this.state.restore(wip.data); } catch { this._seedStarter(); }
      if (el) el.textContent = `${RETENTION_NOTICE} Restored from this device, ${formatSavedAt(wip.savedAt)}.`;
    } else {
      this._seedStarter();
      if (el) el.textContent = RETENTION_NOTICE;
    }
    // If the account holds a newer copy, take it instead.
    loadServerWorkspace().then(server => {
      if (!server?.scaffold) return;
      const winner = pickNewer(wip, server);
      if (!winner || winner.source !== 'account') return;
      try {
        this.state.restore(server.scaffold);
        this.state.resetHistory();
        this._sync();
        if (el) el.textContent = `${RETENTION_NOTICE} Restored from your account, ${formatSavedAt(winner.savedAt)}.`;
      } catch { /* keep the local copy */ }
    });
    this.state.resetHistory();
    this._renderViews();
    this._refreshProps();
    this._sync();
  }

  _seedStarter() {
    const part = getPart('standards', DEFAULT_PART.standards);
    const b = 7;
    for (const [x, y] of [[0, 0], [b, 0], [0, b], [b, b]]) this.state.addStandard(x, y, part.lengthFt);
    // Ledgers at the first connection level around the bay.
    const nodes = this.state.nodes().filter(n => n.level === 1);
    const at = (x, y) => nodes.find(n => n.x === x && n.y === y);
    const pairs = [[[0, 0], [b, 0]], [[0, b], [b, b]], [[0, 0], [0, b]], [[b, 0], [b, b]]];
    for (const [p, q] of pairs) {
      const a = at(p[0], p[1]), c = at(q[0], q[1]);
      if (a && c) this.state.addLedger([a.x, a.y, a.z], [c.x, c.y, c.z]);
    }
    const c0 = at(0, 0), c1 = at(b, b);
    if (c0 && c1) this.state.addPlank([c0.x, c0.y, c0.z], [c1.x, c1.y, c1.z]);
  }

  _buildToolbar() {
    const bar = this.$('sfw-toolbar');
    bar.innerHTML =
      TOOLS.map(t => `<button type="button" class="sfw-tool" data-tool="${t}" title="${TOOL_META[t].label}"><span class="sfw-tool-ico">${TOOL_META[t].icon}</span><span class="sfw-tool-lbl">${TOOL_META[t].label}</span></button>`).join('')
      + `<div class="sfw-toggles">
           <button type="button" class="sfw-toggle" data-toggle="ortho" title="Orthographic view">ORTHO</button>
           <button type="button" class="sfw-toggle" data-toggle="panlock" title="Lock left-drag to pan">PAN</button>
           <button type="button" class="sfw-toggle is-on" data-toggle="legloads" title="Show leg loads">LOADS</button>
           <button type="button" class="sfw-toggle" data-toggle="skeleton" title="Line (centerline) view">LINE</button>
         </div>
         <div class="sfw-toggles">
           <button type="button" class="sfw-toggle" data-act="undo" title="Undo (Ctrl+Z)">UNDO</button>
           <button type="button" class="sfw-toggle" data-act="redo" title="Redo (Ctrl+Shift+Z)">REDO</button>
         </div>`;
    for (const btn of bar.querySelectorAll('[data-tool]')) {
      btn.addEventListener('click', () => {
        this.tools.setTool(btn.dataset.tool);
        // Keep the catalog dropdown in step with the chosen tool.
        const cat = CATEGORIES.find(c => CATEGORY_TOOL[c] === btn.dataset.tool);
        if (cat && this.$('sfw-cat').value !== cat) { this.$('sfw-cat').value = cat; this._onCategoryChange(false); }
      });
    }
    for (const btn of bar.querySelectorAll('[data-toggle]')) {
      btn.addEventListener('click', () => this._toggle(btn.dataset.toggle, btn));
    }
    for (const btn of bar.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'undo') this.state.undo(); else this.state.redo();
        this.selection = [];
        this._sync();
      });
    }
  }

  _toggle(name, btn) {
    if (name === 'ortho') {
      const on = this.engine.projection !== 'orthographic';
      this.engine.setProjection(on ? 'orthographic' : 'perspective');
      btn.classList.toggle('is-on', on);
    } else if (name === 'panlock') {
      const on = !this.engine.panLock;
      this.engine.setPanLock(on);
      btn.classList.toggle('is-on', on);
    } else if (name === 'skeleton') {
      this.skeleton = !this.skeleton;
      btn.classList.toggle('is-on', this.skeleton);
      this._rebuildContent();
      this.$('sfw-hint').textContent = this.skeleton
        ? 'Line view: members drawn as centerlines with joints, the same model the DXF exports.'
        : 'Solid view.';
    } else if (name === 'legloads') {
      this.showLegLoads = !this.showLegLoads;
      btn.classList.toggle('is-on', this.showLegLoads);
      this._rebuildLabels();
    }
  }

  _buildCatalogUi() {
    const cat = this.$('sfw-cat');
    cat.innerHTML = CATEGORIES.map(k => `<option value="${k}">${CATALOG[k].label}</option>`).join('');
    cat.value = 'standards';
    this._onCategoryChange(false);
    cat.addEventListener('change', () => this._onCategoryChange(true));
    this.$('sfw-part').addEventListener('change', () => this._onPartChange());
  }

  _onCategoryChange(switchTool) {
    const key = this.$('sfw-cat').value;
    const sel = this.$('sfw-part');
    sel.innerHTML = CATALOG[key].parts.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
    sel.value = DEFAULT_PART[key];
    if (switchTool) this.tools.setCatalog(key, sel.value);
    else { this.tools.categoryKey = key; this.tools.partId = sel.value; }
    this._updatePartNote();
  }
  _onPartChange() {
    const key = this.$('sfw-cat').value;
    this.tools.setCatalog(key, this.$('sfw-part').value);
    this._updatePartNote();
  }
  _updatePartNote() {
    const key = this.$('sfw-cat').value;
    const part = getPart(key, this.$('sfw-part').value);
    this.$('sfw-partnote').textContent = part ? `${CATALOG[key].code} · ${part.label} · generic tube, no part number` : '';
  }

  _applyToolUi(name) {
    for (const b of this.$('sfw-toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('is-active', b.dataset.tool === name);
    this.$('sfw-hint').textContent = TOOL_META[name]?.hint || '';
    this._rebuildNodes();
  }

  _bindInputs() {
    this.$('sfw-blockh').addEventListener('input', e => { this.tools.blockHeightFt = Math.max(2, Number(e.target.value) || 19.7); });
    this.$('sfw-jack').addEventListener('input', e => this.state.setBase({ jackExtensionIn: Math.max(0, Number(e.target.value) || 0) }));
    this.$('sfw-sill').addEventListener('change', e => this.state.setBase({ showWoodSill: e.target.checked }));
    this.$('sfw-collar').addEventListener('change', e => this.state.setBase({ showBaseCollar: e.target.checked }));
    this.$('sfw-live').addEventListener('input', e => { this.state.liveLoadPsf = Math.max(0, Number(e.target.value) || 0); this._sync(); });
    this.$('sfw-plank').addEventListener('input', e => { this.state.components.plank.areaWeightLbPerFt2 = Math.max(0, Number(e.target.value) || 0); this._sync(); });
    this.$('sfw-clear').addEventListener('click', () => { this.beamLegs.clear(); this.selection = []; this.state.clear(); });
    this.$('sfw-axis').addEventListener('change', () => this._updateBeam());
    this.$('sfw-pos').addEventListener('input', () => this._updateBeam());
    this.$('sfw-pick').addEventListener('click', () => this._selectLegsOnBeam());
    this.$('sfw-import').addEventListener('click', () => this._import());
    this.$('sfw-rails').addEventListener('click', () => {
      const n = this.state.generateGuardrails();
      this.$('sfw-hint').textContent = n ? `Guardrails added around every decked area (${n} members).` : 'Deck a bay first, then add guardrails.';
    });
    this.$('sfw-rails-clear').addEventListener('click', () => this.state.clearGuardrails());
    this.$('sfw-move').addEventListener('click', () => this._beginTransform(false));
    this.$('sfw-copy').addEventListener('click', () => this._beginTransform(true));
    this.$('sfw-dxf').addEventListener('click', () => this._downloadDxf());
    this.$('sfw-view-save').addEventListener('click', () => this._saveView());
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
    this._refreshBom();
    this._persist();
  }

  _matFor(id, fallback) {
    if (this.selection.includes(id)) return MATERIALS.selected;
    if (this.beamLegs.has(id)) return MATERIALS.selected;
    return fallback;
  }

  _rebuildContent() {
    this.contentGroup.clear();
    if (this.skeleton) { this._rebuildSkeleton(); this._rebuildLabels(); return; }
    const g = this.state.geometry();
    for (const s of g.standards) {
      const mat = this._matFor(s.id, MATERIALS.steel);
      const sel = mat === MATERIALS.selected;
      const { meshes } = buildBaseAssembly({
        x: s.x, y: s.y, groundZ: 0,
        jackExtensionIn: this.state.base.jackExtensionIn,
        showWoodSill: this.state.base.showWoodSill,
        showBaseCollar: this.state.base.showBaseCollar,
        material: sel ? MATERIALS.selected : null,
      });
      for (const m of meshes) { m.userData.id = s.id; m.userData.kind = 'base'; this.contentGroup.add(m); }
      const tube = verticalTube(s.x, s.y, s.baseZ, s.topZ, STANDARD_TUBE_OD_IN, mat);
      tube.userData = { id: s.id, kind: 'standard' };
      this.contentGroup.add(tube);
    }
    for (const l of g.ledgers) {
      const m = tubeBetween(l.a, l.b, 1.9, this._matFor(l.id, MATERIALS.ledger));
      m.userData = { id: l.id, kind: 'ledger' };
      this.contentGroup.add(m);
    }
    for (const b of g.braces) {
      const m = tubeBetween(b.a, b.b, 1.69, this._matFor(b.id, MATERIALS.brace));
      m.userData = { id: b.id, kind: 'brace' };
      this.contentGroup.add(m);
    }
    for (const p of g.planks) {
      const mat = this._matFor(p.id, PLANK_MATERIAL);
      for (const b of p.boards) {
        const m = plankBoard(b.center, b.rotationZ, b.lengthFt, b.widthIn, mat);
        m.userData = { id: p.id, kind: 'plank' };
        this.contentGroup.add(m);
      }
    }
    for (const t of g.trusses || []) {
      const mat = this._matFor(t.id, MATERIALS.ledger);
      for (const m of buildTruss(t.a, t.b, mat)) { m.userData = { id: t.id, kind: 'truss' }; this.contentGroup.add(m); }
    }
    for (const gr of g.guardrails || []) {
      const mat = this._matFor(gr.id, MATERIALS.brace);
      const m = tubeBetween(gr.a, gr.b, GUARDRAIL_OD_IN, mat);
      m.userData = { id: gr.id, kind: 'guardrail' };
      this.contentGroup.add(m);
    }
    for (const br of g.brackets || []) {
      const mat = this._matFor(br.id, MATERIALS.ledger);
      for (const m of buildSideBracket({ x: br.x, y: br.y, z: br.z }, br.dir, br.lengthFt, mat)) {
        m.userData = { id: br.id, kind: 'bracket' };
        this.contentGroup.add(m);
      }
    }
    this._rebuildLabels();
  }

  // Centerline (skeleton) view: one line per member plus joint markers. Picking
  // still works because each line carries its member id.
  _rebuildSkeleton() {
    const model = buildCenterlineModel(this.state);
    const colours = {
      [LAYERS.standard]: 0x9fb2cc,
      [LAYERS.ledger]: 0x3dd9c9,
      [LAYERS.brace]: 0x8a7bd8,
      [LAYERS.truss]: 0xffc266,
      [LAYERS.bracket]: 0x6ee7b7,
      [LAYERS.guardrail]: 0xffa41b,
    };
    this._lineMats = this._lineMats || {};
    for (const seg of model.segments) {
      const selected = seg.id && this.selection.includes(seg.id);
      const colour = selected ? 0xa855f7 : (colours[seg.layer] ?? 0xaebbd1);
      const key = `${colour}`;
      if (!this._lineMats[key]) this._lineMats[key] = new THREE.LineBasicMaterial({ color: colour });
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...seg.start), new THREE.Vector3(...seg.end),
      ]);
      const line = new THREE.Line(geo, this._lineMats[key]);
      line.userData = { id: seg.id, kind: 'line' };
      this.contentGroup.add(line);
    }
    // Joint markers so splices and connections read clearly.
    this._jointGeo = this._jointGeo || new THREE.SphereGeometry(0.1, 8, 6);
    this._jointMat = this._jointMat || new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const p of model.points) {
      const m = new THREE.Mesh(this._jointGeo, this._jointMat);
      m.position.set(p[0], p[1], p[2]);
      m.raycast = () => {};
      this.contentGroup.add(m);
    }
  }

  _refreshProps() {
    const el = this.$('sfw-props');
    if (!el) return;
    const ids = this.selection;
    if (!ids.length) { el.innerHTML = '<p class="sfw-note">Nothing selected. Click a member, or drag a marquee.</p>'; return; }
    if (ids.length > 1) {
      const kinds = {};
      for (const id of ids) { const k = this._kindOf(id); kinds[k] = (kinds[k] || 0) + 1; }
      el.innerHTML = `<dl class="sfw-proplist"><div><dt>Selected</dt><dd>${ids.length}</dd></div>` +
        Object.entries(kinds).map(([k, n]) => `<div><dt>${k}</dt><dd>${n}</dd></div>`).join('') + '</dl>';
      return;
    }
    const id = ids[0];
    const rows = this._describe(id);
    el.innerHTML = `<dl class="sfw-proplist">` +
      rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('') + '</dl>';
  }

  _kindOf(id) {
    if (this.state.standards.has(id)) return 'standard';
    if (this.state.ledgers.has(id)) return 'ledger';
    if (this.state.braces.has(id)) return 'brace';
    if (this.state.planks.has(id)) return 'plank';
    if (this.state.brackets.has(id)) return 'bracket';
    if (this.state.trusses.has(id)) return 'truss';
    if (this.state.guardrails.has(id)) return 'guardrail';
    return 'item';
  }

  _describe(id) {
    const r = v => Math.round(v * 100) / 100;
    const st = this.state.standards.get(id);
    if (st) {
      const { legs } = this.state.takeoff();
      const leg = legs.find(l => l.id === id);
      return [['Type', 'Standard'], ['Position', `${r(st.x)}, ${r(st.y)} ft`],
        ['Segments', st.segments.map(x => `${r(x)} ft`).join(' + ')],
        ['Height', `${r(this.state.standardHeightFt(st))} ft`],
        ['Dead', `${Math.round(leg?.deadLb ?? 0)} lb`], ['Live', `${Math.round(leg?.liveLb ?? 0)} lb`]];
    }
    for (const [map, label] of [[this.state.ledgers, 'Ledger'], [this.state.braces, 'Brace'], [this.state.trusses, 'Truss'], [this.state.guardrails, 'Guardrail']]) {
      const m = map.get(id);
      if (m) {
        const len = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
        return [['Type', m.kind ? `${label} (${m.kind})` : label], ['Length', `${r(len)} ft`],
          ['From', `${r(m.a[0])}, ${r(m.a[1])}, ${r(m.a[2])}`], ['To', `${r(m.b[0])}, ${r(m.b[1])}, ${r(m.b[2])}`]];
      }
    }
    const p = this.state.planks.get(id);
    if (p) {
      const boards = this.state.plankBoards(p);
      return [['Type', 'Plank bay'], ['Size', `${r(p.x1 - p.x0)} x ${r(p.y1 - p.y0)} ft`],
        ['Boards', boards.length], ['Height', `${r(p.z)} ft`]];
    }
    const b = this.state.brackets.get(id);
    if (b) return [['Type', 'Side bracket'], ['Length', `${r(b.lengthFt)} ft`], ['Height', `${r(b.z)} ft`]];
    return [['Type', 'Item']];
  }

  _refreshBom() {
    const bom = deriveBom(this.state);
    this._bom = bom;
    this.$('sfw-bom-rows').innerHTML = bom.lineItems.length
      ? bom.lineItems.map(r => `<tr><td>${r.description}</td><td>${r.quantity}</td><td>${r.totalWeightLb}</td></tr>`).join('')
      : '<tr><td colspan="3" class="sfw-empty">Nothing placed yet.</td></tr>';
    this.$('sfw-bom-total').innerHTML =
      `<div><dt>Lines</dt><dd>${bom.summary.lineItemCount}</dd></div>` +
      `<div><dt>Pieces</dt><dd>${bom.summary.totalQuantity}</dd></div>` +
      `<div><dt>Weight</dt><dd>${Math.round(bom.summary.totalWeightLb)} lb</dd></div>`;
  }

  _rebuildLabels() {
    if (!this.labelGroup) return;
    this.labelGroup.clear();
    this.labelGroup.visible = this.showLegLoads;
    if (!this.showLegLoads) return;
    const { legs } = this.state.takeoff();
    for (const leg of legs) {
      const s = this.state.standards.get(leg.id);
      if (!s) continue;
      const sp = labelSprite(`${Math.round(leg.deadLb + leg.liveLb)} lb`);
      sp.position.set(s.x, s.y, this.state.standardTopZ(s) + 1.1);
      this.labelGroup.add(sp);
    }
  }

  // Rosette connection nodes: drawn procedurally on every standard so ledgers,
  // horizontals and braces always have real points to connect to.
  _rebuildNodes() {
    this.nodeGroup.clear();
    const connectTool = ['ledger', 'brace', 'plank'].includes(this.tools?.tool);
    for (const n of this.state.nodes()) {
      const m = rosetteDisk(n.x, n.y, n.z, connectTool ? this.nodeActiveMat : MATERIALS.hardware);
      m.userData = { node: n };
      this.nodeGroup.add(m);
    }
  }

  _updateCounts() {
    const s = this.state;
    this.$('sfw-counts').innerHTML =
      `<span>${s.standards.size} std</span><span>${s.ledgers.size} ldg</span><span>${s.braces.size} brc</span>` +
      `<span>${s.planks.size} plk</span><span>${s.trusses.size} trs</span><span>${s.guardrails.size} rail</span>`;
  }

  _beamSpan() { return window.scafmetric?.getBeamSpanFt?.() || 20; }

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
    this.beamGroup.clear();
    const { draw, span } = this._currentBeam();
    this.beamGroup.add(tubeBetween(draw.a, draw.b, 4, this.beamMat));
    this.$('sfw-span').textContent = `${round(span, 3)} ft`;
    this._refreshTakeoff();
  }

  _legsForImport() {
    const { legs } = this.state.takeoff();
    const byId = new Map(legs.map(l => [l.id, l]));
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
      : '<tr><td colspan="4" class="sfw-empty">No legs selected — use Select legs on beam.</td></tr>';
    const { imported, skipped } = toBeamPointLoads(located);
    this._importable = imported;
    const dead = imported.reduce((s, e) => s + e.deadLb, 0), live = imported.reduce((s, e) => s + e.liveLb, 0);
    this.$('sfw-totals').innerHTML = `<div><dt>Legs</dt><dd>${imported.length}</dd></div><div><dt>ΣDead</dt><dd>${round(dead, 0)} lb</dd></div><div><dt>ΣLive</dt><dd>${round(live, 0)} lb</dd></div>`;
    const warn = this.$('sfw-warn');
    if (skipped.length) { warn.hidden = false; warn.textContent = `${skipped.length} selected leg(s) off the beam line or past the span — excluded.`; }
    else warn.hidden = true;
    this.$('sfw-import').disabled = imported.length === 0;
  }

  /** Move/copy: pick an anchor, then a destination, and shift the selected stacks. */
  _beginTransform(copy) {
    const ids = this.selection.filter(id => this.state.standards.has(id));
    if (!ids.length) {
      this.$('sfw-hint').textContent = 'Select one or more standards first (drag a marquee).';
      return;
    }
    this._transform = { ids, copy, anchor: null };
    this.$('sfw-hint').textContent = `${copy ? 'Copy' : 'Move'}: click the anchor point, then the destination. Esc cancels.`;
    this.tools.setTool('select');
    this.tools.transformHook = pt => this._transformClick(pt);
  }

  _transformClick(pt) {
    const t = this._transform;
    if (!t) return false;
    if (!t.anchor) {
      t.anchor = pt;
      this.$('sfw-hint').textContent = 'Now click the destination.';
      return true;
    }
    const dx = pt.x - t.anchor.x, dy = pt.y - t.anchor.y;
    const ids = this.state.transformStacks(t.ids, dx, dy, t.copy);
    this.selection = ids;
    this._transform = null;
    this.tools.transformHook = null;
    this._rebuildContent();
    this._refreshProps();
    this.$('sfw-hint').textContent = `${ids.length} stack(s) ${t.copy ? 'copied' : 'moved'}.`;
    return true;
  }

  _saveView() {
    const cam = this.engine.camera;
    const tgt = this.engine.controls.target;
    this._views = this._views || [];
    this._views.push({
      name: `View ${this._views.length + 1}`,
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: [tgt.x, tgt.y, tgt.z],
      projection: this.engine.projection,
      zoom: cam.zoom ?? 1,
    });
    this._renderViews();
  }

  _renderViews() {
    const el = this.$('sfw-views');
    if (!el) return;
    const views = this._views || [];
    el.innerHTML = views.length
      ? views.map((v, i) => `<div class="sfw-view-row"><button type="button" data-view-go="${i}">${v.name}</button><button type="button" class="sfw-view-x" data-view-del="${i}" aria-label="Delete ${v.name}">×</button></div>`).join('')
      : '<p class="sfw-note">No saved views yet.</p>';
    for (const b of el.querySelectorAll('[data-view-go]')) {
      b.addEventListener('click', () => this._applyView(views[Number(b.dataset.viewGo)]));
    }
    for (const b of el.querySelectorAll('[data-view-del]')) {
      b.addEventListener('click', () => { this._views.splice(Number(b.dataset.viewDel), 1); this._renderViews(); });
    }
  }

  _applyView(v) {
    if (!v) return;
    this.engine.setProjection(v.projection);
    this.engine.controls.target.set(v.target[0], v.target[1], v.target[2]);
    this.engine.camera.position.set(v.position[0], v.position[1], v.position[2]);
    if (this.engine.camera.isOrthographicCamera) {
      this.engine.camera.zoom = v.zoom || 1;
      this.engine.camera.updateProjectionMatrix();
    }
    this.engine.controls.update();
  }

  _downloadDxf() {
    const dxf = exportScaffoldDxf(this.state);
    const blob = new Blob([dxf], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scaffold-centerlines.dxf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _downloadBom() {
    if (!this._bom) return;
    const blob = new Blob([bomToCsv(this._bom)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scaffold-bom.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _import() {
    if (!window.scafmetric?.importScaffoldLoads) {
      this.$('sfw-warn').hidden = false;
      this.$('sfw-warn').textContent = 'Beam workspace not ready.';
      return;
    }
    const n = window.scafmetric.importScaffoldLoads(this._importable.map(e => ({ legId: e.legId, deadLb: e.deadLb, liveLb: e.liveLb, locationFt: e.locationFt })));
    this.close();
    window.dispatchEvent(new CustomEvent('scafmetric:loads-imported', { detail: { count: n } }));
  }
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

const root = document.getElementById('scaffold-modal');
if (root) {
  const ws = new Workspace(root);
  for (const btn of document.querySelectorAll('[data-open-scaffold]')) btn.addEventListener('click', () => ws.open());
  window.addEventListener('scafmetric:loads-imported', e => {
    const n = e.detail?.count ?? 0;
    for (const btn of document.querySelectorAll('[data-open-scaffold]')) btn.dataset.imported = String(n);
  });
}
