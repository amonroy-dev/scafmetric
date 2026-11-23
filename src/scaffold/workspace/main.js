// Scaffold workspace entry (bundled to dist/scaffold-app.js).

import * as THREE from 'three';
import { Engine } from './engine.js';
import { ViewCube } from './viewcube.js';
import { Tools, TOOLS } from './tools.js';
import { DEFAULT_BAY_LIVE_LOAD_PSF } from './liveloads.js';
import { workspaceSupported } from './viewport.js';
import { BRACE_DELTA_LIFT } from './braces.js';
import { ScaffoldState, stateBounds } from './state.js';
import {
  MATERIALS, verticalTube, tubeBetween, buildBaseAssembly,
  STANDARD_TUBE_OD_IN, rosetteDisk, plankBoard, PLANK_MATERIAL, liveLoadPatch, nodePickProxy, tubePickProxy, NODE_MATERIALS } from './parts.js';
import { CATALOG, CATEGORIES, DEFAULT_PART, CATEGORY_TOOL, getPart } from './catalog.js';
import { BLOCK_DEFAULTS } from './planning.js';
import { DEFAULT_COMPONENTS, DEFAULT_LIVE_LOAD_PSF } from '../catalog.js';
import { beamFromSupports, mapLegsToBeam, toBeamPointLoads } from '../legloads.js';
import { deriveBom, bomToCsv, TRUSS_FAMILY_LABEL } from './bom.js';
import { KEYS, RETENTION_NOTICE, save as saveWip, load as loadWip, purgeExpired, debounce, formatSavedAt, loadServerWorkspace, saveServerWorkspace, pickNewer } from '../store.js';
import { buildSideBracket, buildTruss, GUARDRAIL_OD_IN } from './parts.js';
import { exportScaffoldDxf, buildCenterlineModel, LAYERS } from './dxf.js';
import { instanceMeshes, mergeLineSegments, clearGroup } from './instancing.js';

// Line icons, 20px grid, drawn in currentColor.
const svg = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  select: svg('<path d="M5 3.5l10 6.2-4.4 1.2-2.3 4.3L5 3.5z"/>'),
  standard: svg('<path d="M10 3v12.5M6.5 16.5h7M8.2 3h3.6M7.8 8h4.4M7.8 12h4.4"/>'),
  block: svg('<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M3.5 10h13M10 3.5v13"/>'),
  ledger: svg('<path d="M5 10h10"/><circle cx="3.6" cy="10" r="1.4"/><circle cx="16.4" cy="10" r="1.4"/>'),
  brace: svg('<path d="M4 3.5v13M16 3.5v13M4 15L16 5"/>'),
  truss: svg('<path d="M3 14.5h14M4 6h12M4 6l3 8.5L10 6l3 8.5L16 6"/>'),
  bracket: svg('<path d="M5 3v14M5 6h10M5 11.5L15 6"/>'),
  plank: svg('<rect x="2.5" y="7.5" width="15" height="5" rx="1"/><path d="M7.5 7.5v5M12.5 7.5v5"/>'),
  liveload: svg('<path d="M3 16h14M6.5 4v7.5M4.5 9.5l2 2 2-2M13.5 4v7.5M11.5 9.5l2 2 2-2"/>'),
  erase: svg('<path d="M7.5 16.5h9M3.9 12.3l6.9-6.9a1.4 1.4 0 012 0l2.8 2.8a1.4 1.4 0 010 2l-6.1 6.1H7.4l-3.5-3.5a.4.4 0 010-.5zM8.3 9.1l4.3 4.3"/>'),
  // Undo2 / Redo2 from lucide, as ScaffoldPro's toolbar uses them.
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/></svg>',
  close: svg('<path d="M5 5l10 10M15 5L5 15"/>'),
  monitor: svg('<rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 16.5h6M10 13.5v3"/>'),
};

const TOOL_META = {
  select: { label: 'Select', icon: ICONS.select, hint: 'Click to select, Shift+click to add. Drag left to right for a window, right to left for a crossing; Ctrl+drag adds. Delete removes.' },
  block: { label: 'Block', icon: ICONS.block, hint: 'Set the block in the card, then click the grid to place it. It snaps onto the standards beside it. R turns it 90°.' },
  standard: { label: 'Standard', icon: ICONS.standard, hint: 'Click the ground to set a standard. Enter a target height in the panel and one click builds the whole planned stack.' },
  ledger: { label: 'Ledger', icon: ICONS.ledger, hint: 'Click a rosette node to run a ledger to the nearest open standard. Shift+click fills every bay at that level.' },
  brace: { label: 'Brace', icon: ICONS.brace, hint: 'Hover a bay face; the height under the cursor picks the lift. R flips the direction. Shift+click braces every perimeter face at that height.' },
  truss: { label: 'Truss', icon: ICONS.truss, hint: 'Pick Light truss, Heavy truss or Truss and a length in the catalog, then click a rosette: the truss runs to the rosette its own length away. R turns it to the next one. Shift+click fills the face.' },
  bracket: { label: 'Bracket', icon: ICONS.bracket, hint: 'Hover a rosette to preview a side bracket pointing out of the scaffold, then click. R turns it to the next free direction.' },
  plank: { label: 'Plank', icon: ICONS.plank, hint: 'Click a ledger to deck the bay on that side with best-fit 9 in and 6 in boards. R turns the boards to run the other way. Shift+click decks the whole run.' },
  liveload: { label: 'Live load', icon: ICONS.liveload, hint: 'Click a ledger to load the bay on that side at the bay patch psf. R flips the side. Shift+click loads every bay along the run.' },
  erase: { label: 'Erase', icon: ICONS.erase, hint: 'Click a component to remove it.' },
};
const OFF_TOLERANCE_FT = 0.5;

// As ScaffoldPro's App.tsx: typing in a field keeps the field's own undo.
function isTextInputTarget(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

const UNSUPPORTED_TEMPLATE = `
<div class="sfw-backdrop" data-sfw-close></div>
<div class="sfw-dialog sfw-dialog--notice" role="dialog" aria-modal="true" aria-label="Scaffold builder unavailable">
  <header class="sfw-head">
    <div><h2>Scaffold builder</h2></div>
    <button type="button" class="sfw-icon-btn" data-sfw-close aria-label="Close">${ICONS.close}</button>
  </header>
  <div class="sfw-notice-body">
    <div class="sfw-notice-ico">${ICONS.monitor}</div>
    <h3>Open this on a desktop browser</h3>
    <p>The scaffold builder is a 3D modelling workspace. It needs a wide screen and a mouse or trackpad: navigation uses middle-drag to pan, SHIFT+middle-drag to orbit, the wheel to zoom, and SHIFT and R while placing.</p>
    <p class="sfw-notice-sub">For the best experience and accurate results, open Scafmetric on a laptop or desktop. Beam analysis itself works fine on this device &mdash; you can keep entering loads by hand, and your work is saved for 30 days either way.</p>
    <button type="button" class="sfw-btn primary" data-sfw-close>Back to beam analysis</button>
  </div>
</div>`;


const TEMPLATE = `
<div class="sfw-backdrop" data-sfw-close></div>
<div class="sfw-dialog" role="dialog" aria-modal="true" aria-label="Scaffold builder">
  <header class="sfw-head">
    <div>
      <h2>Scaffold builder</h2>
      <p>Model the scaffold, then send its leg loads to the beam.</p>
    </div>
    <div class="sfw-head-actions">
      <button type="button" class="sfw-icon-btn" data-sfw-close aria-label="Close">${ICONS.close}</button>
    </div>
  </header>
  <div class="sfw-body">
    <div class="sfw-toolbar" id="sfw-toolbar" role="toolbar" aria-label="Tools"></div>
    <div class="sfw-stage" id="sfw-stage">
      <div class="sfw-stagebar">
        <div class="sfw-viewbar" role="toolbar" aria-label="View">
          <button type="button" class="sfw-toggle" data-toggle="ortho" title="Orthographic projection">Orthographic</button>
          <button type="button" class="sfw-toggle" data-toggle="skeleton" title="Centerline view">Lines</button>
          <button type="button" class="sfw-toggle is-on" data-toggle="legloads" title="Show leg loads">Leg loads</button>
          <button type="button" class="sfw-toggle" data-toggle="panlock" title="Left-drag pans (for trackpads)">Pan</button>
        </div>
        <div class="sfw-history" role="toolbar" aria-label="History">
          <button type="button" class="sfw-hist-btn" data-act="undo" aria-label="Undo" title="Nothing to undo" aria-disabled="true">${ICONS.undo}</button>
          <button type="button" class="sfw-hist-btn" data-act="redo" aria-label="Redo" title="Nothing to redo" aria-disabled="true">${ICONS.redo}</button>
        </div>
      </div>
      <section class="sfw-group sfw-blockcard" id="sfw-blockcard" aria-label="Block" hidden>
        <h3>Block<button type="button" class="sfw-icon-btn" data-block-close aria-label="Close the Block tool" title="Back to Select (Esc)">${ICONS.close}</button></h3>
        <div class="sfw-grid2">
          <label>Width<span class="sfw-u"><input type="number" data-block="widthFt" min="0.5" step="any"><i>ft</i></span></label>
          <label>Depth<span class="sfw-u"><input type="number" data-block="depthFt" min="0.5" step="any"><i>ft</i></span></label>
          <label>Height<span class="sfw-u"><input type="number" data-block="heightFt" min="0.5" step="any" title="Height of the top working deck"><i>ft</i></span></label>
          <label>Planked levels<input type="number" data-block="plankedLevelsCount" min="0" max="20" step="1"></label>
        </div>
        <label class="sfw-check"><input type="checkbox" data-block="includeBaseDeck"><span>Include base deck (lift 0)</span></label>
        <label class="sfw-check"><input type="checkbox" data-block="guardrails"><span>Guardrails round every deck</span></label>
        <div class="sfw-grid2 sfw-mt">
          <label>Front/back braces<select data-block="braceFrontBack"><option value="off">Off</option><option value="slash">/</option><option value="backslash">\\</option></select></label>
          <label>Left/right braces<select data-block="braceLeftRight"><option value="off">Off</option><option value="slash">/</option><option value="backslash">\\</option></select></label>
        </div>
        <p class="sfw-note" id="sfw-block-summary"></p>
        <div class="sfw-blockcard-foot">
          <button type="button" class="sfw-btn ghost" data-block-reset>Reset</button>
          <span>Click to place · <kbd>R</kbd> rotates</span>
        </div>
      </section>
      <div class="sfw-hint" id="sfw-hint"></div>
    </div>
    <aside class="sfw-side">
      <div class="sfw-group">
        <h3>Catalog</h3>
        <label>Category<select id="sfw-cat"></select></label>
        <label class="sfw-mt">Size<select id="sfw-part"></select></label>
        <p class="sfw-note" id="sfw-partnote"></p>
      </div>
      <div class="sfw-group">
        <h3>Base</h3>
        <label>Standard target height<span class="sfw-u"><input type="number" id="sfw-stdh" min="0" step="any" value="0" placeholder="0 = single segment"><i>ft</i></span></label>
        <p class="sfw-note" id="sfw-stdh-note">0 uses the catalog size above. Any other height plans the stack for you.</p>
        <label class="sfw-mt">Screw jack extension<span class="sfw-u"><input type="number" id="sfw-jack" min="0" max="12" step="0.25" value="6"><i>in</i></span></label>
        <label class="sfw-check"><input type="checkbox" id="sfw-sill" checked><span>Wood sill</span></label>
        <label class="sfw-check"><input type="checkbox" id="sfw-collar" checked><span>Base collar</span></label>
        <dl class="sfw-counts" id="sfw-counts"></dl>
        <button type="button" class="sfw-btn ghost" id="sfw-clear">Clear all</button>
      </div>
      <div class="sfw-group">
        <h3>Loads</h3>
        <div class="sfw-grid2">
          <label>Live load<span class="sfw-u"><input type="number" id="sfw-live" min="0" step="any" value="${DEFAULT_LIVE_LOAD_PSF}"><i>psf</i></span></label>
          <label>Plank wt<span class="sfw-u"><input type="number" id="sfw-plank" min="0" step="any" value="${DEFAULT_COMPONENTS.plank.areaWeightLbPerFt2}"><i>psf</i></span></label>
        </div>
        <div class="sfw-grid2 sfw-mt">
          <label>Bay patch<span class="sfw-u"><input type="number" id="sfw-bay-psf" min="0" step="any" value="${DEFAULT_BAY_LIVE_LOAD_PSF}"><i>psf</i></span></label>
          <label>Mode<select id="sfw-live-mode"><option value="uniform">Uniform over decks</option><option value="bays">Placed bay patches</option></select></label>
        </div>
        <p class="sfw-note" id="sfw-live-note"></p>
        <button type="button" class="sfw-btn ghost" id="sfw-live-clear">Clear bay loads</button>
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
        <h3>Bracing</h3>
        <div class="sfw-grid2">
          <label>Direction<select id="sfw-brace-dir"><option value="descending">Descending</option><option value="ascending">Ascending</option></select></label>
          <label>Faces<select id="sfw-brace-filter"><option value="all">All</option><option value="front">Front</option><option value="back">Back</option><option value="left">Left</option><option value="right">Right</option></select></label>
        </div>
        <label class="sfw-mt">Every nth bay<select id="sfw-brace-nth"><option value="1">Every bay</option><option value="2">Every 2nd bay</option><option value="3">Every 3rd bay</option></select></label>
        <p class="sfw-note">Hover a bay face with the Brace tool; <strong>R</strong> flips direction, <strong>SHIFT</strong>+click fills the perimeter.</p>
      </div>
      <div class="sfw-group">
        <h3>Guardrails</h3>
        <div class="sfw-actions-row">
          <button type="button" class="sfw-btn" id="sfw-rails">Add to decks</button>
          <button type="button" class="sfw-btn ghost" id="sfw-rails-clear">Clear</button>
        </div>
      </div>
      <div class="sfw-group">
        <h3>Saved views <button type="button" class="sfw-link" id="sfw-view-save">Save current</button></h3>
        <div id="sfw-views" class="sfw-views-list"></div>
      </div>
      <div class="sfw-group">
        <h3>Bill of materials <button type="button" class="sfw-link" id="sfw-bom-csv">Export CSV</button></h3>
        <div class="sfw-table-wrap sfw-bom-wrap"><table class="sfw-table sfw-bom"><thead><tr><th>Item</th><th>Qty</th><th>Wt (lb)</th></tr></thead><tbody id="sfw-bom-rows"></tbody></table></div>
        <div class="sfw-totals" id="sfw-bom-total"></div>
        <button type="button" class="sfw-btn ghost sfw-mt" id="sfw-dxf">Export DXF centerlines</button>
      </div>
      <div class="sfw-group">
        <h3>Beam and import</h3>
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
    <p class="sfw-disclaimer">Preliminary tributary takeoff with dead and live load kept separate, using generic tubes.<br>
      <span class="sfw-keys"><kbd>Shift</kbd>+click fills a run · <kbd>Enter</kbd> confirms · <kbd>R</kbd> rotates · <kbd>Esc</kbd> Select · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Y</kbd> redo · Middle-drag pans · <kbd>Shift</kbd>+middle-drag orbits · Double middle-click fits · Wheel zooms</span><br>
      <span class="sfw-retain" id="sfw-retain"></span></p>
    <div>
      <button type="button" class="sfw-btn ghost" data-sfw-close>Cancel</button>
      <button type="button" class="sfw-btn primary" id="sfw-import" disabled>Import to beam</button>
    </div>
  </footer>
</div>`;

// Leg-load tag: a dark label with an orange load tick, legible on the light canvas.
function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  const r = 14;
  g.beginPath();
  g.moveTo(r + 2, 2); g.arcTo(254, 2, 254, 62, r); g.arcTo(254, 62, 2, 62, r); g.arcTo(2, 62, 2, 2, r); g.arcTo(2, 2, 254, 2, r);
  g.closePath();
  g.fillStyle = '#18181b'; g.fill();
  g.fillStyle = '#fb923c';
  g.fillRect(18, 22, 6, 20);
  g.fillStyle = '#ffffff';
  g.font = '600 30px Inter, "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 138, 34);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.9, 0.48, 1);
  sp.userData.ownsMaterial = true; // its texture is freed when the labels are rebuilt
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
    this._bindClose();
    document.addEventListener('keydown', e => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') {
        // Escape cancels the in-progress action and drops back to the Select
        // tool. It must never close the builder, which previously dumped the
        // user back to the beam form.
        e.preventDefault();
        this._transform = null;
        if (this.tools) {
          this.tools.transformHook = null;
          this.tools.cancelMarquee();
          this.tools.setTool('select');
          // Esc also lets go of whatever is selected, as in ScaffoldPro.
          if (this.tools.selection.size || this.selection.length) {
            this.tools.selection.clear();
            this.selection = [];
            this._rebuildContent();
            this._refreshProps();
          }
        }
        this.$('sfw-hint').textContent = `${TOOL_META.select.hint} Close with the × button; your model is saved.`;
        return;
      }
      // Undo / redo, with ScaffoldPro's rules (App.tsx): Ctrl/Cmd+Z undoes,
      // Ctrl+Y or Ctrl/Cmd+Shift+Z redoes. A held key does not repeat, a key
      // another handler already took is left alone, and typing in a field
      // keeps the field's own undo rather than undoing the model.
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      if (!isUndo && !isRedo) return;
      if (e.repeat || e.defaultPrevented || isTextInputTarget(e.target)) return;
      e.preventDefault();
      if (isUndo) this._undo(); else this._redo();
    });
  }

  _undo() {
    if (!this.state?.canUndo()) return;
    this.state.undo();
    this._afterHistoryStep();
  }

  _redo() {
    if (!this.state?.canRedo()) return;
    this.state.redo();
    this._afterHistoryStep();
  }

  // Whatever was selected or half-placed may no longer exist.
  _afterHistoryStep() {
    this.selection = [];
    if (this.tools) { this.tools.selection.clear(); this.tools.pending = null; this.tools._clearGhost(); }
    this._sync();
    this._refreshProps();
  }

  _refreshHistory() {
    const states = { undo: this.state?.canUndo(), redo: this.state?.canRedo() };
    for (const btn of this.root.querySelectorAll('[data-act]')) {
      const can = !!states[btn.dataset.act];
      btn.setAttribute('aria-disabled', String(!can));
      btn.title = btn.dataset.act === 'undo'
        ? (can ? 'Undo (Ctrl+Z)' : 'Nothing to undo')
        : (can ? 'Redo (Ctrl+Y)' : 'Nothing to redo');
    }
  }

  _bindClose() {
    for (const el of this.root.querySelectorAll('[data-sfw-close]')) {
      el.addEventListener('click', () => this.close());
    }
  }

  open() {
    // Never build the 3D workspace on a screen that cannot drive it.
    if (!workspaceSupported()) {
      this.root.innerHTML = UNSUPPORTED_TEMPLATE;
      this.root.hidden = false;
      document.body.style.overflow = 'hidden';
      this._unsupported = true;
      this._bindClose();
      return;
    }
    // Coming back from the small-screen notice (rotated to landscape, or a
    // resized window): put the real workspace markup back and re-bind it.
    if (this._unsupported) {
      this.root.innerHTML = TEMPLATE;
      this._unsupported = false;
      this._bindClose();
    }
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    this._guardBackNavigation(true);
    if (!this.engine) this._init();
    requestAnimationFrame(() => { this.engine.resize(); this._frame(); });
  }
  close() {
    this.root.hidden = true;
    document.body.style.overflow = '';
    this._guardBackNavigation(false);
  }

  /**
   * Keep a stray Back from leaving the page while the builder is open, as
   * ScaffoldPro's useBlockBrowserBackNavigation does.
   *
   * A mouse wheel pressed sideways reports as the Back button, and browsers act
   * on Back/Forward buttons below the page: preventDefault on mousedown,
   * pointerdown, mouseup or auxclick is not honoured for them
   * (w3c/pointerevents#191). So the navigation is undone rather than
   * prevented: a duplicate history entry for this same page is pushed on open,
   * a Back lands on it (same document, nothing unloads) and the duplicate is
   * pushed again for next time. Closing the builder takes the duplicate back
   * out, so Back works normally on the beam page.
   */
  _guardBackNavigation(on) {
    if (on) {
      if (this._onPopState) return;
      history.pushState({ sfwBackGuard: true }, '', location.href);
      this._onPopState = () => history.pushState({ sfwBackGuard: true }, '', location.href);
      window.addEventListener('popstate', this._onPopState);
      return;
    }
    if (!this._onPopState) return;
    window.removeEventListener('popstate', this._onPopState);
    this._onPopState = null;
    if (history.state?.sfwBackGuard) history.back();
  }

  _init() {
    const stage = this.$('sfw-stage');
    this.engine = new Engine(stage);
    this.engine.onProjectionChange = mode => {
      const btn = this.root.querySelector('[data-toggle="ortho"]');
      if (btn) btn.classList.toggle('is-on', mode === 'orthographic');
    };
    this.viewcube = new ViewCube(this.engine, 92, { onHome: () => this.engine.setView('home', { animate: true, fit: this._modelBox() }) });
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
    this.labelGroup = new THREE.Group();
    this.engine.scene.add(this.contentGroup, this.nodeGroup, this.labelGroup);
    // What navigation needs from the model: Zoom Extents fits the model box, the
    // wheel and orbit look for model surfaces under the cursor, and an orbit
    // pivot snaps to the nearest rosette.
    this.engine.navHooks = {
      modelBox: () => this._modelBox(),
      pickables: () => this.contentGroup.children,
      snapPoints: () => this.state.nodes().map(n => new THREE.Vector3(n.x, n.y, n.z)),
    };
    this.nodeActiveMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, emissive: 0x1e3a8a, emissiveIntensity: 0.5, metalness: 0.3, roughness: 0.4 });

    this.engine.raycaster.params.Line = { threshold: 0.25 };
    this.tools = new Tools(this.engine, this.state, {
      getNodeMeshes: () => this.nodeGroup.children,
      getContentMeshes: () => this.contentGroup.children,
      onSelectionChange: ids => { this.selection = ids; this._rebuildContent(); this._refreshProps(); },
      onToolChange: name => this._applyToolUi(name),
      onPreview: (tool, count, info) => this._onToolPreview(tool, count, info),
      onRotate: (tool, value) => this._onToolRotate(tool, value),
      onBulkFill: (n, tool) => {
        if (tool === 'block') {
          this.$('sfw-hint').textContent = n
            ? `Block placed: ${n} new standard${n === 1 ? '' : 's'}, with its ledgers, decks and bracing. Ctrl+Z takes it back.`
            : 'Block placed onto the standards already there, with its ledgers, decks and bracing.';
        } else {
          this.$('sfw-hint').textContent = n
            ? `Added ${n} ${tool}${n > 1 ? 's' : ''} across every bay at that level.`
            : 'Nothing to add at that level — place more standards first.';
        }
      },
    });

    this.tools.liveLoadPsf = Math.max(0, Number(this.$('sfw-bay-psf').value) || DEFAULT_BAY_LIVE_LOAD_PSF);
    this.tools.standardTargetHeightFt = Math.max(0, Number(this.$('sfw-stdh').value) || 0);
    this.tools.braceDirection = this.$('sfw-brace-dir').value;
    this.tools.braceFaceFilter = this.$('sfw-brace-filter').value;
    this.tools.braceNthBay = Math.min(3, Math.max(1, Math.floor(Number(this.$('sfw-brace-nth').value) || 1)));
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
    // A fresh builder starts empty, looking straight down, with the standard
    // tool ready to place the first leg.
    if (wip && wip.data) {
      try { this.state.restore(wip.data); } catch { this.state.clear(); }
      if (el) el.textContent = `${RETENTION_NOTICE} Restored from this device, ${formatSavedAt(wip.savedAt)}.`;
    } else if (el) {
      el.textContent = RETENTION_NOTICE;
    }
    this.engine.setView('top');
    this._restoreViews();
    // If the account holds a newer copy, take it instead.
    loadServerWorkspace().then(server => {
      if (!server?.scaffold) return;
      const winner = pickNewer(wip, server);
      if (!winner || winner.source !== 'account') return;
      try {
        this.state.restore(server.scaffold);
        this.state.resetHistory();
        this._refreshHistory();
        this._sync();
        if (el) el.textContent = `${RETENTION_NOTICE} Restored from your account, ${formatSavedAt(winner.savedAt)}.`;
      } catch { /* keep the local copy */ }
    });
    this.state.resetHistory();
    this._refreshHistory();
    this._renderViews();
    this._refreshProps();
    this._sync();
  }

  _buildToolbar() {
    const bar = this.$('sfw-toolbar');
    bar.innerHTML =
      TOOLS.map(t => `<button type="button" class="sfw-tool" data-tool="${t}" title="${TOOL_META[t].label}"><span class="sfw-tool-ico">${TOOL_META[t].icon}</span><span class="sfw-tool-lbl">${TOOL_META[t].label}</span></button>`).join('');
    for (const btn of bar.querySelectorAll('[data-tool]')) {
      btn.addEventListener('click', () => {
        this.tools.setTool(btn.dataset.tool);
        // Keep the catalog dropdown in step with the chosen tool.
        // Several categories can drive one tool (the three truss families):
        // leave the dropdown alone when it already shows one of them.
        const cat = CATEGORIES.find(c => CATEGORY_TOOL[c] === btn.dataset.tool);
        if (cat && CATEGORY_TOOL[this.$('sfw-cat').value] !== btn.dataset.tool) { this.$('sfw-cat').value = cat; this._onCategoryChange(false); }
      });
    }
    // View toggles sit on the canvas and undo/redo in the header.
    for (const btn of this.root.querySelectorAll('[data-toggle]')) {
      btn.addEventListener('click', () => this._toggle(btn.dataset.toggle, btn));
    }
    for (const btn of this.root.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'undo') this._undo(); else this._redo();
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
    // The block card comes up with the Block tool, as ScaffoldPro's does.
    const card = this.$('sfw-blockcard');
    if (card) {
      card.hidden = name !== 'block';
      if (!card.hidden) this._fillBlockCard();
    }
    this._rebuildNodes();
  }

  // --- the block card ---------------------------------------------------------
  // ScaffoldPro's block settings: dimensions, the top deck height, planked
  // levels, a base deck, and full-height bracing per pair of faces.

  _bindBlockCard() {
    const card = this.$('sfw-blockcard');
    if (!card) return;
    for (const el of card.querySelectorAll('[data-block]')) {
      const key = el.dataset.block;
      const read = () => {
        if (el.type === 'checkbox') return el.checked;
        if (el.tagName === 'SELECT') return el.value;
        const v = Number(el.value);
        if (!Number.isFinite(v)) return null;
        if (key === 'plankedLevelsCount') return Math.min(20, Math.max(0, Math.round(v)));
        return v >= 0.5 ? v : null;
      };
      const apply = () => {
        const v = read();
        if (v === null) return;
        this.tools.setBlockSettings({ [key]: v });
        this._updateBlockSummary();
      };
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', apply);
      // On leaving a field, put back the value actually in force.
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('change', () => this._fillBlockCard());
    }
    card.querySelector('[data-block-reset]').addEventListener('click', () => {
      this.tools.setBlockSettings({ ...BLOCK_DEFAULTS });
      this._fillBlockCard();
    });
    card.querySelector('[data-block-close]').addEventListener('click', () => this.tools.setTool('select'));
    // Typing in the card must not reach the canvas shortcuts (R, Delete...).
    card.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });
  }

  _fillBlockCard() {
    const card = this.$('sfw-blockcard');
    const s = this.tools.blockSettings;
    for (const el of card.querySelectorAll('[data-block]')) {
      const v = s[el.dataset.block];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    }
    this._updateBlockSummary();
  }

  /** What the recipe works out to, so Height reads as the deck it is. */
  _updateBlockSummary() {
    const el = this.$('sfw-block-summary');
    if (!el) return;
    const plan = this.tools._blockPlan();
    const ft = v => `${round(v, 2)} ft`;
    const decks = plan.deckLifts.map(l => ft(this.state.liftZ(l)));
    const standardFt = plan.segments.reduce((a, b) => a + b, 0);
    const brace = v => ({ off: 'off', slash: '/', backslash: '\\' }[v] || 'off');
    const wanted = Math.round(Number(this.tools.blockSettings.plankedLevelsCount) || 0);
    el.innerHTML =
      `${ft(plan.widthFt)} × ${ft(plan.depthFt)} · ${plan.layoutX.bays} × ${plan.layoutY.bays} bay${plan.layoutX.bays * plan.layoutY.bays === 1 ? '' : 's'}<br>` +
      (decks.length ? `Deck${decks.length === 1 ? '' : 's'} at <strong>${decks.join(', ')}</strong>` : '<strong>No deck fits under that height</strong>') +
      ` · standards ${ft(standardFt)}` +
      // Height caps the planked levels; say so rather than quietly placing fewer.
      (decks.length && decks.length < wanted ? `<br><strong>Only ${decks.length} of ${wanted} planked levels fit under ${ft(plan.heightFt)}.</strong> Raise Height for more: decks go every ${round(this.state.liftZ(8) - this.state.liftZ(4), 2)} ft.` : '') +
      `<br>Braces: front/back ${brace(this.tools.blockSettings.braceFrontBack)} · left/right ${brace(this.tools.blockSettings.braceLeftRight)}` +
      `<br>Guardrails: ${this.tools.blockSettings.guardrails && decks.length ? 'two rails round each deck' : 'off'}`;
  }

  _bindInputs() {
    this._bindBlockCard();
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
    this.$('sfw-stdh').addEventListener('input', e => {
      this.tools.standardTargetHeightFt = Math.max(0, Number(e.target.value) || 0);
      this._updateStandardPlanNote();
    });
    this.$('sfw-brace-dir').addEventListener('change', e => { this.tools.braceDirection = e.target.value; });
    this.$('sfw-brace-filter').addEventListener('change', e => { this.tools.braceFaceFilter = e.target.value; });
    this.$('sfw-brace-nth').addEventListener('change', e => {
      // The source offers 1, 2 or 3 only.
      this.tools.braceNthBay = Math.min(3, Math.max(1, Math.floor(Number(e.target.value) || 1)));
    });
    this.$('sfw-bay-psf').addEventListener('input', e => {
      this.tools.liveLoadPsf = Math.max(0, Number(e.target.value) || 0);
      // Retag any selected patches so the field doubles as an editor.
      const changed = this.state.batch(() => {
        let n = 0;
        for (const id of this.selection) {
          if (this.state.setLiveLoadPsf(id, this.tools.liveLoadPsf)) n++;
        }
        return n;
      });
      if (changed) this._refreshProps();
      this._updateLiveLoadNote();
    });
    this.$('sfw-live-mode').addEventListener('change', e => {
      this.state.setLiveLoadMode(e.target.value);
      this._sync();
    });
    this.$('sfw-live-clear').addEventListener('click', () => {
      this.state.clearLiveLoads();
      this.$('sfw-hint').textContent = 'Bay live loads cleared; back to the uniform psf over every deck.';
    });
  }

  /** Spell out the stack a typed target height will build. */
  _updateStandardPlanNote() {
    const el = this.$('sfw-stdh-note');
    if (!el) return;
    const target = this.tools.standardTargetHeightFt || 0;
    if (!target) {
      el.textContent = '0 uses the catalog size above. Any other height plans the stack for you.';
      return;
    }
    const plan = this.tools.standardStackPlan();
    if (!plan.length) { el.textContent = 'No catalog segments available to plan a stack.'; return; }
    const total = plan.reduce((a, b) => a + b, 0);
    const counts = new Map();
    for (const len of plan) counts.set(len, (counts.get(len) || 0) + 1);
    const parts = [...counts].sort((a, b) => b[0] - a[0]).map(([len, n]) => `${n} x ${round(len, 3)} ft`);
    const shortBy = target - total;
    el.textContent = `${parts.join(' + ')} = ${round(total, 3)} ft` +
      (Math.abs(shortBy) > 1e-6 ? ` (${shortBy > 0 ? 'short of' : 'over'} ${round(Math.abs(shortBy), 3)} ft — catalog sizes do not sum exactly)` : ' (exact)');
  }

  /** Live readout for whatever the hovered tool is about to place. */
  _onToolPreview(tool, count, info = {}) {
    const hint = this.$('sfw-hint');
    if (!hint) return;
    if (tool === 'brace') {
      if (!count) {
        hint.textContent = BRACE_MISS_HINT[info.reason] || BRACE_MISS_HINT['no-face'];
        return;
      }
      const dir = info.direction === 'descending' ? 'descending' : 'ascending';
      hint.textContent = info.batch
        ? `SHIFT: brace ${count} perimeter face${count === 1 ? '' : 's'} (${dir}, ${info.filter}, every ${info.nthBay} bay) — click or press Enter.`
        : `Click to brace this face, ${dir}. R flips direction. SHIFT fills the perimeter.`;
      return;
    }
    if (tool === 'plank') {
      if (!count) return;
      hint.textContent = info.batch
        ? `SHIFT: deck ${count} bay${count === 1 ? '' : 's'} along this run — click or press Enter.`
        : `Click to deck this bay${info.crossed ? ', boards turned with R' : ''}. R turns the boards; SHIFT decks the whole run.`;
      return;
    }
    if (tool === 'block') {
      const deck = info.deckZ === null ? 'no deck fits under that height' : `deck at ${round(info.deckZ, 2)} ft`;
      hint.textContent = `Click to place the ${round(info.widthFt, 2)} × ${round(info.depthFt, 2)} ft block, ${deck}` +
        `${info.rotation ? `, turned ${info.rotation}°` : ''}.` +
        (info.snapped ? ' Snapped onto the standards beside it.' : ' R turns it.');
      return;
    }
    if (tool === 'truss') {
      const name = (TRUSS_FAMILY_LABEL[info.family] || 'Truss').toLowerCase();
      if (!count) { hint.textContent = `No rosette is ${round(info.lengthFt, 2)} ft away along a run at this lift. Pick another length, or another rosette.`; return; }
      hint.textContent = info.batch
        ? `SHIFT: ${count} ${name}${count === 1 ? '' : 'es'} along this face — click or press Enter.`
        : `Click to place the ${round(info.lengthFt, 2)} ft ${name}.${info.choices > 1 ? ' R turns it to the next rosette.' : ''} SHIFT fills the face.`;
      return;
    }
    if (tool === 'bracket') {
      hint.textContent = info.dir
        ? `Click to hang the bracket pointing ${compassOf(info.dir)}. R turns it to the next free direction.`
        : 'Every direction on this rosette is taken by a ledger or another bracket.';
      return;
    }
    if (tool === 'liveload') {
      if (!count) return;
      hint.textContent = info.batch
        ? `SHIFT: load ${count} bay${count === 1 ? '' : 's'} along this run at ${info.psf} psf — click or press Enter.`
        : `Click to load this bay at ${info.psf} psf${info.flipped ? ' (side flipped with R)' : ''}. SHIFT fills the run.`;
      return;
    }
    if (tool === 'ledger') {
      if (!info.batch) {
        hint.textContent = count
          ? 'Click to add this ledger. Hold SHIFT to preview every bay at this level.'
          : 'This node already has a ledger to each neighbour. Hold SHIFT to fill the level.';
        return;
      }
      if (!count) { hint.textContent = 'Every bay at this level already has its ledgers.'; return; }
      hint.textContent = `SHIFT: ${count} ledger${count === 1 ? '' : 's'} to fill this level — click or press Enter.`;
      return;
    }
    if (tool === 'standard' && count > 1) {
      hint.textContent = `Click to build a ${round(info.totalFt, 2)} ft stack from ${count} segments.`;
    }
  }

  /** Feedback for R. */
  _onToolRotate(tool, value) {
    const hint = this.$('sfw-hint');
    if (!hint) return;
    // The refreshed preview usually writes its own hint; these are for when it
    // has nothing to show.
    if (tool === 'block') return;
    if (tool === 'brace') {
      const sel = this.$('sfw-brace-dir');
      if (sel) sel.value = value;
      hint.textContent = `Bracing direction: ${value}.`;
      return;
    }
    if (tool === 'truss') {
      if (value === null) hint.textContent = 'Hover a rosette the truss can start from, then press R to turn it.';
      else if (value < 2) hint.textContent = 'This truss can only run one way from this rosette.';
      return;
    }
    if (tool === 'bracket') {
      if (!value) hint.textContent = 'Bracket turn stepped on. Hover a rosette to see where it points.';
      return;
    }
    if (tool === 'plank') {
      if (value === undefined) hint.textContent = 'Hover a bay, then press R to turn its boards.';
      else if (value === null) hint.textContent = 'This bay has ledgers on two sides only, so its boards can run one way only.';
      else hint.textContent = `Boards now run ${compassAxis(value)}, and stay that way until you press R again.`;
      return;
    }
    if (tool === 'liveload') {
      hint.textContent = value === 'flipped'
        ? 'Side flipped — the bay on the other side of the ledger is targeted.'
        : 'Side follows the cursor again.';
      return;
    }
    hint.textContent = 'Nothing to rotate with this tool.';
  }

  /** Explain which live load model is in force, and what it adds up to. */
  _updateLiveLoadNote() {
    const el = this.$('sfw-live-note');
    if (!el) return;
    const sel = this.$('sfw-live-mode');
    if (sel) sel.value = this.state.liveLoadMode;
    const placed = this.state.liveLoads.size;
    const patches = this.state.liveLoadPatches();
    const orphans = placed - patches.length;
    const totalLb = patches.reduce((a, x) => a + x.totalLb, 0);
    if (!placed) {
      el.textContent = `Uniform: ${this.state.liveLoadPsf} psf over every decked bay. Use the Live load tool to load bays individually instead.`;
      return;
    }
    const bits = [`${patches.length} bay patch${patches.length === 1 ? '' : 'es'} · ${Math.round(totalLb)} lb total`];
    if (orphans > 0) bits.push(`${orphans} no longer enclosed by two ledgers (ignored)`);
    bits.push(this.state.usingBayLiveLoads()
      ? 'Patches are driving live load; the uniform psf is not applied.'
      : `Uniform ${this.state.liveLoadPsf} psf is in force; switch the mode to use the patches.`);
    el.textContent = bits.join(' · ');
  }

  _modelBox() {
    const b = stateBounds(this.state);
    return b ? new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)) : null;
  }

  _frame() {
    const box = this._modelBox();
    if (box) this.engine.frame(box);
  }

  _sync() {
    if (!this.engine) return;
    this._refreshHistory();
    this._rebuildContent();
    this._rebuildNodes();
    this._updateBeam();
    this._updateCounts();
    this._refreshBom();
    this._updateLiveLoadNote();
    this._persist();
  }

  _matFor(id, fallback) {
    if (this.selection.includes(id)) return MATERIALS.selected;
    if (this.beamLegs.has(id)) return MATERIALS.selected;
    return fallback;
  }

  // The model is built as ordinary meshes, one per part, then drawn as one
  // InstancedMesh per geometry and material (see instancing.js). Picks read the
  // member back with hitData().
  _rebuildContent() {
    clearGroup(this.contentGroup);
    const meshes = [];
    if (this.skeleton) this._buildSkeleton();
    else this._buildSolids(meshes);
    this._buildLiveLoads(meshes);
    for (const m of instanceMeshes(meshes)) this.contentGroup.add(m);
    this._rebuildLabels();
    this.engine?.invalidate({ shadows: true });
  }

  _buildSolids(out) {
    const add = (m, data) => { m.userData = data; out.push(m); };
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
      for (const m of meshes) add(m, { ...m.userData, id: s.id, kind: 'base' });
      add(verticalTube(s.x, s.y, s.baseZ, s.topZ, STANDARD_TUBE_OD_IN, mat), { id: s.id, kind: 'standard' });
    }
    for (const l of g.ledgers) {
      add(tubeBetween(l.a, l.b, 1.9, this._matFor(l.id, MATERIALS.ledger)), { id: l.id, kind: 'ledger' });
      // Fat invisible hit target so the deck and live load tools can be hovered
      // without landing on the 1.9 in tube exactly. Marked as a proxy so click
      // cycling in select/erase ignores it.
      add(tubePickProxy(l.a, l.b), { id: l.id, kind: 'ledger', proxy: true });
    }
    for (const b of g.braces) {
      add(tubeBetween(b.a, b.b, 1.69, this._matFor(b.id, MATERIALS.brace)), { id: b.id, kind: 'brace' });
    }
    for (const p of g.planks) {
      const mat = this._matFor(p.id, PLANK_MATERIAL);
      for (const b of p.boards) {
        add(plankBoard(b.center, b.rotationZ, b.lengthFt, b.widthIn, mat), { id: p.id, kind: 'plank' });
      }
    }
    for (const t of g.trusses || []) {
      const mat = this._matFor(t.id, MATERIALS.ledger);
      for (const m of buildTruss(t.a, t.b, mat, t.family)) add(m, { id: t.id, kind: 'truss' });
    }
    for (const gr of g.guardrails || []) {
      const mat = this._matFor(gr.id, MATERIALS.brace);
      add(tubeBetween(gr.a, gr.b, GUARDRAIL_OD_IN, mat), { id: gr.id, kind: 'guardrail' });
    }
    for (const br of g.brackets || []) {
      const mat = this._matFor(br.id, MATERIALS.ledger);
      for (const m of buildSideBracket({ x: br.x, y: br.y, z: br.z }, br.dir, br.lengthFt, mat)) {
        add(m, { id: br.id, kind: 'bracket' });
      }
    }
  }

  // Live load patches sit above the deck, striped across the one-way span.
  _buildLiveLoads(out) {
    for (const patch of this.state.liveLoadPatches()) {
      const m = liveLoadPatch(patch, this.selection.includes(patch.id) ? MATERIALS.selected : null);
      m.userData = { id: patch.id, kind: 'liveload' };
      out.push(m);
    }
  }

  // Centerline (skeleton) view: one line per member plus joint markers, merged
  // into one LineSegments per colour. Picking still works: each segment keeps
  // its member id (hitData).
  _buildSkeleton() {
    const model = buildCenterlineModel(this.state);
    const colours = {
      [LAYERS.jack]: 0x71717a,
      [LAYERS.standard]: 0x3f3f46,
      [LAYERS.ledger]: 0x2563eb,
      [LAYERS.brace]: 0x7c3aed,
      [LAYERS.truss]: 0xb45309,
      [LAYERS.bracket]: 0x047857,
      [LAYERS.guardrail]: 0xea580c,
    };
    this._lineMats = this._lineMats || {};
    const segments = model.segments.map(seg => {
      const selected = seg.id && this.selection.includes(seg.id);
      const colour = selected ? 0x2563eb : (colours[seg.layer] ?? 0x71717a);
      const key = `${colour}`;
      if (!this._lineMats[key]) this._lineMats[key] = new THREE.LineBasicMaterial({ color: colour });
      return { start: seg.start, end: seg.end, material: this._lineMats[key], data: { id: seg.id, kind: 'line' } };
    });
    for (const lines of mergeLineSegments(segments)) this.contentGroup.add(lines);
    // Joint markers so splices and connections read clearly. Never picked.
    this._jointGeo = this._jointGeo || new THREE.SphereGeometry(0.1, 8, 6);
    this._jointMat = this._jointMat || new THREE.MeshBasicMaterial({ color: 0x18181b });
    const joints = model.points.map(p => {
      const m = new THREE.Mesh(this._jointGeo, this._jointMat);
      m.position.set(p[0], p[1], p[2]);
      return m;
    });
    for (const m of instanceMeshes(joints)) {
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
    const ll = this.state.liveLoads.get(id);
    if (ll) {
      const field = this.$('sfw-bay-psf');
      if (field) field.value = ll.psf;
      this.tools.liveLoadPsf = ll.psf;
    }
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
    if (this.state.liveLoads.has(id)) return 'live load';
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
        const type = map === this.state.trusses ? (TRUSS_FAMILY_LABEL[m.family] || 'Truss') : (m.kind ? `${label} (${m.kind})` : label);
        return [['Type', type], ['Length', `${r(len)} ft`],
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
    const ll = this.state.liveLoads.get(id);
    if (ll) {
      const patch = this.state.liveLoadPatches().find(x => x.id === id);
      if (!patch) return [['Type', 'Live load'], ['Status', 'bay no longer closed'], ['Magnitude', `${r(ll.psf)} psf`]];
      return [['Type', 'Live load patch'],
        ['Magnitude', `${r(patch.psf)} psf`],
        ['Bay', `${r(patch.widthFt)} x ${r(patch.lengthFt)} ft`],
        ['Area', `${r(patch.areaSqFt)} sq ft`],
        ['Total', `${Math.round(patch.totalLb)} lb`],
        ['Height', `${r(patch.center[2])} ft`]];
    }
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
    clearGroup(this.labelGroup);
    this.labelGroup.visible = this.showLegLoads;
    this.engine?.invalidate();
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
    clearGroup(this.nodeGroup);
    const tool = this.tools?.tool;
    // Only the tools that start from a node light them up. Decks, braces and
    // load patches work off ledgers and faces, so they leave nodes neutral.
    const nodeTool = tool === 'ledger' || tool === 'truss' || tool === 'bracket';
    const validFor = this._nodeValidator(tool);
    const meshes = [];
    for (const n of this.state.nodes()) {
      const ok = nodeTool ? validFor(n) : false;
      const mat = nodeTool ? (ok ? NODE_MATERIALS.valid : NODE_MATERIALS.invalid) : MATERIALS.hardware;
      const disc = rosetteDisk(n.x, n.y, n.z, mat);
      disc.userData = { node: n };
      meshes.push(disc);
      // Forgiving hit target: a thin disc seen edge on is nearly unclickable.
      const proxy = nodePickProxy(n.x, n.y, n.z);
      proxy.userData = { node: n };
      meshes.push(proxy);
    }
    for (const m of instanceMeshes(meshes)) this.nodeGroup.add(m);
    this.engine?.invalidate({ shadows: true });
  }

  /** Can the active tool start a placement from this node? */
  _nodeValidator(tool) {
    if (tool === 'ledger') return n => this.tools.ledgerTargetFor(n) !== null;
    // A rosette takes a truss when another sits the truss's own length away along a run.
    if (tool === 'truss') return n => this.tools._trussCandidates(n).length > 0;
    // A rosette takes a bracket when it is on a standard (not another bracket's
    // tip) and has a direction no ledger or bracket already takes.
    if (tool === 'bracket') return n => this.tools._bracketDir(n) !== null;
    return () => false;
  }

  _updateCounts() {
    const s = this.state;
    const rows = [
      ['Standards', s.standards.size], ['Ledgers', s.ledgers.size], ['Braces', s.braces.size],
      ['Decks', s.planks.size + s.plankPlacements.size], ['Trusses', s.trusses.size], ['Guardrails', s.guardrails.size],
    ];
    if (s.liveLoads.size) rows.push(['Load patches', s.liveLoads.size]);
    this.$('sfw-counts').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
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

  // The beam line is not drawn in the model; it only locates legs for import.
  _updateBeam() {
    if (!this.engine) return;
    const { span } = this._currentBeam();
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
    this.$('sfw-totals').innerHTML = `<div><dt>Legs</dt><dd>${imported.length}</dd></div><div><dt>Dead</dt><dd>${round(dead, 0)} lb</dd></div><div><dt>Live</dt><dd>${round(live, 0)} lb</dd></div>`;
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
    this._persistViews();
  }

  _persistViews() { saveWip(KEYS.views, this._views || []); }

  _restoreViews() {
    const saved = loadWip(KEYS.views);
    this._views = Array.isArray(saved?.data) ? saved.data.filter(v => v && v.position && v.target) : [];
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
      b.addEventListener('click', () => { this._views.splice(Number(b.dataset.viewDel), 1); this._renderViews(); this._persistViews(); });
    }
  }

  _applyView(v) {
    if (!v) return;
    this.engine.cancelTransition();
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

// Why a brace hover came up empty. The short-stack case is the one that used to
// fail silently: a diagonal spans BRACE_DELTA_LIFT rosette levels, so both
// standards need one more level than that.
const BRACE_MISS_HINT = {
  'no-face': 'No braceable face under the cursor — hover the side of a bay, between two standards.',
  'too-short': `No diagonal fits there — a brace climbs ${BRACE_DELTA_LIFT} rosette levels, so both standards need ${BRACE_DELTA_LIFT + 1}, counting the base collar's. These have fewer: set a standard target height and click the stack again to build it taller.`,
  'already-braced': 'Every lift on that face is already braced — hover a different bay or press R to brace the other way.',
};

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

// Plan directions in words, for the hints. +Y is back, -Y front, as the
// ViewCube labels them.
function compassOf([dx, dy]) {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  const names = [[0, 'right (+X)'], [90, 'back (+Y)'], [180, 'left (−X)'], [-180, 'left (−X)'], [-90, 'front (−Y)']];
  const hit = names.find(([deg]) => Math.abs(a - deg) < 1);
  return hit ? hit[1] : `${Math.round(a)}°`;
}
function compassAxis(angle) {
  const deg = Math.round((angle * 180) / Math.PI) % 180;
  if (deg === 0) return 'left to right (along X)';
  if (deg === 90) return 'front to back (along Y)';
  return `at ${deg}°`;
}

const root = document.getElementById('scaffold-modal');
if (root) {
  const ws = new Workspace(root);
  // Handle for the headless WebGL harness (scripts/visual-check.mjs) and for
  // debugging a live page from the console. Read-only as far as the app cares.
  window.scaffoldWorkspace = ws;
  for (const btn of document.querySelectorAll('[data-open-scaffold]')) btn.addEventListener('click', () => ws.open());
  window.addEventListener('scafmetric:loads-imported', e => {
    const n = e.detail?.count ?? 0;
    for (const btn of document.querySelectorAll('[data-open-scaffold]')) btn.dataset.imported = String(n);
  });
}
