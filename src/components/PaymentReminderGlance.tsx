import React, { useState } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { canPay } from './PaymentRolePicker';
import MemberAvatar from './MemberAvatar';
import ReminderModeChooser from './ReminderModeChooser';
import {
  PayerMode, PaymentReminder, REMINDER_TYPE_ICON, canRingPaymentAlarm, getPayerModes, nextReminderAt, reminderSummary, relativeDay, setPayerMode,
} from '../lib/paymentReminders';

// What is scheduled for a Payments group, shown on the Dashboard card and in the reminders sheet: the next reminders, who each one rings
// for, and, for a person they ring for, the Alarm / Notification / Off choice, which covers their scheduled reminders and anyone's
// "ring now" alike. `children` (the Ring buttons) sit at the bottom of the same box, so a card carries one reminders block, not three.
export default function PaymentReminderGlance({ groupId, reminders, members, max = 2, onManage, children, className }: {
  groupId: string;
  reminders: PaymentReminder[];
  members: { userId: string; role?: string; name?: string; displayName?: string; photo?: string }[];
  max?: number;
  onManage?: () => void;
  children?: React.ReactNode;
  className?: string;
}) {
  const { user, profile } = useAuth();
  const [saving, setSaving] = useState(false);
  const me = members.find((m) => m.userId === user?.uid);
  const person = (uid?: string | null) => (uid ? members.find((x) => x.userId === uid) : undefined);
  const nameOf = (uid: string) => (uid === user?.uid ? 'You' : person(uid)?.name || person(uid)?.displayName || 'Payer');
  const active = reminders.filter((r) => r.active && nextReminderAt(r));
  const upcoming = [...active].sort((a, b) => nextReminderAt(a)!.getTime() - nextReminderAt(b)!.getTime()).slice(0, max);
  const forMe = !!user && (canPay(me?.role) || reminders.some((r) => r.payerUid === user.uid));
  const chosen = getPayerModes(profile)[groupId] || '';
  // with no choice made, what the reminders were set up with
  const effective: PayerMode = (chosen as PayerMode) || (reminders.find((r) => r.active)?.mode ?? 'notification');

  if (upcoming.length === 0 && !forMe && !children && !onManage) return null;
  const pick = async (mode: PayerMode) => {
    if (!user || saving || mode === effective) return;
    setSaving(true);
    await setPayerMode(user.uid, groupId, mode).catch((err) => console.error('Could not save the reminder choice:', err));
    setSaving(false);
  };

  return (
    <div className={clsx('rounded-xl border border-border-subtle px-3 py-3 space-y-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-wider text-text-muted">Payment reminders</p>
        {onManage && <button type="button" onClick={onManage} className="text-xs font-black text-primary px-2 py-1 -mr-2">Manage</button>}
      </div>

      {max > 0 && upcoming.length === 0 && <p className="text-xs text-text-muted">None scheduled yet.</p>}
      {upcoming.map((r) => {
        const payer = person(r.payerUid);
        const when = relativeDay(nextReminderAt(r)!);
        return (
          <div key={r.id} className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">{REMINDER_TYPE_ICON[r.label] || 'payments'}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-primary truncate">{r.label}{r.amount ? ` · ${r.amount.toLocaleString()}` : ''}</p>
              <p className="text-xs text-text-muted truncate">{reminderSummary(r)}</p>
            </div>
            {r.payerUid && <MemberAvatar name={nameOf(r.payerUid)} photo={payer?.photo} size={22} />}
            <span className={clsx('text-xs font-black rounded-full px-2.5 py-1 shrink-0', when === 'Today' ? 'bg-primary text-white' : 'bg-primary/10 text-primary')}>{when}</span>
          </div>
        );
      })}

      {forMe && (
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-text-muted">Remind me with</p>
          <ReminderModeChooser value={effective} onChange={pick} allowOff disabled={saving} />
          <p className="text-xs text-text-muted">
            {effective === 'off'
              ? 'Off: nothing rings for you in this group, and people cannot ring you.'
              : 'For your scheduled reminders and when someone rings you.'}
            {effective === 'alarm' && !canRingPaymentAlarm() ? ' The alarm rings on Android; here you get a notification.' : ''}
          </p>
        </div>
      )}

      {children}
    </div>
  );
}
