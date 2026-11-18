// In-page driver for the visual harness.
//
// Installed once by scripts/visual-check.mjs, then driven one step at a time so
// the orchestrator can screenshot between steps. Every step talks to the real
// workspace through real pointer and keyboard events on the real canvas, so it
// exercises the same code path a user does -- picking, snapping, ghosts and all.

window.__sv = (() => {
  const errors = [];
  window.addEventListener('error', e => errors.push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', e => errors.push(`rejection: ${e.reason}`));
  const realError = console.error.bind(console);
  console.error = (...a) => { errors.push(`console.error: ${a.join(' ')}`); realError(...a); };

  const ws = () => window.scaffoldWorkspace;
  const canvas = () => (ws() && ws().engine ? ws().engine.renderer.domElement : null);
  const raf = (n = 1) => new Promise(r => {
    const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  // three.js is bundled, not global, so multiply the camera matrices by hand.
  // Matrix4.elements is column-major: index = col * 4 + row.
  function applyMat4(e, v) {
    const [x, y, z, w] = v;
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12] * w,
      e[1] * x + e[5] * y + e[9] * z + e[13] * w,
      e[2] * x + e[6] * y + e[10] * z + e[14] * w,
      e[3] * x + e[7] * y + e[11] * z + e[15] * w,
    ];
  }

  /** World feet -> client pixels, through whichever camera is live. */
  function project(world) {
    const cam = ws().engine.camera;
    cam.updateMatrixWorld();
    const view = applyMat4(cam.matrixWorldInverse.elements, [world[0], world[1], world[2], 1]);
    const clip = applyMat4(cam.projectionMatrix.elements, view);
    const w = clip[3] || 1e-6;
    const r = canvas().getBoundingClientRect();
    return {
      x: r.left + ((clip[0] / w) + 1) / 2 * r.width,
      y: r.top + (1 - (clip[1] / w)) / 2 * r.height,
    };
  }

  function pointer(type, at, opts) {
    const o = opts || {};
    canvas().dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientX: at.x, clientY: at.y,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' || type === 'pointermove' && o.held ? 1 : 0,
      shiftKey: !!o.shift, ctrlKey: !!o.ctrl, altKey: !!o.alt,
    }));
  }

  /** Hover a world point and let the ghost/preview settle. */
  async function hover(world, opts) {
    pointer('pointermove', project(world), opts);
    await raf(2);
  }

  /** Hover then click with no movement between, so it never reads as a drag. */
  async function click(world, opts) {
    const at = project(world);
    pointer('pointermove', at, opts);
    await raf(1);
    pointer('pointerdown', at, opts);
    pointer('pointerup', at, opts);
    await raf(2);
  }

  /** A real press-move-release, which is what marquee and block layout need. */
  async function drag(fromWorld, toWorld, opts) {
    const o = Object.assign({}, opts, { held: true });
    const a = project(fromWorld);
    const b = project(toWorld);
    pointer('pointermove', a, opts);
    pointer('pointerdown', a, opts);
    for (let i = 1; i <= 8; i++) {
      pointer('pointermove', { x: a.x + (b.x - a.x) * i / 8, y: a.y + (b.y - a.y) * i / 8 }, o);
      await raf(1);
    }
    pointer('pointerup', b, opts);
    await raf(2);
  }

  function key(k, opts) {
    const o = opts || {};
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
      bubbles: true, shiftKey: !!o.shift, ctrlKey: !!o.ctrl,
    }));
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function canvasCenter() {
    const r = canvas().getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** A mouse pointer event for navigation; middle button unless told otherwise. */
  function navPointer(type, at, opts) {
    const o = opts || {};
    return canvas().dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: 'mouse', isPrimary: true,
      clientX: at.x, clientY: at.y,
      button: type === 'pointermove' ? -1 : (o.button ?? 1),
      buttons: type === 'pointerup' ? 0 : (o.buttons ?? 4),
      shiftKey: !!o.shift,
    }));
  }

  async function middleDrag(a, b, opts) {
    navPointer('pointerdown', a, opts);
    for (let i = 1; i <= 10; i++) {
      navPointer('pointermove', { x: a.x + (b.x - a.x) * i / 10, y: a.y + (b.y - a.y) * i / 10 }, opts);
      await raf(1);
    }
    navPointer('pointerup', b, opts);
    await raf(2);
  }

  function wheel(at, deltaY) {
    canvas().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, deltaY, deltaMode: 0 }));
  }

  /** The ground point (z = 0) under a client pixel. */
  function groundAt(p) {
    const g = ws().engine.projectClientToGround(p.x, p.y);
    return g ? [g.x, g.y, g.z] : null;
  }

  /** Where the model's box corners land on the canvas, and how much of it they fill. */
  function modelOnScreen() {
    const b = ws()._modelBox();
    const r = canvas().getBoundingClientRect();
    const pts = [];
    for (let i = 0; i < 8; i++) {
      pts.push(project([i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z]));
    }
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return {
      inside: pts.every(p => p.x >= r.left - 1 && p.x <= r.right + 1 && p.y >= r.top - 1 && p.y <= r.bottom + 1),
      fill: +Math.max((Math.max(...xs) - Math.min(...xs)) / r.width, (Math.max(...ys) - Math.min(...ys)) / r.height).toFixed(3),
    };
  }

  function setField(id, value) {
    const el = ws().root.querySelector('#' + id);
    if (!el) return false;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function tool(name) {
    const b = ws().root.querySelector('[data-tool="' + name + '"]');
    if (!b) throw new Error('no tool button: ' + name);
    b.click();
  }

  function toggle(name) {
    const b = ws().root.querySelector('[data-toggle="' + name + '"]');
    if (b) b.click();
  }

  function hint() { return ws().$('sfw-hint').textContent; }

  /** Fraction of canvas pixels that differ from the scene background. */
  function coverage() {
    const c = canvas();
    const off = document.createElement('canvas');
    const w = off.width = Math.min(480, c.width);
    const h = off.height = Math.round(w * (c.height / c.width));
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    // Compare against the live scene background, whatever colour the theme sets.
    const bg = ws().engine.scene.background.getHex();
    const br = (bg >> 16) & 255, bgG = (bg >> 8) & 255, bb = bg & 255;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb) > 24) lit++;
    }
    return +(lit / (w * h)).toFixed(4);
  }

  /** Fraction of canvas pixels that read as the cyan of a live load patch. */
  function cyanFraction() {
    const c = canvas();
    const off = document.createElement('canvas');
    const w = off.width = Math.min(480, c.width);
    const h = off.height = Math.round(w * (c.height / c.width));
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let hit = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > r + 20 && b > r + 20 && g > 60) hit++;
    }
    return +(hit / (w * h)).toFixed(5);
  }

  function counts() {
    const s = ws().state;
    let segments = 0;
    for (const col of s.standards.values()) segments += col.segments.length;
    return {
      columns: s.standards.size, segments,
      ledgers: s.ledgers.size, braces: s.braces.size,
      decks: s.plankBays().length, liveLoads: s.liveLoads.size,
      trusses: s.trusses.size, brackets: s.brackets.size, nodes: s.nodes().length,
    };
  }

  function glInfo() {
    const c = canvas();
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    if (!ctx) return { ok: false };
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      version: ctx.getParameter(ctx.VERSION),
      renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER),
      drawingBuffer: [c.width, c.height],
    };
  }

  /** Unit vector from the orbit target to the camera, rounded for comparison. */
  function camDir() {
    const e = ws().engine;
    const p = e.camera.position, t = e.controls.target;
    const v = [p.x - t.x, p.y - t.y, p.z - t.z];
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return v.map(c => +(c / n).toFixed(3));
  }

  const BAY = 7;

  /** Height of a rosette level on the column at (x, y), in world feet. */
  function levelZ(x, y, level) {
    const n = ws().state.nodes().find(q => q.x === x && q.y === y && q.level === level);
    return n ? n.z : null;
  }

  /** Ledgers on the y=0 run, lowest first. */
  function frontLedgers() {
    return ws().state.ledgerList()
      .filter(l => Math.abs(l.a[1]) < 1e-6 && Math.abs(l.b[1]) < 1e-6)
      .sort((p, q) => p.a[2] - q.a[2]);
  }

  /** A point on the front shoulder of a ledger, for the deck/load tools. The
   *  offset stays inside the pick proxy so the raycast still lands on the
   *  ledger, while telling the tool which side of it the cursor is on. */
  function besideLedger(l) {
    return [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2 + 0.15, l.a[2]];
  }

  /** A point just outside the y=0 face of the first bay, at a given level. */
  function frontFace(level) {
    const z = levelZ(0, 0, level);
    return z === null ? null : [BAY / 2, -0.08, z + 0.5];
  }

  const steps = {
    // Open the builder from the real page button with no saved work: it must
    // start empty, in the top view, with the standard tool active.
    async open() {
      for (const k of Object.keys(localStorage)) {
        if (k.indexOf('scafmetric:wip:') === 0) localStorage.removeItem(k);
      }
      document.querySelector('[data-open-scaffold]').click();
      for (let i = 0; i < 300 && !(ws() && ws().engine); i++) await raf(1);
      if (!(ws() && ws().engine)) throw new Error('engine never started');
      await raf(30);
      // Measure teal with the grid hidden: its thin centre axes are teal too.
      ws().engine.grid.visible = false;
      await raf(3);
      const tealOnEmpty = coverage();
      ws().engine.grid.visible = true;
      await raf(3);
      const initial = {
        projection: ws().engine.projection, camDir: camDir(), tool: ws().tools.tool,
        activeButton: (ws().root.querySelector('.sfw-tool.is-active') || {}).dataset?.tool || null,
        // Teal pixels on an empty model: the old beam line drew a teal bar here.
        coverage: tealOnEmpty,
        undoDisabled: ws().root.querySelector('.sfw-history [data-act="undo"]').getAttribute('aria-disabled'),
      };
      return { gl: glInfo(), counts: counts(), coverage: coverage(), hint: hint(), initial };
    },

    // Esc drops any tool back to Select, through a real document-level keypress.
    async escToSelect() {
      // The rest of the walkthrough builds from the home view.
      ws().engine.setView('home');
      await raf(8);
      tool('brace');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await raf(2);
      const fromBrace = ws().tools.tool;
      tool('standard');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await raf(2);
      return {
        fromBrace, fromStandard: ws().tools.tool,
        activeButton: (ws().root.querySelector('.sfw-tool.is-active') || {}).dataset?.tool || null,
        open: !ws().root.hidden, hint: hint(),
      };
    },

    // Typed target height: one click builds the whole planned stack, and a click
    // on a standard that is already there stacks onto it.
    async autoHeightStandards() {
      tool('standard');
      setField('sfw-stdh', 19.7);
      const plan = ws().tools.standardStackPlan();
      const before = counts().segments;
      for (const [x, y] of [[0, 0], [BAY, 0], [0, BAY], [BAY, BAY]]) await click([x, y, 0]);
      ws()._frame();
      await raf(8);
      return {
        plan, planTotalFt: +plan.reduce((a, b) => a + b, 0).toFixed(4),
        added: counts().segments - before, counts: counts(),
        note: (ws().$('sfw-stdh-note') || {}).textContent || null,
      };
    },

    // Left-drag marquee over the four stacks just placed. This is the path that
    // threw on every pointerdown because the ground projection chained off
    // Raycaster.setFromCamera.
    async marqueeSelect() {
      tool('select');
      await drag([-3, -3, 0], [BAY + 3, BAY + 3, 0]);
      const selected = ws().selection.length;
      ws().selection = [];
      ws().tools.selection.clear();
      ws()._rebuildContent();
      await raf(3);
      return { selected, counts: counts() };
    },

    // SHIFT fills every bay at the level of the node under the cursor.
    async ledgersEveryLevel() {
      tool('ledger');
      const before = counts().ledgers;
      const levels = [5, 9, 13];
      for (const level of levels) {
        const z = levelZ(0, 0, level);
        if (z !== null) await click([0, 0, z], { shift: true });
      }
      ws()._frame();
      await raf(8);
      return { levels, added: counts().ledgers - before, counts: counts(), hint: hint() };
    },

    // Hover a bay face: the preview shows which lift pair would be braced.
    async bracePreview() {
      tool('brace');
      const at = frontFace(3);
      await hover(at);
      const p = project(at);
      const target = ws().tools.braceTargetUnderCursor(
        new PointerEvent('pointermove', { clientX: p.x, clientY: p.y }));
      return {
        ghosts: ws().tools.ghostGroup.children.length,
        target: target ? { levelA: target.levelA, levelB: target.levelB, spanFt: +target.spanFt.toFixed(4) } : null,
        miss: ws().tools.braceMiss, hint: hint(),
      };
    },

    // Click places one diagonal on that face.
    async braceOne() {
      const before = counts().braces;
      await click(frontFace(3));
      ws()._frame();
      await raf(6);
      const b = [...ws().state.braces.values()].pop();
      return {
        added: counts().braces - before,
        lengthFt: b ? +Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]).toFixed(4) : null,
        counts: counts(),
      };
    },

    // SHIFT fills every perimeter face at that height.
    async braceShiftFill() {
      const before = counts().braces;
      await click(frontFace(3), { shift: true });
      ws()._frame();
      await raf(6);
      return { added: counts().braces - before, counts: counts(), hint: hint() };
    },

    // R flips the diagonal direction while hovering.
    async braceRotate() {
      const before = ws().tools.braceDirection;
      await hover(frontFace(3));
      key('r');
      await raf(4);
      return { before, after: ws().tools.braceDirection, hint: hint() };
    },

    // Decks hang off a ledger: hover one, the side under the cursor picks the bay.
    async deckOne() {
      tool('plank');
      const l = frontLedgers()[0];
      if (!l) throw new Error('no ledger on the y=0 run');
      const before = counts().decks;
      await hover(besideLedger(l));
      const ghosts = ws().tools.ghostGroup.children.length;
      // What the ray actually found, so a miss says why.
      const at = project(besideLedger(l));
      ws().engine.setPointerFromEvent({ clientX: at.x, clientY: at.y });
      ws().engine.raycaster.setFromCamera(ws().engine.pointer, ws().engine.camera);
      const raw = ws().engine.raycaster.intersectObjects(ws().contentGroup.children, false);
      const probe = {
        tool: ws().tools.tool,
        contentMeshes: ws().contentGroup.children.length,
        hits: raw.slice(0, 6).map(h => (h.object.userData || {}).kind + ((h.object.userData || {}).proxy ? '*' : '')),
        picked: !!ws().tools._pickLedger({ clientX: at.x, clientY: at.y }),
      };
      await click(besideLedger(l));
      ws()._frame();
      await raf(6);
      const bay = ws().state.plankBays().pop();
      return {
        ghosts, probe, added: counts().decks - before,
        boards: bay ? bay.boards.length : 0,
        boardLengthFt: bay ? +bay.boards[0].lengthFt.toFixed(3) : null,
        bayFt: bay ? [+bay.widthFt.toFixed(3), +bay.lengthFt.toFixed(3)] : null,
        counts: counts(),
      };
    },

    // SHIFT decks every bay along that run, one lift up.
    async deckShiftFill() {
      const l = frontLedgers().find(q => q.a[2] > frontLedgers()[0].a[2] + 0.5);
      if (!l) throw new Error('no upper ledger on the y=0 run');
      const before = counts().decks;
      await click(besideLedger(l), { shift: true });
      ws()._frame();
      await raf(6);
      return { added: counts().decks - before, counts: counts(), hint: hint() };
    },

    // Per-bay live load patch on a ledger side.
    async liveLoadPatch() {
      tool('liveload');
      setField('sfw-bay-psf', 75);
      const l = frontLedgers()[0];
      const before = counts().liveLoads;
      // Look straight down at the bay so the patch, if it renders, is unmissable.
      ws().engine.setView('top');
      await raf(6);
      const cyanBefore = cyanFraction();
      await click(besideLedger(l));
      await raf(8);
      const cyanAfter = cyanFraction();
      const t = ws().state.takeoff();
      return {
        added: counts().liveLoads - before,
        cyanBefore, cyanAfter, cyanDelta: +(cyanAfter - cyanBefore).toFixed(5),
        mode: ws().state.liveLoadMode,
        liveLb: Math.round(t.totals.liveLb),
        placedLiveLb: Math.round(t.placedLiveLb || 0),
        counts: counts(),
      };
    },

    // R rotates the block preview in 90 degree steps.
    async blockRotate() {
      tool('block');
      await hover([3 * BAY, 0, 0]);
      const before = ws().tools.rotationSteps;
      key('r');
      await raf(4);
      return { before, after: ws().tools.rotationSteps, hint: hint() };
    },

    // Drag out a block: standards, ledgers, bracing and a deck in one gesture.
    async blockDrag() {
      const before = counts();
      setField('sfw-blockh', 13);
      await drag([-14, 0, 0], [-7, BAY, 0]);
      ws()._frame();
      await raf(8);
      const after = counts();
      return {
        addedColumns: after.columns - before.columns,
        addedLedgers: after.ledgers - before.ledgers,
        addedBraces: after.braces - before.braces,
        counts: after, hint: hint(),
      };
    },

    // A face whose standards are too short must SAY so, not fail silently.
    async braceShortStackMessage() {
      tool('standard');
      setField('sfw-stdh', 0);
      await click([-14, -14, 0]);
      await click([-14 + BAY, -14, 0]);
      ws()._frame();
      await raf(6);
      tool('brace');
      const z = levelZ(-14, -14, 2);
      await hover([-14 + BAY / 2, -14 - 0.08, z + 0.5]);
      return { miss: ws().tools.braceMiss, hint: hint() };
    },

    // Named views are orthographic, and a zoom-to-fit right afterwards must not
    // throw the direction away.
    async viewTop() {
      tool('select');
      ws().engine.setView('top');
      ws()._frame();
      await raf(10);
      return { projection: ws().engine.projection, camDir: camDir(), coverage: coverage() };
    },

    async viewFront() {
      ws().engine.setView('front');
      ws()._frame();
      await raf(10);
      return { projection: ws().engine.projection, camDir: camDir(), coverage: coverage() };
    },

    // ScaffoldPro navigation, through real middle-button and wheel events.
    // Middle-drag in Top: the grabbed ground point follows the cursor on BOTH
    // axes. It used to move only sideways when looking straight down.
    async panTopView() {
      tool('select');
      ws().engine.setView('top');
      ws()._frame();
      await raf(4);
      const c = canvasCenter();
      const a = { x: c.x - 120, y: c.y - 70 }, b = { x: a.x + 180, y: a.y + 120 };
      const grabbed = groundAt(a);
      const before = ws().engine.controls.target.toArray();
      await middleDrag(a, b);
      const landed = project(grabbed);
      const after = ws().engine.controls.target.toArray();
      return {
        error: +Math.hypot(landed.x - b.x, landed.y - b.y).toFixed(3),
        moved: [+(after[0] - before[0]).toFixed(3), +(after[1] - before[1]).toFixed(3)],
        camDir: camDir(), projection: ws().engine.projection,
      };
    },

    // Wheel in Top: the ground point under the cursor stays under it.
    async wheelZoomTop() {
      const c = canvasCenter();
      const at = { x: c.x + 160, y: c.y + 90 };
      const before = groundAt(at), zoomBefore = ws().engine.camera.zoom;
      wheel(at, -300);
      await raf(2);
      const after = groundAt(at);
      return { drift: +Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(4), zoomBefore, zoomAfter: ws().engine.camera.zoom };
    },

    // Wheel in perspective: whatever is under the cursor stays under it.
    async wheelZoomPerspective() {
      ws().engine.setView('home');
      ws()._frame();
      await raf(4);
      const e = ws().engine;
      const c = canvasCenter();
      const at = { x: c.x + 60, y: c.y + 40 };
      const before = groundAt(at), distBefore = e.camera.position.distanceTo(e.controls.target);
      wheel(at, -200);
      await raf(2);
      const after = groundAt(at);
      return {
        drift: +Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]).toFixed(4),
        distBefore: +distBefore.toFixed(3), distAfter: +e.camera.position.distanceTo(e.controls.target).toFixed(3),
      };
    },

    // Double middle-click is Zoom Extents: from off screen the model comes back.
    async doubleMiddleFits() {
      const c = canvasCenter();
      await middleDrag(c, { x: c.x + 700, y: c.y + 380 });
      const offBefore = modelOnScreen();
      for (const n of [1, 2]) {
        navPointer('pointerdown', c);
        navPointer('pointerup', c);
        canvas().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, detail: n, clientX: c.x, clientY: c.y }));
      }
      await sleep(450);
      await raf(2);
      return { offBefore, ...modelOnScreen() };
    },

    // Shift+middle orbits about the model centre while the whole model is in
    // view; the pivot holds its place on screen and its marker shows meanwhile.
    async orbitShiftMiddle() {
      const center = ws()._modelBox().getCenter(ws().engine.camera.position.clone()).toArray();
      const p0 = project(center), dir0 = camDir();
      const c = canvasCenter();
      navPointer('pointerdown', c, { shift: true });
      for (let i = 1; i <= 10; i++) { navPointer('pointermove', { x: c.x + 16 * i, y: c.y - 6 * i }, { shift: true }); await raf(1); }
      const markerShown = ws().engine._pivotMarker.visible;
      navPointer('pointerup', { x: c.x + 160, y: c.y - 60 }, { shift: true });
      await sleep(400);
      await raf(2);
      const p1 = project(center), dir1 = camDir();
      return {
        pivotShiftPx: +Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(3),
        turned: +Math.acos(Math.min(1, dir0[0] * dir1[0] + dir0[1] * dir1[1] + dir0[2] * dir1[2])).toFixed(3),
        markerShown, markerHiddenAfter: !ws().engine._pivotMarker.visible, projection: ws().engine.projection,
      };
    },

    // In an orthographic face, Shift+middle does not turn out of it.
    async orbitLockedInTop() {
      ws().engine.setView('top');
      ws()._frame();
      await raf(4);
      const c = canvasCenter();
      await middleDrag(c, { x: c.x + 160, y: c.y + 40 }, { shift: true });
      await sleep(200);
      return { camDir: camDir(), projection: ws().engine.projection };
    },

    // A ViewCube face travels on a timed curve and lands exactly on the face.
    // The midpoint is sampled by time, not frame count, so a slow software GPU
    // cannot finish the move before it is looked at.
    async viewTransition() {
      const e = ws().engine;
      e.setView('home');
      await raf(2);
      const startDir = camDir();
      e.setView('front', { animate: true });
      const tr = e._transition;
      let midDir = null;
      if (tr) { e._stepTransition(tr.start + tr.duration / 2); midDir = camDir(); }
      await sleep(800);
      await raf(3);
      return { started: !!tr, startDir, midDir, camDir: camDir(), projection: e.projection };
    },

    // Undo / redo with the real keys and the canvas arrows, on ScaffoldPro's
    // rules: Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z; typing in a field keeps the
    // field's own undo.
    async undoRedo() {
      ws().engine.setView('top');
      ws()._frame();
      await raf(4);
      tool('standard');
      setField('sfw-stdh', 0);
      const undoBtn = ws().root.querySelector('.sfw-history [data-act="undo"]');
      const redoBtn = ws().root.querySelector('.sfw-history [data-act="redo"]');
      const ctrl = (k, shift) => document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: k, code: 'Key' + k.toUpperCase(), ctrlKey: true, shiftKey: !!shift, bubbles: true, cancelable: true,
      }));
      const before = counts().columns;
      await click([BAY / 2, BAY / 2, 0]);
      const placed = counts().columns;
      const undoEnabled = undoBtn.getAttribute('aria-disabled') === 'false';
      ctrl('z'); await raf(2); const afterCtrlZ = counts().columns;
      const redoEnabled = redoBtn.getAttribute('aria-disabled') === 'false';
      ctrl('y'); await raf(2); const afterCtrlY = counts().columns;
      ctrl('z'); ctrl('z', true); await raf(2); const afterShiftZ = counts().columns;
      undoBtn.click(); await raf(2); const afterButton = counts().columns;
      const field = ws().$('sfw-stdh');
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
      await raf(2);
      const afterFieldCtrlZ = counts().columns;
      field.blur();
      tool('select');
      const v = ws().root.querySelector('.sfw-viewbar').getBoundingClientRect();
      const h = ws().root.querySelector('.sfw-history').getBoundingClientRect();
      return {
        before, placed, undoEnabled, afterCtrlZ, redoEnabled, afterCtrlY, afterShiftZ, afterButton, afterFieldCtrlZ,
        besideView: h.left >= v.right && Math.abs(h.top - v.top) < 4,
      };
    },

    // The mouse's Back button is swallowed over the canvas, not navigated.
    async historyButtons() {
      const c = canvasCenter();
      const notCancelled = navPointer('pointerdown', c, { button: 3, buttons: 8 });
      navPointer('pointerup', c, { button: 3 });
      return { backPrevented: notCancelled === false, open: !ws().root.hidden };
    },

    async lineView() {
      ws().engine.setView('home');
      ws()._frame();
      await raf(6);
      toggle('skeleton');
      await raf(10);
      return { coverage: coverage() };
    },

    async solidAgain() {
      toggle('skeleton');
      await raf(10);
      const t = ws().state.takeoff();
      const bom = ws()._bom;
      return {
        coverage: coverage(),
        legs: t.legs.length,
        deadLb: Math.round(t.totals.deadLb),
        liveLb: Math.round(t.totals.liveLb),
        bomLineItems: bom && bom.summary ? bom.summary.lineItemCount : null,
        bomWeightLb: bom && bom.summary ? bom.summary.totalWeightLb : null,
        counts: counts(),
      };
    },
  };

  return {
    names: Object.keys(steps),
    async run(name) {
      const t0 = performance.now();
      const out = await steps[name]();
      await raf(2);
      return Object.assign({ name, ms: Math.round(performance.now() - t0) }, out);
    },
    // Render on demand so the orchestrator screenshots a fresh frame.
    paint() {
      const e = ws().engine;
      e.renderer.render(e.scene, e.camera);
      return true;
    },
    drainErrors() { const e = errors.slice(); errors.length = 0; return e; },
  };
})();
true;
