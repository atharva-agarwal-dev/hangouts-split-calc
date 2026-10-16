# Put Hangout online with Firebase

This is a static website: there is no app build or server to maintain. Firebase Hosting serves the files in `public/`, and Cloud Firestore saves the outings and supplies live updates. The setup uses Firebase's Spark plan within its free allowances. You do not need a paid domain or a billing account. [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)

The delivered files start in **local preview mode** because your own Firebase project has not been connected. In that mode, records exist only in that browser and friends cannot open them on another device. The website clearly labels this mode. Connecting Firebase enables shared records; it does not move existing preview outings into the shared database.

## 1. Create your project

1. Open the [Firebase console](https://console.firebase.google.com/) and sign in with your Google account.
2. Choose **Create a project**, name it, and keep the **Spark** plan. Google Analytics is optional and can stay off for this app.
3. Keep note of the **project ID** shown in Project settings. This differs from the friendly display name and is used by the publishing command below.
4. From Project overview, choose the web icon **`</>`**, or **Add app → Web**. Use “Hangout” as its nickname and register it.
5. Find **SDK setup and configuration → Config**. Copy the `firebaseConfig` object.
6. Open `public/firebase-config.js`. Replace `null` with that object, retaining `export const firebaseConfig =` before it.

The web configuration identifies your public Firebase project; it is designed to be included in the website. The security rules control access to data. Do not copy a service-account key or Firebase Admin credentials into the website. [Web setup](https://firebase.google.com/docs/web/setup)

## 2. Enable silent authentication

Open **Authentication** (under Security or Build, depending on the console layout), select **Get started**, then **Sign-in method → Anonymous → Enable → Save**.

The website signs each browser in anonymously in the background. Your friends will not see a login form or need accounts. This browser identity lets the database enforce the private owner link. [Anonymous authentication](https://firebase.google.com/docs/auth/web/anonymous-auth)

Keep Firebase Authentication's optional automatic anonymous-account cleanup disabled for this small app. Owner links should be bookmarked, since browser data may be cleared or a phone may be replaced.

## 3. Create the database

1. Open **Firestore Database** (under Databases & Storage or Build).
2. Choose **Create database** and **Standard edition** if an edition choice is shown.
3. Use the **`(default)`** database.
4. Pick a location near your group. The console shows the available locations; choose carefully because a database's location cannot be changed in place.
5. Choose **Production mode**, then create the database. The supplied rules will replace the initial deny-all rules when you publish.

Do not add collections by hand; the website creates the records it needs. [Firestore setup](https://firebase.google.com/docs/firestore/quickstart)

## 4. Publish the files and access rules together

These steps run on your computer, inside the folder containing `firebase.json`.

If Node.js is not installed, install a current LTS release from the [official Node.js site](https://nodejs.org/). Then run:

```sh
npx firebase-tools login
```

Accept the Firebase CLI installation if prompted, and complete the Google sign-in in your browser. Use the Google account that owns the project.

Replace `YOUR_PROJECT_ID` with your project's exact ID and run:

```sh
npx firebase-tools deploy --project YOUR_PROJECT_ID --only firestore:rules,hosting
```

The existing `firebase.json` already specifies the right public folder and rule file, so you do **not** need to run `firebase init`. The deployment prints the public Hosting URL, typically `https://YOUR_PROJECT_ID.web.app`.

This uses **Firebase Hosting (classic)** for static files. Firebase App Hosting, Cloud Functions, and a paid plan are not required. Subsequent website changes use the same deployment command. Creating outings or saving payments through the website does not require redeployment. [CLI publishing](https://firebase.google.com/docs/cli) · [Hosting guide](https://firebase.google.com/docs/hosting/quickstart)

## 5. Check it on two devices

1. Open the published URL on your Android phone. The local-preview message should be gone.
2. Create a test outing. Bookmark its **owner link** somewhere private.
3. Copy the **view-only link** and open it on a second phone or in another browser.
4. Add and edit a payment on the owner page. Check that the viewer sees the saved changes without refreshing and cannot edit or check off debts.
5. Open the owner link on another device to confirm you can regain edit access there without a login form.
6. Check both settlement tabs, settle a debt, and reopen it. Confirm the changes appear on the viewer page.

Use the copy buttons for sharing. Anyone with an event's view link can view that event; anyone with its owner link can edit. The site does not offer a searchable public directory of events.

## How access is enforced

- Event IDs and private owner keys are separate, cryptographically random 256-bit values.
- A viewer can fetch an individual event only when they know its ID. Listing all events is denied by the database.
- The owner key is stored in a separate, non-listable collection. It is absent from the shared event data.
- A new device holding the owner key can claim a private editing grant for its anonymous identity. Existing grants and owner keys cannot be edited through the client.
- The database rejects viewer writes and changes to the original event owner's identity. Every save must advance the event revision by exactly one; transactions reject stale edits instead of overwriting another saved change.
- Opening the view link uses read-only controls, including when the browser previously used the owner link. The original owner's authenticated browser still has server-side authority; sharing a view link does not grant that authority to a different browser.
- Data stays in your Firebase project. Firebase setup failures do not silently switch to local storage.

The rules validate the document structure and access boundaries. The app validates the individual amounts and settlement relationships. Each outing is stored as a single document, suitable for a small friend group; the app caps its serialized event data at 750 KB so it can report a clear limit before Firestore's document-size limit. Large or frequent group use would need a different storage layout.

## Checks and remaining verification

The local adapter was exercised for creation, owner-token checks, viewer records without secrets, data-copy isolation, revision conflicts, subscriptions, missing links, and invalid configuration. No real Firebase project was provisioned or published as part of these files. The deployed live-update flow and Firestore rules must be tested against your project before you rely on it for a real outing. The Firestore emulator was not available in the build environment, so the rules have been reviewed but not emulator-tested.

Suggested database access checks before regular use:

| Attempt | Expected result |
|---|---|
| Signed-out read or write | Denied |
| Anonymous user gets a known event ID | Allowed |
| Anonymous user lists `events` or `editLinks` | Denied |
| Viewer updates an event | Denied |
| Viewer invents an editor grant without its owner key | Denied |
| Owner creates an event and its private key in one batch | Allowed |
| Another device claims a grant with the correct key | Allowed |
| Owner/editor saves with revision + 1 | Allowed |
| Owner/editor changes `ownerUid` or `createdAt` | Denied |
| Owner/editor reuses the old revision | Denied |

If a published page reports insufficient permissions, check that Anonymous authentication is enabled, that the config points to the correct project, and that the supplied rules were deployed to that same project's `(default)` Firestore database. Keep the protective rules in place while correcting the setup.
