import { useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { checkAppPermissions, openPermissionSettings, PermissionKey, PermissionStatus } from '../lib/appPermissions';

// Device-local, not per-account — an OS permission grant lives on the device/install, not the
// signed-in user, so this deliberately does NOT go through Firestore the way the feedback/rating
// prompt does.
const SNOOZE_KEY = 'fl_permissions_reminder_snoozed_until';
// Re-checked every time the app comes to the foreground, but the popup itself only actually shows
// at most this often — "check occasionally," not nag on every single launch.
const SNOOZE_HOURS = 24;

// Which gaps we ever surface, and in what order — notifications/alarm-reliability first since
// those affect the app's core reminder features; contacts/microphone are lower-stakes (only used
// by specific optional flows: inviting from contacts, voice chat in games).
const PERMISSION_ORDER: PermissionKey[] = ['notifications', 'exactAlarm', 'batteryOptimization', 'contacts', 'microphone'];

export default function AppPermissionsReminder() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [missing, setMissing] = useState<PermissionKey[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!user || !Capacitor.isNativePlatform()) return;
    let cancelled = false;

    const run = async () => {
      const snoozedUntil = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      if (Date.now() < snoozedUntil) return;
      const status: PermissionStatus | null = await checkAppPermissions();
      if (!status || cancelled) return;
      const gaps = PERMISSION_ORDER.filter((key) => status[key] === false);
      if (gaps.length > 0) {
        setMissing(gaps);
        setVisible(true);
      }
    };

    run();
    // Safety net for permissions granted/revoked while the app was backgrounded (e.g. the user
    // followed an "Enable" link out to Settings and back) — re-check on every foreground, same
    // pattern as GlobalAlarmRingingBanner's appStateChange listener.
    const sub = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) run();
    });
    return () => {
      cancelled = true;
      sub.then((h) => h.remove()).catch(() => {});
    };
  }, [user]);

  const snooze = () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_HOURS * 60 * 60 * 1000));
    setVisible(false);
  };

  const enable = (key: PermissionKey) => {
    openPermissionSettings(key);
    // Leave the rest of the list up (they may fix more than one in a row); this one drops off
    // now and the next foreground check will confirm whether it's actually resolved.
    setMissing((prev) => prev.filter((k) => k !== key));
  };

  useEffect(() => {
    if (visible && missing.length === 0) setVisible(false);
  }, [missing, visible]);

  if (!visible || missing.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-[22px] text-primary">privacy_tip</span>
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-black text-primary">{t('permissions.reminderTitle')}</h2>
            <p className="text-xs text-text-muted mt-0.5">{t('permissions.reminderBody')}</p>
          </div>
        </div>
        <div className="space-y-2">
          {missing.map((key) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 bg-surface rounded-2xl p-3 border border-border-subtle"
            >
              <div className="min-w-0">
                <p className="text-sm font-bold text-on-surface">{t(`permissions.${key}`)}</p>
                <p className="text-[11px] text-text-muted">{t(`permissions.${key}Why`)}</p>
              </div>
              <button
                type="button"
                onClick={() => enable(key)}
                className="shrink-0 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold active:scale-95 transition-all"
              >
                {t('permissions.enable')}
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={snooze} className="w-full py-2 text-text-muted font-bold text-xs">
          {t('permissions.remindLater')}
        </button>
      </div>
    </div>
  );
}
