import { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../lib/constants';
import FrequencyPicker from './FrequencyPicker';
import { FrequencyConfig, firstOccurrenceOnOrAfter, frequencyConfigForUpdate } from '../lib/frequency';
import { evaluateAmountSum } from '../lib/amountMath';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';

// Edit a recurring expense without leaving the list it was tapped in: what it is called, how much, the category, how often, whether it is paused, and
// whether it is added automatically. Splits and photos stay in the full editor (the "More options" link opens it for this rule).
export default function RecurringQuickEdit({
  rule,
  groupId,
  currencySymbol,
  canSetAutoAdd,
  actorName,
  onClose,
  onMoreOptions,
}: {
  rule: any;
  groupId: string;
  currencySymbol: string;
  canSetAutoAdd: boolean;
  actorName: string;
  onClose: () => void;
  onMoreOptions: () => void;
}) {
  const isIncome = rule.type === 'income';
  const categories = isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const [description, setDescription] = useState<string>(rule.description || '');
  const [amount, setAmount] = useState<string>(String(rule.amount ?? ''));
  const [category, setCategory] = useState<string>(rule.category);
  const original: FrequencyConfig = {
    frequency: rule.frequency,
    dayOfWeek: rule.dayOfWeek,
    daysOfWeek: rule.daysOfWeek,
    dayOfMonth: rule.dayOfMonth,
    month: rule.month,
    hour: rule.hour,
    minute: rule.minute,
  };
  const [freq, setFreq] = useState<FrequencyConfig>(original);
  const [active, setActive] = useState<boolean>(rule.active !== false);
  const [autoAdd, setAutoAdd] = useState<boolean>(rule.autoAdd === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const parsed = evaluateAmountSum(amount);
    if (!parsed || parsed <= 0) {
      setError('Enter an amount above zero.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const freqChanged = JSON.stringify(freq) !== JSON.stringify(original);
      await updateDoc(doc(db, 'recurringExpenses', rule.id), {
        description: description.trim(),
        amount: parsed,
        category,
        active,
        // the next date is only recalculated when the schedule itself was changed
        ...(freqChanged ? { ...frequencyConfigForUpdate(freq), nextRunDate: firstOccurrenceOnOrAfter(freq, new Date()).toISOString() } : {}),
        ...(canSetAutoAdd ? { autoAdd } : {}),
      });
      notifyGroupActivity({ groupId, action: 'recurring_changed', description: description.trim() || undefined, amount: parsed, actorName });
      onClose();
    } catch (e) {
      console.error('Failed to save recurring expense:', e);
      setError('Could not save. Try again.');
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-black text-primary">Edit {isIncome ? 'recurring income' : 'recurring expense'}</h4>
        <button type="button" onClick={onClose} className="text-xs font-bold text-text-muted">Back</button>
      </div>

      <label className="block space-y-1">
        <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Name</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={80} className="w-full h-11 bg-surface px-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20" placeholder="What is it for?" />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Amount</span>
          <div className="flex items-center h-11 bg-surface rounded-xl border border-border-subtle px-3 gap-1">
            <span className="text-sm font-bold text-text-muted">{currencySymbol}</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="flex-1 min-w-0 bg-transparent text-sm font-bold outline-none" />
          </div>
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-11 bg-surface px-2 rounded-xl border border-border-subtle text-sm outline-none">
            {categories.map((c: any) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="space-y-1">
        <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">How often</span>
        <FrequencyPicker config={freq} onChange={setFreq} />
      </div>

      <button type="button" onClick={() => setActive((v) => !v)} className={clsx('w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left', active ? 'border-border-subtle bg-white' : 'border-amber-300 bg-amber-50')}>
        <span><span className="block text-sm font-bold text-primary">{active ? 'Running' : 'Paused'}</span><span className="block text-[11px] text-text-muted">{active ? 'It keeps coming due on schedule.' : 'Nothing is added or asked while it is paused.'}</span></span>
        <span className={clsx('w-10 h-5 rounded-full relative shrink-0', active ? 'bg-primary' : 'bg-gray-300')}><span className={clsx('w-4 h-4 bg-white rounded-full absolute top-0.5 shadow-md', active ? 'right-0.5' : 'left-0.5')} /></span>
      </button>

      {canSetAutoAdd ? (
        <button type="button" onClick={() => setAutoAdd((v) => !v)} className={clsx('w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left', autoAdd ? 'border-primary bg-primary/5' : 'border-border-subtle bg-white')}>
          <span className="min-w-0"><span className="block text-sm font-bold text-primary">Add automatically</span><span className="block text-[11px] text-text-muted leading-snug">{autoAdd ? 'Added by itself each time, in your name. No confirmation.' : 'Off: you are asked to accept, change or decline each time.'}</span></span>
          <span className={clsx('w-10 h-5 rounded-full relative shrink-0', autoAdd ? 'bg-primary' : 'bg-gray-200')}><span className={clsx('w-4 h-4 bg-white rounded-full absolute top-0.5 shadow-md', autoAdd ? 'right-0.5' : 'left-0.5')} /></span>
        </button>
      ) : (
        <p className="text-[11px] text-text-muted px-1">{rule.autoAdd === true ? 'This one is added automatically. Only the person who set it up can change that.' : 'Only the person who set this up can turn on automatic adding.'}</p>
      )}

      {error && <p className="text-xs font-bold text-error px-1">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border-subtle text-sm font-bold text-text-muted">Cancel</button>
        <button type="button" onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
      </div>
      <button type="button" onClick={onMoreOptions} className="w-full text-center text-[11px] font-bold text-primary underline decoration-dotted">More options (split, photos)</button>
    </div>
  );
}
