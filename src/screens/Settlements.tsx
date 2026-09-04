import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { getCurrencySymbol, EXPENSE_CATEGORIES } from '../lib/constants';
import { parseLocalDate } from '../lib/dateUtils';
import { useLanguage } from '../context/LanguageContext';
import SettlementDetailModal, { SettlementDetailInfo } from '../components/SettlementDetailModal';
import ExpenseQuickView from '../components/ExpenseQuickView';

interface Balance {
  userId: string;
  displayName: string;
  photoURL: string;
  amount: number; // Positive means they are owed, negative means they owe
}

interface SettlementInfo {
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

export default function Settlements() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { groupId: urlGroupId } = useParams();
  
  const [selectedGroupId, setSelectedGroupId] = useState<string>(urlGroupId || 'overall');
  const [loading, setLoading] = useState(false);
  const [selectedSettlement, setSelectedSettlement] = useState<SettlementDetailInfo | null>(null);
  const [quickViewExpense, setQuickViewExpense] = useState<any>(null);

  // Fetch groups
  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null
  );
  const memberships = membershipsValue?.docs.map(doc => doc.data()) || [];
  const groupIds = memberships.map((m: any) => m.groupId);

  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null
  );
  const groups = groupsValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[];

  // Fetch expenses for EVERY group the user's in, not just currently split-enabled ones — a
  // group's `splitEnabled` toggle only controls whether NEW expenses get split going forward;
  // each expense doc carries its own `splitInfo` from whenever it was actually added, regardless
  // of the group's setting today. Gating this fetch by splitEnabled meant flipping a group's
  // splitting off silently dropped ALL of that group's real, already-split (and possibly still
  // unsettled) expenses from every balance calculation — the bug this fixes.
  const [expensesValue, expensesLoading, expensesError] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'expenses'), where('groupId', 'in', groupIds)) : null
  );
  // A transient read failure (e.g. a momentary quota/network error) makes expensesValue
  // undefined again after an earlier successful snapshot — without this cache, balances
  // would flash correct then silently drop to zero. Keep the last good snapshot instead.
  const lastGoodExpensesRef = useRef<any[]>([]);
  if (expensesValue) {
    lastGoodExpensesRef.current = expensesValue.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
  const expenses = lastGoodExpensesRef.current;

  // A group belongs in Balances (as an "Overall" contributor and as its own tab) if it's
  // CURRENTLY split-enabled, OR it has ever had a real split expense — that second clause is what
  // keeps a group's balance/settlement history visible after someone toggles splitting off.
  const splitEnabledGroups = useMemo(() => {
    const idsWithSplitHistory = new Set(
      expenses.filter((e: any) => (e.splitInfo?.splits?.length || 0) > 0).map((e: any) => e.groupId),
    );
    return groups.filter((g: any) => g.splitEnabled || idsWithSplitHistory.has(g.id));
  }, [groups, expenses]);

  const splitEnabledGroupIds = useMemo(() => {
    return splitEnabledGroups.map((g: any) => g.id);
  }, [splitEnabledGroups]);

  // Fetch all members for all groups the user is in to get names/photos
  const [allMembersValue, , allMembersError] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null
  );
  const lastGoodMembersRef = useRef<any>({});
  if (allMembersValue) {
    lastGoodMembersRef.current = allMembersValue.docs.reduce((acc: any, doc) => {
      const data = doc.data();
      acc[data.userId] = {
        displayName: data.displayName,
        photoURL: data.photoURL
      };
      return acc;
    }, {});
  }
  const allMembers = lastGoodMembersRef.current;
  const hasStaleDataWarning = Boolean((expensesError || allMembersError) && (lastGoodExpensesRef.current.length > 0));

  const { balances, settlements, summary } = useMemo(() => {
    // Debts must never be netted across groups — a debt in one group is unrelated to a
    // debt in another (different members, possibly different currencies), so simplification
    // runs independently per group, even in the "Overall" view. Only the resulting settlement
    // lists get combined, never the raw balances.
    const relevantGroupIds = selectedGroupId === 'overall' ? splitEnabledGroupIds : [selectedGroupId];

    const settlements: SettlementInfo[] = [];
    const globalBalances: Record<string, number> = {};
    // Same "never net across groups" reasoning as the comment above applies here too — the
    // current user's own balance, bucketed by each contributing group's OWN currency code, so the
    // Overall summary cards can show "you're owed ₹100.00 + A$50.00" instead of silently adding a
    // ₹ figure to an A$ one and calling the blended result ₹150 (see the bug this fixes: the old
    // code hardcoded a single '₹' symbol over `currentBalance`, a plain sum across every group's
    // raw numbers regardless of currency).
    const userBalanceByCurrency: Record<string, number> = {};

    relevantGroupIds.forEach((gid: string) => {
      const groupExpenses = expenses.filter(e => e.groupId === gid);
      const groupBalances: Record<string, number> = {};

      groupExpenses.forEach(expense => {
        const payerId = expense.paidBy;
        const splits = expense.splitInfo?.splits || [];
        if (splits.length === 0) return;

        splits.forEach((split: any) => {
          const benefitId = split.userId;
          const benefitAmount = split.amount;

          if (payerId !== benefitId) {
            // benefitId owes payerId, within this group only
            groupBalances[benefitId] = (groupBalances[benefitId] || 0) - benefitAmount;
            groupBalances[payerId] = (groupBalances[payerId] || 0) + benefitAmount;
            globalBalances[benefitId] = (globalBalances[benefitId] || 0) - benefitAmount;
            globalBalances[payerId] = (globalBalances[payerId] || 0) + benefitAmount;
          }
        });
      });

      const userGroupBalance = groupBalances[user?.uid || ''] || 0;
      if (userGroupBalance !== 0) {
        const currencyCode = groups.find((g: any) => g.id === gid)?.currency || '';
        userBalanceByCurrency[currencyCode] = (userBalanceByCurrency[currencyCode] || 0) + userGroupBalance;
      }

      const groupName = groups.find((g: any) => g.id === gid)?.name || 'Group';
      const owers = Object.entries(groupBalances)
        .filter(([_, bal]) => bal < -0.01)
        .sort((a, b) => a[1] - b[1]); // Sort by most debt
      const receivers = Object.entries(groupBalances)
        .filter(([_, bal]) => bal > 0.01)
        .sort((a, b) => b[1] - a[1]); // Sort by most owed

      // Simple algorithm to match owers to receivers, scoped to this group's members only
      let owerIdx = 0;
      let receiverIdx = 0;
      while (owerIdx < owers.length && receiverIdx < receivers.length) {
        const [owerId, owerBal] = owers[owerIdx];
        const [receiverId, receiverBal] = receivers[receiverIdx];
        const amount = Math.min(Math.abs(owerBal), receiverBal);

        settlements.push({
          owerId,
          owerName: allMembers[owerId]?.displayName || 'Unknown',
          owerPhoto: allMembers[owerId]?.photoURL || '',
          receiverId,
          receiverName: allMembers[receiverId]?.displayName || 'Unknown',
          receiverPhoto: allMembers[receiverId]?.photoURL || '',
          amount,
          groupId: gid,
          groupName,
        });

        owers[owerIdx][1] += amount;
        receivers[receiverIdx][1] -= amount;

        if (Math.abs(owers[owerIdx][1]) < 0.01) owerIdx++;
        if (Math.abs(receivers[receiverIdx][1]) < 0.01) receiverIdx++;
      }
    });

    // Per-currency only now — a single blended currentBalance (summed across every group
    // regardless of currency) is exactly the shape that produced the mislabeled-total bug this
    // fix addresses, so there's no safe single number left to derive here.
    const owedByCurrency = Object.entries(userBalanceByCurrency)
      .filter(([, amt]) => amt > 0.01)
      .map(([currencyCode, amount]) => ({ currencyCode, amount }));
    const oweByCurrency = Object.entries(userBalanceByCurrency)
      .filter(([, amt]) => amt < -0.01)
      .map(([currencyCode, amount]) => ({ currencyCode, amount: Math.abs(amount) }));

    return {
      balances: globalBalances,
      settlements,
      summary: {
        owedByCurrency,
        oweByCurrency,
      }
    };
  }, [selectedGroupId, expenses, allMembers, user, splitEnabledGroupIds, groups]);

  // Only meaningful as a single figure when exactly one currency is actually in play — the
  // "Overall" balance cards below use owedByCurrency/oweByCurrency instead, precisely because
  // Overall can span groups in different currencies (this was hardcoded to '₹' here before,
  // silently mislabeling a mixed- or non-INR total as Rupees — see the fix on those cards).
  // Still correct as-is for every OTHER currencySymbol usage in this file (settlement rows, the
  // detail modal, etc.), which are all scoped to one specific group already.
  const currencySymbol = useMemo(() => {
    if (selectedGroupId === 'overall') return getCurrencySymbol(undefined);
    const group = groups.find(g => g.id === selectedGroupId);
    return getCurrencySymbol(group?.currency);
  }, [selectedGroupId, groups]);

  // The expense lines actually behind a given settlement row — any expense in that group where
  // BOTH people appear (one paid, the other is in the split), in either direction, since a net
  // debt can be built from several expenses that partly offset each other.
  const settlementTransactions = useMemo(() => {
    if (!selectedSettlement) return [];
    const { owerId, receiverId, groupId } = selectedSettlement;
    return expenses
      .filter((e: any) => {
        if (e.groupId !== groupId || !e.splitInfo?.splits) return false;
        const splitUids = new Set(e.splitInfo.splits.map((s: any) => s.userId));
        const pair = [owerId, receiverId];
        return pair.includes(e.paidBy) && splitUids.has(pair.find((uid) => uid !== e.paidBy)!);
      })
      .sort((a: any, b: any) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime());
  }, [selectedSettlement, expenses]);

  const membersArray = useMemo(
    () => Object.entries(allMembers).map(([userId, m]: [string, any]) => ({ userId, ...m })),
    [allMembers],
  );

  if (expensesLoading) {
    return <div className="p-8 text-center text-text-muted">Loading settlements...</div>;
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-6 max-w-2xl mx-auto w-full space-y-6 pb-24">
        {hasStaleDataWarning && (
          <div className="p-3 bg-warning/10 text-warning text-xs font-bold rounded-xl border border-warning/20 text-center">
            {t('settlements.serverTrouble')}
          </div>
        )}
        <header className="space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-black text-primary tracking-tight">{t('settlements.title')}</h1>
            <div className="flex bg-white rounded-xl border border-border-subtle p-1 shadow-sm">
              <button
                onClick={() => setSelectedGroupId('overall')}
                className={clsx(
                  "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                  selectedGroupId === 'overall' ? "bg-primary text-white shadow-md" : "text-text-muted hover:bg-surface"
                )}
              >
                {t('settlements.overall')}
              </button>
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar" data-tour="settlements-filter">
            {splitEnabledGroups.map(group => (
              <button
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
                className={clsx(
                  "flex-none px-4 py-2 rounded-xl font-bold border text-xs transition-all active:scale-95 shadow-sm whitespace-nowrap min-w-max",
                  selectedGroupId === group.id 
                    ? "bg-primary text-white border-primary" 
                    : "bg-white text-on-surface border-border-subtle hover:bg-surface-container"
                )}
              >
                {group.name}
              </button>
            ))}
          </div>
        </header>

        {/* User Balance Cards — "Overall" can span groups in different currencies (INR debt in
            one, AUD in another), so a single blended number would either be meaningless (raw sum
            of two different currencies) or mislabeled (this used to hardcode '₹' over that sum
            regardless of what currencies actually made it up). One line per currency instead —
            almost always just one line in practice, since most people's groups share a currency. */}
        <div className="grid grid-cols-2 gap-3" data-tour="settlements-summary">
          <div className="bg-white p-4 rounded-3xl border border-border-subtle shadow-sm flex flex-col items-center">
            <span className="text-[10px] font-black text-text-muted uppercase tracking-widest mb-1">{t('settlements.youAreOwed')}</span>
            {summary.owedByCurrency.length === 0 ? (
              <span className="text-2xl font-black text-success">{currencySymbol}0.00</span>
            ) : summary.owedByCurrency.length === 1 ? (
              <span className="text-2xl font-black text-success">{getCurrencySymbol(summary.owedByCurrency[0].currencyCode)}{summary.owedByCurrency[0].amount.toFixed(2)}</span>
            ) : (
              <div className="flex flex-col items-center gap-0.5">
                {summary.owedByCurrency.map(({ currencyCode, amount }) => (
                  <span key={currencyCode} className="text-base font-black text-success">{getCurrencySymbol(currencyCode)}{amount.toFixed(2)}</span>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white p-4 rounded-3xl border border-border-subtle shadow-sm flex flex-col items-center">
            <span className="text-[10px] font-black text-text-muted uppercase tracking-widest mb-1">{t('settlements.youOwe')}</span>
            {summary.oweByCurrency.length === 0 ? (
              <span className="text-2xl font-black text-error">{currencySymbol}0.00</span>
            ) : summary.oweByCurrency.length === 1 ? (
              <span className="text-2xl font-black text-error">{getCurrencySymbol(summary.oweByCurrency[0].currencyCode)}{summary.oweByCurrency[0].amount.toFixed(2)}</span>
            ) : (
              <div className="flex flex-col items-center gap-0.5">
                {summary.oweByCurrency.map(({ currencyCode, amount }) => (
                  <span key={currencyCode} className="text-base font-black text-error">{getCurrencySymbol(currencyCode)}{amount.toFixed(2)}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        <section className="space-y-4" data-tour="settlements-list">
          <h2 className="text-sm font-black text-primary uppercase tracking-wider px-1">{t('settlements.whoOwesWho')}</h2>

          <div className="space-y-3">
            {settlements.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-3xl border border-dashed border-border-subtle text-text-muted text-sm italic">
                {t('settlements.noActiveDebts')}
              </div>
            ) : (
              settlements.map((s, idx) => (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  key={`${s.groupId}-${s.owerId}-${s.receiverId}`}
                  onClick={() => setSelectedSettlement(s)}
                  className="bg-white p-4 rounded-3xl border border-border-subtle shadow-sm flex items-center gap-4 transition-all active:scale-[0.98] cursor-pointer hover:bg-surface"
                >
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full overflow-hidden bg-primary/10 border-2 border-white shadow-sm">
                      {s.owerPhoto ? <img src={s.owerPhoto} className="w-full h-full object-cover" /> : <div className="flex items-center justify-center h-full"><span className="material-symbols-outlined text-sm">person</span></div>}
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col min-w-0">
                    <div className="flex items-center gap-1.5 leading-none mb-1">
                      <span className="text-xs font-black text-primary truncate max-w-[80px]">
                        {s.owerId === user?.uid ? t('settlements.you') : s.owerName.split(' ')[0]}
                      </span>
                      <span className="material-symbols-outlined text-sm text-text-muted">trending_flat</span>
                      <span className="text-xs font-black text-primary truncate max-w-[80px]">
                        {s.receiverId === user?.uid ? t('settlements.you') : s.receiverName.split(' ')[0]}
                      </span>
                    </div>
                    <span className="text-[10px] text-text-muted">
                      {t('settlements.owesLine', {
                        ower: s.owerId === user?.uid ? t('settlements.you') : s.owerName.split(' ')[0],
                        receiver: s.receiverId === user?.uid ? t('settlements.you') : s.receiverName.split(' ')[0],
                      })}
                    </span>
                    {selectedGroupId === 'overall' && (
                      <span className="text-[9px] font-bold text-primary/70 uppercase tracking-wide truncate mt-0.5">{s.groupName}</span>
                    )}
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-lg font-black text-primary">
                      {selectedGroupId === 'overall' ? getCurrencySymbol(groups.find((g: any) => g.id === s.groupId)?.currency) : currencySymbol}{s.amount.toFixed(2)}
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </section>

        {/* Details of items */}
        <section className="space-y-4">
          <h2 className="text-sm font-black text-primary uppercase tracking-wider px-1">{t('settlements.spendItems')}</h2>
          <div className="space-y-2">
            {expenses.filter(e => e.splitInfo && (selectedGroupId === 'overall' || e.groupId === selectedGroupId)).slice(0, 10).map((expense) => {
              const payerName = allMembers[expense.paidBy]?.displayName || t('common.unknown');
              const payerIsMe = expense.paidBy === user?.uid;
              
              return (
                <div 
                  key={expense.id}
                  onClick={() => setQuickViewExpense(expense)}
                  className="bg-white p-4 rounded-3xl border border-border-subtle shadow-sm flex flex-col gap-3 active:scale-[0.98] transition-all cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-primary/5 flex items-center justify-center text-primary shrink-0">
                        <span className="text-lg">
                          {EXPENSE_CATEGORIES.find(c => c.id === expense.category)?.icon || '🧾'}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-black text-primary truncate">{expense.description}</div>
                        <div className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{parseLocalDate(expense.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-black text-primary">
                        {selectedGroupId === 'overall' ? getCurrencySymbol(groups.find(g => g.id === expense.groupId)?.currency) : currencySymbol}
                        {expense.amount.toFixed(2)}
                      </div>
                      <div className="text-[8px] font-black text-text-muted uppercase tracking-widest bg-surface px-1.5 py-0.5 rounded-full inline-block mt-0.5 border border-border-subtle">
                        {expense.splitInfo.splitType === 'equally' ? t('addExpense.equally') : expense.splitInfo.splitType === 'percentage' ? t('addExpense.percent') : t('common.amount')}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border-subtle/50">
                    <div className="space-y-1">
                      <span className="text-[8px] font-black text-text-muted uppercase tracking-widest">{t('settlements.addedBy')}</span>
                      <div className="flex items-center gap-1.5">
                        <div className="w-4 h-4 rounded-full overflow-hidden bg-primary/10 border border-border-subtle">
                          {allMembers[expense.paidBy]?.photoURL ? (
                            <img src={allMembers[expense.paidBy].photoURL} className="w-full h-full object-cover" />
                          ) : (
                            <div className="flex items-center justify-center h-full text-[8px] font-bold">{payerName.slice(0, 1)}</div>
                          )}
                        </div>
                        <span className="text-[10px] font-bold text-primary">{payerIsMe ? t('common.me') : payerName.split(' ')[0]}</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-[8px] font-black text-text-muted uppercase tracking-widest">{t('addExpense.splitWith')}</span>
                      <div className="flex flex-wrap gap-1">
                        {expense.splitInfo.splits.map((s: any) => {
                          const name = allMembers[s.userId]?.displayName || t('common.unknown');
                          const isMe = s.userId === user?.uid;
                          return (
                            <div key={s.userId} className="flex items-center gap-1 bg-surface px-1.5 py-0.5 rounded-full border border-border-subtle shrink-0">
                              <span className="text-[9px] font-bold text-primary/80">{isMe ? t('common.me') : name.split(' ')[0]}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {expenses.filter(e => e.splitInfo && (selectedGroupId === 'overall' || e.groupId === selectedGroupId)).length > 10 && (
              <p className="text-center text-[10px] text-text-muted italic">{t('settlements.onlyShowingRecent')}</p>
            )}
          </div>
        </section>
      </main>

      {selectedSettlement && (
        <SettlementDetailModal
          settlement={selectedSettlement}
          currencySymbol={getCurrencySymbol(groups.find((g: any) => g.id === selectedSettlement.groupId)?.currency)}
          transactions={settlementTransactions}
          onClose={() => setSelectedSettlement(null)}
          onOpenExpense={(expense) => setQuickViewExpense(expense)}
        />
      )}

      {quickViewExpense && (
        <ExpenseQuickView
          expense={quickViewExpense}
          groupId={quickViewExpense.groupId}
          currencySymbol={getCurrencySymbol(groups.find((g: any) => g.id === quickViewExpense.groupId)?.currency)}
          payerName={allMembers[quickViewExpense.paidBy]?.displayName || t('common.unknown')}
          payerPhoto={allMembers[quickViewExpense.paidBy]?.photoURL}
          members={membersArray}
          onClose={() => setQuickViewExpense(null)}
        />
      )}
    </div>
  );
}
