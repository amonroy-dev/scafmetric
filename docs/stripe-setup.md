# Stripe subscription integration — pending

The current site is a preview. Firebase account and trial code exists but has not been connected or verified against a live project. It does not collect payment information, charge cards, or enforce subscription access. No payment provider is connected. Do not describe the preview as an active trial or deploy it as a billing flow.

The owner selected Stripe and a 14-day trial; the price remains undecided. The Copious repository was inspected, while its public site and Stripe documentation were inaccessible from this environment. The billing flow, terms, prices, and cancellation conditions must be confirmed before implementing the exact commercial experience.

## Implementation requirements

1. Create a server-side application and an authenticated user account system. Persist user IDs, Stripe customer and subscription IDs, subscription status, and entitlement state. Do not put Stripe secret keys or webhook signing secrets in browser code or in the repository.
2. Configure a Stripe product and recurring price in test mode. Confirm the 14-day trial, billing interval, price, trial eligibility, whether a payment method is collected at signup, behavior at trial end, taxes, cancellation and refund policies. Display those terms clearly before the customer confirms checkout. Avoid creating an unexpected charge after a trial.
3. After authenticating a user, create a Stripe Checkout Session in subscription mode on the server. Use the server-controlled recurring price and explicitly chosen trial settings. Set a configured, trusted success and cancellation URL. Associate the session with the authenticated user. Never let a browser select arbitrary prices, alter the trial, or grant itself access.
4. Process Stripe's signed webhook events on the server using the raw request body and Stripe's official server library. Reject invalid signatures. Persist event IDs so retries are idempotent, and reconcile current subscription state with Stripe instead of assuming delivery order. A return to a success page alone must never grant a paid subscription. Handle failed payment, cancellation, trial end, and payment recovery.
5. Decide and implement the entitlement policy for trialing, active, past-due and canceled accounts. Provide authenticated access to Stripe's customer portal for subscription management and cancellation. Protect against users accessing another account's billing session.
6. Test complete signup, trial expiration, payment success and failure, canceled checkout, cancellation, webhook retries and replay, authorization boundaries, and browser refresh with Stripe's test mode. Only after reviewing actual prices and terms, webhook handling, legal text, and test results should live credentials be configured and live checkout enabled.

## Configuration needed later

Use a secret manager or hosting provider's secret settings for the Stripe secret key and webhook signing secret. Configure the Stripe recurring price ID, trial duration, and trusted public application URL as server-side settings. These values and the Stripe account are not present in this repository. Never ask for secret values in chat.
