import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { BpReminderSettings } from './bloodPressure';

// On-device only, same reasoning as healthReminders.ts's glucose reminders. Unlike glucose's
// fixed 3-meal set, BP's reminder times are a user-editable list (add/remove/rename any time),
// so there's no fixed id space to blanket-cancel — instead the ids actually scheduled last time
// are tracked in localStorage and cancelled by that exact list before rescheduling.
const STORAGE_KEY = 'familyledger_bp_reminder_ids';

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

export async function scheduleBpReminders(settings: BpReminderSettings) {
  if (!Capacitor.isNativePlatform()) return; // no local notifications on web
  try {
    await cancelBpReminders();
    if (!settings.enabled || settings.times.length === 0) return;

    const notifications: any[] = [];
    const scheduledIds: number[] = [];
    settings.times.forEach((slot) => {
      const [hour, minute] = slot.time.split(':').map(Number);
      const body = `${slot.label || 'Blood pressure'} reading time`;
      if (settings.cadence === 'daily') {
        const id = hashId(`bp_daily_${slot.id}`);
        scheduledIds.push(id);
        notifications.push({
          id,
          title: 'Blood pressure check',
          body,
          schedule: { on: { hour, minute }, every: 'day', allowWhileIdle: true },
          extra: { type: 'bp_reminder', slotId: slot.id },
        });
      } else {
        settings.weekdays.forEach((weekday) => {
          const id = hashId(`bp_weekly_${slot.id}_${weekday}`);
          scheduledIds.push(id);
          notifications.push({
            // Capacitor's `on.weekday` is 1-7 (Sun=1); settings.weekdays is 0-6 (Sun=0) to match
            // JS Date.getDay() — converted only at this scheduling boundary.
            id,
            title: 'Blood pressure check',
            body,
            schedule: { on: { weekday: weekday + 1, hour, minute }, every: 'week', allowWhileIdle: true },
            extra: { type: 'bp_reminder', slotId: slot.id },
          });
        });
      }
    });

    if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheduledIds));
  } catch (err) {
    console.error('Failed to schedule BP reminders:', err);
  }
}

export async function cancelBpReminders() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const ids = readScheduledIds();
    if (ids.length > 0) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Failed to cancel BP reminders:', err);
  }
}
