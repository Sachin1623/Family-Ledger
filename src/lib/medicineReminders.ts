import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Medicine, MedicineDoseTime, isMedicineDueOn, medicineEndDateStr } from './medicines';
import { toLocalDateString } from './dateUtils';
import { scheduleAlarm, cancelAlarm, ensureAlarmClockSanitized, setApprovedAlarmIds } from './alarmClock';

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

// `currentUid`/`ownerNames` are only needed once a caller passes medicines belonging to someone
// OTHER than the signed-in user (a delegate's own device now also schedules alarms for whoever
// delegates to them — see HealthMedicines.tsx's call site) — every body text below prefixes the
// owner's name for any medicine that isn't the signed-in user's own, so a delegate's ringing alarm
// says whose dose it's for instead of reading like their own.
function ownerPrefix(med: Medicine, currentUid?: string, ownerNames?: Record<string, string>): string {
  if (!currentUid || med.userId === currentUid) return '';
  const name = ownerNames?.[med.userId];
  return name ? `${name}: ` : '';
}

// Several places call scheduleMedicineReminders (the app-root scheduler, Medicine Reminders, the
// Alarms hub) and each call is a multi-await "cancel what I armed last time, then arm what's due now"
// pass over ONE shared set of native alarms and ONE stored id list. Overlapping passes could leave an
// alarm armed that no list mentioned any more — it then rang forever, long after its medicine was
// edited or deleted. So every call goes through this queue (passes never overlap), and a pass that a
// newer call has already superseded is skipped outright — only the latest data matters.
let queue: Promise<void> = Promise.resolve();
let latestSeq = 0;

export function scheduleMedicineReminders(medicines: Medicine[], currentUid?: string, ownerNames?: Record<string, string>): Promise<void> {
  const seq = ++latestSeq;
  const run = queue.then(async () => {
    if (seq !== latestSeq) return;
    await runSchedule(medicines, currentUid, ownerNames);
  });
  queue = run.catch(() => {});
  return run;
}

async function runSchedule(medicines: Medicine[], currentUid?: string, ownerNames?: Record<string, string>) {
  if (!Capacitor.isNativePlatform()) return; // no native alarms on web
  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return;
  try {
    await ensureAlarmClockSanitized();

    // A native recurring alarm (Android AlarmClock, iOS's cron-style `on`/`every` trigger) has no
    // built-in expiry — scheduleAlarm() below just means "ring every day/N days/these weekdays",
    // forever, until explicitly cancelled. Filtering on `m.active`/`m.remindersEnabled` alone (the
    // old behavior) never excluded a medicine whose fixed-length course (dayCount/endDate) had
    // already elapsed, so e.g. a 1-day course kept ringing daily past its end date until someone
    // manually paused or deleted it — this is what actually stops it, not just "reopen the app".
    const todayStr = toLocalDateString(new Date());
    const active = medicines.filter((m) => {
      if (!m.active || !m.remindersEnabled) return false;
      const end = medicineEndDateStr(m);
      return !end || todayStr <= end;
    });
    const scheduledIds: number[] = [];
    const iosNotifications: any[] = [];

    // Two (or more) medicines due at the exact same moment used to each get their OWN alarm — on
    // Android that meant two separate full-screen AlarmActivity takeovers (and two overlapping
    // ringtones) firing at once, since AlarmManager has no concept of "these are really one event".
    // Grouped here by a signature covering everything that has to match for two slots to truly BE
    // the same alarm: the clock time, AND the exact recurrence rule (every day / the same explicit
    // weekday set / the same interval-days schedule) — two medicines that only coincidentally share
    // a clock time but ring on different days still get their own alarms, correctly. Deliberately
    // NOT scoped to one owner — a delegate managing two different people's 8am medicines hears one
    // combined alarm too, same as one person's own two medicines would.
    interface AndroidGroup {
      hour: number; minute: number; weekdays: number[]; intervalDays?: number; startDate?: string;
      items: { med: Medicine; slot: MedicineDoseTime }[];
    }
    const androidGroups = new Map<string, AndroidGroup>();

    for (const med of active) {
      for (const slot of med.times) {
        const [hour, minute] = slot.time.split(':').map(Number);
        const body = `${ownerPrefix(med, currentUid, ownerNames)}${med.name}${med.dosage ? ` (${med.dosage})` : ''} — ${slot.label}`;
        const alternating = !!med.intervalDays && med.intervalDays > 1;
        const everyDay = !alternating && (med.weekdays.length === 0 || med.weekdays.length === 7);

        if (platform === 'android') {
          const weekdaysForAlarm = alternating || everyDay ? [] : [...med.weekdays].sort((a, b) => a - b);
          const signature = alternating
            ? `${hour}:${minute}|i${med.intervalDays}|${med.startDate}`
            : `${hour}:${minute}|w${weekdaysForAlarm.join(',')}`;
          if (!androidGroups.has(signature)) {
            androidGroups.set(signature, {
              hour, minute, weekdays: weekdaysForAlarm,
              intervalDays: alternating ? med.intervalDays! : undefined,
              startDate: alternating ? med.startDate : undefined,
              items: [],
            });
          }
          androidGroups.get(signature)!.items.push({ med, slot });
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

    // Work out every Android alarm first (pure), so the full set of ids that are ABOUT to be armed is
    // known before anything is cancelled or armed.
    const androidPlans: Parameters<typeof scheduleAlarm>[0][] = [];
    if (platform === 'android') {
      for (const group of androidGroups.values()) {
        // Sorted so the id (and therefore whether this group is treated as "already scheduled" vs
        // new on the next reconcile) doesn't depend on iteration order — only on WHICH med/slot
        // pairs are actually in it.
        const key = group.items.map((it) => `med_${it.med.id}_${it.slot.id}`).sort().join('|');
        const id = hashId(key);
        scheduledIds.push(id);
        const body = group.items
          .map((it) => `${ownerPrefix(it.med, currentUid, ownerNames)}${it.med.name}${it.med.dosage ? ` (${it.med.dosage})` : ''} — ${it.slot.label}`)
          .join('; ');
        androidPlans.push({
          id,
          title: group.items.length > 1 ? `Medicine reminder (${group.items.length} due)` : 'Medicine reminder',
          body,
          hour: group.hour,
          minute: group.minute,
          weekdays: group.weekdays,
          intervalDays: group.intervalDays,
          startDate: group.startDate,
          route: '/health/medicines',
          feature: 'medicine',
          // The phone silences this alarm itself once every medicine in it has finished its course
          // (a group is only open-ended if one of its medicines is).
          endDate: group.items.every((it) => !!medicineEndDateStr(it.med))
            ? group.items.map((it) => medicineEndDateStr(it.med)!).sort().slice(-1)[0]
            : '',
        });
      }
    }

    // Cancel what the last pass armed (by id, not a blanket cancel-all — AlarmClock is shared with the
    // vaccine reminders)...
    const previousIds = readScheduledIds();
    if (platform === 'android') {
      for (const id of previousIds) await cancelAlarm(id);
    } else {
      await cancelIosIds(previousIds);
    }

    // ...record what is ABOUT to be armed BEFORE arming any of it. This list used to be saved only
    // after every alarm had been scheduled, so a failure part-way (or the app being killed mid-pass)
    // left real alarms that no stored list mentioned — impossible to cancel later.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheduledIds));
    // ...and tell the phone this is now the ONLY set of medicine alarms allowed to ring.
    if (platform === 'android') await setApprovedAlarmIds('medicine', scheduledIds);

    for (const plan of androidPlans) await scheduleAlarm(plan);
    if (platform === 'ios' && iosNotifications.length > 0) {
      await LocalNotifications.schedule({ notifications: iosNotifications });
    }
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
