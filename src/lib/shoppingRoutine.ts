import { doc, setDoc, deleteField } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { db, auth } from './firebase';
import { scheduleAlarm, cancelAlarm, ensureAlarmClockSanitized } from './alarmClock';

// Weekly shopping routines: one per group (or one for "just me"), each with its own day, time and reminder, and its own repeating
// items. On a routine's day the server (see processShoppingRoutines in server.ts) builds that group's list from whatever is due:
// one list per group per day at most, and never a second one while that group's last automatic list is still open.
// Everything lives on the person's own user record: `shoppingRoutines` (a map keyed by group id, or 'me') and
// `shoppingRecurring` (a map keyed `<routine key>__<item key>`, each entry saying which routine it belongs to).
export type Freq = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface RecurringItem {
  name: string;
  qty?: number | null;
  unit?: string | null;
  store?: string | null;
  freq: Freq;
  routine?: string; // the routine (group) this item belongs to
  anchor?: string | null; // the day the item started repeating (counts the weeks for "every 2 weeks")
  lastAdded?: string | null; // the last routine day this item was put in a list (written by the server)
}

export interface ShoppingRoutine {
  enabled: boolean;
  dayOfWeek: number; // 0 = Sunday
  time: string; // HH:MM, the time the list is scheduled for
  groupId: string | null; // the group this routine is for (null = just me)
  // How to remind the person on shopping day: nothing, a notification, or an alarm that rings like a clock (Android; other devices get the notification).
  reminder?: 'none' | 'notification' | 'alarm';
  remindLead?: number; // minutes before the shopping time (0, 30 or 60)
  lastRunDate?: string | null; // written by the server
}

export const DEFAULT_ROUTINE: ShoppingRoutine = { enabled: true, dayOfWeek: 0, time: '17:00', groupId: null, reminder: 'notification', remindLead: 0 };

// A routine's key: the group it is for, or 'me' for personal shopping.
export const routineKeyOf = (groupId?: string | null) => groupId || 'me';
export const recurringKey = (routineKey: string, itemKey: string) => `${routineKey}__${itemKey}`;
export const getRoutines = (profile: any): Record<string, ShoppingRoutine> => (profile?.shoppingRoutines || {}) as Record<string, ShoppingRoutine>;

export const FREQ_OPTIONS: { id: Freq | ''; label: string }[] = [
  { id: '', label: 'Never' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'biweekly', label: 'Every 2 weeks' },
  { id: 'monthly', label: 'Monthly' },
];
export const FREQ_SHORT: Record<Freq, string> = { daily: 'Daily', weekly: 'Weekly', biweekly: '2 wks', monthly: 'Monthly' };
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const todayLocalDate = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function routineSummary(r: ShoppingRoutine | undefined | null): string {
  if (!r?.enabled) return 'Off';
  const [h, m] = (r.time || '17:00').split(':').map(Number);
  const hour12 = ((h + 11) % 12) + 1;
  return `${DAY_NAMES[r.dayOfWeek] || 'Sun'} ${hour12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Sets (or, with null, removes) the repeat for one item.
export function saveRecurring(uid: string, key: string, entry: RecurringItem | null) {
  return setDoc(doc(db, 'users', uid), { shoppingRecurring: { [key]: entry ? entry : deleteField() } }, { merge: true });
}

// Saves (or, with null, removes) one routine. `all` is every routine as it is now, so the "any routine is on" flag the server
// looks for can be kept right.
export function saveRoutineFor(uid: string, key: string, routine: ShoppingRoutine | null, all: Record<string, ShoppingRoutine>) {
  const next = { ...all };
  if (routine) next[key] = routine; else delete next[key];
  const active = Object.values(next).some((r) => r?.enabled);
  return setDoc(doc(db, 'users', uid), { shoppingRoutines: { [key]: routine ? routine : deleteField() }, shoppingRoutineActive: active }, { merge: true });
}

// One-time move from the earlier single routine: it becomes the routine for the group it was sharing with, and the repeating items
// that belonged to it are filed under that routine. Safe to run again: it does nothing once everything is filed.
export async function migrateLegacyShopping(uid: string, profile: any) {
  const legacy = profile?.shoppingRoutine;
  const recurring = (profile?.shoppingRecurring || {}) as Record<string, RecurringItem>;
  const orphans = Object.entries(recurring).filter(([, e]) => e && !e.routine);
  const needsRoutine = !!legacy && !profile?.shoppingRoutines;
  if (!needsRoutine && orphans.length === 0) return;
  const key = routineKeyOf(legacy?.groupId);
  const patch: Record<string, unknown> = {};
  if (needsRoutine) {
    patch.shoppingRoutines = {
      [key]: {
        enabled: !!legacy.enabled,
        dayOfWeek: legacy.dayOfWeek ?? 0,
        time: legacy.time || '17:00',
        groupId: legacy.groupId || null,
        reminder: legacy.reminder || 'notification',
        remindLead: legacy.remindLead || 0,
        ...(legacy.lastRunDate ? { lastRunDate: legacy.lastRunDate } : {}),
      },
    };
    patch.shoppingRoutineActive = !!legacy.enabled;
  }
  if (orphans.length > 0) {
    const rec: Record<string, unknown> = {};
    orphans.forEach(([k, e]) => { rec[recurringKey(key, k)] = { ...e, routine: key }; rec[k] = deleteField(); });
    patch.shoppingRecurring = rec;
  }
  await setDoc(doc(db, 'users', uid), patch, { merge: true });
}

// Builds a routine's list now, whatever the day and time (the same thing the server does on that routine's day).
export async function runRoutineNow(routineKey: string): Promise<{ result: string; listId?: string; added?: number }> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch('/api/shopping-routine/run-now', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ routineKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------- the reminders on shopping days ----------
// Done on the phone itself (a weekly on-device notification, or the same native alarm medicine reminders use), so they fire on time
// with no connection and cost nothing to run. Each routine has its own pair of ids, so setting one again replaces the old one.
const REMINDER_IDS_KEY = 'familyledger_shopping_reminder_ids';
const REMINDER_TITLE = '🛒 Time to go shopping';

export const canRingShoppingAlarm = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const reminderIds = (routineKey: string) => {
  let h = 0;
  for (let i = 0; i < routineKey.length; i++) h = (h * 31 + routineKey.charCodeAt(i)) | 0;
  const base = 880100 + (Math.abs(h) % 9000) * 2;
  return { notification: base, alarm: base + 1 };
};

function readReminderIds(): number[] {
  try { return JSON.parse(localStorage.getItem(REMINDER_IDS_KEY) || '[]'); } catch { return []; }
}

// Makes this phone's reminders match the routines: everything armed before is cancelled, then each routine that wants one gets its own.
export async function syncShoppingReminders(routines: Record<string, ShoppingRoutine>, nameFor: (routineKey: string) => string) {
  if (!Capacitor.isNativePlatform()) return; // web has no on-device reminders
  try {
    // the single reminder the first version of this feature armed, plus everything armed since
    const previous = Array.from(new Set([880011, 880012, ...readReminderIds()]));
    await LocalNotifications.cancel({ notifications: previous.map((id) => ({ id })) }).catch(() => {});
    for (const id of previous) await cancelAlarm(id);

    const armed: number[] = [];
    for (const [key, routine] of Object.entries(routines)) {
      const mode = routine?.reminder || 'none';
      if (!routine?.enabled || mode === 'none') continue;
      // the reminder time is the shopping time minus the lead, which can fall on the day before
      const [h, m] = (routine.time || '17:00').split(':').map((n) => parseInt(n, 10));
      let total = (Number.isFinite(h) ? h : 17) * 60 + (Number.isFinite(m) ? m : 0) - (routine.remindLead || 0);
      let day = routine.dayOfWeek ?? 0;
      if (total < 0) { total += 24 * 60; day = (day + 6) % 7; }
      const hour = Math.floor(total / 60);
      const minute = total % 60;
      const ids = reminderIds(key);
      const body = `Your ${nameFor(key)} list is ready. Tap to open it.`;

      if (mode === 'alarm' && canRingShoppingAlarm()) {
        await ensureAlarmClockSanitized();
        await scheduleAlarm({ id: ids.alarm, title: REMINDER_TITLE, body, hour, minute, weekdays: [day], route: '/shopping-lists' });
        armed.push(ids.alarm);
        continue;
      }
      // a notification (also what an alarm becomes on an iPhone)
      let perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
      if (perm.display !== 'granted') continue;
      await LocalNotifications.schedule({
        notifications: [{
          id: ids.notification,
          title: REMINDER_TITLE,
          body,
          // Capacitor counts weekdays 1 (Sunday) to 7 (Saturday)
          schedule: { on: { weekday: day + 1, hour, minute }, allowWhileIdle: true },
          extra: { type: 'shopping_list' },
        }],
      });
      armed.push(ids.notification);
    }
    try { localStorage.setItem(REMINDER_IDS_KEY, JSON.stringify(armed)); } catch { /* not persisted: the next sync just cancels what it can */ }
  } catch (err) {
    console.error('Failed to set the shopping reminders:', err);
  }
}
