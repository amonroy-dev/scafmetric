// three.js engine for the scaffold workspace: Z-up CAD scene, lighting, ground,
// grid, and ScaffoldPro-style navigation.
//
// Navigation model (matches the source app):
//   - LEFT drag  : reserved for tools / marquee selection (never orbits)
//   - MIDDLE drag: pan
//   - RIGHT drag : orbit (perspective only; locked in orthographic)
//   - SHIFT+LEFT : pan
//   - SPACE/ALT+LEFT : orbit (perspective only)
//   - WHEEL      : zoom (ortho) / dolly (perspective)
//   - Pan lock   : when on, LEFT drag pans (hand tool)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const HOME_DIR = new THREE.Vector3(0.75, -1, 0.72).normalize();

export class Engine {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a1120');

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    this._makeControls();
    this._addLights();
    this._addGroundAndGrid();

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.pointer = new THREE.Vector2();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onKeyDown = e => this._key(e, true);
    this._onKeyUp = e => this._key(e, false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    el.addEventListener('contextmenu', e => e.preventDefault());

    this._updaters = new Set();
    this._running = true;
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
    c.screenSpacePanning = false;
    c.minDistance = 1.5;
    c.maxDistance = 600;
    c.target.copy(target);
    this.controls = c;
    this._applyBindings();
    c.update();
  }

  // Button/modifier bindings, re-applied whenever modifiers or mode change.
  _applyBindings() {
    const c = this.controls;
    if (!c) return;
    const isOrtho = this.projection === 'orthographic';
    c.enableRotate = !isOrtho;

    let left = null; // reserved for tools / marquee
    if (this.panLock || this._modifiers.shift) left = THREE.MOUSE.PAN;
    else if ((this._modifiers.space || this._modifiers.alt) && !isOrtho) left = THREE.MOUSE.ROTATE;

    c.mouseButtons = {
      LEFT: left,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: isOrtho ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
    };
    c.touches = { ONE: isOrtho ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  _key(e, down) {
    const before = { ...this._modifiers };
    if (e.key === 'Shift') this._modifiers.shift = down;
    if (e.code === 'Space') this._modifiers.space = down;
    if (e.key === 'Alt') this._modifiers.alt = down;
    if (before.shift !== this._modifiers.shift || before.space !== this._modifiers.space || before.alt !== this._modifiers.alt) {
      this._applyBindings();
    }
  }

  setPanLock(on) { this.panLock = !!on; this._applyBindings(); }

  setProjection(mode) {
    if (mode === this.projection) return;
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
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.3 }));
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(200, 200, 0x3dd9c9, 0x1d2b42);
    grid.material.opacity = 0.3;
    grid.material.transparent = true;
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.grid = grid;
  }

  addUpdater(fn) { this._updaters.add(fn); return () => this._updaters.delete(fn); }

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
    return this.raycaster.setFromCamera(this.pointer, this.camera).ray.intersectPlane(this.groundPlane, v) ? v : null;
  }

  pick(objects, recursive = false) {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(objects, recursive);
    return hits.length ? hits[0] : null;
  }

  frame(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(3, size.length() / 2);
    this.controls.target.copy(center);
    const dist = radius / Math.sin((this.persp.fov * Math.PI) / 180 / 2) * 1.08;
    this.camera.position.copy(center).addScaledVector(HOME_DIR, dist);
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = this.frustumSize / Math.max(radius * 2.3, 1e-6);
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  setView(name) {
    // Named face views are orthographic (matching the source app); home/iso is
    // perspective. Without this, a "top" view still splays verticals outward.
    const isFace = ['top', 'bottom', 'front', 'back', 'right', 'left'].includes(name);
    this.setProjection(isFace ? 'orthographic' : 'perspective');
    const target = this.controls.target.clone();
    const dist = Math.max(this.camera.position.distanceTo(target), 1);
    const dirs = {
      top: [0, 0, 1], bottom: [0, 0, -1],
      front: [0, -1, 0], back: [0, 1, 0],
      right: [1, 0, 0], left: [-1, 0, 0],
      iso: [HOME_DIR.x, HOME_DIR.y, HOME_DIR.z],
      home: [HOME_DIR.x, HOME_DIR.y, HOME_DIR.z],
    };
    const d = new THREE.Vector3(...(dirs[name] || dirs.home)).normalize();
    // Top/bottom need a different up vector to avoid gimbal roll.
    this.camera.up.set(0, 0, 1);
    if (Math.abs(d.z) > 0.999) this.camera.up.set(0, d.z > 0 ? 1 : -1, 0);
    this.camera.position.copy(target).addScaledVector(d, dist);
    this.controls.update();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
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

  _tick() {
    if (!this._running) return;
    this.controls.update();
    for (const fn of this._updaters) fn();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
