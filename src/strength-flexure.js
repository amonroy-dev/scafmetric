/**
 * AISC 360-16 ASD F2 / B4.1b: rolled W section, major-axis flexure.
 * Units: ksi, inches, feet, kips. Strengths use nominal E and section properties;
 * the analysis stiffness multiplier is never applied to the member strengths.
 * This is an individual member check, not a scaffold, stability-system, bearing,
 * connection, concentrated-force, torsion, axial, or combined-force verification.
 */
export function checkFlexure({ section, analysis, bracesFt, cbMethod = 'unity', Eksi = 29000, Fyksi = 50, confirmedLateralBracing = false, confirmedScope = false }) {
  if (!confirmedLateralBracing) throw new Error('Confirm both flanges are laterally restrained at the entered brace locations.');
  if (!confirmedScope) throw new Error('Confirm the beam meets the stated flexural-check assumptions.');
  if (Eksi !== 29000 || Fyksi !== 50) throw new Error('The implemented check is limited to A992 steel with E = 29,000 ksi and Fy = 50 ksi.');
  if (!section || section.Type !== 'W') throw new Error('The implemented check requires a rolled, doubly symmetric W section.');
  const keys = ['d', 'bf', 'tf', 'tw', 'kdes', 'Sx', 'Zx', 'ry', 'rts', 'J', 'ho'];
  if (keys.some(key => !Number.isFinite(section[key]) || section[key] <= 0)) throw new Error('Selected W section is missing required positive section properties.');
  if (section.d <= 2 * section.kdes || section.d <= 2 * section.tf || section.Zx < section.Sx) throw new Error('Selected W section has invalid section dimensions or moduli.');
  if (!['unity', 'quarter'].includes(cbMethod)) throw new Error('Select a supported Cb method.');
  const a = analysis?.input;
  if (!a || typeof analysis.at !== 'function' || !Number.isFinite(a.spanFt) || a.spanFt <= 0 || !Number.isFinite(a.uniformLoadPlf) || a.uniformLoadPlf < 0 || !Array.isArray(a.pointLoads) || a.pointLoads.some(p => !p || !Number.isFinite(p.loadLb) || p.loadLb < 0 || !Number.isFinite(p.locationFt) || p.locationFt < 0 || p.locationFt > a.spanFt)) throw new Error('Flexural check supports a simply supported beam under downward uniform and point loads only.');
  if (a.Eksi !== Eksi) throw new Error('Analysis and flexural-check elastic modulus must match.');
  const L = a.spanFt;
  if (!Array.isArray(bracesFt) || bracesFt.length < 2 || bracesFt.some(x => !Number.isFinite(x)) || bracesFt[0] !== 0 || bracesFt[bracesFt.length - 1] !== L || bracesFt.some((x, i) => x < 0 || x > L || (i > 0 && x <= bracesFt[i - 1]))) throw new Error('Brace locations must increase from 0 to the span and include both end restraints.');

  const root = Math.sqrt(Eksi / Fyksi);
  const flangeRatio = section.bf / (2 * section.tf);
  const webRatio = (section.d - 2 * section.kdes) / section.tw;
  const flangeLimit = 0.38 * root;
  const webLimit = 3.76 * root;
  if (flangeRatio > flangeLimit || webRatio > webLimit) throw new Error('Section is not compact in flexure; local buckling checks for this section are not implemented.');

  const MpKipIn = Fyksi * section.Zx;
  const LpIn = 1.76 * section.ry * root;
  const jr = section.J / (section.Sx * section.ho); // c = 1 for doubly symmetric I-shapes
  const LrIn = 1.95 * section.rts * Eksi / (0.7 * Fyksi) * Math.sqrt(jr + Math.sqrt(jr ** 2 + 6.76 * (0.7 * Fyksi / Eksi) ** 2));
  if (![MpKipIn, LpIn, LrIn].every(Number.isFinite) || LrIn <= LpIn) throw new Error('Section properties do not produce valid F2 limiting lengths.');

  const segments = bracesFt.slice(1).map((endFt, index) => {
    const startFt = bracesFt[index], LbFt = endFt - startFt, LbIn = LbFt * 12;
    const moment = x => Math.abs(analysis.at(x).momentKipFt);
    const breakpoints = [...new Set([startFt, ...a.pointLoads.map(p => p.locationFt).filter(x => x > startFt && x < endFt), endFt])].sort((x, y) => x - y);
    const candidates = breakpoints.map(moment);
    // Between point loads, shear varies linearly under the uniform load.
    // A zero-shear location is a possible moment extremum within that interval.
    if (a.uniformLoadPlf > 0) for (let i = 0; i < breakpoints.length - 1; i++) {
      const x = breakpoints[i] + analysis.at(breakpoints[i], 'right').shearLb / a.uniformLoadPlf;
      if (x > breakpoints[i] && x < breakpoints[i + 1]) candidates.push(moment(x));
    }
    const MmaxKipFt = Math.max(...candidates);
    const MaKipFt = moment(startFt + LbFt / 4), MbKipFt = moment(startFt + LbFt / 2), McKipFt = moment(startFt + 3 * LbFt / 4);
    // A zero-moment interval has no meaningful moment-gradient factor; use 1.0.
    const Cb = cbMethod === 'quarter' && MmaxKipFt > 0 ? 12.5 * MmaxKipFt / (2.5 * MmaxKipFt + 3 * MaKipFt + 4 * MbKipFt + 3 * McKipFt) : 1;
    let MnKipIn, ltbRegime, FcrKsi = null;
    if (LbIn <= LpIn) { MnKipIn = MpKipIn; ltbRegime = 'yielding'; }
    else if (LbIn <= LrIn) {
      MnKipIn = Math.min(MpKipIn, Cb * (MpKipIn - (MpKipIn - 0.7 * Fyksi * section.Sx) * (LbIn - LpIn) / (LrIn - LpIn)));
      ltbRegime = 'inelastic LTB';
    } else {
      const slenderness = LbIn / section.rts;
      FcrKsi = Cb * Math.PI ** 2 * Eksi / slenderness ** 2 * Math.sqrt(1 + 0.078 * jr * slenderness ** 2);
      MnKipIn = Math.min(MpKipIn, FcrKsi * section.Sx); ltbRegime = 'elastic LTB';
    }
    const MnKipFt = MnKipIn / 12, allowableKipFt = MnKipFt / 1.67, utilization = MmaxKipFt / allowableKipFt;
    if (![Cb, MmaxKipFt, MaKipFt, MbKipFt, McKipFt, MnKipFt, allowableKipFt, utilization].every(Number.isFinite) || allowableKipFt <= 0) throw new Error('The flexural result is outside the numerical range supported.');
    return Object.freeze({ startFt, endFt, LbFt, Cb, MmaxKipFt, MaKipFt, MbKipFt, McKipFt, MnKipFt, allowableKipFt, utilization, ltbRegime, FcrKsi });
  });
  const governingSegment = segments.reduce((best, segment) => segment.utilization > best.utilization ? segment : best);
  return Object.freeze({ compactness: Object.freeze({ flangeRatio, webRatio, flangeLimit, webLimit }), LpFt: LpIn / 12, LrFt: LrIn / 12, MpKipFt: MpKipIn / 12, omegaB: 1.67, cbMethod, segments: Object.freeze(segments), governingSegment });
}
