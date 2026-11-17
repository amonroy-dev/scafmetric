// Dependency-free 3D canvas for the scaffold-to-beam modal.
//
// No three.js, no WebGL, no external libraries — a small pinhole projector that
// draws depth-sorted tubes and planks onto a 2D canvas. The glowing-wireframe
// look is deliberate: it matches Scafmetric's HUD aesthetic and keeps the static
// build (and offline use) untouched.
//
// Coordinate system is Z-UP (CAD convention), matching the source scaffold
// projects: X = right, Y = depth, Z = vertical height.

const WORLD_UP = [0, 0, 1];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = a => Math.hypot(a[0], a[1], a[2]) || 1;
const norm = a => scale(a, 1 / len(a));

export class Scene3D {
  constructor(canvas, { onPickLeg } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPickLeg = onPickLeg;
    this.scene = { legs: [], ledgers: [], braces: [], planks: [], beam: null, grid: [] };

    // Orbit camera state.
    this.target = [7, 3.5, 6];
    this.distance = 42;
    this.azimuth = -0.9;   // radians
    this.elevation = 0.5;  // radians above horizon
    this.fov = 0.9;        // radians (~52°)
    this.near = 0.05;

    this._drag = null;
    this._dpr = 1;
    this._needsDraw = true;
    this._raf = null;

    this._bind();
    this.resize();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  setScene(scene) {
    this.scene = { legs: [], ledgers: [], braces: [], planks: [], beam: null, grid: [], ...scene };
    this._needsDraw = true;
  }

  // Frame the camera so the whole structure fits comfortably.
  frame(bbox) {
    if (!bbox) return;
    const cx = (bbox.min[0] + bbox.max[0]) / 2;
    const cy = (bbox.min[1] + bbox.max[1]) / 2;
    const cz = (bbox.min[2] + bbox.max[2]) / 2;
    this.target = [cx, cy, cz];
    const sx = bbox.max[0] - bbox.min[0];
    const sy = bbox.max[1] - bbox.min[1];
    const sz = bbox.max[2] - bbox.min[2];
    const radius = Math.max(4, Math.hypot(sx, sy, sz) / 2);
    this.distance = radius / Math.tan(this.fov / 2) * 1.25;
    this._needsDraw = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this._cssW = rect.width;
    this._cssH = rect.height;
    this._needsDraw = true;
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    for (const [type, fn, opts] of this._listeners) this.canvas.removeEventListener(type, fn, opts);
    window.removeEventListener('resize', this._onResize);
  }

  // --- camera -------------------------------------------------------------
  _cameraBasis() {
    const e = Math.max(-1.45, Math.min(1.45, this.elevation));
    const offset = [
      Math.cos(e) * Math.cos(this.azimuth),
      Math.cos(e) * Math.sin(this.azimuth),
      Math.sin(e),
    ];
    const cam = add(this.target, scale(offset, this.distance));
    const forward = norm(sub(this.target, cam));
    let right = cross(forward, WORLD_UP);
    if (len(right) < 1e-6) right = [1, 0, 0];
    right = norm(right);
    const up = cross(right, forward);
    return { cam, forward, right, up };
  }

  _project(p, basis) {
    const rel = sub(p, basis.cam);
    const camZ = dot(rel, basis.forward);
    const focal = (this._cssH / 2) / Math.tan(this.fov / 2);
    const x = this._cssW / 2 + focal * dot(rel, basis.right) / camZ;
    const y = this._cssH / 2 - focal * dot(rel, basis.up) / camZ;
    return { x, y, camZ, visible: camZ > this.near };
  }

  // --- drawing ------------------------------------------------------------
  _loop() {
    if (this._needsDraw) { this._draw(); this._needsDraw = false; }
    this._raf = requestAnimationFrame(this._loop);
  }

  _draw() {
    const ctx = this.ctx;
    const basis = this._cameraBasis();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this._cssW, this._cssH);

    // Ground grid (drawn first, always behind).
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(61,217,201,0.16)';
    for (const seg of this.scene.grid) {
      const a = this._project(seg[0], basis);
      const b = this._project(seg[1], basis);
      if (!a.visible || !b.visible) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Collect drawable primitives with a camera-space depth key.
    const items = [];
    const pushSeg = (a, b, style) => {
      const pa = this._project(a, basis);
      const pb = this._project(b, basis);
      if (!pa.visible || !pb.visible) return;
      items.push({ kind: 'seg', pa, pb, style, depth: (pa.camZ + pb.camZ) / 2 });
    };
    for (const pk of this.scene.planks) {
      const pts = pk.quad.map(p => this._project(p, basis));
      if (pts.some(p => !p.visible)) continue;
      items.push({ kind: 'poly', pts, depth: pts.reduce((s, p) => s + p.camZ, 0) / pts.length });
    }
    for (const m of this.scene.braces) pushSeg(m.a, m.b, 'brace');
    for (const m of this.scene.ledgers) pushSeg(m.a, m.b, 'ledger');
    for (const leg of this.scene.legs) pushSeg(leg.base, leg.top, leg.selected ? 'legSel' : 'leg');
    if (this.scene.beam) pushSeg(this.scene.beam.a, this.scene.beam.b, 'beam');

    // Painter's algorithm: far first.
    items.sort((a, b) => b.depth - a.depth);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const it of items) {
      if (it.kind === 'poly') {
        ctx.beginPath();
        ctx.moveTo(it.pts[0].x, it.pts[0].y);
        for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i].x, it.pts[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,164,27,0.12)';
        ctx.strokeStyle = 'rgba(255,164,27,0.55)';
        ctx.lineWidth = 1.25;
        ctx.fill(); ctx.stroke();
        continue;
      }
      const s = STYLES[it.style];
      // Depth-attenuated width so near tubes read heavier.
      const w = s.width * Math.max(0.55, Math.min(1.6, 24 / it.depth));
      if (s.glow) { ctx.shadowColor = s.glow; ctx.shadowBlur = s.style === 'beam' ? 14 : 8; }
      else ctx.shadowBlur = 0;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(it.pa.x, it.pa.y); ctx.lineTo(it.pb.x, it.pb.y); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Cache projected leg segments for picking.
    this._legHits = this.scene.legs.map(leg => ({
      id: leg.id,
      a: this._project(leg.base, basis),
      b: this._project(leg.top, basis),
    })).filter(h => h.a.visible && h.b.visible);
  }

  // --- input --------------------------------------------------------------
  _bind() {
    this._listeners = [];
    const on = (type, fn, opts) => { this.canvas.addEventListener(type, fn, opts); this._listeners.push([type, fn, opts]); };

    on('contextmenu', e => e.preventDefault());
    on('pointerdown', e => {
      this.canvas.setPointerCapture?.(e.pointerId);
      const pan = e.button === 1 || e.button === 2 || e.shiftKey;
      this._drag = { x: e.clientX, y: e.clientY, pan, moved: 0, button: e.button };
    });
    on('pointermove', e => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      this._drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this._drag.pan) this._pan(dx, dy);
      else { this.azimuth += dx * 0.01; this.elevation = Math.max(-1.45, Math.min(1.45, this.elevation + dy * 0.01)); }
      this._needsDraw = true;
    });
    const endDrag = e => {
      if (!this._drag) return;
      const wasClick = this._drag.moved < 4 && this._drag.button === 0;
      const drag = this._drag;
      this._drag = null;
      this.canvas.releasePointerCapture?.(e.pointerId);
      if (wasClick) this._click(e);
    };
    on('pointerup', endDrag);
    on('pointercancel', endDrag);
    on('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0012);
      this.distance = Math.max(3, Math.min(400, this.distance * factor));
      this._needsDraw = true;
    }, { passive: false });

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  _pan(dx, dy) {
    const basis = this._cameraBasis();
    const worldPerPx = (2 * this.distance * Math.tan(this.fov / 2)) / this._cssH;
    const move = add(scale(basis.right, -dx * worldPerPx), scale(basis.up, dy * worldPerPx));
    this.target = add(this.target, move);
  }

  _click(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const id = this.pickLeg(px, py);
    if (id && this.onPickLeg) this.onPickLeg(id);
  }

  // Nearest leg whose projected segment is within the hit radius of (px,py).
  pickLeg(px, py) {
    let best = null, bestDist = 12; // px threshold
    for (const h of this._legHits || []) {
      const d = distToSegment(px, py, h.a.x, h.a.y, h.b.x, h.b.y);
      if (d < bestDist) { bestDist = d; best = h.id; }
    }
    return best;
  }
}

const STYLES = {
  leg: { color: '#8aa0bd', width: 3.4, glow: null, style: 'leg' },
  legSel: { color: '#ffa41b', width: 4.4, glow: 'rgba(255,164,27,0.85)', style: 'leg' },
  ledger: { color: '#53627d', width: 2.6, glow: null, style: 'ledger' },
  brace: { color: '#3d5068', width: 1.8, glow: null, style: 'brace' },
  beam: { color: '#3dd9c9', width: 5, glow: 'rgba(61,217,201,0.9)', style: 'beam' },
};

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
