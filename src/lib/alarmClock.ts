import { Capacitor, registerPlugin } from '@capacitor/core';

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

interface AlarmClockNativePlugin {
  schedule(opts: AlarmClockSchedule): Promise<void>;
  cancel(opts: { id: number }): Promise<void>;
  cancelAll(): Promise<void>;
  checkFullScreenIntentPermission(): Promise<{ granted: boolean }>;
  requestFullScreenIntentPermission(): Promise<{ granted: boolean }>;
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
