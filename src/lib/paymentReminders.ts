import { doc, setDoc, deleteDoc, deleteField } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { db, auth } from './firebase';
import { scheduleAlarm, cancelAlarm, ensureAlarmClockSanitized, setApprovedAlarmIds } from './alarmClock';
import { toLocalDateString } from './dateUtils';

// "Remind the payer to add this payment": rent, a water or electricity bill and so on, on a date, once or repeating. A reminder belongs
// to the Payments group (any member can set one up) and rings only on the phone of the person who pays: the member picked for it, or
// else whoever is marked Payer in the group. If that person has not joined yet nothing rings; the moment they join (their Payer role
// comes with the invite) their phone finds the reminder and arms it. Each phone arms its own reminders as a normal notification or as
// an alarm that rings like a clock (Android; other devices get the notification), so they fire on time with no connection and cost
// nothing to run. Stored in `groupPaymentReminders`.
export type PayFreq = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'yearly';

export interface PaymentReminder {
  id: string;
  groupId: string;
  groupName?: string; // shown in the reminder text
  payerUid?: string | null; // who it rings for; empty = whoever is the group's Payer
  createdBy?: string;
  label: string; // what the payment is for: Rent, Water bill...
  amount?: number | null; // shown in the reminder when it is known
  startDate: string; // yyyy-mm-dd, the day the payment is to be added (the first one, when it repeats)
  time: string; // HH:MM
  freq: PayFreq;
  mode: 'notification' | 'alarm';
  active: boolean;
}

export const PAY_FREQ_OPTIONS: { id: PayFreq; label: string }[] = [
  { id: 'once', label: 'Once' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'biweekly', label: 'Every 2 weeks' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'bimonthly', label: 'Every 2 months' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'yearly', label: 'Yearly' },
];
export const PAY_FREQ_LABEL: Record<PayFreq, string> = Object.fromEntries(PAY_FREQ_OPTIONS.map((o) => [o.id, o.label])) as Record<PayFreq, string>;

// the usual things people pay on a schedule, offered before anything a group has added of its own
export const REMINDER_TYPES = ['Rent', 'Electricity bill', 'Water bill', 'Gas bill', 'Internet bill', 'Maintenance', 'EMI', 'Salary', 'Fees', 'Other'];

const MONTH_STEP: Partial<Record<PayFreq, number>> = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };
const DAY_STEP: Partial<Record<PayFreq, number>> = { weekly: 7, biweekly: 14 };

export const newReminderId = () => `pr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function savePaymentReminder(r: PaymentReminder) {
  const { id, ...rest } = r;
  return setDoc(doc(db, 'groupPaymentReminders', id), { ...rest, amount: rest.amount ?? null, payerUid: rest.payerUid || null, updatedAt: new Date().toISOString() });
}
export const deletePaymentReminder = (id: string) => deleteDoc(doc(db, 'groupPaymentReminders', id));

// The payer's own choice for how a group's reminders reach them, alarm or notification, whatever the reminder was set up with. It
// covers the scheduled reminders and the "ring now" taps alike. Kept on their user record as `paymentReminderModes` (by group), and
// copied to this phone so a ring that arrives with the app open can read it without a lookup.
export type ReminderMode = 'notification' | 'alarm';
export const getPayerModes = (profile: any): Record<string, ReminderMode> => (profile?.paymentReminderModes || {}) as Record<string, ReminderMode>;
export const setPayerMode = (uid: string, groupId: string, mode: ReminderMode | null) =>
  setDoc(doc(db, 'users', uid), { paymentReminderModes: { [groupId]: mode || deleteField() } }, { merge: true });
const MODES_KEY = 'familyledger_payment_reminder_modes';
const readModes = (): Record<string, ReminderMode> => { try { return JSON.parse(localStorage.getItem(MODES_KEY) || '{}'); } catch { return {}; } };

// Does this reminder ring for me? Yes if it names me, or names nobody and I am marked Payer in its group.
export const rings = (r: PaymentReminder, uid: string, myPayerGroups: Set<string>) => (r.payerUid ? r.payerUid === uid : myPayerGroups.has(r.groupId));

const parseDate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };

// The reminder's `i`-th occurrence (0 = the start date) as a real moment. Months keep the start day and fall back to the month's last day
// where it is shorter (a 31st becomes the 28th, 29th or 30th), without drifting afterwards.
function occurrence(r: PaymentReminder, i: number): Date {
  const [h, m] = (r.time || '09:00').split(':').map((n) => parseInt(n, 10));
  const start = parseDate(r.startDate);
  let d: Date;
  const days = DAY_STEP[r.freq];
  const months = MONTH_STEP[r.freq];
  if (days) {
    d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days * i);
  } else if (months) {
    const first = new Date(start.getFullYear(), start.getMonth() + months * i, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    d = new Date(first.getFullYear(), first.getMonth(), Math.min(start.getDate(), last));
  } else {
    d = start;
  }
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

// The next `count` moments after now (just the one for a once-only reminder).
export function upcoming(r: PaymentReminder, count: number): Date[] {
  const out: Date[] = [];
  const now = Date.now();
  const max = r.freq === 'once' ? 1 : 400;
  for (let i = 0; i < max && out.length < (r.freq === 'once' ? 1 : count); i++) {
    const at = occurrence(r, i);
    if (at.getTime() > now) out.push(at);
    else if (r.freq === 'once') break;
  }
  return out;
}

export const nextReminderAt = (r: PaymentReminder): Date | null => upcoming(r, 1)[0] || null;

export function reminderSummary(r: PaymentReminder): string {
  const when = parseDate(r.startDate);
  const day = when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const [h, m] = (r.time || '09:00').split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  const freq = r.freq === 'once' ? `${day}, ${when.getFullYear()}` : `${PAY_FREQ_LABEL[r.freq]} from ${day}`;
  return `${freq} · ${time}`;
}

// ---------- arming the reminders on this phone ----------
const ARMED_KEY = 'familyledger_payment_reminder_ids';
export const canRingPaymentAlarm = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

// each reminder owns a block of 20 ids, so setting it again replaces what it had before
const idBase = (reminderId: string) => {
  let h = 0;
  for (let i = 0; i < reminderId.length; i++) h = (h * 31 + reminderId.charCodeAt(i)) | 0;
  return 890000 + (Math.abs(h) % 5000) * 20;
};

const readArmed = (): number[] => { try { return JSON.parse(localStorage.getItem(ARMED_KEY) || '[]'); } catch { return []; } };

// how many future moments are armed one by one for the repeats that cannot repeat on their own
const AHEAD: Partial<Record<PayFreq, number>> = { biweekly: 8, monthly: 12, bimonthly: 8, quarterly: 6, yearly: 3 };

const routeFor = (r: PaymentReminder) => `/groups/${r.groupId}?add=1&label=${encodeURIComponent(r.label)}`;
const bodyFor = (r: PaymentReminder) =>
  `${r.amount ? `${r.label} · ${r.amount.toLocaleString()}. ` : ''}Tap to add this payment${r.groupName ? ` in ${r.groupName}` : ''}.`;

// Several syncs can overlap (saving and the page opening), and each one is a "cancel what I armed, arm what is due" pass over shared
// native state, so they run one at a time.
let chain: Promise<void> = Promise.resolve();

// `reminders` is only the ones that ring for this person.
export function syncPaymentReminders(reminders: PaymentReminder[], modes: Record<string, ReminderMode> = {}): Promise<void> {
  try { localStorage.setItem(MODES_KEY, JSON.stringify(modes)); } catch { /* not persisted: a ring just uses the reminder's own setting */ }
  if (!Capacitor.isNativePlatform()) return Promise.resolve(); // web has no on-device reminders
  chain = chain.then(async () => {
    try {
      const previous = readArmed();
      if (previous.length) await LocalNotifications.cancel({ notifications: previous.map((id) => ({ id })) }).catch(() => {});
      const android = canRingPaymentAlarm();
      if (android) {
        await ensureAlarmClockSanitized();
        for (const id of previous) await cancelAlarm(id);
      }

      const plans: { id: number; r: PaymentReminder; at: Date; repeatEvery?: number }[] = [];
      for (const r of reminders) {
        if (!r.active) continue;
        const base = idBase(r.id);
        // a weekly reminder repeats on its own; the rest are armed date by date
        if (r.freq === 'weekly') {
          const next = nextReminderAt(r);
          if (next) plans.push({ id: base, r, at: next, repeatEvery: 7 });
        } else {
          upcoming(r, AHEAD[r.freq] || 1).forEach((at, i) => plans.push({ id: base + i, r, at }));
        }
      }

      const alarmIds: number[] = [];
      const armed: number[] = [];
      const notifications: any[] = [];
      for (const p of plans) {
        const ringing = (modes[p.r.groupId] || p.r.mode) === 'alarm' && android;
        const title = `💸 ${p.r.label} is due`;
        const body = bodyFor(p.r);
        if (ringing) {
          alarmIds.push(p.id);
          armed.push(p.id);
        } else {
          armed.push(p.id);
          notifications.push({
            id: p.id,
            title,
            body,
            schedule: p.repeatEvery
              ? { on: { weekday: p.at.getDay() + 1, hour: p.at.getHours(), minute: p.at.getMinutes() }, allowWhileIdle: true } // Capacitor weekdays run 1 (Sunday) to 7
              : { at: p.at, allowWhileIdle: true },
            extra: { type: 'payment_reminder', groupId: p.r.groupId, label: p.r.label, reminderId: p.r.id },
          });
        }
      }

      if (android) await setApprovedAlarmIds('payment', alarmIds); // before arming: only these may ring
      for (const p of plans) {
        if (!alarmIds.includes(p.id)) continue;
        const date = toLocalDateString(p.at);
        await scheduleAlarm({
          id: p.id,
          title: `💸 ${p.r.label} is due`,
          body: bodyFor(p.r),
          hour: p.at.getHours(),
          minute: p.at.getMinutes(),
          weekdays: [],
          // a repeat that the phone can count on its own, otherwise a single ring on its day (the 100-year interval, as to-dos do)
          intervalDays: p.repeatEvery || 36500,
          startDate: date,
          ...(p.repeatEvery ? {} : { endDate: date }),
          route: routeFor(p.r),
          feature: 'payment',
        });
      }

      if (notifications.length > 0) {
        let perm = await LocalNotifications.checkPermissions();
        if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
        if (perm.display === 'granted') await LocalNotifications.schedule({ notifications });
      }
      try { localStorage.setItem(ARMED_KEY, JSON.stringify(armed)); } catch { /* not persisted: the next sync just cancels what it can */ }
    } catch (err) {
      console.error('Failed to set the payment reminders:', err);
    }
  });
  return chain;
}

// ---------- ring the payer now ----------
// A receiver (any member) taps a button and the payer's phone is told to ring. The server finds the payer and pushes to them.
export async function ringPayerNow(groupId: string, payerUid: string | null, label: string): Promise<{ ok: boolean; message: string }> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return { ok: false, message: 'You are not signed in.' };
    const res = await fetch('/api/payment-reminder/ring', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, payerUid, label }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data.error || 'Could not ring the payer.' };
    return { ok: true, message: data.sent > 0 ? 'Rung. They will see it on their phone now.' : 'Sent, but their phone has no notifications on.' };
  } catch (err) {
    console.error('Could not ring the payer:', err);
    return { ok: false, message: 'Could not ring the payer. Check your connection.' };
  }
}

// On the payer's phone, when the ring arrives while the app is open: an alarm at the next minute (the phone's alarm works to the minute).
export async function ringPaymentAlarmNow(groupId: string, label: string, body: string) {
  if (!canRingPaymentAlarm()) return;
  if (readModes()[groupId] === 'notification') return; // the payer chose notifications only
  const at = new Date(Date.now() + 60_000);
  const id = 899999;
  const date = toLocalDateString(at);
  await ensureAlarmClockSanitized();
  await setApprovedAlarmIds('payment_ring', [id]);
  await scheduleAlarm({
    id, title: `⏰ ${label} is due`, body, hour: at.getHours(), minute: at.getMinutes(), weekdays: [],
    intervalDays: 36500, startDate: date, endDate: date, route: `/groups/${groupId}?add=1&label=${encodeURIComponent(label)}`, feature: 'payment_ring',
  });
}
