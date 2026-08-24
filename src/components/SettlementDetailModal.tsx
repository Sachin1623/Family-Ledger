import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { parseLocalDate } from '../lib/dateUtils';
import { EXPENSE_CATEGORIES } from '../lib/constants';

export interface SettlementDetailInfo {
  owerId: string;
  owerName: string;
  owerPhoto: string;
  receiverId: string;
  receiverName: string;
  receiverPhoto: string;
  amount: number;
  groupId: string;
  groupName: string;
}

// The floating "who owes who" detail view opened from tapping a Settlements.tsx row — shows the
// two people involved, a context-appropriate action (pay now if you're the ower, nudge them if
// you're the receiver), and the actual expense lines behind the number, each tappable into its
// own read-only ExpenseQuickView (rendered by the caller, same pattern Dashboard.tsx already uses
// for its own "Latest spend" rows — this component only asks for one via `onOpenExpense`).
export default function SettlementDetailModal({
  settlement,
  currencySymbol,
  transactions,
  onClose,
  onOpenExpense,
}: {
  settlement: SettlementDetailInfo;
  currencySymbol: string;
  transactions: any[];
  onClose: () => void;
  onOpenExpense: (expense: any) => void;
}) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwer = user?.uid === settlement.owerId;
  const isReceiver = user?.uid === settlement.receiverId;

  const handleSettleUp = () => {
    const params = new URLSearchParams({
      groupId: settlement.groupId,
      amount: settlement.amount.toFixed(2),
      settleWith: settlement.receiverId,
      description: `Settlement to ${settlement.receiverName.split(' ')[0]}`,
      category: 'misc',
    });
    navigate(`/add-expense?${params.toString()}`);
  };

  const handleSendReminder = async () => {
    if (!user || sending) return;
    setSending(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/settlement-reminder', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: settlement.groupId, targetUserId: settlement.owerId, amount: settlement.amount }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to send reminder.');
      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Failed to send reminder.');
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={(e) => e.stopPropagation()}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 30 }}
          className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden"
        >
          {/* 1. Header — both people, profile icons, the settlement summary. */}
          <div className="p-5 border-b border-border-subtle shrink-0 bg-primary/5">
            <div className="flex justify-end">
              <button onClick={onClose} className="p-1.5 -mr-1.5 -mt-1.5 hover:bg-surface rounded-full">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="flex items-center justify-center gap-4 mt-1">
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-14 h-14 rounded-full overflow-hidden bg-primary/10 border-2 border-white shadow-sm shrink-0">
                  {settlement.owerPhoto ? (
                    <img src={settlement.owerPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-primary font-bold">{settlement.owerName.slice(0, 1)}</div>
                  )}
                </div>
                <span className="text-xs font-bold text-primary max-w-[80px] truncate">
                  {settlement.owerId === user?.uid ? t('settlements.you') : settlement.owerName.split(' ')[0]}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1 shrink-0">
                <span className="material-symbols-outlined text-2xl text-text-muted">trending_flat</span>
                <span className="text-lg font-black text-primary whitespace-nowrap">{currencySymbol}{settlement.amount.toFixed(2)}</span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-14 h-14 rounded-full overflow-hidden bg-primary/10 border-2 border-white shadow-sm shrink-0">
                  {settlement.receiverPhoto ? (
                    <img src={settlement.receiverPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-primary font-bold">{settlement.receiverName.slice(0, 1)}</div>
                  )}
                </div>
                <span className="text-xs font-bold text-primary max-w-[80px] truncate">
                  {settlement.receiverId === user?.uid ? t('settlements.you') : settlement.receiverName.split(' ')[0]}
                </span>
              </div>
            </div>
            <p className="text-center text-[11px] text-text-muted mt-2">{settlement.groupName}</p>
          </div>

          {/* 2. Fixed action — settle up if you owe, nudge them if you're owed. Neither shows if
              this settlement doesn't actually involve the viewer (e.g. an "Overall" row between
              two other people they share a group with). */}
          {(isOwer || isReceiver) && (
            <div className="p-4 border-b border-border-subtle shrink-0">
              {isOwer ? (
                <button
                  onClick={handleSettleUp}
                  className="w-full h-12 bg-success text-white font-bold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[20px]">paid</span>
                  {t('settlements.settleUp')}
                </button>
              ) : sent ? (
                <div className="w-full h-12 bg-success/10 text-success font-bold rounded-2xl flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-[20px]">check_circle</span>
                  {t('settlements.reminderSent')}
                </div>
              ) : (
                <button
                  onClick={handleSendReminder}
                  disabled={sending}
                  className="w-full h-12 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[20px]">notifications_active</span>
                  {sending ? '…' : t('settlements.sendReminder')}
                </button>
              )}
              {error && <p className="text-xs font-bold text-error text-center mt-2">{error}</p>}
            </div>
          )}

          {/* 3. Scrollable transactions behind this number — each opens the real expense in
              read-only view (edit/comment happens there). */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <h3 className="text-[10px] font-black text-text-muted uppercase tracking-widest px-1 mb-1">
              {t('settlements.transactions')}
            </h3>
            {transactions.length === 0 ? (
              <p className="text-sm text-text-muted italic text-center py-6">{t('settlements.noTransactions')}</p>
            ) : (
              transactions.map((expense) => {
                const icon = EXPENSE_CATEGORIES.find((c) => c.id === expense.category)?.icon || '🧾';
                return (
                  <button
                    key={expense.id}
                    onClick={() => onOpenExpense(expense)}
                    className="w-full flex items-center justify-between bg-surface p-3 rounded-2xl border border-border-subtle hover:bg-surface-container/60 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-lg shrink-0">{icon}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-on-surface truncate">{expense.description}</p>
                        <p className="text-[10px] text-text-muted">
                          {parseLocalDate(expense.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-black text-primary shrink-0 ml-2">{currencySymbol}{expense.amount.toFixed(2)}</span>
                  </button>
                );
              })
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
