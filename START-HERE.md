# Connect Hangout to Firebase

The website is currently a local preview. The files below are ready to connect to your own Firebase project. No Firebase project or public deployment has been created for this version.

## 1. Create a project

Open https://console.firebase.google.com/ and sign in with your Google account. Create a project, give it a name, and keep it on the free Spark plan. Google Analytics and Gemini assistance are optional and are not needed by this app.

## 2. Create the database

In the project's Build menu, open Firestore Database and select Create database. Choose Standard edition if asked, use the default database, select a location near you, and start in Production mode. The app's own rules will be deployed with the website.

## 3. Enable anonymous authentication

Open Build → Authentication → Get started → Sign-in method. Enable Anonymous and save. This happens silently in the app; friends will not see a login screen or need to make an account.

## 4. Register the website

Open Project settings → General → Your apps, select the Web icon (</>), give the app a nickname, and register it. Find the configuration object beginning `const firebaseConfig = { ... }`.

Send that configuration object to this chat, or replace `null` in `public/firebase-config.js` with the object's contents, keeping `export const firebaseConfig =` before it. This is the public web configuration, not a service-account/private key.

## 5. Sign in and deploy

Once the configuration is filled in, use the folder containing `firebase.json` as the working directory. With Node.js LTS installed, sign in using:

```
npx firebase-tools login
```

Sign into the Google account that owns the project. Then publish the website and its database access rules together:

```
npx firebase-tools deploy --project YOUR_PROJECT_ID --only firestore:rules,hosting
```

Replace `YOUR_PROJECT_ID` with the exact ID from Project settings. This is ordinary Firebase Hosting, not Firebase App Hosting. Do not run `firebase init`; the required configuration files are already supplied. No website build step or separate website dependency installation is required.

The command returns the live address, normally `https://YOUR_PROJECT_ID.web.app`.

## 6. Use the hosted website

Open the live website, create an outing, and bookmark its private owner link. Share the separate view-only link with friends. Future design or code changes require another deployment; new expenses do not.

Outings entered in the local preview are stored only in that browser. They are not uploaded automatically when Firebase is connected.

Official instructions:
- https://firebase.google.com/docs/web/setup
- https://firebase.google.com/docs/auth/web/anonymous-auth
- https://firebase.google.com/docs/firestore/quickstart
- https://firebase.google.com/docs/hosting/quickstart

Requested edit status: equal-split item editing corrected, dark mode applied, numeric displays use a standard sans-serif font, and decorative marketing text removed. These latest edits have not been tested, as requested. Firebase deployment and live sharing are not yet verified.
