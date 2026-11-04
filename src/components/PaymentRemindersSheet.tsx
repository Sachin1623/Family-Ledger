import React, { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { motion, useDragControls } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import {
  PAY_FREQ_LABEL, PAY_FREQ_OPTIONS, PayFreq, PayerMode, PaymentReminder, REMINDER_PRESETS, REMINDER_TYPE_ICON, canRingPaymentAlarm, deletePaymentReminder,
  getPayerModes, newReminderId, nextReminderAt, relativeDay, reminderSummary, savePaymentReminder, timeLabel,
} from '../lib/paymentReminders';
import { canPay } from './PaymentRolePicker';
import MemberAvatar from './MemberAvatar';
import PaymentReminderGlance from './PaymentReminderGlance';
import RingPayerButtons from './RingPayerButtons';
import ReminderModeChooser from './ReminderModeChooser';
import ReminderDeliveryNotice from './ReminderDeliveryNotice';
import { KIND_STYLE } from '../lib/groupKindStyle';
import { toLocalDateString } from '../lib/dateUtils';
import { useModalBack } from '../lib/useModalBack';

type Person = { userId: string; name: string; photo?: string; role?: string };
export type ReminderType = { name: string; icon: string }; // icon: a Material symbol, or an emoji for a category the group added

const style = KIND_STYLE.payments;

const TypeGlyph = ({ icon, size = 22 }: { icon: string; size?: number }) => (/^[a-z_]+$/.test(icon)
  ? <span className="material-symbols-outlined" style={{ fontSize: size }}>{icon}</span>
  : <span className="leading-none" style={{ fontSize: size }}>{icon}</span>);

// the next date that falls on this day of the month (this month if it is still ahead)
const nextOnDay = (day: number) => {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
  return toLocalDateString(thisMonth.getTime() > now.getTime() ? thisMonth : new Date(now.getFullYear(), now.getMonth() + 1, day));
};

// Reminders to add a payment in a Payments group: what it is for, the day (and time) it is to be added, how often it comes back, who it
// is for, and whether it arrives as a notification or rings like an alarm. It rings only for the payer: the member picked here, or
// whoever is marked Payer in the group, even if they join after the reminder is set. Sits over the bottom bar so its buttons are never behind it.
// Back closes the editor first and then the sheet, and an editor with unsaved changes asks before it lets them go.
export default function PaymentRemindersSheet({ groupId, groupName, symbol, typeOptions, reminders, members, isAdmin, onClose }: {
  groupId: string;
  groupName: string;
  symbol: string;
  typeOptions: ReminderType[]; // the usual types, then the group's own payment categories
  reminders: PaymentReminder[];
  members: Person[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { user, profile } = useAuth();
  const [editing, setEditing] = useState<PaymentReminder | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const opened = useRef(false);
  useEffect(() => { opened.current = true; }, []);
  useModalBack(onClose);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const sorted = [...reminders].sort((a, b) => (nextReminderAt(a)?.getTime() ?? Infinity) - (nextReminderAt(b)?.getTime() ?? Infinity));
  const payers = members.filter((m) => canPay(m.role));
  const me = members.find((m) => m.userId === user?.uid);
  const youName = (m: Person) => (m.userId === user?.uid ? 'You' : m.name);
  const myChoice = getPayerModes(profile)[groupId];

  const personFor = (r: PaymentReminder) => (r.payerUid ? members.find((x) => x.userId === r.payerUid) : undefined);
  // who a reminder rings for, in words
  const ringsFor = (r: PaymentReminder): { text: string; waiting: boolean; people: Person[] } => {
    if (r.payerUid) {
      const m = personFor(r);
      return m ? { text: `Rings for ${youName(m)}`, waiting: false, people: [m] } : { text: 'Waiting for the payer to join', waiting: true, people: [] };
    }
    if (payers.length === 0) return { text: 'Waiting for a payer to join', waiting: true, people: [] };
    return { text: `Rings for ${payers.map(youName).join(', ')}`, waiting: false, people: payers };
  };
  const ringsForMe = (r: PaymentReminder) => (r.payerUid ? r.payerUid === user?.uid : canPay(me?.role));
  // what the person looking at this will actually get: their own choice if the reminder rings for them
  const modeOf = (r: PaymentReminder): PayerMode => (ringsForMe(r) && myChoice ? myChoice : r.mode);
  const needsDelivery = canPay(me?.role) || reminders.some((r) => r.active && ringsForMe(r));

  const canDeleteIt = (r: PaymentReminder) => !!user && (r.createdBy === user.uid || isAdmin);
  const toggle = (r: PaymentReminder) => savePaymentReminder({ ...r, active: !r.active }).catch((err) => console.error('Could not change the reminder:', err));

  const blank = (over: Partial<PaymentReminder> = {}): PaymentReminder => ({
    id: newReminderId(), groupId, label: 'Rent', amount: null, startDate: toLocalDateString(new Date()), time: '09:00', freq: 'monthly', mode: 'notification',
    active: true, groupName, payerUid: null, createdBy: user?.uid, skipped: [], ...over,
  });

  const saved = async (r: PaymentReminder, existed: boolean) => {
    await savePaymentReminder(r);
    setEditing(null);
    const next = nextReminderAt(r);
    setToast({ text: `${r.label} reminder ${existed ? 'updated' : 'set'}${next ? `. Next: ${next.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${timeLabel(r.time)}` : ''}` });
  };
  const removed = async (r: PaymentReminder) => {
    await deletePaymentReminder(r.id);
    setEditing(null);
    setToast({ text: `${r.label} reminder deleted`, undo: () => { void savePaymentReminder(r); setToast(null); } });
  };

  if (editing) {
    return (
      <React.Fragment key={editing.id}>
      <Editor
        initial={editing}
        exists={reminders.some((x) => x.id === editing.id)}
        canDelete={reminders.some((x) => x.id === editing.id) && canDeleteIt(editing)}
        symbol={symbol}
        members={members}
        types={typeOptions}
        onBack={() => setEditing(null)}
        onSaved={(r) => saved(r, reminders.some((x) => x.id === r.id))}
        onDelete={removed}
      />
      </React.Fragment>
    );
  }

  return (
    <Shell onClose={onClose} title="Payment reminders" subtitle={groupName} instant={opened.current} overlay={toast && (
        <div className="fixed left-4 right-4 z-[330] flex items-center gap-3 rounded-xl bg-on-surface px-4 py-3 text-white shadow-lg bottom-[calc(1rem+env(safe-area-inset-bottom))] sm:left-1/2 sm:right-auto sm:w-96 sm:-translate-x-1/2" role="status">
          <p className="flex-1 text-sm font-bold">{toast.text}</p>
          {toast.undo && <button type="button" onClick={toast.undo} className="text-sm font-black text-[#a5b4fc] px-2 py-1">Undo</button>}
        </div>
    )}>
      <ReminderDeliveryNotice needed={needsDelivery} />

      {payers.some((m) => m.userId !== user?.uid) && (
        <div className="rounded-2xl p-3 space-y-2" style={{ background: style.tint }}>
          <p className="text-xs font-bold" style={{ color: style.dark }}>Waiting on a payment? Make the payer's phone ring now.</p>
          <RingPayerButtons
            groupId={groupId}
            payers={payers.filter((m) => m.userId !== user?.uid).map((m) => ({ userId: m.userId, name: m.name, photo: m.photo }))}
            labelFor={(uid) => sorted.find((r) => r.active && (!r.payerUid || r.payerUid === uid))?.label || 'the payment'}
            accent={style.dark}
            onAccent={style.onAcc}
          />
        </div>
      )}

      <PaymentReminderGlance groupId={groupId} reminders={reminders} members={members} max={0} />

      {sorted.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border-subtle p-4 space-y-3">
          <p className="text-center text-sm text-text-muted">No reminders yet. Pick one to start, or make your own. We will nudge you on the day to add the payment here.</p>
          <div className="grid grid-cols-2 gap-2">
            {REMINDER_PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => setEditing(blank({ label: p.label, freq: p.freq, startDate: nextOnDay(p.day) }))}
                className="flex items-center gap-2 rounded-xl border border-border-subtle p-2.5 text-left active:scale-95">
                <span className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0"><TypeGlyph icon={REMINDER_TYPE_ICON[p.label] || 'payments'} size={20} /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-extrabold text-primary truncate">{p.label}</span>
                  <span className="block text-xs text-text-muted truncate">{PAY_FREQ_LABEL[p.freq]}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((r) => {
          const next = nextReminderAt(r);
          const rings = ringsFor(r);
          const mode = modeOf(r);
          const pill = !r.active ? { text: 'Paused', cls: 'bg-border-subtle text-text-muted' }
            : rings.waiting ? { text: 'Waiting for payer', cls: 'bg-amber-100 text-amber-800' }
            : !next ? { text: 'Done', cls: 'bg-border-subtle text-text-muted' }
            : { text: relativeDay(next), cls: relativeDay(next) === 'Today' ? 'bg-primary text-white' : 'bg-primary/10 text-primary' };
          return (
            <div key={r.id} className={clsx('flex items-center gap-2 rounded-2xl border border-border-subtle p-3', !r.active && 'opacity-60')}>
              <button type="button" onClick={() => setEditing(r)} className="flex flex-1 min-w-0 items-center gap-3 text-left">
                <span className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <TypeGlyph icon={typeOptions.find((t) => t.name === r.label)?.icon || REMINDER_TYPE_ICON[r.label] || 'payments'} size={22} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-black text-primary truncate">{r.label}{r.amount ? ` · ${symbol}${r.amount.toLocaleString()}` : ''}</span>
                    <span className="material-symbols-outlined text-[16px] text-text-muted shrink-0" aria-label={mode === 'off' ? 'Off for you' : mode}>
                      {mode === 'alarm' ? 'alarm' : mode === 'off' ? 'notifications_off' : 'notifications'}
                    </span>
                  </span>
                  <span className="block text-xs text-text-muted truncate">{reminderSummary(r)}</span>
                  <span className="mt-0.5 flex items-center gap-1 min-w-0">
                    {rings.people.slice(0, 3).map((m) => <span key={m.userId} className="flex"><MemberAvatar name={m.name} photo={m.photo} size={16} /></span>)}
                    <span className={clsx('text-xs truncate', rings.waiting ? 'text-amber-700 font-bold' : 'text-text-muted')}>{rings.text}</span>
                  </span>
                </span>
              </button>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <span className={clsx('text-xs font-black rounded-full px-2.5 py-1 whitespace-nowrap', pill.cls)}>{pill.text}</span>
                <button type="button" role="switch" aria-checked={r.active} aria-label={r.active ? 'Pause reminder' : 'Turn reminder on'} onClick={() => toggle(r)} className="p-2 -m-2">
                  <span className={clsx('block w-11 h-6 rounded-full relative transition-colors', r.active ? 'bg-primary' : 'bg-border-subtle')}>
                    <span className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all', r.active ? 'left-6' : 'left-1')} />
                  </span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => setEditing(blank())} className="w-full rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95">＋ New reminder</button>

    </Shell>
  );
}

function Editor({ initial, exists, canDelete, symbol, members, types, onBack, onSaved, onDelete }: {
  initial: PaymentReminder;
  members: Person[];
  exists: boolean; // already saved
  canDelete: boolean; // saved, and this person made it (or runs the group)
  symbol: string;
  types: ReminderType[];
  onBack: () => void;
  onSaved: (r: PaymentReminder) => Promise<void>;
  onDelete: (r: PaymentReminder) => Promise<void>;
}) {
  const { user } = useAuth();
  const known = types.some((t) => t.name === initial.label);
  const [type, setType] = useState(known ? initial.label : 'Other');
  const [custom, setCustom] = useState(known ? '' : initial.label);
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : '');
  const [startDate, setStartDate] = useState(initial.startDate);
  const [time, setTime] = useState(initial.time);
  const [freq, setFreq] = useState<PayFreq>(initial.freq);
  const [mode, setMode] = useState(initial.mode);
  const [payerUid, setPayerUid] = useState<string>(initial.payerUid || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const label = type === 'Other' ? custom.trim() : type;

  // anything changed since it was opened?
  const now = JSON.stringify([label, amount, startDate, time, freq, mode, payerUid]);
  const first = useRef(now);
  const dirty = now !== first.current;
  const leave = () => { if (dirty && !saving) setConfirming(true); else onBack(); };
  useModalBack(leave, !confirming);

  const draft = (): PaymentReminder => ({
    ...initial, label: label.slice(0, 60), amount: Number(amount) > 0 ? Number(amount) : null, startDate, time, freq, mode, payerUid: payerUid || null, active: initial.active,
    // moving the schedule makes the "already paid" marks meaningless
    skipped: startDate === initial.startDate && freq === initial.freq ? initial.skipped || [] : [],
  });

  const save = async () => {
    if (!label) return setError('Say what the payment is for.');
    if (!startDate) return setError('Choose the date to add the payment.');
    if (!time) return setError('Choose a time.');
    setSaving(true);
    setError('');
    try {
      await onSaved(draft());
    } catch (err) {
      console.error('Could not save the reminder:', err);
      setError('Could not save the reminder. Check your connection and try again.');
      setSaving(false);
    }
  };

  // the whole reminder in one sentence, so the chips and pickers above it can be checked at a glance
  const who = payerUid ? (payerUid === user?.uid ? 'you' : members.find((m) => m.userId === payerUid)?.name || 'the payer') : (() => {
    const payers = members.filter((m) => canPay(m.role));
    return payers.length ? payers.map((m) => (m.userId === user?.uid ? 'you' : m.name)).join(' and ') : 'the payer once they join';
  })();
  const nextAt = startDate ? nextReminderAt({ ...draft(), label: label || 'x' }) : null;
  const sentence = !startDate ? '' : `Rings ${who} ${mode === 'alarm' ? 'as an alarm' : 'as a notification'} ${freq === 'once' ? 'once' : PAY_FREQ_LABEL[freq].toLowerCase()} at ${timeLabel(time)}${nextAt ? `. Next: ${nextAt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}` : '. That date has already passed'}.`;

  const chip = (on: boolean) => clsx('px-3.5 py-2 rounded-full text-xs font-bold border', on ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle');
  const field = 'w-full rounded-xl border border-border-subtle px-3 py-2.5 text-sm font-bold bg-transparent';

  return (
    <Shell
      onClose={leave}
      title={exists ? 'Edit reminder' : 'New reminder'}
      back
      instant
      overlay={confirming && <ConfirmDiscard onKeep={() => setConfirming(false)} onDiscard={onBack} />}
      footer={(
        <div className="space-y-1.5">
          {sentence && <p className="text-xs font-bold text-text-muted">{sentence}</p>}
          {error && <p className="text-xs font-bold text-error">{error}</p>}
          <button type="button" onClick={save} disabled={saving} className="w-full rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95 disabled:opacity-50">{saving ? 'Saving…' : 'Save reminder'}</button>
          {canDelete && (
            <button type="button" onClick={() => { setSaving(true); onDelete(initial).catch((err) => { console.error('Could not delete the reminder:', err); setSaving(false); }); }}
              disabled={saving} className="w-full text-center text-sm font-bold text-error py-2">Delete reminder</button>
          )}
          {exists && !canDelete && <p className="text-xs text-text-muted text-center">Only the person who made this reminder, or a group admin, can delete it.</p>}
        </div>
      )}
    >
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-text-muted px-1">What is the payment for</label>
        <div className="grid grid-cols-3 gap-2">
          {types.map((t) => (
            <button key={t.name} type="button" onClick={() => setType(t.name)} aria-pressed={type === t.name}
              className={clsx('flex flex-col items-center gap-1 rounded-2xl border-[1.5px] px-1.5 py-2.5 text-center', type === t.name ? 'border-primary bg-primary/5 text-primary' : 'border-border-subtle text-text-muted')}>
              <TypeGlyph icon={t.icon} size={22} />
              <span className="text-xs font-bold leading-tight break-words w-full">{t.name}</span>
            </button>
          ))}
        </div>
        {type === 'Other' && (
          <input value={custom} maxLength={60} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Pocket money" className={field} />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-bold text-text-muted px-1">Add the payment on</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={field} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-bold text-text-muted px-1">At</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-bold text-text-muted px-1">Repeat</label>
        <div className="flex flex-wrap gap-2">
          {PAY_FREQ_OPTIONS.map((o) => <button key={o.id} type="button" onClick={() => setFreq(o.id)} aria-pressed={freq === o.id} className={chip(freq === o.id)}>{o.label}</button>)}
        </div>
        {freq === 'monthly' && <p className="text-xs text-text-muted px-1">On a short month it comes on the last day.</p>}
        {freq === 'weekly' && exists && <p className="text-xs text-text-muted px-1">A weekly reminder keeps ringing even if you add the payment early.</p>}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-bold text-text-muted px-1">Amount (optional)</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{symbol}</span>
          <input type="number" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Shown in the reminder" className={clsx(field, 'pl-8')} />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-bold text-text-muted px-1">Who should be reminded</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPayerUid('')} aria-pressed={!payerUid} className={chip(!payerUid)}>The payer</button>
          {[...members].sort((a, b) => Number(canPay(b.role)) - Number(canPay(a.role))).map((m) => (
            <button key={m.userId} type="button" onClick={() => setPayerUid(m.userId)} aria-pressed={payerUid === m.userId} className={clsx(chip(payerUid === m.userId), 'flex items-center gap-1.5')}><MemberAvatar name={m.name} photo={m.photo} size={18} />{m.name}</button>
          ))}
        </div>
        <p className="text-xs text-text-muted px-1">
          {payerUid ? "It rings only on this person's phone." : 'It rings on the phone of whoever is marked Payer in this group. If the payer is not added yet, it starts ringing for them as soon as they join.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-bold text-text-muted px-1">Remind with</label>
        <ReminderModeChooser variant="cards" value={mode} onChange={(m) => m !== 'off' && setMode(m)} />
        <p className="text-xs text-text-muted px-1">The person it rings for can switch this for themselves.</p>
        {mode === 'alarm' && !canRingPaymentAlarm() && <p className="text-xs text-text-muted px-1">The alarm rings on Android phones. On this device you get a notification.</p>}
      </div>

    </Shell>
  );
}

function ConfirmDiscard({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  useModalBack(onKeep);
  return (
    <div className="fixed inset-0 z-[340] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/50" onClick={onKeep} />
      <div className="relative w-full max-w-xs rounded-2xl bg-white p-5 space-y-3 shadow-xl" role="alertdialog" aria-label="Discard changes?">
        <h3 className="text-base font-black text-primary">Discard your changes?</h3>
        <p className="text-sm text-text-muted">What you changed on this reminder has not been saved.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onKeep} className="flex-1 rounded-xl bg-primary text-white py-2.5 text-sm font-black active:scale-95">Keep editing</button>
          <button type="button" onClick={onDiscard} className="flex-1 rounded-xl border border-border-subtle py-2.5 text-sm font-bold text-error active:scale-95">Discard</button>
        </div>
      </div>
    </div>
  );
}

// A bottom sheet over the bottom bar: it slides up, can be dragged down by its handle to close, and keeps its footer in view.
function Shell({ title, subtitle, onClose, back, footer, instant, overlay, children }: {
  title: string; subtitle?: string; onClose: () => void; back?: boolean; footer?: React.ReactNode; instant?: boolean; overlay?: React.ReactNode; children: React.ReactNode;
}) {
  const drag = useDragControls();
  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
      <motion.div className="absolute inset-0 bg-black/50" initial={instant ? false : { opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.div
        className="relative w-full sm:max-w-md max-h-[92vh] flex flex-col bg-white rounded-t-3xl sm:rounded-3xl"
        initial={instant ? false : { y: '100%' }}
        animate={{ y: 0 }}
        transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => { if (info.offset.y > 100 || info.velocity.y > 600) onClose(); }}
      >
        <div onPointerDown={(e) => drag.start(e)} className="flex justify-center pt-2.5 pb-1 touch-none cursor-grab shrink-0" aria-hidden="true">
          <span className="h-1.5 w-10 rounded-full bg-border-subtle" />
        </div>
        <div className="flex items-center gap-2 px-5 pb-3 shrink-0">
          {back && <button type="button" onClick={onClose} aria-label="Back" className="p-1.5 -ml-1.5 text-text-muted"><span className="material-symbols-outlined">arrow_back</span></button>}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-black text-primary">{title}</h2>
            {subtitle && <p className="text-xs text-text-muted truncate">{subtitle}</p>}
          </div>
          {!back && <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 text-text-muted"><span className="material-symbols-outlined">close</span></button>}
        </div>
        <div className={clsx('flex-1 overflow-y-auto px-5 space-y-4', footer ? 'pb-4' : 'pb-[calc(1.25rem+env(safe-area-inset-bottom))]')}>
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-border-subtle px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">{footer}</div>}
      </motion.div>
      {overlay}
    </div>
  );
}
