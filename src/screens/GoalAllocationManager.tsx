import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { Goal, fromMinorUnits, goalTotalMinor, fundingSourcesForGoal, projectGoalHorizonSchedule, decryptGoalsList } from '../lib/goals';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';
import { applyAccountChange, notifyGoalsMet } from '../lib/accountAllocations';

// Repurposed: goals no longer take a direct percentage share of monthly savings (see goals.ts's
// header comment) — the only way a goal is funded is a linked account's own % allocation. This
// screen is the cross-account view of that: every goal the user owns, and for each one, exactly
// which accounts contribute what % / amount to it, editable right here instead of only from
// inside each account's own edit form. Every edit goes through the same applyAccountChange() used
// everywhere else an account's allocations change, so it's logged identically (that account's own
// History) and subject to the same reserve-on-target-met capping.
const GOAL_COLORS = ['#F59E0B', '#0EA5E9', '#8B5CF6', '#16A34A', '#EC4899', '#EF4444', '#14B8A6', '#6366F1'];
const goalColor = (i: number) => GOAL_COLORS[i % GOAL_COLORS.length];

export default function GoalAllocationManager({ embedded = false, viewingUid }: { embedded?: boolean; viewingUid?: string } = {}) {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  // Browsing someone else's switcher pill (see GoalsHub.tsx's switcher) — "Share My Reports" only
  // controls whether that person's pill shows up at all (see useReportsSharing.ts); it is NOT a
  // blanket access grant. This view is scoped to whatever that person has individually shared with
  // me (group or friend), filtered to just their uid — NOT a broad userId==viewingUid query, which
  // would show goals/accounts that were never actually shared with the viewer (a real user testing
  // this caught exactly that on the Accounts tab). See AccountsHub.tsx's matching isViewingOther.
  const isViewingOther = !!viewingUid && viewingUid !== user?.uid;

  // Own + shared (group or friend) goals and accounts — same union pattern GoalsHub.tsx (goals
  // list) and AccountsHub.tsx (accounts list) already use. The shared queries run regardless of
  // isViewingOther now (not just for "Mine") since a specific person's view is now built by
  // filtering these same "shared with me" results down to just their uid, not a separate query.
  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const cappedGroupIds = (membershipsValue?.docs.map((d) => d.data().groupId) || []).slice(0, 30);

  const [ownGoalsValue] = useCollection(user && !isViewingOther ? query(collection(db, 'goals'), where('userId', '==', user.uid)) : null);
  const [groupSharedGoalsValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'goals'), where('groupId', 'in', cappedGroupIds)) : null);
  const [friendSharedGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('friendUids', 'array-contains', user.uid)) : null);
  const [goals, setGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const byId = new Map<string, any>();
    if (isViewingOther) {
      groupSharedGoalsValue?.docs.forEach((d) => { if (d.data().userId === viewingUid) byId.set(d.id, { id: d.id, ...d.data() }); });
      friendSharedGoalsValue?.docs.forEach((d) => { if (d.data().userId === viewingUid) byId.set(d.id, { id: d.id, ...d.data() }); });
    } else {
      ownGoalsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
      groupSharedGoalsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
      friendSharedGoalsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
    }
    const raw = Array.from(byId.values()).filter((g: any) => g.status === 'active' && !g.isCashHolding);
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt goals:', err));
    return () => { cancelled = true; };
  }, [isViewingOther, viewingUid, ownGoalsValue, groupSharedGoalsValue, friendSharedGoalsValue]);

  const [ownAccountsValue] = useCollection(user && !isViewingOther ? query(collection(db, 'financialAccounts'), where('userId', '==', user.uid)) : null);
  const [groupSharedAccountsValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'financialAccounts'), where('groupId', 'in', cappedGroupIds)) : null);
  const [friendSharedAccountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('friendUids', 'array-contains', user.uid)) : null);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const byId = new Map<string, any>();
    if (isViewingOther) {
      groupSharedAccountsValue?.docs.forEach((d) => { if (d.data().userId === viewingUid) byId.set(d.id, { id: d.id, ...d.data() }); });
      friendSharedAccountsValue?.docs.forEach((d) => { if (d.data().userId === viewingUid) byId.set(d.id, { id: d.id, ...d.data() }); });
    } else {
      ownAccountsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
      groupSharedAccountsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
      friendSharedAccountsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
    }
    decryptAccountsList(Array.from(byId.values())).then((decrypted) => { if (!cancelled) setAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [isViewingOther, viewingUid, ownAccountsValue, groupSharedAccountsValue, friendSharedAccountsValue]);

  // Same non-owner effective-role resolution as AccountsHub.tsx's own canEditAccount — kept as a
  // local duplicate rather than a shared import, matching this codebase's established convention
  // for small per-screen permission checks (see e.g. GroupQuickActionsMenu.tsx's header comment).
  const canEditAccount = (a: FinancialAccount): boolean => {
    if (!user) return false;
    if (a.userId === user.uid) return true;
    if (a.friendUids?.includes(user.uid)) return (a.friendRoles?.[user.uid] || 'view') === 'edit';
    return (a.groupRole || 'view') === 'edit';
  };

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
    <div className={embedded ? 'space-y-5' : 'p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32 md:pb-32'}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-primary">{t('goals.allocationManagerTitle')}</h1>
          <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>
      )}
      <p className={clsx('text-xs text-text-muted', !embedded && '-mt-3')}>{t('goals.allocationManagerSubtitle')}</p>

      {goals.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-8" data-tour="goals-allocation-list">{t('goals.noActiveGoalsForAllocation')}</p>
      ) : (
        <div className="space-y-4" data-tour="goals-allocation-list">
          {/* One table for the whole picture: a row per account, a column per goal, the account's share of that goal in each cell
              (tap to change it, + to add one). The last column says how much of the account is already spoken for. */}
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-white w-24 min-w-[6rem]" />
                  {goals.map((g, i) => (
                    <th key={g.id} className="px-1 py-2 min-w-[62px] align-bottom">
                      <button type="button" onClick={() => navigate(`/goals/${g.id}?from=allocation`)} className="flex flex-col items-center gap-0.5 w-full">
                        <span className="text-xl leading-none">{g.icon || '🎯'}</span>
                        <span className="text-[9px] font-bold text-text-muted leading-tight line-clamp-2 max-w-[60px]" style={{ color: goalColor(i) }}>{g.name}</span>
                      </button>
                    </th>
                  ))}
                  <th className="px-2 py-2 text-[10px] font-black text-text-muted uppercase tracking-wider">{t('goals.allocationUsed')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const totalPct = (a.goalAllocations || []).reduce((sum, e) => sum + (goals.some((g) => g.id === e.goalId) ? e.pct : 0), 0);
                  const editable = canEditAccount(a);
                  return (
                    <tr key={a.id} className="border-t border-border-subtle">
                      <td className="sticky left-0 z-10 bg-white px-2.5 py-2 align-middle">
                        <p className="text-xs font-bold text-on-surface leading-tight line-clamp-2">{a.name}</p>
                        <p className="text-[10px] text-text-muted font-semibold">{getCurrencySymbol(a.currency)}{formatAmountCompact(fromMinorUnits(a.currentBalanceMinor), a.currency, profile?.numberSystem)}</p>
                      </td>
                      {goals.map((g, i) => {
                        const entry = (a.goalAllocations || []).find((e) => e.goalId === g.id);
                        const color = goalColor(i);
                        const reserved = entry?.reservedAmountMinor != null;
                        return (
                          <td key={g.id} className="px-1 py-1.5 text-center">
                            {entry ? (
                              <button
                                type="button"
                                disabled={!editable}
                                onClick={() => openEdit(g.id, g.name, a.id, entry.pct)}
                                className="relative w-full rounded-xl border-[1.5px] py-1.5 font-black text-[13px] disabled:opacity-70 active:scale-95 transition-transform"
                                style={{ background: `${color}22`, borderColor: color, color }}
                              >
                                {entry.pct}%
                                {reserved && <span className="material-symbols-outlined absolute -top-1.5 -right-1 text-[12px] bg-white rounded-full text-success" title={t('goals.reserved')}>lock</span>}
                              </button>
                            ) : editable ? (
                              <button type="button" onClick={() => openEdit(g.id, g.name, a.id, 0)} className="w-full py-1.5 rounded-xl text-[#C4CDD6] hover:bg-surface active:scale-95" aria-label={t('goals.allocationAddShare')}>
                                <span className="material-symbols-outlined text-[16px] align-middle">add</span>
                              </button>
                            ) : (
                              <span className="text-[#C4CDD6]">·</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-center font-black text-xs" style={{ color: totalPct === 100 ? '#15803D' : totalPct === 0 ? '#9CA3AF' : '#B45309' }}>{totalPct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-text-muted text-center">{t('goals.allocationGridHint')}</p>

          {/* Each goal's own funding line, so the "is it getting enough" answer sits right under the table. */}
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-1">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('goals.allocationFundingStatus')}</p>
            {goals.map((g, i) => {
              const sym = getCurrencySymbol(g.currency);
              const remainingMinor = g.targetAmountMinor - goalTotalMinor(g);
              const sources = fundingSourcesForGoal(g.id, accounts);
              const schedule = remainingMinor > 0 ? projectGoalHorizonSchedule(remainingMinor, sources) : { date: null, entries: [] };
              const count = (rowsByGoal.get(g.id) || []).length;
              return (
                <button key={g.id} type="button" onClick={() => navigate(`/goals/${g.id}?from=allocation`)} className="w-full flex items-center gap-2 py-1.5 text-left">
                  <span className="w-1.5 self-stretch rounded-full shrink-0" style={{ background: goalColor(i) }} />
                  <span className="text-lg shrink-0">{g.icon || '🎯'}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-bold text-on-surface truncate">{g.name}</span>
                    <span className="block text-[10px] text-text-muted font-semibold truncate">
                      {sym}{formatAmountCompact(fromMinorUnits(g.accountAllocatedMinor), g.currency, profile?.numberSystem)} / {sym}{formatAmountCompact(fromMinorUnits(g.targetAmountMinor), g.currency, profile?.numberSystem)}
                      {' · '}
                      {remainingMinor <= 0 ? t('goals.metImmediatelyShort') : schedule.date ? t('goals.metByDate', { date: schedule.date }) : t('goals.projectionUnavailable')}
                    </span>
                  </span>
                  <span className={clsx('text-[10px] font-black px-2 py-0.5 rounded-full shrink-0', count === 0 ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success')}>
                    {count === 0 ? t('goals.allocationNoAccounts') : t('goals.allocationAccountsCount', { count: String(count) })}
                  </span>
                </button>
              );
            })}
          </div>
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
            {(() => {
              const acc = accounts.find((x) => x.id === editing.accountId);
              const others = (acc?.goalAllocations || []).reduce((sum, e) => sum + (e.goalId === editing.goalId ? 0 : e.pct), 0);
              return <p className="text-[11px] text-text-muted text-center">{t('goals.allocationFreeHint', { free: String(Math.max(0, 100 - others)) })}</p>;
            })()}
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
