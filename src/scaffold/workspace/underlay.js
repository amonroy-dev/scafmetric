// A drawing laid under the model to build over: a page of a PDF, or an image.
// As ScaffoldPro's underlay: rendered once to a picture, laid flat on the
// ground, and brought to scale either from the sheet's stated scale or from
// two points a known distance apart.
//
// pdf.js is not bundled with the builder. It is copied next to the site by
// scripts/build.mjs and fetched the first time a PDF is opened, so a session
// that never opens one never pays for it.

import * as THREE from 'three';

// A PDF point is 1/72 inch.
export const PDF_POINTS_PER_INCH = 72;
// The longest edge a page is rendered at. Large enough to read a 36 in sheet's
// dimensions, small enough for any graphics card's texture limit.
export const MAX_UNDERLAY_EDGE_PX = 4096;
export const UNDERLAY_DEFAULTS = { feetPerSheetInch: 8, opacity: 0.6 }; // 1/8" = 1'-0"

/** How wide a sheet is on the ground: its width on paper at so many feet to the inch. */
export function sheetWidthFt(widthPt, feetPerSheetInch) {
  return (widthPt / PDF_POINTS_PER_INCH) * Math.max(1e-6, Number(feetPerSheetInch) || 0);
}

/** The render scale that brings a page's longest edge to the limit, never above 4x. */
export function rasterScaleFor(widthPt, heightPt, maxEdgePx = MAX_UNDERLAY_EDGE_PX) {
  const longest = Math.max(widthPt, heightPt, 1);
  return Math.max(0.25, Math.min(4, maxEdgePx / longest));
}

/**
 * Bring an underlay to scale from two points on it that are `realFt` apart.
 * `layout` is { x, y, widthFt, heightFt } with (x, y) its lower left corner.
 * The first point stays where it is. Null when the points coincide.
 */
export function calibrateLayout(layout, a, b, realFt) {
  const drawn = Math.hypot(b.x - a.x, b.y - a.y);
  const real = Number(realFt);
  if (!(drawn > 1e-6) || !(real > 0)) return null;
  const k = real / drawn;
  return {
    x: a.x + (layout.x - a.x) * k, y: a.y + (layout.y - a.y) * k,
    widthFt: layout.widthFt * k, heightFt: layout.heightFt * k,
  };
}

/** Open a PDF's bytes with pdf.js, fetched from beside the site on first use. */
let pdfjsLoading = null;
async function pdfjs() {
  if (!pdfjsLoading) {
    const base = new URL('pdfjs/', document.baseURI).href;
    // A URL worked out at run time, so the bundler leaves it alone.
    pdfjsLoading = import(/* @vite-ignore */ `${base}pdf.min.mjs`).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
      return { lib, base };
    });
  }
  return pdfjsLoading;
}

/**
 * Read a file the user picked into a picture: { canvas, widthPt, heightPt,
 * pageCount, page, isPdf }. For an image widthPt and heightPt are its pixels
 * and there is one page. Throws with a sentence fit to show when it cannot.
 */
export async function readUnderlayFile(file, page = 1) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (!isPdf) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error(`${file.name} could not be read as an image.`);
    const k = Math.min(1, MAX_UNDERLAY_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k); canvas.height = Math.round(bitmap.height * k);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { canvas, widthPt: bitmap.width, heightPt: bitmap.height, pageCount: 1, page: 1, isPdf: false };
  }
  const { lib, base } = await pdfjs().catch(() => { throw new Error('The PDF reader could not be loaded.'); });
  // pdf.js hands the buffer it is given to its worker, which empties the caller's copy.
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`,
  });
  let doc;
  try { doc = await task.promise; } catch { await task.destroy().catch(() => {}); throw new Error(`${file.name} could not be read as a PDF.`); }
  try {
    const n = Math.min(Math.max(1, Math.round(page) || 1), doc.numPages);
    const p = await doc.getPage(n);
    const size = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: rasterScaleFor(size.width, size.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, canvas, viewport }).promise;
    return { canvas, widthPt: size.width, heightPt: size.height, pageCount: doc.numPages, page: n, isPdf: true };
  } finally {
    // The task owns the worker: destroying the document alone would leave it running.
    await task.destroy().catch(() => {});
  }
}

/** The drawing as it lies on the ground. One at a time; it is not part of the model. */
export class UnderlayLayer {
  constructor(engine) {
    this.engine = engine;
    this.mesh = null;
    this.layout = null; // { x, y, widthFt, heightFt }: lower left corner and size
  }
  get loaded() { return !!this.mesh; }

  /** Lay a picture down, `widthFt` wide, its lower left corner at (x, y). */
  set(canvas, widthFt, { x = 0, y = 0, opacity = UNDERLAY_DEFAULTS.opacity } = {}) {
    this.remove();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = -1;
    this.aspect = canvas.height / canvas.width;
    this.engine.scene.add(this.mesh);
    this.place({ x, y, widthFt, heightFt: widthFt * this.aspect });
  }

  place(layout) {
    if (!this.mesh) return;
    this.layout = { ...layout };
    this.mesh.scale.set(layout.widthFt, layout.heightFt, 1);
    this.mesh.position.set(layout.x + layout.widthFt / 2, layout.y + layout.heightFt / 2, 0.004);
    this.engine.invalidate?.();
  }

  setWidth(widthFt) { if (this.layout) this.place({ ...this.layout, widthFt, heightFt: widthFt * this.aspect }); }
  moveBy(dx, dy) { if (this.layout) this.place({ ...this.layout, x: this.layout.x + dx, y: this.layout.y + dy }); }
  calibrate(a, b, realFt) {
    const next = this.layout ? calibrateLayout(this.layout, a, b, realFt) : null;
    if (next) this.place(next);
    return !!next;
  }
  setOpacity(v) { if (this.mesh) { this.mesh.material.opacity = Math.min(1, Math.max(0.05, Number(v) || 0)); this.engine.invalidate?.(); } }
  setVisible(on) { if (this.mesh) { this.mesh.visible = !!on; this.engine.invalidate?.(); } }
  get visible() { return !!this.mesh && this.mesh.visible; }

  remove() {
    if (!this.mesh) return;
    this.engine.scene.remove(this.mesh);
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
    this.mesh = null;
    this.layout = null;
    this.engine.invalidate?.();
  }
}
