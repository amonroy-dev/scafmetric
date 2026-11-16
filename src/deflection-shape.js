/* Geometry for drawing the computed deflected shape on the input model.
   Every deflection comes straight from the analysis engine's closed-form δ(x);
   nothing here is fitted or smoothed. The horizontal axis is always true scale
   (the span is drawn MODEL.right − MODEL.left units long); only the vertical
   deflection is multiplied by the chosen scale factor. */

// Drawing coordinates of the input schematic in src/input-visual.js.
export const MODEL = { left: 77, right: 643, beamY: 138, loadBarY: 64, autoDrop: 40, maxDrop: 60 };

// Factors Auto may choose from, and the fixed factors offered in the menu.
export const SCALE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
export const SCALE_OPTIONS = [1, 10, 25, 50, 100, 200, 500];

// Drawing units per inch of deflection at true (1×) scale, matching the span's scale.
export function unitsPerInch(spanFt) {
  return (MODEL.right - MODEL.left) / (spanFt * 12);
}

// Exact sampled shape: δ(x) at evenly spaced stations plus every point-load station
// and the location of maximum deflection, so kinks in curvature and the peak are
// drawn exactly. `basis` picks the adjusted (reduced-EI) or nominal deflection.
export function deflectedShape(analysis, { samples = 240, basis = 'reducedDeflectionIn' } = {}) {
  const spanFt = analysis.input.spanFt;
  const stations = new Set(Array.from({ length: samples + 1 }, (_, i) => spanFt * i / samples));
  for (const load of analysis.input.pointLoads) stations.add(load.locationFt);
  stations.add(analysis.maxDeflection.xFt);
  const points = [...stations].filter(x => x >= 0 && x <= spanFt).sort((a, b) => a - b)
    .map(xFt => ({ xFt, deflectionIn: analysis.at(xFt)[basis] }));
  return { spanFt, basis, points, peak: { xFt: analysis.maxDeflection.xFt, deflectionIn: analysis.maxDeflection[basis] } };
}

// Drawn drop, in drawing units, of a deflection at a load fraction and scale.
export function dropUnits(deflectionIn, spanFt, scale, loadFraction = 1) {
  return loadFraction * deflectionIn * unitsPerInch(spanFt) * scale;
}

// Largest standard factor whose drawn peak stays within the auto target height.
export function autoScale(peakIn, spanFt) {
  if (!(peakIn > 0)) return 1;
  const fitting = SCALE_STEPS.filter(scale => dropUnits(peakIn, spanFt, scale) <= MODEL.autoDrop);
  return fitting.length ? fitting[fitting.length - 1] : SCALE_STEPS[0];
}

// Whether a fixed factor keeps the drawn peak inside the drawing (it is never clipped).
export function fitsDrawing(peakIn, spanFt, scale) {
  return dropUnits(peakIn, spanFt, scale) <= MODEL.maxDrop;
}

// Beam centreline as drawing points [x, y] for a scale and load fraction. The
// analysis is linear, so the shape at load fraction λ is exactly λ × δ(x).
export function drawnPoints(shape, scale, loadFraction = 1) {
  const length = MODEL.right - MODEL.left;
  return shape.points.map(point => [
    MODEL.left + length * point.xFt / shape.spanFt,
    MODEL.beamY + dropUnits(point.deflectionIn, shape.spanFt, scale, loadFraction)
  ]);
}
