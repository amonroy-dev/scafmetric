// Centerline DXF export, following the structure of ScaffoldPro's
// utils/dxf/risa3dDxf.ts: group-code pairs, a POINT per joint and a LINE per
// member, on per-type layers. Analysis packages map POINT -> joints and
// LINE -> members. Pure string building — unit-testable.

import { trussWorldMembers, sideBracketWorldMembers } from './parts.js';

export const LAYERS = {
  jack: 'SCF_JACK',
  standard: 'SCF_STANDARD',
  ledger: 'SCF_LEDGER',
  brace: 'SCF_BRACE',
  bracket: 'SCF_BRACKET',
  guardrail: 'SCF_GUARDRAIL',
  truss: 'SCF_TRUSS',
  joint: 'SCF_JOINTS',
};

function fmt(v, precision = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(precision);
}

function posKey(p, precision = 6) {
  return `${fmt(p[0], precision)},${fmt(p[1], precision)},${fmt(p[2], precision)}`;
}

/**
 * Centerline model of the scaffold: one segment per member plus the distinct
 * joint points. Coordinates are in feet.
 */
export function buildCenterlineModel(state) {
  const segments = [];
  const joints = new Map();
  const addJoint = p => { const k = posKey(p); if (!joints.has(k)) joints.set(k, p); };
  const addSegment = (a, b, layer, id = null) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 1e-9) return;
    segments.push({ start: a, end: b, layer, id });
    addJoint(a); addJoint(b);
  };

  const base = state.baseOffsetFt();
  for (const s of state.standards.values()) {
    // The base assembly, ground to the standard's foot, as ScaffoldPro's
    // centerlines draw it: a ledger on the collar's rosette lands on this.
    addSegment([s.x, s.y, 0], [s.x, s.y, base], LAYERS.jack, s.id);
    // One segment per stacked lift, so joints land at each splice.
    let z = base;
    for (const len of s.segments) {
      addSegment([s.x, s.y, z], [s.x, s.y, z + len], LAYERS.standard, s.id);
      z += len;
    }
  }
  for (const l of state.ledgers.values()) addSegment(l.a, l.b, LAYERS.ledger, l.id);
  for (const b of state.braces.values()) addSegment(b.a, b.b, LAYERS.brace, b.id);
  // A side bracket is a frame, not a cantilever: chord, post, diagonal, socket.
  for (const k of state.brackets.values()) {
    for (const m of sideBracketWorldMembers(k, k.dir, k.lengthFt)) addSegment(m.a, m.b, LAYERS.bracket, k.id);
  }
  for (const g of state.guardrails?.values?.() ?? []) addSegment(g.a, g.b, LAYERS.guardrail, g.id);
  // Trusses contribute their full member set, so the skeleton and the DXF show
  // the real triangular frame rather than a single line.
  for (const t of state.trusses?.values?.() ?? []) {
    for (const seg of trussWorldMembers(t.a, t.b, t.family)) addSegment(seg.a, seg.b, LAYERS.truss, t.id);
  }

  return { segments, points: [...joints.values()] };
}

/**
 * Serialise a centerline model to DXF text.
 * `axis` 'zup' keeps feet/Z-up; 'yup' swaps Y and Z for packages that expect it.
 */
export function buildDxf(model, options = {}) {
  const { precision = 6, includeJoints = true, axis = 'zup', newline = '\r\n', title = 'Scafmetric scaffold centerlines' } = options;
  const out = [];
  const pair = (code, value) => { out.push(String(code)); out.push(String(value)); };
  const map = p => (axis === 'yup' ? [p[0], p[2], p[1]] : p);

  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1015');
  pair(9, '$INSUNITS'); pair(70, 2); // 2 = feet
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, Object.keys(LAYERS).length);
  let colour = 1;
  for (const name of Object.values(LAYERS)) {
    pair(0, 'LAYER');
    pair(2, name);
    pair(70, 0);
    pair(62, colour);
    pair(6, 'CONTINUOUS');
    colour = (colour % 7) + 1;
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  pair(999, title);
  pair(999, `Units=feet, Axis=${axis}`);

  if (includeJoints) {
    for (const raw of model.points) {
      const p = map(raw);
      pair(0, 'POINT');
      pair(8, LAYERS.joint);
      pair(10, fmt(p[0], precision));
      pair(20, fmt(p[1], precision));
      pair(30, fmt(p[2], precision));
    }
  }
  for (const s of model.segments) {
    const a = map(s.start), b = map(s.end);
    pair(0, 'LINE');
    pair(8, s.layer);
    pair(10, fmt(a[0], precision));
    pair(20, fmt(a[1], precision));
    pair(30, fmt(a[2], precision));
    pair(11, fmt(b[0], precision));
    pair(21, fmt(b[1], precision));
    pair(31, fmt(b[2], precision));
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return out.join(newline) + newline;
}

export function exportScaffoldDxf(state, options) {
  return buildDxf(buildCenterlineModel(state), options);
}
