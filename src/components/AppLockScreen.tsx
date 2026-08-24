import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BiometricAuth, BiometryError } from '@aparajita/capacitor-biometric-auth';
import { useAuth } from '../context/AuthContext';
import { getAppLockSettings, verifyPin } from '../lib/appLock';
import { clsx } from 'clsx';

// Full-screen lock overlay shown whenever the app-lock feature (Profile.tsx) is enabled —
// on cold start, and again every time the app returns from the background, matching the
// standard "banking app" unlock pattern. Native-only: app-lock is a device-security feature,
// not meaningful for the web preview build. Skipped entirely for unauthenticated sessions —
// there's nothing sensitive to protect before sign-in, and it would just double up on Login.tsx.
export default function AppLockScreen() {
  const { user } = useAuth();
  const settings = getAppLockSettings();
  const isActive = Capacitor.isNativePlatform() && !!user && settings.enabled;

  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [biometricBusy, setBiometricBusy] = useState(false);

  // Locks on cold start — but NOT via `useState(isActive)` as the initial value, because on a
  // fresh launch Firebase auth restoration is async: `user` (and therefore `isActive`) is still
  // false on the very first render, a plain `useState` initializer only ever runs once, and
  // nothing else would flip `locked` back to true once auth finishes loading a moment later. This
  // effect instead locks the instant `isActive` first becomes true, whether that's immediately
  // (session already cached) or a beat later (cold start racing auth restoration) — exactly once
  // per app session, via the ref guard, so it doesn't refight the visibility-based re-lock below.
  const lockedOnStartRef = useRef(false);
  useEffect(() => {
    if (isActive && !lockedOnStartRef.current) {
      lockedOnStartRef.current = true;
      setLocked(true);
    }
  }, [isActive]);

  // Re-lock every time the app comes back to the foreground, not just on first mount.
  useEffect(() => {
    if (!isActive) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setLocked(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [isActive]);

  const tryBiometric = React.useCallback(async () => {
    setBiometricBusy(true);
    setError(null);
    try {
      await BiometricAuth.authenticate({
        reason: 'Unlock FamilyLedger',
        cancelTitle: 'Cancel',
        androidTitle: 'Unlock FamilyLedger',
        androidSubtitle: 'Confirm your fingerprint to continue',
        allowDeviceCredential: true,
      });
      setLocked(false);
    } catch (err) {
      if (err instanceof BiometryError) {
        setError(err.message);
      } else {
        console.error('Biometric unlock failed:', err);
      }
    } finally {
      setBiometricBusy(false);
    }
  }, []);

  // Auto-prompt biometric the moment the lock screen appears, so unlocking is a single tap
  // (the OS prompt) rather than requiring an extra "Unlock" tap first every time.
  useEffect(() => {
    if (locked && settings.method === 'biometric') {
      tryBiometric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, settings.method]);

  const handlePinDigit = async (digit: string) => {
    if (pin.length >= 4) return;
    const next = pin + digit;
    setPin(next);
    setError(null);
    if (next.length === 4) {
      const ok = await verifyPin(next);
      if (ok) {
        setLocked(false);
        setPin('');
      } else {
        setError('Incorrect PIN');
        setTimeout(() => setPin(''), 400);
      }
    }
  };

  if (!isActive || !locked) return null;

  return (
    <div className="fixed inset-0 z-[400] bg-white flex flex-col items-center justify-center p-6">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
        <span className="material-symbols-outlined text-primary text-3xl">lock</span>
      </div>
      <h1 className="text-lg font-black text-primary mb-1">FamilyLedger Locked</h1>

      {settings.method === 'biometric' ? (
        <div className="flex flex-col items-center gap-4 mt-4">
          <p className="text-sm text-text-muted text-center max-w-xs">
            {error || 'Confirm your fingerprint to continue.'}
          </p>
          <button
            onClick={tryBiometric}
            disabled={biometricBusy}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-2xl font-bold disabled:opacity-50"
          >
            <span className="material-symbols-outlined">fingerprint</span>
            {biometricBusy ? 'Waiting…' : 'Unlock'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6 mt-4">
          <p className="text-sm text-text-muted">Enter your 4-digit PIN</p>
          <div className="flex gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={clsx(
                  'w-3.5 h-3.5 rounded-full border-2',
                  i < pin.length ? 'bg-primary border-primary' : 'border-border-subtle',
                )}
              />
            ))}
          </div>
          {error && <p className="text-xs font-bold text-error">{error}</p>}
          <div className="grid grid-cols-3 gap-4">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                onClick={() => handlePinDigit(d)}
                className="w-16 h-16 rounded-full bg-surface hover:bg-surface-container text-xl font-bold text-on-surface active:scale-95 transition-all"
              >
                {d}
              </button>
            ))}
            <div />
            <button
              onClick={() => handlePinDigit('0')}
              className="w-16 h-16 rounded-full bg-surface hover:bg-surface-container text-xl font-bold text-on-surface active:scale-95 transition-all"
            >
              0
            </button>
            <button
              onClick={() => setPin((p) => p.slice(0, -1))}
              className="w-16 h-16 rounded-full flex items-center justify-center text-text-muted active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined">backspace</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
