// three.js engine for the scaffold workspace: Z-up CAD scene, lighting, ground,
// grid, and ScaffoldPro's navigation.
//
// Navigation (ScaffoldPro / Inventor; the math lives in navigation.js):
//   - LEFT click / drag   : tools and selection only, never the camera
//   - MIDDLE drag         : pan, 1:1 in every view - the grabbed point stays
//                           under the cursor, including straight down in Top
//   - SHIFT + MIDDLE drag : orbit about the model, or what is under the cursor
//                           when zoomed in (perspective only; faces stay put)
//   - double MIDDLE click : Zoom Extents, keeping the view direction
//   - WHEEL               : zoom toward what is under the cursor
//   - RIGHT drag          : orbit (perspective) / pan (orthographic)
//   - PAN lock + LEFT     : pan;  SPACE or ALT + LEFT : as RIGHT drag
//   - Touch               : OrbitControls (one finger orbit/pan, two zoom/pan)
// ViewCube faces, Home and Zoom Extents travel on a fixed-time eased curve.
// The mouse's Back/Forward buttons, sideways wheel swipes and middle-click
// autoscroll are swallowed over the canvas so they cannot leave the page.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CAMERA_MAX_DISTANCE_FT, CAMERA_MIN_DISTANCE_FT, DRAG_THRESHOLD_PX, GESTURE_GAP_MS,
  ORBIT_SMOOTH_TIME_S, VIEW_TRANSITION_MS, ZOOM_EXTENTS_TRANSITION_MS,
  calculateZoomExtents, dollyAbout, interpolateView, modelVisibility, orbitAbout, orbitAngles,
  orthographicWorldPerPixel, panOffset, perspectiveWorldPerPixel, pointUnderCursor,
  resolveOrbitPivot, snapToNearestPoint, wheelPixels, wheelScale, withMinSpan, zoomOrthoAbout,
} from './navigation.js';

const HOME_DIR = new THREE.Vector3(0.75, -1, 0.72).normalize();
const VIEW_DIRS = {
  top: [0, 0, 1], bottom: [0, 0, -1],
  front: [0, -1, 0], back: [0, 1, 0],
  right: [1, 0, 0], left: [-1, 0, 0],
  iso: [HOME_DIR.x, HOME_DIR.y, HOME_DIR.z],
  home: [HOME_DIR.x, HOME_DIR.y, HOME_DIR.z],
};
const FACE_VIEWS = new Set(['top', 'bottom', 'front', 'back', 'right', 'left']);
const PIVOT_MARKER_PX = 5;
export const MAX_PIXEL_RATIO = 1.5;
// Relative change in a camera value that counts as movement: a billionth of a
// foot at working distances, far below a pixel and far above float noise.
const POSE_EPSILON = 1e-9;

export class Engine {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eceef0');

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Capped at 1.5, as in ScaffoldPro: a frame at 2 costs about 2.6x one at 1,
    // and 1.5 about 1.6x, for edges few can pick out on a tube a few px wide.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The sun is fixed in the world, so the shadow map depends on the model
    // alone. Re-rendering it every frame made each orbit and pan pay for a
    // second pass over every caster; it is now baked when the model changes
    // (invalidate({ shadows: true })).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    container.appendChild(el);

    this.frustumSize = 40;
    this.persp = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
    this.persp.up.set(0, 0, 1);
    this.persp.position.set(24, -30, 22);
    this.ortho = new THREE.OrthographicCamera(-20, 20, 20, -20, -2000, 4000);
    this.ortho.up.set(0, 0, 1);
    this.ortho.position.copy(this.persp.position);

    this.projection = 'perspective';
    this.camera = this.persp;
    this.panLock = false;
    this._modifiers = { shift: false, space: false, alt: false };
    // Supplied by the workspace: what Zoom Extents fits, what the cursor can be
    // over, and the rosettes an orbit pivot snaps to.
    this.navHooks = { modelBox: () => null, pickables: () => [], snapPoints: () => [] };
    this.navSettings = { orbitSensitivity: 1, zoomSensitivity: 1, invertOrbitVertical: false };
    this._nav = null;
    this._transition = null;
    this._orbitPivot = null;
    this._orbitPending = null;
    this._wheel = null;
    this._middleLatch = false;
    this._lastMiddleDragged = false;

    this._makeControls();
    this._addLights();
    this._addGroundAndGrid();
    this._pivotMarker = this._makePivotMarker();

    this.raycaster = new THREE.Raycaster();
    // Picks see every layer, including the invisible hit targets the camera skips.
    this.raycaster.layers.enableAll();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.pointer = new THREE.Vector2();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onKeyDown = e => this._key(e, true);
    this._onKeyUp = e => this._key(e, false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    el.addEventListener('contextmenu', e => e.preventDefault());
    this._bindNavigation();

    this._updaters = new Set();
    // Drawn on demand, as ScaffoldPro does (frameloop="demand"): an editor sits
    // still most of the time, and a loop that redraws sixty times a second
    // anyway spends the main thread the page needs for everything else. A frame
    // is drawn when the camera moved or something called invalidate().
    this._dirty = true;
    this._pose = [];
    this.framesRendered = 0;
    this._running = true;
    this._lastTick = 0;
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
    this.resize();
  }

  _makeControls() {
    const target = this.controls ? this.controls.target.clone() : new THREE.Vector3(7, 3.5, 5);
    if (this.controls) this.controls.dispose();
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.09;
    // Screen-space panning: a touch pan in Top moves across the screen, not
    // into it (the bug the mouse had before this navigation was ported).
    c.screenSpacePanning = true;
    c.minDistance = CAMERA_MIN_DISTANCE_FT;
    c.maxDistance = CAMERA_MAX_DISTANCE_FT;
    c.target.copy(target);
    this.controls = c;
    this._applyBindings();
    c.update();
  }

  // OrbitControls serves touch only; every mouse button and the wheel are
  // handled by _bindNavigation.
  _applyBindings() {
    const c = this.controls;
    if (!c) return;
    const isOrtho = this.projection === 'orthographic';
    c.enableRotate = !isOrtho;
    c.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null };
    c.touches = { ONE: isOrtho ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  _key(e, down) {
    if (e.key === 'Shift') this._modifiers.shift = down;
    if (e.code === 'Space') this._modifiers.space = down;
    if (e.key === 'Alt') this._modifiers.alt = down;
  }

  setPanLock(on) { this.panLock = !!on; }

  setProjection(mode) {
    if (mode === this.projection) return;
    this.cancelTransition();
    const target = this.controls.target.clone();
    const pos = this.camera.position.clone();
    const dist = pos.distanceTo(target);
    this.projection = mode;
    if (mode === 'orthographic') {
      this.ortho.position.copy(pos);
      this.ortho.up.set(0, 0, 1);
      this.camera = this.ortho;
      // Keep roughly the same visible extent as the perspective view.
      const visibleH = 2 * dist * Math.tan((this.persp.fov * Math.PI) / 180 / 2);
      this.ortho.zoom = this.frustumSize / Math.max(visibleH, 1e-6);
    } else {
      this.persp.position.copy(pos);
      this.persp.up.set(0, 0, 1);
      this.camera = this.persp;
    }
    this._makeControls();
    this.controls.target.copy(target);
    // Plans and elevations read as drawings: no ground shadow outside 3D.
    if (this.ground) this.ground.visible = mode !== 'orthographic';
    this.invalidate();
    this.resize();
    this.controls.update();
    this.onProjectionChange?.(this.projection);
  }

  _addLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.58));
    this.scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x161d2a, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.15);
    sun.position.set(26, -22, 48);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 70;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 260 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.sun = sun;
  }

  _addGroundAndGrid() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.1 }));
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    const grid = new THREE.GridHelper(200, 200, 0xa8acb2, 0xd7dade);
    grid.material.opacity = 0.9;
    grid.material.transparent = true;
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.grid = grid;
  }

  // The orbit pivot, drawn while an orbit is in progress (ScaffoldPro's marker).
  _makePivotMarker() {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.renderOrder = 999;
    marker.visible = false;
    this.scene.add(marker);
    return marker;
  }

  addUpdater(fn) { this._updaters.add(fn); return () => this._updaters.delete(fn); }

  /**
   * Ask for a frame. Anything that changes what the scene holds calls this;
   * camera moves are noticed on their own. shadows: the model itself changed,
   * so the baked shadow map must be redrawn too.
   */
  invalidate({ shadows = false } = {}) {
    this._dirty = true;
    if (shadows) this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * True when the camera moved, zoomed or was swapped since the last frame.
   *
   * Not an exact comparison: OrbitControls.update() runs every tick (touch and
   * damping need it) and round-trips the camera through spherical coordinates,
   * which moves it by ~1e-14 ft each time. Compared exactly, a still camera
   * "moved" every frame and the canvas never stopped drawing.
   */
  _poseChanged() {
    const c = this.camera;
    const e = c.projectionMatrix.elements;
    const now = [c.id, c.position.x, c.position.y, c.position.z,
      c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w,
      c.zoom, e[0], e[5], e[8], e[9], e[10], e[14]];
    const last = this._pose;
    for (let i = 0; i < now.length; i++) {
      // Written so a missing (first-frame) value also counts as a change.
      if (!(Math.abs(last[i] - now[i]) <= POSE_EPSILON * Math.max(1, Math.abs(now[i])))) {
        this._pose = now;
        return true;
      }
    }
    return false;
  }

  setPointerFromEvent(event) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((event.clientY - r.top) / r.height) * 2 + 1;
  }

  groundPoint(out = new THREE.Vector3()) {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out);
  }

  // Project a client point onto the Z=0 ground plane (used by the marquee).
  projectClientToGround(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
    const v = new THREE.Vector3();
    // setFromCamera returns undefined in three.js, so the ray must be read
    // from the raycaster afterwards -- chaining off it throws on every click.
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, v) ? v : null;
  }

  pick(objects, recursive = false) {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(objects, recursive);
    return hits.length ? hits[0] : null;
  }

  // ---------------------------------------------------------------------------
  // Mouse navigation

  _bindNavigation() {
    const el = this.renderer.domElement;
    const surface = this.container;
    const onCanvas = e => e.target === el;
    const isHistoryButton = b => b === 3 || b === 4;

    // Middle-click autoscroll and Back/Forward are default actions of the press.
    this._onNavMouseDown = e => {
      if (onCanvas(e) && (e.button === 1 || isHistoryButton(e.button))) e.preventDefault();
    };
    this._onNavDown = e => {
      if (!onCanvas(e)) return;
      if (e.button === 1 || isHistoryButton(e.button)) e.preventDefault();
      if (isHistoryButton(e.button)) { e.stopPropagation(); return; }
      const mode = this._navModeFor(e);
      if (!mode) return;
      this.cancelTransition();
      this._flushOrbit();
      this._nav = {
        mode, pointerId: e.pointerId, button: e.button,
        lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, dragged: false,
      };
      if (e.button === 1) { this._middleLatch = true; this._lastMiddleDragged = false; }
      if (mode === 'orbit') this._beginOrbit(e.clientX, e.clientY);
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
      e.preventDefault();
      e.stopPropagation(); // the tools and OrbitControls must not also take this press
    };
    this._onNavMove = e => {
      const nav = this._nav;
      if (!nav || e.pointerId !== nav.pointerId) return;
      const dx = e.clientX - nav.lastX, dy = e.clientY - nav.lastY;
      nav.lastX = e.clientX; nav.lastY = e.clientY;
      nav.dragged ||= Math.hypot(e.clientX - nav.startX, e.clientY - nav.startY) > DRAG_THRESHOLD_PX;
      if (nav.button === 1) this._lastMiddleDragged = nav.dragged;
      if (nav.mode === 'pan') this.panBy(dx, dy);
      else this._queueOrbit(dx, dy);
      e.preventDefault();
      e.stopPropagation();
    };
    this._onNavUp = e => {
      const nav = this._nav;
      if (nav && e.pointerId === nav.pointerId) {
        if (nav.button === 1) this._lastMiddleDragged = nav.dragged;
        try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        this._endNav();
        e.stopPropagation();
      }
      // auxclick follows in the same task; disarm after it, so a stale latch
      // can never swallow an unrelated later click.
      if (e.button === 1) setTimeout(() => { this._middleLatch = false; }, 0);
    };
    // Double middle-click is Zoom Extents. The click count comes from the OS
    // double-click setting, and a pan or orbit never counts as a click.
    this._onAuxClick = e => {
      if (isHistoryButton(e.button)) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.button !== 1 || !this._middleLatch) return;
      e.preventDefault();
      e.stopPropagation();
      this._middleLatch = false;
      if (e.detail >= 2 && !this._lastMiddleDragged) this.zoomExtents({ animate: true });
    };
    this._onWheel = e => {
      if (!onCanvas(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // A sideways swipe is the browser's back/forward gesture, not a zoom.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      this.zoomAt(e.clientX, e.clientY, wheelPixels(e));
    };
    this._onBlur = () => this._endNav();

    surface.addEventListener('mousedown', this._onNavMouseDown, true);
    surface.addEventListener('pointerdown', this._onNavDown, true);
    surface.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    window.addEventListener('pointermove', this._onNavMove, true);
    window.addEventListener('pointerup', this._onNavUp, true);
    window.addEventListener('pointercancel', this._onNavUp, true);
    window.addEventListener('auxclick', this._onAuxClick, true);
    window.addEventListener('blur', this._onBlur);
  }

  _navModeFor(e) {
    if (e.pointerType === 'touch') return null; // OrbitControls owns touch
    const ortho = this.projection === 'orthographic';
    if (e.button === 1) return e.shiftKey ? 'orbit' : 'pan';
    if (e.button === 2) return ortho ? 'pan' : 'orbit';
    if (e.button === 0) {
      if (this.panLock) return 'pan';
      if (this._modifiers.space || e.altKey) return ortho ? 'pan' : 'orbit';
    }
    return null;
  }

  _endNav() {
    this._nav = null;
    if (this._pivotMarker.visible) {
      this._pivotMarker.visible = false;
      this.invalidate();
    }
  }

  /** Is a navigation drag in progress? Tools can use this to stay quiet. */
  get navigating() { return this._nav !== null; }

  _viewportHeight() {
    return Math.max(this.renderer.domElement.getBoundingClientRect().height, 1);
  }

  _worldPerPixelAt(distance) {
    const cam = this.camera;
    return cam.isOrthographicCamera
      ? orthographicWorldPerPixel({ frustumHeight: cam.top - cam.bottom, zoom: cam.zoom, viewportHeightPx: this._viewportHeight() })
      : perspectiveWorldPerPixel({ distance, fovDeg: cam.getEffectiveFOV(), viewportHeightPx: this._viewportHeight() });
  }

  /** 1:1 grab pan by a pointer movement in pixels, along the screen's own axes. */
  panBy(dx, dy) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const o = panOffset({ dx, dy, worldPerPixel: this._worldPerPixelAt(cam.position.distanceTo(this.controls.target)) });
    const shift = right.multiplyScalar(o.right).add(up.multiplyScalar(o.up));
    cam.position.add(shift);
    this.controls.target.add(shift);
    this.controls.update();
  }

  /** What model surface is under the current pointer, if any. */
  _pickModel() {
    const objects = this.navHooks.pickables?.() || [];
    if (!objects.length) return null;
    const hit = this.raycaster.intersectObjects(objects, true)[0];
    return hit ? hit.point.clone() : null;
  }

  /** Wheel zoom toward what is under the cursor. Positive deltas zoom out. */
  zoomAt(clientX, clientY, deltaPx) {
    const scale = wheelScale(deltaPx, this.navSettings.zoomSensitivity);
    if (scale === 1) return;
    this.cancelTransition();
    this._flushOrbit();
    const cam = this.camera;
    const target = this.controls.target;
    this.setPointerFromEvent({ clientX, clientY });
    this.raycaster.setFromCamera(this.pointer, cam);
    if (cam.isOrthographicCamera) {
      cam.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
      const halfW = (cam.right - cam.left) / 2 / cam.zoom;
      const halfH = (cam.top - cam.bottom) / 2 / cam.zoom;
      const cursorOffset = right.multiplyScalar(this.pointer.x * halfW).add(up.multiplyScalar(this.pointer.y * halfH));
      const next = zoomOrthoAbout({ position: cam.position, target, zoom: cam.zoom, scale, cursorOffset });
      cam.position.copy(next.position);
      target.copy(next.target);
      cam.zoom = next.zoom;
      cam.updateProjectionMatrix();
    } else {
      // The pivot is found once per gesture: a burst of wheel events is one zoom.
      const now = performance.now();
      const w = this._wheel;
      const sameGesture = w && now - w.at < GESTURE_GAP_MS && Math.hypot(clientX - w.x, clientY - w.y) < 3;
      const pivot = sameGesture ? w.pivot
        : (this._pickModel() || pointUnderCursor(this.raycaster.ray, cam.position.distanceTo(target)));
      this._wheel = { at: now, x: clientX, y: clientY, pivot };
      const next = dollyAbout({ position: cam.position, target, pivot, scale });
      cam.position.copy(next.position);
      target.copy(next.target);
    }
    this.controls.update();
  }

  _beginOrbit(clientX, clientY) {
    this._orbitPending = { theta: 0, phi: 0 };
    if (this.camera.isOrthographicCamera) { this._orbitPivot = null; return; }
    this.setPointerFromEvent({ clientX, clientY });
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray.clone();
    const modelBox = this.navHooks.modelBox?.() || null;
    let choice = null;
    if (modelBox && !modelBox.isEmpty()) {
      const visibility = modelVisibility(modelBox, this.camera);
      let cursorHit = null;
      if (visibility === 'part') {
        const hit = this._pickModel();
        if (hit) cursorHit = snapToNearestPoint(hit, this.navHooks.snapPoints?.() || []) || hit;
      }
      choice = resolveOrbitPivot({
        modelBox, visibility, cursorHit, cursorRay: ray,
        fallbackDistance: this.camera.position.distanceTo(this.controls.target),
      });
    }
    this._orbitPivot = choice ? choice.point : this.controls.target.clone();
    this._pivotMarker.position.copy(this._orbitPivot);
    this._pivotMarker.visible = true;
    this.invalidate();
  }

  _queueOrbit(dx, dy) {
    // Orthographic faces stay put; the drag is still tracked, so it cannot end
    // as a click and fire Zoom Extents.
    if (this.camera.isOrthographicCamera || !this._orbitPivot || !this._orbitPending) return;
    const a = orbitAngles({
      dx, dy, viewportHeightPx: this._viewportHeight(),
      sensitivity: this.navSettings.orbitSensitivity, invertVertical: this.navSettings.invertOrbitVertical,
    });
    this._orbitPending.theta += a.theta;
    this._orbitPending.phi += a.phi;
  }

  _applyOrbit(theta, phi) {
    const next = orbitAbout({ position: this.camera.position, target: this.controls.target, pivot: this._orbitPivot, theta, phi });
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(next.position);
    this.controls.target.copy(next.target);
  }

  // Eased toward the accumulated drag, so a slow frame never becomes a jump.
  _stepOrbit(dt) {
    const p = this._orbitPending;
    if (!p) return;
    if (this._orbitPivot) {
      const f = 1 - Math.exp(-dt / ORBIT_SMOOTH_TIME_S);
      const theta = p.theta * f, phi = p.phi * f;
      p.theta -= theta; p.phi -= phi;
      if (theta || phi) this._applyOrbit(theta, phi);
    }
    if (!this._nav && Math.abs(p.theta) < 1e-5 && Math.abs(p.phi) < 1e-5) {
      this._orbitPending = null;
      this._orbitPivot = null;
    }
  }

  /** Finish any easing orbit at once, before another gesture starts. */
  _flushOrbit() {
    const p = this._orbitPending;
    if (p && this._orbitPivot && (p.theta || p.phi)) this._applyOrbit(p.theta, p.phi);
    this._orbitPending = null;
    this._orbitPivot = null;
  }

  // ---------------------------------------------------------------------------
  // Views, fitting and transitions

  _applyPose(pose) {
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    if (this.camera.isOrthographicCamera && pose.zoom) {
      this.camera.zoom = pose.zoom;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  _startTransition(to, durationMs, onDone) {
    const cam = this.camera;
    const from = { position: cam.position.clone(), target: this.controls.target.clone(), zoom: cam.zoom };
    const turns = from.position.clone().sub(from.target).normalize()
      .dot(to.position.clone().sub(to.target).normalize()) < 1 - 1e-9;
    this._transition = { from, to, turns, start: performance.now(), duration: Math.max(durationMs, 1), onDone };
  }

  cancelTransition() { this._transition = null; }

  _stepTransition(now) {
    const tr = this._transition;
    if (!tr) return;
    const t = Math.min(1, (now - tr.start) / tr.duration);
    const v = interpolateView(tr.from, tr.to, t);
    if (tr.turns) this.camera.up.set(0, 0, 1);
    this.camera.position.copy(v.position);
    this.controls.target.copy(v.target);
    if (this.camera.isOrthographicCamera && v.zoom) {
      this.camera.zoom = v.zoom;
      this.camera.updateProjectionMatrix();
    }
    if (t >= 1) {
      this._transition = null;
      tr.onDone?.();
    }
  }

  /** Fit a box keeping the current view direction, at once (Zoom All). */
  frame(box) {
    if (!box || box.isEmpty()) return;
    this.cancelTransition();
    const pose = calculateZoomExtents(this.camera, withMinSpan(box), this.camera.position, this.controls.target);
    if (pose) this._applyPose(pose);
  }

  /** Zoom Extents on the model, eased by default. False when nothing is drawn. */
  zoomExtents({ animate = true } = {}) {
    const box = this.navHooks.modelBox?.();
    if (!box || box.isEmpty()) return false;
    const pose = calculateZoomExtents(this.camera, withMinSpan(box), this.camera.position, this.controls.target);
    if (!pose) return false;
    this._flushOrbit();
    if (animate) this._startTransition({ ...pose, zoom: pose.zoom ?? this.camera.zoom }, ZOOM_EXTENTS_TRANSITION_MS);
    else { this.cancelTransition(); this._applyPose(pose); }
    return true;
  }

  /**
   * Named views. Faces are orthographic, Home/iso perspective. Instant by
   * default (programmatic use); animate for the ViewCube and Home, where the
   * camera swings round on an eased curve and becomes orthographic on arrival
   * at a face. fit: a box to frame in the new direction.
   */
  setView(name, { animate = false, fit = null } = {}) {
    const face = FACE_VIEWS.has(name);
    const d = new THREE.Vector3(...(VIEW_DIRS[name] || VIEW_DIRS.home)).normalize();
    this._flushOrbit();
    if (!animate) {
      this.cancelTransition();
      this.setProjection(face ? 'orthographic' : 'perspective');
      const target = this.controls.target.clone();
      const dist = Math.max(this.camera.position.distanceTo(target), 1);
      // Top/bottom need a different up vector to avoid gimbal roll.
      this.camera.up.set(0, 0, 1);
      if (Math.abs(d.z) > 0.999) this.camera.up.set(0, d.z > 0 ? 1 : -1, 0);
      this.camera.position.copy(target).addScaledVector(d, dist);
      this.controls.update();
      if (fit && !fit.isEmpty()) {
        const pose = calculateZoomExtents(this.camera, withMinSpan(fit), this.camera.position, this.controls.target);
        if (pose) this._applyPose(pose);
      }
      return;
    }
    if (!face) this.setProjection('perspective');
    const target = this.controls.target.clone();
    const dist = Math.max(this.camera.position.distanceTo(target), 1);
    let to = { position: target.clone().addScaledVector(d, dist), target, zoom: this.camera.zoom };
    if (fit && !fit.isEmpty()) {
      const probe = this.camera.clone();
      probe.up.set(0, 0, 1);
      probe.position.copy(to.position);
      probe.lookAt(to.target);
      probe.updateMatrixWorld();
      const pose = calculateZoomExtents(probe, withMinSpan(fit), to.position, to.target);
      if (pose) to = { position: pose.position, target: pose.target, zoom: pose.zoom ?? this.camera.zoom };
    }
    // On arrival, snap exactly: the face's projection and up vector.
    this._startTransition(to, VIEW_TRANSITION_MS, () => this.setView(name));
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    // Resizing clears the drawing buffer, so the next tick must draw.
    this.invalidate();
    const aspect = w / h;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    const fs = this.frustumSize;
    this.ortho.left = (-fs * aspect) / 2;
    this.ortho.right = (fs * aspect) / 2;
    this.ortho.top = fs / 2;
    this.ortho.bottom = -fs / 2;
    this.ortho.updateProjectionMatrix();
  }

  _updatePivotMarker() {
    const m = this._pivotMarker;
    if (!m.visible) return;
    const s = this._worldPerPixelAt(this.camera.position.distanceTo(m.position)) * PIVOT_MARKER_PX;
    m.scale.setScalar(s);
  }

  _tick(now) {
    if (!this._running) return;
    const t = typeof now === 'number' ? now : performance.now();
    const dt = this._lastTick ? Math.min((t - this._lastTick) / 1000, 0.1) : 1 / 60;
    this._lastTick = t;
    this._stepTransition(performance.now());
    this._stepOrbit(dt);
    this.controls.update();
    if (this._poseChanged() || this._dirty) {
      this._dirty = false;
      this._updatePivotMarker();
      for (const fn of this._updaters) fn();
      this.renderer.render(this.scene, this.camera);
      this.framesRendered++;
    }
    this._raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.container.removeEventListener('mousedown', this._onNavMouseDown, true);
    this.container.removeEventListener('pointerdown', this._onNavDown, true);
    this.container.removeEventListener('wheel', this._onWheel, { capture: true });
    window.removeEventListener('pointermove', this._onNavMove, true);
    window.removeEventListener('pointerup', this._onNavUp, true);
    window.removeEventListener('pointercancel', this._onNavUp, true);
    window.removeEventListener('auxclick', this._onAuxClick, true);
    window.removeEventListener('blur', this._onBlur);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
