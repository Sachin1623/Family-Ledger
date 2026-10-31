import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, increment, query, where, writeBatch } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { getCategoryNameOverride, getCurrencySymbol, getGroupCategories } from '../lib/constants';
import { useIdentities } from '../lib/userIdentity';
import { markExpenseAdded } from '../lib/recentlyAddedExpenses';
import CategoryBadge from './CategoryBadge';

// "Track in my group": a payment lives in the Payments group as a record; each person can also keep it in their OWN group so their
// own spending and income stay complete. The payer tracks it as an expense, the receiver as income. When the chosen group splits
// expenses, the same split choices as Add Expense appear (who shares it: equally, by percentage, or by amount).
//
// useTrackInGroup holds the choices and the write; it is used by the "Add a payment" form (the choices appear inline when the
// switch is on and are saved together with the payment) and by TrackPaymentSheet (for an entry that already exists).

type SplitType = 'equally' | 'percentage' | 'amount';
type Role = 'payer' | 'receiver';

export type TrackDraft = { amount: number; label?: string; note?: string; date: string; images?: string[]; groupId: string };
export type TrackSaved = { id: string; amount: number; label?: string; note?: string; date: string; images?: string[]; groupId: string };

// the category a payment label most likely belongs to
const guessCategory = (label: string | undefined, income: boolean) => {
  const l = (label || '').toLowerCase();
  if (income) return l.includes('salary') ? 'salary' : l.includes('rent') ? 'house_rent' : 'other_income';
  if (l.includes('rent') || l.includes('maintenance')) return 'housing';
  if (l.includes('emi')) return 'finance';
  if (l.includes('fee') || l.includes('tuition')) return 'education';
  if (l.includes('salary')) return 'household';
  return 'misc';
};

export function useTrackInGroup(draft: TrackDraft, role: Role, enabled = true, defaultGroupId?: string) {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const income = role === 'receiver';

  // my groups that can take this entry: not Payments groups, not archived, and for income only where income is tracked
  const [membershipsSnap] = useCollection(enabled && user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = useMemo(() => Array.from(new Set((membershipsSnap?.docs || []).map((d) => (d.data() as any).groupId as string))).slice(0, 30), [membershipsSnap]);
  const [groupsSnap] = useCollection(enabled && groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null);
  const groups = useMemo(
    () => (groupsSnap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [])
      .filter((g: any) => g.groupType !== 'payments' && !g.archived && g.id !== draft.groupId && (!income || g.incomeEnabled))
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))),
    [groupsSnap, income, draft.groupId],
  );

  const [groupId, setGroupId] = useState('');
  const group: any = groups.find((g: any) => g.id === groupId);
  // the group this person chose as their default for this Payments group is pre-selected (still changeable for this payment);
  // otherwise, with a single possible group, that one
  useEffect(() => {
    if (!enabled || groupId) return;
    if (defaultGroupId && groups.some((g: any) => g.id === defaultGroupId)) setGroupId(defaultGroupId);
    else if (groups.length === 1) setGroupId(groups[0].id);
  }, [enabled, groups, groupId, defaultGroupId]);

  const [category, setCategory] = useState(guessCategory(draft.label, income));
  const categories = useMemo(() => (group ? getGroupCategories(group, income ? 'income' : 'expense') : []), [group, income]);
  useEffect(() => {
    if (categories.length > 0 && !categories.some((c) => c.id === category)) {
      const guess = guessCategory(draft.label, income);
      setCategory(categories.some((c) => c.id === guess) ? guess : categories[categories.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories]);

  // splitting — only for an expense in a group that splits
  const splits = !income && !!group?.splitEnabled;
  const [membersSnap] = useCollection(enabled && groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null);
  const groupMembers = useMemo(() => (membersSnap?.docs.map((d) => d.data() as any) || []), [membersSnap]);
  const resolve = useIdentities(groupMembers.map((m) => m.userId));
  const nameOf = (m: any) => (m.userId === user?.uid ? 'You' : resolve(m.userId, m.displayName).name || 'Member');
  const [splitType, setSplitType] = useState<SplitType>('equally');
  const [splitMembers, setSplitMembers] = useState<string[]>([]);
  const [memberSplits, setMemberSplits] = useState<Record<string, number>>({});
  useEffect(() => { setSplitMembers(groupMembers.map((m) => m.userId)); setMemberSplits({}); }, [groupId, membersSnap]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchSplitType = (next: SplitType) => {
    setSplitType(next);
    const n = splitMembers.length || 1;
    setMemberSplits(Object.fromEntries(splitMembers.map((uid) => [uid, next === 'percentage' ? Math.round((100 / n) * 100) / 100 : Math.round(((draft.amount || 0) / n) * 100) / 100])));
  };
  const toggleMember = (uid: string) => setSplitMembers((prev) => (prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid]));

  const symbol = getCurrencySymbol(group?.currency);

  // what has to be right before anything is saved: a group, a category and (when it splits) a split that adds up
  const validate = (): { error: string | null; splitInfo?: any } => {
    if (!group) return { error: 'Choose the group to track it in.' };
    if (!category) return { error: 'Choose a category for it.' };
    if (!splits) return { error: null };
    const amount = draft.amount || 0;
    if (splitMembers.length === 0) return { error: 'Choose at least one person to share it with.' };
    if (splitType === 'percentage') {
      const total = splitMembers.reduce((n, uid) => n + (memberSplits[uid] || 0), 0);
      if (splitMembers.some((uid) => (memberSplits[uid] || 0) < 0)) return { error: 'Percentages cannot be negative.' };
      if (Math.abs(total - 100) > 0.001) return { error: `The percentages must add up to 100. Now: ${total}.` };
      return { error: null, splitInfo: { splitType, splits: splitMembers.map((uid) => ({ userId: uid, percentage: memberSplits[uid] || 0, amount: (amount * (memberSplits[uid] || 0)) / 100 })) } };
    }
    if (splitType === 'amount') {
      const total = splitMembers.reduce((n, uid) => n + (memberSplits[uid] || 0), 0);
      if (splitMembers.some((uid) => (memberSplits[uid] || 0) < 0)) return { error: 'Amounts cannot be negative.' };
      if (Math.abs(total - amount) > 0.01) return { error: `The amounts must add up to ${symbol}${amount}. Now: ${symbol}${total}.` };
      return { error: null, splitInfo: { splitType, splits: splitMembers.map((uid) => ({ userId: uid, amount: memberSplits[uid] || 0 })) } };
    }
    return { error: null, splitInfo: { splitType, splits: splitMembers.map((uid) => ({ userId: uid, amount: amount / splitMembers.length })) } };
  };

  // writes the expense (or income) in the chosen group, bumps that group's totals, logs it, and notes where it went
  const commit = async (payment: TrackSaved): Promise<{ groupId: string; groupName: string }> => {
    if (!user || !group) throw new Error('No group chosen.');
    const { error, splitInfo } = validate();
    if (error) throw new Error(error);
    const actorName = profile?.displayName || user.displayName || 'Someone';
    const description = `${payment.label || 'Payment'}${payment.note ? ` – ${payment.note}` : ''}`.slice(0, 200);
    const expenseRef = doc(collection(db, 'expenses'));
    const batch = writeBatch(db);
    batch.set(expenseRef, {
      groupId,
      amount: payment.amount,
      description,
      category,
      date: payment.date,
      paidBy: user.uid,
      paymentMethod: 'upi',
      addedBy: user.uid,
      type: income ? 'income' : 'expense',
      createdAt: new Date().toISOString(),
      favoritedBy: [],
      linkedPaymentId: payment.id,
      ...(payment.images?.length ? { images: payment.images } : {}),
      ...(splitInfo ? { splitInfo } : {}),
    });
    batch.update(doc(db, 'groups', groupId), {
      totalSpending: increment(income ? 0 : payment.amount),
      totalIncome: increment(income ? payment.amount : 0),
    });
    batch.set(doc(collection(db, 'activities')), {
      groupId,
      userId: user.uid,
      userName: actorName,
      userPhoto: profile?.photoURL || user.photoURL || '',
      type: income ? 'add_income' : 'add_expense',
      description: `${actorName} ${income ? 'added income' : 'added an expense'}: ${description}`,
      data: { amount: payment.amount, description, groupName: group.name, currencySymbol: symbol, currencyCode: group.currency },
      createdAt: new Date().toISOString(),
    });
    // remembers that this person has tracked this payment, so it is offered once and shows where it went
    batch.set(doc(db, 'paymentLinks', `${payment.id}_${user.uid}`), {
      paymentId: payment.id, uid: user.uid, role, groupId, groupName: group.name, expenseId: expenseRef.id, createdAt: new Date().toISOString(),
    });
    await batch.commit();
    markExpenseAdded(groupId, expenseRef.id);
    return { groupId, groupName: group.name };
  };

  // the choices themselves: which group, which category, and the split when that group splits
  const fields = (
    <div className="space-y-4">
      {groups.length === 0 ? (
        <p className="text-sm text-text-muted rounded-xl bg-surface p-3">
          {income ? 'None of your groups track income yet. Turn on “Track income” in a group first.' : 'You have no other group to track this in yet.'}
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-text-muted px-1">Which group should it be tracked in?</label>
            <div className="flex flex-wrap gap-2">
              {groups.map((g: any) => (
                <button key={g.id} type="button" onClick={() => setGroupId(g.id)} className={clsx('px-3 py-2 rounded-xl text-xs font-bold border', groupId === g.id ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}>
                  {g.name}
                </button>
              ))}
            </div>
          </div>

          {group && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-text-muted px-1">Category</label>
              <div className="grid grid-cols-5 gap-x-1.5 gap-y-2.5">
                {categories.map((cat) => {
                  const picked = category === cat.id;
                  const label = getCategoryNameOverride(group, cat.id) || t(`${income ? 'income' : 'category'}.${cat.id}`);
                  return (
                    <button key={cat.id} type="button" onClick={() => setCategory(cat.id)} className="flex flex-col items-center gap-1 active:scale-95 transition-all">
                      <span className={clsx('rounded-full p-[3px] transition-all', picked ? 'ring-[3px] ring-primary' : 'ring-0')}><CategoryBadge id={cat.id} icon={cat.icon} size={40} /></span>
                      <span className={clsx('text-[10px] leading-tight text-center truncate w-full px-0.5', picked ? 'font-extrabold text-primary' : 'font-bold text-text-muted')}>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {splits && (
            <div className="space-y-2.5 rounded-2xl border border-border-subtle p-3">
              <p className="text-[11px] font-black uppercase tracking-wider text-text-muted">This group splits expenses</p>
              <div className="flex items-center gap-2 text-xs text-text-muted"><span className="font-bold">Paid by</span><span className="rounded-full bg-primary/10 text-primary font-bold px-2.5 py-1">You</span></div>
              <div>
                <p className="text-[11px] font-bold text-text-muted mb-1.5">Share it with</p>
                <div className="flex flex-wrap gap-2">
                  {groupMembers.map((m) => (
                    <button key={m.userId} type="button" onClick={() => toggleMember(m.userId)} className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border', splitMembers.includes(m.userId) ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}>
                      {nameOf(m)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {([['equally', 'Equally', 'balance'], ['percentage', 'Percentage', 'percent'], ['amount', 'Amount', 'payments']] as const).map(([id, label, icon]) => (
                  <button key={id} type="button" onClick={() => (id === 'equally' ? setSplitType('equally') : switchSplitType(id))} className={clsx('flex flex-col items-center p-2 rounded-xl border gap-1 active:scale-95', splitType === id ? 'bg-primary text-white border-primary' : 'bg-white border-border-subtle')}>
                    <span className="material-symbols-outlined text-[18px]">{icon}</span><span className="text-[10px] font-bold">{label}</span>
                  </button>
                ))}
              </div>
              {splitType !== 'equally' && splitMembers.length > 0 && (
                <div className="space-y-1.5">
                  {groupMembers.filter((m) => splitMembers.includes(m.userId)).map((m) => (
                    <div key={m.userId} className="flex items-center gap-2">
                      <span className="flex-1 text-sm font-bold truncate">{nameOf(m)}</span>
                      <div className="flex items-center gap-1 rounded-xl border border-border-subtle px-2 w-28">
                        {splitType === 'amount' && <span className="text-[10px] font-bold text-primary">{symbol}</span>}
                        <input type="number" inputMode="decimal" min="0" value={memberSplits[m.userId] ?? ''} onChange={(e) => setMemberSplits((prev) => ({ ...prev, [m.userId]: Number(e.target.value) }))} className="w-full h-9 bg-transparent text-sm font-bold outline-none text-right" />
                        {splitType === 'percentage' && <span className="text-[10px] font-bold text-primary">%</span>}
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] font-bold text-text-muted text-right">
                    {splitType === 'percentage'
                      ? `Total ${splitMembers.reduce((n, uid) => n + (memberSplits[uid] || 0), 0)}% of 100%`
                      : `Total ${symbol}${splitMembers.reduce((n, uid) => n + (memberSplits[uid] || 0), 0)} of ${symbol}${draft.amount || 0}`}
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  return { fields, group, validate, commit };
}

// For an entry that already exists: the same choices in a sheet, with its own save
export default function TrackPaymentSheet({
  payment, role, defaultGroupId, onClose, onDone,
}: {
  payment: TrackSaved;
  role: Role;
  defaultGroupId?: string;
  onClose: () => void;
  onDone?: (info: { groupId: string; groupName: string }) => void;
}) {
  const income = role === 'receiver';
  const track = useTrackInGroup(payment, role, true, defaultGroupId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const { error: problem } = track.validate();
    if (problem) return setError(problem);
    setSaving(true);
    setError('');
    try {
      const info = await track.commit(payment);
      onDone?.(info);
      onClose();
    } catch (err) {
      console.error('Could not track the payment:', err);
      setError('Could not save it. Check your connection and try again.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[320] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-5 space-y-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-primary">Track in my group</h2>
            <p className="text-xs text-text-muted mt-0.5">
              {income ? 'Keep this as income in one of your groups.' : 'Keep this as an expense in one of your groups.'} {payment.label || 'Payment'} · {getCurrencySymbol(track.group?.currency || 'INR')}{Math.round(payment.amount).toLocaleString()}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-text-muted"><span className="material-symbols-outlined">close</span></button>
        </div>

        {track.fields}

        {error && <p className="text-xs font-bold text-error">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-border-subtle py-3 text-sm font-bold text-text-muted active:scale-95">Not now</button>
          <button type="button" onClick={save} disabled={saving || !track.group} className="flex-1 rounded-xl bg-primary text-white py-3 text-sm font-black active:scale-95 disabled:opacity-50">
            {saving ? 'Saving…' : income ? 'Track as income' : 'Track as expense'}
          </button>
        </div>
      </div>
    </div>
  );
}
