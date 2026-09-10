import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useLanguage } from '../context/LanguageContext';
import {
  getRingingAlarm,
  dismissRingingAlarm,
  snoozeRingingAlarm,
  onRingingAlarmChange,
  type RingingAlarmState,
} from '../lib/alarmClock';

// A whole-app-lifetime supplement to the native full-screen AlarmActivity: for the entire time a
// takeover alarm is actually ringing (its foreground service is up), this shows Snooze / Dismiss
// controls INSIDE the app too. So a user who's already in the app when it fires — or who swiped
// the native screen away and came back — can silence or snooze it without hunting for the
// notification. Android-only in practice; every alarmClock.ts helper it calls no-ops on web/iOS,
// so getRingingAlarm() just always returns { ringing: false } there and this renders nothing.
export default function GlobalAlarmRingingBanner() {
  const { t } = useLanguage();
  const [state, setState] = useState<RingingAlarmState>({ ringing: false });
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    // Android-only surface; nothing to watch on web/iOS.
    if (!(Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android')) return;
    let cancelled = false;
    const refresh = async () => {
      const s = await getRingingAlarm();
      if (!cancelled) setState(s);
    };

    refresh();

    // Live push from the native service (start / stop).
    const unsubscribe = onRingingAlarmChange(
      (s) => { if (!cancelled) setState(s); },
      () => { if (!cancelled) setState({ ringing: false }); },
    );

    // Safety net: the events above can be missed when the alarm started or stopped while the
    // webview wasn't attached (fired with the app killed, or dismissed from the native screen).
    // Re-query whenever the app comes back to the foreground, plus a slow poll while mounted.
    const appStateP = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) refresh();
    });
    pollRef.current = window.setInterval(refresh, 4000);

    return () => {
      cancelled = true;
      unsubscribe();
      appStateP.then((h) => h.remove()).catch(() => {});
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  if (!state.ringing) return null;

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setState({ ringing: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-[300] px-3"
      style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
    >
      <div className="mx-auto max-w-md bg-primary text-white rounded-2xl shadow-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-[22px] shrink-0">alarm</span>
          <div className="min-w-0">
            <p className="text-sm font-black truncate">{state.title || t('alarm.ringingTitle')}</p>
            {state.body ? <p className="text-xs opacity-90 truncate">{state.body}</p> : null}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={() => act(() => snoozeRingingAlarm(10))}
            className="flex-1 py-2.5 rounded-xl bg-white/15 hover:bg-white/25 font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
          >
            {t('alarm.snooze')}
          </button>
          <button
            disabled={busy}
            onClick={() => act(() => dismissRingingAlarm())}
            className="flex-1 py-2.5 rounded-xl bg-white text-primary font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
          >
            {t('alarm.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
