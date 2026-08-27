import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { GlucoseMealType, GlucoseReminderSettings, BEFORE_MEAL_REMINDER_LEAD_MINUTES } from './health';

// On-device only, same reasoning as localReminders.ts's to-do reminders — no server round trip,
// works offline, exact to the minute. Deterministic ids over the FULL possible id space (every
// meal × before/after × every weekday, plus the plain-daily variant) so cancelGlucoseReminders can
// always clear everything this feature could ever have scheduled, regardless of what the previous
// cadence/meal selection was, before scheduling the current one.
const MEAL_INDEX: Record<GlucoseMealType, number> = { breakfast: 0, lunch: 1, dinner: 2 };
const MEAL_LABELS: Record<GlucoseMealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

// Daily ids: 9100 + meal*10 + timing(1|2) — 6 ids, 9101..9132.
function dailyId(meal: GlucoseMealType, timing: 'before' | 'after'): number {
  return 9100 + MEAL_INDEX[meal] * 10 + (timing === 'before' ? 1 : 2);
}
// Weekly ids: 9200 + meal*70 + timing(0|35) + weekday(0-6) — 42 ids, 9200..9341, never overlapping daily's range.
function weeklyId(meal: GlucoseMealType, timing: 'before' | 'after', weekday: number): number {
  return 9200 + MEAL_INDEX[meal] * 70 + (timing === 'before' ? 0 : 35) + weekday;
}

function allPossibleIds(): number[] {
  const ids: number[] = [];
  (['breakfast', 'lunch', 'dinner'] as const).forEach((meal) => {
    (['before', 'after'] as const).forEach((timing) => {
      ids.push(dailyId(meal, timing));
      for (let weekday = 0; weekday <= 6; weekday++) ids.push(weeklyId(meal, timing, weekday));
    });
  });
  return ids;
}

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
    if (!settings.enabled || settings.meals.length === 0) return;

    const notifications: any[] = [];
    settings.meals.forEach((meal) => {
      const cfg = settings[meal];
      const before = minusMinutes(cfg.time, BEFORE_MEAL_REMINDER_LEAD_MINUTES);
      const after = plusHours(cfg.time, cfg.afterHours);
      const entries: { timing: 'before' | 'after'; at: { hour: number; minute: number }; body: string }[] = [
        { timing: 'before', at: before, body: `Before-${MEAL_LABELS[meal]} reading time` },
        { timing: 'after', at: after, body: `After-${MEAL_LABELS[meal]} reading time (${cfg.afterHours}hr later)` },
      ];

      entries.forEach(({ timing, at, body }) => {
        if (settings.cadence === 'daily') {
          notifications.push({
            id: dailyId(meal, timing),
            title: 'Glucose check',
            body,
            schedule: { on: { hour: at.hour, minute: at.minute }, every: 'day', allowWhileIdle: true },
            extra: { type: 'glucose_reminder', meal, timing },
          });
        } else {
          settings.weekdays.forEach((weekday) => {
            notifications.push({
              // Capacitor's `on.weekday` is 1-7 (Sun=1) — settings.weekdays is stored 0-6 (Sun=0)
              // to match JS Date.getDay(), so convert only at the scheduling boundary.
              id: weeklyId(meal, timing, weekday),
              title: 'Glucose check',
              body,
              schedule: { on: { weekday: weekday + 1, hour: at.hour, minute: at.minute }, every: 'week', allowWhileIdle: true },
              extra: { type: 'glucose_reminder', meal, timing },
            });
          });
        }
      });
    });

    if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.error('Failed to schedule glucose reminders:', err);
  }
}

export async function cancelGlucoseReminders() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: allPossibleIds().map((id) => ({ id })) });
  } catch (err) {
    console.error('Failed to cancel glucose reminders:', err);
  }
}
