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
import { doc, setDoc } from "firebase/firestore";
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
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [resetToken, setResetToken] = React.useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = React.useState(false);
  const [isSendingOtp, setIsSendingOtp] = React.useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = React.useState(false);
  const [agreedToTerms, setAgreedToTerms] = React.useState(false);

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

    await setDoc(
      userDocRef,
      {
        displayName:
          loggedInUser.displayName ||
          loggedInUser.email?.split("@")[0] ||
          "User",
        photoURL: loggedInUser.photoURL || "",
        joinedAt: new Date().toISOString(),
        uid: loggedInUser.uid,
        email: loggedInUser.email || "",
      },
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
      if (error.code === "auth/popup-blocked") {
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
      if (
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
      if (error?.code === "auth/wrong-password") {
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
