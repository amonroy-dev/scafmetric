/** Linear Euler–Bernoulli analysis. US customary units, downward loads positive.
 * Simply supported, prismatic beam; one full-span uniform and one point load.
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
  const L = spanFt * 12, a = pointLocationFt * 12, w = uniformLoadPlf / 12, P = pointLoadLb, EI = Eksi * 1000 * Iin4;
  const leftLb = w * L / 2 + P * (L - a) / L;
  const rightLb = w * L + P - leftLb;
  const C = (leftLb * L ** 3 / 6 - w * L ** 4 / 24 - P * (L - a) ** 3 / 6) / L;
  const pos = n => Math.max(n, 0);
  function at(xFt, side = 'right') {
    if (!Number.isFinite(xFt) || xFt < 0 || xFt > spanFt) throw new Error('Position must be between supports');
    const x = xFt * 12;
    const jump = x > a || (x === a && side === 'right') ? P : 0;
    const shearLb = leftLb - w * x - jump;
    const momentLbIn = leftLb * x - w * x ** 2 / 2 - P * pos(x - a);
    const nominalDeflectionIn = (C * x - leftLb * x ** 3 / 6 + w * x ** 4 / 24 + P * pos(x - a) ** 3 / 6) / EI;
    return { xFt, shearLb, momentLbIn, momentKipFt: momentLbIn / 12000, nominalDeflectionIn, reducedDeflectionIn: nominalDeflectionIn / stiffnessFactor };
  }
  const momentCandidates = [0, spanFt, pointLocationFt];
  if (w > 0) {
    for (const x of [leftLb / w, (leftLb - P) / w]) if (x > 0 && x < L) momentCandidates.push(x / 12);
  }
  const maxMoment = momentCandidates.map(x => at(x)).reduce((best, curr) => curr.momentLbIn > best.momentLbIn ? curr : best);
  const slopeNumerator = x => C - leftLb * x ** 2 / 2 + w * x ** 3 / 6 + P * pos(x - a) ** 2 / 2;
  let lo = 0, hi = L;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (slopeNumerator(mid) > 0) lo = mid; else hi = mid; }
  const maxDeflection = w || P ? at((lo + hi) / 24) : at(0);
  const shearCandidates = [at(0), at(spanFt, 'left')];
  if (pointLocationFt > 0 && pointLocationFt < spanFt) shearCandidates.push(at(pointLocationFt, 'left'), at(pointLocationFt, 'right'));
  const maxShear = shearCandidates.reduce((best, curr) => curr.shearLb > best.shearLb ? curr : best);
  const minShear = shearCandidates.reduce((best, curr) => curr.shearLb < best.shearLb ? curr : best);
  return { input: { ...values }, reactions: { leftLb, rightLb }, maxMoment, maxDeflection, maxShear, minShear, equilibrium: { forceResidualLb: leftLb + rightLb - w * L - P, momentResidualLbIn: rightLb * L - w * L ** 2 / 2 - P * a }, at };
}
