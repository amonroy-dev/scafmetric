// The notice a person must agree to before they first use the scaffold builder.
//
// One place for the wording, so the page that shows it, the server that
// records agreement to it and the tests all read the same text. Bump the
// version whenever the wording changes in a way that matters: everyone is then
// shown the notice and asked again.
export const SCAFFOLD_NOTICE_VERSION = '2026-11-24-v1';

/** The name the server files an agreement under. */
export const SCAFFOLD_NOTICE_ID = 'scaffold-builder';

export const SCAFFOLD_NOTICE = Object.freeze({
  title: 'Scaffold builder: for estimating only',
  lead: 'Please read this before you continue. You will be asked once.',
  sections: Object.freeze([
    {
      heading: 'What it is for',
      text: 'The scaffold builder is an estimating aid. It lets you lay out a scaffold, list its parts and estimate the load on each leg, so that you can prepare a bid or plan a job.',
    },
    {
      heading: 'What it is not',
      text: 'It is not engineering, and Monroy Labs, LLC does not provide engineering services through it. It does not design a scaffold. It does not perform a structural analysis. It does not check that any scaffold, component, connection, tie, foundation or supporting structure is safe, adequate, or compliant with any code, standard or regulation.',
    },
    {
      heading: 'How its numbers are made',
      text: 'Leg loads are estimates. They come from generic component weights and a simplified method that treats each ledger as a simple span between standards. They leave out, among other things, frame action, wind and other lateral loads, stability, ties and anchors, eccentric and dynamic loads, erection tolerances, the actual products used, and site conditions. A structural analysis of the same scaffold can give materially different loads.',
    },
    {
      heading: 'What you must do',
      text: 'A scaffold must be designed by a qualified person, and built and loaded in accordance with that design. In the United States that is an OSHA requirement (29 CFR 1926.451(a)(6)), and some scaffolds must be designed by a registered professional engineer. Before any scaffold is erected, altered, loaded or relied on, and before any structure is relied on to support one, a qualified person must independently determine the loads and verify the design. Do not use anything from this tool as a design, as a stamped or sealed calculation, as evidence that a scaffold or its support is adequate, or in place of the judgment of a qualified person or engineer.',
    },
    {
      heading: 'Your responsibility',
      text: 'You are responsible for how you use the output and for what you pass on to others. If you share it, make clear that it is an estimate and not an engineered design. The Scafmetric terms of use apply to the scaffold builder, including the disclaimer of warranties and the limits on liability.',
    },
  ]),
  // Each is its own box to tick. The ids travel with the agreement, so the
  // server can refuse one that left a box empty.
  confirmations: Object.freeze([
    { id: 'use', text: 'I will use the scaffold builder for estimating and bid purposes only.' },
    { id: 'limits', text: 'I understand that it is not engineering, that its loads are estimates only, and that it does not replace the design, analysis or judgment of a qualified person or a licensed professional engineer.' },
  ]),
  assent: 'By selecting “I agree and continue” you confirm both statements. Your agreement is recorded with your account, with the date.',
  agree: 'I agree and continue',
  cancel: 'Cancel',
  termsLabel: 'Read the terms of use',
  termsHref: 'terms.html',
});

/**
 * The lines stamped on anything exported from the builder. A parts list or a
 * drawing travels to people who never saw the notice, so it has to say for
 * itself what it is.
 */
export const SCAFFOLD_EXPORT_NOTE = Object.freeze([
  'Estimate for bidding and planning only. Not an engineered design.',
  'A scaffold must be designed by a qualified person. Verify all loads and quantities independently.',
]);

/** Every confirmation id, in order: what a complete agreement must carry. */
export const SCAFFOLD_NOTICE_CONFIRMATIONS = Object.freeze(SCAFFOLD_NOTICE.confirmations.map(c => c.id));
