/**
 * AISC 360-16, Chapter G, Section G2.1(a): major-axis shear of a rolled
 * W-shaped I-section with a stocky web. Units: inches, ksi and kips.
 * This evaluates the stated steel-web shear limit state only. It is not a
 * scaffold-capacity, connection, bearing, torsion, or overall design check.
 * The W properties must be checked against the official AISC source.
 */
export function checkMajorAxisShear({ section, FyKsi, Eksi, demandKip } = {}) {
  const unavailable = reason => ({ status: 'not_evaluated', reason });
  if (!section || section.Type !== 'W') return unavailable('Select a rolled W section.');
  const d = section.d, tw = section.tw, kdes = section.kdes;
  const values = [d, tw, kdes, FyKsi, Eksi, demandKip];
  if (!values.every(Number.isFinite) || d <= 0 || tw <= 0 || kdes <= 0 || FyKsi <= 0 || Eksi <= 0 || demandKip < 0)
    return unavailable('Valid section dimensions, yield stress, elastic modulus, and nonnegative shear demand are required.');
  const clearWebIn = d - 2 * kdes;
  if (clearWebIn <= 0 || tw >= d) return unavailable('The section web dimensions are invalid.');
  const hOverTw = clearWebIn / tw;
  const slendernessLimit = 2.24 * Math.sqrt(Eksi / FyKsi);
  if (![hOverTw, slendernessLimit].every(Number.isFinite)) return unavailable('The section web slenderness could not be determined.');
  // G2.1(a) only. The alternative provisions for more slender webs,
  // transverse stiffeners and tension-field action are not implemented.
  if (hOverTw > slendernessLimit) return unavailable('The web exceeds the G2.1(a) rolled-I-section slenderness limit; other shear provisions are not implemented.');
  const AwIn2 = d * tw;
  const nominalKip = 0.6 * FyKsi * AwIn2;
  const omega = 1.5;
  const allowableKip = nominalKip / omega;
  const utilization = demandKip / allowableKip;
  if (![AwIn2, nominalKip, allowableKip, utilization].every(Number.isFinite) || allowableKip <= 0)
    return unavailable('The shear strength could not be calculated from these values.');
  return Object.freeze({
    status: 'evaluated', reference: 'AISC 360-16 G2.1(a), G2-1; ASD',
    sectionName: section.AISC_Manual_Label || '', dIn: d, twIn: tw, kdesIn: kdes, clearWebIn,
    hOverTw, slendernessLimit, FyKsi, Eksi, AwIn2, Cv1: 1, nominalKip, omega,
    allowableKip, demandKip, utilization, meets: utilization <= 1
  });
}
