export type GlucoseMealType = 'breakfast' | 'lunch' | 'dinner';
export type GlucoseTiming = 'before' | 'after';

export interface GlucoseLog {
  id: string;
  userId: string; // whose reading this is — a delegate can log it, but it always belongs to this uid
  loggedBy: string; // who actually entered it; equals userId for a self-entry, the delegate's uid otherwise
  groupId: string | null; // computed from GlucoseShareSettings at write time, not user-picked per entry
  sharedFriendUids: string[]; // ditto — individual friends this entry is currently shared with
  mealType: GlucoseMealType;
  timing: GlucoseTiming;
  postMealHours: number | null;
  value: number;
  notes: string | null;
  loggedAt: string; // ISO datetime, user-editable
  createdAt: string; // ISO datetime, set once at creation
}

// Fallback only — the real, user-editable ranges live on `users/{uid}.healthTargets.glucose`
// (see GlucoseTargetMap below). Used before that's ever been set.
export const DEFAULT_GLUCOSE_TARGET_MIN = 70;
export const DEFAULT_GLUCOSE_TARGET_MAX = 180;

export interface GlucoseTarget {
  min: number;
  max: number;
}

export function isGlucoseInRange(value: number, target: GlucoseTarget): boolean {
  return value >= target.min && value <= target.max;
}

export const POST_MEAL_HOUR_OPTIONS = [1, 2, 3, 4];

// The 6 fixed meal-window buckets the Dashboard tab trends and the PDF export both iterate over,
// in a stable display order — every log belongs to exactly one of these.
export const GLUCOSE_WINDOWS: { mealType: GlucoseMealType; timing: GlucoseTiming; key: string; labelKey: string; icon: string }[] = [
  { mealType: 'breakfast', timing: 'before', key: 'breakfast_before', labelKey: 'health.beforeBreakfast', icon: '🌅' },
  { mealType: 'breakfast', timing: 'after', key: 'breakfast_after', labelKey: 'health.afterBreakfast', icon: '🍳' },
  { mealType: 'lunch', timing: 'before', key: 'lunch_before', labelKey: 'health.beforeLunch', icon: '🥗' },
  { mealType: 'lunch', timing: 'after', key: 'lunch_after', labelKey: 'health.afterLunch', icon: '🍱' },
  { mealType: 'dinner', timing: 'before', key: 'dinner_before', labelKey: 'health.beforeDinner', icon: '🌙' },
  { mealType: 'dinner', timing: 'after', key: 'dinner_after', labelKey: 'health.afterDinner', icon: '🍽️' },
];

export function glucoseWindowOf(log: Pick<GlucoseLog, 'mealType' | 'timing'>): string {
  return `${log.mealType}_${log.timing}`;
}

// A target range per meal window (before/after breakfast/lunch/dinner), not one global band —
// clinically, before- and after-meal targets genuinely differ, and this app has no basis to guess
// sensible defaults for that split, so every window starts at the same generic band and the user
// dials in their own per-window numbers from there.
export type GlucoseTargetMap = Record<string, GlucoseTarget>;

export function defaultGlucoseTargetMap(): GlucoseTargetMap {
  const map: GlucoseTargetMap = {};
  GLUCOSE_WINDOWS.forEach((w) => {
    map[w.key] = { min: DEFAULT_GLUCOSE_TARGET_MIN, max: DEFAULT_GLUCOSE_TARGET_MAX };
  });
  return map;
}

export function targetForWindow(targets: GlucoseTargetMap | undefined, windowKey: string): GlucoseTarget {
  return targets?.[windowKey] || { min: DEFAULT_GLUCOSE_TARGET_MIN, max: DEFAULT_GLUCOSE_TARGET_MAX };
}

// --- Sharing (Firestore: healthShareSettings/{uid}) ---
// A one-time, standing preference instead of a per-entry choice — "share always" or "share only
// readings dated within a range" — evaluated against each log's OWN loggedAt date (not the date
// the setting was saved), so narrowing/widening the range later is meaningful for past entries
// too. Two independent target kinds, both optional and combinable: one group (family/friends/
// expense group — whichever the user actually belongs to) AND/OR any number of individual
// friends, so sharing isn't forced through a group that happens to also track shared expenses.
export type GlucoseShareMode = 'always' | 'range';

export interface GlucoseShareSettings {
  groupId: string | null; // null = no group target
  friendUids: string[]; // individual friends, independent of groupId
  mode: GlucoseShareMode | null;
  startDate: string | null; // 'YYYY-MM-DD', inclusive
  endDate: string | null; // 'YYYY-MM-DD', inclusive; null = open-ended/ongoing
}

export const DEFAULT_GLUCOSE_SHARE_SETTINGS: GlucoseShareSettings = {
  groupId: null,
  friendUids: [],
  mode: null,
  startDate: null,
  endDate: null,
};

export function hasShareTarget(settings: GlucoseShareSettings): boolean {
  return !!settings.groupId || settings.friendUids.length > 0;
}

// Whether a log dated `dateStr` (YYYY-MM-DD, or an ISO datetime — only the date portion matters)
// should be tagged as shared under the CURRENT settings. Called both when saving a brand new
// entry and when settings change and existing entries get batch-recomputed.
export function isShareActiveForDate(settings: GlucoseShareSettings, dateStr: string): boolean {
  if (!hasShareTarget(settings) || !settings.mode) return false;
  if (settings.mode === 'always') return true;
  const day = dateStr.slice(0, 10);
  if (settings.startDate && day < settings.startDate) return false;
  if (settings.endDate && day > settings.endDate) return false;
  return true;
}

// --- Delegated entry (Firestore: healthDelegateSettings/{uid}) ---
// The inverse of sharing: sharing grants READ access to my data; this grants WRITE access — one
// group AND/OR any number of individual friends who may log a reading (or set reminders) on my
// behalf, e.g. a caregiver logging for an elderly parent who doesn't use the app themselves. Same
// group-scalar + friend-array shape as GlucoseShareSettings, and the same reasoning applies to why
// the friend check is safe in Firestore rules without iterating the reader's own friend list.
export interface GlucoseDelegateSettings {
  groupId: string | null;
  friendUids: string[];
}

export const DEFAULT_GLUCOSE_DELEGATE_SETTINGS: GlucoseDelegateSettings = {
  groupId: null,
  friendUids: [],
};

export function hasDelegateTarget(settings: GlucoseDelegateSettings): boolean {
  return !!settings.groupId || settings.friendUids.length > 0;
}

// --- Reminders (Firestore: users/{uid}.glucoseReminders) ---
// "Before" is always a fixed 15 minutes ahead of the meal time (matches how people actually test —
// right before eating); "after" is however many hours the user themselves finds meaningful for
// their own post-meal check, so that one's configurable per meal. `meals` controls which of the
// three actually get reminders at all; `cadence`/`weekdays` control which days they fire on.
export interface MealReminderTime {
  time: string; // 'HH:mm', 24hr, local
  afterHours: number;
}

export type GlucoseReminderCadence = 'daily' | 'weekly';

export interface GlucoseReminderSettings {
  enabled: boolean;
  meals: GlucoseMealType[]; // which meals get a reminder at all
  cadence: GlucoseReminderCadence;
  weekdays: number[]; // 0=Sun..6=Sat, used only when cadence === 'weekly'
  breakfast: MealReminderTime;
  lunch: MealReminderTime;
  dinner: MealReminderTime;
}

export const DEFAULT_GLUCOSE_REMINDERS: GlucoseReminderSettings = {
  enabled: false,
  meals: ['breakfast', 'lunch', 'dinner'],
  cadence: 'daily',
  weekdays: [1, 2, 3, 4, 5], // Mon–Fri, only used once cadence is switched to weekly
  breakfast: { time: '08:00', afterHours: 2 },
  lunch: { time: '13:00', afterHours: 2 },
  dinner: { time: '20:00', afterHours: 2 },
};

export const BEFORE_MEAL_REMINDER_LEAD_MINUTES = 15;
