// Medicine Reminders — a bigger departure from health.ts's glucose model than bloodPressure.ts
// was, because a medicine ISN'T a single logged reading: it's a standing prescription (name,
// dosage, one or more times a day, food timing, a fixed duration or dose count) that then
// generates many individual dose events over time. So this file has two entities instead of one:
// `Medicine` (the prescription/schedule) and `MedicineLog` (one taken/skipped dose instance).
// Sharing/Delegate settings keep the same shape as glucose/BP for consistency, but reminders are
// deliberately NOT a separate settings panel here — each medicine's own times/weekdays/duration
// already fully determine its reminder schedule, so there's nothing a global reminders panel would
// add beyond a per-medicine "Remind me" toggle on the medicine itself.

export type FoodTiming = 'before' | 'after' | 'empty' | 'any';

export interface MedicineDoseTime {
  id: string; // stable per-slot id, not index — reordering/removal shouldn't reshuffle log/notification ids
  label: string; // e.g. "Morning", "Afternoon", "Night" — user-editable, not a fixed enum
  time: string; // 'HH:mm', 24hr, local
  foodTiming: FoodTiming;
}

export type MedicineDurationMode = 'ongoing' | 'endDate' | 'dayCount';

export interface Medicine {
  id: string;
  userId: string; // whose medicine — a delegate can add/manage it, but it always belongs to this uid
  loggedBy: string; // who actually created/last edited it
  groupId: string | null;
  sharedFriendUids: string[];
  name: string;
  dosage: string; // freeform, e.g. "500mg", "1 tablet"
  // Which MedicalIncident (medicalIncidents.ts) this medicine is grouped under — HealthMedicines.tsx
  // groups the Medicines tab by this, and filters both the Log and Dashboard tabs by it. `null`
  // means it belongs to the General bucket (see GENERAL_INCIDENT_ID), never hidden.
  incidentId: string | null;
  times: MedicineDoseTime[];
  weekdays: number[]; // 0=Sun..6=Sat — which days this schedule applies; every day by default
  // An interval-based repeat ("every other day" = 2, "every 3rd day" = 3, etc.), counted from
  // startDate — mutually exclusive with `weekdays`: when set (>1), it's what isMedicineDueOn()
  // actually checks, and `weekdays` is ignored. `null`/1 means the plain weekdays-based schedule
  // above. Kept as a general N (not just a Boolean "alternate days" flag) since the UI's single
  // "Alternate days" toggle is just intervalDays=2 — no reason to close the door on other
  // intervals later for the cost of one extra field.
  intervalDays: number | null;
  startDate: string; // yyyy-mm-dd
  durationMode: MedicineDurationMode;
  endDate: string | null; // set when durationMode === 'endDate'
  dayCount: number | null; // set when durationMode === 'dayCount'
  remindersEnabled: boolean;
  notes: string | null;
  active: boolean; // manually paused/stopped independent of the duration having elapsed
  createdAt: string;
}

export const FOOD_TIMING_OPTIONS: FoodTiming[] = ['before', 'after', 'empty', 'any'];

export const DEFAULT_DOSE_TIMES: Omit<MedicineDoseTime, 'id'>[] = [
  { label: 'Morning', time: '08:00', foodTiming: 'after' },
];

// The last day this medicine is scheduled, or null if ongoing / can't be computed yet.
export function medicineEndDateStr(med: Pick<Medicine, 'durationMode' | 'startDate' | 'endDate' | 'dayCount'>): string | null {
  if (med.durationMode === 'endDate') return med.endDate;
  if (med.durationMode === 'dayCount' && med.dayCount && med.dayCount > 0) {
    const [y, m, d] = med.startDate.split('-').map(Number);
    const end = new Date(y, m - 1, d);
    end.setDate(end.getDate() + med.dayCount - 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
  }
  return null;
}

// Local-date (not UTC) day difference — both inputs are 'yyyy-mm-dd' wall-clock dates, so this
// stays correct across a DST transition day the same way medicineEndDateStr's own date math does.
function daysBetween(startDateStr: string, dateStr: string): number {
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [dy, dm, dd] = dateStr.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const date = new Date(dy, dm - 1, dd);
  return Math.round((date.getTime() - start.getTime()) / 86400000);
}

// Whether this medicine has a dose scheduled on the given yyyy-mm-dd, factoring in the pause
// flag, the start/end bounds, and the repeat pattern (an interval count from startDate, or a
// weekday selection — see intervalDays' own comment for why these are mutually exclusive).
export function isMedicineDueOn(med: Medicine, dateStr: string): boolean {
  if (!med.active) return false;
  if (dateStr < med.startDate) return false;
  const end = medicineEndDateStr(med);
  if (end && dateStr > end) return false;
  if (med.intervalDays && med.intervalDays > 1) {
    return daysBetween(med.startDate, dateStr) % med.intervalDays === 0;
  }
  if (med.weekdays.length === 0 || med.weekdays.length === 7) return true;
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  return med.weekdays.includes(weekday);
}

export function medicineStatusLabel(med: Medicine, todayStr: string): 'active' | 'paused' | 'ended' | 'upcoming' {
  if (!med.active) return 'paused';
  const end = medicineEndDateStr(med);
  if (end && todayStr > end) return 'ended';
  if (todayStr < med.startDate) return 'upcoming';
  return 'active';
}

// --- One taken/skipped dose instance (Firestore: medicineLogs/{id}) ---
export type MedicineLogStatus = 'taken' | 'skipped';

export interface MedicineLog {
  id: string; // deterministic: `${userId}_${medicineId}_${doseTimeId}_${dateStr}` — see medicineLogId()
  userId: string;
  loggedBy: string;
  groupId: string | null;
  sharedFriendUids: string[];
  medicineId: string;
  medicineName: string; // denormalized so the log/report still reads correctly if the medicine is later deleted
  doseTimeId: string;
  doseLabel: string; // denormalized, same reason
  scheduledTime: string; // 'HH:mm' the dose was scheduled for
  status: MedicineLogStatus;
  dateStr: string; // yyyy-mm-dd this dose belongs to — distinct from loggedAt (when it was actually marked)
  loggedAt: string; // ISO datetime, when marked taken/skipped
  notes: string | null;
  createdAt: string;
}

export function medicineLogId(userId: string, medicineId: string, doseTimeId: string, dateStr: string): string {
  return `${userId}_${medicineId}_${doseTimeId}_${dateStr}`;
}

// --- Sharing (Firestore: medicineShareSettings/{uid}) — identical shape to glucose/BP ---
export type MedicineShareMode = 'always' | 'range';

export interface MedicineShareSettings {
  groupId: string | null;
  friendUids: string[];
  mode: MedicineShareMode | null;
  startDate: string | null;
  endDate: string | null;
}

export const DEFAULT_MEDICINE_SHARE_SETTINGS: MedicineShareSettings = {
  groupId: null,
  friendUids: [],
  mode: null,
  startDate: null,
  endDate: null,
};

export function hasMedicineShareTarget(settings: MedicineShareSettings): boolean {
  return !!settings.groupId || settings.friendUids.length > 0;
}

export function isMedicineShareActiveForDate(settings: MedicineShareSettings, dateStr: string): boolean {
  if (!hasMedicineShareTarget(settings) || !settings.mode) return false;
  if (settings.mode === 'always') return true;
  const day = dateStr.slice(0, 10);
  if (settings.startDate && day < settings.startDate) return false;
  if (settings.endDate && day > settings.endDate) return false;
  return true;
}

// --- Delegated entry (Firestore: medicineDelegateSettings/{uid}) — identical shape to glucose/BP ---
export interface MedicineDelegateSettings {
  groupId: string | null;
  friendUids: string[];
}

export const DEFAULT_MEDICINE_DELEGATE_SETTINGS: MedicineDelegateSettings = {
  groupId: null,
  friendUids: [],
};

export function hasMedicineDelegateTarget(settings: MedicineDelegateSettings): boolean {
  return !!settings.groupId || settings.friendUids.length > 0;
}
