// Shared Reminders — Galarm-style: create a reminder once, share it with a group and/or
// specific friends/family, everyone gets their own on-device notification at the scheduled time,
// and (optionally) the creator can see who's acknowledged it. Deliberately separate from
// ExpenseReminders.tsx (personal, expense-specific "remind me to pay X") — this is general-
// purpose and inherently social.

export type ReminderCadence = 'once' | 'daily' | 'weekly' | 'monthly';
export type ReminderResponseStatus = 'accepted' | 'declined';
// 'all' — every non-declined recipient must mark it done for the occurrence to count as complete
// (the default, and the only mode that existed before this). 'any' — the first person to mark it
// done closes it for everyone else too, e.g. "someone take the bins out" rather than "everyone
// log their own reading."
export type ReminderCompletionMode = 'all' | 'any';

export interface SharedReminder {
  id: string;
  title: string;
  notes: string | null;
  createdBy: string; // uid — always an implicit recipient of their own reminder
  createdByName: string; // denormalized, so recipients see who set it without a lookup
  createdAt: string;
  groupId: string | null;
  friendUids: string[]; // specific friends/family members, independent of groupId
  startDate: string; // yyyy-mm-dd, first occurrence
  time: string; // 'HH:mm', 24hr, local
  cadence: ReminderCadence;
  weekdays: number[]; // 0=Sun..6=Sat, used only when cadence === 'weekly'
  requireAck: boolean;
  completionMode?: ReminderCompletionMode; // optional — missing on reminders created before this
  // field existed, always treat as 'all' via `reminder.completionMode || 'all'`.
  active: boolean; // paused reminders keep their history but stop firing
}

export function hasReminderTarget(groupId: string | null, friendUids: string[]): boolean {
  return !!groupId || friendUids.length > 0;
}

// Every uid this reminder is ever relevant to — used both for "who do I notify" and "whose
// devices should schedule this locally" (every recipient's own client is what actually schedules
// the on-device notification; there's no server-side push at trigger time, same on-device-only
// model already used by the Health trackers' reminders).
export function reminderRecipientUids(reminder: SharedReminder, groupMemberUids: string[]): string[] {
  const set = new Set<string>([reminder.createdBy, ...reminder.friendUids]);
  if (reminder.groupId) groupMemberUids.forEach((uid) => set.add(uid));
  return Array.from(set);
}

// The next occurrence's date, as yyyy-mm-dd, on or after `fromDateStr` — null once a one-off
// reminder's single occurrence has passed. Used both for "next due" display and to compute which
// occurrence today's/tomorrow's local notification (and any acknowledgment) belongs to.
export function nextOccurrence(reminder: SharedReminder, fromDateStr: string): string | null {
  if (reminder.cadence === 'once') {
    return reminder.startDate >= fromDateStr ? reminder.startDate : null;
  }
  if (reminder.startDate > fromDateStr) return reminder.startDate;

  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const from = new Date(fy, fm - 1, fd);

  if (reminder.cadence === 'daily') return fromDateStr;

  if (reminder.cadence === 'weekly') {
    const days = reminder.weekdays.length > 0 ? reminder.weekdays : [from.getDay()];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      if (days.includes(d.getDay())) return toDateStr(d);
    }
    return fromDateStr;
  }

  // monthly — same day-of-month as startDate, rolled forward to the next month if this month's
  // occurrence has already passed.
  const [, , startDay] = reminder.startDate.split('-').map(Number);
  const candidate = new Date(from.getFullYear(), from.getMonth(), startDay);
  if (candidate < from) candidate.setMonth(candidate.getMonth() + 1);
  return toDateStr(candidate);
}

function toDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function describeCadence(reminder: SharedReminder, t: (key: string, vars?: Record<string, any>) => string, weekdayLabels: string[]): string {
  if (reminder.cadence === 'once') return t('reminders.once');
  if (reminder.cadence === 'daily') return t('reminders.everyDay');
  if (reminder.cadence === 'monthly') return t('reminders.everyMonth');
  const days = reminder.weekdays.length > 0 ? reminder.weekdays : [0, 1, 2, 3, 4, 5, 6];
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => weekdayLabels[d].slice(0, 3))
    .join('/');
}

// Deterministic doc id for one recipient's acknowledgment of one occurrence — makes "have I
// already acked today's one?" a plain getDoc/setDoc instead of a query.
export function ackId(uid: string, occurrenceDateStr: string): string {
  return `${uid}_${occurrenceDateStr}`;
}

// Whether an occurrence counts as done, given who's actually eligible to act (recipients minus
// anyone who's declined the reminder outright — a decline should never block an 'all' reminder
// from ever closing, and shouldn't count as an eligible completer for an 'any' one either) and who
// already has. Centralized here so the list row, the creator's detail checklist, and the
// recipient's own card all agree on exactly the same definition of "complete."
export function isOccurrenceComplete(
  completionMode: ReminderCompletionMode,
  activeRecipientUids: string[],
  doneUids: Set<string>,
): boolean {
  if (activeRecipientUids.length === 0) return false;
  return completionMode === 'any'
    ? activeRecipientUids.some((uid) => doneUids.has(uid))
    : activeRecipientUids.every((uid) => doneUids.has(uid));
}
