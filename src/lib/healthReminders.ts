import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { GlucoseReminderSettings, BEFORE_MEAL_REMINDER_LEAD_MINUTES } from './health';

// On-device only, same reasoning as localReminders.ts's to-do reminders — no server round trip,
// works offline, exact to the minute. Fixed ids (not per-user hashed) since a device only ever
// has ONE glucose reminder configuration active at a time, unlike to-dos which have many.
const REMINDER_IDS: Record<string, number> = {
  breakfast_before: 9101,
  breakfast_after: 9102,
  lunch_before: 9103,
  lunch_after: 9104,
  dinner_before: 9105,
  dinner_after: 9106,
};

const MEAL_LABELS: Record<'breakfast' | 'lunch' | 'dinner', string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

function minusMinutes(time: string, minutes: number): { hour: number; minute: number } {
  const [h, m] = time.split(':').map(Number);
  const total = (((h * 60 + m - minutes) % 1440) + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function plusHours(time: string, hours: number): { hour: number; minute: number } {
  const [h, m] = time.split(':').map(Number);
  const total = (((h * 60 + m + hours * 60) % 1440) + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

export async function scheduleGlucoseReminders(settings: GlucoseReminderSettings) {
  if (!Capacitor.isNativePlatform()) return; // no local notifications on web
  try {
    await cancelGlucoseReminders();
    if (!settings.enabled) return;
    const notifications: any[] = [];
    (['breakfast', 'lunch', 'dinner'] as const).forEach((meal) => {
      const cfg = settings[meal];
      const before = minusMinutes(cfg.time, BEFORE_MEAL_REMINDER_LEAD_MINUTES);
      const after = plusHours(cfg.time, cfg.afterHours);
      notifications.push({
        id: REMINDER_IDS[`${meal}_before`],
        title: 'Glucose check',
        body: `Before-${MEAL_LABELS[meal]} reading time`,
        schedule: { on: { hour: before.hour, minute: before.minute }, every: 'day', allowWhileIdle: true },
        extra: { type: 'glucose_reminder', meal, timing: 'before' },
      });
      notifications.push({
        id: REMINDER_IDS[`${meal}_after`],
        title: 'Glucose check',
        body: `After-${MEAL_LABELS[meal]} reading time (${cfg.afterHours}hr later)`,
        schedule: { on: { hour: after.hour, minute: after.minute }, every: 'day', allowWhileIdle: true },
        extra: { type: 'glucose_reminder', meal, timing: 'after' },
      });
    });
    await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.error('Failed to schedule glucose reminders:', err);
  }
}

export async function cancelGlucoseReminders() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: Object.values(REMINDER_IDS).map((id) => ({ id })) });
  } catch (err) {
    console.error('Failed to cancel glucose reminders:', err);
  }
}
