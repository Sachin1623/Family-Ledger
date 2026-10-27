import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { scheduleAlarm, cancelAlarm, ensureAlarmClockSanitized, setApprovedAlarmIds } from './alarmClock';
import { toLocalDateString } from './dateUtils';

// Personal (non-shared) to-do reminders are scheduled entirely on-device, deliberately bypassing
// the server/cron entirely — no network round trip needed to fire at the right moment, so it
// works offline and isn't subject to the cron's polling interval (server-triggered reminders,
// used for group-shared items since only the server can reach *other* members' devices, are
// only ever as precise as how often the cron runs — see processTodoReminders in server.ts).
// Tapping the resulting notification is already routed correctly by the shared
// `localNotificationActionPerformed` listener in pushNotifications.ts, since it reads the same
// `extra.type === 'todo_reminder'` shape used here.

// Deterministic string -> 32-bit positive int, so the same todo always maps to the same
// notification id — re-scheduling (e.g. after editing the reminder time) then just overwrites
// the existing pending notification instead of creating a duplicate one.
function todoNotificationId(todoId: string): number {
  let hash = 0;
  for (let i = 0; i < todoId.length; i++) {
    hash = (hash * 31 + todoId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

export async function scheduleLocalTodoReminder(todo: { id: string; text: string; reminderAt: string }) {
  if (!Capacitor.isNativePlatform()) return; // no local notifications on web
  const at = new Date(todo.reminderAt);
  if (at.getTime() <= Date.now()) return; // don't schedule something already in the past
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: todoNotificationId(todo.id),
          title: 'To-Do reminder',
          body: todo.text,
          schedule: { at },
          extra: { type: 'todo_reminder', todoId: todo.id },
        },
      ],
    });
  } catch (err) {
    console.error('Failed to schedule local to-do reminder:', err);
  }
}

export async function cancelLocalTodoReminder(todoId: string) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: todoNotificationId(todoId) }] });
  } catch (err) {
    console.error('Failed to cancel local to-do reminder:', err);
  }
}

// ---------- "Alarm" style reminders (Android) ----------
// A to-do can ask to ring like a real alarm (full-screen card with Snooze / Dismiss, rings over silent mode) instead of a plain notification. It
// reuses the same native alarm plugin medicine and vaccine reminders use (alarmClock.ts), as a one-time alarm on the reminder's own day. Only personal
// to-dos can do this (a shared to-do's reminder comes from the server to every member's phone, which cannot ring an alarm). On iPhone and web an
// alarm-style to-do falls back to the normal notification above.
const ALARM_IDS_KEY = 'familyledger_todo_alarm_ids';

export const canRingTodoAlarm = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const todoAlarmId = (todoId: string) => todoNotificationId(`todo_alarm_${todoId}`);

function readAlarmIds(): number[] {
  try {
    const raw = localStorage.getItem(ALARM_IDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// Several syncs can overlap (the list updates fast), and each is a "cancel what I armed, arm what is due now" pass over shared native state, so they run
// one at a time — the same reason medicine and vaccine reminders do.
let alarmChain: Promise<void> = Promise.resolve();

export function syncTodoAlarms(todos: { id: string; text: string; reminderAt: string }[]): Promise<void> {
  if (!canRingTodoAlarm()) return Promise.resolve();
  alarmChain = alarmChain.then(async () => {
    try {
      await ensureAlarmClockSanitized();
      const wanted = todos
        .map((t) => ({ ...t, at: new Date(t.reminderAt), alarmId: todoAlarmId(t.id) }))
        .filter((t) => t.at.getTime() > Date.now());
      const wantedIds = wanted.map((t) => t.alarmId);
      for (const id of readAlarmIds()) if (!wantedIds.includes(id)) await cancelAlarm(id);
      await setApprovedAlarmIds('todo', wantedIds); // before arming: only these may ring
      for (const t of wanted) {
        await scheduleAlarm({
          id: t.alarmId,
          title: 'To-Do',
          body: t.text,
          hour: t.at.getHours(),
          minute: t.at.getMinutes(),
          weekdays: [],
          intervalDays: 36500, // a one-time alarm, the same way vaccine reminders do it
          startDate: toLocalDateString(t.at),
          endDate: toLocalDateString(t.at),
          route: '/todo',
          feature: 'todo',
        });
      }
      localStorage.setItem(ALARM_IDS_KEY, JSON.stringify(wantedIds));
    } catch (err) {
      console.error('Failed to sync to-do alarms:', err);
    }
  });
  return alarmChain;
}
