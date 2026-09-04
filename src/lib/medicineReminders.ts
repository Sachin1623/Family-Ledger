import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Medicine, isMedicineDueOn } from './medicines';
import { toLocalDateString } from './dateUtils';
import { scheduleAlarm, cancelAlarm } from './alarmClock';

// Medicine reminders should ring like a real alarm clock, not a plain notification a dose could be
// missed on — but "how" splits hard by platform, since Android and iOS allow fundamentally
// different things to third-party apps:
//
//   - Android: a genuine full-screen, rings-over-silent-mode takeover — see alarmClock.ts + the
//     native AlarmReceiver/AlarmRingingService/AlarmActivity it wraps.
//   - iOS: Apple doesn't let any third-party app take over the screen the way Android's
//     AlarmActivity does (that's reserved for Apple's own Clock/Phone + CallKit), and silently
//     bypassing the mute switch/Do Not Disturb requires a special "Critical Alerts" entitlement
//     that Apple grants case-by-case, not something togglable from code — see the comment on
//     MEDICINE_INTERRUPTION_LEVEL below. The closest available today is a Time-Sensitive local
//     notification: breaks through Focus modes, shows prominently with a loud sound and
//     Snooze/Dismiss actions right on the lock screen — everything short of true silent-mode
//     bypass and full-screen takeover.
//
// Unlike bpReminders.ts's independent, user-set reminder times, a medicine's reminder schedule IS
// its own times/weekdays — there's nothing extra to configure, so this just (re)schedules
// everything for every currently-active, reminders-enabled medicine passed in. Call it whenever
// the caller's own medicine list changes (add/edit/pause/delete/duration-elapsed).
//
// A scheduled reminder has no built-in end date, so a medicine whose duration has since elapsed
// keeps firing until the next reconcile (this function is only ever called with the medicine's
// CURRENT state, so an ended/paused medicine is simply omitted next time it runs) — same
// on-device-only, best-effort tradeoff already documented in bpReminders.ts.
const STORAGE_KEY = 'familyledger_medicine_reminder_ids';

// 'critical' bypasses the mute switch/Do Not Disturb entirely — but ONLY takes effect once Apple
// has granted this app the Critical Alerts entitlement (a manual request via Apple's own form,
// filed separately from any code change; see ios/App/App/App.entitlements). Requesting 'critical'
// WITHOUT the entitlement doesn't just fail quietly — per Apple's docs, iOS treats it as if you'd
// asked for 'active' instead, i.e. WORSE than 'timeSensitive' (no Focus-mode breakthrough either).
// So this stays 'timeSensitive' — the best available without a granted entitlement — until that
// approval is confirmed, at which point flipping this one constant to 'critical' is the entire
// change needed.
const MEDICINE_INTERRUPTION_LEVEL: 'timeSensitive' | 'critical' = 'timeSensitive';

export const MEDICINE_ACTION_TYPE_ID = 'MEDICINE_ALARM';

// Registered once at app startup (see pushNotifications.ts) so the Dismiss/Snooze buttons show up
// directly on the lock-screen notification itself, mirroring Android's AlarmActivity buttons as
// closely as iOS's notification model allows. Android-side medicine reminders don't use this at
// all (they bypass @capacitor/local-notifications entirely — see alarmClock.ts) so this is a no-op
// there; still safe to call unconditionally.
export async function registerMedicineActionTypes() {
  if (Capacitor.getPlatform() !== 'ios') return;
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: MEDICINE_ACTION_TYPE_ID,
          actions: [
            { id: 'dismiss', title: 'Dismiss' },
            { id: 'snooze', title: 'Snooze 10 min' },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('Failed to register medicine action types:', err);
  }
}

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

async function cancelIosIds(ids: number[]) {
  if (ids.length === 0) return;
  await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
}

export async function scheduleMedicineReminders(medicines: Medicine[]) {
  if (!Capacitor.isNativePlatform()) return; // no native alarms on web
  const platform = Capacitor.getPlatform();
  try {
    const previousIds = readScheduledIds();
    if (platform === 'android') {
      // Cancel by id, not a blanket cancel-all — AlarmClock is a shared native plugin, and a
      // future second feature built on it should never have its alarms wiped out by a medicine
      // list change.
      for (const id of previousIds) await cancelAlarm(id);
    } else if (platform === 'ios') {
      await cancelIosIds(previousIds);
    } else {
      return;
    }

    const active = medicines.filter((m) => m.active && m.remindersEnabled);
    const scheduledIds: number[] = [];
    const iosNotifications: any[] = [];

    for (const med of active) {
      for (const slot of med.times) {
        const [hour, minute] = slot.time.split(':').map(Number);
        const body = `${med.name}${med.dosage ? ` (${med.dosage})` : ''} — ${slot.label}`;
        const alternating = !!med.intervalDays && med.intervalDays > 1;
        const everyDay = !alternating && (med.weekdays.length === 0 || med.weekdays.length === 7);

        if (platform === 'android') {
          const id = hashId(`med_${med.id}_${slot.id}`);
          scheduledIds.push(id);
          await scheduleAlarm({
            id,
            title: 'Medicine reminder',
            body,
            hour,
            minute,
            weekdays: alternating || everyDay ? [] : med.weekdays,
            intervalDays: alternating ? med.intervalDays! : undefined,
            startDate: alternating ? med.startDate : undefined,
            route: '/health/medicines',
          });
        } else if (alternating) {
          // @capacitor/local-notifications' cron-style `on` trigger has no "every N days" concept
          // at all (only day/week/month/year) — an interval-based medicine gets a bounded batch of
          // one-shot occurrences instead (next ~60 days, capped at 30 notifications). This function
          // re-runs on every medicine-list change (add/edit/pause/delete) and, per GoalsHub-style
          // reasoning elsewhere in this app, ideally also periodically — for now it's the same
          // on-device-only, best-effort tradeoff this file already documents for the weekly case:
          // if nobody opens the app for ~2 months straight, the batch could run dry.
          const now = new Date();
          let scheduledCount = 0;
          for (let i = 0; i < 60 && scheduledCount < 30; i++) {
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
            const dateStr = toLocalDateString(d);
            if (!isMedicineDueOn(med, dateStr)) continue;
            const occurrence = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute);
            if (occurrence <= now) continue;
            const id = hashId(`med_${med.id}_${slot.id}_${dateStr}`);
            scheduledIds.push(id);
            iosNotifications.push({
              id,
              title: 'Medicine reminder',
              body,
              sound: 'default',
              interruptionLevel: MEDICINE_INTERRUPTION_LEVEL,
              actionTypeId: MEDICINE_ACTION_TYPE_ID,
              schedule: { at: occurrence, allowWhileIdle: true },
              extra: { type: 'medicine_reminder', medicineId: med.id, doseTimeId: slot.id },
            });
            scheduledCount++;
          }
        } else {
          // @capacitor/local-notifications' cron-style `on` trigger takes at most one weekday per
          // schedule (unlike AlarmClock's own `weekdays: number[]`) — one notification per weekday
          // when the medicine isn't daily, exactly like this app's other iOS/Android-shared
          // reminders (see healthReminders.ts) already do for the same plugin limitation.
          const weekdaysToSchedule = everyDay ? [null] : med.weekdays;
          for (const weekday of weekdaysToSchedule) {
            const id = hashId(`med_${med.id}_${slot.id}${weekday === null ? '' : `_${weekday}`}`);
            scheduledIds.push(id);
            iosNotifications.push({
              id,
              title: 'Medicine reminder',
              body,
              // Undocumented-but-relied-on plugin fallback: a filename that isn't actually bundled
              // in the app falls back to the system default sound rather than erroring — see the
              // `sound` field's own doc comment in the plugin's definitions — used deliberately
              // here since omitting `sound` entirely means NO sound at all on iOS (unlike Android,
              // which defaults to a sound when this is left unset).
              sound: 'default',
              interruptionLevel: MEDICINE_INTERRUPTION_LEVEL,
              actionTypeId: MEDICINE_ACTION_TYPE_ID,
              schedule: {
                on: weekday === null ? { hour, minute } : { weekday: weekday + 1, hour, minute },
                every: weekday === null ? 'day' : 'week',
                allowWhileIdle: true,
              },
              extra: { type: 'medicine_reminder', medicineId: med.id, doseTimeId: slot.id },
            });
          }
        }
      }
    }

    if (platform === 'ios' && iosNotifications.length > 0) {
      await LocalNotifications.schedule({ notifications: iosNotifications });
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheduledIds));
  } catch (err) {
    console.error('Failed to schedule medicine reminders:', err);
  }
}

export async function cancelMedicineReminders() {
  if (!Capacitor.isNativePlatform()) return;
  const platform = Capacitor.getPlatform();
  try {
    const ids = readScheduledIds();
    if (platform === 'android') {
      for (const id of ids) await cancelAlarm(id);
    } else if (platform === 'ios') {
      await cancelIosIds(ids);
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Failed to cancel medicine reminders:', err);
  }
}

// A tapped "Snooze 10 min" action (see pushNotifications.ts's localNotificationActionPerformed
// listener) re-fires this exact reminder once, 10 minutes out — a genuine one-shot, independent of
// (and in addition to) its real recurring schedule, which keeps recurring on its own via the
// plugin's own cron-style trigger. Mirrors AlarmActivity.snooze()'s behavior on Android as closely
// as iOS's notification model allows.
export async function snoozeMedicineReminder(originalId: number, title: string, body: string) {
  if (Capacitor.getPlatform() !== 'ios') return;
  try {
    // Distinct id space so a snooze's one-shot notification never clobbers the reminder's own
    // recurring one (same offset pattern as AlarmActivity.snooze() on the Android side).
    const id = (1_000_000_000 + originalId) | 0;
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title,
          body,
          sound: 'default',
          interruptionLevel: MEDICINE_INTERRUPTION_LEVEL,
          actionTypeId: MEDICINE_ACTION_TYPE_ID,
          schedule: { at: new Date(Date.now() + 10 * 60 * 1000), allowWhileIdle: true },
          extra: { type: 'medicine_reminder', snoozed: true },
        },
      ],
    });
  } catch (err) {
    console.error('Failed to snooze medicine reminder:', err);
  }
}
