import React, { useMemo } from 'react';
import { collection, doc, query, updateDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// For a Payments group: where this person keeps their side of the payments, set once. Every payment then suggests these groups
// (payments you make as an expense in one of your groups, payments you receive as income in another), and it can still be changed
// for any single payment.
export default function PaymentTrackingDefaults({ groupId, member }: { groupId: string; member: any }) {
  const { user } = useAuth();
  const [membershipsSnap] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = useMemo(() => Array.from(new Set((membershipsSnap?.docs || []).map((d) => (d.data() as any).groupId as string))).slice(0, 30), [membershipsSnap]);
  const [groupsSnap] = useCollection(groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null);
  const groups = useMemo(
    () => (groupsSnap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [])
      .filter((g: any) => g.groupType !== 'payments' && !g.archived && g.id !== groupId)
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))),
    [groupsSnap, groupId],
  );

  const set = (field: 'trackExpenseGroupId' | 'trackIncomeGroupId', value: string) => {
    if (!member?.id) return;
    updateDoc(doc(db, 'members', member.id), { [field]: value }).catch((err) => console.error('Could not save the tracking choice:', err));
  };

  const select = (field: 'trackExpenseGroupId' | 'trackIncomeGroupId', list: any[]) => (
    <select
      value={member?.[field] && list.some((g) => g.id === member[field]) ? member[field] : ''}
      onChange={(e) => set(field, e.target.value)}
      className="w-full h-11 px-3 rounded-xl border border-border-subtle bg-surface text-sm font-bold text-on-surface outline-none focus:border-primary"
    >
      <option value="">Don't track it</option>
      {list.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );

  return (
    <section className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm space-y-3" data-tour="manage-group-tracking">
      <div>
        <h3 className="text-sm font-bold text-primary">Where do I track these?</h3>
        <p className="text-[11px] text-text-muted mt-0.5">Choose your own groups once. Each payment suggests them, and you can change it for any single payment.</p>
      </div>
      <div className="space-y-1">
        <label className="text-[11px] font-bold text-text-muted px-1">Payments I make, as an expense in</label>
        {select('trackExpenseGroupId', groups)}
      </div>
      <div className="space-y-1">
        <label className="text-[11px] font-bold text-text-muted px-1">Payments I receive, as income in</label>
        {select('trackIncomeGroupId', groups.filter((g: any) => g.incomeEnabled))}
        {groups.length > 0 && groups.every((g: any) => !g.incomeEnabled) && (
          <p className="text-[10px] text-text-muted px-1">None of your groups track income yet. Turn on "Track income" in one first.</p>
        )}
      </div>
    </section>
  );
}
