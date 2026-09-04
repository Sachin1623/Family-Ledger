import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { auth, db, setAnalyticsUserId } from '../lib/firebase';
import { doc, getDoc, setDoc, addDoc, collection, onSnapshot, query, where, getDocs, limit } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from '../lib/firebase';
import { encryptPII, decryptPII } from '../lib/encryption';
import { updateGlobalStats } from '../services/statsService';
import { Capacitor } from '@capacitor/core';
import { initPushNotifications } from '../lib/pushNotifications';
import { getApproxCountry } from '../lib/geo';
import { FrequencyConfig, firstOccurrenceOnOrAfter, sanitizeFrequencyConfig } from '../lib/frequency';

interface AdminStatus {
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  isSuperAdmin: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  profile: any | null;
  admin: AdminStatus;
}

const DEFAULT_ADMIN_STATUS: AdminStatus = { isAdmin: false, isPrimaryAdmin: false, isSuperAdmin: false };

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  profile: null,
  admin: DEFAULT_ADMIN_STATUS,
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminStatus, setAdminStatus] = useState<AdminStatus>(DEFAULT_ADMIN_STATUS);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | undefined;
    let currentAuthUid: string | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (authUser) => {
      // Clean up previous profile listener if it exists immediately
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = undefined;
      }

      // Refreshes fields (emailVerified, displayName, photoURL) that can change server-side
      // out of band — e.g. /api/mark-email-verified during signup — without a matching
      // client-side auth event. Without this, UI gated on emailVerified (the Feed button in
      // Header.tsx) can stay wrong for the rest of the session.
      if (authUser) {
        try {
          await authUser.reload();
        } catch (reloadErr) {
          console.error('Failed to refresh auth user profile:', reloadErr);
        }
      }

      setUser(authUser);
      setAnalyticsUserId(authUser?.uid || null);
      
      if (authUser) {
        const myUid = authUser.uid;
        currentAuthUid = myUid;

        const userDocRef = doc(db, 'users', myUid);
        const privateDocRef = doc(db, 'users', myUid, 'private', 'info');
        
        // Listen to both public and private data
        const syncProfile = async () => {
          try {
            const [publicSnap, privateSnap] = await Promise.all([
              getDoc(userDocRef).catch(err => {
                handleFirestoreError(err, OperationType.GET, `users/${myUid}`);
                throw err;
              }),
              getDoc(privateDocRef).catch(err => {
                handleFirestoreError(err, OperationType.GET, `users/${myUid}/private/info`);
                throw err;
              })
            ]);

            // If the user changed/logged out during the fetch, abort
            if (currentAuthUid !== myUid) {
              return;
            }

            // If profile documents don't exist, we wait slightly to see if the signup flow in Login.tsx is creating them
            let isPublicMissing = !publicSnap.exists();
            let isPrivateMissing = !privateSnap.exists();

            if (isPublicMissing || isPrivateMissing) {
              await new Promise(resolve => setTimeout(resolve, 600));
              if (currentAuthUid !== myUid) return;
              
              // Fetch again to check if Login.tsx already created them
              const [freshPublicSnap, freshPrivateSnap] = await Promise.all([
                getDoc(userDocRef),
                getDoc(privateDocRef)
              ]);
              isPublicMissing = !freshPublicSnap.exists();
              isPrivateMissing = !freshPrivateSnap.exists();
            }

            if (isPublicMissing) {
              // Create default public profile
              await setDoc(userDocRef, {
                uid: myUid,
                displayName: authUser.displayName || 'User',
                photoURL: authUser.photoURL || '',
                joinedAt: new Date().toISOString(),
                verified: false,
                isVerified: false,
                emailVerified: false,
                // Explicitly `false` (not just absent) so OnboardingTour.tsx can tell a genuinely
                // brand-new account apart from an established user whose doc predates this field
                // entirely — only the former should auto-launch the tour.
                hasSeenOnboarding: false
              }).catch(err => {
                handleFirestoreError(err, OperationType.CREATE, `users/${myUid}`);
                throw err;
              });
              // Increment global user count
              await updateGlobalStats({ users: 1 });
            }

            if (isPrivateMissing) {
              // Create default private info
              await setDoc(privateDocRef, {
                email: encryptPII(authUser.email || ''),
                biometricEnabled: false,
                notificationsEnabled: true,
                updatedAt: new Date().toISOString(),
                verified: false,
                isVerified: false,
                emailVerified: false
              }).catch(err => {
                handleFirestoreError(err, OperationType.CREATE, `users/${myUid}/private/info`);
                throw err;
              });
            }

            // If the user changed/logged out during the document creations, abort
            if (currentAuthUid !== myUid) {
              return;
            }

            // Set up real-time listener for both
            const unsubPublic = onSnapshot(userDocRef, (snap) => {
              const publicData = snap.data();
              setProfile((prev: any) => ({ ...prev, ...publicData }));
            });

            const unsubPrivate = onSnapshot(privateDocRef, (snap) => {
              const privateData = snap.data();
              if (privateData?.email) {
                privateData.email = decryptPII(privateData.email);
              }
              setProfile((prev: any) => ({ ...prev, ...privateData }));
            }, (err) => {
              // If we can't read private data, that's okay for others' profiles, 
              // but here it's the current user's profile which we should be able to read.
              console.error("Private info snapshot error:", err);
            });

            unsubscribeProfile = () => {
              unsubPublic();
              unsubPrivate();
            };
          } catch (error) {
            if (currentAuthUid === myUid) {
              handleFirestoreError(error, OperationType.WRITE, 'profile_sync');
            }
          } finally {
            if (currentAuthUid === myUid) {
              setLoading(false);
            }
          }
        };

        syncProfile();
        initPushNotifications(authUser);

        authUser.getIdToken().then((idToken) => {
          const authHeader = { Authorization: `Bearer ${idToken}` };

          // Best-effort: recover any prior account's data for this email (duplicate
          // account from a different sign-in provider, or a recent self-deletion). Safe
          // to call every sign-in — it's a no-op when there's nothing to merge.
          fetch('/api/merge-account', { method: 'POST', headers: authHeader }).catch((mergeError) =>
            console.error('merge-account request failed:', mergeError),
          );

          // Admin panel visibility (backend is the source of truth; this is only used to
          // decide whether to show the admin nav entry and gate the /admin routes).
          fetch('/api/admin/me', { headers: authHeader })
            .then((r) => r.json())
            .then((status) => {
              if (currentAuthUid === myUid) setAdminStatus(status);
            })
            .catch((adminError) => console.error('admin/me request failed:', adminError));

          // Idempotent — assigns a 6-char search ID the first time this account signs in, no-op
          // after that. Server-side (not written directly by the client here) since it needs a
          // uniqueness check against every other user's ID. The public-profile snapshot listener
          // above picks up the written field automatically once it lands.
          fetch('/api/ensure-short-id', { method: 'POST', headers: authHeader }).catch((shortIdError) =>
            console.error('ensure-short-id request failed:', shortIdError),
          );
        });

        // Login/activity tracking, used by the admin analytics dashboard and (later) idle
        // reminder notifications. Fire-and-forget — never blocks sign-in.
        const nowIso = new Date().toISOString();
        addDoc(collection(db, 'loginEvents'), {
          uid: myUid,
          email: authUser.email || '',
          createdAt: nowIso,
          platform: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web',
        }).catch((err) => console.error('loginEvents write failed:', err));
        setDoc(userDocRef, { lastLoginAt: nowIso, lastActiveAt: nowIso, country: getApproxCountry() }, { merge: true }).catch((err) =>
          console.error('lastLoginAt update failed:', err),
        );
      } else {
        currentAuthUid = null;
        setProfile(null);
        setAdminStatus(DEFAULT_ADMIN_STATUS);
        setLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
    };
  }, []);

  // Heartbeat for the "haven't opened the app in 5 days" reminder — onAuthStateChanged only
  // fires on actual sign-in/out, not on every app open for an already-persisted session, so
  // this refreshes lastActiveAt whenever the app comes to the foreground too.
  //
  // Also maintains `appForegroundAt`, a short-lived "is this device actually open right now"
  // signal — used by server-side notification logic (e.g. Ludo's turn notifications) to decide
  // between a push (app closed/backgrounded) and a lightweight in-app indicator (app open, just
  // on a different screen). Unlike lastActiveAt (updated once per foreground transition, fine for
  // a multi-day-idle check), this needs to stay fresh for as long as the app stays open — a
  // single foreground event wouldn't still be "recent" 20 minutes into an open session — so it
  // re-writes on an interval the whole time the document stays visible, and is explicitly cleared
  // (not just left to go stale) the moment it's backgrounded, so the server doesn't have to guess
  // based on a timeout alone.
  useEffect(() => {
    if (!user) return;
    let interval: ReturnType<typeof setInterval> | null = null;

    const writeForeground = () => {
      // Piggybacks the IANA timezone (e.g. "Asia/Kolkata") onto this same heartbeat write rather
      // than a separate effect — it's already a merge write every 25s while foregrounded, so this
      // adds no extra write count, keeps the value self-correcting if someone travels, and gives
      // every server-side cron job doing calendar-day/month math (see server.ts's
      // nowInTimeZone/todayDateStringInTimeZone) a per-user zone to fall back to when a feature
      // hasn't captured its own (like recurring expenses/reminders already do per-item).
      setDoc(
        doc(db, 'users', user.uid),
        {
          lastActiveAt: new Date().toISOString(),
          appForegroundAt: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        { merge: true },
      ).catch((err) => console.error('presence heartbeat failed:', err));
    };
    const clearForeground = () => {
      setDoc(doc(db, 'users', user.uid), { appForegroundAt: null }, { merge: true }).catch(() => {});
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        writeForeground();
        if (!interval) interval = setInterval(writeForeground, 25000);
      } else {
        if (interval) { clearInterval(interval); interval = null; }
        clearForeground();
      }
    };

    handleVisibility(); // cover the initial mount, not just later transitions
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (interval) clearInterval(interval);
    };
  }, [user]);

  // Every user gets a standing "log an expense?" nudge at 8pm their own local time, daily —
  // reusing the existing expenseReminders/processExpenseReminders machinery (ExpenseReminders.tsx,
  // server.ts's 15-min cron) rather than inventing a parallel one. Seeded once, lazily, the first
  // time this runs after the user is known — cheapest place to check-and-backfill for both
  // existing and brand-new accounts without a separate migration script. Marked with
  // `systemReminderKind` so it's identifiable (and safely re-runnable: this checks for an existing
  // one before creating another), but it's otherwise a completely ordinary reminder — visible,
  // editable, and deletable by the user from the Expense Reminders screen like any other, which is
  // also how they opt back out if they don't want it.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const existing = await getDocs(
          query(
            collection(db, 'expenseReminders'),
            where('userId', '==', user.uid),
            where('systemReminderKind', '==', 'daily_expense_log'),
            limit(1),
          ),
        );
        if (cancelled || !existing.empty) return;
        const config: FrequencyConfig = { frequency: 'daily', hour: 20, minute: 0 };
        const nextRunDate = firstOccurrenceOnOrAfter(config, new Date()).toISOString();
        await addDoc(collection(db, 'expenseReminders'), {
          userId: user.uid,
          systemReminderKind: 'daily_expense_log',
          presetGroupId: null,
          presetCategory: null,
          presetAmount: null,
          presetImages: [],
          oneTime: false,
          ...sanitizeFrequencyConfig(config),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          nextRunDate,
          active: true,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error('Failed to seed the daily expense-log reminder:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, profile, admin: adminStatus }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
