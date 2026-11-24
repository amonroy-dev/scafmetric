# Leg loads checked against OpenSees

The scaffold builder reports a dead and a live load for every leg, and those are
the loads that go onto the beam. This folder checks them against
[OpenSees](https://opensees.berkeley.edu/), an independent structural analysis
program, leg by leg.

## The result

On fourteen scaffolds, 106 legs in all, every leg's dead load and live load matches
the OpenSees reaction to within 0.01 lb. The beam check matches too: for a beam
under a row of those legs, the reactions, the bending moment and the deflection
agree with an OpenSees beam to within 0.00002 lb-in and 0.0000000001 in.

That match is with ledgers taken as simple spans between standards, which is
what a tributary takeoff assumes, and with a side bracket's overturning held by
the leg it hangs on and the leg behind it as a pair of forces. It says the
arithmetic is right for the method. It does not say a frame analysis would give
the same numbers: see
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
| Side bracket | Its arm is a member: continuous, rigid where it meets the standard it hangs on, free at its tip, which is what a cantilever is. A deck bears on the arm as on a ledger, and a ledger or brace can end on its tip rosette. The frame's own weight is on the arm, each tube of it at its own middle. |
| Standard in a bracket | One continuous member from the bracket's tip up. It has no base and no support of its own: only the bracket holds it. |

`solve.py` has OpenSees solve each model for dead load and for live load and
reads the vertical reaction at every base. It does so up to four ways:

- **pinned**: as above, with every base held rigidly. Every load has one path
  to the ground, so the reactions follow from equilibrium alone and no stiffness
  enters. A load on a side bracket goes down the leg the bracket hangs on, and
  its overturning is taken out at that leg's foot as a moment.
- **levered**: only for a scaffold with side brackets that have a leg behind
  them. A leg on a screw jack has no moment to give at its foot, so here the
  overturning is held the way a scaffold holds it: by the leg under the bracket
  and the leg behind it, as a pair of forces. The bases of those two legs hinge
  about the line of the face, as does every leg in line with them, and the
  ledgers joining the pair are fixed to both. Still one path for every load,
  and still no stiffness in the answer.
- **braced**: whichever of those two the builder is held to, with the diagonal
  braces added as axial members.
- **rigid**: ledgers fixed to the standards with no end releases, braces in,
  bases pinned.

The builder is held to **levered** where there is one and to **pinned**
everywhere else, where the two are the same thing. Which leg is behind which
bracket is worked out in `model.mjs` from the placed parts, on its own, so the
builder's choice of leg is checked along with its arithmetic.

`run.mjs` sets the builder's leg loads beside those reactions and reports how
far the two frame solutions move from them. `tests/opensees-leg-loads.test.js`
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
| `brackets-decked-along-the-row` | 8 | A three-bay run with a 2 ft side bracket on each front leg, decked from arm to arm, 75 psf on the brackets and 25 psf behind. |
| `bracket-bay-on-tip-ledgers` | 8 | The same run with 3 ft brackets, a ledger from tip to tip, and the boards laid out from the face onto it, 60 psf. |
| `standards-on-brackets` | 8 | A standard seated in each bracket, with a ledger along that outer row, a ledger from each back to the scaffold, a brace up it, and the brackets decked at 50 psf. |
| `brackets-on-a-run-two-bays-deep` | 9 | Two bays by two, 6 ft deep each, with 2 ft brackets off the front, decked, 75 psf on the brackets and 25 psf behind. |

In the bracket scaffolds the question is where a bracket's load goes. A bracket
hangs on one standard, so everything on it (its deck, the live load on that
deck, a standard in its socket and whatever that standard carries) comes down
that one leg. And because it stands outside that leg, it levers more onto it
from the leg behind. OpenSees and the builder agree on both, leg by leg:

| Scaffold | On the leg under the brackets | Off the leg behind |
|---|---|---|
| `brackets-and-truss` (dead load only) | 6 lb more (3%) | 6 lb |
| `brackets-decked-along-the-row` | 366 lb more (24%) | 366 lb, leaving 54 lb |
| `bracket-bay-on-tip-ledgers` | 690 lb more (39%) | 690 lb, leaving 270 lb of uplift |
| `standards-on-brackets` | 285 lb more (23%) | 285 lb, leaving 135 lb |
| `brackets-on-a-run-two-bays-deep` | 183 lb more (10%) | 183 lb off the middle row; the back row is untouched |

Those are the inner legs, against the plain tributary answer. On
`bracket-bay-on-tip-ledgers` all four back legs are in uplift. What it takes to
hold such a scaffold down is a separate figure with a safety factor in it:
[docs/scaffold-overturning.md](../../docs/scaffold-overturning.md).

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
and the largest fall in any one leg's total load, against what the builder
reports. Totals do not change; only the share between legs does.

| Scaffold | Braces added | Rigid joints |
|---|---|---|
| `single-bay` | no braces | 0% |
| `hung-decks` | no braces | 0% |
| `one-bay-loaded-of-six` | no braces | 0% |
| `brackets-and-truss` | under 1% | +2.0% / -2.2% (3 lb) |
| `mid-leg-load-along` | no braces | +3.2% (2 lb) |
| `three-bay-run-braced` | +9.1% (24 lb) / -7.8% (35 lb) | +7.7% / -7.9% (35 lb) |
| `zigzag` | no braces | +13.5% (95 lb) / -20.6% (50 lb), at the step only |
| `older-ledger-patch` | no braces | +14.2% (30 lb) / -32.1% (15 lb) |
| `brackets-on-a-run-two-bays-deep` | no braces | +17.5% (193 lb) / -14.2% (58 lb) |
| `two-by-two-two-levels` | +19.3% (235 lb) / -20.7% (468 lb) | +11.2% / -26.2% (592 lb) |
| `mid-leg-load-across` | no braces | +29.7% (93 lb) / -23.6% (46 lb) |

The bracket runs one bay deep are better put in pounds, since their back legs
carry so little that a percentage of it says nothing:

| Scaffold | Braces added | Rigid joints |
|---|---|---|
| `brackets-decked-along-the-row` | no braces | 28 lb either way; +2.8% / -1.5% on the front legs |
| `bracket-bay-on-tip-ledgers` | no braces | 78 lb either way on the back legs, 6 lb (under 1%) on the front legs |
| `standards-on-brackets` | 8 lb either way (under 1%) | up to 58 lb; +6.3% / -3.8% on the front legs |

Before the builder levered a bracket's load against the leg behind, the rigid
solution stood 333 lb and 672 lb away from it on the first two of these.

Three things do it:

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
- **How a bracket's leverage is shared out.** The leverage itself is statics,
  and the builder has it: the bracket's load times its distance out, divided by
  the distance back to the leg behind, more on one leg and less on the other.
  What stiffness changes is the sharing. The builder levers each bracket
  against the one leg behind it, frame by frame. With rigid joints the ledgers
  along the face even the frames out, so the inner back legs are lifted a
  little less and the end ones a little more: 28 lb on the 2 ft brackets, 78 lb
  on the 3 ft ones. The front legs, which carry the load, barely move. Two
  arrangements the check does not cover, because their answer depends on
  stiffness and equilibrium alone cannot give it: brackets on both faces of a
  scaffold two bays deep, where both lever against the same middle leg and the
  builder adds the two, and brackets on two faces of a corner.

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
