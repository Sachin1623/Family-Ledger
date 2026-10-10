import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { scheduleAlarm, cancelAlarm, ensureAlarmClockSanitized, setApprovedAlarmIds } from './alarmClock';
import { VaccineDose, VaccineAppointment, ReminderPrefs, BabyProfile, DEFAULT_REMINDER_PREFS, vaccineAppointmentId } from './vaccinations';
import { toLocalDateString, parseLocalDate, combineLocalDateAndTime } from './dateUtils';

// Vaccine reminders are deliberately a MIX of two different mechanisms, unlike medicines (which
// are uniformly alarm-clock-style on Android) — most of the run-up to a visit is a plain,
// dismissible notice; only the moment that actually needs someone to physically go somewhere gets
// a real ringing alarm. Exact rule (specified by the user, not a general design choice), each
// category individually switchable via a profile's own ReminderPrefs (see VaccineReminders.tsx):
//
//   Appointment BOOKED (date + time known):
//     - [leadUpNotices] Plain notifications 3, 2 and 1 day before the appointment date.
//     - [dayOfAlarm] One ALARM 2 hours before the appointment's actual date+time — "get ready and
//       leave". No generic day-of alarm; this one already covers that, at the real time.
//   Appointment NOT booked and not marked "walk-in":
//     - [leadUpNotices] Plain notifications 3, 2 and 1 day before the due date, nudging to book.
//     - [dayOfAlarm] One ALARM at 9am on the due date itself — a safety net in case every earlier
//       notice was missed by every caregiver.
//     - [overdueRecurring] Once the due date has passed with nothing resolved, an ALARM every 3
//       days at 10am specifically to prompt scheduling an appointment (starts 3 days after the due
//       date, so it never doubles up with the 9am due-date alarm on the same day).
//   Marked "walk-in" (parent explicitly said no appointment is needed):
//     - [dayOfAlarm] Same 9am-on-due-date safety-net alarm as the not-booked case.
//     - No booking nudges and no overdue-recurring nag — both are about GETTING an appointment,
//       which they've already said they don't need.
//
// The native AlarmClock plugin (alarmClock.ts) only understands RECURRING schedules (a weekday
// set, or an every-N-days interval from an anchor date) — there's no "fire once on this exact
// date" mode, and adding one would mean touching native Java and needing a real APK rebuild to
// test. A one-shot alarm is instead scheduled as an interval-based recurrence with a huge interval
// (100 years) anchored at the target date: `computeNextTrigger` (AlarmScheduler.java) finds the
// occurrence at diff=0 first (the target date itself, since 0 % anything is 0), and the NEXT
// occurrence after it lands 100 years later, which any future reconcile pass (this function,
// re-run on every data change, same "cancel everything, reschedule from current state" pattern
// medicineReminders.ts already uses) will have long since cancelled and replaced. The
// overdueRecurring alarm needs no such hack — "every 3 days" is a genuine native interval
// schedule. No native code changes anywhere here, so this all ships through the JS bundle alone.
const ONE_SHOT_INTERVAL_DAYS = 36500;

const ANDROID_IDS_KEY = 'familyledger_vaccine_alarm_ids';
const NOTIF_IDS_KEY = 'familyledger_vaccine_notification_ids';

function hashId(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash) || 1;
}

function readIds(key: string): number[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function scheduleOneShotAlarm(id: number, title: string, body: string, at: Date, route: string) {
  await scheduleAlarm({
    id, title, body,
    hour: at.getHours(), minute: at.getMinutes(),
    weekdays: [],
    intervalDays: ONE_SHOT_INTERVAL_DAYS,
    startDate: toLocalDateString(at),
    route,
    feature: 'vaccine',
    endDate: toLocalDateString(at), // a one-shot: it may only ring on its own day
  });
}

export interface VisitGroup {
  profileId: string;
  profileName: string;
  visitKey: string;
  visitLabel: string;
  dueDate: string;
  doses: VaccineDose[];
  reminderPrefs: ReminderPrefs;
}

// Groups a flat, possibly MULTI-profile dose list into one VisitGroup per (profile, visitKey) —
// the multi-profile analog of BabyVaccinations.tsx's own single-profile groupIntoVisits, used
// anywhere reminders need to be reconciled across every profile the viewer can act on at once
// (GlobalVaccineReminderScheduler.tsx) rather than just whichever one happens to be "active" in
// the UI right now.
export function groupDosesIntoVisits(doseList: VaccineDose[], profilesById: Map<string, BabyProfile>): VisitGroup[] {
  const byKey = new Map<string, VisitGroup>();
  doseList.forEach((d) => {
    const profile = profilesById.get(d.profileId);
    if (!profile) return;
    const key = `${d.profileId}_${d.visitKey}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        profileId: profile.id, profileName: profile.name, visitKey: d.visitKey,
        visitLabel: d.visitLabel, dueDate: d.dueDate, doses: [],
        reminderPrefs: profile.reminderPrefs || DEFAULT_REMINDER_PREFS,
      });
    }
    byKey.get(key)!.doses.push(d);
  });
  return Array.from(byKey.values()).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// Every native alarm / local-notification id a visit can ever own, derived purely from
// (profileId, visitKey) — the same hashing scheduleVaccineReminders uses below. This is what lets a
// visit's reminders be cancelled with certainty even when the stored "ids I armed last time" list
// (localStorage) is missing, stale or was never written: an alarm armed for a visit that has since
// been deleted would otherwise be unreachable and keep ringing on its own recurring schedule
// (the native overdue alarm repeats every 3 days until something cancels that exact id).
function idsForVisit(profileId: string, visitKey: string): { alarmIds: number[]; notifIds: number[] } {
  const baseKey = `vax_${profileId}_${visitKey}`;
  const alarmIds = ['_leave', '_dueday', '_overdue'].map((s) => hashId(`${baseKey}${s}`));
  const notifIds: number[] = [];
  [3, 2, 1].forEach((d) => {
    notifIds.push(hashId(`${baseKey}_notice_${d}`), hashId(`${baseKey}_book_${d}`));
  });
  notifIds.push(hashId(`${baseKey}_leave`), hashId(`${baseKey}_dueday`));
  for (let i = 0; i < 20; i++) notifIds.push(hashId(`${baseKey}_overdue_${i}`));
  return { alarmIds, notifIds };
}

async function cancelIds(platform: string, alarmIds: number[], notifIds: number[]) {
  if (platform === 'android') {
    for (const id of new Set(alarmIds)) await cancelAlarm(id);
  }
  const uniqueNotif = Array.from(new Set(notifIds));
  if (uniqueNotif.length > 0) {
    await LocalNotifications.cancel({ notifications: uniqueNotif.map((id) => ({ id })) });
  }
}

export interface KnownVisit {
  profileId: string;
  visitKey: string;
}

// scheduleVaccineReminders / cancelVaccineRemindersForVisit all touch ONE shared set of native
// alarms and ONE shared id list in localStorage, but are called from several places at once
// (GlobalVaccineReminderScheduler.tsx, BabyVaccinations.tsx, the delete handlers) — each run is a
// multi-await "cancel everything, then re-arm" pass. Interleaved, a slower run holding OLDER data
// could finish arming a since-deleted visit's alarm AFTER a newer run had already cancelled it and
// recorded its (shorter) id list, leaving an armed alarm nothing tracks any more. Every call goes
// through this one queue so passes can never overlap, and a pass superseded by a newer schedule
// request is skipped outright (only the latest data matters).
let queue: Promise<void> = Promise.resolve();
let latestScheduleSeq = 0;

function enqueue(job: () => Promise<void>): Promise<void> {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
}

// Re-derives the full reminder set from scratch for every visit that still has a pending dose —
// call whenever a caller's own doses or appointments change (add/edit/log/cancel), mirroring
// scheduleMedicineReminders' own "cancel everything, reschedule from current state" contract.
// `knownVisits` should list EVERY (profile, visit) that exists in the data — including deleted and
// fully-completed ones — so their derivable ids get cancelled even if they're missing from the
// stored list.
export function scheduleVaccineReminders(
  visitGroups: VisitGroup[],
  appointmentsById: Map<string, VaccineAppointment>,
  knownVisits: KnownVisit[] = [],
): Promise<void> {
  const seq = ++latestScheduleSeq;
  return enqueue(async () => {
    if (seq !== latestScheduleSeq) return;
    await runSchedule(visitGroups, appointmentsById, knownVisits);
  });
}

// Surgical cancel for one visit (delete handlers) — unlike cancelling everything, this leaves every
// other baby's/visit's alarms alone, and it works from the derived ids so it doesn't depend on the
// stored list at all.
export function cancelVaccineRemindersForVisit(profileId: string, visitKey: string): Promise<void> {
  return enqueue(async () => {
    if (!Capacitor.isNativePlatform()) return;
    const platform = Capacitor.getPlatform();
    if (platform !== 'android' && platform !== 'ios') return;
    try {
      const { alarmIds, notifIds } = idsForVisit(profileId, visitKey);
      await cancelIds(platform, alarmIds, notifIds);
    } catch (err) {
      console.error('Failed to cancel vaccine reminders for visit:', err);
    }
  });
}

type AlarmJob =
  | { kind: 'oneShot'; id: number; title: string; body: string; at: Date }
  | { kind: 'recurring'; id: number; title: string; body: string; startDate: string };

async function runSchedule(
  visitGroups: VisitGroup[],
  appointmentsById: Map<string, VaccineAppointment>,
  knownVisits: KnownVisit[],
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return;

  try {
    await ensureAlarmClockSanitized();
    const route = '/baby-vaccinations';
    const now = new Date();
    const alarmJobs: AlarmJob[] = [];
    const notifications: any[] = [];

    const pending = visitGroups.filter((v) => v.doses.some((d) => d.status === 'pending'));

    for (const visit of pending) {
      const appt = appointmentsById.get(vaccineAppointmentId(visit.profileId, visit.visitKey));
      const prefs = visit.reminderPrefs;
      const label = `${visit.profileName}'s ${visit.visitLabel}`;
      const doseNames = visit.doses.filter((d) => d.status === 'pending').map((d) => `${d.vaccineName}${d.doseNumber ? `·${d.doseNumber}` : ''}`).join(', ');
      const baseKey = `vax_${visit.profileId}_${visit.visitKey}`;

      if (appt?.booked && appt.date && appt.time) {
        if (prefs.leadUpNotices) {
          [3, 2, 1].forEach((daysBefore) => {
            const noticeAt = new Date(parseLocalDate(appt.date!).getTime() - daysBefore * 86400000);
            noticeAt.setHours(9, 0, 0, 0);
            if (noticeAt <= now) return;
            notifications.push({
              id: hashId(`${baseKey}_notice_${daysBefore}`),
              title: `${label} in ${daysBefore} day${daysBefore > 1 ? 's' : ''}`,
              body: `Appointment ${appt.date} at ${appt.time}${appt.clinic ? ` — ${appt.clinic}` : ''}`,
              schedule: { at: noticeAt, allowWhileIdle: true },
              extra: { type: 'vaccine_appointment_reminder', profileId: visit.profileId, visitKey: visit.visitKey },
            });
          });
        }
        if (prefs.dayOfAlarm) {
          const apptDateTime = combineLocalDateAndTime(appt.date, appt.time);
          const alarmAt = new Date(apptDateTime.getTime() - 2 * 3600000);
          if (alarmAt > now) {
            if (platform === 'android') {
              alarmJobs.push({ kind: 'oneShot', id: hashId(`${baseKey}_leave`), title: `Time to leave for ${label}`, body: `Appointment at ${appt.time}${appt.clinic ? ` — ${appt.clinic}` : ''}. Get ready to go.`, at: alarmAt });
            } else {
              notifications.push({
                id: hashId(`${baseKey}_leave`),
                title: `Time to leave for ${label}`,
                body: `Appointment at ${appt.time}${appt.clinic ? ` — ${appt.clinic}` : ''}. Get ready to go.`,
                sound: 'default', interruptionLevel: 'timeSensitive',
                schedule: { at: alarmAt, allowWhileIdle: true },
                extra: { type: 'vaccine_leave_reminder', profileId: visit.profileId, visitKey: visit.visitKey },
              });
            }
          }
        }
      } else {
        if (prefs.leadUpNotices && !appt?.walkIn) {
          [3, 2, 1].forEach((daysBefore) => {
            const noticeAt = new Date(parseLocalDate(visit.dueDate).getTime() - daysBefore * 86400000);
            noticeAt.setHours(9, 0, 0, 0);
            if (noticeAt <= now) return;
            notifications.push({
              id: hashId(`${baseKey}_book_${daysBefore}`),
              title: `${label} in ${daysBefore} day${daysBefore > 1 ? 's' : ''} — no appointment yet`,
              body: `${doseNames}. Book a clinic visit, or mark it as a walk-in.`,
              schedule: { at: noticeAt, allowWhileIdle: true },
              extra: { type: 'vaccine_booking_nudge', profileId: visit.profileId, visitKey: visit.visitKey },
            });
          });
        }
        if (prefs.dayOfAlarm) {
          const dueAt = parseLocalDate(visit.dueDate);
          dueAt.setHours(9, 0, 0, 0);
          if (dueAt > now) {
            if (platform === 'android') {
              alarmJobs.push({ kind: 'oneShot', id: hashId(`${baseKey}_dueday`), title: `${label} is due today`, body: doseNames, at: dueAt });
            } else {
              notifications.push({
                id: hashId(`${baseKey}_dueday`),
                title: `${label} is due today`,
                body: doseNames,
                sound: 'default', interruptionLevel: 'timeSensitive',
                schedule: { at: dueAt, allowWhileIdle: true },
                extra: { type: 'vaccine_due_today', profileId: visit.profileId, visitKey: visit.visitKey },
              });
            }
          }
        }
        // Once overdue, nag every 3 days to actually book — starts 3 days AFTER the due date so it
        // never lands on the same day as the dayOfAlarm one-off above. Never fires for a walk-in
        // (there's nothing left to "schedule").
        if (prefs.overdueRecurring && !appt?.walkIn) {
          const overdueStart = new Date(parseLocalDate(visit.dueDate).getTime() + 3 * 86400000);
          overdueStart.setHours(10, 0, 0, 0);
          const overdueBody = `${doseNames}. Schedule an appointment.`;
          if (platform === 'android') {
            alarmJobs.push({ kind: 'recurring', id: hashId(`${baseKey}_overdue`), title: `${label} is overdue`, body: overdueBody, startDate: toLocalDateString(overdueStart) });
          } else {
            // iOS's LocalNotifications `every` cron only supports day/week/month/year, not an
            // arbitrary N-day interval — approximated with a bounded batch of one-shot occurrences,
            // same pattern medicineReminders.ts already uses for a medicine's own "alternate days".
            for (let i = 0; i < 20; i++) {
              const occ = new Date(overdueStart.getTime() + i * 3 * 86400000);
              if (occ <= now) continue;
              notifications.push({
                id: hashId(`${baseKey}_overdue_${i}`),
                title: `${label} is overdue`,
                body: overdueBody,
                sound: 'default', interruptionLevel: 'timeSensitive',
                schedule: { at: occ, allowWhileIdle: true },
                extra: { type: 'vaccine_overdue_reminder', profileId: visit.profileId, visitKey: visit.visitKey },
              });
            }
          }
        }
      }
    }

    // Cancel EVERYTHING that could be armed: what the last run recorded, plus every id derivable
    // from any visit we know about (active, completed or deleted).
    const previousAlarmIds = readIds(ANDROID_IDS_KEY);
    const previousNotifIds = readIds(NOTIF_IDS_KEY);
    const derivedAlarmIds: number[] = [];
    const derivedNotifIds: number[] = [];
    const seen = new Set<string>();
    [...visitGroups.map((v) => ({ profileId: v.profileId, visitKey: v.visitKey })), ...knownVisits].forEach((v) => {
      const k = `${v.profileId}_${v.visitKey}`;
      if (seen.has(k)) return;
      seen.add(k);
      const ids = idsForVisit(v.profileId, v.visitKey);
      derivedAlarmIds.push(...ids.alarmIds);
      derivedNotifIds.push(...ids.notifIds);
    });
    await cancelIds(platform, [...previousAlarmIds, ...derivedAlarmIds], [...previousNotifIds, ...derivedNotifIds]);

    // Write-ahead: record what's ABOUT to be armed before arming any of it. Previously the list was
    // only saved after every alarm had been scheduled, so a failure part-way (or the app being
    // killed mid-pass) left real native alarms that no stored list mentioned — unreachable by any
    // later cancel and ringing forever.
    const desiredAlarmIds = alarmJobs.map((j) => j.id);
    const desiredNotifIds = notifications.map((n) => n.id);
    localStorage.setItem(ANDROID_IDS_KEY, JSON.stringify(desiredAlarmIds));
    localStorage.setItem(NOTIF_IDS_KEY, JSON.stringify(desiredNotifIds));
    // The phone may ring ONLY these vaccine alarms from now on — set before arming any of them.
    if (platform === 'android') await setApprovedAlarmIds('vaccine', desiredAlarmIds);

    for (const job of alarmJobs) {
      if (job.kind === 'oneShot') {
        await scheduleOneShotAlarm(job.id, job.title, job.body, job.at, route);
      } else {
        await scheduleAlarm({
          id: job.id, title: job.title, body: job.body,
          hour: 10, minute: 0, weekdays: [],
          intervalDays: 3, startDate: job.startDate,
          route,
          feature: 'vaccine',
        });
      }
    }
    if (notifications.length > 0) {
      await LocalNotifications.schedule({ notifications });
    }
  } catch (err) {
    console.error('Failed to schedule vaccine reminders:', err);
  }
}
