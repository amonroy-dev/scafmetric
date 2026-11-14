/**
 * Discrete lateral brace locations, measured in feet from the left support.
 * Both supports are included as end restraints. The user must confirm adequate
 * lateral restraint of the compression flange and twist restraint at the ends;
 * these locations do not establish brace strength or stiffness.
 *
 * The supported simply supported beam has downward loading and sagging bending,
 * so only the top-flange locations define its F2 unbraced lengths. Bottom-flange
 * locations are retained independently; they are never combined with the top.
 */
function checkedSpan(spanFt) {
  if (!Number.isFinite(spanFt) || spanFt <= 0) throw new Error('A positive finite span is required for brace locations.');
}

function braceDefinition(locations, spanFt, flange) {
  if (!Array.isArray(locations) || locations.length < 2 || locations[0] !== 0 || locations[locations.length - 1] !== spanFt || locations.some((x, i) => !Number.isFinite(x) || x < 0 || x > spanFt || (i > 0 && x <= locations[i - 1]))) {
    throw new Error(`Brace locations for the ${flange} flange must increase from 0 to the span and include both end restraints.`);
  }
  return Object.freeze({
    locations: Object.freeze([...locations]),
    segments: Object.freeze(locations.slice(1).map((x, i) => x - locations[i]))
  });
}

function assembled(top, bottom) {
  return Object.freeze({
    top, bottom, compressionFlange: 'top',
    // Legacy consumers use the active compression-flange definition.
    locations: top.locations, segments: top.segments
  });
}

/** Validate numerical definitions; legacy bracesFt means the same list for both flanges. */
export function resolveFlangeBracing({ spanFt, bracesFt, topBracesFt = bracesFt, bottomBracesFt = bracesFt }) {
  checkedSpan(spanFt);
  return assembled(braceDefinition(topBracesFt, spanFt, 'top'), braceDefinition(bottomBracesFt, spanFt, 'bottom'));
}

/** Parse independent x-location lists. Blank means end restraints only. */
export function parseFlangeBracing({ top = '', bottom = '', spanFt }) {
  checkedSpan(spanFt);
  const parse = (value, flange) => {
    if (typeof value !== 'string') throw new Error(`Enter ${flange}-flange brace locations as comma-separated distances in feet.`);
    const tokens = value.trim() ? value.split(',').map(token => token.trim()) : [];
    if (tokens.some(token => !token || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token))) {
      throw new Error(`Enter ${flange}-flange brace locations as comma-separated numbers between 0 and the span.`);
    }
    const values = tokens.map(Number);
    if (values.some(x => !Number.isFinite(x) || x < 0 || x > spanFt)) throw new Error(`${flange[0].toUpperCase() + flange.slice(1)}-flange brace locations must be between 0 and the span.`);
    return braceDefinition([...new Set([0, ...values, spanFt])].sort((a, b) => a - b), spanFt, flange);
  };
  return assembled(parse(top, 'top'), parse(bottom, 'bottom'));
}
