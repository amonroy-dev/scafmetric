// Bill of materials for the scaffold builder, following the line-item/summary
// shape of ScaffoldPro's bomDerivation.ts but kept generic: components are
// identified by SIZE, never by manufacturer part number.
//
// Pure math (no three.js, no DOM) so it is unit-testable.

import { tubeWeightPerFoot, STEEL_DENSITY_LB_FT3 } from '../catalog.js';
import {
  WOOD_SILL, JACK_PLATE, JACK_STEM, HANDLE_NUT, BASE_COLLAR,
  STANDARD_TUBE_OD_IN, PLANK, inchesToFeet, trussMemberLengthFt, sideBracketTubeLengthFt,
} from './parts.js';

export const CATEGORY_ORDER = ['Standards', 'Bases', 'Ledgers', 'Trusses', 'Diagonals', 'Brackets', 'Guardrails', 'Planks'];

// Softwood sill pad; everything else is steel.
const WOOD_DENSITY_LB_FT3 = 35;
const STEEL_LB_PER_IN3 = STEEL_DENSITY_LB_FT3 / 1728;

export function formatFeetInches(ft) {
  if (!Number.isFinite(ft)) return '—';
  const totalIn = Math.round(ft * 12 * 16) / 16;
  const feet = Math.floor(totalIn / 12);
  const inches = totalIn - feet * 12;
  const inchStr = Number.isInteger(inches) ? `${inches}` : inches.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return feet > 0 ? `${feet} ft ${inchStr} in` : `${inchStr} in`;
}

// --- procedural component weights -------------------------------------------
// Derived from the modelled geometry and material density, so the BOM always
// agrees with what is drawn.

export function woodSillWeightLb() {
  const volIn3 = WOOD_SILL.widthIn * WOOD_SILL.depthIn * WOOD_SILL.thicknessIn;
  return (volIn3 / 1728) * WOOD_DENSITY_LB_FT3;
}

export function screwJackWeightLb(jackExtensionIn = 0) {
  const plate = JACK_PLATE.sizeIn ** 2 * JACK_PLATE.thicknessIn;
  const rodLen = JACK_STEM.baseHeightIn + Math.max(0, jackExtensionIn);
  const rod = Math.PI * (JACK_STEM.rodDiameterIn / 2) ** 2 * rodLen;
  const nut = Math.PI * (HANDLE_NUT.diameterIn / 2) ** 2 * HANDLE_NUT.heightIn;
  const wings = 2 * HANDLE_NUT.wingLenIn * HANDLE_NUT.wingThickIn * HANDLE_NUT.wingHeightIn;
  return (plate + rod + nut + wings) * STEEL_LB_PER_IN3;
}

// The collar's two tubes: the one over the jack and the sleeve around the
// standard's foot.
export function baseCollarWeightLb() {
  const ring = (od, lengthIn) => (Math.PI / 4) * (od ** 2 - (od - 2 * BASE_COLLAR.wallIn) ** 2) * lengthIn;
  const sleeveIn = BASE_COLLAR.sleeveBelowBaseIn + BASE_COLLAR.sleeveAboveBaseIn;
  const volIn3 = ring(BASE_COLLAR.tubeOdIn, BASE_COLLAR.heightIn) + ring(BASE_COLLAR.sleeveOdIn, sleeveIn);
  return volIn3 * STEEL_LB_PER_IN3;
}

export function plankBoardWeightLb(widthIn, lengthFt, areaWeightLbPerFt2) {
  return inchesToFeet(widthIn) * lengthFt * areaWeightLbPerFt2;
}

function round(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }
const sizeKey = ft => Math.round(ft * 1000) / 1000;

/**
 * Derive the bill of materials from the current scaffold state.
 * Returns { lineItems, summary }.
 */
export function deriveBom(state) {
  const rows = new Map(); // key -> mutable line item
  const add = (category, key, description, quantity, unitWeightLb) => {
    const id = `${category}:${key}`;
    const existing = rows.get(id);
    if (existing) { existing.quantity += quantity; return existing; }
    const item = { id, category, description, quantity, unitWeightLb };
    rows.set(id, item);
    return item;
  };

  const perFootStandard = tubeWeightPerFoot(state.components.standard);
  const perFootLedger = tubeWeightPerFoot(state.components.ledger);
  const perFootBrace = tubeWeightPerFoot(state.components.brace);
  const plankPsf = state.components.plank.areaWeightLbPerFt2;

  // Standards, grouped by segment length.
  for (const s of state.standards.values()) {
    for (const len of s.segments) {
      add('Standards', `len${sizeKey(len)}`,
        `Standard tube ${STANDARD_TUBE_OD_IN} in OD · ${formatFeetInches(len)}`,
        1, perFootStandard * len);
    }
  }

  // Base assembly: one per standard column.
  const legCount = state.standards.size;
  if (legCount > 0) {
    add('Bases', 'jack', `Screw jack · ${round(state.base.jackExtensionIn, 2)} in extension`,
      legCount, screwJackWeightLb(state.base.jackExtensionIn));
    if (state.base.showWoodSill) {
      add('Bases', 'sill', `Wood sill ${WOOD_SILL.widthIn} x ${WOOD_SILL.depthIn} x ${WOOD_SILL.thicknessIn} in`,
        legCount, woodSillWeightLb());
    }
    if (state.base.showBaseCollar) {
      add('Bases', 'collar', `Base collar · ${formatFeetInches(inchesToFeet(BASE_COLLAR.heightIn))}`,
        legCount, baseCollarWeightLb());
    }
  }

  for (const l of state.ledgers.values()) {
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]);
    add('Ledgers', `len${sizeKey(len)}`, `Ledger tube · ${formatFeetInches(len)}`, 1, perFootLedger * len);
  }

  for (const b of state.braces.values()) {
    const len = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]);
    add('Diagonals', `len${sizeKey(len)}`, `Diagonal brace · ${formatFeetInches(len)}`, 1, perFootBrace * len);
  }

  if (state.trusses) {
    for (const t of state.trusses.values()) {
      const len = Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]);
      add('Trusses', `len${sizeKey(len)}`, `Triangular truss · ${formatFeetInches(len)}`,
        1, trussWeightLb(len, state));
    }
  }
  if (state.guardrails) {
    for (const g of state.guardrails.values()) {
      const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]);
      const label = g.kind === 'post' ? 'Guardrail post' : 'Guardrail rail';
      add('Guardrails', `${g.kind}${sizeKey(len)}`, `${label} · ${formatFeetInches(len)}`,
        1, tubeWeightPerFoot(state.components.brace) * len);
    }
  }
  if (state.brackets) {
    for (const br of state.brackets.values()) {
      add('Brackets', `len${sizeKey(br.lengthFt)}`,
        `Side bracket · ${formatFeetInches(br.lengthFt)}`, 1, bracketWeightLb(br.lengthFt, state));
    }
  }

  for (const p of state.plankBays()) {
    for (const board of p.boards) {
      add('Planks', `w${board.widthIn}l${sizeKey(board.lengthFt)}`,
        `Deck plank · ${board.widthIn} in x ${formatFeetInches(board.lengthFt)}`,
        1, plankBoardWeightLb(board.widthIn, board.lengthFt, plankPsf));
    }
  }

  const lineItems = [...rows.values()]
    .map(r => ({
      ...r,
      unitWeightLb: round(r.unitWeightLb, 2),
      totalWeightLb: round(r.unitWeightLb * r.quantity, 2),
    }))
    .sort((a, b) => {
      const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
      if (ca !== cb) return ca - cb;
      return a.description.localeCompare(b.description);
    });

  const summary = {
    lineItemCount: lineItems.length,
    totalQuantity: lineItems.reduce((a, r) => a + r.quantity, 0),
    totalWeightLb: round(lineItems.reduce((a, r) => a + r.totalWeightLb, 0), 2),
  };
  return { lineItems, summary };
}

// A side bracket is a chord, post, diagonal and socket; weight follows the tubing.
export function bracketWeightLb(lengthFt, state) {
  return tubeWeightPerFoot(state.components.ledger) * sideBracketTubeLengthFt(lengthFt);
}

export function trussWeightLb(spanFt, state) {
  return tubeWeightPerFoot(state.components.ledger) * trussMemberLengthFt(spanFt);
}

// Plain-text export (CSV) for the BOM table.
export function bomToCsv(bom) {
  const head = 'Category,Description,Qty,Unit weight (lb),Total weight (lb)';
  const lines = bom.lineItems.map(r =>
    [r.category, `"${r.description.replace(/"/g, '""')}"`, r.quantity, r.unitWeightLb, r.totalWeightLb].join(','));
  const total = `,,${bom.summary.totalQuantity},,${bom.summary.totalWeightLb}`;
  return [head, ...lines, total].join('\n');
}
