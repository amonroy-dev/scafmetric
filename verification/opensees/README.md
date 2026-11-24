# Leg loads checked against OpenSees

The scaffold builder reports a dead and a live load for every leg, and those are
the loads that go onto the beam. This folder checks them against
[OpenSees](https://opensees.berkeley.edu/), an independent structural analysis
program, leg by leg.

## The result

On ten scaffolds, 73 legs in all, every leg's dead load and live load matches
the OpenSees reaction to within 0.01 lb. The beam check matches too: for a beam
under a row of those legs, the reactions, the bending moment and the deflection
agree with an OpenSees beam to within 0.00002 lb-in and 0.0000000001 in.

That match is with ledgers taken as simple spans between standards, which is
what a tributary takeoff assumes. It says the arithmetic is right for the
method. It does not say a frame analysis would give the same numbers: see
[What a tributary takeoff leaves out](#what-a-tributary-takeoff-leaves-out).

## How the check works

`model.mjs` turns a scaffold into a structural model using only the parts as
they were placed. It does not call the builder's takeoff or its live load
attribution, so the two sides share no load-path code.

| Part | In the model |
|---|---|
| Standard | One continuous member, ground to top, held at the ground. Its tube weight is spread up its height; its jack, collar and sill sit at its foot. |
| Ledger | A beam between its two standards, pinned at both ends, carrying its own weight. |
| Plank | Each board is a strip where it is drawn, running the way it is drawn, simply supported on the ledgers it crosses and carrying its own weight. |
| Live load | Strips 3 in wide over the bay, spanning the way the load was set (along the planks, or across them), simply supported on the ledgers they cross. |
| Brace, truss | Half its weight at each end. |
| Guardrail | One tube between each pair of standards it runs past, half its weight at each. |
| Side bracket | Its weight on the standard it hangs from. |

`solve.py` has OpenSees solve each model for dead load and for live load and
reads the vertical reaction at every base. It does so three ways:

- **pinned**: as above. Every load has one path to the ground, so the reactions
  follow from equilibrium alone and no stiffness enters. The builder is held to
  this one.
- **braced**: the same, with the diagonal braces added as axial members.
- **rigid**: ledgers fixed to the standards with no end releases, braces in,
  bases pinned.

`run.mjs` sets the builder's leg loads beside the pinned reactions and reports
how far the two frame solutions move from them. `tests/opensees-leg-loads.test.js`
holds the builder to the stored reactions in `reference/` on every test run, so
the comparison does not need Python once the reference is written.

## The scaffolds

| Scaffold | Legs | What it covers |
|---|---|---|
| `single-bay` | 4 | One 7 x 3 ft bay, decked, railed, 25 psf. |
| `three-bay-run-braced` | 8 | A run of three bays braced on every face, 25 psf. |
| `two-by-two-two-levels` | 9 | Two bays by two, two planked levels, 50 psf above and 25 below, one load turned across its planks. |
| `zigzag` | 19 | Two runs stepped by a bay's depth, 25 psf on one and 75 on the other. |
| `one-bay-loaded-of-six` | 8 | Six bays with one loaded at 75 psf, so most legs carry no live load. |
| `mid-leg-load-along` | 5 | A leg under the middle of a side ledger, load along the planks. |
| `mid-leg-load-across` | 5 | The same, load across the planks. |
| `hung-decks` | 6 | Decks hung on ledgers with the Plank tool, 25 psf beside 75 psf. |
| `older-ledger-patch` | 5 | A load hung between two ledgers with no planks under it, as models saved before loads sat on decks still hold. |
| `brackets-and-truss` | 4 | Dead load only: bracing, side brackets and a truss. |

## What the check found

Live loads matched from the first run. Dead loads did not, for three reasons,
all now fixed in `src/scaffold/workspace/state.js`:

1. **Base hardware was left out.** The jack, collar and sill were in the parts
   list but not in the leg loads, so every leg read about 14 lb light.
2. **A guardrail's weight went to the wrong legs.** A rail round a deck is drawn
   as one line along each edge. It was weighed as a single tube, half on each
   end leg and nothing on the legs between. On the three-bay run that put an
   extra 38 lb on each end leg and left 38 lb off each inner one. A rail is now
   one tube between each pair of standards it passes, in the leg loads and in
   the parts list. Rails are also weighed as ledger tube in both places; the
   parts list had been using the brace tube.
3. **Plank weight was shared equally among the legs round a bay.** That is right
   for four legs at the corners and wrong otherwise. A plank bears on the
   ledgers at its two ends, so a leg under the middle of a side ledger carries
   none of it. Plank weight now follows the same path as the live load on it.

With those fixed, the sum of the leg dead loads equals the parts list weight,
and every leg matches OpenSees.

## What a tributary takeoff leaves out

The frame solutions move load between legs. The table gives the largest rise
and the largest fall in any one leg's total load, against the pinned solution.
Totals do not change; only the share between legs does.

| Scaffold | Braces added | Rigid joints |
|---|---|---|
| `single-bay` | no braces | 0% |
| `hung-decks` | no braces | 0% |
| `one-bay-loaded-of-six` | no braces | 0% |
| `brackets-and-truss` | under 1% | +2.5% / -2.5% (4 lb) |
| `mid-leg-load-along` | no braces | +3.2% (2 lb) |
| `three-bay-run-braced` | +9.1% (24 lb) / -7.8% (35 lb) | +7.7% / -7.9% (35 lb) |
| `zigzag` | no braces | +13.5% (95 lb) / -20.6% (50 lb), at the step only |
| `older-ledger-patch` | no braces | +14.2% (30 lb) / -32.1% (15 lb) |
| `two-by-two-two-levels` | +19.3% (235 lb) / -20.7% (468 lb) | +11.2% / -26.2% (592 lb) |
| `mid-leg-load-across` | no braces | +29.7% (93 lb) / -23.6% (46 lb) |

Two things do it:

- **A loaded ledger that runs over a standard.** Taken as two simple spans, the
  standard in the middle gets half of each. If the joint carries moment, the two
  spans act as one continuous beam and the middle standard takes more, up to a
  quarter more for two equal spans, with the outer two taking less. This shows
  wherever planks bear on a line of ledgers that passes over a leg: a deck two
  bays deep, the step of the zigzag, a load turned across its planks onto a
  ledger with a leg under its middle. In a single run of bays the planks bear
  on ledgers that span one bay, and the rigid solution is within half a percent
  of the pinned one.
- **Braces between legs that carry different loads.** The heavier leg shortens
  more, the brace resists, and load moves to the lighter leg.

How much of either a real scaffold has depends on how stiff its wedge-head
joints are and how much play its brace connections have, which this check does
not settle. The pinned and rigid solutions are the two ends of the range.

## Running it

```
pip install openseespy
node verification/opensees/run.mjs            # compare and report
node verification/opensees/run.mjs --save     # also rewrite reference/
```

Set `OPENSEES_PYTHON` to the Python that has `openseespy` if it is not the
`python` on the path. The run exits non-zero if any leg is off by more than
0.01 lb. Checked with OpenSees 3.8.0.
