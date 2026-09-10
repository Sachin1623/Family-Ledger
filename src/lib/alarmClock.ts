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
  checkFullScreenIntentPermission(): Promise<{ granted: boolean }>;
  requestFullScreenIntentPermission(): Promise<{ granted: boolean }>;
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

// Mirrors requestExactAlarmPermission() in pushNotifications.ts — same one-time-ask, redirect-to-
// Settings pattern, for the separate "Full screen notifications" Android permission (distinct from
// "Alarms & reminders"; a takeover alarm needs both). Called once from initPushNotifications so it
// happens the same place/time as every other startup permission ask in this app.
const FULL_SCREEN_ASKED_KEY = 'familyledger_full_screen_intent_asked';

export async function requestAlarmTakeoverPermission() {
  if (!isSupported()) return;
  try {
    if (localStorage.getItem(FULL_SCREEN_ASKED_KEY)) return;
    const status = await native.checkFullScreenIntentPermission();
    if (status.granted) {
      localStorage.setItem(FULL_SCREEN_ASKED_KEY, '1');
      return;
    }
    localStorage.setItem(FULL_SCREEN_ASKED_KEY, '1');
    const proceed = window.confirm(
      'For medicine reminders to ring like a real alarm clock — even over silent mode — FamilyLedger needs the "Full screen notifications" permission. Open Settings to allow it now?'
    );
    if (proceed) await native.requestFullScreenIntentPermission();
  } catch (err) {
    console.error('Failed to check/request full-screen intent permission:', err);
  }
}

// Same one-time-ask pattern as requestAlarmTakeoverPermission above, for standard Android's own
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
