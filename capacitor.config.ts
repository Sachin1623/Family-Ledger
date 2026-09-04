import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.familyledger.app',
  appName: 'FamilyLedger',
  webDir: 'dist',
  server: {
    // Points the app at the production backend so OTP/email/Firebase-Admin routes work from
    // any network, not just a dev LAN.
    // Migrated 2026-08-02 from gen-lang-client-0507207637 (free-tier-locked Firestore) to
    // familyledgerta (Blaze plan, no quota lock) — see FL12 - All imp info/DEPLOYMENT.md.
    // Repointed 2026-08-05 from the raw Cloud Run URL to the custom domain mapping
    // (familyledger.thirteenapps.com), once its cert finished provisioning — same backend,
    // just the branded domain. The .run.app URL still works too; both route to the same
    // familyledger-backend Cloud Run service.
    url: 'https://familyledger.thirteenapps.com',
  },
  plugins: {
    // skipNativeAuth: true is required — Login.tsx's native sign-in handlers (Google AND Apple)
    // both manually bridge the native credential into the JS SDK via signInWithCredential(auth,
    // ...), which is the only sign-in call this app's `auth` object (and everything built on it —
    // useAuth(), Firestore rules' request.auth.uid, etc.) ever sees. With skipNativeAuth: false
    // (the plugin's default), it ALSO completes its own native Firebase sign-in internally before
    // handing back the credential — for Apple specifically, that consumes the one-time nonce, so
    // the app's own signInWithCredential call then fails with "Duplicate credential received...
    // auth/missing-or-invalid-nonce" (Apple's nonce enforcement is strict about reuse; Google's
    // apparently tolerated the same double-exchange without erroring, which is why this went
    // unnoticed until Apple sign-in was actually turned on).
    FirebaseAuthentication: {
      skipNativeAuth: true,
      providers: ['google.com', 'apple.com'],
    },
    // iOS-only: without this, a push that arrives while the app is in the FOREGROUND shows
    // nothing at all on iOS (the OS assumes the app will display it itself). Android has the
    // opposite gap — it always shows backgrounded pushes natively but needs manual re-display in
    // the foreground — handled instead by pushNotifications.ts's own notificationReceived
    // listener, guarded to Android only so this doesn't double up with that native iOS display.
    FirebaseMessaging: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
