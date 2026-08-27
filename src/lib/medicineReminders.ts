import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Medicine } from './medicines';

// Unlike bpReminders.ts's independent, user-set reminder times, a medicine's reminder schedule
// IS its own times/weekdays — there's nothing extra to configure, so this just (re)schedules
// notifications for every currently-active, reminders-enabled medicine passed in. Call it
// whenever the caller's own medicine list changes (add/edit/pause/delete/duration-elapsed).
//
// Local notification repeats have no built-in end date, so a medicine whose duration has since
// elapsed keeps firing until the next reconcile (this function is only ever called with the
// medicine's CURRENT state, so an ended/paused medicine is simply omitted next time it runs) —
// same on-device-only, best-effort tradeoff already documented in bpReminders.ts.
const STORAGE_KEY = 'familyledger_medicine_reminder_ids';

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

export async function scheduleMedicineReminders(medicines: Medicine[]) {
  if (!Capacitor.isNativePlatform()) return; // no local notifications on web
  try {
    await cancelMedicineReminders();
    const active = medicines.filter((m) => m.active && m.remindersEnabled);
    if (active.length === 0) return;

    const notifications: any[] = [];
    const scheduledIds: number[] = [];
    active.forEach((med) => {
      med.times.forEach((slot) => {
        const [hour, minute] = slot.time.split(':').map(Number);
        const body = `${med.name}${med.dosage ? ` (${med.dosage})` : ''} — ${slot.label}`;
        const everyDay = med.weekdays.length === 0 || med.weekdays.length === 7;
        if (everyDay) {
          const id = hashId(`med_daily_${med.id}_${slot.id}`);
          scheduledIds.push(id);
          notifications.push({
            id,
            title: 'Medicine reminder',
            body,
            schedule: { on: { hour, minute }, every: 'day', allowWhileIdle: true },
            extra: { type: 'medicine_reminder', medicineId: med.id, doseTimeId: slot.id },
          });
        } else {
          med.weekdays.forEach((weekday) => {
            const id = hashId(`med_weekly_${med.id}_${slot.id}_${weekday}`);
            scheduledIds.push(id);
            notifications.push({
              // Capacitor's `on.weekday` is 1-7 (Sun=1); Medicine.weekdays is 0-6 (Sun=0) to
              // match JS Date.getDay() — converted only at this scheduling boundary.
              id,
              title: 'Medicine reminder',
              body,
              schedule: { on: { weekday: weekday + 1, hour, minute }, every: 'week', allowWhileIdle: true },
              extra: { type: 'medicine_reminder', medicineId: med.id, doseTimeId: slot.id },
            });
          });
        }
      });
    });

    if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheduledIds));
  } catch (err) {
    console.error('Failed to schedule medicine reminders:', err);
  }
}

export async function cancelMedicineReminders() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const ids = readScheduledIds();
    if (ids.length > 0) await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Failed to cancel medicine reminders:', err);
  }
}
