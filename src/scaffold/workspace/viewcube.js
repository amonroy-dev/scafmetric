// A compact clickable ViewCube (like GizmoViewcube in the reference app). Renders
// a labeled cube in a corner overlay that mirrors the main camera's orientation;
// clicking a face snaps the main view to that direction. Z-up convention.

import * as THREE from 'three';

const FACES = [
  { name: 'right', label: 'Right', axis: new THREE.Vector3(1, 0, 0) },
  { name: 'left', label: 'Left', axis: new THREE.Vector3(-1, 0, 0) },
  { name: 'back', label: 'Back', axis: new THREE.Vector3(0, 1, 0) },
  { name: 'front', label: 'Front', axis: new THREE.Vector3(0, -1, 0) },
  { name: 'top', label: 'Top', axis: new THREE.Vector3(0, 0, 1) },
  { name: 'bottom', label: 'Bottom', axis: new THREE.Vector3(0, 0, -1) },
];

// Light faces with dark sentence-case labels, as in Inventor / Fusion.
function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fafaf9';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#3f3f46';
  g.font = `600 ${text.length > 5 ? 22 : 26}px Inter, "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// A house, as a view cube's home control usually is. Same line style as the
// toolbar icons: 20px grid, drawn in currentColor.
const HOME_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 9.6 10 3.4l7 6.2"/><path d="M5 8.2v8.3h10V8.2"/><path d="M8.4 16.5v-4.4h3.2v4.4"/></svg>';
// The view counts as flat when it looks this squarely along one axis (about two degrees).
const FLAT_VIEW_COS = 0.9995;

export class ViewCube {
  constructor(engine, size = 92, opts = {}) {
    this.engine = engine;
    this.onHome = opts.onHome || null;
    const el = document.createElement('div');
    el.className = 'sfw-viewcube';
    el.style.width = `${size}px`;
    this.el = el;

    // Home button, like the source app's ViewCube home control.
    const home = document.createElement('button');
    home.type = 'button';
    home.className = 'sfw-viewcube-home';
    home.title = 'Home: back to the 3D view';
    home.setAttribute('aria-label', 'Home: back to the 3D view');
    // The words show only in a flat view, where the way back needs spelling out.
    home.innerHTML = `${HOME_ICON}<span class="sfw-viewcube-home-label">3D view</span>`;
    home.addEventListener('click', ev => {
      ev.stopPropagation();
      if (this.onHome) this.onHome();
      else engine.setView('home');
    });
    this.homeButton = home;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(size, size);
    el.appendChild(this.renderer.domElement);
    el.appendChild(home);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(2, -3, 4);
    this.scene.add(dir);

    // Order matches BoxGeometry material order: +X,-X,+Y,-Y,+Z,-Z
    const order = ['right', 'left', 'back', 'front', 'top', 'bottom'];
    const mats = order.map(n => {
      const f = FACES.find(ff => ff.name === n);
      return new THREE.MeshBasicMaterial({ map: labelTexture(f.label) });
    });
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats);
    this.scene.add(this.cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.001, 1.001, 1.001)),
      new THREE.LineBasicMaterial({ color: 0xa8a29e }),
    );
    this.scene.add(edges);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._R = 3;

    this.renderer.domElement.style.cursor = 'pointer';
    this.renderer.domElement.addEventListener('pointerdown', e => this._onClick(e));
    this._stop = engine.addUpdater(() => this._sync());
  }

  _sync() {
    const offset = new THREE.Vector3().subVectors(this.engine.camera.position, this.engine.controls.target);
    if (offset.lengthSq() < 1e-6) offset.set(1, -1, 1);
    offset.normalize().multiplyScalar(this._R);
    const up = this.engine.camera.up;
    // A pan, zoom or hover redraws the main view without turning it; the cube
    // only needs drawing when the view direction or up vector changed.
    const key = [offset.x, offset.y, offset.z, up.x, up.y, up.z].map(v => v.toFixed(5)).join(',');
    if (key === this._lastKey) return;
    this._lastKey = key;
    // Looking square at one face (Top, Front, a side) the scaffold reads as a
    // flat drawing, and it is not obvious how to get the 3D view back. The
    // home button says so there: it darkens, names itself and pulses.
    const flat = Math.max(Math.abs(offset.x), Math.abs(offset.y), Math.abs(offset.z)) / this._R > FLAT_VIEW_COS;
    if (flat !== this.flat) {
      this.flat = flat;
      this.homeButton.classList.toggle('is-flat', flat);
    }
    this.camera.position.copy(offset);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  _onClick(e) {
    e.stopPropagation();
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit || !hit.face) return;
    const normal = hit.face.normal.clone().applyQuaternion(this.cube.quaternion).normalize();
    let best = FACES[0], bd = -Infinity;
    for (const f of FACES) { const d = normal.dot(f.axis); if (d > bd) { bd = d; best = f; } }
    this.engine.setView(best.name, { animate: true });
  }

  destroy() {
    this._stop?.();
    this.renderer.dispose();
    this.el.remove();
  }
}
