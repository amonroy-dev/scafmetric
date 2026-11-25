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

  /** The view cube's home button: its state, and whether its words are showing. */
  function homeButton() {
    const b = ws().root.querySelector('.sfw-viewcube-home');
    const label = b.querySelector('.sfw-viewcube-home-label');
    return {
      icon: !!b.querySelector('svg'),
      flat: b.classList.contains('is-flat'),
      label: !!label && getComputedStyle(label).display !== 'none' ? label.textContent : null,
      pulsing: getComputedStyle(b).animationName !== 'none',
    };
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
    if (b) { b.click(); return; }
    // The centerline view has no button any more; it is still what the DXF
    // exports, so the check flips it directly.
    if (name === 'skeleton') { ws().skeleton = !ws().skeleton; ws()._rebuildContent(); }
  }

  function hint() { return ws().$('sfw-hint').textContent; }

  /**
   * The canvas, drawn now. The builder draws on demand, and a WebGL drawing
   * buffer is cleared once presented, so reading pixels in a frame that drew
   * nothing would read a blank canvas. Draw, then read in the same task.
   */
  function snapshotCanvas() {
    const e = ws().engine;
    e.renderer.render(e.scene, e.camera);
    const c = canvas();
    const off = document.createElement('canvas');
    off.width = Math.min(480, c.width);
    off.height = Math.round(off.width * (c.height / c.width));
    off.getContext('2d').drawImage(c, 0, 0, off.width, off.height);
    return off;
  }

  /** Fraction of canvas pixels that differ from the scene background. */
  function coverage() {
    const off = snapshotCanvas();
    const w = off.width, h = off.height;
    const ctx = off.getContext('2d');
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
    const off = snapshotCanvas();
    const w = off.width, h = off.height;
    const ctx = off.getContext('2d');
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
      // The first click brings up the notice, not the builder: it has to be
      // read and both statements ticked before the builder will open.
      const trigger = document.querySelector('[data-open-scaffold]');
      const button = { name: trigger.querySelector('strong')?.textContent || null, note: trigger.querySelector('small')?.textContent || null };
      trigger.click();
      for (let i = 0; i < 120 && !document.querySelector('dialog.sfn[open]'); i++) await raf(1);
      const page = document.querySelector('dialog.sfn[open]');
      if (!page) throw new Error('the scaffold builder notice never came up');
      const agree = page.querySelector('.sfn-agree');
      const boxes = [...page.querySelectorAll('input[type="checkbox"]')];
      const notice = {
        title: page.querySelector('h1').textContent,
        boxes: boxes.length,
        builderHeldBack: !(ws() && ws().engine) && document.getElementById('scaffold-modal').hidden,
        agreeLockedAtFirst: agree.disabled,
      };
      boxes[0].click();
      notice.agreeLockedWithOneTick = agree.disabled;
      boxes[1].click();
      notice.agreeOpenWithBoth = !agree.disabled;
      agree.click();
      for (let i = 0; i < 300 && !(ws() && ws().engine); i++) await raf(1);
      if (!(ws() && ws().engine)) throw new Error('engine never started');
      notice.goneAfterAgreeing = !document.querySelector('dialog.sfn');
      // Asked once: the button now goes straight to the builder.
      trigger.click();
      await raf(4);
      notice.askedAgain = !!document.querySelector('dialog.sfn');
      await raf(30);
      // Measure teal with the grid hidden: its thin centre axes are teal too.
      // The canvas draws on demand: a change made from outside asks for a frame.
      ws().engine.grid.visible = false;
      ws().engine.invalidate();
      await raf(3);
      const tealOnEmpty = coverage();
      ws().engine.grid.visible = true;
      ws().engine.invalidate();
      await raf(3);
      const initial = {
        projection: ws().engine.projection, camDir: camDir(), tool: ws().tools.tool,
        activeButton: (ws().root.querySelector('.sfw-tool.is-active') || {}).dataset?.tool || null,
        toolOrder: [...ws().root.querySelectorAll('.sfw-tool[data-tool]')].slice(0, 4).map(b => b.dataset.tool),
        blockCard: !ws().$('sfw-blockcard').hidden && !ws().$('sfw-toolcard').hidden,
        home: homeButton(),
        // Teal pixels on an empty model: the old beam line drew a teal bar here.
        coverage: tealOnEmpty,
        undoDisabled: ws().root.querySelector('.sfw-history [data-act="undo"]').getAttribute('aria-disabled'),
      };
      return { gl: glInfo(), counts: counts(), coverage: coverage(), hint: hint(), initial, notice, button };
    },

    // Esc drops any tool back to Select, through a real document-level keypress.
    async escToSelect() {
      // The rest of the walkthrough builds from the home view.
      ws().engine.setView('home');
      await raf(8);
      const homeIn3d = homeButton();
      tool('brace');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await raf(2);
      const fromBrace = ws().tools.tool;
      tool('standard');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await raf(2);
      return {
        fromBrace, fromStandard: ws().tools.tool, homeIn3d,
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
      // The box is drawn on the screen, so it goes round the stacks as they
      // appear: every foot and every top, left to right (a window box).
      const st = ws().state;
      const pts = [...st.standards.values()].flatMap(c => [project([c.x, c.y, 0]), project([c.x, c.y, st.baseOffsetFt() + st.standardHeightFt(c)])]);
      const from = { x: Math.min(...pts.map(p => p.x)) - 12, y: Math.min(...pts.map(p => p.y)) - 12 };
      const to = { x: Math.max(...pts.map(p => p.x)) + 12, y: Math.max(...pts.map(p => p.y)) + 12 };
      pointer('pointermove', from); pointer('pointerdown', from);
      for (let i = 1; i <= 8; i++) { pointer('pointermove', { x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }, { held: true }); await raf(1); }
      pointer('pointerup', to);
      await raf(2);
      const selected = ws().selection.length;
      ws().selection = [];
      ws().tools.selection.clear();
      ws()._rebuildContent();
      await raf(3);
      return { selected, counts: counts() };
    },

    // Holding Shift over a node previews the whole level at once, without
    // moving the mouse, as in ScaffoldPro; letting go goes back to one ledger.
    async shiftPreviewInPlace() {
      tool('ledger');
      await hover([0, 0, levelZ(0, 0, 5)]);
      const t = ws().tools;
      const single = t.ghostGroup.children.length;
      const singleHint = hint();
      const f0 = ws().engine.framesRendered;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true, bubbles: true }));
      await raf(2);
      const held = t.ghostGroup.children.length;
      const drew = ws().engine.framesRendered - f0;
      const batchPending = !!t._pendingBatch;
      const heldHint = hint();
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
      await raf(2);
      const released = t.ghostGroup.children.length;
      const releasedPending = !!t._pendingBatch;
      // Shift typed into a field, with the pointer off the canvas (it is on the
      // field being typed in), is typing: it must not start a fill. With the
      // pointer still out on the canvas the same key IS for the tool; the brace
      // step checks that side of it.
      canvas().dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }));
      await raf(1);
      const field = ws().$('sfw-stdh');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true, bubbles: true }));
      await raf(2);
      const inField = { ghosts: t.ghostGroup.children.length, shiftHeld: t.shiftHeld, batchPending: !!t._pendingBatch };
      field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
      await raf(1);
      return { single, held, released, drew, batchPending, releasedPending, inField, singleHint, heldHint, counts: counts() };
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
      const ghosts = ws().tools.ghostGroup.children.length;
      const hoverHint = hint();
      // A dropdown in the Brace card keeps the keyboard focus after it is used.
      // With the pointer still out on the face, Shift pressed then must show
      // the perimeter at once, not wait for the mouse to move.
      const sides = ws().$('sfw-brace-filter');
      sides.focus();
      sides.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true, cancelable: true }));
      await raf(2);
      const batch = ws().tools._pendingBatch;
      const shiftFromField = { focus: document.activeElement === sides, count: batch ? batch.count : 0, hint: hint() };
      sides.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      sides.blur();
      await raf(2);
      return {
        ghosts,
        target: target ? { levelA: target.levelA, levelB: target.levelB, spanFt: +target.spanFt.toFixed(4) } : null,
        miss: ws().tools.braceMiss, hint: hoverHint, shiftFromField,
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
    // The whole run is one edit: one undo step, so one Ctrl+Z takes it all back.
    async braceShiftFill() {
      const before = counts().braces;
      const steps0 = ws().state._history.length;
      await click(frontFace(3), { shift: true });
      ws()._frame();
      await raf(6);
      const added = counts().braces - before;
      const undoSteps = ws().state._history.length - steps0;
      // The builder listens for its shortcuts on the document.
      const ctrl = k => document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: k, code: 'Key' + k.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true,
      }));
      ctrl('z');
      await raf(2);
      const afterUndo = counts().braces;
      ctrl('y');
      await raf(2);
      return { added, undoSteps, afterUndo, before, afterRedo: counts().braces - before, counts: counts(), hint: hint() };
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
        // Members are instanced: a hit's data lives at its instanceId.
        hits: raw.slice(0, 6).map(h => {
          const d = (h.object.userData?.items || [])[h.instanceId] || h.object.userData || {};
          return d.kind + (d.proxy ? '*' : '');
        }),
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

    // A live load on a planked bay: point at the deck and click. R turns the
    // load across the planks; SHIFT takes the whole platform.
    async liveLoadPatch() {
      tool('liveload');
      const field = ws().$('sfw-bay-psf');
      const defaults = { value: field.value, placeholder: field.placeholder, dir: ws().$('sfw-load-dir').value };
      setField('sfw-bay-psf', 75);
      const before = counts().liveLoads;
      // Look straight down at the bay so the patch, if it renders, is unmissable.
      ws().engine.setView('top');
      await raf(6);
      // From above the pointer lands on the highest deck over that spot.
      const decks = ws().state.plankBays();
      const top = decks.reduce((a, b) => (b.z > a.z ? b : a));
      const at = [top.frame.center.x, top.frame.center.y, top.z];
      const loadOnTop = () => [...ws().state.liveLoads.values()].find(l => l.deckId === top.id) || null;
      // Planked, but nothing placed yet: the planks carry no live load.
      const liveBefore = Math.round(ws().state.takeoff().totals.liveLb);
      const cyanBefore = cyanFraction();
      await hover(at);
      const ghosts = ws().tools.ghostGroup.children.length;
      const hoverHint = hint();
      await click(at);
      await raf(8);
      const cyanAfter = cyanFraction();
      const placed = loadOnTop();
      const load = placed ? { psf: placed.psf, across: !!placed.across } : null;
      const added = counts().liveLoads - before;
      const t = ws().state.takeoff();
      const placedLiveLb = Math.round(t.placedLiveLb || 0);

      // R, with the pointer still on the bay: the card and the preview follow,
      // and a click turns the load that is already there.
      key('r');
      await raf(2);
      const turned = { across: ws().tools.liveLoadAcross, dir: ws().$('sfw-load-dir').value, hint: hint(), ghosts: ws().tools.ghostGroup.children.length };
      await click(at);
      turned.loadAcross = !!(loadOnTop() || {}).across;
      turned.loads = counts().liveLoads - before;
      key('r');
      await raf(2);

      // SHIFT: every bay of that platform.
      const level = decks.filter(d => Math.abs(d.z - top.z) < 0.1);
      await click(at, { shift: true });
      await raf(6);
      const loaded = level.filter(d => [...ws().state.liveLoads.values()].some(l => l.deckId === d.id)).length;
      return {
        defaults, ghosts, hoverHint, added, load, turned,
        platform: { decks: level.length, loaded, hint: hint() },
        cyanBefore, cyanAfter, cyanDelta: +(cyanAfter - cyanBefore).toFixed(5),
        liveBefore,
        placedLiveLb,
        counts: counts(),
      };
    },

    // R rotates the block preview in 90 degree steps.
    // The Block tool brings up ScaffoldPro's block card; its fields drive the
    // ghost, and R turns the ghost at once, without moving the mouse.
    async blockCard() {
      tool('block');
      const card = ws().$('sfw-blockcard');
      const shown = !!card && !card.hidden;
      const field = k => card.querySelector(`[data-block="${k}"]`);
      const defaults = ['widthFt', 'depthFt', 'heightFt', 'plankedLevelsCount'].map(k => field(k).value).join(',');
      const set = (k, v) => {
        const el = field(k);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
      };
      set('widthFt', 8); set('depthFt', 6); set('heightFt', 13); set('braceFrontBack', 'slash');
      const summary = ws().$('sfw-block-summary').textContent;
      await hover([-11, 3, 0]);
      const ghosts = ws().tools.ghostGroup.children.length;
      const before = ws().tools.rotationSteps;
      const f0 = ws().engine.framesRendered;
      key('r');
      await raf(2);
      const turned = { steps: ws().tools.rotationSteps, drew: ws().engine.framesRendered - f0, hint: hint() };
      for (let i = 0; i < 3; i++) key('r'); // back round to square, for the placement below
      await raf(2);
      return { shown, defaults, settings: { ...ws().tools.blockSettings }, summary, ghosts, before, turned, after: ws().tools.rotationSteps };
    },

    // A click places the block the ghost shows: standards, ledgers, bracing and a deck.
    async blockPlace() {
      const before = counts();
      const steps0 = ws().state._history.length;
      await click([-11, 3, 0]);
      ws()._frame();
      await raf(8);
      const after = counts();
      const xs = [...new Set([...ws().state.standards.values()].filter(s => s.x < -1).map(s => s.x))].sort((a, b) => a - b);
      return {
        addedColumns: after.columns - before.columns,
        addedLedgers: after.ledgers - before.ledgers,
        addedBraces: after.braces - before.braces,
        addedDecks: after.decks - before.decks,
        undoSteps: ws().state._history.length - steps0,
        xs, counts: after, hint: hint(),
      };
    },

    // A second block near the first snaps onto its face and shares those
    // standards instead of standing a second set beside (or on) them.
    async blockSnap() {
      const s = ws().state;
      const before = counts();
      const shared = [...s.standards.values()].filter(p => p.x === -15).map(p => p.segments.length).join();
      await hover([-18.2, 3.2, 0]);
      const snappedHint = hint();
      await click([-18.2, 3.2, 0]);
      ws()._frame();
      await raf(8);
      const after = counts();
      return {
        snappedHint,
        addedColumns: after.columns - before.columns,
        sharedUnchanged: [...s.standards.values()].filter(p => p.x === -15).map(p => p.segments.length).join() === shared,
        newXs: [...new Set([...s.standards.values()].map(p => p.x))].filter(x => x < -15),
        counts: after,
      };
    },

    // The canvas draws when something changes and otherwise sits still, and the
    // model is drawn instanced, so a frame stays cheap as the job grows.
    async renderOnDemand() {
      const e = ws().engine;
      tool('select');
      await raf(4);
      let f0 = e.framesRendered;
      await raf(20);
      const idleFrames = e.framesRendered - f0;
      // A hover that shows a ghost asks for a frame.
      tool('standard');
      setField('sfw-stdh', 0);
      f0 = e.framesRendered;
      await hover([BAY * 6, BAY * 3, 0]);
      const hoverFrames = e.framesRendered - f0;
      const ghosts = ws().tools.ghostGroup.children.length;
      // Moving the camera draws without being asked.
      f0 = e.framesRendered;
      const c = canvasCenter();
      await middleDrag(c, { x: c.x + 60, y: c.y + 20 });
      const panFrames = e.framesRendered - f0;
      // Leaving the canvas clears the ghost, then it goes quiet again.
      tool('select');
      await raf(4);
      f0 = e.framesRendered;
      await raf(20);
      const idleAgain = e.framesRendered - f0;
      e.invalidate();
      await raf(2);
      const calls = e.renderer.info.render.calls;
      let meshes = 0;
      ws().contentGroup.traverse(o => { if (o.isMesh) meshes++; });
      let members = 0;
      for (const o of ws().contentGroup.children) members += o.isInstancedMesh ? o.count : 1;
      return { idleFrames, hoverFrames, ghosts, panFrames, idleAgain, drawCalls: calls, contentObjects: meshes, members, counts: counts() };
    },

    // A face whose standards are too short must SAY so, not fail silently.
    async braceShortStackMessage() {
      tool('standard');
      setField('sfw-stdh', 0);
      await click([-14, -14, 0]);
      await click([-14 + BAY, -14, 0]);
      ws()._frame();
      await raf(6);
      // With its base collar a single segment has five rosettes, enough for a
      // diagonal from the collar's. Without one it has four, which is short.
      const collar = ws().$('sfw-collar');
      const setCollar = on => { collar.checked = on; collar.dispatchEvent(new Event('change', { bubbles: true })); };
      setCollar(true);
      tool('brace');
      const zWith = levelZ(-14, -14, 2);
      await hover([-14 + BAY / 2, -14 - 0.08, zWith + 0.5]);
      const withCollar = ws().tools.braceMiss;
      setCollar(false);
      await raf(2);
      const z = levelZ(-14, -14, 2);
      await hover([-14 + BAY / 2, -14 - 0.08, z + 0.5]);
      const out = { miss: ws().tools.braceMiss, hint: hint(), withCollar };
      setCollar(true);
      await raf(2);
      return out;
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

    // A selection box works in any view and takes any part, as ScaffoldPro's
    // does. In the Front view the old ground-plane marquee could select nothing.
    async marqueeFrontView() {
      tool('select');
      ws().engine.setView('front');
      ws()._frame();
      await raf(6);
      const r = canvas().getBoundingClientRect();
      const a = { x: r.right - 12, y: r.top + 70 }, b = { x: r.left + 12, y: r.bottom - 12 };
      pointer('pointermove', a);
      pointer('pointerdown', a);
      for (let i = 1; i <= 6; i++) { pointer('pointermove', { x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }, { held: true }); await raf(1); }
      const box = document.querySelector('[data-marquee]');
      // Seen, not merely present: nothing may be drawn over the middle of the box
      // except the box's own canvas (the box ignores the pointer, so the element
      // under that point is the canvas only when the box is not buried).
      let during = null;
      if (box) {
        const br = box.getBoundingClientRect();
        const under = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        const style = getComputedStyle(box);
        during = {
          shown: box.style.display === 'block', mode: box.dataset.marquee, width: br.width,
          inBuilder: ws().root.contains(box), onTop: under === canvas(),
          border: style.borderTopWidth, visible: style.visibility === 'visible' && br.height > 20,
        };
      }
      pointer('pointerup', b);
      await raf(2);
      const s = ws().state;
      const ids = ws().selection.slice();
      const kinds = {};
      for (const id of ids) { const k = ws()._kindOf(id); kinds[k] = (kinds[k] || 0) + 1; }
      const hidden = box ? box.style.display === 'none' : false;
      // A left-to-right box round one standard only, top to bottom: a window.
      const col = [...s.standards.values()].find(c => c.x === 0 && c.y === 0);
      const top = project([0, 0, s.baseOffsetFt() + s.standardHeightFt(col)]), foot = project([0, 0, 0]);
      const w1 = { x: foot.x - 6, y: top.y - 6 }, w2 = { x: foot.x + 6, y: foot.y + 6 };
      pointer('pointermove', w1); pointer('pointerdown', w1);
      for (let i = 1; i <= 4; i++) { pointer('pointermove', { x: w1.x + (w2.x - w1.x) * i / 4, y: w1.y + (w2.y - w1.y) * i / 4 }, { held: true }); await raf(1); }
      const windowMode = box ? box.dataset.marquee : null;
      pointer('pointerup', w2);
      await raf(2);
      const windowKinds = {};
      for (const id of ws().selection) { const k = ws()._kindOf(id); windowKinds[k] = (windowKinds[k] || 0) + 1; }
      // Esc lets go of the selection.
      const beforeEsc = ws().selection.length;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      await raf(2);
      const esc = { before: beforeEsc, after: ws().selection.length, toolsAfter: ws().tools.selection.size, props: ws().$('sfw-props').textContent };
      return { esc, during, hidden, selected: ids.length, kinds, total: { standards: s.standards.size, ledgers: s.ledgers.size, braces: s.braces.size }, windowMode, windowKinds };
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

    // The base collar's rosette is a node (lift 0) a ledger can run from, and
    // a side bracket hangs as a frame with a rosette at its tip that a ledger
    // can run from too, along the row of brackets.
    async bracketsAndCollar() {
      ws().engine.setView('home');
      ws()._frame();
      await raf(4);
      const s = ws().state;
      const ledgerAt = z => s.ledgerList().filter(l => Math.abs(l.a[2] - z) < 1e-6 && Math.abs(l.b[2] - z) < 1e-6);

      tool('ledger');
      const collarZ = levelZ(0, 0, 0);
      const collarBefore = collarZ === null ? 0 : ledgerAt(collarZ).length;
      if (collarZ !== null) await click([0, 0, collarZ]);
      const collarLedgers = collarZ === null ? 0 : ledgerAt(collarZ).length - collarBefore;

      tool('bracket');
      const hosts = [[BAY, 0], [BAY, BAY]].map(([x, y]) => s.nodes().find(n => !n.bracketId && n.x === x && n.y === y && n.level === 3));
      const bracketsBefore = s.brackets.size, nodesBefore = s.nodes().length;
      // Both out along +X, so their tips make a row: R turns each one there.
      for (const n of hosts) {
        await hover([n.x, n.y, n.z]);
        for (let i = 0; i < 4 && (ws().tools._bracketDir(n) || []).join() !== '1,0'; i++) { key('r'); await raf(1); }
        if ((ws().tools._bracketDir(n) || []).join() !== '1,0') throw new Error(`R never turned the bracket at ${n.x},${n.y} to +X`);
        await click([n.x, n.y, n.z]);
      }
      ws().tools.bracketTurn = 0;
      const added = [...s.brackets.values()].slice(bracketsBefore);
      let members = 0;
      for (const o of ws().contentGroup.children) for (const d of o.userData.items || []) if (d.kind === 'bracket' && !d.proxy && added.some(k => k.id === d.id)) members++; // the invisible pick target along the arm is not a member
      const tips = s.nodes().filter(n => added.some(k => k.id === n.bracketId));

      // From one tip, the ledger tool runs to the next tip along the row.
      tool('ledger');
      const before = s.ledgers.size;
      if (tips[0]) await click([tips[0].x, tips[0].y, tips[0].z]);
      const l = s.ledgers.size > before ? s.ledgerList().pop() : null;
      const onTip = p => tips.some(t => Math.hypot(t.x - p[0], t.y - p[1], t.z - p[2]) < 1e-6);
      ws()._frame();
      await raf(6);
      return {
        collarZ, collarLedgers,
        bracketsAdded: added.length, members, tipNodes: tips.length, nodesAdded: s.nodes().length - nodesBefore,
        tipLedger: l ? { a: onTip(l.a), b: onTip(l.b) } : null,
        counts: counts(), hint: hint(),
      };
    },

    // R with the Bracket tool turns the previewed bracket to the next free
    // direction at once, and the click hangs it that way (ScaffoldPro).
    async bracketTurnR() {
      tool('bracket');
      const s = ws().state, t = ws().tools;
      const node = s.nodes().find(n => !n.bracketId && n.x === 0 && n.y === BAY && n.level === 3);
      await hover([node.x, node.y, node.z]);
      const before = t._bracketDir(node);
      const ghostsBefore = t.ghostGroup.children.length;
      const f0 = ws().engine.framesRendered;
      key('r');
      await raf(2);
      const after = t._bracketDir(node);
      const drew = ws().engine.framesRendered - f0;
      const turnedHint = hint();
      // Shift, pointer still: a bracket on every standard along the run.
      key('Shift', { shift: true });
      await raf(2);
      const run = { count: t._pendingBatch ? t._pendingBatch.count : 0, hint: hint() };
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      await raf(2);
      const count = s.brackets.size;
      await click([node.x, node.y, node.z]);
      const placed = [...s.brackets.values()].pop();
      t.bracketTurn = 0;
      return {
        before, after, ghostsBefore, ghostsAfter: t.ghostGroup.children.length, drew, turnedHint, run,
        added: s.brackets.size - count, placedDir: placed ? placed.dir : null,
      };
    },

    // R with the Plank tool turns the boards across the hovered opening, decking
    // off the other pair of ledgers (ScaffoldPro), and the click lays them so.
    async plankTurnR() {
      ws().engine.setView('home');
      ws()._frame();
      await raf(4);
      tool('plank');
      const s = ws().state, t = ws().tools;
      const z0 = s.liftZ(0);
      const l = s.ledgerList().find(q => q.a[1] === 0 && q.b[1] === 0 && Math.max(q.a[0], q.b[0]) <= -7 && Math.abs(q.a[2] - z0) < 1e-6);
      if (!l) throw new Error('no collar-level front ledger on the block');
      await hover(besideLedger(l));
      const rot = () => (t.ghostGroup.children[0] ? +t.ghostGroup.children[0].rotation.z.toFixed(4) : null);
      const before = rot();
      key('r');
      await raf(2);
      const after = rot();
      const turnedHint = hint();
      const decks = s.plankBays().length;
      await click(besideLedger(l));
      const placed = s.plankBays().find(d => Math.abs(d.z - z0) < 0.1 && d.x0 >= -15.01 && d.x1 <= -6.99);
      return {
        before, after, turnedHint,
        added: s.plankBays().length - decks,
        placedRotation: placed && placed.boards[0] ? +placed.boards[0].rotationZ.toFixed(4) : null,
      };
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

    // Send to beam: the legs are picked by clicking them (from above, where a
    // leg is a dot under its load tag), the beam is drawn under the picks, the
    // Import button is in the card, and the beam form gets whole pounds.
    async sendToBeam() {
      const s = ws().state;
      ws().engine.setView('top');
      ws()._frame();
      await raf(8);
      ws().root.querySelector('.sfw-tool[data-tool="beam"]').click();
      await raf(4);
      const rows = () => [...ws().$('sfw-rows').querySelectorAll('tr')].map(r => [...r.children].map(c => c.textContent));
      const drawn = () => ws().beamGroup.children.length;
      const opened = {
        tool: ws().tools.tool,
        active: (ws().root.querySelector('.sfw-tool.is-active') || {}).dataset?.tool || null,
        title: ws().$('sfw-tool-title').textContent,
        rows: rows(),
        importInCard: !!ws().$('sfw-toolcard').querySelector('#sfw-import'),
        importDisabled: ws().$('sfw-import').disabled,
        footer: !!ws().root.querySelector('.sfw-foot'),
        oldControls: ['sfw-axis', 'sfw-pos', 'sfw-pick'].filter(id => ws().$(id)).length,
        drawn: drawn(),
      };
      // The longest row of legs running left to right, and the first three of it.
      const byRow = new Map();
      for (const c of s.standards.values()) {
        const k = Math.round(c.y * 100);
        if (!byRow.has(k)) byRow.set(k, []);
        byRow.get(k).push(c);
      }
      const row = [...byRow.values()].sort((a, b) => b.length - a.length)[0].sort((a, b) => a.x - b.x);
      const three = row.slice(0, 3);
      const topOf = c => [c.x, c.y, s.standardTopZ(c)];
      await hover(topOf(three[1]));
      const hovered = { cursor: canvas().style.cursor, hint: hint(), lit: ws().tools.ghostGroup.children.length };
      // Clicked out of order: the beam still starts under the leftmost.
      for (const c of [three[1], three[0], three[2]]) await click(topOf(c));
      const takeoff = new Map(s.takeoff().legs.map(l => [l.id, l]));
      const want = three.map((c, i) => {
        const l = takeoff.get(c.id);
        return { n: String(i + 1), dead: Math.round(l.deadLb), live: Math.round(l.liveLb), at: Math.round((c.x - three[0].x) * 100) / 100 };
      });
      const picked = {
        ids: [...ws().beamLegs].sort().join(), wanted: three.map(c => c.id).sort().join(),
        rows: rows(), drawn: drawn(), importDisabled: ws().$('sfw-import').disabled,
        selected: ws().selection.length,
      };
      // A second click takes a leg off; a third puts it back.
      await click(topOf(three[2]));
      const afterSecondClick = ws().beamLegs.size;
      await click(topOf(three[2]));
      // Moving the first leg in from the support moves every distance with it.
      const first = ws().$('sfw-first');
      first.value = '2';
      first.dispatchEvent(new Event('input', { bubbles: true }));
      await raf(3);
      const inboard = rows().map(r => r[1]);
      first.value = '0';
      first.dispatchEvent(new Event('input', { bubbles: true }));
      await raf(3);
      // Over to the beam form.
      ws().$('sfw-import').click();
      await sleep(300);
      const formRows = [...document.querySelectorAll('.load-row[data-scaffold-import]')].map(r => ({
        dead: r.querySelector('.point-dead').value, live: r.querySelector('.point-live').value, at: r.querySelector('.point-location').value,
      }));
      const closedByImport = ws().root.hidden;
      const note = (document.querySelector('[data-scaffold-note]') || {}).textContent || null;
      ws().open();
      await raf(6);
      // Esc puts Select back in hand: the beam goes with the card, the picks are kept.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await raf(4);
      const afterEsc = { tool: ws().tools.tool, drawn: drawn(), kept: ws().beamLegs.size, cardHidden: ws().$('sfw-toolcard').hidden };
      ws().engine.setView('home');
      ws()._frame();
      await raf(6);
      return { opened, hovered, picked, want, afterSecondClick, inboard, formRows, closedByImport, note, afterEsc };
    },

    // Side brackets that carry something: standards seated in their sockets
    // with "On side brackets" ticked (SHIFT takes the row), and boards laid
    // from arm to arm with the Plank tool. Their load must come down the legs
    // the brackets hang on.
    async onSideBrackets() {
      const s = ws().state, t = ws().tools;
      // A run of its own, clear of the rest of the model: two bays, one deck.
      const before = { ...t.blockSettings };
      t.setBlockSettings({ widthFt: 14, depthFt: 3, heightFt: 13, plankedLevelsCount: 1, includeBaseDeck: false, guardrails: false, braceFrontBack: 'off', braceLeftRight: 'off' });
      const existing = new Set(s.standards.keys());
      t.placeBlockAt({ plan: t._blockPlan(), center: { x: 90, y: 0 }, snapped: false, rotationSteps: 0 });
      t.setBlockSettings(before);
      const mine = [...s.standards.values()].filter(c => !existing.has(c.id));
      const front = Math.min(...mine.map(c => c.y));
      const deckZ = Math.max(...s.plankBays().filter(d => d.frame.center.x > 80).map(d => d.z));
      const nodes = s.nodes();
      const hosts = mine.filter(c => Math.abs(c.y - front) < 1e-6).sort((a, b) => a.x - b.x);
      const ks = hosts.map(c => s.addBracket(nodes.find(n => n.columnId === c.id && Math.abs(n.z - deckZ) < 1e-6), [0, -1], 2));
      // Framed on this run alone: the whole model is far wider by now.
      const box = ws()._modelBox();
      box.min.set(80, -6, 0);
      box.max.set(100, 4, 16);
      ws().engine.setView('home');
      ws().engine.frame(box);
      await raf(8);
      const legLoad = () => Object.fromEntries(s.takeoff().legs.filter(l => l.x > 80).map(l => [`${l.x},${l.y}`, Math.round(l.deadLb * 100) / 100]));
      const legsBefore = s.takeoff().legs.length;

      // Standards: tick the box, SHIFT over one socket, click.
      tool('standard');
      await raf(3);
      const tick = ws().$('sfw-std-brackets');
      const label = tick.closest('label').textContent.trim();
      tick.click();
      await raf(3);
      const socket = [ks[1].x, ks[1].y - 2, ks[1].z];
      await hover(socket, { shift: true });
      const standardPreview = { hint: hint(), ghosts: t.ghostGroup.children.length, pending: t._pendingBatch ? t._pendingBatch.count : 0 };
      const standardsBefore = s.standards.size;
      await click(socket, { shift: true });
      const seated = [...s.standards.values()].filter(c => c.bracketId);
      // On open ground the tool stands nothing while the box is ticked.
      await click([90, -14, 0]);
      const stood = {
        added: s.standards.size - standardsBefore, seated: seated.length, legs: s.takeoff().legs.length - legsBefore,
        onLifts: seated.every(c => s.nodes().filter(n => n.columnId === c.id && !n.bracketId).every(n => Math.abs(n.z - s.liftZ(n.level)) < 1e-9)),
        footAboveBracket: Math.round((s.standardBaseZ(seated[0]) - ks[0].z) * 12 * 10000) / 10000,
        bases: ws().contentGroup.children.reduce((n, o) => n + (o.userData.items || []).filter(d => d.kind === 'base' && seated.some(c => c.id === d.id)).length, 0),
      };
      tick.click();
      await raf(2);

      // Decks: the Plank tool pointed at a bracket's arm, SHIFT for the row.
      const before2 = legLoad();
      tool('plank');
      await raf(3);
      const onArm = [ks[1].x, ks[1].y - 1, ks[1].z];
      await hover(onArm, { shift: true });
      const deckPreview = { hint: hint(), ghosts: t.ghostGroup.children.length, pending: t._pendingBatch ? t._pendingBatch.count : 0 };
      const decksBefore = s.plankBays().length;
      await click(onArm, { shift: true });
      const decks = s.plankBays().filter(d => d.frame.center.x > 80 && d.frame.center.y < front);
      const after2 = legLoad();
      const moved = Object.fromEntries(Object.keys(after2).map(k => [k, Math.round((after2[k] - before2[k]) * 100) / 100]));
      const frontKeys = hosts.map(c => `${c.x},${c.y}`);
      const backMoved = Object.keys(moved).filter(k => !frontKeys.includes(k)).map(k => moved[k]);
      const psf = s.components.plank.areaWeightLbPerFt2;
      const decked = {
        added: s.plankBays().length - decksBefore,
        alongFace: decks.every(d => Math.abs(d.frame.along.x) > 0.99),
        boards: decks.map(d => d.boards.length).join(),
        onFrontLegs: frontKeys.every(k => moved[k] > 0),
        // Out past the front legs, the decks lever a little off the back ones.
        offBackLegs: backMoved.length === 3 && backMoved.every(v => v < 0),
        net: Math.round(Object.values(moved).reduce((a, b) => a + b, 0) * 10) / 10,
        deckLb: Math.round(decks.reduce((sum, d) => sum + d.boards.reduce((w, b) => w + b.widthIn / 12 * b.lengthFt * psf, 0), 0) * 10) / 10,
        ledgersAdded: 0,
      };
      tool('select');
      ws()._frame();
      await raf(6);
      return { label, standardPreview, stood, deckPreview, decked };
    },

    // A loaded bracket levers load off the leg behind it. Enough of it and that
    // leg is in uplift, and its tag says so. What it takes to hold the leg
    // down against overturning is a second tag with a larger number on it,
    // named for what it is, so that the uplift is never read as that. And a
    // beam under those legs is given no credit for the live load levered off.
    async bracketUplift() {
      const s = ws().state;
      const run = [...s.standards.values()].filter(c => !c.bracketId && c.x > 80);
      const front = Math.min(...run.map(c => c.y));
      const backs = run.filter(c => c.y > front + 1).sort((a, b) => a.x - b.x);
      const middle = backs[1];
      const tagsOf = id => ws().labelGroup.children.filter(c => c.userData.legId === id).map(c => ({ text: c.userData.text, holdDown: !!c.userData.holdDown }));
      const figures = () => {
        const l = s.takeoff().legs.find(x => x.id === middle.id);
        return {
          dead: Math.round(l.deadLb), live: Math.round(l.liveLb), total: Math.round(l.deadLb) + Math.round(l.liveLb),
          holdDown: Math.round(l.overturning ? l.overturning.holdDownLb : 0),
          factor: l.overturning ? Math.round(l.overturning.factor * 100) / 100 : null,
          liftedLive: Math.round(l.lifted ? l.lifted.liveLb : 0),
        };
      };
      const unloaded = { leg: figures(), tags: tagsOf(middle.id) };

      // 100 psf on the two decks the brackets carry, and nothing behind them.
      for (const d of s.plankBays().filter(d => d.frame.center.x > 80 && d.frame.center.y < front)) s.setDeckLiveLoad(d.id, 100);
      await raf(4);
      const loaded = { leg: figures(), tags: tagsOf(middle.id) };

      // Selected, the card names each figure.
      ws().selection = [middle.id];
      ws()._rebuildContent();
      ws()._refreshProps();
      await raf(3);
      const props = Object.fromEntries([...ws().$('sfw-props').querySelectorAll('.sfw-proplist > div')].map(d => [d.children[0].textContent, d.children[1].textContent]));
      ws().selection = [];
      ws()._rebuildContent();
      ws()._refreshProps();

      // On a beam: the back legs, picked in place of whatever was picked before.
      const kept = [...ws().beamLegs];
      ws().root.querySelector('.sfw-tool[data-tool="beam"]').click();
      await raf(3);
      ws().beamLegs.clear();
      for (const c of backs) ws().beamLegs.add(c.id);
      ws()._beamChanged();
      await raf(3);
      const onBeam = {
        rows: [...ws().$('sfw-rows').querySelectorAll('tr')].map(r => [...r.children].map(c => c.textContent)),
        note: ws().$('sfw-warn').hidden ? '' : ws().$('sfw-warn').textContent,
        tags: tagsOf(middle.id),
      };
      ws().beamLegs.clear();
      for (const id of kept) ws().beamLegs.add(id);
      ws()._beamChanged();
      tool('select');
      // Framed on this run from overhead, where the two tags must still read apart.
      const box = ws()._modelBox();
      box.min.set(80, -6, 0);
      box.max.set(100, 6, 16);
      ws().engine.setView('top');
      ws().engine.frame(box);
      await raf(8);
      return { unloaded, loaded, props, onBeam };
    },

    // Handrails on a row of standards seated in side brackets: the Ledger tool
    // with "Perimeter handrails" ticked. A click adds the short return at the
    // end of the row; SHIFT adds the rest round the outside of that level, and
    // nothing across the decks or over the rails the block laid round its own.
    async perimeterHandrails() {
      const s = ws().state, t = ws().tools;
      // A run of its own with its rails on: three bays, one deck, a bracket on each front leg.
      const before = { ...t.blockSettings };
      t.setBlockSettings({ widthFt: 21, depthFt: 5, heightFt: 10, plankedLevelsCount: 1, includeBaseDeck: false, guardrails: true, braceFrontBack: 'off', braceLeftRight: 'off' });
      const existing = new Set(s.standards.keys());
      t.placeBlockAt({ plan: t._blockPlan(), center: { x: 130.5, y: 0.5 }, snapped: false, rotationSteps: 0 });
      t.setBlockSettings(before);
      const mine = [...s.standards.values()].filter(c => !existing.has(c.id));
      const front = Math.min(...mine.map(c => c.y));
      const deckZ = Math.max(...s.plankBays().filter(d => d.frame.center.x > 115).map(d => d.z));
      const hosts = mine.filter(c => Math.abs(c.y - front) < 1e-6).sort((a, b) => a.x - b.x);
      const at0 = s.nodes();
      const ks = hosts.map(c => s.addBracket(at0.find(n => n.columnId === c.id && Math.abs(n.z - deckZ) < 1e-6), [0, -1], 2));
      for (const k of ks.slice(0, -1)) {
        const arm = s.supportList().find(l => l.bracketId === k.id);
        if (!s.addPlankOnLedger(arm.id, 1)) s.addPlankOnLedger(arm.id, -1);
      }
      for (const k of ks) s.addStandardOnBracket(k.id, 3.28125);
      const box = ws()._modelBox();
      box.min.set(118, -6, 0);
      box.max.set(143, 5, 13);
      ws().engine.setView('home');
      ws().engine.frame(box);
      await raf(8);

      const level = s.liftAt(deckZ) + 1;
      const z1 = s.liftZ(level), z2 = s.liftZ(level + 1);
      const outer = front - 2;
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
      const ledgersAt = z => s.ledgerList().filter(l => Math.abs(l.a[2] - z) < 1e-6 && Math.abs(l.b[2] - z) < 1e-6 && l.a[0] > 115);
      // Where the ledgers at a height are: along the bracket row, the two returns, or anywhere else.
      const where = z => {
        const out = { row: 0, returns: 0, elsewhere: 0 };
        for (const l of ledgersAt(z)) {
          const onRow = Math.abs(l.a[1] - outer) < 1e-6 && Math.abs(l.b[1] - outer) < 1e-6;
          const isReturn = [hosts[0], hosts[hosts.length - 1]].some(h => (near(l.a, [h.x, front]) && near(l.b, [h.x, outer])) || (near(l.b, [h.x, front]) && near(l.a, [h.x, outer])));
          out[onRow ? 'row' : isReturn ? 'returns' : 'elsewhere']++;
        }
        return out;
      };
      const pending = () => (t._pendingBatch ? t._pendingBatch.count : 0);
      // The previewed tubes on this run (the marker on the rosette is a sphere, unscaled).
      const ghostsHere = () => t.ghostGroup.children.filter(m => m.scale.y !== 1 && m.position.x > 115).length;

      tool('ledger');
      await raf(3);
      const tick = ws().$('sfw-ledger-outside');
      const card = { shown: !ws().$('sfw-toolcard').hidden, title: ws().$('sfw-tool-title').textContent, label: tick.closest('label').textContent.trim() };
      const middle = [hosts[1].x, outer, z1];
      // Without the tick, SHIFT is every open bay edge of the level, on every scaffold in the model.
      await hover(middle, { shift: true });
      const everyBay = { pending: pending(), here: ghostsHere(), hint: hint() };
      tick.click();
      await raf(3);
      const lit = s.nodes().filter(n => n.level === level && n.x > 115).filter(ws()._nodeValidator('ledger')).length;
      const ticked = { hint: hint(), lit, on: t.perimeterHandrails };

      // A click on the end standard of the row: the 2 ft return to the scaffold.
      const end = [hosts[0].x, outer, z1];
      await hover(end);
      const oneHint = hint();
      await click(end);
      const afterClick = where(z1);
      // SHIFT from the middle of the row: the rest of that level.
      await hover(middle, { shift: true });
      const preview = { pending: pending(), here: ghostsHere(), ghosts: t.ghostGroup.children.length, hint: hint() };
      await click(middle, { shift: true });
      const filled = { ...where(z1), hint: hint() };
      // The top rail, one lift up, confirmed with Enter in place of a click.
      await hover([hosts[2].x, outer, z2], { shift: true });
      const topPending = pending();
      key('Enter');
      await raf(3);
      const top = { ...where(z2), pending: topPending, hint: hint() };
      // A rosette between the two decks is on no outside face.
      await hover([hosts[1].x, front, z1]);
      const inside = { hint: hint(), ghosts: t.ghostGroup.children.length };
      // Nothing left to add; and no rail of the block's has a ledger laid over it.
      await hover(middle, { shift: true });
      const again = { pending: pending(), hint: hint() };
      const rails = [...s.guardrails.values()].filter(g => g.kind === 'rail' && g.a[0] > 115).length;

      tick.click();
      await raf(2);
      tool('select');
      ws().engine.frame(box);
      await raf(8);
      return { card, everyBay, ticked, oneHint, afterClick, preview, filled, top, inside, again, rails };
    },

    // A sideways wheel press arrives as the browser's Back, which the page
    // cannot cancel. While the builder is open, Back is undone (ScaffoldPro's
    // guard): same page, builder still open. Closing it removes the guard.
    async backGuard() {
      const settle = () => new Promise(r => setTimeout(r, 300));
      const guarded = !!(history.state && history.state.sfwBackGuard);
      const url = location.href;
      history.back();
      await settle();
      const out = { guarded, stillOpen: !ws().root.hidden, sameUrl: location.href === url, reArmed: !!(history.state && history.state.sfwBackGuard) };
      ws().close();
      await settle();
      out.releasedOnClose = !(history.state && history.state.sfwBackGuard);
      ws().open();
      await raf(6);
      return out;
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
