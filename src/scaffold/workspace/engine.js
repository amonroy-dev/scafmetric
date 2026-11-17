// three.js engine for the scaffold workspace: Z-up CAD scene, lighting, ground,
// grid, orbit/pan/zoom controls, render loop, and a ground-plane raycaster used
// by the placement tools. Adapted from the Scaffxiq/ScaffoldPro three.js scene
// conventions (Z-up: X right, Y depth, Z vertical).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Engine {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a1120');

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    // Z-up perspective camera looking at the structure from the front-right.
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(22, -26, 20);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 400;
    this.controls.target.set(7, 3.5, 6);
    // Match CAD feel: left=orbit, right=pan (OrbitControls default middle=dolly).
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this._addLights();
    this._addGroundAndGrid();

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.pointer = new THREE.Vector2();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this._running = true;
    this._updaters = new Set();
    this._raf = requestAnimationFrame(this._loop.bind(this));
    this.resize();
  }

  _addLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const hemi = new THREE.HemisphereLight(0x9fb8ff, 0x1a2230, 0.5);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(18, -12, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 60;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 200 });
    sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun);
    this.sun = sun;
  }

  _addGroundAndGrid() {
    // Shadow-catching ground at Z=0 (XY plane).
    const groundGeo = new THREE.PlaneGeometry(400, 400);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.28 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Faint grid on the XY plane (three's GridHelper is XZ, so rotate to XY).
    const grid = new THREE.GridHelper(120, 120, 0x3dd9c9, 0x22324e);
    grid.material.opacity = 0.25;
    grid.material.transparent = true;
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.grid = grid;
  }

  addUpdater(fn) { this._updaters.add(fn); return () => this._updaters.delete(fn); }

  // Update the pointer (NDC) from a DOM event for raycasting.
  setPointerFromEvent(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  // World point where the cursor ray meets the Z=0 ground plane (or null).
  groundPoint(out = new THREE.Vector3()) {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, out);
  }

  // Raycast against a set of objects; returns the first intersection or null.
  pick(objects) {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  }

  frame(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(4, size.length() / 2);
    this.controls.target.copy(center);
    const dir = new THREE.Vector3(0.7, -0.9, 0.6).normalize();
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 180 / 2) * 1.1;
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
  }

  setView(name) {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const dirs = {
      top: [0, 0, 1], bottom: [0, 0, -1],
      front: [0, -1, 0], back: [0, 1, 0],
      right: [1, 0, 0], left: [-1, 0, 0],
      iso: [0.7, -0.9, 0.6],
    };
    const d = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
    this.camera.position.copy(target).addScaledVector(d, dist);
    this.camera.up.set(0, 0, 1);
    this.controls.update();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (!this._running) return;
    this.controls.update();
    for (const fn of this._updaters) fn();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  destroy() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}
