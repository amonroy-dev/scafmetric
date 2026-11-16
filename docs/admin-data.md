# Set up sign-in and owner data

This checklist connects the existing Firebase project `scafmetric` to the production site at `https://www.scafmetric.com`. The integration has not yet been verified against the live project. Firebase must be configured before users can sign in and run an analysis.

The site collects each account holder's name, company, and how they found Scafmetric. Project name and preparer are associated with the signed-in account after a completed analysis. Saving occurs after results render; if a save fails, it can be retried while the page remains open, but an unsaved record can be lost if the page closes. Once configured, the owner can view and download saved records at `https://www.scafmetric.com/admin.html`. Treat the records and exports as private; the application does not automatically delete them. Review the privacy disclosure and decide how long to retain them before collecting real user data.

## 1. Locate the Firebase web configuration

1. Open the [Firebase console](https://console.firebase.google.com/), select the existing project, and verify that **Project ID** is exactly `scafmetric` under Project settings > General. A project display name can differ from its ID.
2. In Project settings > General, find **Your apps**. Select an existing web app for Scafmetric, or register a web app if one does not exist. In its SDK setup and configuration, choose the configuration object and note `apiKey`, `authDomain`, `projectId`, and, if present, `appId`, `storageBucket`, and `messagingSenderId`. These identify the browser app; they are not the service-account private key. [Firebase web setup](https://firebase.google.com/docs/web/setup)

## 2. Enable sign-in and Firestore

1. In Firebase Authentication > Sign-in method, enable **Email/Password** and **Google** and save. Configure the Google provider's support email if requested. [Email/password setup](https://firebase.google.com/docs/auth/web/password-auth) · [Google sign-in setup](https://firebase.google.com/docs/auth/web/google-signin)
2. In Authentication > Settings > Authorized domains, add `www.scafmetric.com` (host name only). Configure email verification and password reset delivery, and verify that their return links work for the production domain. If a second domain or preview deployment will be used, it needs its own deliberate configuration; the application accepts write requests only from its configured canonical origin.
3. Open Firestore Database and create the default database if it does not already exist, choosing a location deliberately. In the **Rules** tab, ensure web/mobile clients cannot read or write the `scafmetricAccounts` and `scafmetricProjects` collections. The application uses the Firebase Admin SDK on the server, which bypasses Firestore Security Rules and is governed by IAM. [Firestore security rules](https://firebase.google.com/docs/firestore/security/insecure-rules)
4. If the project already contains other applications or rules, **do not replace those rules blindly**. Inspect the complete ruleset and test the effect on the other applications. Firestore grants access if any matching rule allows it: simply adding an `allow ...: if false` rule for these collections does not override a broader matching allow rule. Adjust any overlapping allow rules and test that unauthenticated and authenticated browser clients cannot access either collection before publishing. If unsure, have the project administrator review the rules. Limit the server service account's IAM permissions to those needed.

## 3. Configure Vercel

In the Scafmetric project in Vercel, open **Settings > Environment Variables**. Add these values to **Production**. Do not paste secrets into chat, commit them to the repository, or add a `NEXT_PUBLIC_` prefix to server-only values. Vercel offers sensitive environment variables for private values. [Vercel environment variables](https://vercel.com/docs/environment-variables/managing-environment-variables)

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Web configuration `apiKey` from step 1 |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Web configuration `authDomain` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Web configuration `projectId` (`scafmetric`) |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Web configuration `appId`, if supplied |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Web configuration `storageBucket`, if supplied |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Web configuration `messagingSenderId`, if supplied |
| `NEXT_PUBLIC_APP_URL` | `https://www.scafmetric.com` with no trailing slash or path |
| `FIREBASE_PROJECT_ID` | Service-account JSON `project_id` (`scafmetric`) |
| `FIREBASE_CLIENT_EMAIL` | Service-account JSON `client_email` |
| `FIREBASE_PRIVATE_KEY` | Service-account JSON `private_key`, including its BEGIN/END lines and line breaks; the JSON's literal `\n` separators are also accepted |
| `SESSION_SECRET` | A unique cryptographically random secret, at least 32 characters; do not reuse another site's secret |
| `ADMIN_UIDS` | The owner's Firebase Authentication UID from step 4; for several owners, separate exact UIDs with commas |

For the server values, go to Firebase Project settings > **Service accounts** and use an appropriately restricted service account. If a JSON key is needed for this deployment, Firebase documents **Generate new private key** there. Enter the corresponding three JSON values directly into Vercel; do not upload the JSON file to the repository or share it in chat. Protect the downloaded file and dispose of it securely once it is no longer needed. Service-account keys are sensitive credentials; restrict access and rotate them if exposed. [Firebase Admin SDK setup](https://firebase.google.com/docs/admin/setup)

Generate `SESSION_SECRET` locally using a secure password manager or cryptographic random generator, then enter it directly in Vercel. Keep it private. Set `ADMIN_UIDS` after creating the owner account below. Environment variable changes apply to new deployments, so redeploy after completing the settings; a build is needed for the public web configuration.

## 4. Set owner access

1. Deploy with Firebase settings, visit `https://www.scafmetric.com/signin.html`, and create or sign in to the owner's account. Verify its email if required, complete the profile, and accept the current terms.
2. In Firebase Authentication > Users, locate that exact account and copy its **UID**. This is not the email address or project ID.
3. Set the server-only `ADMIN_UIDS` environment variable in Vercel to that UID, then redeploy. An empty or missing allowlist denies owner access. Anyone added to this list can view and export all collected account and project details.

## 5. Check the live setup

1. Sign in as the owner, complete an analysis with a test project, and visit `https://www.scafmetric.com/admin.html`. Check both tabs and both CSV downloads; confirm the account profile and the submitted project and preparer are present. Only completed, authenticated submissions should be expected in the project list.
2. Sign in with a separate ordinary account and verify that `/admin.html` does not display the records and its data endpoint denies access. Check email verification, email/password sign-in, Google sign-in (including mobile), sign-out, and password recovery.
3. Verify Firestore rules deny direct browser access to both collections, without affecting other applications in the project. Confirm production works after every change to credentials, origin, or allowlist. Store or delete the test records in accordance with your retention policy.
