import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SharedReminder } from './sharedReminders';

// On-device only — same reasoning as bpReminders.ts/medicineReminders.ts. Every recipient's own
// client schedules its own local notification for a reminder they're part of; there's no
// server-side push firing at trigger time. Since the set of relevant reminders is dynamic (not a
// fixed list like a health tracker's own reminders), the actually-scheduled notification ids are
// tracked in localStorage and cancelled by that exact list before rescheduling, same pattern as
// bpReminders.ts.
const STORAGE_KEY = 'familyledger_shared_reminder_ids';

function hashId(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash) || 1;
}

function readScheduledIds(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function scheduleSharedReminders(reminders: SharedReminder[]) {
  if (!Capacitor.isNativePlatform()) return; // no local notifications on web
  try {
    await cancelSharedReminders();
    const active = reminders.filter((r) => r.active);
    if (active.length === 0) return;

    const notifications: any[] = [];
    const scheduledIds: number[] = [];

    active.forEach((reminder) => {
      const [hour, minute] = reminder.time.split(':').map(Number);
      const body = reminder.title;
      const extra = { type: 'shared_reminder', reminderId: reminder.id };

      if (reminder.cadence === 'once') {
        const [y, m, d] = reminder.startDate.split('-').map(Number);
        const at = new Date(y, m - 1, d, hour, minute);
        if (at.getTime() <= Date.now()) return; // already passed, nothing to schedule
        const id = hashId(`shared_once_${reminder.id}`);
        scheduledIds.push(id);
        notifications.push({ id, title: 'Reminder', body, schedule: { at, allowWhileIdle: true }, extra });
      } else if (reminder.cadence === 'daily') {
        const id = hashId(`shared_daily_${reminder.id}`);
        scheduledIds.push(id);
        notifications.push({ id, title: 'Reminder', body, schedule: { on: { hour, minute }, every: 'day', allowWhileIdle: true }, extra });
      } else if (reminder.cadence === 'weekly') {
        const days = reminder.weekdays.length > 0 ? reminder.weekdays : [0, 1, 2, 3, 4, 5, 6];
        days.forEach((weekday) => {
          const id = hashId(`shared_weekly_${reminder.id}_${weekday}`);
          scheduledIds.push(id);
          notifications.push({
            // Capacitor's `on.weekday` is 1-7 (Sun=1); SharedReminder.weekdays is 0-6 (Sun=0) to
            // match JS Date.getDay() — converted only at this scheduling boundary.
            id,
            title: 'Reminder',
            body,
            schedule: { on: { weekday: weekday + 1, hour, minute }, every: 'week', allowWhileIdle: true },
            extra,
          });
        });
      } else if (reminder.cadence === 'monthly') {
        const [, , day] = reminder.startDate.split('-').map(Number);
        const id = hashId(`shared_monthly_${reminder.id}`);
        scheduledIds.push(id);
        notifications.push({ id, title: 'Reminder', body, schedule: { on: { day, hour, minute }, every: 'month', allowWhileIdle: true }, extra });
      }
    });

    if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheduledIds));
  } catch (err) {
    console.error('Failed to schedule shared reminders:', err);
  }
}

export async function cancelSharedReminders() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const ids = readScheduledIds();
    if (ids.length > 0) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Failed to cancel shared reminders:', err);
  }
}
