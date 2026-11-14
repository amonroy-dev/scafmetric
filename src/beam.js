/** Linear Euler–Bernoulli analysis. US customary units, downward loads positive.
 * Simply supported, prismatic beam; a full-span uniform load and point loads.
 * Deflections are bending-only, downward positive; shear and sagging moment positive.
 * Reduced stiffness is a standalone analysis assumption, not Direct Analysis Method.
 */
export function analyzeBeam(input) {
  const { spanFt, uniformLoadPlf = 0, pointLoadLb = 0, pointLocationFt = spanFt / 2, Eksi, Iin4, stiffnessFactor = 0.8 } = input;
  const values = { spanFt, uniformLoadPlf, pointLoadLb, pointLocationFt, Eksi, Iin4, stiffnessFactor };
  for (const [key, value] of Object.entries(values)) if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  if (spanFt <= 0 || Eksi <= 0 || Iin4 <= 0) throw new Error('Span, elastic modulus and moment of inertia must be greater than zero');
  if (uniformLoadPlf < 0 || pointLoadLb < 0) throw new Error('Only downward loads are supported');
  if (pointLocationFt < 0 || pointLocationFt > spanFt) throw new Error('Point load location must be between the supports');
  if (stiffnessFactor <= 0 || stiffnessFactor > 1) throw new Error('Stiffness factor must be greater than zero and at most 1');
  if (input.pointLoads !== undefined && !Array.isArray(input.pointLoads)) throw new Error('Point loads must be an array');
  if (input.pointLoads !== undefined && pointLoadLb !== 0) throw new Error('Use either pointLoads or pointLoadLb, not both');
  const pointLoads = (input.pointLoads ?? (pointLoadLb ? [{ loadLb: pointLoadLb, locationFt: pointLocationFt }] : []))
    .map(load => {
      if (!load || !Number.isFinite(load.loadLb) || !Number.isFinite(load.locationFt)) throw new Error('Point loads and locations must be finite numbers');
      if (load.loadLb < 0) throw new Error('Only downward loads are supported');
      if (load.locationFt < 0 || load.locationFt > spanFt) throw new Error('Point load location must be between the supports');
      return { loadLb: load.loadLb, locationFt: load.locationFt };
    }).sort((a, b) => a.locationFt - b.locationFt);
  const L = spanFt * 12, w = uniformLoadPlf / 12, EI = Eksi * 1000 * Iin4;
  const pointSum = pointLoads.reduce((total, p) => total + p.loadLb, 0);
  const leftLb = w * L / 2 + pointLoads.reduce((total, p) => total + p.loadLb * (L - p.locationFt * 12) / L, 0);
  const rightLb = w * L + pointSum - leftLb;
  const C = (leftLb * L ** 3 / 6 - w * L ** 4 / 24 - pointLoads.reduce((total, p) => total + p.loadLb * (L - p.locationFt * 12) ** 3 / 6, 0)) / L;
  if (![L, w, EI, pointSum, leftLb, rightLb, C].every(Number.isFinite)) throw new Error('Beam inputs exceed the supported numerical range');
  const pos = n => Math.max(n, 0);
  function at(xFt, side = 'right') {
    if (!Number.isFinite(xFt) || xFt < 0 || xFt > spanFt) throw new Error('Position must be between supports');
    if (!['left', 'right'].includes(side)) throw new Error('Side must be left or right');
    const x = xFt * 12;
    const jump = pointLoads.reduce((total, p) => total + (xFt > p.locationFt || (xFt === p.locationFt && side === 'right') ? p.loadLb : 0), 0);
    const momentLbIn = leftLb * x - w * x ** 2 / 2 - pointLoads.reduce((total, p) => total + p.loadLb * pos(x - p.locationFt * 12), 0);
    const nominalDeflectionIn = (C * x - leftLb * x ** 3 / 6 + w * x ** 4 / 24 + pointLoads.reduce((total, p) => total + p.loadLb * pos(x - p.locationFt * 12) ** 3 / 6, 0)) / EI;
    return { xFt, shearLb: leftLb - w * x - jump, momentLbIn, momentKipFt: momentLbIn / 12000, nominalDeflectionIn, reducedDeflectionIn: nominalDeflectionIn / stiffnessFactor };
  }
  const positions = [...new Set([0, ...pointLoads.map(p => p.locationFt), spanFt])];
  const momentCandidates = [...positions];
  if (w > 0) for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i], end = positions[i + 1];
    const root = start + at(start, 'right').shearLb / uniformLoadPlf;
    if (root > start && root < end) momentCandidates.push(root);
  }
  const maxMoment = momentCandidates.map(x => at(x)).reduce((best, curr) => curr.momentLbIn > best.momentLbIn ? curr : best);
  const slopeNumerator = x => C - leftLb * x ** 2 / 2 + w * x ** 3 / 6 + pointLoads.reduce((total, p) => total + p.loadLb * pos(x - p.locationFt * 12) ** 2 / 2, 0);
  let lo = 0, hi = L;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (slopeNumerator(mid) > 0) lo = mid; else hi = mid; }
  const maxDeflection = w || pointSum ? at((lo + hi) / 24) : at(0);
  const shearCandidates = [at(0), at(spanFt, 'left')];
  for (const x of positions) if (x > 0 && x < spanFt) shearCandidates.push(at(x, 'left'), at(x, 'right'));
  const maxShear = shearCandidates.reduce((best, curr) => curr.shearLb > best.shearLb ? curr : best);
  const minShear = shearCandidates.reduce((best, curr) => curr.shearLb < best.shearLb ? curr : best);
  return { input: { ...values, pointLoads }, reactions: { leftLb, rightLb }, maxMoment, maxDeflection, maxShear, minShear, equilibrium: { forceResidualLb: leftLb + rightLb - w * L - pointSum, momentResidualLbIn: rightLb * L - w * L ** 2 / 2 - pointLoads.reduce((total, p) => total + p.loadLb * p.locationFt * 12, 0) }, at };
}
