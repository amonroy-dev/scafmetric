# Scaffold-to-beam workflow

The scaffold builder, opened from the beam workspace (**Loads → Scaffold builder**),
lets you model a scaffold in a 3D canvas, click the legs resting on a beam, and import
their loads into the beam analysis as point loads, with **dead and live kept
separate** and each load placed at its distance from the left support.

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
- **Side brackets** are cantilevers off one standard, so everything a bracket
  carries comes down the leg it hangs on and no other: a deck on its arm, the
  live load on that deck, a standard seated in its socket, and whatever that
  standard carries in turn. A standard seated in a bracket is not a leg: it has
  no base, no load tag, and is not offered to Send to beam.
- **A bracket's leverage.** That load stands outside the leg, and a leg on a
  screw jack cannot hold the overturning by itself. The frame holds it as a pair
  of forces: more on the leg the bracket hangs on, and the same amount less on
  the leg behind it. Each is the load times how far out it acts, divided by the
  distance between the two legs. The leg behind is the nearest one a ledger or
  truss runs back to; with none, the load stays where it was. This is statics,
  not stiffness, so it is still a takeoff and not a frame analysis.
- **Live per leg** = only the live loads placed with the Live load tool (below).
  A planked bay carries no live load of its own.
- The leg dead loads add up to the parts list weight.

These leg loads are checked against OpenSees, leg by leg, and match to within
0.01 lb: see [verification/opensees](../verification/opensees/README.md).

### Uplift, and holding down against overturning

Enough load on a bracket and the leg behind it has less than nothing on it. The
builder shows that in two separate figures, because they are two different
things and the first must not be read as the second:

- **Uplift** is the leg's load as the scaffold stands, with everything placed on
  it at once and no safety factor. Its tag turns red and reads "Uplift 270 lb".
- **Hold-down** is what must be added at that leg, as counterweight or an
  anchor, for the dead load holding the scaffold down to be 1.5 times what the
  brackets lift. It has its own outlined tag over the leg's load, and the
  Select card lists "Overturning" (the factor the leg has) and "Hold-down for
  1.5 : 1". Live load on the deck behind is not counted as holding anything
  down.

The hold-down is always more than the uplift, and a leg with no uplift can still
need one. Where the 1.5 comes from, why it is not the 4 of a scaffold's
strength, and what the figure leaves out (wind, ties) are in
[scaffold-overturning.md](scaffold-overturning.md).

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

## Side brackets that carry something

- **Standards.** In the Standard tool's card, **On side brackets** makes the tool
  stand its standard in a bracket's socket and nowhere else: point at the
  rosette on the end of a bracket and click. Shift stands one in every free
  socket along that row of brackets. The standard seats 3.9375 in above the
  rosette the bracket hangs on, which puts its own rosettes exactly on the lifts
  of the scaffold beside it (ScaffoldPro's socket shoulder at 3.925 in, plus the
  0.0125 in its tip rosette sits below the bracket's). A second click on the
  same socket adds a segment on top. Removing a bracket removes the standard in
  it.
- **Planks.** Point the Plank tool at a bracket: the boards are laid from that
  bracket's arm to the next one's, running along the face, with no ledger
  between the tips. Shift decks the whole row of brackets. Two arms more than
  10.5 ft apart are not one deck. With a ledger from tip to tip, R turns the
  boards to run out from the face instead, bearing on the face ledger and the
  tip ledger.
- **Braces.** The Brace tool works on the outer row: between two standards seated
  in neighbouring brackets (from one bracket's tip rosette up the next
  standard), and on the short face from a seated standard back to the standard
  its bracket hangs on. A Shift fill braces the outer row but not those short
  faces, which would otherwise get a brace at every bracket.

## Handrails

A handrail is a ledger on the rosettes above a deck, so it is put on with the
Ledger tool. Its Shift fill adds a ledger on every open bay edge of a level,
which at rail height means ledgers across the decks. **Perimeter handrails**, in
the Ledger tool's card, keeps the tool to the outside of the scaffold
(ScaffoldPro's ledger placement mode of the same name):

- A click adds the one ledger along an outside face from the rosette under the
  pointer. A rosette with no outside face is not lit and takes nothing.
- Shift adds every ledger still missing round the outside of that scaffold at
  that level, and nothing inside it. One click a rail: once at the mid rail's
  rosettes, once at the top rail's.
- On a row of standards seated in side brackets that is the rail along the row
  and the short return to the scaffold at each end of it. Nothing goes across
  the bracket decks, or along the face between them and the scaffold's own deck.

An edge is inside when a bay stands on each side of it (`outsideEdgeKeys` in
`src/scaffold/workspace/planning.js`), read from the bays themselves, so it
holds for a footprint with a corner cut out and for a scaffold turned in plan.
Two legs make a bay edge when a ledger or truss joins them at some lift, the
Brace tool's rule, so two runs standing a few feet apart are railed on the
faces that look at each other; a bracket joins the standard seated in it to the
leg it hangs on. Two scaffolds that no bay joins are filled one at a time.

The rails a block lays round its decks are on the same rosettes and count as the
member on those bay edges: the Ledger tool, ticked or not, lays nothing over
them, and a block placed later lays no rail over a ledger that is already
there. Either way a bay edge is listed and weighed once. The Ledger tool only
adds: the block's rail down the face the brackets hang on stays until it is
erased (one click for each of the two rails).

## Stair tower

The Stair tool places a 14 x 7 ft switchback stair tower the way the Block tool
places a block: a ghost that snaps onto the standards beside it, R to turn it a
quarter turn, a click to place. Its one setting is the height of the top
landing; the tower has a flight for every four rosettes (6'-6 3/4") under that
height, and its standards are picked to stand two rosettes above the top
landing (`planStairTower` in `src/scaffold/workspace/planning.js`).

- **Ten standards.** Four down each long side, at 0, 3'-6", 10'-6" and 14 ft,
  and one in the middle of the 7 ft width on each landing line.
- **Landings** 3'-6" by 7 ft at alternate ends, the first on the collar's
  rosette, decked with 7 ft planks. Each is railed with ledgers one and two
  rosettes up on its three outer sides, and open where the flights come and go.
  A block's rails are never laid round a stair landing.
- **Flights** between the landing lines, on alternate halves of the width. A
  flight is two 7 ft stringers and nine 2'-6" treads, a quarter of its weight
  to each of the four standards its two ledgers hang on.
- **Handrails** are 7 ft bay diagonals: two beside each flight on its outer side
  and two on the middle standards. One more diagonal goes up each end face for
  each flight.

A flight always climbs four rosettes, so a top landing that is not a whole
number of flights up is reached by one adjustment, chosen from the height:

- **One rosette short: the top flight is buried.** Its foot hangs on a ledger a
  rosette below the landing it leaves, its three lowest treads are left off,
  and three 9 in planks laid between its stringers carry the landing out to
  where its treads come up.
- **One rosette over: a step.** The top flight is hung a rosette high, with a
  one-plank step on two clamp-on brackets making up the first rise.
- **Two rosettes over: a starter stair.** A short stair of four treads comes
  off the ground to a first landing two rosettes up, and nothing is decked at
  the ground. Half its weight is on the ground, not on a leg.

So every height is reached to the rosette. The card says what the tower will
be as its settings are changed: how many flights, how many of them adjusted and
how, and where its landings come.

**Make up height with** holds the tower to one way: Auto (the above), Buried
stringer (one rosette or two, never more: two leaves three treads), Clamp-on
step, or Starter stair. A way that cannot make the height asked for lands on
the nearest it can make, over or under.

**Landing heights** in the Stair card is a row for each level, with **Add a
level** for another. The tower is given a landing within a foot of each (the nearest
rosette, which is never more than 10 in off), with whole flights between them
and a buried flight or a step wherever the distance from one wanted landing to
the next is not a whole number of flights. Two wanted heights less than three
rosettes (4'-11") apart cannot both be landed on: the upper one is left out and
the hint says so.

**Match the scaffold's decks** (on by default): a stair tower set down so that
it shares standards with a scaffold takes its landings from that scaffold's
decks in place of the heights in the card, one landing at each deck level on
the chain it joins (`_deckLevelsBeside` in `tools.js`). The landings of other
stair towers and a deck at the foot are not counted. The rails between a
landing and the deck beside it are left in: erase the ones in the way.
Landings alternate ends, so a tower joined to a scaffold by one end has only
every other landing beside it, and the hint says how many; with its long side
against the scaffold every landing is beside it.

Parts are named for what they are and weighed in round figures for a takeoff.
No maker's part numbers or catalogue weights are kept here.

No live load is put on a stair. The Live load tool loads its landings like any
other deck; it does not yet load a flight.

## Buildings

The Building tool traces a building's outline on the ground, corner by corner.
Shift keeps the next wall square to the last corner; a click back on the first
corner, or Enter, closes it into a building of the height in the card. A
building is drawn as a pale mass. It carries nothing and weighs nothing: it is
there to build against.

- The Building tool is second in the toolbar, under Select. Its card asks for
  the **Shape** first and shows nothing else; once one is picked it shows what
  that shape can have, and the roof's own settings only when there is a roof.
- **Shape.** Rectangle (two opposite corners), Round (the centre, then a point
  on the wall; drawn as 48 straight walls) or Trace (corner by corner).
- **Roof** on a rectangle: flat, gable, hip or shed, with a rise; the ridge runs
  along the longer side. **Parapet** is a height of wall above a flat roof.
  These are drawn only (`src/scaffold/workspace/buildings.js`).
- A round building takes a **cone** or a **dome**. **Overhang** carries the
  eaves of any roof out, and **Ridge** turns a gable, hip or shed. **Hollow
  radius** makes a round building a ring with an open middle.
- A building drawn on another's flat roof stands on it: a penthouse, a setback
  (`buildingBaseZ`). Its Height is its own, above that roof. Scaffold round it
  stands on the roof below and is decked under its top.
- **Raised** lifts a building off what it stands on: a balcony or a canopy on
  the side of another. A raised one is not stood on, and a leg under it stands
  on whatever is below.
- With a building selected in Select, each wall that is square to the grid
  shows an arrow as the pointer comes near; dragged, it moves that wall in or
  out a foot at a time and the walls either side follow (`moveBuildingWall`).
  A building picked up on its own snaps corner to corner with one that stays.
- With a building selected, the card's Height, Roof, Roof rise and Parapet
  change that building. Move and Copy pick a building up like a chain, held by
  a corner, and R turns it.
- **Standing off a wall.** A block or stair tower placed beside a wall that is
  square to the grid stands off it by **Scaffold off wall** (`snapToWall` in
  `src/scaffold/workspace/planning.js`). Joining standards already there comes
  first.
- **Scaffold round it** lays blocks round the selected building, or the last one
  traced, as ScaffoldPro's auto scaffold does: one run along each wall and a
  square block at each corner, as deep as the Block card says, with its planked
  levels, rails and bracing, decked under the building's height
  (`planScaffoldRoundBuilding`). At a corner that turns inward the runs stop
  short and the square goes in the angle. Runs and squares share their end
  standards, so the result is one chain and one undo step.
- Walls that are not square to the grid get no run: blocks turn in quarter
  turns only.
- The face of that scaffold that looks at the wall gets no rails, then or when
  a later block re-lays the rails round that deck height. The outside face and
  the ends are railed as any block's.

## Legs that stand on a building

As ScaffoldPro's support-aware legs: the scaffold stays level and every rosette
stays on the same heights whatever is under a leg.

- A leg over a building with a flat roof stands on the roof
  (`supportZAt`, `firstLiftAt` in `src/scaffold/workspace/state.js`). A pitched
  roof is not stood on, and a leg on the line of a wall is beside the building.
- Its tube starts at the first height that keeps its rosettes in step with the
  legs on the ground, so it is shorter by the roof, and its screw jack is wound
  out by the difference: less than one rosette spacing (19 11/16 in).
- A block placed over a roof gives each such leg only the standards it needs,
  and builds nothing of the block at it below its lowest rosette. Wholly on one
  roof, its foot ledgers go on the collars up there. Half on and half off, the
  ground legs are full height.
- What a leg stands on is read from what is under it now: move or remove the
  building and its legs are on the ground again.

The extra jack travel is drawn and is not added to the jack's weight.

## Scaffold round a round building

**Scaffold round it** on a round building lays two rings of standards, the
inner one off the wall and the outer one the Block card's depth further out,
with straight ledgers between them (ScaffoldPro's round plan,
`planRoundScaffold`). The number of bays is the one that brings the inner
ledgers nearest 6 ft and the outer nearest 8 ft. It is decked at the card's
planked levels and railed on the outer ring only. Its ledgers are whatever
length the ring makes them, not catalogue lengths, and it is not braced.

## Drawing underlay

**Drawing underlay**, in the side panel, lays a page of a PDF or an image
(PNG, JPEG, WebP) flat on the ground to build over, as ScaffoldPro's underlay
does (`src/scaffold/workspace/underlay.js`).

- A PDF knows its paper size, so **1 in on sheet** sets its scale directly: 8
  for a sheet drawn at 1/8 in to the foot. **Page** picks the page.
- **Scale by 2 points** brings any drawing to scale from two points a **Known
  distance** apart: type the distance, press the button, click its two ends.
  The first point stays put.
- **Move** takes a point on the drawing to where it belongs; the second click
  lands on the grid, so a building's corner can be put on a grid line.
- Opacity, Hide and Remove do what they say.

The drawing is not part of the model. It is not saved with it, is not in the
parts list or the DXF, and goes when the page is reloaded.

pdf.js (the same release ScaffoldPro uses, pinned) is copied to `dist/pdfjs/`
by the build and fetched the first time a PDF is opened. It is not in the
builder's bundle.

## Chains: moving, turning and copying a whole scaffold

A chain is one connected scaffold: every standard that a walk along ledgers,
trusses, braces, rails, decks, brackets and stair flights reaches, and every
part on them (`chainOf` in `src/scaffold/workspace/state.js`). Blocks that
click onto each other share standards, so they are one chain, and so is
anything built onto them by hand. Nothing is stored for it; it is read from the
parts, so it holds for models saved before.

- **Double-click** a part with Select to take its whole chain. A box, or
  Shift-click, still takes single parts.
- **Move** or **Copy** in the Select card picks the selection up. It follows the
  pointer, held by the standard that was nearest it; **R** turns it a quarter
  turn about that standard; a click sets it down; Esc lets go.
- Within 1.25 ft of a standard that is staying put it snaps onto it, as a block
  does. Whatever lands exactly on a part already there becomes one with it (two
  standards on a spot, two ledgers between the same rosettes, two decks over the
  same bay), so a chain set down against another joins it.
- Every kind of part goes: standards, ledgers, braces, trusses, rails, decks,
  brackets with the standards in them, stair flights, and the live loads on the
  decks. It is one undo step.

Move and Copy used to shift the standards alone and leave everything on them
behind.

## Pulling an end

With Select, a straight outside face of a scaffold shows an arrow when the
pointer comes near it. Dragged out, it adds whole bays; dragged in, it takes
them away. The bays to be added are outlined in blue, those to go in red, with
the count and the length in the hint; letting go does it, as one undo step
(`src/scaffold/workspace/pull.js`).

- A bay added is the last bay repeated as it stands: its ledgers, decks,
  braces, stair flights and the live loads on its decks. What makes the end an
  end (its rails, its braces, brackets pointing out of it and the standards in
  them) is carried out to the new end and not left across the deck.
- An end makes a run longer; a long side pulled out makes it a bay deeper.
- It works on any scaffold, placed as a block or built by hand, because nothing
  is laid out again: every standard that stays is exactly where it was. Pulled
  to a size, a block-built scaffold is what a block of that size would have
  been, part for part and pound for pound.
- The last bay is never taken. A standard another run still stands on stays.
- A face is not offered a handle when the standards along it do not all have
  one straight behind them at the same distance.

ScaffoldPro stretches a block by a handle on its side and lays its bays out
again, with a rule for the odd bay left over. That needs the scaffold to still
be the block it was placed as, and moves standards under whatever was built on
them since.

## Picking legs and importing

**To beam** in the toolbar opens the Send to beam card. With it open, a click on a
leg puts that leg on the beam and a second click takes it off. A box dragged round
several legs takes them all (Ctrl+drag takes them off). A leg's load tag counts as
the leg, which is what there is to click in the view from above.

The beam is laid under the picks (`beamUnderPickedLegs` in
`src/scaffold/legloads.js`):

- Its line is the line through the most picked legs. Two legs make a line. A
  picked leg more than 6 in off that line is **flagged and left out**, not sent.
- Its left end is the end further left in plan, or further to the front for a
  beam running front to back. The first leg on the line stands over the left
  support unless **First leg from left support** says how far in it is.
- Its span is read from the beam form. A leg past the end of the beam is flagged
  and left out.

While the card is open the beam is drawn on the ground under the legs, with its
left support tagged. The legs on it turn blue and are numbered from that support,
and picked legs that are left out are drawn in the warning colour.

**Import to beam**, in the same card, sends each leg as a point load in whole
pounds, dead and live kept apart, at its distance from the left support to a
hundredth of a foot. The takeoff works in fractions of a pound; carried over
unrounded, a leg read "2,103.8769 lbs" on the beam diagram, which looks like a
load a thousand times its size. Importing replaces any rows imported before;
loads typed in by hand are left alone.

A leg behind a loaded side bracket sends more than its tag on the scaffold
shows. The live load the bracket levers off it is not counted, since the bracket
can be empty while the deck behind is loaded, and a leg never sends a negative
load. The card says which legs this applies to (`loadOnBeamFromLeg` in
`src/scaffold/legloads.js`).

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
