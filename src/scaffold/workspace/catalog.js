// Generic component catalog for the scaffold builder.
//
// Lengths match the real system sizes, but parts are identified by SIZE ONLY —
// no manufacturer names or part numbers, per the project checklist.

const ft = (f, i = 0) => f + i / 12;

export const CATEGORIES = ['standards', 'ledgers', 'braces', 'lightTrusses', 'heavyTrusses', 'trusses', 'brackets', 'planks'];

export const CATALOG = {
  standards: {
    label: 'Standards',
    code: 'STD',
    unit: 'length',
    parts: [
      { id: 'std-9-10', label: '9 ft 10 in', lengthFt: ft(9, 10.125) },
      { id: 'std-6-7', label: '6 ft 7 in', lengthFt: ft(6, 6.75) },
      { id: 'std-4-11', label: '4 ft 11 in', lengthFt: ft(4, 11.0625) },
      { id: 'std-3-3', label: '3 ft 3 in', lengthFt: ft(3, 3.375) },
      { id: 'std-1-8', label: '1 ft 8 in', lengthFt: ft(1, 7.6875) },
    ],
  },
  ledgers: {
    label: 'Ledgers',
    code: 'LED',
    unit: 'length',
    parts: [
      { id: 'led-10', label: '10 ft', lengthFt: 10 },
      { id: 'led-8', label: '8 ft', lengthFt: 8 },
      { id: 'led-7', label: '7 ft', lengthFt: 7 },
      { id: 'led-6', label: '6 ft', lengthFt: 6 },
      { id: 'led-5', label: '5 ft', lengthFt: 5 },
      { id: 'led-4', label: '4 ft', lengthFt: 4 },
      { id: 'led-3-6', label: '3 ft 6 in', lengthFt: 3.5 },
      { id: 'led-3', label: '3 ft', lengthFt: 3 },
      { id: 'led-2', label: '2 ft', lengthFt: 2 },
    ],
  },
  braces: {
    label: 'Braces',
    code: 'BRC',
    unit: 'bay',
    parts: [
      { id: 'brc-10', label: '10 ft bay', lengthFt: 10 },
      { id: 'brc-8', label: '8 ft bay', lengthFt: 8 },
      { id: 'brc-7', label: '7 ft bay', lengthFt: 7 },
      { id: 'brc-6', label: '6 ft bay', lengthFt: 6 },
      { id: 'brc-5', label: '5 ft bay', lengthFt: 5 },
      { id: 'brc-4', label: '4 ft bay', lengthFt: 4 },
      { id: 'brc-3-6', label: '3 ft 6 in bay', lengthFt: 3.5 },
      { id: 'brc-2', label: '2 ft bay', lengthFt: 2 },
    ],
  },
  // Three truss families, each spanning two rosettes at one lift (parts.js).
  lightTrusses: {
    label: 'Light trusses',
    code: 'LTR',
    unit: 'length',
    family: 'light',
    parts: [
      { id: 'ltr-10', label: '10 ft', lengthFt: 10 },
      { id: 'ltr-8', label: '8 ft', lengthFt: 8 },
      { id: 'ltr-7', label: '7 ft', lengthFt: 7 },
      { id: 'ltr-6', label: '6 ft', lengthFt: 6 },
      { id: 'ltr-5', label: '5 ft', lengthFt: 5 },
    ],
  },
  heavyTrusses: {
    label: 'Heavy trusses',
    code: 'HTR',
    unit: 'length',
    family: 'heavy',
    parts: [
      { id: 'htr-10', label: '10 ft', lengthFt: 10 },
      { id: 'htr-8', label: '8 ft', lengthFt: 8 },
      { id: 'htr-7', label: '7 ft', lengthFt: 7 },
      { id: 'htr-6', label: '6 ft', lengthFt: 6 },
      { id: 'htr-5', label: '5 ft', lengthFt: 5 },
    ],
  },
  trusses: {
    label: 'Trusses',
    code: 'TRS',
    unit: 'length',
    family: 'truss',
    parts: [
      { id: 'trs-20', label: '20 ft', lengthFt: 20 },
      { id: 'trs-18', label: '18 ft', lengthFt: 18 },
      { id: 'trs-16', label: '16 ft', lengthFt: 16 },
      { id: 'trs-15', label: '15 ft', lengthFt: 15 },
      { id: 'trs-14', label: '14 ft', lengthFt: 14 },
      { id: 'trs-12', label: '12 ft', lengthFt: 12 },
      { id: 'trs-10', label: '10 ft', lengthFt: 10 },
      { id: 'trs-9', label: '9 ft', lengthFt: 9 },
      { id: 'trs-8', label: '8 ft', lengthFt: 8 },
      { id: 'trs-7', label: '7 ft', lengthFt: 7 },
      { id: 'trs-6', label: '6 ft', lengthFt: 6 },
      { id: 'trs-5', label: '5 ft', lengthFt: 5 },
    ],
  },
  brackets: {
    label: 'Side brackets',
    code: 'BRK',
    unit: 'length',
    parts: [
      { id: 'brk-3-6', label: '3 ft 6 in', lengthFt: 3.5 },
      { id: 'brk-3', label: '3 ft', lengthFt: 3 },
      { id: 'brk-2', label: '2 ft', lengthFt: 2 },
    ],
  },
  planks: {
    label: 'Planks',
    code: 'PLK',
    unit: 'length',
    parts: [
      { id: 'plk-10', label: '10 ft', lengthFt: 10, widthIn: 9.5 },
      { id: 'plk-8', label: '8 ft', lengthFt: 8, widthIn: 9.5 },
      { id: 'plk-7', label: '7 ft', lengthFt: 7, widthIn: 9.5 },
      { id: 'plk-6', label: '6 ft', lengthFt: 6, widthIn: 9.5 },
      { id: 'plk-5', label: '5 ft', lengthFt: 5, widthIn: 9.5 },
      { id: 'plk-4', label: '4 ft', lengthFt: 4, widthIn: 9.5 },
    ],
  },
};

// Default selection per category.
export const DEFAULT_PART = {
  standards: 'std-6-7',
  ledgers: 'led-7',
  braces: 'brc-7',
  planks: 'plk-7',
  brackets: 'brk-2',
  lightTrusses: 'ltr-7',
  heavyTrusses: 'htr-7',
  trusses: 'trs-7',
};

export function getPart(categoryKey, partId) {
  const cat = CATALOG[categoryKey];
  if (!cat) return null;
  return cat.parts.find(p => p.id === partId) || cat.parts[0] || null;
}

// The tool each catalog category drives.
export const CATEGORY_TOOL = {
  standards: 'standard',
  ledgers: 'ledger',
  braces: 'brace',
  planks: 'plank',
  brackets: 'bracket',
  lightTrusses: 'truss',
  heavyTrusses: 'truss',
  trusses: 'truss',
};
