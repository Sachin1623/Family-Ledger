import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// Bridges a fully custom native plugin (android/app/src/main/java/com/familyledger/app/
// AlarmClockPlugin.java + AlarmReceiver/AlarmRingingService/AlarmActivity/AlarmBootReceiver
// alongside it) — @capacitor/local-notifications, used by every OTHER reminder type in this app
// (bpReminders.ts, healthReminders.ts, sharedReminderNotifications.ts, localReminders.ts), has no
// concept of a full-screen, rings-over-silent-mode "alarm clock" takeover. This exists specifically
// to provide that, starting with medicine reminders (see medicineReminders.ts) — a plain
// notification is easy to miss or dismiss without ever taking the dose. Android-only: iOS has no
// equivalent native surface built yet, so every export below silently no-ops there and on web.
export interface AlarmClockSchedule {
  id: number;
  title: string;
  body: string;
  hour: number;
  minute: number;
  weekdays?: number[]; // 0=Sun..6=Sat (JS Date.getDay() convention); omit/empty = every day. Ignored when intervalDays is set (see below).
  // An interval-based repeat ("every other day" = 2, etc.), counted from `startDate` — mirrors
  // Medicine.intervalDays exactly (medicines.ts) so isMedicineDueOn() and this native schedule
  // agree on which days a dose is actually due. Mutually exclusive with `weekdays`: set this (with
  // `startDate`) instead of `weekdays` for an interval-based medicine, never both.
  intervalDays?: number;
  startDate?: string; // yyyy-mm-dd — required when intervalDays is set; the anchor day for the interval count
  route?: string; // where the ringing screen's "Open FamilyLedger" button deep-links to (e.g. /health/medicines) — see AlarmActivity.openApp()
}

// State of whatever takeover alarm is ringing RIGHT NOW (foreground service up). `ringing: false`
// means nothing is — the other fields are then stale/empty and should be ignored.
export interface RingingAlarmState {
  ringing: boolean;
  id?: number;
  title?: string;
  body?: string;
  route?: string;
}

interface AlarmClockNativePlugin {
  schedule(opts: AlarmClockSchedule): Promise<void>;
  cancel(opts: { id: number }): Promise<void>;
  cancelAll(): Promise<void>;
  checkBatteryOptimizationExemption(): Promise<{ granted: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{ granted: boolean }>;
  // Currently-ringing controls — so the app can show its own Snooze/Dismiss the whole time an
  // alarm rings, not only via the native full-screen AlarmActivity.
  isRinging(): Promise<RingingAlarmState>;
  stopRinging(): Promise<void>;
  snoozeRinging(opts?: { minutes?: number }): Promise<void>;
  addListener(eventName: 'alarmRinging', cb: (state: RingingAlarmState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'alarmStopped', cb: (state: { ringing: false }) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<AlarmClockNativePlugin>('AlarmClock');

function isSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function scheduleAlarm(opts: AlarmClockSchedule) {
  if (!isSupported()) return;
  try {
    await native.schedule(opts);
  } catch (err) {
    console.error('Failed to schedule alarm:', err);
  }
}

export async function cancelAlarm(id: number) {
  if (!isSupported()) return;
  try {
    await native.cancel({ id });
  } catch (err) {
    console.error('Failed to cancel alarm:', err);
  }
}

export async function cancelAllAlarms() {
  if (!isSupported()) return;
  try {
    await native.cancelAll();
  } catch (err) {
    console.error('Failed to cancel all alarms:', err);
  }
}

// --- Currently-ringing alarm: in-app Snooze / Dismiss (see GlobalAlarmRingingBanner.tsx) ---
// All no-op / "nothing ringing" on web + iOS, same as everything else here.

export async function getRingingAlarm(): Promise<RingingAlarmState> {
  if (!isSupported()) return { ringing: false };
  try {
    return await native.isRinging();
  } catch (err) {
    console.error('Failed to read ringing alarm state:', err);
    return { ringing: false };
  }
}

export async function dismissRingingAlarm() {
  if (!isSupported()) return;
  try {
    await native.stopRinging();
  } catch (err) {
    console.error('Failed to dismiss ringing alarm:', err);
  }
}

export async function snoozeRingingAlarm(minutes = 10) {
  if (!isSupported()) return;
  try {
    await native.snoozeRinging({ minutes });
  } catch (err) {
    console.error('Failed to snooze ringing alarm:', err);
  }
}

// Subscribe to ring-start / ring-stop while mounted. Returns a cleanup fn that removes both
// listeners. Fires nothing on web/iOS.
export function onRingingAlarmChange(
  onRinging: (state: RingingAlarmState) => void,
  onStopped: () => void,
): () => void {
  if (!isSupported()) return () => {};
  const handles: PluginListenerHandle[] = [];
  let removed = false;
  native.addListener('alarmRinging', (state) => onRinging(state)).then((h) => {
    if (removed) h.remove(); else handles.push(h);
  }).catch((err) => console.error('Failed to attach alarmRinging listener:', err));
  native.addListener('alarmStopped', () => onStopped()).then((h) => {
    if (removed) h.remove(); else handles.push(h);
  }).catch((err) => console.error('Failed to attach alarmStopped listener:', err));
  return () => {
    removed = true;
    handles.forEach((h) => h.remove());
    handles.length = 0;
  };
}

// This file used to also export requestAlarmTakeoverPermission() here — a one-time-ask,
// redirect-to-Settings prompt for the "Full screen notifications" Android permission. Removed
// 2026-09-18 along with the native USE_FULL_SCREEN_INTENT permission itself, after Play Console
// rejected the app under the Full-Screen Intent Permission policy (this app's declared category
// is finance/productivity, not alarm/clock). See AndroidManifest.xml's own comment for the full
// reasoning — the takeover screen still works without it, so there's nothing left to ask for.

// One-time-ask pattern, for standard Android's own
// battery-optimization exemption — confirmed via a real device this session that without it, an
// OEM's own background-management layer (seen on a Vivo phone) can silently drop an alarm's
// broadcast before it ever reaches AlarmReceiver, with zero trace: no crash, no error, nothing.
// SCHEDULE_EXACT_ALARM (requestExactAlarmPermission in pushNotifications.ts) does NOT cover this —
// it's a separate restriction layer OEMs add on top of stock Android. This shows Android's own
// system dialog directly (one tap to grant), not a redirect into Settings to hunt for the toggle.
const BATTERY_EXEMPTION_ASKED_KEY = 'familyledger_battery_exemption_asked';

export async function requestBatteryOptimizationExemption() {
  if (!isSupported()) return;
  try {
    if (localStorage.getItem(BATTERY_EXEMPTION_ASKED_KEY)) return;
    const status = await native.checkBatteryOptimizationExemption();
    if (status.granted) {
      localStorage.setItem(BATTERY_EXEMPTION_ASKED_KEY, '1');
      return;
    }
    localStorage.setItem(BATTERY_EXEMPTION_ASKED_KEY, '1');
    const proceed = window.confirm(
      'To make sure medicine reminders never get silently missed, FamilyLedger needs to be exempted from battery optimization. Allow it now?'
    );
    if (proceed) await native.requestBatteryOptimizationExemption();
  } catch (err) {
    console.error('Failed to check/request battery optimization exemption:', err);
  }
}
