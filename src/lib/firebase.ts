import { initializeApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, OAuthProvider } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  doc,
  getDocFromServer
} from 'firebase/firestore';
import { getAnalytics, isSupported, logEvent, setUserId, type Analytics } from 'firebase/analytics';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Initialize Firestore
const dbId = (firebaseConfig as any).firestoreDatabaseId;

// Offline persistence (IndexedDB-backed): onSnapshot listeners keep serving whatever was last
// synced instead of hanging/erroring while offline, and writes made offline (addDoc/updateDoc/
// deleteDoc/transactions, everywhere in the app) are queued locally and sent automatically the
// moment connectivity returns — this is the SDK's own built-in behavior once persistence is on,
// not something built per-feature. `persistentMultipleTabManager` (over the older single-tab-only
// default) avoids a `failed-precondition` error if the app is ever open in more than one WebView/
// tab context at once. Falls back to a memory-only cache (today's prior behavior — works fine
// online, just nothing survives offline) if persistence can't be enabled at all, e.g. a browser/
// WebView with IndexedDB disabled or restricted (some private-browsing modes).
function createFirestore(firebaseApp: FirebaseApp, databaseId?: string) {
  try {
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
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

function initAnalyticsSdk() {
  isSupported()
    .then((supported) => {
      if (supported) analyticsInstance = getAnalytics(app);
    })
    .catch(() => {});
}

export function getAnalyticsConsent(): 'granted' | 'denied' | null {
  try {
    const v = localStorage.getItem(ANALYTICS_CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null; // localStorage unavailable (private browsing etc.) — treated as "not yet decided"
  }
}

export function setAnalyticsConsent(consent: 'granted' | 'denied') {
  try {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, consent);
  } catch {
    // Unable to persist — the banner will just ask again next visit, which is the safe direction
    // to fail in (never tracking without a fresh "yes" beats accidentally tracking without one).
  }
  if (consent === 'granted') initAnalyticsSdk();
}

if (getAnalyticsConsent() === 'granted') initAnalyticsSdk();

export function trackEvent(name: string, params?: Record<string, unknown>) {
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
