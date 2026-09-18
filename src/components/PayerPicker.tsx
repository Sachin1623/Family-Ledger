import React from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

// The "Who Paid" section shared by AddExpense.tsx and GroupExpenses.tsx's edit-expense modal —
// extracted here so both get the multiple-payers option (some bills are paid by more than one
// person, e.g. two people each handing over cash) identically, not two separately-maintained
// copies of the same toggle + pill row + amount-entry block. Purely a controlled/presentational
// component — every piece of state lives in the caller, exactly like the existing split-amount
// UI's `splitMembers`/`memberSplits`/`splitType` atoms it's styled to match.
export interface PayerPickerMember {
  userId: string;
  displayName?: string;
  photoURL?: string;
}

export default function PayerPicker({
  members,
  amount,
  currencySymbol,
  payerMode,
  setPayerMode,
  paidBy,
  setPaidBy,
  payerIds,
  setPayerIds,
  payerAmounts,
  setPayerAmounts,
}: {
  members: PayerPickerMember[];
  amount: number;
  currencySymbol: string;
  payerMode: 'single' | 'multiple';
  setPayerMode: (mode: 'single' | 'multiple') => void;
  paidBy: string;
  setPaidBy: (uid: string) => void;
  payerIds: string[];
  setPayerIds: (ids: string[]) => void;
  payerAmounts: Record<string, number>;
  setPayerAmounts: (amounts: Record<string, number>) => void;
}) {
  const { user } = useAuth();
  const { t } = useLanguage();

  const totalPaid = payerIds.reduce((sum, uid) => sum + (payerAmounts[uid] || 0), 0);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-primary uppercase tracking-widest">{t('addExpense.whoPaid')}</h2>
        <button
          type="button"
          onClick={() => {
            if (payerMode === 'single') {
              // Switching in: seed the multi-payer list with whoever was already picked as the
              // single payer, defaulting their amount to the full total — a natural starting
              // point (add a second payer and adjust from there) rather than an empty list.
              setPayerMode('multiple');
              const seedId = paidBy || user?.uid || '';
              if (seedId) {
                setPayerIds([seedId]);
                setPayerAmounts({ [seedId]: amount });
              }
            } else {
              // Switching back out: collapse to a single payer — whoever had the largest
              // contribution, a reasonable default rather than picking arbitrarily.
              setPayerMode('single');
              const primary = payerIds.reduce((best, uid) => ((payerAmounts[uid] || 0) > (payerAmounts[best] || 0) ? uid : best), payerIds[0] || user?.uid || '');
              if (primary) setPaidBy(primary);
            }
          }}
          className="text-[10px] font-bold text-primary hover:underline"
        >
          {payerMode === 'single' ? t('addExpense.splitPayment') : t('addExpense.onePayer')}
        </button>
      </div>

      {payerMode === 'single' ? (
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar px-1">
          {members.map((member) => (
            <button
              key={member.userId}
              type="button"
              onClick={() => setPaidBy(member.userId)}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm shrink-0',
                paidBy === member.userId
                  ? 'bg-primary text-white border-primary'
                  : 'bg-white text-on-surface border-border-subtle hover:bg-surface-container',
              )}
            >
              <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10">
                {member.photoURL ? (
                  <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="material-symbols-outlined text-[12px] flex items-center justify-center h-full">person</span>
                )}
              </div>
              {member.userId === user?.uid ? t('common.me') : member.displayName}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar px-1">
            {members.map((member) => {
              const selected = payerIds.includes(member.userId);
              return (
                <button
                  key={member.userId}
                  type="button"
                  onClick={() => {
                    if (selected) {
                      setPayerIds(payerIds.filter((id) => id !== member.userId));
                      const next = { ...payerAmounts };
                      delete next[member.userId];
                      setPayerAmounts(next);
                    } else {
                      setPayerIds([...payerIds, member.userId]);
                    }
                  }}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm shrink-0',
                    selected
                      ? 'bg-primary text-white border-primary'
                      : 'bg-white text-on-surface border-border-subtle hover:bg-surface-container',
                  )}
                >
                  <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10">
                    {member.photoURL ? (
                      <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="material-symbols-outlined text-[12px] flex items-center justify-center h-full">person</span>
                    )}
                  </div>
                  {member.userId === user?.uid ? t('common.me') : member.displayName}
                </button>
              );
            })}
          </div>

          {payerIds.length > 0 && (
            <div className="space-y-2 bg-surface p-3 rounded-2xl border border-border-subtle">
              <h3 className="text-[10px] font-bold text-primary uppercase tracking-widest pl-1">{t('addExpense.enterAmounts')}</h3>
              <div className="space-y-2">
                {payerIds.map((uid) => {
                  const member = members.find((m) => m.userId === uid);
                  return (
                    <div key={uid} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-border-subtle">
                      <div className="w-8 h-8 rounded-full overflow-hidden bg-primary/10">
                        {member?.photoURL ? (
                          <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="material-symbols-outlined text-sm flex items-center justify-center h-full">person</span>
                        )}
                      </div>
                      <span className="text-xs font-bold text-on-surface flex-1 truncate">
                        {uid === user?.uid ? t('common.me') : member?.displayName}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-bold text-primary">{currencySymbol}</span>
                        <input
                          type="number"
                          value={payerAmounts[uid] || ''}
                          onChange={(e) => setPayerAmounts({ ...payerAmounts, [uid]: parseFloat(e.target.value) || 0 })}
                          placeholder="0"
                          className="w-16 h-8 bg-surface rounded-lg border border-border-subtle text-right px-2 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className={clsx('text-[10px] font-bold text-center mt-2', Math.abs(totalPaid - amount) < 0.01 ? 'text-success' : 'text-error')}>
                {t('addExpense.totalAmount', {
                  spent: `${currencySymbol}${totalPaid.toFixed(2)}`,
                  total: `${currencySymbol}${amount.toFixed(2)}`,
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
