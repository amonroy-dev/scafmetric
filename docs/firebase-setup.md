# Firebase sign-in setup

The sign-in flow follows Copious: Firebase Auth with Google popup (redirect fallback) and email/password; email verification; password recovery; and a verified ID-token exchange for a 12-hour HTTP-only session. Firebase account creation starts a 14-day trial, recorded server-side in Firestore. This code has not been tested against a live Firebase project. The calculator is currently public: neither login nor paid-trial entitlement protects it yet. No Stripe subscription exists.

Use a dedicated Scafmetric Firebase project; the owner selected separate accounts and trials from Copious. Reusing Copious's Firebase project means existing users' trials start at their original Firebase account creation date, not when they first use Scafmetric. Enable Firebase Authentication Google and email/password providers, configure email delivery and verification action links, create Firestore, and add the exact deployment domain to Firebase Authentication's authorized domains. Configure Firestore rules to deny client access to `scafmetricAccounts`; server Admin SDK access is separate. Review existing rules before modifying a shared project. Enable appropriate quota and abuse controls.

Set the following in Vercel project environment settings (never put credentials in the repository or chat). Redeploy so public browser configuration is generated at build time:

- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`: Firebase web app configuration. These are public browser identifiers, not admin credentials.
- `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`: optional web app configuration if provided.
- `NEXT_PUBLIC_APP_URL`: exact canonical HTTPS application origin, with no path. The session endpoint accepts requests only from this origin.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: Firebase Admin service-account configuration, server-side only. Use a restricted service account and store the private key securely.
- `SESSION_SECRET`: a unique, high-entropy secret of at least 32 characters, server-side only.

Before opening signup, provide reviewed Terms of Service and Privacy Policy; the current notice is draft. Verify the Vercel function route, Google popup and redirect on mobile, email verification, password reset, sign-out, account records and trial dates with test accounts in the deployed environment. A configured status only means required variables are present; it does not prove Firebase or Firestore access. An existing Firebase user's trial derives from the Firebase account creation timestamp, as in Copious.
