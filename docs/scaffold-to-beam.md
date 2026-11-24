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
- **Live per leg** = only the live loads placed with the Live load tool (below).
  A planked bay carries no live load of its own.
- Tributary area for the plank weight uses the quarter-bay rule, so legs' areas
  sum exactly to the planked footprint.

This is an approximation suitable for preliminary leg-reaction estimates, not a
rigid-frame distribution.

### Placed live loads (one-way)

The **Live load** tool puts a load on a planked bay: point at the deck and click
(Shift takes every bay joined to it at that lift). Each bay has its own load in
lb/ft², 25 unless another is typed. A bay that was not loaded this way carries no
live load, and the Send to beam card says so when no load is placed at all.

A placed load is a one-way area load, attributed the way RISA-3D attributes a
one-way member area load:

- It spans **along the planks** by default, because planks bear on the ledgers at
  their ends. **R** turns it to span across them, onto the other pair of ledgers;
  a bay with ledgers on two sides only cannot be turned. The arrows on the load
  show the span.
- Each strip of the load is carried by the nearest ledger either side of it along
  the span, as a simply supported deck: each takes the share set by how far the
  other is.
- If there is no ledger one way along the span, that part of the load goes
  two-way, to the nearest ledgers whichever way they lie, each by how near it is.
- Each ledger then passes its load to the legs at its two ends as a simple span.

RISA's result depends on its area-load mesh; this takes each stretch between two
ledgers whole, which is what a fine mesh converges to, so a hand check of a
rectangular bay agrees exactly. A load sits on its deck: remove the planks and the
load goes with them.

## Beam placement & import

The beam is positioned along a chosen grid line (X or Y); its span is read from the
beam workspace, with the left support at the first leg on that line. Each selected
leg's distance from the left support is preserved at full precision. Legs that fall
off the beam line or past the span are **flagged and excluded** from import (not
silently clamped). Importing replaces any prior scaffold-imported rows; manually
entered loads are left untouched.
