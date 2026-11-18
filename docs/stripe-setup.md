# Stripe subscription setup and operations

Scafmetric's intended offer is **US$49 per month**, charged at signup, with **no free trial**. The calculator is available only to an authenticated account whose current terms and profile are complete and whose payment or explicit lifetime grant has been verified. The owner's free-lifetime grant is separate from Stripe. The payment integration and deployment must be tested in an isolated sandbox before live use; do not assume a local test or Checkout return URL proves payment.

## Configure separate environments

1. Use the dedicated Scafmetric Stripe account and an isolated Stripe sandbox, separate from live mode and the other applications. Use a dedicated Firebase test project for preview/sandbox work so sandbox customer mappings, holds and events cannot affect production accounts. Do not enable live collection or production gating until the complete sandbox workflow passes.
2. Create one active, fixed-price, licensed recurring Price for **USD 4,900 cents every month**, with quantity one and no trial. Save the Price ID (`price_...`), not the Product ID. The server verifies this exact price, currency, interval and trial setting before creating Checkout. Any future price change requires a deliberate code and commercial-terms update; changing only the dashboard price will be rejected.
3. Configure Stripe-hosted Customer Portal so subscribers can update payment details and cancel as intended. Confirm the chosen cancellation and refund policies in the dashboard and website terms. A subscription remains eligible only while Stripe reports it active, its paid current item and its most recent paid invoice pass server verification, and there is no risk hold. No access is granted merely because Checkout redirects to a success page.
4. Configure Firebase Authentication, the separate Firestore database and the exact canonical HTTPS origin as described in [Firebase setup](firebase-setup.md). Set the preview origin as `NEXT_PUBLIC_APP_URL` for preview builds and add that hostname to Firebase Authorized domains; deploy the public auth configuration at build time. Restrict the server-only Firestore collections in Security Rules, including `scafmetricAccounts`, `scafmetricProjects`, `billingEntitlements`, `scafmetricBilling`, `scafmetricStripeCustomers` and `scafmetricStripeEvents`. A broader overlapping allow rule overrides a narrow deny: inspect and test the entire ruleset.

Set these as server-only environment variables in the correct Vercel environment; never put their secret values in browser code, the repository, chat or logs:

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Production only: the live Stripe API key (`rk_live_...` or `sk_live_...`). |
| `STRIPE_TEST_SECRET_KEY` | Preview and sandbox testing only: the test Stripe API key (`rk_test_...` or `sk_test_...`). |
| `STRIPE_PRICE_ID` | Configure separate values in Production and Preview: each mode's approved active USD $49/month Price ID. |
| `STRIPE_WEBHOOK_SECRET` | Configure a separate signing secret for each environment's webhook destination; keep it separate from the API key. |
| `NEXT_PUBLIC_APP_URL` | Exact canonical HTTPS site origin with no path or trailing slash. Checkout and portal return URLs are derived on the server from this origin. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Firebase Admin credentials for the matching environment, using least privilege. |
| `SESSION_SECRET` | A unique, cryptographically random secret of at least 32 characters; never reuse between environments. |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | The corresponding Firebase web application configuration; these are public identifiers, not admin credentials. |

Use Vercel sensitive/secret settings for private values, separate credentials per environment, and a Stripe restricted API key with the least permissions needed. Grant only the read/write operations used by Checkout, Customers, Subscriptions, Prices, Customer Portal, Invoices, Invoice Payments, Payment Intents, Charges, Disputes and early fraud warnings. Test that the exact permissions work in the sandbox before creating an equivalent live key. Rotate any exposed key. Do not provide secrets in chat.

Vercel's `VERCEL_ENV` identifies Production versus Preview; a Preview deployment can also have `NODE_ENV=production`. Configure `STRIPE_SECRET_KEY` for Production and `STRIPE_TEST_SECRET_KEY` for Preview. Vercel Development also uses the test key. When `VERCEL_ENV` is unset, `NODE_ENV=production` uses the live key; other `NODE_ENV` values use the test key. Each deployment must use a key from its matching Stripe mode, with no fallback to the other key. Configure Preview with a dedicated Firebase test project and matching Firebase credentials, price, webhook destination and signing secret. A Stripe sandbox key alone does not isolate shared Firestore customer mappings or risk holds from production.

## Webhook destination

Create a destination at `https://<environment-origin>/api/stripe/webhook` for the **same** Stripe account and mode as the API key and Price ID. Replace the placeholder with the hostname only; for production the URL is `https://www.scafmetric.com/api/stripe/webhook`. Pin its event API version to **2026-09-30.endive** to match the SDK and object relationships used by the implementation. Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `charge.refunded`
- `charge.dispute.created`
- `radar.early_fraud_warning.created`

Record the destination's signing secret in `STRIPE_WEBHOOK_SECRET`. The endpoint verifies the Stripe signature using the raw request and rejects events from a different Stripe mode. It stores processed event IDs and resolves subscription/payment ownership through Stripe objects and the server-owned customer mapping, rather than trusting customer-supplied metadata. Webhooks are required for subscription and risk handling; do not go live without testing signature verification, delivery and retry.

## Owner lifetime access

After verifying the owner's Firebase Auth UID and verified email independently, grant access by setting the server-owned Firestore document `billingEntitlements/{uid}` field `lifetimeFree` to the boolean `true`. Do not grant based solely on an unverified email or a client-writeable document. Never grant lifetime access to other accounts accidentally. Firestore client rules must deny all reads and writes to this collection; the service account uses Admin SDK and IAM. Verify the actual owner can reach the calculator without creating a Stripe customer or subscription and that a different account cannot. Do not use the presence of an Admin UID alone as a payment exemption.

## Risk holds and recovery

The server uses `scafmetricBilling/{uid}.stripeCustomerId` and `scafmetricStripeCustomers/{stripeCustomerId}.uid` as a matched pair; it fails closed if the pair is absent or inconsistent. Do not change these mappings or clear a hold without verifying ownership and investigating the Stripe account. Normal lifecycle webhooks do not grant access or remove a risk hold; current Stripe subscription, invoice and payment state is checked on access.

A full refund, unresolved dispute or actionable early fraud warning puts a server-owned `riskHold: true` on the forward billing record. Partial refunds and non-actionable/resolved risk events are flagged `riskReviewRequired` for review. Holds persist until an authorized operator investigates Stripe and the affected subscription and decides what to do. Only after that review may the operator set `riskHold` and `riskReviewRequired` to `false` on the correct `scafmetricBilling/{uid}` document, recording the reason through the business's approved internal process. Clearing a hold does **not** by itself grant access: the live payment verifier must still pass. Keep the reverse mapping and processed event records intact.

Checkout customer and session creation use persisted reservations and Stripe idempotency keys to prevent duplicate charges from retries or simultaneous requests. A customer who cancels an **open** hosted checkout can resume it; an expired checkout can be replaced. An old reservation without a saved Stripe response is blocked after 23 hours rather than risking a duplicate after Stripe's idempotency retention period. If a customer is stuck, an authorized operator must inspect Stripe request logs, customer/subscription and checkout sessions and reconcile ownership with both Firestore mappings before changing any reservation. Do not simply delete a reservation, customer mapping or subscription: if Stripe did create a session or customer, doing so can lead to duplicate billing. Escalate unresolved cases for engineering review.

## Verification before live use

In a protected preview deployment with isolated sandbox and test Firebase credentials:

1. Verify guests and ordinary accounts without a paid subscription cannot fetch the workspace HTML or private application bundle. Verify the owner's explicitly granted lifetime account can access both. Confirm direct static paths and alternate Vercel domains do not expose the protected bundle.
2. Test signup, profile completion, current terms, payment at Checkout, and that access remains unavailable until Stripe confirms payment. Check the webhook is received and the actual subscriber can use the calculator, save a project, and access billing management. Verify a second user cannot view or change the first customer's billing.
3. Test declined and asynchronous payments, a canceled and resumed checkout, a successful checkout with delayed webhook delivery, duplicate event delivery, signature errors, payment failure, subscription cancellation and renewal. Test full and partial refunds, disputes, fraud warnings, risk-hold review and the Stripe/Firestore outage fail-closed behavior. Confirm no duplicate customer or charge is created by retries and concurrent clicks.
4. Verify the Customer Portal, both Firestore mapping collections, event records and deployed server logs without exposing personal information or secrets. Check every required resource and `workspace-private/app.js` are included in the deployed function, and that private responses are not shared-cached.
5. After legal/business review of the price, recurring disclosure, cancellation, refund and privacy terms, configure the matching live Price, restricted key, webhook destination, signing secret and live Firebase settings. Deploy and verify the live environment carefully. A configured environment flag is not proof of a successful payment or working webhook.

## Tax

The requested configuration does not enable Stripe automatic tax. That does not determine whether tax is owed. Review sales-tax obligations and applicable registrations with a qualified adviser before enabling tax or treating charges as tax-exempt. Stripe calculates tax only where the account has the applicable registrations; see [Stripe's recurring-payments tax guide](https://docs.stripe.com/billing/taxes/collect-taxes).
