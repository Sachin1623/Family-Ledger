import { deleteField } from 'firebase/firestore';

// Shared frequency model for recurring expenses and expense reminders. The same shape and
// date math is duplicated (not imported) in server.ts, since the client (Vite) and server
// (esbuild) bundles are built separately and don't share a module graph.
export type Frequency = 'daily' | 'alternate_day' | 'weekly' | 'monthly' | 'alternate_month' | 'quarterly' | 'half_yearly' | 'annually';

export interface FrequencyConfig {
  frequency: Frequency;
  dayOfWeek?: number; // 0=Sun..6=Sat — legacy single-day field, kept for old rules; new rules use daysOfWeek
  daysOfWeek?: number[]; // one or more of 0=Sun..6=Sat, for 'weekly' — lets a rule fire on e.g. both Mon and Thu
  dayOfMonth?: number; // 1-31, for monthly/quarterly/half_yearly/annually
  month?: number; // 1-12, the anchor/start month for quarterly/half_yearly/annually
  hour?: number; // 0-23 — user-chosen reminder time, any frequency
  minute?: number; // 0-59 — user-chosen reminder time, any frequency
}

// `daysOfWeek` is the current field; `dayOfWeek` (singular) is read as a fallback for rules
// created before multi-day weekly support existed.
export function resolveDaysOfWeek(config: Partial<FrequencyConfig>): number[] {
  if (config.daysOfWeek && config.daysOfWeek.length > 0) return config.daysOfWeek;
  return [config.dayOfWeek ?? 0];
}

// Every frequency lets the user pick a reminder time now. Unset hour/minute falls back to each
// frequency's old fixed default (9am for daily/alternate_day, noon for everything else) so rules
// created before per-frequency time picking existed keep firing at the same time as before.
export function reminderTimeOfDay(config: Partial<FrequencyConfig>): { hour: number; minute: number } {
  const defaultHour = config.frequency === 'daily' || config.frequency === 'alternate_day' ? 9 : 12;
  return { hour: config.hour ?? defaultHour, minute: config.minute ?? 0 };
}

export function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

export const FREQUENCY_OPTIONS: { id: Frequency; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'alternate_day', label: 'Alternate Day' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'alternate_month', label: 'Alternate Months' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'half_yearly', label: 'Half-Yearly' },
  { id: 'annually', label: 'Annually' },
];

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function atMidnight(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

// Returns the next date strictly after `after` that matches the given frequency config, at that
// frequency's target time-of-day (see reminderTimeOfDay). The day-selection logic below always
// lands on a calendar day strictly later than `after`'s own day (every branch starts from
// atMidnight(after) and moves forward by at least one day), so applying any time-of-day to that
// day is always guaranteed to be later than the exact `after` instant — no extra same-day edge
// case to handle here (see firstOccurrenceOnOrAfter for the one place that DOES need it, since
// it's seeded with an artificial "yesterday" reference rather than a real moment).
export function nextOccurrenceAfter(config: FrequencyConfig, after: Date): Date {
  const from = atMidnight(after);
  const { frequency, dayOfMonth = 1, month = 1 } = config;
  let result: Date;

  switch (frequency) {
    case 'daily': {
      const d = new Date(from);
      d.setDate(d.getDate() + 1);
      result = d;
      break;
    }
    case 'alternate_day': {
      const d = new Date(from);
      d.setDate(d.getDate() + 2);
      result = d;
      break;
    }
    case 'weekly': {
      const days = resolveDaysOfWeek(config);
      const d = new Date(from);
      d.setDate(d.getDate() + 1);
      while (!days.includes(d.getDay())) d.setDate(d.getDate() + 1);
      result = d;
      break;
    }
    case 'monthly': {
      // This month's target date first — only roll to next month if it's already on/before
      // `from` (i.e. today or earlier). Unconditionally jumping to next month here used to mean
      // scheduling "monthly on the 29th" on the 22nd showed its first run as next month instead
      // of the 29th still coming up this month.
      const thisMonth = new Date(from.getFullYear(), from.getMonth(), 1);
      thisMonth.setDate(Math.min(dayOfMonth, daysInMonth(thisMonth.getFullYear(), thisMonth.getMonth())));
      if (thisMonth > from) {
        result = thisMonth;
      } else {
        const d = new Date(from.getFullYear(), from.getMonth() + 1, 1);
        d.setDate(Math.min(dayOfMonth, daysInMonth(d.getFullYear(), d.getMonth())));
        result = d;
      }
      break;
    }
    case 'alternate_month':
    case 'quarterly':
    case 'half_yearly':
    case 'annually': {
      const stepMonths = frequency === 'alternate_month' ? 2 : frequency === 'quarterly' ? 3 : frequency === 'half_yearly' ? 6 : 12;
      const anchorMonth0 = Math.max(0, Math.min(11, month - 1));
      // Walk forward from `from` in stepMonths increments, starting from the anchor month in
      // from's year, until we land strictly after `from`.
      let candidate = new Date(from.getFullYear(), anchorMonth0, 1);
      candidate.setDate(Math.min(dayOfMonth, daysInMonth(candidate.getFullYear(), candidate.getMonth())));
      while (candidate <= from) {
        const next = new Date(candidate.getFullYear(), candidate.getMonth() + stepMonths, 1);
        next.setDate(Math.min(dayOfMonth, daysInMonth(next.getFullYear(), next.getMonth())));
        candidate = next;
      }
      result = candidate;
      break;
    }
    default:
      throw new Error(`Unknown frequency: ${frequency}`);
  }

  const { hour, minute } = reminderTimeOfDay(config);
  result.setHours(hour, minute, 0, 0);
  return result;
}

// The first occurrence on or after `now` (used when a rule is first created). Seeds
// nextOccurrenceAfter with "yesterday" so that *today* qualifies as a valid first occurrence —
// but since that's an artificial reference rather than the real current moment, the result can
// land on today at the target time even if that time has already passed today (e.g. creating a
// "daily @ 9am" reminder at 3pm) — roll forward one more occurrence in that case.
export function firstOccurrenceOnOrAfter(config: FrequencyConfig, now: Date): Date {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  let candidate = nextOccurrenceAfter(config, yesterday);
  if (candidate <= now) {
    candidate = nextOccurrenceAfter(config, candidate);
  }
  return candidate;
}

// Whether a given calendar day (YYYY-MM-DD, local) is a scheduled occurrence of this frequency —
// used by the habit tracker grid to color each day cell (grey/green/red) without having to walk
// the whole nextOccurrenceAfter chain from the habit's creation date for every cell. Direct
// per-frequency predicate rather than simulation, mirroring nextOccurrenceAfter's case structure.
// `sinceDateStr` is the habit's own creation date — days before it were never "due" (the habit
// didn't exist yet).
export function isDueOnDate(config: FrequencyConfig, dateStr: string, sinceDateStr: string): boolean {
  if (dateStr < sinceDateStr) return false;
  const date = new Date(`${dateStr}T00:00:00`);
  const since = new Date(`${sinceDateStr}T00:00:00`);
  const { frequency, dayOfMonth = 1, month = 1 } = config;

  switch (frequency) {
    case 'daily':
      return true;
    case 'alternate_day': {
      const days = Math.round((date.getTime() - since.getTime()) / 86400000);
      return days % 2 === 0;
    }
    case 'weekly':
      return resolveDaysOfWeek(config).includes(date.getDay());
    case 'monthly':
      return date.getDate() === Math.min(dayOfMonth, daysInMonth(date.getFullYear(), date.getMonth()));
    case 'alternate_month':
    case 'quarterly':
    case 'half_yearly':
    case 'annually': {
      const stepMonths = frequency === 'alternate_month' ? 2 : frequency === 'quarterly' ? 3 : frequency === 'half_yearly' ? 6 : 12;
      const anchorMonth0 = Math.max(0, Math.min(11, month - 1));
      if (date.getDate() !== Math.min(dayOfMonth, daysInMonth(date.getFullYear(), date.getMonth()))) return false;
      const monthsFromAnchor = (date.getFullYear() - since.getFullYear()) * 12 + (date.getMonth() - anchorMonth0);
      return monthsFromAnchor >= 0 && monthsFromAnchor % stepMonths === 0;
    }
    default:
      return false;
  }
}

// Rebuilds a FrequencyConfig from a Firestore doc's own top-level fields (recurring to-dos store
// these flattened directly on the todo doc rather than nested, matching recurringExpenses' shape)
// — shared by ToDoList.tsx (for describeFrequency in the detail sheet) and HabitTracker.tsx (for
// isDueOnDate), so both compute "which days is this habit due" identically.
export function frequencyConfigFromFields(data: Partial<FrequencyConfig>): FrequencyConfig {
  return {
    frequency: data.frequency || 'daily',
    dayOfWeek: data.dayOfWeek,
    daysOfWeek: data.daysOfWeek,
    dayOfMonth: data.dayOfMonth,
    month: data.month,
    hour: data.hour,
    minute: data.minute,
  };
}

// Human-readable summary of a frequency config, e.g. "Weekly on Mon at 12:00 PM" or
// "Daily at 9:00 AM". Shared by RecurringExpenses.tsx, ExpenseReminders.tsx, and
// ManageGroup.tsx's group-wide recurring expenses list.
export function describeFrequency(rule: Partial<FrequencyConfig>): string {
  const label = FREQUENCY_OPTIONS.find((f) => f.id === rule.frequency)?.label || rule.frequency;
  const { hour, minute } = reminderTimeOfDay(rule);
  const timeStr = `at ${formatTimeOfDay(hour, minute)}`;
  if (rule.frequency === 'weekly') {
    const days = resolveDaysOfWeek(rule).sort((a, b) => a - b);
    const dayNames = days.map((d) => WEEKDAY_LABELS[d].slice(0, 3));
    return `${label} on ${dayNames.join(', ')} ${timeStr}`;
  }
  if (rule.frequency === 'monthly') return `${label} on day ${rule.dayOfMonth ?? 1} ${timeStr}`;
  if (rule.frequency === 'alternate_month' || rule.frequency === 'quarterly' || rule.frequency === 'half_yearly' || rule.frequency === 'annually') {
    return `${label}, ${MONTH_LABELS[(rule.month ?? 1) - 1]} ${rule.dayOfMonth ?? 1} ${timeStr}`;
  }
  return `${label} ${timeStr}`;
}

// FrequencyPicker and both screens' handleEditStart always populate every optional field on a
// FrequencyConfig (so switching frequency types cleanly resets the ones that no longer apply),
// which means fields that don't apply to the current frequency end up explicitly `undefined`
// rather than simply absent. Spreading that straight into an addDoc/updateDoc call throws
// "Unsupported field value: undefined" — Firestore rejects literal undefined in writes. These
// two helpers convert an undefined-bearing config into what each write type actually needs.

// For creates: just drop unset keys — there's no existing document field to worry about.
export function sanitizeFrequencyConfig<T extends Record<string, any>>(config: T): Partial<T> {
  const clean: Partial<T> = {};
  for (const key of Object.keys(config) as (keyof T)[]) {
    if (config[key] !== undefined) clean[key] = config[key];
  }
  return clean;
}

// For updates: turn unset keys into deleteField() sentinels instead of omitting them, so e.g.
// switching a rule from weekly (dayOfWeek/daysOfWeek) to monthly (dayOfMonth) actually clears the
// now-irrelevant fields from the stored document — updateDoc() only merges the keys you send, it
// won't remove fields you simply don't mention.
export function frequencyConfigForUpdate<T extends Record<string, any>>(config: T): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(config)) {
    const value = config[key as keyof T];
    result[key] = value === undefined ? deleteField() : value;
  }
  return result;
}
