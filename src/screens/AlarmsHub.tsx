import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { collection, doc, query, updateDoc, deleteDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { toLocalDateString, parseLocalDate, combineLocalDateAndTime } from '../lib/dateUtils';
import { Medicine, medicineEndDateStr } from '../lib/medicines';
import { scheduleMedicineReminders } from '../lib/medicineReminders';
import { useMedicineDelegators } from '../lib/useMedicineDelegators';
import { useVaccineCaregivers } from '../lib/useVaccineCaregivers';
import { GENERAL_INCIDENT_ID } from '../lib/medicalIncidents';
import { DEFAULT_BP_REMINDERS, BpReminderSettings, BpReminderTime } from '../lib/bloodPressure';
import { scheduleBpReminders } from '../lib/bpReminders';
import { DEFAULT_GLUCOSE_REMINDERS, GlucoseReminderSettings } from '../lib/health';
import { scheduleGlucoseReminders } from '../lib/healthReminders';
import { DEFAULT_REMINDER_PREFS } from '../lib/vaccinations';
import { SharedReminder, describeCadence, nextOccurrence } from '../lib/sharedReminders';
import { scheduleSharedReminders } from '../lib/sharedReminderNotifications';
import { cancelLocalTodoReminder } from '../lib/localReminders';

// One place to see everything on THIS device that's set up to ring/notify at a scheduled time —
// medicines, health check reminders, vaccination visits, shared reminders, to-do reminders — and
// stop or delete any of them without having to know which of the app's many screens actually owns
// that schedule. Built after a real incident: a delegate kept hearing a medicine alarm for a
// course that had already ended, with no way to see (let alone kill) it short of opening Medicines
// and hunting for the right toggle. See GlobalMedicineReminderScheduler.tsx's own comment for the
// root cause that incident uncovered (delegate medicines weren't in the app-root reconciler at
// all) — this screen is the "let the user just look at and manage what's ringing" companion fix.
//
// Deliberately reads the exact same source data each feature's own scheduler function reads from
// (medicines, users/{uid}.bpReminders/glucoseReminders, babyProfiles, sharedReminders, todos) and
// applies the exact same "active" filter each one uses internally, so what's listed here always
// matches what's actually armed on the device — never a separate, driftable source of truth.
//
// Medicine / BP / Glucose / Shared Reminders all reschedule immediately after a stop/delete here
// (same reconcile call each feature's own screen uses, just fired eagerly instead of waiting for
// that screen to be reopened) — a to-do reminder is cancelled directly, one id, no reschedule
// needed. Vaccination is the one exception: reminderPrefs live per BABY PROFILE, and precisely
// recomputing its alarms needs that profile's full doses+appointments, which this screen doesn't
// otherwise load — so stopping a profile's vaccination reminders here updates Firestore right away
// (the alarms will stop being scheduled from then on) but the currently-armed ones only get
// explicitly cancelled the next time Baby Vaccinations itself is opened, same best-effort,
// clearly-flagged tradeoff this codebase already accepts elsewhere for on-device-only reminders.

type Category = 'medicine' | 'bp' | 'glucose' | 'vaccination' | 'shared' | 'todo';

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function fmtNext(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const datePart = sameDay ? 'Today' : isTomorrow ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `Next: ${datePart} at ${fmtTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)}`;
}

// Next concrete fire date+time for a daily/weekly/interval-days recurring reminder at `time`
// ('HH:mm') — shared by Medicine/BP/Glucose (each has its own recurrence shape but they all
// reduce to "every day", "these weekdays", or "every N days from an anchor date").
function nextFireAt(time: string, opts: { weekdays?: number[]; intervalDays?: number | null; startDate?: string }): Date {
  const [hh, mm] = time.split(':').map(Number);
  const now = new Date();
  if (opts.intervalDays && opts.intervalDays > 1 && opts.startDate) {
    const [sy, sm, sd] = opts.startDate.split('-').map(Number);
    let candidate = new Date(sy, sm - 1, sd, hh, mm);
    while (candidate <= now) candidate = new Date(candidate.getTime() + opts.intervalDays * 86400000);
    return candidate;
  }
  const weekdays = opts.weekdays || [];
  const everyDay = weekdays.length === 0 || weekdays.length === 7;
  if (everyDay) {
    let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
    if (candidate <= now) candidate = new Date(candidate.getTime() + 86400000);
    return candidate;
  }
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm);
    if (weekdays.includes(d.getDay()) && d > now) return d;
  }
  return new Date(now.getTime() + 7 * 86400000);
}

interface AlarmItem {
  key: string;
  title: string;
  subtitle: string;
  actions: { label: string; danger: boolean; warning: string; onConfirm: () => Promise<void> }[];
}

const Tile: React.FC<{ icon: string; label: string; count: number; onClick: () => void }> = ({ icon, label, count, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 bg-white rounded-2xl border border-border-subtle shadow-sm p-4 text-left active:scale-[0.99] transition-transform"
    >
      <span className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <span className="material-symbols-outlined text-[22px]">{icon}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-on-surface">{label}</p>
        <p className="text-xs text-text-muted mt-0.5">{count === 0 ? 'No active alarms' : `${count} active alarm${count === 1 ? '' : 's'}`}</p>
      </div>
      <span className="material-symbols-outlined text-text-muted text-[20px]">chevron_right</span>
    </button>
  );
};

// The trigger button AND its confirm modal, reused everywhere an alarm-cancelling action needs a
// "here's what you'll miss" warning before it commits — the flat per-category lists (ItemRow) and
// the Medicine hierarchy's dose/medicine/incident-level cancel buttons alike.
type AlarmAction = AlarmItem['actions'][number];
const ConfirmButton: React.FC<{ action: AlarmAction; small?: boolean }> = ({ action, small }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await action.onConfirm();
      setOpen(false);
    } catch (err) {
      console.error('Failed to update alarm:', err);
      alert('Something went wrong — please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${small ? 'px-2.5 py-1 text-[11px]' : 'px-3.5 py-1.5 text-xs'} font-bold rounded-lg ${action.danger ? 'bg-error/10 text-error' : 'bg-surface border border-border-subtle text-text-muted'}`}
      >
        {action.label}
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => !busy && setOpen(false)}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-black text-on-surface">{action.label}</p>
            <p className="text-sm text-text-muted mt-2 leading-relaxed">{action.warning}</p>
            <div className="flex items-center gap-2 mt-4">
              <button type="button" onClick={() => setOpen(false)} disabled={busy} className="flex-1 px-4 py-2.5 bg-surface border border-border-subtle text-on-surface text-sm font-bold rounded-xl disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={run} disabled={busy} className="flex-1 px-4 py-2.5 bg-error text-white text-sm font-bold rounded-xl disabled:opacity-50">
                {busy ? 'Working…' : action.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const ItemRow: React.FC<{ item: AlarmItem }> = ({ item }) => (
  <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3.5">
    <p className="text-sm font-bold text-on-surface">{item.title}</p>
    <p className="text-xs text-text-muted mt-0.5">{item.subtitle}</p>
    <div className="flex items-center gap-2 mt-2.5">
      {item.actions.map((a) => <ConfirmButton key={a.label} action={a} />)}
    </div>
  </div>
);

export default function AlarmsHub() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  // Drill-down level lives in the URL (not component state) so the app's single global back
  // button/Android hardware-back (both driven by navigationParents.ts's getParentPath) step back
  // one level at a time — no separate in-page back buttons needed. See getParentPath's own
  // '/alarms' special case for how each level's parent is computed from these same params.
  const [searchParams] = useSearchParams();
  const category = searchParams.get('cat') as Category | null;

  // --- shared groupIds (medicine-delegate + shared-reminders queries both need it) ---
  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = useMemo(() => membershipsValue?.docs.map((d) => d.data().groupId as string) || [], [membershipsValue]);

  // --- Medicines (own + delegated), grouped Person -> Incident -> Medicine -> Dose ---
  const { medicines, ownerNames } = useMedicineDelegators(user?.uid);
  const todayStr = toLocalDateString(new Date());
  const activeMedicines = useMemo(
    () => medicines.filter((m) => {
      if (!m.active || !m.remindersEnabled) return false;
      const end = medicineEndDateStr(m);
      return !end || todayStr <= end;
    }),
    [medicines, todayStr],
  );
  const delegatorUidsForIncidents = useMemo(() => Array.from(new Set(activeMedicines.map((m) => m.userId))), [activeMedicines]);
  const [medicalIncidentsValue] = useCollection(
    delegatorUidsForIncidents.length > 0 ? query(collection(db, 'medicalIncidents'), where('userId', 'in', delegatorUidsForIncidents.slice(0, 30))) : null,
  );
  const incidentNameById = useMemo(() => {
    const map: Record<string, string> = {};
    medicalIncidentsValue?.docs.forEach((d) => { map[d.id] = (d.data() as any).name; });
    return map;
  }, [medicalIncidentsValue]);

  const stopMedicineReminders = async (medId: string) => {
    await updateDoc(doc(db, 'medicines', medId), { remindersEnabled: false });
    const updated = medicines.map((x) => (x.id === medId ? { ...x, remindersEnabled: false } : x));
    await scheduleMedicineReminders(updated, user!.uid, ownerNames);
  };
  const stopIncidentReminders = async (medIds: string[]) => {
    await Promise.all(medIds.map((id) => updateDoc(doc(db, 'medicines', id), { remindersEnabled: false })));
    const updated = medicines.map((x) => (medIds.includes(x.id) ? { ...x, remindersEnabled: false } : x));
    await scheduleMedicineReminders(updated, user!.uid, ownerNames);
  };
  // A single dose-time slot is removed outright rather than flagged — Medicine has no per-slot
  // enabled bit, and firestore.rules requires `times.size() > 0`, so cancelling the LAST remaining
  // slot instead falls back to stopping the whole medicine (same end result — no more alarms for
  // it — without ever writing an invalid empty `times` array).
  const cancelDose = async (med: Medicine, slotId: string) => {
    if (med.times.length <= 1) { await stopMedicineReminders(med.id); return; }
    const updatedTimes = med.times.filter((s) => s.id !== slotId);
    await updateDoc(doc(db, 'medicines', med.id), { times: updatedTimes });
    const updated = medicines.map((x) => (x.id === med.id ? { ...x, times: updatedTimes } : x));
    await scheduleMedicineReminders(updated, user!.uid, ownerNames);
  };

  const medPersonGroups = useMemo(() => {
    const map = new Map<string, Medicine[]>();
    activeMedicines.forEach((m) => {
      if (!map.has(m.userId)) map.set(m.userId, []);
      map.get(m.userId)!.push(m);
    });
    const uids = Array.from(map.keys()).sort((a, b) => (a === user?.uid ? -1 : b === user?.uid ? 1 : 0));
    return uids.map((uid) => ({ uid, label: uid === user?.uid ? 'You' : (ownerNames[uid] || 'Someone'), medicines: map.get(uid)! }));
  }, [activeMedicines, user, ownerNames]);
  const medPersonUid = searchParams.get('person');
  const medIncidentKey = searchParams.get('incident');
  const medIncidentGroups = useMemo(() => {
    if (!medPersonUid) return [];
    const map = new Map<string, Medicine[]>();
    activeMedicines.filter((m) => m.userId === medPersonUid).forEach((m) => {
      const key = m.incidentId || GENERAL_INCIDENT_ID;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    });
    return Array.from(map.entries()).map(([key, meds]) => ({
      key,
      label: key === GENERAL_INCIDENT_ID ? 'General' : (incidentNameById[key] || 'Incident'),
      medicines: meds,
    }));
  }, [activeMedicines, medPersonUid, incidentNameById]);
  const medPersonLabel = medPersonGroups.find((p) => p.uid === medPersonUid)?.label || '';
  const medIncidentLabel = medIncidentGroups.find((i) => i.key === medIncidentKey)?.label || '';
  const medMedicinesForIncident = medIncidentGroups.find((i) => i.key === medIncidentKey)?.medicines || [];

  // --- Blood Pressure reminders (self only — each device schedules its own) ---
  const bp: BpReminderSettings = profile?.bpReminders || DEFAULT_BP_REMINDERS;
  const bpItems: AlarmItem[] = bp.enabled ? bp.times.map((slot) => ({
    key: slot.id,
    title: `${slot.label || 'Blood pressure'} check`,
    subtitle: fmtNext(nextFireAt(slot.time, { weekdays: bp.cadence === 'weekly' ? bp.weekdays : [] })),
    actions: [{
      label: 'Delete',
      danger: true,
      warning: `You won't get a blood pressure reminder at ${fmtTime(slot.time)} anymore.`,
      onConfirm: async () => {
        const updated: BpReminderSettings = { ...bp, times: bp.times.filter((s: BpReminderTime) => s.id !== slot.id) };
        await updateDoc(doc(db, 'users', user!.uid), { bpReminders: updated });
        await scheduleBpReminders(updated);
      },
    }],
  })) : [];

  // --- Glucose reminders (self only) ---
  const glucose: GlucoseReminderSettings = profile?.glucoseReminders || DEFAULT_GLUCOSE_REMINDERS;
  const mealLabel: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
  // Mirrors healthReminders.ts's own private minusMinutes/plusHours exactly (needed here purely to
  // show the real next-fire time — the actual native scheduling still lives in that file).
  const glucoseTimes = (mealTime: string, afterHours: number) => {
    const [h, m] = mealTime.split(':').map(Number);
    const beforeTotal = (((h * 60 + m - 15) % 1440) + 1440) % 1440;
    const afterTotal = (((h * 60 + m + afterHours * 60) % 1440) + 1440) % 1440;
    const fmt = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    return { before: fmt(beforeTotal), after: fmt(afterTotal) };
  };
  const glucoseItems: AlarmItem[] = glucose.enabled ? glucose.meals.map((meal) => {
    const cfg = (glucose as any)[meal];
    const { before, after } = glucoseTimes(cfg.time, cfg.afterHours);
    const weekdays = glucose.cadence === 'weekly' ? glucose.weekdays : [];
    const nextBefore = fmtNext(nextFireAt(before, { weekdays }));
    const nextAfter = fmtNext(nextFireAt(after, { weekdays }));
    return {
      key: meal,
      title: `${mealLabel[meal]} glucose check`,
      subtitle: `Before — ${nextBefore}  ·  After — ${nextAfter}`,
      actions: [{
        label: 'Delete',
        danger: true,
        warning: `You won't get before/after-${mealLabel[meal].toLowerCase()} glucose reminders anymore.`,
        onConfirm: async () => {
          const updated: GlucoseReminderSettings = { ...glucose, meals: glucose.meals.filter((mm) => mm !== meal) };
          await updateDoc(doc(db, 'users', user!.uid), { glucoseReminders: updated });
          await scheduleGlucoseReminders(updated);
        },
      }],
    };
  }) : [];

  // --- Vaccination reminders (profiles you own OR have accepted caregiver access to, via the
  // shared useVaccineCaregivers hook — matching BabyVaccinations.tsx/GlobalVaccineReminderScheduler
  // .tsx, since that's what actually arms these alarms; an owner-only query here previously left a
  // caregiver's armed, firing alarms invisible in this list), grouped Baby -> Visit -> individual
  // alarm/notice occurrences, each with its own computed fire date+time. reminderPrefs
  // (leadUpNotices/dayOfAlarm/overdueRecurring) live per BABY PROFILE, not per visit —
  // vaccinationReminders.ts has no per-visit granularity to cancel into, so "cancel this one" here
  // means "turn off this CATEGORY for this baby" and says so plainly in the warning, rather than
  // pretending a finer-grained control exists than the schema actually has. "Change" routes to
  // VaccineReminders.tsx, the real per-profile settings screen, for anything beyond an outright
  // cancel.
  const { profiles: babyProfiles } = useVaccineCaregivers(user?.uid);
  const babyProfileIds = useMemo(() => babyProfiles.map((p: any) => p.id), [babyProfiles]);
  const [vaccineDosesValue] = useCollection(
    babyProfileIds.length > 0 ? query(collection(db, 'vaccineDoses'), where('profileId', 'in', babyProfileIds.slice(0, 30)), where('status', '==', 'pending')) : null,
  );
  const [vaccineAppointmentsValue] = useCollection(
    babyProfileIds.length > 0 ? query(collection(db, 'vaccineAppointments'), where('profileId', 'in', babyProfileIds.slice(0, 30))) : null,
  );
  const appointmentsByVisit = useMemo(() => {
    const map = new Map<string, any>();
    vaccineAppointmentsValue?.docs.forEach((d) => map.set(d.id, d.data()));
    return map;
  }, [vaccineAppointmentsValue]);

  interface VaxAlarmEntry { key: string; categoryLabel: string; firesAt: Date; prefKey: 'leadUpNotices' | 'dayOfAlarm' | 'overdueRecurring'; }
  interface VaxVisit { profileId: string; profileName: string; visitKey: string; visitLabel: string; dueDate: string; entries: VaxAlarmEntry[]; }

  const now = new Date();
  const vaxVisits: VaxVisit[] = useMemo(() => {
    const byVisit = new Map<string, { profileId: string; profileName: string; visitKey: string; visitLabel: string; dueDate: string }>();
    (vaccineDosesValue?.docs || []).forEach((d) => {
      const dose = d.data() as any;
      const profile = babyProfiles.find((p: any) => p.id === dose.profileId);
      if (!profile) return;
      const key = `${dose.profileId}_${dose.visitKey}`;
      if (!byVisit.has(key)) {
        byVisit.set(key, { profileId: dose.profileId, profileName: profile.name, visitKey: dose.visitKey, visitLabel: dose.visitLabel, dueDate: dose.dueDate });
      }
    });
    return Array.from(byVisit.values()).map((v) => {
      const profile = babyProfiles.find((p: any) => p.id === v.profileId);
      const prefs = profile?.reminderPrefs || DEFAULT_REMINDER_PREFS;
      const appt = appointmentsByVisit.get(`${v.profileId}_${v.visitKey}`);
      const entries: VaxAlarmEntry[] = [];
      const baseKey = `${v.profileId}_${v.visitKey}`;

      if (appt?.booked && appt.date && appt.time) {
        if (prefs.leadUpNotices) {
          [3, 2, 1].forEach((daysBefore) => {
            const at = new Date(parseLocalDate(appt.date).getTime() - daysBefore * 86400000);
            at.setHours(9, 0, 0, 0);
            if (at > now) entries.push({ key: `${baseKey}_notice_${daysBefore}`, categoryLabel: 'Lead-up notice', firesAt: at, prefKey: 'leadUpNotices' });
          });
        }
        if (prefs.dayOfAlarm) {
          const at = new Date(combineLocalDateAndTime(appt.date, appt.time).getTime() - 2 * 3600000);
          if (at > now) entries.push({ key: `${baseKey}_leave`, categoryLabel: 'Time-to-leave alarm', firesAt: at, prefKey: 'dayOfAlarm' });
        }
      } else {
        if (prefs.leadUpNotices && !appt?.walkIn) {
          [3, 2, 1].forEach((daysBefore) => {
            const at = new Date(parseLocalDate(v.dueDate).getTime() - daysBefore * 86400000);
            at.setHours(9, 0, 0, 0);
            if (at > now) entries.push({ key: `${baseKey}_book_${daysBefore}`, categoryLabel: 'Lead-up notice', firesAt: at, prefKey: 'leadUpNotices' });
          });
        }
        if (prefs.dayOfAlarm) {
          const at = parseLocalDate(v.dueDate);
          at.setHours(9, 0, 0, 0);
          if (at > now) entries.push({ key: `${baseKey}_dueday`, categoryLabel: 'Due-date alarm', firesAt: at, prefKey: 'dayOfAlarm' });
        }
        if (prefs.overdueRecurring && !appt?.walkIn) {
          let at = new Date(parseLocalDate(v.dueDate).getTime() + 3 * 86400000);
          at.setHours(10, 0, 0, 0);
          while (at <= now) at = new Date(at.getTime() + 3 * 86400000);
          entries.push({ key: `${baseKey}_overdue`, categoryLabel: 'Overdue reminder (repeats every 3 days)', firesAt: at, prefKey: 'overdueRecurring' });
        }
      }
      return { ...v, entries };
    }).filter((v) => v.entries.length > 0);
  }, [vaccineDosesValue, babyProfiles, appointmentsByVisit, now]);

  const stopVaxCategory = async (profileId: string, prefKey: 'leadUpNotices' | 'dayOfAlarm' | 'overdueRecurring') => {
    const profile = babyProfiles.find((p: any) => p.id === profileId);
    const prefs = profile?.reminderPrefs || DEFAULT_REMINDER_PREFS;
    await updateDoc(doc(db, 'babyProfiles', profileId), { reminderPrefs: { ...prefs, [prefKey]: false } });
  };

  const vaxBabyGroups = useMemo(() => {
    const map = new Map<string, VaxVisit[]>();
    vaxVisits.forEach((v) => {
      if (!map.has(v.profileId)) map.set(v.profileId, []);
      map.get(v.profileId)!.push(v);
    });
    return Array.from(map.entries()).map(([profileId, visits]) => ({
      profileId,
      profileName: visits[0].profileName,
      visits,
      alarmCount: visits.reduce((sum, v) => sum + v.entries.length, 0),
    }));
  }, [vaxVisits]);
  const vaxProfileId = searchParams.get('baby');
  const vaxVisitsForProfile = vaxBabyGroups.find((b) => b.profileId === vaxProfileId)?.visits || [];
  const vaccineItemCount = vaxVisits.reduce((sum, v) => sum + v.entries.length, 0);

  // --- Shared reminders (own + group + friend-targeted) ---
  const [ownRemindersValue] = useCollection(user ? query(collection(db, 'sharedReminders'), where('createdBy', '==', user.uid)) : null);
  const [groupRemindersValue] = useCollection(groupIds.length > 0 ? query(collection(db, 'sharedReminders'), where('groupId', 'in', groupIds)) : null);
  const [friendRemindersValue] = useCollection(user ? query(collection(db, 'sharedReminders'), where('friendUids', 'array-contains', user.uid)) : null);
  const sharedReminders: SharedReminder[] = useMemo(() => {
    const map = new Map<string, SharedReminder>();
    [ownRemindersValue, groupRemindersValue, friendRemindersValue].forEach((snap) => {
      snap?.docs.forEach((d) => map.set(d.id, { id: d.id, ...(d.data() as any) }));
    });
    return Array.from(map.values()).filter((r) => r.active);
  }, [ownRemindersValue, groupRemindersValue, friendRemindersValue]);
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // nextOccurrence only resolves to a DATE — if today's occurrence's time has already passed, roll
  // forward one day and re-resolve, so the shown fire time is always genuinely in the future.
  const sharedReminderNextFire = (r: SharedReminder): Date | null => {
    const todayStr = toLocalDateString(new Date());
    let occDate = nextOccurrence(r, todayStr);
    if (!occDate) return null;
    let at = combineLocalDateAndTime(occDate, r.time);
    if (at <= new Date()) {
      const tomorrowStr = toLocalDateString(new Date(Date.now() + 86400000));
      occDate = nextOccurrence(r, tomorrowStr);
      if (!occDate) return null;
      at = combineLocalDateAndTime(occDate, r.time);
    }
    return at;
  };
  const sharedItems: AlarmItem[] = sharedReminders.map((r) => {
    const next = sharedReminderNextFire(r);
    return {
    key: r.id,
    title: r.title,
    subtitle: `${describeCadence(r, t, weekdayLabels)} — ${next ? fmtNext(next) : 'no more occurrences'}`,
    actions: [
      {
        label: 'Pause',
        danger: false,
        warning: `You won't be notified for "${r.title}" until you turn it back on from Reminders.`,
        onConfirm: async () => {
          await updateDoc(doc(db, 'sharedReminders', r.id), { active: false });
          await scheduleSharedReminders(sharedReminders.filter((s) => s.id !== r.id));
        },
      },
      {
        label: 'Delete',
        danger: true,
        warning: `This permanently deletes "${r.title}" for everyone it's shared with — not just you.`,
        onConfirm: async () => {
          await deleteDoc(doc(db, 'sharedReminders', r.id));
          await scheduleSharedReminders(sharedReminders.filter((s) => s.id !== r.id));
        },
      },
    ],
  };
  });

  // --- To-do reminders (personal, non-group todos with a reminder set) ---
  const [todosValue] = useCollection(user ? query(collection(db, 'todos'), where('userId', '==', user.uid)) : null);
  const todoReminders = useMemo(
    () => (todosValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []).filter((td: any) => !td.done && !td.groupId && td.reminderAt),
    [todosValue],
  );
  const todoItems: AlarmItem[] = todoReminders.map((td: any) => ({
    key: td.id,
    title: td.text,
    subtitle: new Date(td.reminderAt).toLocaleString(),
    actions: [{
      label: 'Delete',
      danger: true,
      warning: `You won't get a reminder for "${td.text}" anymore. The to-do item itself stays on your list.`,
      onConfirm: async () => {
        await updateDoc(doc(db, 'todos', td.id), { reminderAt: null });
        await cancelLocalTodoReminder(td.id);
      },
    }],
  }));

  const FLAT_CATEGORY_META: Partial<Record<Category, { label: string; icon: string; items: AlarmItem[]; manageRoute: string; manageLabel: string }>> = {
    bp: { label: 'Blood Pressure Reminders', icon: 'monitor_heart', items: bpItems, manageRoute: '/health/blood-pressure', manageLabel: 'Manage in Blood Pressure' },
    glucose: { label: 'Glucose Reminders', icon: 'water_drop', items: glucoseItems, manageRoute: '/health/glucose', manageLabel: 'Manage in Glucose' },
    shared: { label: 'Shared Reminders', icon: 'notifications_active', items: sharedItems, manageRoute: '/reminders', manageLabel: 'Manage in Reminders' },
    todo: { label: 'To-Do Reminders', icon: 'checklist', items: todoItems, manageRoute: '/todo', manageLabel: 'Manage in To-Do' },
  };

  // --- Medicine Reminders: Person -> Incident -> Medicine (+ its doses) ---
  // No in-page back button at any level here — the URL carries the drill-down level (cat/person/
  // incident params), so the app's one global back button (Header.tsx's arrow, and the Android
  // hardware-back handler, both via navigationParents.ts's getParentPath) already steps back one
  // level at a time on its own.
  if (category === 'medicine') {
    if (!medPersonUid) {
      return (
        <div className="max-w-2xl mx-auto p-4 pb-24">
          <h1 className="text-xl font-black text-on-surface mb-4">Medicine Reminders</h1>
          {medPersonGroups.length === 0 ? (
            <p className="text-sm text-text-muted text-center mt-10">No active alarms in this category.</p>
          ) : (
            <div className="space-y-2.5">
              {medPersonGroups.map((p) => (
                <Tile key={p.uid} icon="person" label={p.label} count={p.medicines.length} onClick={() => navigate(`/alarms?cat=medicine&person=${p.uid}`)} />
              ))}
            </div>
          )}
        </div>
      );
    }
    if (!medIncidentKey) {
      return (
        <div className="max-w-2xl mx-auto p-4 pb-24">
          <h1 className="text-xl font-black text-on-surface mb-4">{medPersonLabel}</h1>
          <div className="space-y-2.5">
            {medIncidentGroups.map((inc) => (
              <Tile key={inc.key} icon="folder" label={inc.label} count={inc.medicines.length} onClick={() => navigate(`/alarms?cat=medicine&person=${medPersonUid}&incident=${inc.key}`)} />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-2xl mx-auto p-4 pb-24">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h1 className="text-xl font-black text-on-surface">{medIncidentLabel}</h1>
          <ConfirmButton
            small
            action={{
              label: 'Stop All for Incident',
              danger: true,
              warning: `This stops every reminder for all ${medMedicinesForIncident.length} medicine${medMedicinesForIncident.length === 1 ? '' : 's'} under "${medIncidentLabel}". Each medicine's record and dose log stay — you can turn reminders back on any time.`,
              onConfirm: () => stopIncidentReminders(medMedicinesForIncident.map((m) => m.id)),
            }}
          />
        </div>
        <div className="space-y-3">
          {medMedicinesForIncident.map((m) => (
            <div key={m.id} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-bold text-on-surface">{m.name}{m.dosage ? ` (${m.dosage})` : ''}</p>
                <ConfirmButton
                  small
                  action={{
                    label: 'Stop All',
                    danger: true,
                    warning: `You won't be reminded to take ${m.name}${m.dosage ? ` (${m.dosage})` : ''} anymore. The medicine record and dose log stay — you can turn reminders back on from Medicines any time.`,
                    onConfirm: () => stopMedicineReminders(m.id),
                  }}
                />
              </div>
              <div className="mt-2 space-y-1.5">
                {m.times.map((slot) => (
                  <div key={slot.id} className="flex items-center justify-between gap-3 bg-surface rounded-lg px-2.5 py-1.5">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-on-surface">{slot.label} — {fmtTime(slot.time)}</p>
                      <p className="text-[11px] text-text-muted">{fmtNext(nextFireAt(slot.time, { weekdays: m.weekdays, intervalDays: m.intervalDays, startDate: m.startDate }))}</p>
                    </div>
                    <ConfirmButton
                      small
                      action={{
                        label: 'Cancel',
                        danger: true,
                        warning: m.times.length <= 1
                          ? `${slot.label} is the only dose for ${m.name} — cancelling it stops all reminders for this medicine.`
                          : `You won't be reminded for the ${slot.label.toLowerCase()} dose of ${m.name} (${fmtTime(slot.time)}) anymore.`,
                        onConfirm: () => cancelDose(m, slot.id),
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // --- Vaccination Reminders: Baby -> Visit (+ its individual alarm/notice occurrences) ---
  if (category === 'vaccination') {
    if (!vaxProfileId) {
      return (
        <div className="max-w-2xl mx-auto p-4 pb-24">
          <h1 className="text-xl font-black text-on-surface mb-4">Vaccination Reminders</h1>
          {vaxBabyGroups.length === 0 ? (
            <p className="text-sm text-text-muted text-center mt-10">No active alarms in this category.</p>
          ) : (
            <div className="space-y-2.5">
              {vaxBabyGroups.map((b) => (
                <Tile key={b.profileId} icon="person" label={b.profileName} count={b.alarmCount} onClick={() => navigate(`/alarms?cat=vaccination&baby=${b.profileId}`)} />
              ))}
            </div>
          )}
        </div>
      );
    }
    const profileName = vaxBabyGroups.find((b) => b.profileId === vaxProfileId)?.profileName || '';
    return (
      <div className="max-w-2xl mx-auto p-4 pb-24">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-xl font-black text-on-surface">{profileName}</h1>
          <button type="button" onClick={() => navigate(`/baby-vaccinations/reminders/${vaxProfileId}`)} className="text-xs font-bold text-primary underline underline-offset-2 shrink-0">
            Change settings
          </button>
        </div>
        <div className="space-y-3">
          {vaxVisitsForProfile.map((v) => (
            <div key={`${v.profileId}_${v.visitKey}`} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3.5">
              <p className="text-sm font-bold text-on-surface">{v.visitLabel}</p>
              <p className="text-xs text-text-muted mt-0.5">Due {v.dueDate}</p>
              <div className="mt-2 space-y-1.5">
                {v.entries.map((entry) => (
                  <div key={entry.key} className="flex items-center justify-between gap-3 bg-surface rounded-lg px-2.5 py-1.5">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-on-surface">{entry.categoryLabel}</p>
                      <p className="text-[11px] text-text-muted">{entry.firesAt.toLocaleString()}</p>
                    </div>
                    <ConfirmButton
                      small
                      action={{
                        label: 'Cancel',
                        danger: true,
                        warning: `This turns off "${entry.categoryLabel}" reminders for ALL of ${profileName}'s vaccine visits, not just this one — vaccination reminders don't yet support per-visit control. Takes effect the next time Baby Vaccinations is opened on this device.`,
                        onConfirm: () => stopVaxCategory(v.profileId, entry.prefKey),
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (category) {
    const meta = FLAT_CATEGORY_META[category]!;
    return (
      <div className="max-w-2xl mx-auto p-4 pb-24">
        <h1 className="text-xl font-black text-on-surface">{meta.label}</h1>
        <button type="button" onClick={() => navigate(meta.manageRoute)} className="text-xs font-bold text-primary mt-1 mb-4 underline underline-offset-2">
          {meta.manageLabel}
        </button>
        {meta.items.length === 0 ? (
          <p className="text-sm text-text-muted text-center mt-10">No active alarms in this category.</p>
        ) : (
          <div className="space-y-2.5">
            {meta.items.map((item) => <ItemRow key={item.key} item={item} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 pb-24">
      <h1 className="text-xl font-black text-on-surface">Alarms</h1>
      <p className="text-xs text-text-muted mt-1 mb-4">Everything on this device set up to ring or notify you — tap a category to see what's scheduled, and stop or delete anything you don't need.</p>
      <div className="space-y-2.5">
        <Tile icon="medication" label="Medicine Reminders" count={activeMedicines.length} onClick={() => navigate('/alarms?cat=medicine')} />
        <Tile icon="monitor_heart" label="Blood Pressure Reminders" count={bpItems.length} onClick={() => navigate('/alarms?cat=bp')} />
        <Tile icon="water_drop" label="Glucose Reminders" count={glucoseItems.length} onClick={() => navigate('/alarms?cat=glucose')} />
        <Tile icon="vaccines" label="Vaccination Reminders" count={vaccineItemCount} onClick={() => navigate('/alarms?cat=vaccination')} />
        <Tile icon="notifications_active" label="Shared Reminders" count={sharedItems.length} onClick={() => navigate('/alarms?cat=shared')} />
        <Tile icon="checklist" label="To-Do Reminders" count={todoItems.length} onClick={() => navigate('/alarms?cat=todo')} />
      </div>
    </div>
  );
}
