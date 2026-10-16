import { isIosApp } from './platform';
import { initializeApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, OAuthProvider } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  memoryLocalCache,
  doc,
  getDocFromServer
} from 'firebase/firestore';
import { getAnalytics, isSupported, logEvent, setUserId, type Analytics } from 'firebase/analytics';
import { Capacitor } from '@capacitor/core';
import { FirebaseAnalytics } from '@capacitor-firebase/analytics';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Initialize Firestore
const dbId = (firebaseConfig as any).firestoreDatabaseId;

// Offline persistence (IndexedDB-backed): onSnapshot listeners keep serving whatever was last
// synced instead of hanging/erroring while offline, and writes made offline (addDoc/updateDoc/
// deleteDoc/transactions, everywhere in the app) are queued locally and sent automatically the
// moment connectivity returns — this is the SDK's own built-in behavior once persistence is on,
// not something built per-feature. Falls back to a memory-only cache (today's prior behavior —
// works fine online, just nothing survives offline) if persistence can't be enabled at all, e.g. a
// browser/WebView with IndexedDB disabled or restricted (some private-browsing modes).
//
// Multi-tab vs single-tab ownership: `persistentMultipleTabManager` (used on web, where a real
// user genuinely can have several browser tabs of this site open) makes every tab negotiate a
// shared "primary" owner of the IndexedDB cache on startup. The installed Capacitor app is a
// single WebView instance, not multiple tabs — it never needed that negotiation — but it was
// paying its cost anyway: a stale ownership lock left behind by a force-closed previous session
// (the WebView doesn't always get to release it cleanly) made every onSnapshot listener reset to
// `undefined` and resubscribe moments after a correct first read, diagnosed live via a temporary
// _medDebugLog trace showing a query's result flip from correct-from-cache to empty within ~450ms
// of a fresh launch, with the id list it was querying unchanged throughout. `forceOwnership: true`
// on native skips the negotiation entirely and claims the cache outright, eliminating that window.
function createFirestore(firebaseApp: FirebaseApp, databaseId?: string) {
  const tabManager = Capacitor.isNativePlatform()
    ? persistentSingleTabManager({ forceOwnership: true })
    : persistentMultipleTabManager();
  try {
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager }),
    }, databaseId);
  } catch (err) {
    console.error('Failed to enable Firestore offline persistence, falling back to memory-only cache:', err);
    return initializeFirestore(firebaseApp, { localCache: memoryLocalCache() }, databaseId);
  }
}

export const db = createFirestore(app, dbId);

console.log("Using Firestore database:", dbId || "(default)");

export const auth = getAuth(app);

// Critical: Test connection on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firebase connected successfully");
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      // Expected whenever the device genuinely has no connection — persistence (above) still
      // serves cached data to the rest of the app, this ping is just a boot-time diagnostic.
      console.log("Firebase connection test skipped — device is offline; using cached data.");
    } else {
      console.error("Firebase connection test failed:", error);
    }
  }
}
testConnection();

export const googleProvider = new GoogleAuthProvider();
export const appleProvider = new OAuthProvider('apple.com');

// --- Analytics ---
// The Firebase project already had a GA4 stream configured (measurementId in the config file),
// but nothing in the app ever actually called the SDK — so the property existed and looked
// "enabled" yet never received a single event. `isSupported()` is a Promise (the web SDK needs
// IndexedDB/cookies, not guaranteed in every WebView/private-browsing context), so `analyticsInstance`
// starts null and every tracking call below just quietly no-ops until/unless it resolves true —
// callers never need to check readiness themselves.
//
// Gated behind explicit consent (see ConsentBanner.tsx) rather than starting eagerly on load —
// GA4 sets identifiers and tracks behavior, which needs prior opt-in consent under GDPR/ePrivacy,
// not just a privacy-policy disclosure after the fact. Applied to every user, not just
// EU-detected ones, since reliable EU-only detection isn't worth the complexity or risk of
// getting it wrong.
const ANALYTICS_CONSENT_KEY = 'familyledger_analytics_consent';
let analyticsInstance: Analytics | null = null;

// The iPhone/iPad app never runs web analytics or shows the cookie prompt (App Store guideline 5.1.2:
// no tracking, so nothing to ask permission for). Analytics stays a web / Android choice.
// The installed Android app sends its events through Firebase's NATIVE analytics (the Android data stream, which is what Google Play and
// Google Ads tie installs and sign-ups to). The web analytics below then stays out of the installed app, so nothing is counted twice.
export function isAndroidApp(): boolean {
  return Capacitor.getPlatform() === 'android';
}

// A rough "is this phone in Europe" check (time zone), so analytics there stays off until the person agrees. Wrong guesses only ever
// err toward asking, which is the safe direction.
export function looksLikeEurope(): boolean {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return tz.startsWith('Europe/') || tz === 'Atlantic/Reykjavik' || tz === 'Atlantic/Azores' || tz === 'Atlantic/Madeira' || tz === 'Atlantic/Canary';
  } catch {
    return false;
  }
}

function initAnalyticsSdk() {
  if (isIosApp() || isAndroidApp()) return;
  isSupported()
    .then((supported) => {
      if (supported) analyticsInstance = getAnalytics(app);
    })
    .catch(() => {});
}

// What the person chose, or null if they have not been asked / have not answered yet.
export function getStoredAnalyticsConsent(): 'granted' | 'denied' | null {
  try {
    const v = localStorage.getItem(ANALYTICS_CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null; // localStorage unavailable (private browsing etc.) — treated as "not yet decided"
  }
}

// What analytics should do right now. In the installed Android app, outside Europe, anonymous usage counts are ON until the person
// turns them off (the first-run notice says so); everywhere else (web, Europe) they stay off until the person says yes.
export function getAnalyticsConsent(): 'granted' | 'denied' | null {
  if (isIosApp()) return 'denied';
  const stored = getStoredAnalyticsConsent();
  if (stored) return stored;
  if (isAndroidApp() && !looksLikeEurope()) return 'granted';
  return null;
}

export function setAnalyticsConsent(consent: 'granted' | 'denied') {
  if (isIosApp()) return;
  try {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, consent);
  } catch {
    // Unable to persist — the banner will just ask again next visit, which is the safe direction
    // to fail in (never tracking without a fresh "yes" beats accidentally tracking without one).
  }
  if (isAndroidApp()) {
    FirebaseAnalytics.setEnabled({ enabled: consent === 'granted' }).catch(() => {});
    return;
  }
  if (consent === 'granted') initAnalyticsSdk();
}

if (isAndroidApp()) {
  // Native analytics: collect only while consent is granted (on by default outside Europe, see getAnalyticsConsent).
  FirebaseAnalytics.setEnabled({ enabled: getAnalyticsConsent() === 'granted' }).catch(() => {});
} else if (getAnalyticsConsent() === 'granted') {
  initAnalyticsSdk();
}

export function trackEvent(name: string, params?: Record<string, unknown>) {
  if (isAndroidApp()) {
    if (getAnalyticsConsent() === 'granted') FirebaseAnalytics.logEvent({ name, params: (params || {}) as any }).catch(() => {});
    return;
  }
  if (analyticsInstance) logEvent(analyticsInstance, name, params);
}

export function trackPageView(path: string) {
  trackEvent('page_view', { page_path: path, page_location: path });
}

export function setAnalyticsUserId(uid: string | null) {
  if (analyticsInstance) setUserId(analyticsInstance, uid);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
