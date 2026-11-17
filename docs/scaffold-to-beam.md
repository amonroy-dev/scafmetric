# Scaffold-to-beam workflow

A modal in the beam workspace (**Loads → Import loads from scaffold**) that lets you
configure a scaffold in a 3D canvas, pick the legs resting on a beam, and import
their reactions into the beam analysis as point loads — with **dead and live kept
separate** and each load placed at its **exact distance from the left support**.

## What was reused vs. rebuilt

The source scaffold projects (`Scaffxiq_v2`, `ScaffoldPro`) are React + three.js +
TypeScript. Scafmetric is a vanilla-JS static site, so their components cannot be
imported directly. Instead the **concepts** were adapted into dependency-free
modules:

- `src/scaffold/catalog.js` — generic component specs + steel self-weight formula.
- `src/scaffold/model.js` — grid of standards/ledgers/braces/planks + per-leg load takeoff.
- `src/scaffold/legloads.js` — leg → beam point-load mapping.
- `src/scaffold/render3d.js` — a small pinhole 3D renderer on a 2D canvas (orbit/pan/zoom, leg picking). No three.js/WebGL, so the offline static build is untouched.
- `src/scaffold/modal.js` / `launch.js` — UI wiring.

Removed from the source scope: building mode, manufacturer names/part numbers,
rosettes, and mouthpieces. Standards, ledgers, and braces render as generic tubes.

## Weight basis

Steel unit weight **490 lb/ft³**. Tube self-weight comes from the actual
cross-section: `A = π/4 (OD² − ID²)`, `ID = OD − 2·wall`.

| Component | Basis | Status |
|-----------|-------|--------|
| **Standard** (leg) | 1.9″ OD × 0.12″ wall, **+20%** → ≈ **2.74 lb/ft** | **Settled** (from the checklist) |
| Ledger | 1.9″ OD × 0.12″ wall, +20% (same tube, provisional) | **Assumption — editable** |
| Brace | 1.9″ OD × 0.12″ wall, +25% end allowance | **Assumption — editable** |
| Plank | 3.0 lb/ft² generic steel-plank equivalent | **Placeholder — editable**, pending published-spec research |

Only the standard's three numbers are settled. Ledger/brace/plank values are
editable in the modal's **Component assumptions** panel and are clearly flagged as
unverified. Component-weight details are kept internal to the calculation — they are
never shown as product specifications. Published steel-plank spec research (multiple
cited sources, lb/ft² comparison) is still a pending deliverable; see
[scaffold-to-beam-research-checklist.md](scaffold-to-beam-research-checklist.md).

## Load path (preliminary — not a code check)

Tributary-area method:

- **Dead per leg** = its full standard self-weight + half of every ledger/brace
  framing into it + tributary plank self-weight.
- **Live per leg** = tributary deck area × live load (lb/ft², editable; default 25).
- Tributary area uses the quarter-bay rule, so legs' areas sum exactly to the
  planked footprint.

This is an approximation suitable for preliminary leg-reaction estimates, not a
rigid-frame distribution.

## Beam placement & import

The beam is positioned along a chosen grid line (X or Y); its span is read from the
beam workspace, with the left support at the first leg on that line. Each selected
leg's distance from the left support is preserved at full precision. Legs that fall
off the beam line or past the span are **flagged and excluded** from import (not
silently clamped). Importing replaces any prior scaffold-imported rows; manually
entered loads are left untouched.
