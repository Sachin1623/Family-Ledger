import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

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
