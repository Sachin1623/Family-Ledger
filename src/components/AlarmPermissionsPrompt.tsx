import { useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useLanguage } from '../context/LanguageContext';
import { checkAppPermissions, type PermissionKey } from '../lib/appPermissions';
import { ALARM_ASK_EVENT, type AlarmAskDetail, type AlarmAskKind } from '../lib/alarmPermissions';
import MissingPermissionsList from './MissingPermissionsList';

// "Let your alarms ring on time": appears right when someone sets up (or opens) something that rings, and lists only what is still switched off.
// Medicine alarms also ask for the pop-up card; other reminders only need exact timing and the battery exemption. Asked at most once a day unless
// the person has just created something.
const ASKED_KEY = 'fl_alarm_permissions_asked_at';
const WHICH: Record<AlarmAskKind, PermissionKey[]> = {
  medicine: ['exactAlarm', 'batteryOptimization', 'overlay'],
  reminder: ['exactAlarm', 'batteryOptimization'],
};

export default function AlarmPermissionsPrompt() {
  const { t } = useLanguage();
  const [missing, setMissing] = useState<PermissionKey[]>([]);
  const [kind, setKind] = useState<AlarmAskKind>('medicine');

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const onAsk = async (e: Event) => {
      const { kind: k, force } = (e as CustomEvent<AlarmAskDetail>).detail;
      const last = Number(localStorage.getItem(ASKED_KEY) || 0);
      if (!force && Date.now() - last < 24 * 3600 * 1000) return;
      const status = await checkAppPermissions();
      if (!status) return;
      const gaps = WHICH[k].filter((key) => status[key] === false);
      if (gaps.length === 0) return;
      localStorage.setItem(ASKED_KEY, String(Date.now()));
      setKind(k);
      setMissing(gaps);
    };
    window.addEventListener(ALARM_ASK_EVENT, onAsk);
    // coming back from Settings: drop whatever has been switched on since
    const sub = CapacitorApp.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive) return;
      const status = await checkAppPermissions();
      if (status) setMissing((prev) => prev.filter((key) => status[key] === false));
    });
    return () => {
      window.removeEventListener(ALARM_ASK_EVENT, onAsk);
      sub.then((h) => h.remove()).catch(() => {});
    };
  }, []);

  if (missing.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-[22px] text-primary">alarm</span>
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-black text-primary">{t('permissions.alarmsTitle')}</h2>
            <p className="text-xs text-text-muted mt-0.5">{kind === 'medicine' ? t('permissions.alarmsBodyMedicine') : t('permissions.alarmsBody')}</p>
          </div>
        </div>
        <MissingPermissionsList missing={missing} onEnable={(key) => setMissing((prev) => prev.filter((k) => k !== key))} />
        <button type="button" onClick={() => setMissing([])} className="w-full py-2 text-text-muted font-bold text-xs">
          {t('permissions.notNow')}
        </button>
      </div>
    </div>
  );
}
