import React, { useState } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import {
  PAY_FREQ_OPTIONS, PaymentReminder, REMINDER_TYPES, canRingPaymentAlarm, deletePaymentReminder, getPaymentReminders,
  newReminderId, nextReminderAt, reminderSummary, savePaymentReminder, syncPaymentReminders,
} from '../lib/paymentReminders';
import { toLocalDateString } from '../lib/dateUtils';

// Reminders to add a payment in a Payments group: what it is for, the day (and time) it is to be added, how often it comes back, and
// whether it arrives as a notification or rings like an alarm. Sits over the bottom bar so its buttons are never behind it.
export default function PaymentRemindersSheet({ groupId, groupName, categoryNames, groupNameOf, onClose }: {
  groupId: string;
  groupName: string;
  categoryNames: string[]; // the group's own payment categories, offered after the usual types
  groupNameOf: (groupId: string) => string;
  onClose: () => void;
}) {
  const { user, profile } = useAuth();
  const all = getPaymentReminders(profile);
  const mine = all.filter((r) => r.groupId === groupId).sort((a, b) => (nextReminderAt(a)?.getTime() ?? Infinity) - (nextReminderAt(b)?.getTime() ?? Infinity));
  const [editing, setEditing] = useState<PaymentReminder | null>(null);

  const persist = async (next: PaymentReminder[]) => { await syncPaymentReminders(next, groupNameOf); };

  const toggle = async (r: PaymentReminder) => {
    if (!user) return;
    const next = { ...r, active: !r.active };
    await savePaymentReminder(user.uid, next).catch((err) => console.error('Could not change the reminder:', err));
    await persist(all.map((x) => (x.id === r.id ? next : x)));
  };

  if (editing) {
    return (
      <Editor
        initial={editing}
        exists={all.some((x) => x.id === editing.id)}
        types={Array.from(new Set([...REMINDER_TYPES.filter((t) => t !== 'Other'), ...categoryNames.filter((c) => !/^other$/i.test(c)), 'Other']))}
        onBack={() => setEditing(null)}
        onSaved={async (saved) => {
          if (!user) return;
          await savePaymentReminder(user.uid, saved);
          await persist([...all.filter((x) => x.id !== saved.id), saved]);
          setEditing(null);
        }}
        onDelete={async (id) => {
          if (!user) return;
          await deletePaymentReminder(user.uid, id);
          await persist(all.filter((x) => x.id !== id));
          setEditing(null);
        }}
      />
    );
  }

  const blank = (): PaymentReminder => ({ id: newReminderId(), groupId, label: 'Rent', amount: null, startDate: toLocalDateString(new Date()), time: '09:00', freq: 'monthly', mode: 'notification', active: true });

  return (
    <Shell onClose={onClose} title="Payment reminders" subtitle={groupName}>
      {mine.length === 0 && (
        <p className="rounded-2xl border border-dashed border-border-subtle p-4 text-center text-sm text-text-muted">
          No reminders yet. Set one for rent or a bill and we will nudge you on the day to add the payment here.
        </p>
      )}
      <div className="space-y-2">
        {mine.map((r) => {
          const next = nextReminderAt(r);
          return (
            <div key={r.id} className={clsx('flex items-center gap-3 rounded-2xl border border-border-subtle p-3', !r.active && 'opacity-60')}>
              <button type="button" onClick={() => setEditing(r)} className="flex-1 min-w-0 text-left">
                <p className="text-sm font-black text-primary truncate">
                  <span className="material-symbols-outlined text-[16px] align-[-3px] mr-1">{r.mode === 'alarm' ? 'alarm' : 'notifications'}</span>
                  {r.label}{r.amount ? ` · ${r.amount.toLocaleString()}` : ''}
                </p>
                <p className="text-[11px] text-text-muted truncate">{reminderSummary(r)}</p>
                <p className="text-[11px] font-bold text-text-muted">
                  {!r.active ? 'Paused' : next ? `Next: ${next.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Done'}
                </p>
              </button>
              <button type="button" role="switch" aria-checked={r.active} aria-label={r.active ? 'Pause reminder' : 'Turn reminder on'} onClick={() => toggle(r)}
                className={clsx('w-11 h-6 rounded-full relative shrink-0 transition-colors', r.active ? 'bg-primary' : 'bg-border-subtle')}>
                <span className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all', r.active ? 'left-6' : 'left-1')} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => setEditing(blank())} className="w-full rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95">＋ New reminder</button>
    </Shell>
  );
}

function Editor({ initial, exists, types, onBack, onSaved, onDelete }: {
  initial: PaymentReminder;
  exists: boolean; // already saved (so it can be deleted)
  types: string[];
  onBack: () => void;
  onSaved: (r: PaymentReminder) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const known = types.includes(initial.label);
  const [type, setType] = useState(known ? initial.label : 'Other');
  const [custom, setCustom] = useState(known ? '' : initial.label);
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : '');
  const [startDate, setStartDate] = useState(initial.startDate);
  const [time, setTime] = useState(initial.time);
  const [freq, setFreq] = useState(initial.freq);
  const [mode, setMode] = useState(initial.mode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const label = type === 'Other' ? custom.trim() : type;

  const save = async () => {
    if (!label) return setError('Say what the payment is for.');
    if (!startDate) return setError('Choose the date to add the payment.');
    if (!time) return setError('Choose a time.');
    setSaving(true);
    setError('');
    try {
      await onSaved({ ...initial, label: label.slice(0, 60), amount: Number(amount) > 0 ? Number(amount) : null, startDate, time, freq, mode, active: true });
    } catch (err) {
      console.error('Could not save the reminder:', err);
      setError('Could not save the reminder. Check your connection and try again.');
      setSaving(false);
    }
  };

  const chip = (on: boolean) => clsx('px-3 py-1.5 rounded-full text-xs font-bold border', on ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle');

  return (
    <Shell onClose={onBack} title={exists ? 'Edit reminder' : 'New reminder'} back>
      <div className="space-y-1">
        <label className="text-[11px] font-bold text-text-muted px-1">What is the payment for</label>
        <div className="flex flex-wrap gap-2">
          {types.map((t) => <button key={t} type="button" onClick={() => setType(t)} className={chip(type === t)}>{t}</button>)}
        </div>
        {type === 'Other' && (
          <input value={custom} maxLength={60} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Pocket money" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">Add the payment on</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-bold text-text-muted px-1">At</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-bold text-text-muted px-1">Repeat</label>
        <div className="flex flex-wrap gap-2">
          {PAY_FREQ_OPTIONS.map((o) => <button key={o.id} type="button" onClick={() => setFreq(o.id)} className={chip(freq === o.id)}>{o.label}</button>)}
        </div>
        {freq === 'monthly' && <p className="text-[10px] text-text-muted px-1">On a short month it comes on the last day.</p>}
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-bold text-text-muted px-1">Amount (optional)</label>
        <input type="number" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Shown in the reminder" className="w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent" />
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-bold text-text-muted px-1">Remind me with</label>
        <div className="grid grid-cols-2 gap-2">
          {([['notification', 'notifications', 'Notification', 'A normal alert'], ['alarm', 'alarm', 'Alarm', 'Rings until you act']] as const).map(([id, icon, name, hint]) => (
            <button key={id} type="button" onClick={() => setMode(id)} className={clsx('rounded-2xl border-[1.5px] p-3 text-left', mode === id ? 'border-primary bg-primary/5' : 'border-border-subtle')}>
              <span className="material-symbols-outlined text-[22px] text-primary">{icon}</span>
              <span className="block text-sm font-extrabold text-primary">{name}</span>
              <span className="block text-[11px] text-text-muted">{hint}</span>
            </button>
          ))}
        </div>
        {mode === 'alarm' && !canRingPaymentAlarm() && <p className="text-[10px] text-text-muted px-1">The alarm rings on Android phones. On this device you get a notification.</p>}
      </div>

      {error && <p className="text-xs font-bold text-error">{error}</p>}
      <button type="button" onClick={save} disabled={saving} className="w-full rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95 disabled:opacity-50">{saving ? 'Saving…' : 'Save reminder'}</button>
      {exists && (
        <button type="button" onClick={() => { if (window.confirm(`Delete the ${initial.label} reminder?`)) onDelete(initial.id).catch((err) => console.error('Could not delete the reminder:', err)); }}
          className="w-full text-center text-sm font-bold text-error py-2">Delete reminder</button>
      )}
    </Shell>
  );
}

function Shell({ title, subtitle, onClose, back, children }: { title: string; subtitle?: string; onClose: () => void; back?: boolean; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-5 space-y-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          {back && <button type="button" onClick={onClose} aria-label="Back" className="p-1 -ml-1 text-text-muted"><span className="material-symbols-outlined">arrow_back</span></button>}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-black text-primary">{title}</h2>
            {subtitle && <p className="text-[11px] text-text-muted truncate">{subtitle}</p>}
          </div>
          {!back && <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-text-muted"><span className="material-symbols-outlined">close</span></button>}
        </div>
        {children}
      </div>
    </div>
  );
}
