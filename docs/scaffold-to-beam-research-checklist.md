# Scaffold-to-beam research and planning checklist

This is a research and planning request for another agent. Do not write code or publish application changes as part of this research.

## Source projects and scope

- [ ] Review [Scaffxiq_v2](https://github.com/amonroy-dev/Scaffxiq_v2) and [ScaffoldPro](https://github.com/amonroy-dev/scaffoldpro).
- [ ] Plan a scaffold-to-beam workflow in a modal in this beam analysis application. Reuse and adapt substantial existing scaffold functionality; do not rebuild the scaffold engine from scratch.
- [ ] Identify the existing scaffold model, placement tools, calculations, 3D canvas, and orbit controls that can be retained and adapted. Remove building mode and options not needed for this workflow.
- [ ] Give the modal a distinct visual design and feel while retaining useful scaffold interactions.

## Scaffold components and weights

- [ ] Include standards, ledgers, braces, and planks. Remove manufacturer names and references, rosettes, and mouthpieces. Show standards, ledgers, and braces as generic tubes.
- [ ] Calculate tube self-weight from actual component length and steel unit weight of **490 lb/ft³**. The proposed standard is **1.9-inch outside diameter, 0.12-inch wall**, with **20% added** to its calculated weight.
- [ ] Recommend tube dimensions and a weight allowance for ledgers and braces; confirm those assumptions before treating them as settled. Keep component-weight details internal to the calculation rather than displaying them as product specifications.
- [ ] Retain plank layout, placement, rendering, and load distribution. Replace manufacturer-specific plank weights with a generic basis.
- [ ] Research publicly available steel scaffold plank specifications from multiple sources. Cite links and report dimensions, weights, and equivalent lb/ft². Compare them with a steel-area estimate and recommend an editable generic default. Distinguish published values from assumptions.

## Select legs and import beam loads

- [ ] Let users highlight scaffold legs resting on a beam and import those loads into the beam analysis.
- [ ] Propose how users position the beam relative to the scaffold and review each selected leg's exact distance from the beam's left support.
- [ ] Preserve full-precision coordinates; flag legs outside the beam span or off the beam.
- [ ] Keep scaffold dead and live loads separate through import and analysis.

## Research deliverables

- [ ] Identify existing modules and calculations to reuse, what needs extraction or adaptation, dependencies between the scaffold workspace and building features, and limitations in existing load paths.
- [ ] Provide a practical implementation plan, recommended verification cases, and decisions needed from the user.
- [ ] Do not code or publish application changes.
