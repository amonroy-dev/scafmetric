# Beam loads, flange bracing, and calculation reports

Research record: 2026-11-14. This documents the basis for the input and report changes; it is not an independent certification of the beam design.

## Sources actually reviewed

| Source | Evidence used | Limits |
| --- | --- | --- |
| [PyNite `FEModel3D.py`, pinned revision](https://github.com/JWock82/Pynite/blob/4c5f7002c6b251c092fd539fb894555b8fadaf25/Pynite/FEModel3D.py) | `add_member_pt_load` accepts a magnitude `P`, position `x` along the member's local axis, direction, and load case. Each call appends a separate point-load record. Distributed loads are separate records with start/end positions and magnitudes. | This is an independent structural-analysis implementation, not RISA documentation. Scafmetric supports a narrower model: downward loading on one simply supported beam, with full-span uniform loads. |
| [PyNite `BeamSegZ.py`, same revision](https://github.com/JWock82/Pynite/blob/4c5f7002c6b251c092fd539fb894555b8fadaf25/Pynite/BeamSegZ.py) | Member shear, moment, slope, and bending deflection are evaluated as functions of distance. These are structural-analysis calculations, separate from steel code strength checks. | Its local sign conventions and finite-element architecture differ from Scafmetric's downward-positive closed-form implementation. |
| [PyNite `Reporting.py`, same revision](https://github.com/JWock82/Pynite/blob/4c5f7002c6b251c092fd539fb894555b8fadaf25/Pynite/Reporting.py) | Report output includes model/member data, load combinations, reactions, displacements, and member forces. HTML and PDF use the same rendered data. | This is a model-analysis report, not evidence that AISC design checks have been performed. |
| [Kodestruct F2 lateral-torsional buckling implementation](https://github.com/Kodestruct/Kodestruct.Design/blob/5b5f63aa8b12547e2c6bb473d0e402ade0eb6441/Kodestruct.Steel/AISC/AISC360v10/F_Flexure/I/F2-I%20DoublySymmetricCompact/LTB.cs) and [quarter-point Cb](https://github.com/Kodestruct/Kodestruct.Design/blob/5b5f63aa8b12547e2c6bb473d0e402ade0eb6441/Kodestruct.Steel/AISC/AISC360v10/F_Flexure/BaseClasses/Cb.cs) | Independently implements the same F1-1 quarter-point expression and F2-2 through F2-6 formulas used here; caps nominal flexural strength at the plastic moment. The Cb comments identify moments at the quarter, center, and three-quarter positions of each braced interval. | These files explicitly target **AISC 360-10** and include LRFD processing. They corroborate the algebra and reference numbering; they do not independently verify every AISC 360-16 requirement or Scafmetric's ASD result. |
| [Existing RISA/TEDDS reference record](reference-cases.md) | Records the user-provided W16×31 report's section properties, Lb, Cb, bending/shear results, and reported stiffness-adjustment comparison. | Original user PDFs are not in this checkout. The record is historical evidence, not a fresh RISA run or verification of point-load or separate-flange behavior. |

The official [RISA load-help URL](https://risa.com/risahelp/risa3d/Content/Loads-2D-3D/Loads.htm) and [AISC 360-16 specification URL](https://www.aisc.org/globalassets/aisc/publications/standards/a360-16w-rev-june-2019.pdf) were requested through the environment's normal network client. Both failed with `CONNECT tunnel failed, response 403`. They were **not read** during this change. Current RISA menu labels, report layout, and separate-flange defaults therefore remain unverified; the application must not claim to duplicate or be validated against RISA.

## Input workflow

- Use one main load-type selector: **Uniform load** or **Point load**. Changing it clears the load list and creates one empty row of the selected type, as stated in the adjacent help text. Each row shows its type as a plain label.
- Each point-load record needs a unique visible label, separate D and LL magnitudes in pounds, and an **x distance in ft from the left support**. **+ Add** preserves existing loads and appends another row. Coincident points are valid and superpose; positions outside `0 ≤ x ≤ L` are invalid. Do not impose an arbitrary small load-count limit.
- Keep a load schedule in the PDF with every magnitude and x position. Enter separate downward dead and live portions for both point loads and full-span uniform loads; section self-weight is added once. Service point loads use D + LL, and optional comparison multipliers apply only to LL.
- Record **top-flange** and **bottom-flange** lateral-restraint stations independently. They are positions along the beam, not additional vertical supports. Show the support restraints and any assumed endpoints explicitly.

## Flange-bracing interpretation

In the supported single-span model, all applied loads act downward. The internal bending moment is sagging (nonnegative), so the **top flange is in compression** wherever the moment is nonzero. The top-flange restraint stations define the F2 unbraced intervals. Bottom-flange restraint stations are retained and reported independently; adding a bottom-only brace must not shorten the top-flange unbraced length or increase the calculated positive-bending strength.

Do not use the union of the two flange lists as the compression-flange brace list. A bottom-flange lateral restraint is not automatically an effective top-flange restraint or a torsional brace. Conversely, demanding an interior bottom-flange brace at every top-flange brace would hide the distinction the user is asking to model. Adequacy of brace strength/stiffness and end twist restraint remain explicit assumptions, not consequences of typing a location.

This interpretation is limited to the app's current loading/support scope. Uplift, negative moment, continuous members, overhangs, moment reversal, destabilizing load height, and torsional-bracing behavior require additional analysis before using a different flange or a different bracing model. The app does not design the braces under AISC Appendix 6.

## Analysis equations to expose in the report

Use one consistent force/length unit system within each equation. For the formulas below, `w` is a full-span uniform load, `Pᵢ` is a point load at `aᵢ`, and `L` is the span:

```
R_A = wL/2 + Σ[Pᵢ(L − aᵢ)/L]
R_B = wL/2 + Σ[Pᵢaᵢ/L]
V(x⁺) = R_A − wx − Σ(aᵢ ≤ x)Pᵢ
V(x⁻) = R_A − wx − Σ(aᵢ < x)Pᵢ
M(x) = R_A x − wx²/2 − ΣPᵢ⟨x − aᵢ⟩
```

Here `⟨z⟩ = max(z, 0)`. Show the shear discontinuity at every point load, rather than interpolating a smooth line across it. Determine peak moment using point-load stations, supports, and zero-shear locations within the intervening intervals. Do not assume that combined point loads have their peak moment or deflection at midspan.

For downward-positive Euler–Bernoulli bending deflection, convert all lengths to inches and use a consistent `E`, `I`, `w`, and force unit:

```
C = R_A L²/6 − wL³/24 − Σ[Pᵢ(L − aᵢ)³]/(6L)
δ(x) = [Cx − R_A x³/6 + wx⁴/24 + ΣPᵢ⟨x − aᵢ⟩³/6] / EI
δ'(x) = [C − R_A x²/2 + wx³/6 + ΣPᵢ⟨x − aᵢ⟩²/2] / EI
δ_adjusted = δ_nominal / stiffness_factor
```

The integration constant enforces zero displacement at both supports. The maximum-deflection location is obtained from the zero-slope equation, with the endpoints also considered. These equations are equilibrium and elastic beam theory, **not AISC code equations**. The current 0.8 stiffness factor is the stored user example's analysis assumption; it is not a verified universal RISA default or the complete Direct Analysis Method.

## AISC calculation-detail coverage

The application's implemented design basis is **AISC 360-16 ASD**, limited to compact, doubly symmetric rolled W sections in A992 steel. A professional detail report should state the code edition separately from the AISC shape-data edition and show the symbolic equation, substituted values, units, intermediate quantities, result, and reference for each evaluated check:

| Check | Reference used in the implementation | Report content |
| --- | --- | --- |
| Flange/web compactness | Table B4.1b | `bf/(2tf)`, `(d−2kdes)/tw`, and compact limits `0.38√(E/Fy)` and `3.76√(E/Fy)`. Do not add unverified table case numbers. |
| Plastic moment | F2-1 | `Mp = Fy Zx`, with consistent kip-in/kip-ft conversion. |
| Limiting unbraced lengths | F2-5, F2-6 | Values and substitutions for `Lp`, `Lr`, `ry`, `rts`, `J/(Sx ho)`, `E`, and `Fy`. |
| Moment-gradient factor | F1-1, or explicitly specified `Cb = 1` | Every segment's `Mmax`, `MA`, `MB`, and `MC`; use the same segment moments used by the engine. |
| Nominal moment | F2-1, F2-2, or F2-3/F2-4 according to regime | Each segment's `Lb` comparison against `Lp/Lr`, critical stress when applicable, and plastic-moment cap. |
| ASD flexural strength | Chapter F/F1 general provisions and F2 | `Mn / Ωb`, with `Ωb = 1.67`, demand/allowable ratio, and governing segment. |
| Stocky rolled-I-section web shear | G2.1(a), G2-1 | `h/tw` limit, `Aw = d tw`, `Cv1 = 1`, `Vn = 0.6 Fy Aw Cv1`, `Ωv = 1.50`, and demand/allowable ratio. |

Show every segment, not only the governing segment. If an optional live-load comparison is selected, show its transformed uniform **and point** loads and corresponding calculation results separately from the service-load case. The existing OSHA-labeled 4:1 comparison is illustrative; it is not a verified OSHA load combination or compliance check.

Unsupported checks must be identified as not evaluated. In particular, point-load bearing length and connection details are absent, so AISC J10 concentrated-force limit states (local flange bending, web yielding/crippling, sidesway buckling, etc.) cannot be claimed as checked. The report must not turn a partial bending/shear pass into an overall adequacy statement.

## Verification criteria

- A single off-center point load reproduces `R_A = P(L−a)/L`, `R_B = Pa/L`; multiple points superpose with the uniform load.
- Every input point appears once in the load schedule, including coincident points and support-position loads.
- Changing the main load-type selector removes existing rows and adds one empty row of the selected type. **+ Add** appends a row without changing existing loads. Each row includes only its applicable inputs in analysis and validation. Adding/removing/changing a load invalidates prior results and reports.
- Extra bottom-only braces do not improve positive-bending capacity; extra effective top braces change the actual F2 segments. Invalid flange stations reject the calculation.
- PDF content is generated from the same immutable calculation record as the screen result, and all detailed calculations print regardless of screen disclosure state.
- Report equations, substituted values, result units, and governing values agree with the engine; all service diagrams and explicit scope limits are present.
