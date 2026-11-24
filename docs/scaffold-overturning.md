# Overturning: uplift, hold-down, and where 1.5 comes from

Reviewed 24 November 2026. This is the reference for how the scaffold builder
treats a scaffold with loaded side brackets, and for the factor it uses.

## Two figures, kept apart

A load on a side bracket stands outside the scaffold. It goes down the leg the
bracket hangs on, and it levers load off the leg behind. The builder reports two
things about that leg behind, and they answer different questions.

| | Uplift | Hold-down for 1.5 : 1 |
|---|---|---|
| The question | What is this leg's load as the scaffold stands? | What does it take to keep the scaffold from overturning? |
| What is in it | Every load placed, dead and live, all at once | Dead load only holding down; everything on the bracket turning it over |
| Safety factor | None | 1.5 |
| On the scaffold | The leg's own tag, red, reading "Uplift 270 lb" | A second, outlined tag over it, reading "Hold-down 877 lb" |
| In the Select card | "Uplift as loaded" | "Overturning" (the factor it has) and "Hold-down for 1.5 : 1" |

The uplift is not what it takes to hold the scaffold down, and the builder never
shows it under that name. The hold-down is always the larger number, and a leg
with no uplift at all can still need one. Two of the test scaffolds show both
cases (three 7 ft bays, 3 ft deep, an inner back leg):

| Brackets | Load on them | Leg's load as loaded | Hold-down for 1.5 : 1 |
|---|---|---|---|
| 2 ft, decked | 75 psf, with 25 psf behind | 55 lb down: no uplift | 391 lb |
| 3 ft, decked out to a tip ledger | 60 psf, with 25 psf behind | 270 lb uplift | 877 lb |

## How each is worked out

For a bracket on leg F with a leg B a distance `b` behind it (the nearest leg a
ledger or truss runs back to, within about ten degrees of square):

- **Turning.** Each load on the bracket, times how far out from F it acts,
  divided by `b`. That much goes onto F on top of the load's own weight, and the
  same amount comes off B. Dead and live are kept apart. The bracket's own
  weight acts at the middle of its tube, a little under half its reach.
- **Leg load, as shown on the tag.** B's dead and live load less what was
  levered off it. Negative is uplift.
- **Resisting.** B's dead load, without what the brackets lever off it. Live
  load on the deck behind is left out: it may not be there when the bracket is
  loaded.
- **Factor.** Resisting divided by turning (dead and live turning together).
- **Hold-down.** `1.5 x turning - resisting`, or nothing if that is negative. It
  is a downward force at B: counterweight on that leg, or an anchor under it.

Because both legs of the pair stand `b` apart, comparing the two forces at B is
the same as comparing the stabilizing and overturning moments about the line of
the front legs.

The factor is one constant, `OVERTURNING_FACTOR` in
`src/scaffold/workspace/state.js`. The rule is checked against OpenSees (see
`verification/opensees/README.md`) and by hand in
`tests/scaffold-bracket-leverage.test.js`.

## Why 1.5, and why not 4

The 4 that scaffold people know is a strength factor. Neither OSHA nor
ANSI/ASSP A10.8 gives a number for the overturning of a supported scaffold with
side brackets; both say the scaffold must be built to withstand the tipping and
leave the number to the designer. Where a number is given for a scaffold that
stands on the ground, it is 1.5.

| Source | Clause | What it says | Applies to |
|---|---|---|---|
| ANSI/ASSP A10.8-2019 | 4.8 (p. 23) | Own weight plus at least four times the maximum intended load, without failure | Strength of any scaffold. Not overturning |
| | 4.36 (p. 25) | Freestanding scaffold with height to base over 4:1 restrained from tipping | A height limit, not a factor |
| | 6.2.5 (p. 32) | Counterweights "shall provide a safety factor of 4:1 against overturning" | Outrigger beams of **suspended** scaffolds |
| | 6.13.4 (p. 41) | Factor of safety for stability of 2 times rated load | Modular **suspended** platforms |
| | 9.8, 10.5 (pp. 47-48) | Posts and frames locked together vertically where uplift may occur | System and frame scaffolds. No number |
| | 9.9, 10.7 (pp. 47-48) | Tied to the structure above four times the minimum base dimension | System and frame scaffolds |
| | 10.9 (p. 48) | With brackets, the scaffold "shall be constructed to withstand the tipping forces caused by loads being placed on the bracket" | Frame scaffolds with brackets. **No number** |
| | 12.2.2 (p. 50) | Inboard length of an outrigger beam at least one and a half times the outboard, unless designed otherwise | Outrigger scaffolds: a length ratio |
| | 12.2.4, 12.2.6 (p. 50) | Inboard ends anchored with a safety factor of at least four; no counterweights | Outrigger scaffolds |
| OSHA 29 CFR 1926.451 | (a)(1) | Own weight plus at least 4 times the maximum intended load | Strength |
| | (a)(2) | Counterweights and direct connections resist 4 times the tipping moment at the hoist's rated load, or 1.5 times at its stall load, whichever is greater | **Adjustable suspension** scaffolds |
| | (c)(1) | Height to base width over 4:1 restrained from tipping | Supported scaffolds: a height limit |
| | (c)(1)(iii) | Ties, guys, braces or outriggers wherever an eccentric load, "such as a cantilevered work platform", is applied | Supported scaffolds. **No number** |
| OSHA 29 CFR 1926.452 | (c)(5)(iii) | Brackets for personnel only, unless a qualified engineer designs for other loads and the scaffold is built to withstand the tipping | Frame scaffolds with brackets. No number |
| | (i)(1) | Inboard end of an outrigger beam at least one and a half times the outboard | Outrigger scaffolds: a length ratio |
| Hong Kong Labour Department, Code of Practice for Metal Scaffolding Safety, 2nd ed. 2013 | 5.2.3(g) (p. 42) | Factor of safety against overturning not less than 1.5. Overturning is from eccentric weight, imposed loads and environmental loads; stabilizing is from self-weight, added kentledge and anchor or guy forces | Free-standing scaffold structures. **The number, and what goes on each side of it** |
| | 5.2.4(b)(ii), 5.2.5(b)(ii) (pp. 46-47) | Restrained by kentledge or guys to a factor of 1.5 against overturning | Towers in the wind |

So the 4:1 against overturning that does exist is for the counterweights of
suspended scaffolds, which hang people over the side of a building. A scaffold
standing on the ground with brackets on it is not that case, and the one source
found that puts a number on it says 1.5 and defines both sides of the ratio the
way the builder works them out: eccentric weight and imposed load turning,
self-weight holding.

The 1.5 is the figure the builder is built on, not a ruling. A job's engineer or
the scaffold maker's instructions may ask for more.

## What the hold-down figure leaves out

- **Wind.** The builder places no wind load. On a scaffold in the open, wind
  adds to the overturning.
- **Ties.** OSHA 1926.451(c)(1)(iii) asks for ties, guys, braces or outriggers
  wherever a cantilevered platform loads a supported scaffold. A scaffold tied
  to the building resists overturning through its ties, and then the hold-down
  is not what holds it. The figure is what it would take with no tie: useful for
  pricing counterweight or anchors, and for seeing which legs matter.
- **Deeper scaffolds.** A bracket is levered against the one leg next behind
  it. Legs further back are not counted as helping.
- **Design.** Brackets carrying more than people are a qualified engineer's
  call (OSHA 1926.452(c)(5)(iii), ANSI 10.9). The builder is for estimating.

## Send to beam

A beam under the legs is given no credit for live load levered off a leg: the
bracket can be empty while the deck behind is loaded, and then the leg bears
down in full. The dead part of the leverage is always there and is counted, down
to nothing. A leg never sends a negative load. The card says so when it applies.

## Sources

Read at the source for this review:

- ANSI/ASSP A10.8-2019, *Scaffolding Safety Requirements*. The user's licensed
  copy, supplied 24 November 2026; page numbers are the printed ones. The
  licence is single-user and forbids copying, so the PDF is not in this
  repository and only clause numbers and a few words are given here. Check the
  wording there before quoting it.
- [29 CFR 1926.451](https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.451),
  paragraphs (a) to (e)(8), and
  [29 CFR 1926.452](https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.452).
- [Code of Practice for Metal Scaffolding Safety](https://www.labour.gov.hk/eng/public/os/B/mss.pdf),
  Occupational Safety and Health Branch, Labour Department, Hong Kong. Second
  edition, March 2013.
- Two articles by a US scaffold engineer,
  [Factor This: Scaffolding Safety Factors](https://www.dhglabe.com/blog/factor-this-scaffolding-safety-factors)
  and [Balancing Act](https://www.dhglabe.com/blog/balancing-act). They describe
  4 to 1 as a strength factor and as the counterweight factor for a swing
  stage, and give no overturning factor for supported scaffolds.

Seen in search results only, not read at the source, and not relied on:

- New York City's 1968 Building Code, section 27-591, reported as 1.5 against
  overturning and sliding.
- A Norwegian regulation reported as a margin of 2.5 for the counterweights of
  cantilever and suspended scaffolds.
- AS/NZS 1576.1 and BS EN 12811-1 have stability clauses that could not be read
  without buying them.

See also [scaffold-factors.md](scaffold-factors.md) for the strength factor and
deflection limits.
