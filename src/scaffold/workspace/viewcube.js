// A compact clickable ViewCube (like GizmoViewcube in the reference app). Renders
// a labeled cube in a corner overlay that mirrors the main camera's orientation;
// clicking a face snaps the main view to that direction. Z-up convention.

import * as THREE from 'three';

const FACES = [
  { name: 'right', label: 'R', axis: new THREE.Vector3(1, 0, 0) },
  { name: 'left', label: 'L', axis: new THREE.Vector3(-1, 0, 0) },
  { name: 'back', label: 'BK', axis: new THREE.Vector3(0, 1, 0) },
  { name: 'front', label: 'FR', axis: new THREE.Vector3(0, -1, 0) },
  { name: 'top', label: 'TOP', axis: new THREE.Vector3(0, 0, 1) },
  { name: 'bottom', label: 'BOT', axis: new THREE.Vector3(0, 0, -1) },
];

function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#111a2e';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#3dd9c9';
  g.lineWidth = 6;
  g.strokeRect(6, 6, 116, 116);
  g.fillStyle = '#e8ecf4';
  g.font = 'bold 40px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

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
    home.title = 'Home view (fit model)';
    home.setAttribute('aria-label', 'Home view');
    home.textContent = 'HOME';
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
      new THREE.LineBasicMaterial({ color: 0x3dd9c9 }),
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
    this.camera.position.copy(offset);
    this.camera.up.copy(this.engine.camera.up);
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
