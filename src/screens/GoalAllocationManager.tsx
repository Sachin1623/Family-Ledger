import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { Goal, fromMinorUnits, decryptGoalsList } from '../lib/goals';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';
import { applyAccountChange, notifyGoalsMet } from '../lib/accountAllocations';

// Repurposed: goals no longer take a direct percentage share of monthly savings (see goals.ts's
// header comment) — the only way a goal is funded is a linked account's own % allocation. This
// screen is the cross-account view of that: every goal the user owns, and for each one, exactly
// which accounts contribute what % / amount to it, editable right here instead of only from
// inside each account's own edit form. Every edit goes through the same applyAccountChange() used
// everywhere else an account's allocations change, so it's logged identically (that account's own
// History) and subject to the same reserve-on-target-met capping.
export default function GoalAllocationManager() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [goalsValue] = useCollection(user ? query(collection(db, 'goals'), where('userId', '==', user.uid)) : null);
  const [goals, setGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = (goalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []).filter((g: any) => g.status === 'active' && !g.isCashHolding);
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt goals:', err));
    return () => { cancelled = true; };
  }, [goalsValue]);

  const [accountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('userId', '==', user.uid)) : null);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = accountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raw).then((decrypted) => { if (!cancelled) setAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [accountsValue]);

  // Every account→goal allocation, flattened and grouped by goal — {goalId: {accountId: entry}}.
  const rowsByGoal = new Map<string, { account: FinancialAccount; pct: number; reserved: boolean; amountMinor: number }[]>();
  accounts.forEach((a) => {
    (a.goalAllocations || []).forEach((entry) => {
      const amountMinor = entry.reservedAmountMinor != null ? entry.reservedAmountMinor : Math.round((a.currentBalanceMinor * entry.pct) / 100);
      const list = rowsByGoal.get(entry.goalId) || [];
      list.push({ account: a, pct: entry.pct, reserved: entry.reservedAmountMinor != null, amountMinor });
      rowsByGoal.set(entry.goalId, list);
    });
  });

  const [editing, setEditing] = useState<{ goalId: string; goalName: string; accountId: string; pct: number } | null>(null);
  const [pctInput, setPctInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openEdit = (goalId: string, goalName: string, accountId: string, currentPct: number) => {
    setEditing({ goalId, goalName, accountId, pct: currentPct });
    setPctInput(String(currentPct));
    setError(null);
  };

  const handleSaveEdit = async () => {
    if (!editing || !user || saving) return;
    const nextPct = Math.max(0, Math.min(100, Math.round(Number(pctInput.replace(/[^0-9]/g, '')) || 0)));
    const account = accounts.find((a) => a.id === editing.accountId);
    if (!account) return;
    const existingTotal = (account.goalAllocations || []).reduce((s, g) => s + (g.goalId === editing.goalId ? 0 : g.pct), 0);
    if (existingTotal + nextPct > 100) { setError(t('accounts.allocationOver100')); return; }
    setSaving(true);
    setError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nextAllocations = (account.goalAllocations || []).filter((g) => g.goalId !== editing.goalId);
      if (nextPct > 0) nextAllocations.push({ goalId: editing.goalId, goalName: editing.goalName, pct: nextPct });
      const { justCompletedGoals } = await applyAccountChange(account.id, account.currentBalanceMinor, nextAllocations, actorName);
      notifyGoalsMet(justCompletedGoals);
      setEditing(null);
    } catch (err) {
      console.error('Failed to update allocation:', err);
      setError(t('goals.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-primary">{t('goals.allocationManagerTitle')}</h1>
        <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
          <span className="material-symbols-outlined text-[20px] block">close</span>
        </button>
      </div>
      <p className="text-xs text-text-muted -mt-3">{t('goals.allocationManagerSubtitle')}</p>

      {goals.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-8">{t('goals.noActiveGoalsForAllocation')}</p>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => {
            const rows = rowsByGoal.get(g.id) || [];
            const sym = getCurrencySymbol(g.currency);
            return (
              <div key={g.id} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2.5">
                <button type="button" onClick={() => navigate(`/goals/${g.id}`)} className="flex items-center gap-2 w-full text-left">
                  <span className="text-xl shrink-0">{g.icon || '🎯'}</span>
                  <span className="flex-1 text-sm font-bold text-on-surface truncate">{g.name}</span>
                  <span className="text-xs font-bold text-text-muted shrink-0">
                    {sym}{fromMinorUnits(g.accountAllocatedMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })} / {sym}{fromMinorUnits(g.targetAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </button>
                {rows.length === 0 ? (
                  <p className="text-[11px] text-text-muted">{t('goals.noAccountAllocationsYet')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {rows.map((r) => (
                      <button
                        key={r.account.id} type="button"
                        onClick={() => openEdit(g.id, g.name, r.account.id, r.pct)}
                        className="w-full bg-surface hover:bg-primary/5 rounded-xl px-3 py-2 text-left space-y-0.5 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[14px] text-primary shrink-0">account_balance</span>
                          <span className="flex-1 min-w-0 text-xs font-bold text-on-surface truncate">{r.account.name}</span>
                          {r.reserved && (
                            <span className="text-[9px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0">{t('goals.reserved')}</span>
                          )}
                        </div>
                        <p className="text-xs font-bold text-primary pl-[20px]">
                          {r.pct}% · {getCurrencySymbol(r.account.currency)}{fromMinorUnits(r.amountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {accounts.length === 0 && (
        <p className="text-xs text-text-muted text-center">{t('goals.noAccountsForAllocation')}</p>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !saving && setEditing(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{editing.goalName}</h3>
            <p className="text-xs text-text-muted">{accounts.find((a) => a.id === editing.accountId)?.name}</p>
            <div className="flex items-center gap-2 justify-center">
              <input
                type="text" inputMode="numeric" autoFocus value={pctInput}
                onChange={(e) => setPctInput(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-20 h-12 text-center bg-surface border border-border-subtle rounded-xl font-black text-primary text-lg outline-none"
              />
              <span className="text-lg font-bold text-text-muted">%</span>
            </div>
            {error && <p className="text-xs text-error font-bold text-center">{error}</p>}
            <button onClick={handleSaveEdit} disabled={saving} className={clsx('w-full py-3 text-white font-bold rounded-xl disabled:opacity-50', 'bg-primary')}>
              {saving ? t('goals.saving') : t('common.save')}
            </button>
            <button onClick={() => setEditing(null)} disabled={saving} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
