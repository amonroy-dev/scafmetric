// Screen gate for the scaffold builder.
//
// The workspace is a 3D CAD surface: a 96 px tool rail, the canvas, and a
// 332 px sidebar, driven by middle-drag pan, right-drag orbit and SHIFT/R/ALT
// modifiers while placing. None of that works on a phone, so the builder is
// gated rather than shipped broken, and the beam analysis carries on as normal.
//
// Kept free of DOM access so it can be unit-tested.

export const MIN_WORKSPACE_WIDTH_PX = 900;
export const MIN_WORKSPACE_HEIGHT_PX = 520;

export function workspaceSupported(win = typeof window === 'undefined' ? null : window) {
  if (!win) return false;
  const wide = win.innerWidth >= MIN_WORKSPACE_WIDTH_PX;
  const tall = win.innerHeight >= MIN_WORKSPACE_HEIGHT_PX;
  return wide && tall;
}
