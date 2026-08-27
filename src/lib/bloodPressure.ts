// Blood Pressure tracker — deliberately a close mirror of health.ts's glucose model (same
// sharing/delegate/reminder shapes, same Firestore rule patterns) MINUS the meal-window
// dimension: BP readings aren't meaningfully "before/after breakfast/lunch/dinner" the way
// glucose is, so there's no GLUCOSE_WINDOWS equivalent here — just a plain reading + timestamp.

export interface BloodPressureLog {
  id: string;
  userId: string; // whose reading this is — a delegate can log it, but it always belongs to this uid
  loggedBy: string; // who actually entered it; equals userId for a self-entry, the delegate's uid otherwise
  groupId: string | null;
  sharedFriendUids: string[];
  systolic: number;
  diastolic: number;
  pulse: number | null; // optional — most home BP monitors report a pulse alongside the reading
  notes: string | null;
  loggedAt: string; // ISO datetime, user-editable
  createdAt: string; // ISO datetime, set once at creation
}

// A single target band (not per-window, since there's no meal dimension to split it by).
// Standard-ish resting ranges — user-editable from there, same reasoning as glucose's defaults:
// this app has no business asserting more clinical precision than a starting point.
export const DEFAULT_BP_TARGET = {
  systolicMin: 90,
  systolicMax: 120,
  diastolicMin: 60,
  diastolicMax: 80,
};

export interface BpTarget {
  systolicMin: number;
  systolicMax: number;
  diastolicMin: number;
  diastolicMax: number;
}

export type BpRangeStatus = 'inRange' | 'high' | 'low';

export function bpRangeStatus(systolic: number, diastolic: number, target: BpTarget): BpRangeStatus {
  if (systolic > target.systolicMax || diastolic > target.diastolicMax) return 'high';
  if (systolic < target.systolicMin || diastolic < target.diastolicMin) return 'low';
  return 'inRange';
}

// --- Sharing (Firestore: bpShareSettings/{uid}) — identical shape to GlucoseShareSettings ---
export type BpShareMode = 'always' | 'range';

export interface BpShareSettings {
  groupId: string | null;
  friendUids: string[];
  mode: BpShareMode | null;
  startDate: string | null;
  endDate: string | null;
}

export const DEFAULT_BP_SHARE_SETTINGS: BpShareSettings = {
  groupId: null,
  friendUids: [],
  mode: null,
  startDate: null,
  endDate: null,
};

export function hasBpShareTarget(settings: BpShareSettings): boolean {
  return !!settings.groupId || settings.friendUids.length > 0;
}

export function isBpShareActiveForDate(settings: BpShareSettings, dateStr: string): boolean {
  if (!hasBpShareTarget(settings) || !settings.mode) return false;
  if (settings.mode === 'always') return true;
  const day = dateStr.slice(0, 10);
  if (settings.startDate && day < settings.startDate) return false;
  if (settings.endDate && day > settings.endDate) return false;
  return true;
}

// --- Delegated entry (Firestore: bpDelegateSettings/{uid}) — identical shape to glucose's ---
export interface BpDelegateSettings {
  groupId: string | null;
  friendUids: string[];
}

export const DEFAULT_BP_DELEGATE_SETTINGS: BpDelegateSettings = {
  groupId: null,
  friendUids: [],
};

export function hasBpDelegateTarget(settings: BpDelegateSettings): boolean {
  return !!settings.groupId || settings.friendUids.length > 0;
}

// --- Reminders (Firestore: users/{uid}.bpReminders) ---
// No meal binding — just a plain list of times of day (e.g. "Morning", "Evening"), since a BP
// check isn't tied to eating. Each entry is independently removable/addable, unlike glucose's
// fixed 3-meal set.
export interface BpReminderTime {
  id: string; // stable per-slot id (not index) so reordering/removal doesn't reshuffle schedule ids
  label: string; // user-editable, e.g. "Morning", "Evening", "Before bed"
  time: string; // 'HH:mm', 24hr, local
}

export type BpReminderCadence = 'daily' | 'weekly';

export interface BpReminderSettings {
  enabled: boolean;
  cadence: BpReminderCadence;
  weekdays: number[]; // 0=Sun..6=Sat, used only when cadence === 'weekly'
  times: BpReminderTime[];
}

export const DEFAULT_BP_REMINDERS: BpReminderSettings = {
  enabled: false,
  cadence: 'daily',
  weekdays: [1, 2, 3, 4, 5],
  times: [
    { id: 'morning', label: 'Morning', time: '08:00' },
    { id: 'evening', label: 'Evening', time: '20:00' },
  ],
};
