import React, { useState } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { canPay } from './PaymentRolePicker';
import { PaymentReminder, canRingPaymentAlarm, getPayerModes, nextReminderAt, reminderSummary, setPayerMode } from '../lib/paymentReminders';

// What is scheduled for a Payments group, shown on the Dashboard card and in the reminders sheet: the next few reminders and who they
// ring for. A person a reminder rings for also gets the switch between Alarm and Notification, which applies to their scheduled
// reminders and to anyone's "ring now" alike.
export default function PaymentReminderGlance({ groupId, reminders, members, max = 3 }: {
  groupId: string;
  reminders: PaymentReminder[];
  members: { userId: string; role?: string; name?: string; displayName?: string }[];
  max?: number;
}) {
  const { user, profile } = useAuth();
  const [saving, setSaving] = useState(false);
  const me = members.find((m) => m.userId === user?.uid);
  const nameOf = (uid: string) => { const m = members.find((x) => x.userId === uid); return uid === user?.uid ? 'You' : m?.name || m?.displayName || 'Payer'; };
  const active = reminders.filter((r) => r.active && nextReminderAt(r));
  const upcoming = [...active].sort((a, b) => nextReminderAt(a)!.getTime() - nextReminderAt(b)!.getTime()).slice(0, max);
  const forMe = !!user && (canPay(me?.role) || reminders.some((r) => r.payerUid === user.uid));
  const chosen = getPayerModes(profile)[groupId] || '';
  // with no choice made, what the reminders were set up with
  const effective = chosen || (reminders.find((r) => r.active)?.mode ?? 'notification');

  if (upcoming.length === 0 && !forMe) return null;
  const pick = async (mode: 'alarm' | 'notification') => {
    if (!user || saving || mode === effective) return;
    setSaving(true);
    await setPayerMode(user.uid, groupId, mode).catch((err) => console.error('Could not save the reminder choice:', err));
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border-subtle px-3 py-2.5 space-y-2">
      <p className="text-[10px] font-black uppercase tracking-wider text-text-muted">Payment reminders</p>
      {max > 0 && upcoming.length === 0 && <p className="text-xs text-text-muted">None scheduled yet.</p>}
      {upcoming.map((r) => (
        <div key={r.id} className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-bold text-primary truncate">{r.label}{r.amount ? ` · ${r.amount.toLocaleString()}` : ''}</p>
            <p className="text-[11px] text-text-muted truncate">{reminderSummary(r)} · {r.payerUid ? nameOf(r.payerUid) : 'The payer'}</p>
          </div>
          <p className="text-[11px] font-black text-primary shrink-0">{nextReminderAt(r)!.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</p>
        </div>
      ))}
      {forMe && (
        <div className="space-y-1">
          <p className="text-[11px] font-bold text-text-muted">Remind me with</p>
          <div className="grid grid-cols-2 gap-2">
            {([['alarm', 'alarm', 'Alarm'], ['notification', 'notifications', 'Notification']] as const).map(([id, icon, name]) => (
              <button key={id} type="button" disabled={saving} onClick={() => pick(id)}
                className={clsx('flex items-center justify-center gap-1.5 rounded-xl border-[1.5px] py-2 text-xs font-black', effective === id ? 'border-primary bg-primary/5 text-primary' : 'border-border-subtle text-text-muted')}>
                <span className="material-symbols-outlined text-[16px]">{icon}</span>{name}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-text-muted">For your scheduled reminders and when someone rings you.{effective === 'alarm' && !canRingPaymentAlarm() ? ' The alarm rings on Android; here you get a notification.' : ''}</p>
        </div>
      )}
    </div>
  );
}
