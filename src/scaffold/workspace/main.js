// Scaffold workspace entry (bundled to dist/scaffold-app.js).

import * as THREE from 'three';
import { Engine } from './engine.js';
import { ViewCube } from './viewcube.js';
import { Tools, TOOLS } from './tools.js';
import { DEFAULT_BAY_LIVE_LOAD_PSF } from './liveloads.js';
import { workspaceSupported } from './viewport.js';
import { BRACE_DELTA_LIFT } from './braces.js';
import { ScaffoldState, stateBounds, OVERTURNING_FACTOR } from './state.js';
import {
  MATERIALS, verticalTube, tubeBetween, buildBaseAssembly,
  STANDARD_TUBE_OD_IN, rosetteDisk, plankBoard, PLANK_MATERIAL, liveLoadPatch, liveLoadArrows, nodePickProxy, tubePickProxy, NODE_MATERIALS } from './parts.js';
import { CATALOG, CATEGORIES, DEFAULT_PART, CATEGORY_TOOL } from './catalog.js';
import { BLOCK_DEFAULTS } from './planning.js';
import { beamUnderPickedLegs, toBeamPointLoads, forBeamForm, wholePoundsOnLeg, loadOnBeamFromLeg } from '../legloads.js';
import { deriveBom, bomToCsv, TRUSS_FAMILY_LABEL } from './bom.js';
import { KEYS, RETENTION_NOTICE, save as saveWip, load as loadWip, purgeExpired, debounce, formatSavedAt, loadServerWorkspace, saveServerWorkspace, pickNewer } from '../store.js';
import { buildSideBracket, buildTruss, GUARDRAIL_OD_IN, SHARED_GEO, sideBracketTip } from './parts.js';
import { exportScaffoldDxf, buildCenterlineModel, LAYERS } from './dxf.js';
import { instanceMeshes, mergeLineSegments, clearGroup } from './instancing.js';
import { createUseNotice } from './usenotice.js';

// Line icons, 20px grid, drawn in currentColor.
const svg = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  beam: svg('<path d="M3 13.5h14M3 16.5h14M10 13.5v3M10 3v7M7.5 7.5L10 10l2.5-2.5"/>'),
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
  fold: svg('<path d="M5 8l5 5 5-5"/>'),
  close: svg('<path d="M5 5l10 10M15 5L5 15"/>'),
  monitor: svg('<rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 16.5h6M10 13.5v3"/>'),
};

const TOOL_META = {
  select: { label: 'Select', icon: ICONS.select, hint: 'Click to select, Shift+click to add. Drag left to right for a window, right to left for a crossing; Ctrl+drag adds. Delete removes.' },
  block: { label: 'Block', icon: ICONS.block, hint: 'Set the block in the card, then click the grid to place it. It snaps onto the standards beside it. R turns it 90°.' },
  standard: { label: 'Standard', icon: ICONS.standard, hint: 'Click the ground to set a standard. Enter a target height in the panel and one click builds the whole planned stack.' },
  ledger: { label: 'Ledger', icon: ICONS.ledger, hint: 'Click a rosette node to run a ledger to the nearest open standard. Shift+click fills every bay at that level.' },
  brace: { label: 'Brace', icon: ICONS.brace, hint: 'Hover a bay face; the height under the cursor picks the lift. R flips the direction. Shift+click braces every perimeter face at that height.' },
  truss: { label: 'Truss', icon: ICONS.truss, hint: 'Pick Light truss, Heavy truss or Truss and a size in the panel, then click a rosette: the truss runs to the rosette its own length away. R turns it to the next one. Shift+click fills the face.' },
  bracket: { label: 'Bracket', icon: ICONS.bracket, hint: 'Hover a rosette to preview a side bracket pointing out of the scaffold, then click. R turns it to the next free direction.' },
  plank: { label: 'Plank', icon: ICONS.plank, hint: 'Click a ledger to deck the bay on that side with best-fit 9 in and 6 in boards. R turns the boards to run the other way. Shift+click decks the whole run.' },
  liveload: { label: 'Live load', icon: ICONS.liveload, hint: 'Click a planked bay to load it. The load runs along the planks; R turns it across them. Shift+click loads the whole platform.' },
  erase: { label: 'Erase', icon: ICONS.erase, hint: 'Click a component to remove it.' },
  // Not in the run of placing tools (TOOLS): its button stands apart at the foot of the bar.
  beam: { label: 'Send to beam', icon: ICONS.beam, hint: 'Click the legs that sit on the beam.' },
};
const OFF_TOLERANCE_FT = 0.5;

// Send to beam, as drawn. The beam is a flat bar on the ground under the legs
// picked for it, drawn over the model (no depth test) so that it shows from
// above, through the decks. A picked leg the beam cannot take is the warning
// colour.
const BEAM_BAR = new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false });
const BEAM_BAR_WIDTH_FT = 0.5;
const BEAM_BAR_Z_FT = 0.02;
const BEAM_END_TICK_FT = { along: 0.2, across: 1.6 };
// The left support's tag stands this far out past the end, clear of the first leg's own tag.
const BEAM_TAG_OUT_FT = 2.1;
const BEAM_LEG_OUT = new THREE.MeshStandardMaterial({ color: 0xc2410c, emissive: 0x9a3412, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.4 });
// Leg-load tags: dark as a rule; blue and numbered on the beam; the warning
// colour for a picked leg left off it; red for a leg in uplift.
const TAG_LEG = { fill: '#18181b', tick: '#fb923c' };
const TAG_ON_BEAM = { fill: '#2563eb', tick: '#ffffff' };
const TAG_LEFT_OUT = { fill: '#c2410c', tick: '#ffffff' };
const TAG_UPLIFT = { fill: '#b91c1c', tick: '#ffffff' };
const TAG_BEAM_END = { fill: '#2563eb', tick: null };
// What a leg needs against overturning is not a load on it, and must not be
// read as one: its tag is outlined, not filled, and sits over the load.
const TAG_HOLD_DOWN = { fill: '#ffffff', ink: '#b91c1c', edge: '#b91c1c', tick: null, wide: true };
// Where that second tag sits: one tag's height above the first, on the screen,
// so the two read as a pair from overhead as well as from the side, and the
// tags of the legs in front do not cover it.
const TAG_SECOND_ROW = -0.6;

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
          <button type="button" class="sfw-toggle is-on" data-toggle="legloads" title="Show leg loads">Leg loads</button>
          
        </div>
        <div class="sfw-history" role="toolbar" aria-label="History">
          <button type="button" class="sfw-hist-btn" data-act="undo" aria-label="Undo" title="Nothing to undo" aria-disabled="true">${ICONS.undo}</button>
          <button type="button" class="sfw-hist-btn" data-act="redo" aria-label="Redo" title="Nothing to redo" aria-disabled="true">${ICONS.redo}</button>
        </div>
      </div>
      <!-- One card beside the toolbar for whichever tool is in hand: its options
           and nothing else. Each control names its tools in data-for. A tool with
           no options (ledger, plank, erase) shows no card. -->
      <section class="sfw-group sfw-blockcard sfw-toolcard" id="sfw-toolcard" aria-label="Tool options">
        <h3><span id="sfw-tool-title">Standard</span><span class="sfw-card-btns">
          <button type="button" class="sfw-icon-btn" data-card-fold aria-label="Collapse the card" title="Collapse" aria-expanded="true">${ICONS.fold}</button>
          <button type="button" class="sfw-icon-btn" data-card-close aria-label="Hide the card" title="Hide (pick the tool again to show it)">${ICONS.close}</button></span></h3>
        <div class="sfw-toolcard-body">
          <label data-for="truss">Type<select id="sfw-cat"></select></label>
          <label data-for="standard truss bracket" class="sfw-gap">Size<select id="sfw-part"></select></label>
          <div data-for="standard">
            <label class="sfw-mt">Build to height<span class="sfw-u"><input type="number" id="sfw-stdh" min="0" step="any" value="0" placeholder="0 = one piece"><i>ft</i></span></label>
            <label class="sfw-check"><input type="checkbox" id="sfw-std-brackets"><span>On side brackets</span></label>
          </div>
          <div data-for="brace">
            <div class="sfw-grid2 sfw-mt">
              <label>Leans<select id="sfw-brace-dir"><option value="descending">Descending</option><option value="ascending">Ascending</option></select></label>
              <label>Sides<select id="sfw-brace-filter"><option value="all">All</option><option value="front">Front</option><option value="back">Back</option><option value="left">Left</option><option value="right">Right</option></select></label>
            </div>
            <label class="sfw-mt">Shift fills<select id="sfw-brace-nth"><option value="1">Every bay</option><option value="2">Every 2nd bay</option><option value="3">Every 3rd bay</option></select></label>
          </div>
          <div data-for="liveload">
            <label>Load on each bay<span class="sfw-u"><input type="number" id="sfw-bay-psf" min="0" step="any" value="${DEFAULT_BAY_LIVE_LOAD_PSF}" placeholder="${DEFAULT_BAY_LIVE_LOAD_PSF}"><i>psf</i></span></label>
            <label class="sfw-mt">Direction<select id="sfw-load-dir"><option value="along">Along the planks</option><option value="across">Across the planks</option></select></label>
          </div>
          <div data-for="select">
            <div id="sfw-props" class="sfw-props"></div>
            <div class="sfw-actions-row">
              <button type="button" class="sfw-btn ghost" id="sfw-move">Move</button>
              <button type="button" class="sfw-btn ghost" id="sfw-copy">Copy</button>
            </div>
          </div>
          <div data-for="beam">
            <div class="sfw-table-wrap"><table class="sfw-table"><thead><tr><th>Leg</th><th>From left</th><th>Dead</th><th>Live</th></tr></thead><tbody id="sfw-rows"></tbody></table></div>
            <div class="sfw-totals" id="sfw-totals"></div>
            <label class="sfw-mt">First leg from left support<span class="sfw-u"><input type="number" id="sfw-first" min="0" step="any" value="0"><i>ft</i></span></label>
            <p class="sfw-note">Beam span: <strong id="sfw-span">—</strong></p>
            <p class="sfw-warn" id="sfw-warn" hidden></p>
            <div class="sfw-actions-row sfw-beam-actions">
              <button type="button" class="sfw-btn ghost" id="sfw-unpick" title="Take every leg off the beam" disabled>Clear</button>
              <button type="button" class="sfw-btn primary" id="sfw-import" disabled>Import to beam</button>
            </div>
          </div>
          <div data-for="block" id="sfw-blockcard">
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
            <p class="sfw-note" id="sfw-block-summary" hidden></p>
            <div class="sfw-blockcard-foot">
              <button type="button" class="sfw-btn ghost" data-block-reset>Reset</button>
            </div>
                    </div>
        </div>
</section>
      <div class="sfw-hint" id="sfw-hint"></div>
    </div>
    <aside class="sfw-side">
      <details class="sfw-group sfw-fold">
        <summary>Base</summary>
        <label class="sfw-mt">Screw jack extension<span class="sfw-u"><input type="number" id="sfw-jack" min="0" max="12" step="0.25" value="6"><i>in</i></span></label>
        <label class="sfw-check"><input type="checkbox" id="sfw-sill" checked><span>Wood sill</span></label>
        <label class="sfw-check"><input type="checkbox" id="sfw-collar" checked><span>Base collar</span></label>
      </details>
      <details class="sfw-group sfw-fold">
        <summary>Guardrails</summary>
        <p class="sfw-note">Blocks come with their rails. This adds rails round every deck you placed by hand.</p>
        <div class="sfw-actions-row">
          <button type="button" class="sfw-btn" id="sfw-rails">Add to decks</button>
          <button type="button" class="sfw-btn ghost" id="sfw-rails-clear">Clear</button>
        </div>
      </details>
      <details class="sfw-group sfw-fold">
        <summary>Parts list <span class="sfw-fold-sum" id="sfw-bom-sum"></span></summary>
        <dl class="sfw-counts" id="sfw-counts"></dl>
        <div class="sfw-table-wrap sfw-bom-wrap"><table class="sfw-table sfw-bom"><thead><tr><th>Item</th><th>Qty</th><th>Wt (lb)</th></tr></thead><tbody id="sfw-bom-rows"></tbody></table></div>
        <div class="sfw-totals" id="sfw-bom-total"></div>
        <div class="sfw-actions-row">
          <button type="button" class="sfw-btn ghost" id="sfw-bom-csv">Export CSV</button>
          <button type="button" class="sfw-btn ghost" id="sfw-dxf">Export DXF</button>
        </div>
      </details>
      <details class="sfw-group sfw-fold" hidden>
        <summary>Saved views</summary>
        <button type="button" class="sfw-btn ghost" id="sfw-view-save">Save this view</button>
        <div id="sfw-views" class="sfw-views-list"></div>
      </details>
      <div class="sfw-group">
        <button type="button" class="sfw-btn ghost sfw-nomt" id="sfw-clear">Clear all</button>
      </div>
    </aside>
  </div>
</div>`;

// Leg-load tag: a dark label with an orange load tick, legible on the light
// canvas. `look` recolours it (the tags of the legs on the beam) or drops the
// tick (the tag on the beam's left support, which is not a load).
function labelSprite(text, look = TAG_LEG) {
  const c = document.createElement('canvas');
  // A tag that carries words as well as a number is a quarter longer.
  const w = look.wide ? 320 : 256;
  c.width = w; c.height = 64;
  const g = c.getContext('2d');
  const r = 14;
  g.beginPath();
  g.moveTo(r + 2, 2); g.arcTo(w - 2, 2, w - 2, 62, r); g.arcTo(w - 2, 62, 2, 62, r); g.arcTo(2, 62, 2, 2, r); g.arcTo(2, 2, w - 2, 2, r);
  g.closePath();
  g.fillStyle = look.fill; g.fill();
  if (look.edge) { g.lineWidth = 4; g.strokeStyle = look.edge; g.stroke(); }
  if (look.tick) { g.fillStyle = look.tick; g.fillRect(18, 22, 6, 20); }
  g.fillStyle = look.ink || '#ffffff';
  g.font = '600 30px Inter, "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // Squeezed rather than cut off when a number and a long load share the tag.
  if (look.tick) g.fillText(text, w / 2 + 10, 34, w - 52);
  else g.fillText(text, w / 2, 34, w - 32);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.9 * w / 256, 0.48, 1);
  sp.userData.text = text;
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
      jackExtensionIn: Number(this.$('sfw-jack').value) || 0,
      onChange: () => this._sync(),
    });

    this.contentGroup = new THREE.Group();
    this.nodeGroup = new THREE.Group();
    this.beamGroup = new THREE.Group();
    this.labelGroup = new THREE.Group();
    this.engine.scene.add(this.contentGroup, this.nodeGroup, this.beamGroup, this.labelGroup);
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
      // Send to beam: a click or a box picks legs, and a leg's load tag stands for the leg.
      getLegTags: () => (this.labelGroup.visible ? this.labelGroup.children : []),
      onLegPick: id => this._toggleBeamLeg(id),
      onLegBox: (ids, modifiers) => this._boxBeamLegs(ids, modifiers),
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
          this.$('sfw-hint').textContent = tool === 'live load'
            ? `Loaded ${n} bay${n === 1 ? '' : 's'} at ${this.tools.liveLoadPsf} psf. Ctrl+Z takes it back.`
            : tool === 'bracket'
              ? `Hung ${n} bracket${n === 1 ? '' : 's'} along the run. Ctrl+Z takes ${n === 1 ? 'it' : 'them'} back.`
            : tool === 'bracket standard'
              ? `Stood ${n} standard${n === 1 ? '' : 's'} along the row of brackets. Ctrl+Z takes ${n === 1 ? 'it' : 'them'} back.`
            : n
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
    // The Block tool is the one in hand on open: most scaffolds start as a block.
    this.tools.setTool('block');
    // Restore work in progress if it is still within the retention window.
    purgeExpired();
    const wip = loadWip(KEYS.scaffold);
    const el = this.$('sfw-retain');
    // A fresh builder starts empty, looking straight down, with the Block tool
    // ready to place the first block.
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
      const winner = pickNewer(wip, server, 'scaffold');
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
      TOOLS.map(t => `<button type="button" class="sfw-tool" data-tool="${t}" title="${TOOL_META[t].label}"><span class="sfw-tool-ico">${TOOL_META[t].icon}</span><span class="sfw-tool-lbl">${TOOL_META[t].label}</span></button>`).join('') +
      // Send to beam is a tool too, kept apart at the foot of the bar.
      `<button type="button" class="sfw-tool sfw-tool-beam" data-tool="beam" title="Send to beam"><span class="sfw-tool-ico">${ICONS.beam}</span><span class="sfw-tool-lbl">To beam</span></button>`;
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
  }
  _onPartChange() {
    const key = this.$('sfw-cat').value;
    this.tools.setCatalog(key, this.$('sfw-part').value);
  }

  _applyToolUi(name) {
    // Send to beam is a tool like the rest: in hand, a click picks a leg for the beam.
    const wasBeam = !!this._beamShown;
    this._beamShown = name === 'beam';
    // What was selected would read as picked for the beam: both are drawn blue.
    if (this._beamShown && (this.selection.length || this.tools.selection.size)) {
      this.tools.selection.clear();
      this.selection = [];
      this._refreshProps();
    }
    for (const b of this.$('sfw-toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('is-active', b.dataset.tool === name);
    // The card says how the tool works; the bubble is for what is happening now.
    this.$('sfw-hint').textContent = '';
    // The card shows only what this tool needs.
    this.$('sfw-tool-title').textContent = TOOL_META[name]?.label || '';
    for (const el of this.root.querySelectorAll('#sfw-toolcard [data-for]')) el.hidden = !el.dataset.for.split(' ').includes(name);
    // Picking a tool brings its card back if it was hidden.
    // ...unless the tool has nothing to set: an empty card is only clutter.
    // Select has a card only while something is selected.
    this.$('sfw-toolcard').hidden = name === 'select' ? !this.selection.length
      : ![...this.root.querySelectorAll('#sfw-toolcard [data-for]')].some(el => !el.hidden);
    // With the Truss tool, Type offers the three truss families and nothing else.
    for (const o of this.$('sfw-cat').options) o.hidden = CATEGORY_TOOL[o.value] !== 'truss';
    // Picking the Live load tool puts its loads back along the planks.
    this.$('sfw-load-dir').value = this.tools?.liveLoadAcross ? 'across' : 'along';
    // The block card comes up with the Block tool, as ScaffoldPro's does.
    const card = this.$('sfw-blockcard');
    if (card) {
      card.hidden = name !== 'block';
      if (!card.hidden) this._fillBlockCard();
    }
    this._rebuildNodes();
    // The beam, the blue of its legs and their numbered tags come and go with the card.
    if (wasBeam !== this._beamShown) this._beamChanged();
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
    const toolCard = this.$('sfw-toolcard');
    toolCard.querySelector('[data-card-close]').addEventListener('click', () => { toolCard.hidden = true; });
    const fold = toolCard.querySelector('[data-card-fold]');
    fold.addEventListener('click', () => {
      const folded = toolCard.classList.toggle('is-folded');
      fold.setAttribute('aria-expanded', String(!folded));
      fold.title = folded ? 'Expand' : 'Collapse';
    });
    // Typing in the card must not reach the canvas shortcuts (R, Delete...).
    // ...except Shift, R and Enter while the pointer is out on the canvas: those
    // are for the tool in hand even if a dropdown here still has the focus.
    toolCard.addEventListener('keydown', e => { if (e.key !== 'Escape' && !this.tools.claimsKey(e)) e.stopPropagation(); });
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

  /** Says something only when the block cannot be built as asked. */
  _updateBlockSummary() {
    const el = this.$('sfw-block-summary');
    if (!el) return;
    const plan = this.tools._blockPlan();
    const decks = plan.deckLifts.length;
    const wanted = Math.round(Number(this.tools.blockSettings.plankedLevelsCount) || 0);
    el.textContent = !decks && wanted ? 'No deck fits under that height.'
      : decks < wanted ? `Only ${decks} of ${wanted} planked levels fit under ${round(plan.heightFt, 2)} ft.` : '';
    el.hidden = !el.textContent;
  }

  _bindInputs() {
    this._bindBlockCard();
    this.$('sfw-jack').addEventListener('input', e => this.state.setBase({ jackExtensionIn: Math.max(0, Number(e.target.value) || 0) }));
    this.$('sfw-sill').addEventListener('change', e => this.state.setBase({ showWoodSill: e.target.checked }));
    this.$('sfw-collar').addEventListener('change', e => this.state.setBase({ showBaseCollar: e.target.checked }));
    this.$('sfw-clear').addEventListener('click', () => { this.beamLegs.clear(); this.selection = []; this.state.clear(); });
    // Moving the first leg along the beam slides the beam under the legs.
    this.$('sfw-first').addEventListener('input', () => this._beamChanged());
    this.$('sfw-unpick').addEventListener('click', () => { this.beamLegs.clear(); this._beamChanged(); });
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
    });
    this.$('sfw-std-brackets').addEventListener('change', e => {
      this.tools.setStandardsOnBrackets(e.target.checked);
      this.$('sfw-hint').textContent = e.target.checked
        ? (this.state.brackets.size ? 'Point at the rosette on the end of a side bracket.' : 'Hang a side bracket first: the standard stands in its socket.')
        : '';
      // The sockets that can take a standard light up, as rosettes do for the other tools.
      this._rebuildNodes();
    });
    this.$('sfw-brace-dir').addEventListener('change', e => { this.tools.braceDirection = e.target.value; });
    this.$('sfw-brace-filter').addEventListener('change', e => { this.tools.braceFaceFilter = e.target.value; });
    this.$('sfw-brace-nth').addEventListener('change', e => {
      // The source offers 1, 2 or 3 only.
      this.tools.braceNthBay = Math.min(3, Math.max(1, Math.floor(Number(e.target.value) || 1)));
    });
    this.$('sfw-load-dir').addEventListener('change', e => this.tools.setLiveLoadAcross(e.target.value === 'across'));
    this.$('sfw-bay-psf').addEventListener('input', e => {
      // Left empty, the field shows the default greyed out and that is the load placed.
      const typed = e.target.value.trim();
      this.tools.liveLoadPsf = typed === '' ? DEFAULT_BAY_LIVE_LOAD_PSF : Math.max(0, Number(typed) || 0);
      // Retag any selected patches so the field doubles as an editor.
      const changed = this.state.batch(() => {
        let n = 0;
        for (const id of this.selection) {
          if (this.state.setLiveLoadPsf(id, this.tools.liveLoadPsf)) n++;
        }
        return n;
      });
      if (changed) this._refreshProps();
    });
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
      if (!info.dir) { hint.textContent = 'Every direction on this rosette is taken by a ledger or another bracket.'; return; }
      if (info.batch) {
        // A run can come out shorter than it is: say so rather than trim it quietly.
        const short = count < info.walked ? ` Only ${count} of the ${info.walked} standards along it have that rosette free.` : '';
        hint.textContent = `SHIFT: ${count} bracket${count === 1 ? '' : 's'} along this run, pointing ${compassOf(info.dir)} — click or press Enter.${short}`;
        return;
      }
      hint.textContent = `Click to hang the bracket pointing ${compassOf(info.dir)}. R turns it to the next free direction. SHIFT fills the run.`;
      return;
    }
    if (tool === 'liveload') {
      if (info.miss) {
        hint.textContent = info.decks ? 'Point at a planked bay to load it.' : 'Plank a bay first: a load sits on its planks.';
        return;
      }
      const way = info.across ? 'across the planks' : 'along the planks';
      const oneWay = info.oneWayOnly ? ' This bay is held on two sides only, so its load stays along the planks.' : '';
      if (!count) {
        hint.textContent = info.batch
          ? `Every bay of this platform carries ${info.psf} psf ${way}.`
          : `This bay carries ${info.psf} psf ${way}.${oneWay || ' Type another load, or press R to turn it.'}`;
        return;
      }
      hint.textContent = info.batch
        ? `SHIFT: ${info.changing ? 'set' : 'load'} ${count} bay${count === 1 ? '' : 's'} of this platform ${info.changing ? 'to' : 'at'} ${info.psf} psf ${way} — click or press Enter.`
        : `Click to ${info.changing ? 'change this bay to' : 'load this bay at'} ${info.psf} psf ${way}.${oneWay || ' R turns the load. SHIFT takes the whole platform.'}`;
      return;
    }
    if (tool === 'beam') {
      hint.textContent = !count
        ? (this.state.standards.size ? 'Click a leg to put it on the beam. Drag a box to take several.' : 'Build the scaffold first: the beam carries its legs.')
        : this.beamLegs.has(info.id) ? 'Click to take this leg off the beam.' : 'Click to put this leg on the beam.';
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
    if (tool === 'standard' && info.onBrackets) {
      if (!count) {
        hint.textContent = info.brackets ? 'Point at the rosette on the end of a side bracket.' : 'Hang a side bracket first: the standard stands in its socket.';
        return;
      }
      if (info.batch) {
        hint.textContent = info.adding
          ? `SHIFT: another segment on ${count} standard${count === 1 ? '' : 's'} along this row of brackets — click or press Enter.`
          : `SHIFT: a standard in ${count} of the ${info.row} brackets along this row — click or press Enter.`;
        return;
      }
      hint.textContent = info.adding
        ? 'Click to add a segment to the standard on this bracket. SHIFT takes the whole row.'
        : `Click to stand a ${round(info.totalFt, 2)} ft standard in this bracket. SHIFT takes the whole row.`;
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
      else if (value === null) hint.textContent = 'This bay is held on two sides only, so its boards can run one way only.';
      else hint.textContent = `Boards now run ${compassAxis(value)}, and stay that way until you press R again.`;
      return;
    }
    if (tool === 'liveload') {
      const sel = this.$('sfw-load-dir');
      if (sel) sel.value = value.across ? 'across' : 'along';
      hint.textContent = value.oneWayOnly
        ? 'This bay is held on two sides only, so its load stays along the planks.'
        : value.across ? 'Loads now run across the planks. R turns them back.' : 'Loads now run along the planks.';
      return;
    }
    hint.textContent = 'Nothing to rotate with this tool.';
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
    this._refreshTakeoff();
    this._updateCounts();
    this._refreshBom();
    this._persist();
  }

  _matFor(id, fallback) {
    if (this.selection.includes(id)) return MATERIALS.selected;
    // With Send to beam open, the legs on the beam are blue, and a picked leg
    // the beam cannot take is the warning colour.
    if (this._beamOpen() && this.beamLegs.has(id)) return this._beamPlan().numbers.has(id) ? MATERIALS.selected : BEAM_LEG_OUT;
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
    this._rebuildBeam();
    this.engine?.invalidate({ shadows: true });
  }

  _buildSolids(out) {
    const add = (m, data) => { m.userData = data; out.push(m); };
    const g = this.state.geometry();
    for (const s of g.standards) {
      const mat = this._matFor(s.id, MATERIALS.steel);
      // A base under each leg. A standard seated in a side bracket has none.
      const { meshes } = s.leg ? buildBaseAssembly({
        x: s.x, y: s.y, groundZ: 0,
        jackExtensionIn: this.state.base.jackExtensionIn,
        showWoodSill: this.state.base.showWoodSill,
        showBaseCollar: this.state.base.showBaseCollar,
        material: mat === MATERIALS.steel ? null : mat,
      }) : { meshes: [] };
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
      // A fat invisible target along the arm, so the Plank tool can be pointed
      // at a bracket as easily as at a ledger. Never selected (a proxy).
      add(tubePickProxy([br.x, br.y, br.z], sideBracketTip(br, br.dir, br.lengthFt)), { id: br.id, kind: 'bracket', proxy: true });
    }
  }

  // Live load patches sit just above the deck, with arrows along the one-way span.
  _buildLiveLoads(out) {
    for (const patch of this.state.liveLoadPatches()) {
      const data = { id: patch.id, kind: 'liveload' };
      const m = liveLoadPatch(patch, this.selection.includes(patch.id) ? MATERIALS.selected : null);
      m.userData = data;
      out.push(m);
      // Picking an arrow picks its load.
      for (const arrow of liveLoadArrows(patch)) { arrow.userData = data; out.push(arrow); }
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
    // With Select in hand the card comes and goes with the selection.
    if (this.tools?.tool === 'select') this.$('sfw-toolcard').hidden = !ids.length;
    if (!ids.length) { el.innerHTML = ''; return; }
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
    // A row may carry a third item: what it means, shown when it is pointed at.
    const rows = this._describe(id);
    el.innerHTML = `<dl class="sfw-proplist">` +
      rows.map(([k, v, means]) => `<div${means ? ` title="${means}"` : ''}><dt>${k}</dt><dd>${v}</dd></div>`).join('') + '</dl>';
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
      // Seated in a side bracket it is not a leg: its weight is on the leg the bracket hangs on.
      if (!this.state.isLeg(st)) {
        return [['Type', 'Standard on a side bracket'], ['Position', `${r(st.x)}, ${r(st.y)} ft`],
          ['Segments', st.segments.map(x => `${r(x)} ft`).join(' + ')],
          ['Height', `${r(this.state.standardHeightFt(st))} ft`],
          ['Foot at', `${r(this.state.standardBaseZ(st))} ft`]];
      }
      const rows = [['Type', 'Standard'], ['Position', `${r(st.x)}, ${r(st.y)} ft`],
        ['Segments', st.segments.map(x => `${r(x)} ft`).join(' + ')],
        ['Height', `${r(this.state.standardHeightFt(st))} ft`],
        ['Dead', `${Math.round(leg?.deadLb ?? 0) + 0} lb`], ['Live', `${Math.round(leg?.liveLb ?? 0) + 0} lb`]];
      // A leg side brackets lever load off. Its uplift is its load as the
      // scaffold stands; what it takes to hold it down against overturning is
      // a separate figure with a margin in it, and each is named for what it is.
      const pounds = leg ? wholePoundsOnLeg(leg) : 0;
      if (pounds < 0) rows.push(['Uplift as loaded', `${-pounds} lb`, 'This leg’s load with everything placed on the scaffold at once. No safety factor: it is not what it takes to hold the scaffold down.']);
      const over = leg?.overturning;
      if (over) {
        rows.push(['Overturning', `${r(over.factor)} : 1`, 'The dead load holding this leg down, against what the side brackets lift off it. Live load behind the brackets is not counted.']);
        if (Math.round(over.holdDownLb) > 0) {
          rows.push([`Hold-down for ${OVERTURNING_FACTOR} : 1`, `${Math.round(over.holdDownLb)} lb`,
            `Counterweight or an anchor to add at this leg for ${OVERTURNING_FACTOR} to 1 against overturning. More than the uplift, and needed even where there is none. Wind and ties are not in it.`]);
        }
      }
      return rows;
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
      if (!patch) return [['Type', 'Live load'], ['Status', ll.deckId ? 'its planks are no longer carried' : 'bay no longer closed'], ['Magnitude', `${r(ll.psf)} psf`]];
      // Older patches hang between two ledgers rather than sitting on planks.
      const way = patch.deckId ? (patch.across ? 'Across the planks' : 'Along the planks') : 'Between its two ledgers';
      return [['Type', 'Live load'],
        ['Magnitude', `${r(patch.psf)} psf`],
        ['Direction', way],
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
    const sum = this.$('sfw-bom-sum');
    if (sum) sum.textContent = bom.summary.totalQuantity ? `${bom.summary.totalQuantity} pieces · ${Math.round(bom.summary.totalWeightLb).toLocaleString('en-US')} lb` : '';
    this.$('sfw-bom-total').innerHTML =
      `<div><dt>Lines</dt><dd>${bom.summary.lineItemCount}</dd></div>` +
      `<div><dt>Pieces</dt><dd>${bom.summary.totalQuantity}</dd></div>` +
      `<div><dt>Weight</dt><dd>${Math.round(bom.summary.totalWeightLb)} lb</dd></div>`;
  }

  _rebuildLabels() {
    if (!this.labelGroup) return;
    clearGroup(this.labelGroup);
    // With Send to beam open, the legs on the beam are tagged blue and numbered
    // from its left support, a picked leg left off it is the warning colour,
    // and both show whether or not Leg loads is switched on.
    const plan = this._beamOpen() ? this._beamPlan() : null;
    this.labelGroup.visible = this.showLegLoads || !!plan?.located.length;
    this.engine?.invalidate();
    if (!this.labelGroup.visible) return;
    const { legs } = this.state.takeoff();
    for (const leg of legs) {
      const s = this.state.standards.get(leg.id);
      if (!s) continue;
      const number = plan?.numbers.get(leg.id);
      const leftOut = !!plan && !number && this.beamLegs.has(leg.id);
      if (!this.showLegLoads && !number && !leftOut) continue;
      // A leg picked for the beam shows what it sends there, which leaves out
      // the live load a bracket levers off it. Any other leg shows its load as
      // the scaffold stands, and says so when that is uplift.
      const pounds = wholePoundsOnLeg(plan && this.beamLegs.has(leg.id) ? loadOnBeamFromLeg(leg) : leg);
      const load = pounds < 0 ? `Uplift ${-pounds} lb` : `${pounds} lb`;
      const sp = number ? labelSprite(`${number} · ${load}`, TAG_ON_BEAM)
        : labelSprite(load, leftOut ? TAG_LEFT_OUT : pounds < 0 ? TAG_UPLIFT : TAG_LEG);
      sp.userData.legId = leg.id; // a click on the tag is a click on its leg
      const top = this.state.standardTopZ(s) + 1.1;
      sp.position.set(s.x, s.y, top);
      this.labelGroup.add(sp);
      // What it takes to hold this leg down against overturning: a tag of its
      // own over the load, so that neither number is taken for the other.
      // Not while legs are being picked for a beam, which is about loads.
      const holdDown = plan ? 0 : Math.round(leg.overturning?.holdDownLb || 0);
      if (holdDown > 0) {
        const tag = labelSprite(`Hold-down ${holdDown} lb`, TAG_HOLD_DOWN);
        tag.userData.legId = leg.id;
        tag.userData.holdDown = true;
        tag.center.set(0.5, TAG_SECOND_ROW);
        tag.position.set(s.x, s.y, top);
        this.labelGroup.add(tag);
      }
    }
  }

  // Rosette connection nodes: drawn procedurally on every standard so ledgers,
  // horizontals and braces always have real points to connect to.
  _rebuildNodes() {
    clearGroup(this.nodeGroup);
    const tool = this.tools?.tool;
    // Only the tools that start from a node light them up. Decks, braces and
    // load patches work off ledgers and faces, so they leave nodes neutral.
    const nodeTool = tool === 'ledger' || tool === 'truss' || tool === 'bracket' || (tool === 'standard' && !!this.tools.standardsOnBrackets);
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
    // With "On side brackets" ticked: the tip rosettes whose socket can take a standard.
    if (tool === 'standard') return n => { const seat = n.bracketId ? this.state.bracketSeat(n.bracketId) : null; return !!seat && !seat.blocked; };
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

  /** True while Send to beam is the tool in hand. */
  _beamOpen() { return this.tools?.tool === 'beam'; }

  /**
   * The beam under the legs picked for it: where it lies, and each picked leg
   * on it. `sent` are the legs it carries, in order from its left support and
   * numbered that way (`numbers`, by leg id). `leftOut` are picked legs that
   * are not in line with the rest, or that stand past the end of the beam.
   */
  _beamPlan() {
    const span = this._beamSpan();
    const firstLegFt = Math.max(0, Number(this.$('sfw-first').value) || 0);
    const key = `${this.state.version}|${span}|${firstLegFt}|${[...this.beamLegs].join(',')}`;
    if (this._beamPlanCache?.key === key) return this._beamPlanCache.plan;
    const byId = new Map(this.state.takeoff().legs.map(l => [l.id, l]));
    const picked = [...this.beamLegs].map(id => byId.get(id)).filter(Boolean);
    const laid = beamUnderPickedLegs(picked, span, { firstLegFt, offToleranceFt: OFF_TOLERANCE_FT });
    const sent = laid.located.filter(r => r.onBeam && r.onSpan).sort((a, b) => a.locationFt - b.locationFt);
    const leftOut = laid.located.filter(r => !(r.onBeam && r.onSpan));
    const plan = { ...laid, span, sent, leftOut, numbers: new Map(sent.map((r, i) => [r.leg.id, i + 1])) };
    this._beamPlanCache = { key, plan };
    return plan;
  }

  /** A click with Send to beam open: the leg goes on the beam, or comes off it. */
  _toggleBeamLeg(id) {
    if (!id) return;
    if (!this.beamLegs.delete(id)) this.beamLegs.add(id);
    this._beamChanged();
  }

  /** A box dragged with Send to beam open: its legs go on the beam, or with Ctrl come off it. */
  _boxBeamLegs(ids, { ctrlKey } = {}) {
    if (!ids.length) return;
    for (const id of ids) { if (ctrlKey) this.beamLegs.delete(id); else this.beamLegs.add(id); }
    this._beamChanged();
  }

  /** The legs on the beam changed, or where the beam lies under them. */
  _beamChanged() {
    this._rebuildContent();
    this._refreshTakeoff();
  }

  // The beam itself, drawn under the picked legs while Send to beam is open: a
  // bar on the ground as long as the span, a tick across each end, and a tag
  // on its left support, which is where "From left" is measured from. One leg
  // alone gives the beam no direction, so nothing is drawn until there are two.
  _rebuildBeam() {
    if (!this.beamGroup) return;
    clearGroup(this.beamGroup);
    const plan = this._beamOpen() ? this._beamPlan() : null;
    if (!plan?.beam || !plan.directed) return;
    const { origin: [ox, oy], dir: [ux, uy], spanFt } = plan.beam;
    const piece = (alongFt, lengthFt, widthFt) => {
      const m = new THREE.Mesh(SHARED_GEO.UNIT_BOX, BEAM_BAR);
      m.position.set(ox + ux * alongFt, oy + uy * alongFt, BEAM_BAR_Z_FT);
      m.rotation.z = Math.atan2(uy, ux);
      m.scale.set(lengthFt, widthFt, 0.02);
      m.raycast = () => {}; // never picked, never in the way of a pick
      return m;
    };
    this.beamGroup.add(
      piece(spanFt / 2, spanFt, BEAM_BAR_WIDTH_FT),
      piece(0, BEAM_END_TICK_FT.along, BEAM_END_TICK_FT.across),
      piece(spanFt, BEAM_END_TICK_FT.along, BEAM_END_TICK_FT.across),
    );
    const tag = labelSprite('Left support', TAG_BEAM_END);
    tag.position.set(ox - ux * BEAM_TAG_OUT_FT, oy - uy * BEAM_TAG_OUT_FT, BEAM_BAR_Z_FT);
    tag.raycast = () => {};
    this.beamGroup.add(tag);
  }

  /** The Send to beam card: the legs on the beam, what they bring, and what is left out. */
  _refreshTakeoff() {
    if (!this.engine) return;
    const plan = this._beamPlan();
    const ft = v => `${round(v, 2)} ft`;
    const lb = v => `${Math.round(v).toLocaleString('en-US')} lb`;
    this.$('sfw-span').textContent = `${round(plan.span, 3)} ft`;
    // What each leg sends, which is its load less any live load a side
    // bracket levers off it: see loadOnBeamFromLeg.
    const sends = r => { const s = loadOnBeamFromLeg(r.leg); return `<td>${lb(s.deadLb)}</td><td>${lb(s.liveLb)}</td>`; };
    const rows = [
      ...plan.sent.map(r => `<tr><td>${plan.numbers.get(r.leg.id)}</td><td>${ft(r.locationFt)}</td>${sends(r)}</tr>`),
      ...plan.leftOut.map(r => `<tr class="sfw-off"><td>–</td><td>${r.onBeam ? ft(r.locationFt) : 'Not in line'}</td>${sends(r)}</tr>`),
    ];
    this.$('sfw-rows').innerHTML = rows.join('') || '<tr><td colspan="4" class="sfw-empty">Click the legs that sit on the beam.</td></tr>';
    // Whole pounds, and feet to the hundredth: what the rows above show is
    // exactly what the beam form is given.
    const imported = toBeamPointLoads(plan.sent).imported.map(forBeamForm);
    this._importable = imported;
    const dead = imported.reduce((s, e) => s + e.deadLb, 0), live = imported.reduce((s, e) => s + e.liveLb, 0);
    // Nothing picked, nothing to total.
    this.$('sfw-totals').innerHTML = imported.length
      ? `<div><dt>Legs</dt><dd>${imported.length}</dd></div><div><dt>Dead</dt><dd>${lb(dead)}</dd></div><div><dt>Live</dt><dd>${lb(live)}</dd></div>`
      : '';
    const notes = [];
    const offLine = plan.leftOut.filter(r => !r.onBeam).length;
    const pastEnd = plan.leftOut.length - offLine;
    const legs = n => `${n} leg${n === 1 ? '' : 's'}`;
    const out = [];
    if (offLine) out.push(`${legs(offLine)} not in line with the rest`);
    if (pastEnd) out.push(`${legs(pastEnd)} past the end of the ${round(plan.span, 2)} ft beam`);
    if (out.length) notes.push(`Left out: ${out.join(', ')}.`);
    // A leg behind a loaded bracket shows less on the scaffold than it sends:
    // worth a line, or the two numbers look like a mistake.
    const relieved = plan.sent.filter(r => Math.round(r.leg.lifted?.liveLb || 0) > 0).map(r => plan.numbers.get(r.leg.id));
    if (relieved.length) {
      const list = relieved.length > 1 ? `${relieved.slice(0, -1).join(', ')} and ${relieved[relieved.length - 1]}` : `${relieved[0]}`;
      notes.push(`The live load a side bracket levers off leg${relieved.length > 1 ? 's' : ''} ${list} is not counted: the bracket may be empty.`);
    }
    // Live load is only what the Live load tool placed, so a planked scaffold
    // with none placed sends dead load alone: worth saying before it is imported.
    const planked = this.state.planks.size + this.state.plankPlacements.size > 0;
    if (imported.length && planked && !this.state.liveLoads.size) notes.push('No live load is placed, so these legs carry dead load only.');
    const warn = this.$('sfw-warn');
    warn.hidden = !notes.length;
    warn.textContent = notes.join(' ');
    this.$('sfw-import').disabled = imported.length === 0;
    this.$('sfw-unpick').disabled = plan.located.length === 0;
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
    a.download = 'scaffold-centerlines-estimate.dxf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _downloadBom() {
    if (!this._bom) return;
    const blob = new Blob([bomToCsv(this._bom)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scaffold-parts-estimate.csv';
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
  // The builder opens only once its notice has been agreed to, which is asked
  // once per account (usenotice.js). Looked up now so the click does not wait.
  const notice = createUseNotice();
  notice.prefetch();
  for (const btn of document.querySelectorAll('[data-open-scaffold]')) btn.addEventListener('click', () => notice.request(() => ws.open()));
  window.addEventListener('scafmetric:loads-imported', e => {
    const n = e.detail?.count ?? 0;
    for (const btn of document.querySelectorAll('[data-open-scaffold]')) {
      btn.dataset.imported = String(n);
      // The line under the button's name says what came in.
      const note = btn.querySelector('[data-scaffold-note]');
      if (!note) continue;
      note.dataset.idle ||= note.textContent;
      note.textContent = n ? `${n} leg load${n === 1 ? '' : 's'} imported` : note.dataset.idle;
    }
  });
}
