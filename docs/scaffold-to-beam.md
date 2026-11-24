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

Tributary method, with every ledger taken as a simple span between standards:

- **Dead per leg** = its standard and base hardware (jack, collar, sill) + half of
  every ledger, brace, truss and guardrail tube that ends on it + the side
  brackets hung on it + its share of the planks.
- **Planks** bear on the ledgers at their two ends, and each of those ledgers
  passes what it gets to the legs at its own ends. For a bay with a leg at each
  corner that is a quarter each; a leg under the middle of a side ledger carries
  none.
- **Guardrails** are one tube between each pair of standards a rail runs past.
- **Live per leg** = only the live loads placed with the Live load tool (below).
  A planked bay carries no live load of its own.
- The leg dead loads add up to the parts list weight.

These leg loads are checked against OpenSees, leg by leg, and match to within
0.01 lb: see [verification/opensees](../verification/opensees/README.md).

It is a tributary takeoff, not a frame analysis. Where a loaded ledger runs over
a standard, or braces link legs carrying different loads, a frame analysis moves
some load between legs (the totals do not change). The same page gives the size
of that effect on each test scaffold.

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

## The estimating-use notice

The scaffold builder is for bids and planning, not engineering. The first time a
person opens it they are shown a page that says so and must tick two statements
before it opens: that they will use it for estimating and bid purposes only, and
that it is not engineering and does not replace a qualified person or a licensed
professional engineer.

- The wording is in `src/scaffold-notice.js`. To change it, edit it there and
  bump `SCAFFOLD_NOTICE_VERSION`; everyone is then asked again.
- Agreement is recorded on the account (`scaffoldNoticeVersion`,
  `scaffoldNoticeAcceptedAt` in `scafmetricAccounts`), with the date set by the
  server. The first agreement to a version is kept and never moved.
- It is asked once per account, not once per browser. The admin page shows, for
  any user, whether and when they agreed.
- If the record cannot be written the builder still opens, and the person is
  asked again on their next visit.
- Files exported from the builder carry the same message, because they travel to
  people who never saw the notice. The parts list CSV ends with two lines saying
  it is an estimate, and the DXF has them drawn beside the model on the
  `SCF_NOTES` layer and written as comments in the file. The wording is
  `SCAFFOLD_EXPORT_NOTE` in the same file as the notice.
- The terms of use have a section on the scaffold builder that says the same
  things at more length.

## Saved work

Beam inputs and the scaffold model are saved in the browser, and copied to the
signed-in account so they follow the person to another device. The two are saved
separately: each has its own time on the account, saving one leaves the other
alone, and a copy more than 30 days old is not handed back. When both the browser
and the account hold a copy, the newer one is used, judged for that half alone.
