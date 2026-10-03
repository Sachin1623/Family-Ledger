import React from "react";
import {
  auth,
  googleProvider,
  appleProvider,
  db,
  handleFirestoreError,
  OperationType,
  trackEvent,
} from "../lib/firebase";
import { encryptPII } from "../lib/encryption";
import {
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  getAdditionalUserInfo,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { useNavigate, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useLanguage, LANGUAGES, ENABLED_LANGUAGES } from "../context/LanguageContext";
import { motion, AnimatePresence } from "motion/react";
import { clsx } from "clsx";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

type LoginMode = "google" | "login" | "signup" | "forgot";

export default function Login() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { language, setLanguage, t } = useLanguage();
  // Opens automatically as soon as the login screen is ready to show — the user picks (or
  // confirms) a language before doing anything else — and stays reachable afterward via the
  // top-right chip button for changing it mid-session.
  const [showLangPicker, setShowLangPicker] = React.useState(true);
  const [mode, setMode] = React.useState<LoginMode>("google");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [otp, setOtp] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);
  const [otpVerified, setOtpVerified] = React.useState(false);
  const [loginError, setLoginError] = React.useState<string | null>(null);
  // Lazy initializer (not a useEffect) so a message passed via navigate('/login', { state: {
  // message } }) — e.g. Profile.tsx's account-deletion confirmation — shows immediately on the
  // very first render, with no blocking alert() anywhere in the chain that triggered it.
  const [statusMessage, setStatusMessage] = React.useState<string | null>(() => (location.state as any)?.message || null);
  const [resetToken, setResetToken] = React.useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = React.useState(false);
  const [isSendingOtp, setIsSendingOtp] = React.useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = React.useState(false);
  const [agreedToTerms, setAgreedToTerms] = React.useState(false);

  // Apple only ever asks "Share/Hide Email" on a given device's FIRST authorization for this
  // app — a persistent dismiss (not per-session) so a user who's already seen and closed this
  // doesn't keep seeing it on every return visit to the login screen, long after that one-time
  // dialog has already come and gone for them. Best-effort: localStorage can throw/be
  // unavailable (private browsing, blocked site data) — defaults to showing the tip in that
  // case, which is the safe direction to fail in (an extra tip vs. a silently lost one).
  const [showAppleEmailTip, setShowAppleEmailTip] = React.useState(() => {
    try { return localStorage.getItem('familyledger_apple_email_tip_dismissed') !== 'true'; } catch { return true; }
  });
  const dismissAppleEmailTip = () => {
    setShowAppleEmailTip(false);
    try { localStorage.setItem('familyledger_apple_email_tip_dismissed', 'true'); } catch { /* best-effort */ }
  };

  // --- Account recovery: a paused (soft-deleted) account tried to sign in. Firebase blocks a
  // disabled Auth user at the SDK level before this app ever sees a uid, so there's no session
  // to prove identity with the normal way — this reuses the existing OTP infrastructure
  // (send-otp/verify-otp's 'recover' purpose) to prove email ownership instead, then offers the
  // three choices from Profile's "Recover deleted account" banner's own design: relink (restore
  // everything, nothing ever moved so this is instant), delete permanently now (skip the rest
  // of the 30-day wait), or back out and keep the option available in Profile for 30 days. A
  // standalone panel (not woven into the `mode` state machine above) since it's triggered by an
  // error from sign-in, not a deliberate mode switch. */
  const [showRecoverPanel, setShowRecoverPanel] = React.useState(false);
  const [recoverEmail, setRecoverEmail] = React.useState("");
  const [recoverStep, setRecoverStep] = React.useState<"send" | "verify" | "choose" | "done">("send");
  const [recoverOtp, setRecoverOtp] = React.useState("");
  const [recoverToken, setRecoverToken] = React.useState<string | null>(null);
  const [recoverPurgeAt, setRecoverPurgeAt] = React.useState<string | null>(null);
  const [recoverMode, setRecoverMode] = React.useState<string | null>(null);
  const [recoverError, setRecoverError] = React.useState<string | null>(null);
  const [recoverBusy, setRecoverBusy] = React.useState(false);
  const [recoverDoneMessage, setRecoverDoneMessage] = React.useState<string | null>(null);

  const openRecoverPanel = (prefillEmail: string) => {
    setRecoverEmail(prefillEmail || "");
    setRecoverStep("send");
    setRecoverOtp("");
    setRecoverToken(null);
    setRecoverPurgeAt(null);
    setRecoverMode(null);
    setRecoverError(null);
    setRecoverDoneMessage(null);
    setShowRecoverPanel(true);
  };

  // A 'hard' delete (or "delete permanently now" on top of an original soft one) sets purgeAt to
  // the moment it was REQUESTED, not +30 days — the backend purge cron picks it up on its next
  // run rather than instantly, so by the time someone's looking at this screen that timestamp
  // may already be in the past. Showing "Scheduled to delete: <a time already gone by>" would
  // read as broken, so that case gets its own "processing now" copy instead of a date.
  const recoverPurgeDate = recoverPurgeAt ? new Date(recoverPurgeAt) : null;
  const recoverPurgeIsFuture = recoverPurgeDate ? recoverPurgeDate.getTime() > Date.now() : false;
  const recoverPurgeFormatted = recoverPurgeDate
    // Can't combine dateStyle/timeStyle with timeZoneName — Intl.DateTimeFormat throws
    // (ECMA-402 forbids mixing the style shorthands with explicit component options), so this
    // spells out each component instead of using the shorthand.
    ? recoverPurgeDate.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    : null;

  const handleSendRecoveryOtp = async () => {
    setRecoverError(null);
    setRecoverBusy(true);
    try {
      const response = await fetch("/api/send-recovery-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: recoverEmail }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setRecoverError(payload.error || "Unable to send a recovery code right now.");
        return;
      }
      setRecoverStep("verify");
    } catch (error) {
      console.error("send-recovery-otp error:", error);
      setRecoverError("Unable to send a recovery code right now.");
    } finally {
      setRecoverBusy(false);
    }
  };

  const handleVerifyRecoveryOtp = async () => {
    setRecoverError(null);
    setRecoverBusy(true);
    try {
      const response = await fetch("/api/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: recoverEmail, code: recoverOtp, purpose: "recover" }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setRecoverError(payload.error || "Unable to verify that code.");
        return;
      }
      setRecoverToken(payload.recoverToken);
      setRecoverPurgeAt(payload.purgeAt || null);
      setRecoverMode(payload.mode || null);
      setRecoverStep("choose");
    } catch (error) {
      console.error("verify-recovery-otp error:", error);
      setRecoverError("Unable to verify that code.");
    } finally {
      setRecoverBusy(false);
    }
  };

  const handleRecoverAction = async (action: "relink" | "delete-now") => {
    setRecoverError(null);
    setRecoverBusy(true);
    try {
      const response = await fetch("/api/account/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: recoverEmail, recoverToken, action }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setRecoverError(payload.error || "Unable to process that request right now.");
        return;
      }
      if (action === "relink") {
        setRecoverDoneMessage("Your account is back. Sign in again with your usual credentials to pick up right where you left off.");
      } else {
        setRecoverDoneMessage("Got it — your account and data will be permanently deleted shortly. We'll send a confirmation to your email once it's done.");
      }
      setRecoverStep("done");
    } catch (error) {
      console.error("account/recover error:", error);
      setRecoverError("Unable to process that request right now.");
    } finally {
      setRecoverBusy(false);
    }
  };

  // Firebase throws this for ANY sign-in method once an account has been disabled (soft
  // deletion's Auth-level block) — true for Google/Apple/email alike, so one shared check
  // covers all three handlers' catch blocks below. Returns whether it handled the error (and
  // routed to the recovery panel) so each catch block's own fallback error message is skipped.
  const maybeHandleDisabledAccount = (error: any, fallbackEmail: string): boolean => {
    if (error?.code !== "auth/user-disabled") return false;
    openRecoverPanel(fallbackEmail);
    return true;
  };

  const from = (location.state as any)?.from || "/";

  React.useEffect(() => {
    const handleRedirectResult = async () => {
      try {
        const { getRedirectResult } = await import("firebase/auth");
        const result = await getRedirectResult(auth);
        if (result) {
          navigate(from, { replace: true });
        }
      } catch (error) {
        console.error("Redirect error:", error);
      }
    };
    handleRedirectResult();
  }, [from, navigate]);

  if (loading) return null;
  if (user) return <Navigate to={from} replace />;

  const createOrUpdateUserRecords = async (loggedInUser: any) => {
    const userDocRef = doc(db, "users", loggedInUser.uid);
    const privateDocRef = doc(db, "users", loggedInUser.uid, "private", "info");

    // Don't blindly overwrite displayName/photoURL from the OAuth provider on every login — Google
    // (and, on its one-time grant, Apple) hands back its own current name/photo on every sign-in,
    // and this used to unconditionally write both, silently clobbering a name edit or custom photo
    // upload (Profile.tsx, same users/{uid} fields) the next time the user logged back in. Only
    // seed those two fields — and joinedAt — the first time this user document is ever created;
    // every later login only refreshes uid/email, which should always track the provider.
    const existingSnap = await getDoc(userDocRef).catch(() => null);
    const existingData = existingSnap?.exists() ? (existingSnap.data() as any) : null;

    const userUpdate: Record<string, any> = {
      uid: loggedInUser.uid,
      email: loggedInUser.email || "",
    };
    if (!existingData) {
      userUpdate.joinedAt = new Date().toISOString();
      // This write runs synchronously, right here, immediately after sign-in/sign-up resolves —
      // which wins the race against AuthContext.tsx's own onAuthStateChanged-driven creation logic
      // almost every time (that one awaits two getDocs, sometimes a 600ms wait, then a re-check,
      // before it ever writes). Without these two fields set explicitly `false` HERE, on the doc's
      // actual first write, AuthContext.tsx's own creation block finds the doc already exists and
      // skips its own initialization — meaning ProfileSetupWizard and the dashboard spotlight tour
      // (both gated on these being explicitly `false`, not just absent) would never auto-launch for
      // a genuinely brand-new account. Keep these in sync with AuthContext.tsx's matching comment.
      userUpdate.hasSeenOnboarding = false;
      userUpdate.hasCompletedProfileSetup = false;
    }
    if (!existingData?.displayName) {
      userUpdate.displayName =
        loggedInUser.displayName ||
        loggedInUser.email?.split("@")[0] ||
        "User";
    }
    if (!existingData?.photoURL) {
      userUpdate.photoURL = loggedInUser.photoURL || "";
    }

    await setDoc(
      userDocRef,
      userUpdate,
      { merge: true },
    ).catch((err) => {
      handleFirestoreError(
        err,
        OperationType.CREATE,
        `users/${loggedInUser.uid}`,
      );
    });

    if (loggedInUser.email) {
      await setDoc(
        privateDocRef,
        {
          email: encryptPII(loggedInUser.email),
          biometricEnabled: false,
          notificationsEnabled: true,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      ).catch((err) => {
        handleFirestoreError(
          err,
          OperationType.CREATE,
          `users/${loggedInUser.uid}/private/info`,
        );
      });
    }
  };

  const switchMode = (newMode: LoginMode) => {
    setMode(newMode);
    setOtpSent(false);
    setOtpVerified(false);
    setOtp("");
    setPassword("");
    setConfirmPassword("");
    setLoginError(null);
    setResetToken(null);

    if (newMode === "forgot") {
      setStatusMessage(t('auth.forgotPasswordIntro'));
    } else {
      setStatusMessage(null);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    setStatusMessage(null);
    try {
      let firebaseUser;
      let isNewUser = false;
      if (Capacitor.isNativePlatform()) {
        // Web OAuth popups are blocked inside Android's embedded WebView, so on
        // device we sign in with the native Google account picker instead, then
        // bridge the resulting credential into the Firebase JS SDK session.
        // useCredentialManager: false uses the legacy GoogleSignInClient flow. Diagnostic
        // test (2026-08-03) confirmed the newer Credential Manager path (true) fails even
        // harder — NoCredentialException instead of even reaching the account picker — so
        // this is the less-broken of the two until Google's backend catches up.
        const nativeResult = await FirebaseAuthentication.signInWithGoogle({ useCredentialManager: false });
        const idToken = nativeResult.credential?.idToken;
        if (!idToken) {
          // Set directly (not via a thrown Error) so the catch block's generic
          // `error?.message || t('auth.errGoogleSignInFailed')` fallback doesn't get bypassed by
          // a raw, untranslated English message — `finally` below still resets isLoggingIn.
          setLoginError(t('auth.errNoValidCredential'));
          return;
        }
        const credential = GoogleAuthProvider.credential(idToken);
        const result = await signInWithCredential(auth, credential);
        firebaseUser = result.user;
        isNewUser = !!getAdditionalUserInfo(result)?.isNewUser;
      } else {
        const result = await signInWithPopup(auth, googleProvider);
        firebaseUser = result.user;
        isNewUser = !!getAdditionalUserInfo(result)?.isNewUser;
      }
      await createOrUpdateUserRecords(firebaseUser);
      trackEvent(isNewUser ? 'sign_up' : 'login', { method: 'google' });
      navigate(from, { replace: true });
    } catch (error: any) {
      console.error("Login error:", error);
      if (maybeHandleDisabledAccount(error, "")) {
        // handled — recovery panel is open
      } else if (error.code === "auth/popup-blocked") {
        setLoginError(t('auth.errPopupBlocked'));
      } else if (
        error.code !== "auth/popup-closed-by-user" &&
        error.code !== "12501" &&
        error.errorMessage !== "The user canceled the sign-in flow."
      ) {
        setLoginError(error?.message || t('auth.errGoogleSignInFailed'));
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Mirrors handleGoogleSignIn's native/web split. Apple only returns the user's real name on
  // the very FIRST authorization ever granted to this app (never again after, even from the same
  // device) — createOrUpdateUserRecords below already only sets displayName when one isn't set
  // yet, so a returning Apple user who signed up with a name keeps it even though later sign-ins
  // won't re-supply one.
  const handleAppleSignIn = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    setStatusMessage(null);
    try {
      let firebaseUser;
      let isNewUser = false;
      if (Capacitor.isNativePlatform()) {
        const nativeResult = await FirebaseAuthentication.signInWithApple();
        const idToken = nativeResult.credential?.idToken;
        if (!idToken) {
          setLoginError(t('auth.errNoValidCredential'));
          return;
        }
        const credential = new OAuthProvider('apple.com').credential({
          idToken,
          rawNonce: (nativeResult.credential as any)?.nonce,
        });
        const result = await signInWithCredential(auth, credential);
        firebaseUser = result.user;
        isNewUser = !!getAdditionalUserInfo(result)?.isNewUser;
      } else {
        const result = await signInWithPopup(auth, appleProvider);
        firebaseUser = result.user;
        isNewUser = !!getAdditionalUserInfo(result)?.isNewUser;
      }
      await createOrUpdateUserRecords(firebaseUser);
      trackEvent(isNewUser ? 'sign_up' : 'login', { method: 'apple' });
      navigate(from, { replace: true });
    } catch (error: any) {
      console.error("Apple sign-in error:", error);
      if (maybeHandleDisabledAccount(error, "")) {
        // handled — recovery panel is open
      } else if (
        error.code !== "auth/popup-closed-by-user" &&
        error.code !== "1001" &&
        error.errorMessage !== "The user canceled the sign-in flow."
      ) {
        setLoginError(error?.message || t('auth.errAppleSignInFailed'));
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleEmailLogin = async () => {
    setLoginError(null);
    setStatusMessage(null);
    setIsLoggingIn(true);

    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      await createOrUpdateUserRecords(result.user);
      trackEvent('login', { method: 'password' });
      navigate(from, { replace: true });
    } catch (error: any) {
      console.error("Email login error:", error);
      if (maybeHandleDisabledAccount(error, email)) {
        // handled — recovery panel is open
      } else if (error?.code === "auth/wrong-password") {
        setLoginError(t('auth.errWrongPassword'));
      } else if (
        error?.code === "auth/user-not-found" ||
        error?.code === "auth/invalid-credential"
      ) {
        setLoginError(t('auth.errNoAccountFound'));
      } else if (error?.code === "auth/invalid-email") {
        setLoginError(t('auth.errInvalidEmail'));
      } else {
        setLoginError(error?.message || t('auth.errUnableToSignIn'));
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleCreateAccount = async () => {
    setLoginError(null);
    setStatusMessage(null);
    if (!email) {
      setLoginError(t('auth.errEnterEmail'));
      return;
    }
    if (!otpVerified) {
      setLoginError(t('auth.errVerifyEmailFirst'));
      return;
    }
    if (password.length < 6) {
      setLoginError(t('auth.errPasswordTooShort'));
      return;
    }
    if (password !== confirmPassword) {
      setLoginError(t('auth.errPasswordsDontMatch'));
      return;
    }

    setIsLoggingIn(true);
    try {
      const result = await createUserWithEmailAndPassword(
        auth,
        email,
        password,
      );
      await createOrUpdateUserRecords(result.user);
      trackEvent('sign_up', { method: 'password' });
      // We already proved ownership of this inbox via the OTP step above, so mark the
      // Firebase Auth account verified now — this lets /api/merge-account trust the
      // email claim and recover any prior account's data for the same address.
      try {
        const idToken = await result.user.getIdToken();
        await fetch("/api/mark-email-verified", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}` },
        });
        // The client's cached user object still says emailVerified: false until reloaded —
        // without this, UI gated on it (e.g. the Feed button in Header.tsx) stays hidden for
        // the rest of the session even though the account is now correctly marked verified.
        await result.user.reload();
      } catch (verifyError) {
        console.error("mark-email-verified failed:", verifyError);
      }
      navigate(from, { replace: true });
    } catch (error: any) {
      console.error("Signup error:", error);
      if (error?.code === "auth/email-already-in-use") {
        setLoginError(t('auth.errEmailAlreadyRegistered'));
      } else if (error?.code === "auth/invalid-email") {
        setLoginError(t('auth.errInvalidEmail'));
      } else {
        setLoginError(error?.message || t('auth.errUnableToCreateAccount'));
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSendResetOtp = async () => {
    setLoginError(null);
    setStatusMessage(null);
    setIsSendingOtp(true);

    try {
      const response = await fetch("/api/send-reset-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setLoginError(payload.error || t('auth.errUnableToSendResetCode'));
        return;
      }

      setOtpSent(true);
      setOtpVerified(false);
      setStatusMessage(payload.message || t('auth.resetCodeSent'));
    } catch (error) {
      console.error("Send reset OTP error:", error);
      setLoginError(t('auth.errFailedToSendResetCode'));
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleResetPassword = async () => {
    setLoginError(null);
    setStatusMessage(null);

    if (!resetToken) {
      setLoginError(t('auth.errVerifyEmailFirst'));
      return;
    }
    if (password.length < 6) {
      setLoginError(t('auth.errPasswordTooShort'));
      return;
    }
    if (password !== confirmPassword) {
      setLoginError(t('auth.errPasswordsDontMatch'));
      return;
    }

    setIsLoggingIn(true);
    try {
      const response = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, resetToken, newPassword: password }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setLoginError(payload.error || t('auth.errUnableToResetPassword'));
        return;
      }

      switchMode("login");
      setStatusMessage(payload.message || t('auth.passwordUpdated'));
    } catch (error) {
      console.error("Reset password error:", error);
      setLoginError(t('auth.errResetPasswordFailed'));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSendOtp = async () => {
    setLoginError(null);
    setStatusMessage(null);
    setIsSendingOtp(true);

    try {
      const response = await fetch("/api/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const payload = await response.json();
      if (!response.ok) {
        if (payload.userExists) {
          switchMode("login");
          setLoginError(payload.error || t('auth.errEmailAlreadyRegisteredLogin'));
          return;
        }
        setLoginError(payload.error || t('auth.errUnableToSendVerificationCode'));
        return;
      }

      setOtpSent(true);
      setOtpVerified(false);
      setStatusMessage(payload.message || t('auth.verificationCodeSent'));
    } catch (error) {
      console.error("Send OTP error:", error);
      setLoginError(t('auth.errFailedToSendVerificationCode'));
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleVerifyOtp = async () => {
    setLoginError(null);
    setStatusMessage(null);
    setIsVerifyingOtp(true);

    const purpose = mode === "forgot" ? "reset" : "signup";

    try {
      const response = await fetch("/api/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otp, purpose }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setLoginError(payload.error || t('auth.errUnableToVerifyCode'));
        return;
      }

      setOtpVerified(true);
      setOtpSent(false);

      if (purpose === "reset") {
        setResetToken(payload.resetToken || null);
        setStatusMessage(t('auth.emailVerifiedChooseNewPassword'));
      } else {
        setStatusMessage(t('auth.emailVerifiedChoosePasswordSignup'));
      }
    } catch (error) {
      console.error("Verify OTP error:", error);
      setLoginError(t('auth.errVerificationFailed'));
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-surface p-4 text-on-surface">
      <div className="absolute top-4 right-4 z-10">
        <button
          type="button"
          onClick={() => setShowLangPicker(true)}
          className="flex items-center gap-1.5 px-3 py-2 bg-white border border-border-subtle rounded-full shadow-sm text-xs font-bold text-primary active:scale-95 transition-all"
        >
          <span className="material-symbols-outlined text-[18px]">language</span>
          {LANGUAGES.find((l) => l.code === language)?.nativeLabel}
        </button>
      </div>

      <AnimatePresence>
        {showLangPicker && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              className="w-full max-w-sm bg-white rounded-3xl shadow-xl border border-border-subtle p-6 space-y-4 max-h-[85vh] flex flex-col"
            >
              <div className="flex items-center gap-3 shrink-0">
                <div className="w-11 h-11 bg-primary/10 text-primary rounded-2xl flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-2xl">language</span>
                </div>
                <h2 className="text-lg font-black text-primary">{t('profile.chooseLanguage')}</h2>
              </div>
              <div className="grid grid-cols-2 gap-2 overflow-y-auto pr-1">
                {ENABLED_LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => setLanguage(l.code)}
                    className={clsx(
                      "px-3 py-3 rounded-2xl text-left text-sm font-bold transition-all border flex items-center justify-between gap-2",
                      l.code === language
                        ? "bg-primary text-white border-primary"
                        : "text-on-surface border-border-subtle hover:bg-surface-container",
                    )}
                  >
                    <span className="truncate">{l.nativeLabel}</span>
                    {l.code === language && <span className="material-symbols-outlined text-[16px] shrink-0">check</span>}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowLangPicker(false)}
                className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-all shrink-0"
              >
                {t('common.done')}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRecoverPanel && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              className="w-full max-w-sm bg-white rounded-3xl shadow-xl border border-border-subtle p-6 space-y-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 bg-primary/10 text-primary rounded-2xl flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-2xl">restore</span>
                </div>
                <div>
                  <h2 className="text-lg font-black text-primary">Paused account found</h2>
                  <p className="text-xs text-text-secondary">This account was paused, not deleted yet.</p>
                </div>
              </div>

              {recoverStep === "done" ? (
                <>
                  <p className="text-sm text-text-secondary leading-relaxed">{recoverDoneMessage}</p>
                  <button
                    type="button"
                    onClick={() => setShowRecoverPanel(false)}
                    className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-all"
                  >
                    {t('common.done')}
                  </button>
                </>
              ) : (
                <>
                  {recoverStep === "send" && (
                    <p className="text-sm text-text-secondary leading-relaxed">
                      We'll send a code to confirm it's really you before showing any options for this account.
                    </p>
                  )}
                  {recoverStep === "verify" && (
                    <p className="text-sm text-text-secondary leading-relaxed">
                      Enter the 4-digit code we sent to <strong>{recoverEmail}</strong>.
                    </p>
                  )}
                  {recoverStep === "choose" && (
                    <>
                      {recoverPurgeDate && (
                        <div className="flex items-start gap-2 px-3 py-2 bg-surface rounded-xl border border-border-subtle">
                          <span className="material-symbols-outlined text-[16px] text-text-muted mt-0.5">schedule</span>
                          {recoverPurgeIsFuture ? (
                            <p className="text-xs font-bold text-text-secondary leading-snug">
                              Scheduled to delete: {recoverPurgeFormatted}
                            </p>
                          ) : (
                            <p className="text-xs font-bold text-text-secondary leading-snug">
                              This was scheduled to delete on {recoverPurgeFormatted} and may complete at any moment — link it back now if you still want to keep it.
                            </p>
                          )}
                        </div>
                      )}
                      <p className="text-sm text-text-secondary leading-relaxed">
                        {recoverMode === "hard"
                          ? "Link it back to stop the deletion and pick up right where you left off, or let it go through."
                          : "Link it back and pick up right where you left off, or permanently delete it now instead of waiting."}
                      </p>
                    </>
                  )}

                  {recoverError && <p className="text-xs font-bold text-error">{recoverError}</p>}

                  {(recoverStep === "send" || recoverStep === "verify") && (
                    <input
                      type="email"
                      value={recoverEmail}
                      onChange={(e) => setRecoverEmail(e.target.value)}
                      disabled={recoverStep === "verify"}
                      placeholder="you@example.com"
                      className="w-full px-4 py-3 bg-surface border border-border-subtle rounded-2xl text-sm disabled:opacity-60"
                    />
                  )}

                  {recoverStep === "verify" && (
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={recoverOtp}
                      onChange={(e) => setRecoverOtp(e.target.value.replace(/\D/g, ""))}
                      placeholder="4-digit code"
                      className="w-full px-4 py-3 bg-surface border border-border-subtle rounded-2xl text-sm text-center tracking-[0.3em] font-bold"
                    />
                  )}

                  {recoverStep === "choose" && (
                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled={recoverBusy}
                        onClick={() => handleRecoverAction("relink")}
                        className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {recoverBusy ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : "Link my account back"}
                      </button>
                      <button
                        type="button"
                        disabled={recoverBusy}
                        onClick={() => handleRecoverAction("delete-now")}
                        className="w-full py-3.5 bg-error/10 text-error font-bold rounded-2xl active:scale-95 transition-all disabled:opacity-50"
                      >
                        Delete permanently now
                      </button>
                    </div>
                  )}

                  {recoverStep === "send" && (
                    <button
                      type="button"
                      disabled={recoverBusy || !recoverEmail}
                      onClick={handleSendRecoveryOtp}
                      className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {recoverBusy ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : "Send code"}
                    </button>
                  )}
                  {recoverStep === "verify" && (
                    <button
                      type="button"
                      disabled={recoverBusy || recoverOtp.length !== 4}
                      onClick={handleVerifyRecoveryOtp}
                      className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {recoverBusy ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : "Verify code"}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowRecoverPanel(false)}
                    className="w-full text-xs font-bold text-text-muted"
                  >
                    {recoverStep === "choose"
                      ? "Not now — you can still link it any time in the next 30 days from Profile → Recover deleted account."
                      : "Cancel"}
                  </button>
                </>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white p-8 rounded-3xl shadow-xl border border-border-subtle text-center space-y-8"
      >
        <div className="space-y-3">
          <div className="w-16 h-16 rounded-2xl shadow-inner mx-auto overflow-hidden">
            <svg viewBox="0 0 80 100" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
              <rect width="80" height="100" rx="12" fill="url(#login_ledger_grad)" />
              <path d="M60 30C60 26.6863 62.6863 24 66 24H80V76H66C62.6863 76 60 73.3137 60 70V30Z" fill="#1E3A8A" />
              <circle cx="25" cy="30" r="8" fill="white" fillOpacity="0.9" />
              <path d="M15 40C15 38.8954 15.8954 38 17 38H33C34.1046 38 35 38.8954 35 40V65H15V40Z" fill="white" fillOpacity="0.9" />
              <circle cx="45" cy="35" r="7" fill="white" fillOpacity="0.8" />
              <path d="M38 42C38 40.8954 38.8954 40 40 40H50C51.1046 40 52 40.8954 52 42V65H38V42Z" fill="white" fillOpacity="0.8" />
              <circle cx="35" cy="60" r="5" fill="white" />
              <path d="M30 65C30 64.4477 30.4477 64 31 64H39C39.5523 64 40 64.4477 40 65V75H30V65Z" fill="white" />
              <circle cx="55" cy="62" r="5" fill="white" />
              <path d="M50 67C50 66.4477 50.4477 66 51 66H59C59.5523 66 60 66.4477 60 67V75H50V67Z" fill="white" />
              <defs>
                <linearGradient id="login_ledger_grad" x1="0" y1="0" x2="80" y2="100" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#4ADE80" />
                  <stop offset="1" stopColor="#3B82F6" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 className="text-3xl font-black text-primary tracking-tight">
            FamilyLedger
          </h1>
          <p className="text-sm text-text-muted font-medium max-w-xs mx-auto">
            {t('auth.tagline')}
          </p>
        </div>

        {loginError && (
          <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200 text-left font-medium flex items-start gap-2">
            <span className="material-symbols-outlined text-red-500 text-lg shrink-0">
              error
            </span>
            <span>{loginError}</span>
          </div>
        )}

        {statusMessage && (
          <div className="p-4 bg-green-50 text-green-700 text-sm rounded-xl border border-green-200 text-left font-medium">
            {statusMessage}
          </div>
        )}

        <div className="space-y-4">
          <button
            onClick={handleGoogleSignIn}
            disabled={isLoggingIn}
            className="w-full py-4 px-6 bg-white border-2 border-border-subtle hover:border-primary text-primary font-bold rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95 shadow-sm hover:shadow-md disabled:opacity-50"
          >
            {isLoggingIn ? (
              <span className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            ) : (
              <>
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>{t('auth.continueWithGoogle')}</span>
              </>
            )}
          </button>

          {/* iOS-only — Apple's own guideline is that Sign in with Apple only needs to be offered
              wherever OTHER third-party logins are offered, and native Android has no equivalent
              concept of an "Apple account" on the device the way iOS does. Also sidesteps needing
              a working Android-side Apple OAuth config at all (Android would still route through
              the same web-based signInWithPopup as the browser, which the code below handles
              fine, but there's no product reason to surface it there once this is restricted).
              handleAppleSignIn/appleProvider/capacitor.config.ts (providers: ['google.com',
              'apple.com']) are already wired up. On native iOS, this only actually works once an
              iOS build that ran `npx cap sync` after apple.com was added to that config list has
              shipped — the provider list is baked into the native bundle at build time, not
              reachable via a JS-only deploy. Works immediately on web (signInWithPopup). */}
          {Capacitor.getPlatform() === 'ios' && (
            <button
              onClick={handleAppleSignIn}
              disabled={isLoggingIn}
              className="w-full py-4 px-6 bg-black hover:bg-neutral-800 text-white font-bold rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95 shadow-sm disabled:opacity-50"
            >
              {isLoggingIn ? (
                <span className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              ) : (
                <>
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                    <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.256-1.79-2.265-4.51-2.265-7.15 0-4.2 2.605-6.42 5.164-6.42 1.404 0 2.575.9 3.462.9.844 0 2.158-.958 3.762-.958.606 0 2.777.055 4.2 2.107-.11.07-2.507 1.475-2.478 4.396.033 3.497 3.021 4.66 3.058 4.68z" />
                  </svg>
                  <span>{t('auth.continueWithApple')}</span>
                </>
              )}
            </button>
          )}

          {/* A light, dismissible nudge — never a blocking screen in front of Apple's own dialog
              (see the account-recovery discussion this was built from: Apple's "Hide My Email"
              relay address can stop forwarding later if the user revokes this app's access or
              manages their relay addresses, with no way for us to detect that — losing the only
              channel a paused account can be recovered through). Can't make Apple default to
              "Share Email" — no API for that — so this is purely informational, shown right
              before the dialog that actually makes the choice. */}
          {Capacitor.getPlatform() === 'ios' && showAppleEmailTip && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-primary/5 border border-primary/15 rounded-xl text-left">
              <span className="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">info</span>
              <p className="flex-1 text-[11px] text-text-secondary leading-snug">
                When Apple asks, we recommend choosing <strong>Share My Email</strong> — it's how we can reach you if you ever need to recover a paused account.
              </p>
              <button type="button" onClick={dismissAppleEmailTip} className="shrink-0 text-text-muted" aria-label="Dismiss">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
          )}

          <button
            onClick={() => switchMode("login")}
            className="w-full py-4 px-6 bg-primary text-white rounded-2xl font-bold hover:bg-primary-dark transition-all active:scale-95 shadow-sm"
          >
            {t('auth.continueWithEmail')}
          </button>
        </div>

        {mode !== "google" && (
          <div className="space-y-4 text-left">
            <div className="space-y-2">
              <label
                className="text-sm font-semibold text-text-secondary"
                htmlFor="email"
              >
                {t('auth.emailAddress')}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('auth.emailPlaceholder')}
                className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
              />
            </div>

            {mode === "login" && (
              <div className="space-y-4">
                <p className="text-sm text-text-muted">
                  {t('auth.loginIntro')}
                </p>
                <div className="space-y-2">
                  <label
                    className="text-sm font-semibold text-text-secondary"
                    htmlFor="password"
                  >
                    {t('auth.password')}
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('auth.passwordPlaceholder')}
                    className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                  />
                </div>
                <button
                  onClick={handleEmailLogin}
                  disabled={isLoggingIn || !email || !password}
                  className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                >
                  {isLoggingIn ? t('auth.signingIn') : t('auth.logIn')}
                </button>
              </div>
            )}

            {mode === "forgot" && (
              <div className="space-y-4">
                {!otpVerified && (
                  <>
                    {!otpSent ? (
                      <button
                        onClick={handleSendResetOtp}
                        disabled={isSendingOtp || !email}
                        className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                      >
                        {isSendingOtp ? t('auth.sendingCode') : t('auth.sendResetCode')}
                      </button>
                    ) : (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label
                            className="text-sm font-semibold text-text-secondary"
                            htmlFor="otp"
                          >
                            {t('auth.fourDigitCode')}
                          </label>
                          <input
                            id="otp"
                            type="text"
                            value={otp}
                            onChange={(e) =>
                              setOtp(
                                e.target.value
                                  .replace(/[^0-9]/g, "")
                                  .slice(0, 4),
                              )
                            }
                            placeholder={t('auth.codePlaceholder')}
                            className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                          />
                        </div>
                        <button
                          onClick={handleVerifyOtp}
                          disabled={isVerifyingOtp || otp.length !== 4}
                          className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                        >
                          {isVerifyingOtp ? t('auth.verifying') : t('auth.verifyCode')}
                        </button>
                      </div>
                    )}
                  </>
                )}

                {otpVerified && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label
                        className="text-sm font-semibold text-text-secondary"
                        htmlFor="password"
                      >
                        {t('auth.newPassword')}
                      </label>
                      <input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('auth.newPasswordPlaceholder')}
                        className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label
                        className="text-sm font-semibold text-text-secondary"
                        htmlFor="confirmPassword"
                      >
                        {t('auth.confirmNewPassword')}
                      </label>
                      <input
                        id="confirmPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={t('auth.confirmNewPasswordPlaceholder')}
                        className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                      />
                    </div>
                    <button
                      onClick={handleResetPassword}
                      disabled={isLoggingIn || !password || !confirmPassword}
                      className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                    >
                      {isLoggingIn ? t('auth.resetting') : t('auth.resetPasswordBtn')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {mode === "signup" && (
              <div className="space-y-4">
                {!otpVerified && (
                  <>
                    {!otpSent ? (
                      <button
                        onClick={handleSendOtp}
                        disabled={isSendingOtp || !email}
                        className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                      >
                        {isSendingOtp ? t('auth.sendingCode') : t('auth.sendVerificationCode')}
                      </button>
                    ) : (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label
                            className="text-sm font-semibold text-text-secondary"
                            htmlFor="otp"
                          >
                            {t('auth.fourDigitCode')}
                          </label>
                          <input
                            id="otp"
                            type="text"
                            value={otp}
                            onChange={(e) =>
                              setOtp(
                                e.target.value
                                  .replace(/[^0-9]/g, "")
                                  .slice(0, 4),
                              )
                            }
                            placeholder={t('auth.codePlaceholder')}
                            className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                          />
                        </div>
                        <button
                          onClick={handleVerifyOtp}
                          disabled={isVerifyingOtp || otp.length !== 4}
                          className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                        >
                          {isVerifyingOtp ? t('auth.verifying') : t('auth.verifyCode')}
                        </button>
                      </div>
                    )}
                  </>
                )}

                {otpVerified && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label
                        className="text-sm font-semibold text-text-secondary"
                        htmlFor="password"
                      >
                        {t('auth.password')}
                      </label>
                      <input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('auth.choosePassword')}
                        className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label
                        className="text-sm font-semibold text-text-secondary"
                        htmlFor="confirmPassword"
                      >
                        {t('auth.confirmPassword')}
                      </label>
                      <input
                        id="confirmPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={t('auth.confirmPasswordPlaceholder')}
                        className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                      />
                    </div>
                    <label className="flex items-start gap-2.5 text-xs text-text-muted cursor-pointer">
                      <input
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(e) => setAgreedToTerms(e.target.checked)}
                        className="mt-0.5 w-4 h-4 shrink-0 accent-primary"
                      />
                      <span>
                        {t('auth.agreeToPrefix')}{' '}
                        <button type="button" onClick={() => window.open('/privacy', '_blank')} className="underline text-primary font-semibold">
                          {t('auth.privacyPolicy')}
                        </button>
                        {' '}{t('auth.and')}{' '}
                        <button type="button" onClick={() => window.open('/terms', '_blank')} className="underline text-primary font-semibold">
                          {t('auth.termsOfService')}
                        </button>
                      </span>
                    </label>
                    <button
                      onClick={handleCreateAccount}
                      disabled={isLoggingIn || !password || !confirmPassword || !agreedToTerms}
                      className="w-full py-4 px-6 bg-primary text-white font-bold rounded-2xl hover:bg-primary-dark transition-all active:scale-95 shadow-sm disabled:opacity-50"
                    >
                      {isLoggingIn ? t('auth.creatingAccount') : t('auth.createAccount')}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between text-sm text-text-muted">
              {mode === "login" && (
                <>
                  <button
                    type="button"
                    onClick={() => switchMode("forgot")}
                    className="underline text-primary"
                  >
                    {t('auth.forgotPassword')}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode("signup")}
                    className="underline text-primary"
                  >
                    {t('auth.signUpInstead')}
                  </button>
                </>
              )}
              {mode === "signup" && (
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="underline text-primary"
                >
                  {t('auth.alreadyHaveAccount')}
                </button>
              )}
              {mode === "forgot" && (
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="underline text-primary"
                >
                  {t('auth.backToLogin')}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="text-xs text-text-muted space-y-1">
          <p>
            {t('auth.disclaimerContinue')}{' '}
            <button type="button" onClick={() => window.open('/privacy', '_blank')} className="underline text-primary font-semibold">
              {t('auth.privacyPolicy')}
            </button>
            {' '}{t('auth.and')}{' '}
            <button type="button" onClick={() => window.open('/terms', '_blank')} className="underline text-primary font-semibold">
              {t('auth.termsOfService')}
            </button>.
          </p>
          <p>
            {t('auth.disclaimerEmail')}
          </p>
        </div>
      </motion.div>
    </div>
  );
}
