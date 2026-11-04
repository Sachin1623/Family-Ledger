import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { getCurrencySymbol } from '../lib/constants';
import { parseLocalDate } from '../lib/dateUtils';
import { useIdentities } from '../lib/userIdentity';
import { KIND_STYLE } from '../lib/groupKindStyle';
import PaymentRolePicker, { canPay } from './PaymentRolePicker';
import MemberAvatar from './MemberAvatar';
import PaymentReminderGlance from './PaymentReminderGlance';
import type { PaymentReminder } from '../lib/paymentReminders';
import { ringPayerNow } from '../lib/paymentReminders';
import GroupQuickActionsMenu from './GroupQuickActionsMenu';

// A Payments group on the Dashboard. It has no expenses, budget or month-to-month comparison, so it does not use the group
// card's tiles: it shows what you paid and what you received this month, and the one thing you do here, add a payment.
// It opens and closes like every other group card (the same arrow, the same three states, the same menu):
//   1 = header only, 2 = this month's totals and the buttons, 3 = also the latest payments.
export default function PaymentsGroupCard({
  groupId, group, members, index, tileState, onToggleCollapse,
}: { groupId: string; group: any; members: any[]; index: number; tileState: 1 | 2 | 3; onToggleCollapse: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [showMenu, setShowMenu] = useState(false);
  const [snap] = useCollection(query(collection(db, 'groupPayments'), where('groupId', '==', groupId)));
  const [remSnap] = useCollection(query(collection(db, 'groupPaymentReminders'), where('groupId', '==', groupId)));
  const reminders = useMemo(() => (remSnap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as PaymentReminder[], [remSnap]);
  const style = KIND_STYLE.payments;
  // the payers other than me: anyone in the group can make their phone ring right now
  const ringable = members.filter((m: any) => canPay(m.paymentRole) && m.userId !== user?.uid);
  const [ringing, setRinging] = useState(false);
  const [ringMsg, setRingMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ring = async (m: any) => {
    setRinging(true);
    setRingMsg(null);
    const result = await ringPayerNow(groupId, m.userId, 'the payment');
    setRingMsg({ ok: result.ok, text: result.message });
    setRinging(false);
  };
  const symbol = getCurrencySymbol(group?.currency);
  const money = (n: number) => `${symbol}${Math.round(n).toLocaleString()}`;

  const payments = useMemo(() => {
    const list = (snap?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as any[];
    return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [snap]);
  const resolve = useIdentities(payments.slice(0, 3).flatMap((p) => [p.fromUid, p.toUid]));
  const nameOf = (uid: string) => {
    if (uid === user?.uid) return 'You';
    return resolve(uid, members.find((m: any) => m.userId === uid)?.displayName).name || 'Member';
  };

  const { paid, received, count, missing } = useMemo(() => {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let paidSum = 0;
    let receivedSum = 0;
    let n = 0;
    let noReceipt = 0;
    payments.forEach((p) => {
      if (p.fromUid === user?.uid && !(p.images?.length)) noReceipt++;
      if (!(p.date || '').startsWith(monthKey)) return;
      n++;
      if (p.fromUid === user?.uid) paidSum += p.amount || 0;
      if (p.toUid === user?.uid) receivedSum += p.amount || 0;
    });
    return { paid: paidSum, received: receivedSum, count: n, missing: noReceipt };
  }, [payments, user?.uid]);

  const open = (add = false) => navigate(`/groups/${groupId}${add ? '?add=1' : ''}`);
  const stopAnd = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn(); };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: index * 0.05, duration: 0.3 }}
        className="bg-white rounded-2xl border border-border-subtle p-6 shadow-sm hover:shadow-md transition-all relative overflow-hidden"
      >
        <div className="relative z-10 space-y-2">
          <div
            onClick={onToggleCollapse}
            style={{ background: style.headerWash }}
            className="flex items-center justify-between gap-2 -mx-6 -mt-6 mb-1 px-6 pt-4 pb-3 rounded-t-2xl border-b border-border-subtle cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-12 h-12 rounded-xl bg-white/70 flex items-center justify-center shrink-0 border overflow-hidden shadow-inner" style={{ borderColor: style.acc + '55' }}>
                {group?.photoURL ? <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : <span className="text-3xl">{group?.icon || '💸'}</span>}
              </div>
              <div className="min-w-0">
                <h3 className="font-bold text-on-surface line-clamp-1">{group?.name || 'Payments'}</h3>
                <p className="text-sm text-text-muted flex items-center gap-2">
                  <span>{t('dashboard.membersCount', { count: members.length })}</span>
                  <span className="text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5" style={{ background: style.tint, color: style.dark }}>{style.label}</span>
                  <PaymentRolePicker value={members.find((m: any) => m.userId === user?.uid)?.paymentRole} editable={false} className="!px-2 !py-0.5" />
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={stopAnd(() => setShowMenu(true))} title="Group actions" className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-full transition-colors">
                <span className="material-symbols-outlined text-[20px] block">more_vert</span>
              </button>
              <button
                onClick={stopAnd(onToggleCollapse)}
                title={tileState === 1 ? t('dashboard.revealTooltip') : tileState === 2 ? t('dashboard.expandTooltip') : t('dashboard.collapseTooltip')}
                className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-full transition-colors"
              >
                <span className="material-symbols-outlined text-[20px] block">
                  {tileState === 1 ? 'keyboard_double_arrow_down' : tileState === 2 ? 'expand_more' : 'expand_less'}
                </span>
              </button>
            </div>
          </div>

          {tileState >= 2 && (
            <div className="space-y-3 pt-1">
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

              {tileState === 3 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-black uppercase tracking-wider text-text-muted">Latest payments</p>
                  {payments.length === 0 && <p className="text-xs text-text-muted">No payments yet.</p>}
                  {payments.slice(0, 3).map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-xl border border-border-subtle px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-primary truncate">{p.label || 'Payment'}</p>
                        <p className="text-[11px] text-text-muted truncate">{nameOf(p.fromUid)} → {nameOf(p.toUid)} · {parseLocalDate(p.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</p>
                      </div>
                      <p className="text-sm font-black tabular-nums shrink-0">{money(p.amount)}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <button type="button" onClick={() => open(true)} className="flex-1 rounded-xl py-2.5 text-sm font-black active:scale-95 transition-transform" style={{ background: style.acc, color: style.onAcc }}>
                  ＋ Add a payment
                </button>
                <button type="button" onClick={() => open()} className="flex-1 rounded-xl py-2.5 text-sm font-black border border-border-subtle text-primary active:scale-95 transition-transform">
                  View payments
                </button>
              </div>

              <PaymentReminderGlance groupId={groupId} reminders={reminders} members={members.map((m: any) => ({ userId: m.userId, role: m.paymentRole, displayName: m.displayName }))} />

              {ringable.length > 0 && (
                <div className="rounded-xl px-3 py-2.5 space-y-2" style={{ background: style.tint }}>
                  <p className="text-[11px] font-bold" style={{ color: style.dark }}>Waiting on a payment? Ring the payer's phone now.</p>
                  <div className="flex flex-wrap gap-2">
                    {ringable.map((m: any) => (
                      <button key={m.userId} type="button" disabled={ringing} onClick={() => ring(m)}
                        className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-black active:scale-95 disabled:opacity-50" style={{ background: style.acc, color: style.onAcc }}>
                        <MemberAvatar name={m.displayName} photo={m.photoURL} size={20} />
                        <span className="material-symbols-outlined text-[16px]">notifications_active</span>Ring {m.displayName}
                      </button>
                    ))}
                  </div>
                  {ringMsg && <p className={`text-[11px] font-bold ${ringMsg.ok ? 'text-success' : 'text-error'}`}>{ringMsg.text}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {showMenu && (
        <GroupQuickActionsMenu groupId={groupId} group={group} members={members} budget={null} onClose={() => setShowMenu(false)} />
      )}
    </>
  );
}
