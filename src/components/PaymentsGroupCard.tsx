import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { getCurrencySymbol } from '../lib/constants';
import { KIND_STYLE } from '../lib/groupKindStyle';

// A Payments group on the Dashboard. It has no expenses, budget or month-to-month comparison, so it does not use the group
// card's tiles: it shows what you paid and what you received this month, and the one thing you do here, add a payment.
export default function PaymentsGroupCard({ groupId, group, membersCount, index }: { groupId: string; group: any; membersCount: number; index: number }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [snap] = useCollection(query(collection(db, 'groupPayments'), where('groupId', '==', groupId)));
  const style = KIND_STYLE.payments;
  const symbol = getCurrencySymbol(group?.currency);
  const money = (n: number) => `${symbol}${Math.round(n).toLocaleString()}`;

  const { paid, received, count, missing } = useMemo(() => {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let paidSum = 0;
    let receivedSum = 0;
    let n = 0;
    let noReceipt = 0;
    snap?.docs.forEach((d) => {
      const p: any = d.data();
      if (p.fromUid === user?.uid && !(p.images?.length)) noReceipt++;
      if (!(p.date || '').startsWith(monthKey)) return;
      n++;
      if (p.fromUid === user?.uid) paidSum += p.amount || 0;
      if (p.toUid === user?.uid) receivedSum += p.amount || 0;
    });
    return { paid: paidSum, received: receivedSum, count: n, missing: noReceipt };
  }, [snap, user?.uid]);

  const open = (add = false) => navigate(`/groups/${groupId}${add ? '?add=1' : ''}`);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      className="bg-white rounded-2xl border border-border-subtle shadow-sm hover:shadow-md transition-all overflow-hidden"
    >
      <div onClick={() => open()} className="flex items-center justify-between gap-2 px-6 pt-4 pb-3 border-b border-border-subtle cursor-pointer" style={{ background: style.headerWash }}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-white/70 flex items-center justify-center shrink-0 border overflow-hidden shadow-inner" style={{ borderColor: style.acc + '55' }}>
            {group?.photoURL ? <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : <span className="text-3xl">{group?.icon || '💸'}</span>}
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-on-surface line-clamp-1">{group?.name || 'Payments'}</h3>
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span>{membersCount} member{membersCount === 1 ? '' : 's'}</span>
              <span className="text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5" style={{ background: style.tint, color: style.dark }}>{style.label}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate(`/groups/${groupId}/manage`); }}
          aria-label="Group settings"
          className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-full transition-colors"
        >
          <span className="material-symbols-outlined text-[20px] block">settings</span>
        </button>
      </div>

      <div className="px-6 py-4 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl py-2.5 px-3" style={{ background: style.tint }}>
            <p className="text-[9px] uppercase font-bold tracking-wider text-text-muted">You paid · this month</p>
            <p className="text-lg font-black tabular-nums" style={{ color: style.dark }}>{money(paid)}</p>
          </div>
          <div className="rounded-xl py-2.5 px-3 bg-success/10">
            <p className="text-[9px] uppercase font-bold tracking-wider text-text-muted">You received · this month</p>
            <p className="text-lg font-black tabular-nums text-success">{money(received)}</p>
          </div>
        </div>
        <p className="text-xs text-text-muted font-bold">
          {count} payment{count === 1 ? '' : 's'} this month
          {missing > 0 && <span className="ml-2 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">{missing} receipt{missing === 1 ? '' : 's'} missing</span>}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => open(true)} className="flex-1 rounded-xl py-2.5 text-sm font-black active:scale-95 transition-transform" style={{ background: style.acc, color: style.onAcc }}>
            ＋ Add a payment
          </button>
          <button type="button" onClick={() => open()} className="flex-1 rounded-xl py-2.5 text-sm font-black border border-border-subtle text-primary active:scale-95 transition-transform">
            View payments
          </button>
        </div>
      </div>
    </motion.div>
  );
}
