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
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ['google.com'],
    },
  },
};

export default config;
