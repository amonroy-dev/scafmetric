// In-page half of scripts/marketing-shots.mjs.
//
// One example job, worked through the real page the way a person works it:
// the beam form's own fields and buttons, and in the builder real pointer
// events on the real canvas, so the pictures show what the product does and
// not a model put together behind its back. The orchestrator calls one step
// at a time and photographs the page between them.

window.__shots = (() => {
  const ws = () => window.scaffoldWorkspace;
  const canvas = () => ws().engine.renderer.domElement;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const raf = (n = 1) => new Promise(r => {
    const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const text = el => (el ? el.innerText.replace(/\s*\n+\s*/g, ' | ').trim() : '');

  /** Leave a field as a person would: its value, then input and change. */
  function set(el, value) {
    if (!el) throw new Error('a field the example fills in is missing from the page');
    if (el.type === 'checkbox') { if (el.checked !== !!value) el.click(); return; }
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // three.js is bundled, not global, so the camera matrices are multiplied by
  // hand. Matrix4.elements is column-major: index = col * 4 + row.
  function applyMat4(e, v) {
    const [x, y, z, w] = v;
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12] * w,
      e[1] * x + e[5] * y + e[9] * z + e[13] * w,
      e[2] * x + e[6] * y + e[10] * z + e[14] * w,
      e[3] * x + e[7] * y + e[11] * z + e[15] * w,
    ];
  }

  /** World feet to client pixels, through the live camera. */
  function project(world) {
    const cam = ws().engine.camera;
    cam.updateMatrixWorld();
    const view = applyMat4(cam.matrixWorldInverse.elements, [world[0], world[1], world[2], 1]);
    const clip = applyMat4(cam.projectionMatrix.elements, view);
    const w = clip[3] || 1e-6;
    const r = canvas().getBoundingClientRect();
    return { x: r.left + ((clip[0] / w) + 1) / 2 * r.width, y: r.top + (1 - (clip[1] / w)) / 2 * r.height };
  }

  function pointer(type, at, opts = {}) {
    canvas().dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientX: at.x, clientY: at.y, button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' ? 1 : 0, shiftKey: !!opts.shift,
    }));
  }
  async function hover(world, opts) { pointer('pointermove', project(world), opts); await raf(2); }
  /** Hover then click with no movement between, so it never reads as a drag. */
  async function click(world, opts) {
    const at = project(world);
    pointer('pointermove', at, opts); await raf(1);
    pointer('pointerdown', at, opts); pointer('pointerup', at, opts);
    await raf(2);
  }

  function tool(name) {
    const b = ws().root.querySelector(`.sfw-tool[data-tool="${name}"]`);
    if (!b) throw new Error(`the builder has no ${name} tool`);
    b.click();
  }
  function blockCard(settings) {
    for (const [k, v] of Object.entries(settings)) set(ws().root.querySelector(`[data-block="${k}"]`), v);
  }

  /** Where an element sits on the page, in whole CSS pixels. */
  function box(el) {
    const b = el.getBoundingClientRect();
    return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height };
  }
  const need = sel => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nothing on the page matches ${sel}`);
    return el;
  };

  // --- the camera ---------------------------------------------------------

  /** The corners of the model's box, with room above for the leg tags. */
  function modelCorners(aboveFt = 0) {
    const b = ws()._modelBox();
    const out = [];
    for (let i = 0; i < 8; i++) out.push([i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z + aboveFt : b.min.z]);
    return out;
  }

  /**
   * Look along `dir` (from the model toward the camera) and fit the points
   * into `region`, a rectangle of the canvas in client pixels. Several passes:
   * in perspective neither size nor position is linear in where the camera is.
   */
  async function frameInto(points, region, dir) {
    const e = ws().engine;
    e.cancelTransition();
    if (e.projection !== 'perspective') e.setProjection('perspective');
    const cam = e.camera, target = e.controls.target;
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    const d = dir.map(v => v / n);
    const mid = [0, 1, 2].map(i => (Math.min(...points.map(p => p[i])) + Math.max(...points.map(p => p[i]))) / 2);
    target.set(mid[0], mid[1], mid[2]);
    let dist = 90;
    const place = () => {
      cam.up.set(0, 0, 1);
      cam.position.set(target.x + d[0] * dist, target.y + d[1] * dist, target.z + d[2] * dist);
      e.controls.update();
      cam.updateMatrixWorld();
    };
    const bounds = () => {
      const ps = points.map(project);
      const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    for (let pass = 0; pass < 8; pass++) {
      place();
      let b = bounds();
      dist *= Math.max((b.x1 - b.x0) / region.width, (b.y1 - b.y0) / region.height);
      place();
      b = bounds();
      // Slide the camera across its own view plane until the model is centered.
      const dx = (region.x + region.width / 2) - (b.x0 + b.x1) / 2;
      const dy = (region.y + region.height / 2) - (b.y0 + b.y1) / 2;
      const feetPerPixel = 2 * dist * Math.tan((cam.fov * Math.PI / 180) / 2) / canvas().getBoundingClientRect().height;
      const m = cam.matrixWorld.elements; // columns 0 and 1: the camera's right and up
      target.set(
        target.x + (-m[0] * dx + m[4] * dy) * feetPerPixel,
        target.y + (-m[1] * dx + m[5] * dy) * feetPerPixel,
        target.z + (-m[2] * dx + m[6] * dy) * feetPerPixel,
      );
    }
    place();
    e.invalidate({ shadows: true });
    await raf(4);
  }

  // --- the example job ----------------------------------------------------

  const nextStep = n => need(`.wizard-step[data-step="${n}"] [data-step-next]`).click();

  /** The page is ready to be driven: fonts in, the section library loaded. */
  async function ready() {
    await document.fonts.ready;
    for (let i = 0; i < 200 && $('section').options.length < 2; i++) await sleep(50);
    if ($('section').options.length < 2) throw new Error('the section library never loaded');
    return { inter: document.fonts.check('12px Inter'), sections: $('section').options.length };
  }

  /** Steps 1 and 2 of the beam form: whose job it is, and the beam carried in the bid. */
  async function beamStart({ project, preparer, section, spanFt }) {
    set($('project'), project); set($('preparer'), preparer);
    nextStep(1); await sleep(150);
    set($('section'), section); set($('span'), spanFt);
    if ($('section').value !== section) throw new Error(`${section} is not in the section library`);
    nextStep(2); await sleep(150);
  }

  async function openBuilder() {
    need('[data-open-scaffold]').click();
    for (let i = 0; i < 400 && !(ws() && ws().engine && !ws().root.hidden); i++) await raf(1);
    if (!(ws() && ws().engine)) throw new Error('the scaffold builder never opened');
    await raf(20);
  }

  /** One block from the Block card: a run of bays, decked, railed and braced. */
  async function buildScaffold({ bays, bayFt, depthFt, heightFt, levels }) {
    tool('block');
    blockCard({
      widthFt: bays * bayFt, depthFt, heightFt, plankedLevelsCount: levels,
      guardrails: true, braceFrontBack: 'slash', braceLeftRight: 'slash',
    });
    await raf(2);
    await click([bays * bayFt / 2, depthFt / 2, 0]);
    await raf(6);
    const s = ws().state;
    const front = [...new Set([...s.standards.values()].filter(c => Math.abs(c.y) < 1e-6).map(c => c.x))].sort((a, b) => a - b);
    return { standards: s.standards.size, decks: s.plankBays().length, front };
  }

  /** Every deck loaded with the Live load tool, a platform at a time (SHIFT+click). */
  async function loadDecks({ psf, alongFt }) {
    const s = ws().state;
    ws().engine.setView('home', { fit: ws()._modelBox() });
    ws().engine.invalidate({ shadows: true });
    await raf(8);
    tool('liveload');
    set(ws().$('sfw-bay-psf'), psf);
    await raf(2);
    const levels = [...new Set(s.plankBays().map(d => Math.round(d.z * 1000) / 1000))].sort((a, b) => a - b);
    // Just inside the front edge: from the home view that strip of every deck
    // is in sight, where the middle of a lower one is under the deck above.
    for (const z of levels) { await click([alongFt, 0.6, z + 0.05], { shift: true }); await raf(3); }
    return { levels, loaded: s.liveLoads.size };
  }

  /** Send to beam: the front legs clicked onto it, the first set in from the support. */
  async function sendLegs({ at, firstLegFt }) {
    const s = ws().state;
    tool('beam');
    await raf(4);
    const legs = [...s.standards.values()]
      .filter(c => Math.abs(c.y) < 1e-6 && at.some(x => Math.abs(c.x - x) < 1e-6))
      .sort((a, b) => a.x - b.x);
    for (const c of legs) await click([c.x, c.y, s.standardTopZ(c)]);
    set(ws().$('sfw-first'), firstLegFt);
    await raf(4);
    return {
      picked: ws().beamLegs.size,
      rows: [...ws().$('sfw-rows').querySelectorAll('tr')].map(r => [...r.children].map(c => c.textContent)),
      totals: text(ws().$('sfw-totals')),
      spanFt: ws().$('sfw-span').textContent,
      warning: ws().$('sfw-warn').hidden ? '' : ws().$('sfw-warn').textContent,
    };
  }

  /**
   * Set the builder up for its picture: the parts list open, the model drawn
   * at the screen's own resolution and framed in the open part of the stage,
   * beside the tool card and clear of the view cube and the hint.
   * Returns the dialog's rectangle.
   */
  async function composeBuilder({ dir, pixelRatio }) {
    const e = ws().engine;
    const parts = [...ws().root.querySelectorAll('.sfw-side details')].find(d => /parts list/i.test(d.querySelector('summary').textContent));
    if (parts) parts.open = true;
    // The builder caps the canvas at 1.5 device pixels to keep orbiting quick;
    // a still picture can afford every pixel of the screen it is taken for.
    e.renderer.setPixelRatio(pixelRatio);
    e.resize();
    await raf(4);
    const stage = ws().$('sfw-stage').getBoundingClientRect();
    const card = ws().$('sfw-toolcard').getBoundingClientRect();
    const hint = ws().$('sfw-hint').getBoundingClientRect();
    const left = card.right + 64, right = stage.right - 72, top = stage.top + 96, bottom = hint.top - 64;
    await frameInto(modelCorners(1.6), { x: left, y: top, width: right - left, height: bottom - top }, dir);
    // Rest the pointer on open ground: no leg lit, and the hint is the tool's own.
    const b = ws()._modelBox();
    await hover([b.max.x + 9, b.min.y - 9, 0]);
    e.invalidate({ shadows: true });
    await raf(10);
    return box(need('.sfw-dialog'));
  }

  /** Import to beam, take out the placeholder uniform load, and finish the form. */
  async function importAndRun() {
    ws().$('sfw-import').click();
    await sleep(400);
    for (const row of [...document.querySelectorAll('#load-rows .load-row')]) {
      if (!row.dataset.scaffoldImport) row.querySelector('.remove-load').click();
    }
    await sleep(100);
    const loads = [...document.querySelectorAll('#load-rows .load-row')].map(r => ({
      id: r.querySelector('.load-number').textContent,
      deadLb: Number(r.querySelector('.point-dead').value),
      liveLb: Number(r.querySelector('.point-live').value),
      atFt: Number(r.querySelector('.point-location').value),
    }));
    nextStep(3); await sleep(150);
    need('[data-no-bracing]').click(); await sleep(150);
    set($('capacity-confirmed'), true);
    await sleep(80);
    return { loads, ...(await run()) };
  }

  async function run() {
    $('calculate').click();
    for (let i = 0; i < 100 && !document.querySelector('#verdict .verdict-pass, #verdict .verdict-fail'); i++) await sleep(50);
    await sleep(600);
    if (document.activeElement) document.activeElement.blur();
    scrollTo(0, 0);
    await sleep(200);
    const use = document.querySelector('[data-use-suggestion]');
    return {
      error: $('error').textContent,
      passed: !!document.querySelector('#verdict .verdict-pass'),
      verdict: text($('verdict')),
      suggested: use ? use.dataset.useSuggestion : '',
      section: $('section').value,
    };
  }

  /** Take the size the check suggests, confirm the assumptions again, and run it. */
  async function useSuggestion() {
    need('[data-use-suggestion]').click();
    await sleep(300);
    set($('capacity-confirmed'), true);
    await sleep(80);
    return run();
  }

  /**
   * The parts of the beam page the pictures are taken of, as rectangles.
   *   model    the Model panel: the loads on the beam and how it bends
   *   check    the Analysis panel from its heading down to the verdict and
   *            the suggested size
   *   results  the verdict, the suggested size and the figures under them
   */
  function regions() {
    const panel = box(need('.results-panel'));
    const verdict = box(need('#verdict .verdict-card'));
    const suggestion = document.querySelector('#suggestion .suggestion-card');
    const cardsBottom = Math.max(verdict.y + verdict.height, suggestion ? box(suggestion).y + box(suggestion).height : 0);
    const figures = box(need('#results .result-grid'));
    const pad = verdict.x - panel.x; // the panel's own padding, so every edge gets the same
    // The results are cut out of the middle of the panel. Its edges stop half
    // way to whatever is above and below, so that neither neighbor's border
    // shows as a stray line along the edge of the picture.
    const saved = $('project-save-status');
    const above = saved && !saved.hidden ? box(saved).y + box(saved).height : panel.y;
    const details = document.querySelector('#results details');
    const below = details ? box(details).y : Infinity;
    const top = verdict.y - Math.min(pad, (verdict.y - above) / 2);
    const figuresBottom = figures.y + figures.height;
    const bottom = figuresBottom + Math.min(pad, (below - figuresBottom) / 2);
    return {
      model: box(need('.drawing-panel')),
      check: { x: panel.x, y: panel.y, width: panel.width, height: cardsBottom + pad - panel.y },
      results: { x: panel.x, y: top, width: panel.width, height: bottom - top },
    };
  }

  return { ready, beamStart, openBuilder, buildScaffold, loadDecks, sendLegs, composeBuilder, importAndRun, useSuggestion, regions };
})();
