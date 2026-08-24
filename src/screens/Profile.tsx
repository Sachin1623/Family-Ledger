import React, { useEffect, useState, useRef } from 'react';
import { getAppVersion } from '../lib/appVersion';
import { useAuth } from '../context/AuthContext';
import { auth, db, handleFirestoreError, OperationType, getAnalyticsConsent, setAnalyticsConsent } from '../lib/firebase';
import { exportMyData } from '../lib/dataExport';
import { updatePassword } from 'firebase/auth';
import { doc, updateDoc, deleteDoc, setDoc, collection, query, where, getDocs, writeBatch, arrayRemove } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { updateGlobalStats } from '../services/statsService';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { Capacitor } from '@capacitor/core';
import { BiometricAuth, BiometryError } from '@aparajita/capacitor-biometric-auth';
import { getAppLockSettings, enablePinLock, enableBiometricLock, disableAppLock } from '../lib/appLock';
import { removeCurrentDeviceToken } from '../lib/pushNotifications';
import { useLanguage, LANGUAGES, ENABLED_LANGUAGES } from '../context/LanguageContext';

// Looks up a blocked/muted uid's current display name on demand (Profile only ever stores the
// uid on the viewer's own doc — any signed-in user can read another user's basic doc, so this
// avoids denormalizing a name that could go stale if the other person renames themself).
const BlockedMutedRow: React.FC<{ uid: string; kind: 'blocked' | 'muted'; onRemove: () => void }> = ({ uid, kind, onRemove }) => {
  const [userDoc] = useDocument(doc(db, 'users', uid));
  const name = userDoc?.exists() ? (userDoc.data() as any)?.displayName || 'Unknown player' : 'Unknown player';
  return (
    <div className="p-4 flex items-center justify-between">
      <p className="text-sm font-bold text-on-surface">{name}</p>
      <button onClick={onRemove} className="text-xs font-bold text-primary">
        {kind === 'blocked' ? 'Unblock' : 'Unmute'}
      </button>
    </div>
  );
};

function NotificationToggle({
  icon,
  label,
  description,
  prefKey,
  enabled,
  updating,
  onToggle,
}: {
  icon: string;
  label: string;
  description: string;
  prefKey: string;
  enabled: boolean;
  updating: string | null;
  onToggle: (key: string, value: boolean) => void;
}) {
  return (
    <div
      onClick={() => onToggle(prefKey, enabled)}
      className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
    >
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary shrink-0">
          <span className="material-symbols-outlined">{icon}</span>
        </div>
        <div>
          <p className="font-bold text-primary text-sm">{label}</p>
          <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{description}</p>
        </div>
      </div>
      <div className={clsx(
        "w-10 h-5 rounded-full relative transition-all shrink-0",
        enabled ? 'bg-primary' : 'bg-gray-200',
        updating === prefKey && 'opacity-50'
      )}>
        <div className={clsx(
          "w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md flex items-center justify-center",
          enabled ? 'right-0.5' : 'left-0.5'
        )}>
          {updating === prefKey && (
            <div className="w-2 h-2 border border-primary border-t-transparent rounded-full animate-spin" />
          )}
        </div>
      </div>
    </div>
  );
}

// Lets a user change their analytics choice after the fact — GDPR requires consent be
// withdrawable at any time, not just decided once at the ConsentBanner's first prompt. Reads/
// writes localStorage directly via firebase.ts's getAnalyticsConsent/setAnalyticsConsent (this is
// a device-local choice, not an account preference synced through Firestore like the
// NotificationToggle prefs above, so it doesn't need `profile`/`togglePreference`).
function AnalyticsConsentToggle() {
  const [consent, setConsent] = React.useState(() => getAnalyticsConsent() === 'granted');
  return (
    <div
      onClick={() => {
        const next = !consent;
        setAnalyticsConsent(next ? 'granted' : 'denied');
        setConsent(next);
      }}
      className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
    >
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary shrink-0">
          <span className="material-symbols-outlined">analytics</span>
        </div>
        <div>
          <p className="font-bold text-primary text-sm">Analytics</p>
          <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">Help us improve the app</p>
        </div>
      </div>
      <div className={clsx('w-10 h-5 rounded-full relative transition-all shrink-0', consent ? 'bg-primary' : 'bg-gray-200')}>
        <div className={clsx('w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md', consent ? 'right-0.5' : 'left-0.5')} />
      </div>
    </div>
  );
}

// Small brand-colored badges for the "Spread the Word" share buttons, standing in for each
// platform's logo — Material Symbols (used everywhere else in this app) has no brand icons, and
// this app has no licensed brand-asset kit to pull exact vector logos from, so these are
// simplified color+mark badges (brand color + the platform's recognizable letter/glyph) rather
// than pixel-perfect reproductions.
function BrandBadge({ platform }: { platform: 'whatsapp' | 'facebook' | 'x' | 'linkedin' | 'instagram' }) {
  const base = 'w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0 text-white leading-none';
  switch (platform) {
    case 'whatsapp':
      return (
        <span className={clsx(base, 'bg-[#25D366]')}>
          <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: "'FILL' 1" }}>call</span>
        </span>
      );
    case 'facebook':
      return <span className={clsx(base, 'bg-[#1877F2] font-black text-[12px] italic')}>f</span>;
    case 'x':
      return <span className={clsx(base, 'bg-black font-black text-[10px]')}>X</span>;
    case 'linkedin':
      return <span className={clsx(base, 'bg-[#0A66C2] font-black text-[8px]')}>in</span>;
    case 'instagram':
      return (
        <span className={base} style={{ background: 'linear-gradient(45deg, #F58529, #DD2A7B, #8134AF, #515BD4)' }}>
          <span className="material-symbols-outlined text-[11px]">photo_camera</span>
        </span>
      );
  }
}

// Self-contained App Lock settings block — manages its own local state (device-local, see
// lib/appLock.ts) rather than lifting it into Profile's own state, since nothing else on this
// screen needs to know about it. Native-only: app-lock is a device-security feature with no
// meaning in the web preview build.
function AppLockSettings() {
  const [settings, setSettings] = useState(getAppLockSettings());
  const [choosingMethod, setChoosingMethod] = useState(false);
  const [pinStep, setPinStep] = useState<'enter' | 'confirm' | null>(null);
  const [firstPin, setFirstPin] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resetPinFlow = () => {
    setPinStep(null);
    setFirstPin('');
    setPinInput('');
    setError(null);
  };

  const handleToggle = () => {
    if (settings.enabled) {
      disableAppLock();
      setSettings(getAppLockSettings());
      setChoosingMethod(false);
      resetPinFlow();
    } else {
      setChoosingMethod(true);
      setError(null);
    }
  };

  const handleChooseBiometric = async () => {
    setBusy(true);
    setError(null);
    try {
      const check = await BiometricAuth.checkBiometry();
      if (!check.isAvailable) {
        setError(check.reason || 'Biometric authentication is not available on this device.');
        return;
      }
      await BiometricAuth.authenticate({
        reason: 'Confirm to enable fingerprint unlock',
        cancelTitle: 'Cancel',
        androidTitle: 'Enable fingerprint unlock',
      });
      enableBiometricLock();
      setSettings(getAppLockSettings());
      setChoosingMethod(false);
    } catch (err) {
      setError(err instanceof BiometryError ? err.message : 'Could not confirm fingerprint. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handlePinDigit = async (digit: string) => {
    if (pinInput.length >= 4) return;
    const next = pinInput + digit;
    setPinInput(next);
    setError(null);
    if (next.length < 4) return;

    if (pinStep === 'enter') {
      setFirstPin(next);
      setPinInput('');
      setPinStep('confirm');
      return;
    }

    // Confirm step
    if (next === firstPin) {
      await enablePinLock(next);
      setSettings(getAppLockSettings());
      setChoosingMethod(false);
      resetPinFlow();
    } else {
      setError("PINs didn't match — try again.");
      setTimeout(() => {
        setPinInput('');
        setFirstPin('');
        setPinStep('enter');
      }, 500);
    }
  };

  if (!Capacitor.isNativePlatform()) return null;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined">lock</span>
          </div>
          <div>
            <p className="font-bold text-primary text-sm">App Lock</p>
            <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">
              {settings.enabled ? `Enabled — ${settings.method === 'biometric' ? 'Fingerprint' : '4-digit PIN'}` : 'Require unlock to open the app'}
            </p>
          </div>
        </div>
        <div
          onClick={handleToggle}
          className={clsx('w-10 h-5 rounded-full relative transition-all shrink-0 cursor-pointer', settings.enabled ? 'bg-primary' : 'bg-gray-200')}
        >
          <div className={clsx('w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md', settings.enabled ? 'right-0.5' : 'left-0.5')} />
        </div>
      </div>

      {choosingMethod && !settings.enabled && (
        <div className="space-y-3 pt-2 border-t border-border-subtle">
          {!pinStep ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleChooseBiometric}
                disabled={busy}
                className="flex-1 flex flex-col items-center gap-1 py-3 rounded-xl border border-border-subtle bg-surface hover:bg-surface-container disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-primary">fingerprint</span>
                <span className="text-xs font-bold text-primary">Fingerprint</span>
              </button>
              <button
                type="button"
                onClick={() => { setPinStep('enter'); setError(null); }}
                className="flex-1 flex flex-col items-center gap-1 py-3 rounded-xl border border-border-subtle bg-surface hover:bg-surface-container"
              >
                <span className="material-symbols-outlined text-primary">pin</span>
                <span className="text-xs font-bold text-primary">4-digit PIN</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs font-bold text-text-muted">
                {pinStep === 'enter' ? 'Choose a 4-digit PIN' : 'Confirm your PIN'}
              </p>
              <div className="flex gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className={clsx('w-3 h-3 rounded-full border-2', i < pinInput.length ? 'bg-primary border-primary' : 'border-border-subtle')} />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => handlePinDigit(d)}
                    className="w-12 h-12 rounded-full bg-surface hover:bg-surface-container text-sm font-bold text-on-surface active:scale-95 transition-all"
                  >
                    {d}
                  </button>
                ))}
                <div />
                <button
                  type="button"
                  onClick={() => handlePinDigit('0')}
                  className="w-12 h-12 rounded-full bg-surface hover:bg-surface-container text-sm font-bold text-on-surface active:scale-95 transition-all"
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={() => setPinInput((p) => p.slice(0, -1))}
                  className="w-12 h-12 rounded-full flex items-center justify-center text-text-muted active:scale-95 transition-all"
                >
                  <span className="material-symbols-outlined text-[18px]">backspace</span>
                </button>
              </div>
            </div>
          )}
          {error && <p className="text-xs font-bold text-error text-center">{error}</p>}
          <button
            type="button"
            onClick={() => { setChoosingMethod(false); resetPinFlow(); }}
            className="w-full text-center text-[11px] font-bold text-text-muted hover:text-primary"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Requesting Shopkeeper access is a plain Firestore write to the user's own
// shopkeeperRequests/{uid} doc (firestore.rules forces status to 'pending' on any client
// write — approval only ever happens server-side, see server.ts's admin endpoints), followed by
// a fire-and-forget call to notify admins. Once approved, `profile.shopId` is what actually
// grants access (checked here just to show status/hide the button — the real gate is
// server-side and in firestore.rules, not this UI).
function ShopkeeperAccessSection() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [requestDoc] = useDocument(user ? doc(db, 'shopkeeperRequests', user.uid) : null);
  const request = requestDoc?.data() as { status?: string } | undefined;
  const [submitting, setSubmitting] = useState(false);

  if (profile?.shopId) {
    return (
      <div className="p-4 flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] shrink-0">
          <span className="material-symbols-outlined">storefront</span>
        </div>
        <div>
          <p className="font-bold text-primary text-sm">{t('profile.shopkeeperAccessEnabled')}</p>
          <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">
            {t('profile.switchViewsAnytime')}
          </p>
        </div>
      </div>
    );
  }

  const handleRequest = async () => {
    if (!user || submitting) return;
    setSubmitting(true);
    try {
      await setDoc(doc(db, 'shopkeeperRequests', user.uid), {
        userId: user.uid,
        userName: profile?.displayName || user.displayName || 'Someone',
        userEmail: user.email || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      const idToken = await user.getIdToken();
      fetch('/api/notify-shopkeeper-request', { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } }).catch((err) =>
        console.error('notify-shopkeeper-request failed:', err),
      );
    } catch (err) {
      console.error('Failed to submit shopkeeper request:', err);
      alert('Failed to submit request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 flex items-center gap-4">
      <div className="w-10 h-10 rounded-xl bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] shrink-0">
        <span className="material-symbols-outlined">storefront</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-primary text-sm">Shopkeeper mode</p>
        <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">
          {request?.status === 'pending' ? 'Request pending admin approval' : request?.status === 'rejected' ? 'Previous request declined' : 'Sell, track customers & reports'}
        </p>
      </div>
      {request?.status !== 'pending' && (
        <button
          onClick={handleRequest}
          disabled={submitting}
          className="px-4 py-2 bg-[#7C3AED] text-white rounded-xl text-xs font-bold disabled:opacity-50 shrink-0"
        >
          {submitting ? 'Sending…' : request?.status === 'rejected' ? 'Re-request' : 'Request Access'}
        </button>
      )}
    </div>
  );
}

export default function Profile() {
  const { user, profile, admin } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [updating, setUpdating] = useState<string | null>(null);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [exportingData, setExportingData] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExportData = async () => {
    if (!user || exportingData) return;
    setExportingData(true);
    setExportError(null);
    try {
      await exportMyData(user.uid);
    } catch (err) {
      console.error('Data export failed:', err);
      setExportError('Failed to export your data. Please try again.');
    } finally {
      setExportingData(false);
    }
  };
  // Weekly "add your birthday?" push (see processDobReminders in server.ts) deep-links here as
  // `?promptDob=1` — reacts to the param itself, not a mount-only effect, since this screen can
  // already be mounted (React Router reuses the instance for a same-pattern navigation) when the
  // notification is tapped, same pattern as Dashboard's `?dm=`/`?chat=1` handling.
  const promptDob = searchParams.get('promptDob') === '1';
  const [dobInput, setDobInput] = useState('');
  const [dobSeeded, setDobSeeded] = useState(false);
  const [savingDob, setSavingDob] = useState(false);
  useEffect(() => {
    if (!dobSeeded && profile && profile.dateOfBirth !== undefined) {
      setDobInput(profile.dateOfBirth || '');
      setDobSeeded(true);
    }
  }, [profile, dobSeeded]);

  const clearPromptDob = () => {
    if (!searchParams.get('promptDob')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('promptDob');
    setSearchParams(next, { replace: true });
  };

  const handleSaveDob = async () => {
    if (!user || !dobInput || savingDob) return;
    setSavingDob(true);
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        dateOfBirth: dobInput,
        updatedAt: new Date().toISOString(),
      });
      clearPromptDob();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}/private/info`);
    } finally {
      setSavingDob(false);
    }
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [acceptedDeletion, setAcceptedDeletion] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState('');

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [appVersion, setAppVersion] = useState<{ versionName: string; build: string } | null>(null);

  useEffect(() => {
    getAppVersion().then(setAppVersion);
  }, []);

  const isPasswordUser = user?.providerData.some(p => p.providerId === 'password');

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword.length < 6) {
      setPasswordError('Password should be at least 6 characters long.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    setIsChangingPassword(true);
    try {
      await updatePassword(user, newPassword);
      setPasswordSuccess('Password was successfully changed!');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        setShowChangePassword(false);
        setPasswordSuccess(null);
      }, 3000);
    } catch (error: any) {
      console.error('Password change error:', error);
      if (error?.code === 'auth/requires-recent-login') {
        setPasswordError('For security reasons, this action requires a recent sign in. Please log out and sign back in before modifying your credentials.');
      } else {
        setPasswordError(error?.message || 'Failed to update password. Please check your connection.');
      }
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleLogout = async () => {
    if (user) await removeCurrentDeviceToken(user);
    await auth.signOut();
    navigate('/login');
  };

  // Manual trigger for the weekly recap (games/expenses/groups/chat stats) — normally generated
  // automatically by a Cloud Scheduler job, but that job isn't registered yet while this feature
  // is still being tried out, so this button computes+delivers (feed entry + push) the caller's
  // OWN recap on demand via /api/weekly-summary/generate-mine, then opens it.
  const handleGenerateRecap = async () => {
    if (!user || generatingRecap) return;
    setGeneratingRecap(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/weekly-summary/generate-mine', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to generate recap.');
      navigate('/weekly-summary');
    } catch (err: any) {
      console.error('Failed to generate weekly recap:', err);
      alert(err.message || 'Failed to generate your weekly recap.');
    } finally {
      setGeneratingRecap(false);
    }
  };

  // Personal promo message + a 5-image feature carousel for the "Spread the Word" share
  // feature. `shareUrl` is the Play Store listing directly (per explicit request — an earlier
  // version pointed at the backend's /share landing page instead, which carried custom Open
  // Graph tags for a nicer Facebook/LinkedIn preview card; that richer preview is traded away
  // here in favor of sending people straight to the real install page).
  //
  // None of Facebook/LinkedIn/Twitter's web share intents can accept pre-attached images or
  // custom captions from an arbitrary external caller — that's a real platform restriction, not
  // something fixable with a different URL param. The only way to actually get multiple images
  // into a post on any of these apps from a web page is the Web Share API's `files` support
  // (Level 2): it hands real image files to the OS share sheet, and whichever app the user picks
  // (Instagram, Twitter, LinkedIn, WhatsApp, Gallery, ...) receives them exactly like a native
  // "share from Photos" — full images, not a link preview. "native" and "instagram" both use
  // this (feature-detected via canShare, since not every browser/WebView supports file sharing;
  // falls back to text+link share, then to clipboard). "whatsapp"/"twitter" carry the caption
  // text reliably via their own official intents (no images, but at least the words are right).
  // "facebook"/"linkedin" pull whatever preview card Google Play's own listing page provides.
  const handleShareApp = (target: 'native' | 'whatsapp' | 'facebook' | 'twitter' | 'linkedin' | 'instagram') => {
    const shareUrl = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
    const message = `💰 Tired of chasing who-owes-who? I'm using FamilyLedger to split expenses, track recurring bills, and stick to a budget with my family — all in one app! 🙌\n\n✅ Split bills equally, by %, or exact amounts\n🔄 Never forget a recurring bill\n📊 Budgets, smart reminders & to-do/shopping lists\n\nGive it a try 👇\n${shareUrl}`;

    if (target === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
      return;
    }
    if (target === 'facebook') {
      window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`, '_blank');
      return;
    }
    if (target === 'twitter') {
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`, '_blank');
      return;
    }
    if (target === 'linkedin') {
      window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`, '_blank');
      return;
    }

    // "native" and "instagram" both want the image carousel via the OS share sheet.
    shareCarousel(message, shareUrl);
  };

  const CAROUSEL_IMAGES = [
    'slide-1-hero.png',
    'slide-2-splitting.png',
    'slide-3-recurring-budgets.png',
    'slide-4-reminders.png',
    'slide-5-cta.png',
  ];

  const shareCarousel = async (message: string, shareUrl: string) => {
    try {
      const nav = navigator as any;
      const files = await Promise.all(
        CAROUSEL_IMAGES.map(async (name) => {
          const res = await fetch(`/${name}`);
          const blob = await res.blob();
          return new File([blob], name, { type: 'image/png' });
        }),
      );
      if (nav.share && nav.canShare?.({ files })) {
        await nav.share({ title: 'FamilyLedger', text: message, files });
        return;
      }
      if (nav.share) {
        await nav.share({ title: 'FamilyLedger', text: message, url: shareUrl });
        return;
      }
      throw new Error('navigator.share unavailable');
    } catch (err) {
      if ((err as any)?.name === 'AbortError') return; // user cancelled the share sheet
      console.error('shareCarousel failed:', err);
      navigator.clipboard.writeText(message).catch(() => {});
      alert('Share message copied! (Image sharing is not supported on this device/browser.)');
    }
  };

  const resizeImage = (file: File, maxWidth = 600, maxHeight = 600): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxWidth) {
              height *= maxWidth / width;
              width = maxWidth;
            }
          } else {
            if (height > maxHeight) {
              width *= maxHeight / height;
              height = maxHeight;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
      };
    });
  };

  const updateMemberships = async (updates: { displayName?: string, photoURL?: string }) => {
    if (!user) return;
    try {
      const q = query(collection(db, 'members'), where('userId', '==', user.uid));
      const snapshot = await getDocs(q);
      const batch = writeBatch(db);
      snapshot.forEach((doc) => {
        batch.update(doc.ref, updates);
      });
      await batch.commit();
    } catch (error) {
      console.error('Error updating memberships:', error);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setUpdating('photoURL');
    try {
      const resizedBase64 = await resizeImage(file);
      const path = `users/${user.uid}`;
      
      await updateDoc(doc(db, 'users', user.uid), {
        photoURL: resizedBase64
      });
      // Also update all shared memberships
      await updateMemberships({ photoURL: resizedBase64 });
    } catch (error) {
      console.error('Error uploading profile photo:', error);
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    } finally {
      setUpdating(null);
    }
  };

  const handleSaveName = async () => {
    if (!user || !newName.trim() || updating) return;
    setUpdating('displayName');
    const path = `users/${user.uid}`;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        displayName: newName.trim()
      });
      // Also update all shared memberships
      await updateMemberships({ displayName: newName.trim() });
      setIsEditingName(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    } finally {
      setUpdating(null);
    }
  };

  const togglePreference = async (key: string, value: boolean) => {
    if (!user || updating) return;
    setUpdating(key);
    const path = `users/${user.uid}/private/info`;
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        [key]: !value,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    } finally {
      setUpdating(null);
    }
  };

  // Blocking/muting a game-chat sender is initiated from inside the chat itself (see
  // GameChat.tsx) and writes straight to `users/{uid}`; unblocking/unmuting lives here since
  // that's the natural place to review and manage the list later.
  const handleUnblockUser = async (uid: string) => {
    if (!user) return;
    await updateDoc(doc(db, 'users', user.uid), { blockedUsers: arrayRemove(uid) }).catch((err) =>
      handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}`),
    );
  };

  const handleUnmuteUser = async (uid: string) => {
    if (!user) return;
    await updateDoc(doc(db, 'users', user.uid), { mutedUsers: arrayRemove(uid) }).catch((err) =>
      handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}`),
    );
  };

  const handleDeleteAccount = async () => {
    if (!user || !acceptedDeletion) return;
    setIsDeleting(true);
    const path = `users/${user.uid}`;
    try {
      // 1. Transfer ownership of groups if user is owner
      const membersQuery = query(collection(db, 'members'), where('userId', '==', user.uid));
      const memberships = await getDocs(membersQuery);
      
      const batch = writeBatch(db);
      
      for (const memberDoc of memberships.docs) {
        const memberData = memberDoc.data();
        
        if (memberData.role === 'owner') {
          // Find other members in this group to transfer ownership to
          const othersQuery = query(
            collection(db, 'members'), 
            where('groupId', '==', memberData.groupId),
            where('userId', '!=', user.uid)
          );
          const others = await getDocs(othersQuery);
          
          if (!others.empty) {
            // Randomly select one of the other members
            const randomIndex = Math.floor(Math.random() * others.docs.length);
            const newOwnerDoc = others.docs[randomIndex];
            batch.update(newOwnerDoc.ref, { role: 'owner' });
          }
        }
        
        // Remove user from the group membership
        batch.delete(memberDoc.ref);
      }
      
      // 2. Leave a tombstone so re-registering with this email within 30 days can
      //    automatically recover this account's data (see /api/merge-account).
      batch.set(doc(db, 'accountDeletions', user.uid), {
        email: (user.email || '').trim().toLowerCase(),
        deletedAt: new Date().toISOString(),
      });

      // 3. Delete user private profile
      batch.delete(doc(db, 'users', user.uid, 'private', 'info'));

      // 4. Delete user public profile
      batch.delete(doc(db, 'users', user.uid));
      
      await batch.commit();

      // Decrement global user count
      await updateGlobalStats({ users: -1 });

      // 5. Try to delete the Auth account
      // Note: This may fail if the user hasn't logged in recently (auth/requires-recent-login)
      try {
        await user.delete();
        navigate('/login');
      } catch (authError: any) {
        if (authError.code === 'auth/requires-recent-login') {
          // If re-authentication is needed, we log them out and they can try again after logging in
          alert('For security reasons, you must have logged in recently to delete your account. Please log in again and click delete.');
          await auth.signOut();
          navigate('/login');
        } else {
          throw authError;
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 pb-24 max-w-2xl mx-auto w-full space-y-8 pt-8">
        <section className="flex flex-col items-center">
          <div className="relative mb-4 group">
            <div className="w-28 h-28 rounded-full overflow-hidden border-4 border-white shadow-xl relative">
              <img 
                src={profile?.photoURL || user?.photoURL || `https://ui-avatars.com/api/?name=${profile?.displayName || 'User'}`} 
                className={clsx("w-full h-full object-cover transition-opacity", updating === 'photoURL' && "opacity-50")} 
                alt="Avatar" 
              />
              {updating === 'photoURL' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/10">
                  <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <label 
              className={clsx(
                "absolute bottom-0 right-1 bg-primary text-white p-2 rounded-full shadow-lg border-2 border-white active:scale-90 transition-transform cursor-pointer",
                updating === 'photoURL' && "opacity-50 pointer-events-none"
              )}
            >
              <span className="material-symbols-outlined text-lg">edit</span>
              <input 
                type="file" 
                onChange={handleFileChange} 
                accept="image/*" 
                className="hidden" 
                disabled={updating === 'photoURL'}
              />
            </label>
          </div>
          
          {isEditingName ? (
            <div className="flex flex-col items-center gap-2">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                className="text-center text-2xl font-bold text-primary bg-transparent border-b-2 border-primary focus:outline-none px-2 py-1"
                placeholder="Your Name"
              />
              <div className="flex gap-2">
                <button 
                  onClick={() => setIsEditingName(false)}
                  className="text-xs font-bold text-text-muted hover:text-primary transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleSaveName}
                  disabled={updating === 'displayName'}
                  className="text-xs font-bold text-primary flex items-center gap-1"
                >
                  {updating === 'displayName' && <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <h2 className="text-2xl font-bold text-primary flex items-center gap-2">
                {profile?.displayName || user?.displayName}
                <button
                  onClick={() => {
                    setNewName(profile?.displayName || user?.displayName || '');
                    setIsEditingName(true);
                  }}
                  className="text-text-muted hover:text-primary transition-colors"
                  title="Change display name"
                >
                  <span className="material-symbols-outlined text-base">edit</span>
                </button>
              </h2>
              <p className="text-sm text-text-muted font-medium">{profile?.email || user?.email}</p>
              {profile?.shortId && (
                <button
                  onClick={() => navigator.clipboard?.writeText(profile.shortId)}
                  title="Copy your ID — share it so others can find you when inviting to a group"
                  className="mt-1 flex items-center gap-1 text-[11px] font-bold text-primary bg-primary/5 px-2.5 py-1 rounded-full active:scale-95 transition-all"
                >
                  ID: {profile.shortId}
                  <span className="material-symbols-outlined text-[13px]">content_copy</span>
                </button>
              )}
            </div>
          )}
        </section>

        <section className="space-y-1">
          <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">Birthday</h3>
          <div
            className={clsx(
              'bg-white rounded-2xl border shadow-sm p-4 space-y-3 transition-colors',
              promptDob ? 'border-primary ring-2 ring-primary/20' : 'border-border-subtle',
            )}
          >
            {promptDob && !profile?.dateOfBirth && (
              <p className="text-xs font-bold text-primary">
                Add your birthday so we — and your groups, if you want — can celebrate it with you! 🎂
              </p>
            )}
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dobInput}
                onChange={(e) => setDobInput(e.target.value)}
                max={new Date().toISOString().split('T')[0]}
                className="flex-1 h-11 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-medium outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                onClick={handleSaveDob}
                disabled={!dobInput || dobInput === (profile?.dateOfBirth || '') || savingDob}
                className="px-4 h-11 bg-primary text-white font-bold rounded-xl text-sm disabled:opacity-40 shrink-0"
              >
                {savingDob ? 'Saving…' : 'Save'}
              </button>
            </div>
            {!profile?.dateOfBirth && (
              <div className="pt-1 border-t border-border-subtle -mx-4 px-4 pt-3">
                <div
                  onClick={() => togglePreference('dobReminderEnabled', profile?.dobReminderEnabled !== false)}
                  className="flex items-center justify-between cursor-pointer group"
                >
                  <div className="min-w-0 pr-3">
                    <p className="font-bold text-primary text-sm">{t('profile.weeklyReminderToAdd')}</p>
                    <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">
                      {profile?.dobReminderEnabled !== false ? t('profile.dobReminderOn') : t('profile.dobReminderOff')}
                    </p>
                  </div>
                  <div
                    className={clsx(
                      'w-10 h-5 rounded-full relative transition-all shrink-0',
                      profile?.dobReminderEnabled !== false ? 'bg-primary' : 'bg-gray-200',
                      updating === 'dobReminderEnabled' && 'opacity-50',
                    )}
                  >
                    <div
                      className={clsx(
                        'w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md',
                        profile?.dobReminderEnabled !== false ? 'right-0.5' : 'left-0.5',
                      )}
                    />
                  </div>
                </div>
              </div>
            )}
            {profile?.dateOfBirth && (
              <div className="pt-1 border-t border-border-subtle -mx-4 px-4 pt-3">
                <div
                  onClick={() => togglePreference('shareBirthdayWithFriends', profile?.shareBirthdayWithFriends !== false)}
                  className="flex items-center justify-between cursor-pointer group"
                >
                  <div className="min-w-0 pr-3">
                    <p className="font-bold text-primary text-sm">Share with my groups</p>
                    <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">
                      Members of your groups get a heads-up to wish you well
                    </p>
                  </div>
                  <div
                    className={clsx(
                      'w-10 h-5 rounded-full relative transition-all shrink-0',
                      profile?.shareBirthdayWithFriends !== false ? 'bg-primary' : 'bg-gray-200',
                      updating === 'shareBirthdayWithFriends' && 'opacity-50',
                    )}
                  >
                    <div
                      className={clsx(
                        'w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-md',
                        profile?.shareBirthdayWithFriends !== false ? 'right-0.5' : 'left-0.5',
                      )}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-6">
          <div className="space-y-1">
            <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">{t('profile.preferences')}</h3>
            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden divide-y divide-border-subtle">
              <div>
                <button
                  type="button"
                  onClick={() => setShowLanguagePicker((v) => !v)}
                  className="w-full p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                      <span className="material-symbols-outlined">language</span>
                    </div>
                    <div className="text-left">
                      <p className="font-bold text-sm text-on-surface">{t('profile.language')}</p>
                      <p className="text-xs text-text-muted">{t('profile.chooseLanguage')}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-text-muted shrink-0">
                    <span className="text-sm font-bold text-primary">
                      {LANGUAGES.find((l) => l.code === language)?.nativeLabel}
                    </span>
                    <span className="material-symbols-outlined text-[20px]">
                      {showLanguagePicker ? 'expand_less' : 'expand_more'}
                    </span>
                  </div>
                </button>
                <AnimatePresence>
                  {showLanguagePicker && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden bg-surface/50"
                    >
                      <div className="p-2 grid grid-cols-2 gap-1.5">
                        {ENABLED_LANGUAGES.map((l) => (
                          <button
                            key={l.code}
                            type="button"
                            onClick={() => {
                              setLanguage(l.code);
                              setShowLanguagePicker(false);
                            }}
                            className={clsx(
                              'px-3 py-2.5 rounded-xl text-left text-sm font-bold transition-all border',
                              l.code === language
                                ? 'bg-primary text-white border-primary'
                                : 'bg-white text-on-surface border-border-subtle hover:bg-surface-container',
                            )}
                          >
                            {l.nativeLabel}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <NotificationToggle
                icon="notifications"
                label={t('profile.groupActivityAlerts')}
                description={t('profile.groupActivityAlertsDesc')}
                prefKey="notificationsEnabled"
                enabled={profile?.notificationsEnabled !== false}
                updating={updating}
                onToggle={togglePreference}
              />
              <NotificationToggle
                icon="edit_calendar"
                label={t('profile.spendReminders')}
                description={t('profile.spendRemindersDesc')}
                prefKey="spendReminderEnabled"
                enabled={profile?.spendReminderEnabled !== false}
                updating={updating}
                onToggle={togglePreference}
              />
              <NotificationToggle
                icon="waving_hand"
                label={t('profile.comeBackReminders')}
                description={t('profile.comeBackRemindersDesc')}
                prefKey="inactivityReminderEnabled"
                enabled={profile?.inactivityReminderEnabled !== false}
                updating={updating}
                onToggle={togglePreference}
              />
              <div
                onClick={() => navigate('/friends')}
                className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">group</span>
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm">{t('tools.friends')}</p>
                    <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('tools.friendsDesc')}</p>
                  </div>
                </div>
                <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
              </div>
              <div
                onClick={() => navigate('/about')}
                className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">info</span>
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm">{t('profile.aboutFamilyLedger')}</p>
                    <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('profile.featuresVersionInfo')}</p>
                  </div>
                </div>
                <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
              </div>
              <div
                onClick={() => navigate('/?tour=dashboard')}
                className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">school</span>
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm">{t('profile.replayAppTour')}</p>
                    <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('profile.replayAppTourDesc')}</p>
                  </div>
                </div>
                <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
              </div>
              <div
                onClick={() => navigate('/feedback')}
                className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                    <span className="material-symbols-outlined">forum</span>
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm">{t('profile.feedbackSupport')}</p>
                    <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('profile.feedbackSupportDesc')}</p>
                  </div>
                </div>
                <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
              </div>
            </div>
          </div>
        </section>

        {((profile?.blockedUsers?.length || 0) > 0 || (profile?.mutedUsers?.length || 0) > 0) && (
          <section className="space-y-1">
            <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">Blocked &amp; Muted Players</h3>
            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden divide-y divide-border-subtle">
              {(profile?.blockedUsers || []).map((uid: string) => (
                <BlockedMutedRow key={`b-${uid}`} uid={uid} kind="blocked" onRemove={() => handleUnblockUser(uid)} />
              ))}
              {(profile?.mutedUsers || []).map((uid: string) => (
                <BlockedMutedRow key={`m-${uid}`} uid={uid} kind="muted" onRemove={() => handleUnmuteUser(uid)} />
              ))}
            </div>
            <p className="px-2 text-[11px] text-text-muted">Applies to game chat, across every game.</p>
          </section>
        )}

        <section className="space-y-1">
          <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">{t('profile.weeklyRecap')}</h3>
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-3">
            <p className="text-xs text-text-muted">
              {t('profile.weeklyRecapDesc')}
            </p>
            <button
              onClick={handleGenerateRecap}
              disabled={generatingRecap}
              className="w-full bg-primary text-white py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">insights</span>
              {generatingRecap ? t('profile.generatingRecap') : t('profile.generateRecap')}
            </button>
            <button
              onClick={() => navigate('/weekly-summary')}
              className="w-full text-primary py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">history</span>
              {t('profile.viewPastRecaps')}
            </button>
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">{t('profile.spreadTheWord')}</h3>
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-3">
            <p className="text-xs text-text-muted">
              {t('profile.knowSomeone')}
            </p>
            <button
              onClick={() => handleShareApp('native')}
              className="w-full bg-primary text-white py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm"
            >
              <span className="material-symbols-outlined text-[18px]">{typeof navigator !== 'undefined' && (navigator as any).share ? 'share' : 'content_copy'}</span>
              <span>{typeof navigator !== 'undefined' && (navigator as any).share ? t('profile.shareFamilyLedger') : t('profile.copyShareMessage')}</span>
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => handleShareApp('whatsapp')}
                className="flex-1 bg-[#25D366]/10 text-[#128C4A] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#25D366]/20 active:scale-[0.98] transition-all border border-[#25D366]/20"
              >
                <BrandBadge platform="whatsapp" />
                WhatsApp
              </button>
              <button
                onClick={() => handleShareApp('facebook')}
                className="flex-1 bg-[#1877F2]/10 text-[#1877F2] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#1877F2]/20 active:scale-[0.98] transition-all border border-[#1877F2]/20"
              >
                <BrandBadge platform="facebook" />
                Facebook
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleShareApp('instagram')}
                className="flex-1 bg-[#E1306C]/10 text-[#C13584] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#E1306C]/20 active:scale-[0.98] transition-all border border-[#E1306C]/20"
              >
                <BrandBadge platform="instagram" />
                Instagram
              </button>
              <button
                onClick={() => handleShareApp('twitter')}
                className="flex-1 bg-[#0F1419]/10 text-[#0F1419] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#0F1419]/20 active:scale-[0.98] transition-all border border-[#0F1419]/20"
              >
                <BrandBadge platform="x" />
                X
              </button>
              <button
                onClick={() => handleShareApp('linkedin')}
                className="flex-1 bg-[#0A66C2]/10 text-[#0A66C2] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#0A66C2]/20 active:scale-[0.98] transition-all border border-[#0A66C2]/20"
              >
                <BrandBadge platform="linkedin" />
                LinkedIn
              </button>
            </div>
            <p className="text-[10px] text-text-muted">
              {t('profile.forAnyOtherApp')}
            </p>
          </div>
        </section>

        {Capacitor.isNativePlatform() && (
          <section className="space-y-1">
            <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">App Lock</h3>
            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <AppLockSettings />
            </div>
          </section>
        )}

        <section className="space-y-1">
          <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">Privacy</h3>
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
            <AnalyticsConsentToggle />
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">{t('profile.business')}</h3>
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
            <ShopkeeperAccessSection />
          </div>
        </section>

        {isPasswordUser && (
          <section className="space-y-6">
            <div className="space-y-1">
              <h3 className="px-2 text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">{t('profile.security')}</h3>
              <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden p-4 space-y-4">
                <div
                  onClick={() => {
                    setShowChangePassword(!showChangePassword);
                    setPasswordError(null);
                    setPasswordSuccess(null);
                  }}
                  className="flex items-center justify-between cursor-pointer group"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary">
                      <span className="material-symbols-outlined">lock</span>
                    </div>
                    <div>
                      <p className="font-bold text-primary text-sm">{t('profile.changeAccountPassword')}</p>
                      <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('profile.updateSecurityCredentials')}</p>
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-text-muted transition-transform duration-200">
                    {showChangePassword ? 'expand_less' : 'expand_more'}
                  </span>
                </div>

                <AnimatePresence>
                  {showChangePassword && (
                    <motion.form 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      onSubmit={handleChangePassword}
                      className="space-y-4 pt-2 border-t border-border-subtle overflow-hidden"
                    >
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-on-surface/80">New Password</label>
                        <input
                          type="password"
                          required
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="At least 6 characters"
                          className="w-full h-11 px-4 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium text-sm bg-surface-container"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-on-surface/80">Confirm New Password</label>
                        <input
                          type="password"
                          required
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Re-enter new password"
                          className="w-full h-11 px-4 rounded-xl border border-border-subtle focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium text-sm bg-surface-container"
                        />
                      </div>

                      {passwordError && (
                        <div className="p-3 bg-red-50 text-red-800 border border-red-200 rounded-xl text-xs font-medium leading-relaxed font-sans">
                          {passwordError}
                        </div>
                      )}

                      {passwordSuccess && (
                        <div className="p-3 bg-green-50 text-green-800 border border-green-200 rounded-xl text-xs font-medium leading-relaxed font-sans">
                          {passwordSuccess}
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={isChangingPassword}
                        className="w-full h-11 bg-primary hover:bg-primary-hover text-white font-bold rounded-xl transition-all active:scale-[0.98] shadow-sm flex items-center justify-center gap-2"
                      >
                        {isChangingPassword ? (
                          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                          'Update Password'
                        )}
                      </button>
                    </motion.form>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </section>
        )}

        {admin.isAdmin && (
          <button
            onClick={() => navigate('/admin')}
            className="w-full flex items-center justify-center gap-2 py-5 bg-primary text-white font-bold rounded-2xl active:scale-[0.98] transition-all mt-8 shadow-sm"
          >
            <span className="material-symbols-outlined">admin_panel_settings</span>
            Admin Panel
          </button>
        )}

        <button
          onClick={handleLogout}
          className={clsx(
            "w-full flex items-center justify-center gap-2 py-5 border-2 border-border-subtle text-primary font-bold rounded-2xl hover:bg-surface-container/20 active:scale-[0.98] transition-all shadow-sm",
            admin.isAdmin ? "mt-3" : "mt-8"
          )}
        >
          <span className="material-symbols-outlined">logout</span>
          {t('profile.logout')}
        </button>
        
        <div className="flex flex-col items-center text-center gap-3 pt-4 pb-8">
          <p className="text-[10px] text-text-muted font-bold uppercase tracking-[0.1em] opacity-50">
            {appVersion ? `Version ${appVersion.versionName} (Build ${appVersion.build})` : 'FamilyLedger'}
          </p>

          <button
            onClick={handleExportData}
            disabled={exportingData}
            className="block text-[11px] font-bold text-primary/70 hover:text-primary hover:underline transition-colors uppercase tracking-widest disabled:opacity-50"
          >
            {exportingData ? 'Preparing your data…' : 'Download My Data'}
          </button>
          {exportError && <p className="text-[10px] font-bold text-error">{exportError}</p>}

          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="text-[11px] font-bold text-error/60 hover:text-error hover:underline transition-colors uppercase tracking-widest"
          >
            {t('profile.deleteAccountData')}
          </button>
        </div>
      </main>

      <AnimatePresence>
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isDeleting && setShowDeleteConfirm(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto"
            >
              <div className="w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-3xl">warning</span>
              </div>
              
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-primary">Delete your data?</h3>
                <p className="text-sm text-text-secondary leading-relaxed">
                  This will permanently delete your account, your profile, and all your personal financial records. This action cannot be undone.
                </p>
              </div>

              <div className="flex items-start gap-3 p-4 bg-error/5 rounded-2xl border border-error/10">
                <div className="pt-0.5">
                  <input 
                    type="checkbox" 
                    id="accept-deletion"
                    checked={acceptedDeletion}
                    onChange={(e) => setAcceptedDeletion(e.target.checked)}
                    className="w-4 h-4 rounded border-border-subtle text-error focus:ring-error cursor-pointer"
                  />
                </div>
                <label htmlFor="accept-deletion" className="text-xs text-error font-medium leading-tight cursor-pointer">
                  I understand that this will permanently erase all my data and cannot be recovered.
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button 
                  disabled={isDeleting}
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setAcceptedDeletion(false);
                  }}
                  className="py-3 px-4 rounded-xl font-bold text-primary bg-surface border border-border-subtle hover:bg-white transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button 
                  disabled={isDeleting || !acceptedDeletion}
                  onClick={handleDeleteAccount}
                  className="py-3 px-4 rounded-xl font-bold text-white bg-error hover:bg-error/90 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isDeleting ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    'Confirm Delete'
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
