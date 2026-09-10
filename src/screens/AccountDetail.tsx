import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collection, doc, query, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { decryptAmount } from '../lib/fieldCrypto';
import {
  Goal, fromMinorUnits, goalTotalMinor, fundingSourcesForGoal, projectGoalHorizonSchedule, decryptGoalsList,
} from '../lib/goals';
import {
  FinancialAccount, ACCOUNT_TYPES,
  decryptAccount, decryptAccountsList, accountUnallocatedMinor, accountAllocatedPctTotal,
} from '../lib/accounts';
import { applyAccountChange, undoLatestAccountChange, notifyGoalsMet } from '../lib/accountAllocations';
import GoalContributionSchedule from '../components/GoalContributionSchedule';
import ImageLightbox from '../components/ImageLightbox';

const maskAccountNumber = (num: string) => (num.length <= 4 ? num : `••••${num.slice(-4)}`);

// The account-side counterpart to GoalDetail: tap an account (from AccountsHub, or the Accounts
// tab inside GoalsHub) and land here — a real screen, not the old inline modal card. Overview +
// three tabs (Goals it funds / Contributions over time / History). Edit Allocation and the
// History "Undo" run right here; the fuller Edit-account-details / Share / Delete flows deep-link
// back to AccountsHub's existing modals (they're big and shared with the Add flow). Shared
// viewers see everything read-only, same as GoalDetail treats a non-owner.
export default function AccountDetail() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { accountId } = useParams<{ accountId: string }>();

  const [accountDoc] = useDocument(accountId ? doc(db, 'financialAccounts', accountId) : null);
  const [account, setAccount] = useState<FinancialAccount | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!accountDoc?.exists()) { setAccount(null); return; }
    decryptAccount({ id: accountDoc.id, ...(accountDoc.data() as any) })
      .then((a) => { if (!cancelled) setAccount(a); })
      .catch((err) => console.error('Failed to decrypt account:', err));
    return () => { cancelled = true; };
  }, [accountDoc]);

  const ownerId = account?.userId;
  const isOwner = !!user && !!account && account.userId === user.uid;
  const canEdit = useMemo(() => {
    if (!user || !account) return false;
    if (account.userId === user.uid) return true;
    if (account.friendUids?.includes(user.uid)) return (account.friendRoles?.[user.uid] || 'view') === 'edit';
    return (account.groupRole || 'view') === 'edit';
  }, [user, account]);

  // Every one of the owner's accounts + goals — needed so fundingSourcesForGoal() sees the full
  // funding picture when projecting each linked goal, and so linked-goal targets/totals are known.
  const [allAccountsValue] = useCollection(ownerId ? query(collection(db, 'financialAccounts'), where('userId', '==', ownerId)) : null);
  const [allAccounts, setAllAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = allAccountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raw).then((decrypted) => { if (!cancelled) setAllAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [allAccountsValue]);

  const [goalsValue] = useCollection(ownerId ? query(collection(db, 'goals'), where('userId', '==', ownerId)) : null);
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = (goalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []).filter((g: any) => !g.isCashHolding);
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setAllGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt goals:', err));
    return () => { cancelled = true; };
  }, [goalsValue]);
  const goalById = useMemo(() => new Map(allGoals.map((g) => [g.id, g])), [allGoals]);

  // --- History (account log) ---
  const [logValue] = useCollection(accountId ? collection(db, 'financialAccounts', accountId, 'log') : null);
  const [logEntries, setLogEntries] = useState<any[]>([]);
  const [historyLightbox, setHistoryLightbox] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!accountId) { setLogEntries([]); return; }
    const raw = (logValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [])
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    Promise.all(raw.map(async (e) => ({
      ...e,
      balanceBeforeMinor: await decryptAmount('account', accountId, e.balanceBeforeMinor),
      balanceAfterMinor: await decryptAmount('account', accountId, e.balanceAfterMinor),
      allocationChanges: await Promise.all((e.allocationChanges || []).map(async (c: any) => ({
        ...c,
        beforeAmountMinor: await decryptAmount('account', accountId, c.beforeAmountMinor),
        afterAmountMinor: await decryptAmount('account', accountId, c.afterAmountMinor),
      }))),
    }))).then((decrypted) => { if (!cancelled) setLogEntries(decrypted); })
      .catch((err) => console.error('Failed to decrypt account history:', err));
    return () => { cancelled = true; };
  }, [logValue, accountId]);

  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const handleUndoLatest = async () => {
    if (!account || undoBusy) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      await undoLatestAccountChange(account.id, actorName);
      setConfirmUndo(false);
    } catch (err: any) {
      console.error('Failed to undo latest account change:', err);
      setUndoError(err?.message === 'stale' ? t('accounts.undoStale') : t('accounts.undoFailed'));
    } finally {
      setUndoBusy(false);
    }
  };

  // --- Edit Allocation ---
  const [showAllocEditor, setShowAllocEditor] = useState(false);
  const [allocPcts, setAllocPcts] = useState<Record<string, number>>({});
  const [allocSaving, setAllocSaving] = useState(false);
  const [allocError, setAllocError] = useState<string | null>(null);
  const activeLinkableGoals = useMemo(
    () => allGoals.filter((g) => g.status === 'active'),
    [allGoals],
  );
  // Currently-allocated goals that aren't in the active list (completed/paused) still hold a real
  // % — surface them in the editor too so that % never silently vanishes (same "hidden allocation"
  // handling AccountsHub's own edit form does).
  const allocEditorGoals = useMemo(() => {
    const rows: { id: string; name: string }[] = activeLinkableGoals.map((g) => ({ id: g.id, name: g.name }));
    (account?.goalAllocations || []).forEach((a) => {
      if (!rows.some((r) => r.id === a.goalId)) rows.push({ id: a.goalId, name: a.goalName });
    });
    return rows;
  }, [activeLinkableGoals, account]);
  const openAllocEditor = () => {
    setAllocPcts(Object.fromEntries((account?.goalAllocations || []).map((a) => [a.goalId, a.pct])));
    setAllocError(null);
    setShowAllocEditor(true);
  };
  const allocTotal = Object.keys(allocPcts).reduce((s, k) => s + (allocPcts[k] || 0), 0);
  const handleSaveAllocation = async () => {
    if (!account || !user || allocSaving) return;
    if (allocTotal > 100) { setAllocError(t('accounts.allocationOver100')); return; }
    setAllocSaving(true);
    setAllocError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nameFor = (goalId: string) =>
        allocEditorGoals.find((g) => g.id === goalId)?.name
        || (account.goalAllocations || []).find((a) => a.goalId === goalId)?.goalName
        || goalId;
      const newAllocations = Object.keys(allocPcts)
        .filter((goalId) => (allocPcts[goalId] || 0) > 0)
        .map((goalId) => ({ goalId, goalName: nameFor(goalId), pct: allocPcts[goalId] }));
      const { justCompletedGoals } = await applyAccountChange(account.id, account.currentBalanceMinor, newAllocations, actorName);
      notifyGoalsMet(justCompletedGoals);
      setShowAllocEditor(false);
    } catch (err) {
      console.error('Failed to save allocation:', err);
      setAllocError(t('goals.saveFailed'));
    } finally {
      setAllocSaving(false);
    }
  };

  const [tab, setTab] = useState<'goals' | 'contributions' | 'history'>('goals');
  const [revealNumber, setRevealNumber] = useState(false);
  const [expandedContrib, setExpandedContrib] = useState<Set<string>>(new Set());

  if (!account) {
    return <div className="p-8 text-center text-text-muted">{t('goals.loading')}</div>;
  }

  const sym = getCurrencySymbol(account.currency);
  const typeMeta = ACCOUNT_TYPES.find((tp) => tp.id === account.type);
  const unallocatedMinor = accountUnallocatedMinor(account);
  const allocatedPct = accountAllocatedPctTotal(account);
  const fmt = (m: number) => `${sym}${formatAmountCompact(fromMinorUnits(m), account.currency, profile?.numberSystem)}`;

  // Per linked goal: this account's contribution today, and its projected contribution once the
  // goal is actually met — same forward simulation GoalDetail's Contributions tab uses.
  const linkedRows = (account.goalAllocations || []).map((entry) => {
    const g = goalById.get(entry.goalId);
    const currentMinor = entry.reservedAmountMinor != null
      ? entry.reservedAmountMinor
      : Math.round((account.currentBalanceMinor * entry.pct) / 100);
    let finalMinor = currentMinor;
    let metDate: string | null = null;
    if (g && g.targetAmountMinor > 0) {
      const remaining = g.targetAmountMinor - goalTotalMinor(g);
      if (remaining > 0 && entry.reservedAmountMinor == null) {
        const sources = fundingSourcesForGoal(g.id, allAccounts);
        const schedule = projectGoalHorizonSchedule(remaining, sources);
        const last = schedule.entries[schedule.entries.length - 1];
        const idx = sources.findIndex((s) => s.id === account.id);
        if (last && idx >= 0) finalMinor = currentMinor + last.perSourceCumulativeMinor[idx];
        metDate = schedule.date;
      }
    }
    const targetPctNow = g && g.targetAmountMinor > 0 ? Math.round((currentMinor / g.targetAmountMinor) * 100) : 0;
    const targetPctFinal = g && g.targetAmountMinor > 0 ? Math.round((finalMinor / g.targetAmountMinor) * 100) : 0;
    return { entry, goal: g, currentMinor, finalMinor, metDate, targetPctNow, targetPctFinal };
  });

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32">
      <div className="flex items-center justify-end">
        {canEdit ? (
          <button
            onClick={() => navigate(`/goals/accounts?edit=${account.id}`)}
            className="p-2 text-primary hover:bg-primary/10 rounded-full"
            aria-label={t('common.edit')}
          >
            <span className="material-symbols-outlined text-[20px] block">edit</span>
          </button>
        ) : (
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider bg-surface-container px-2.5 py-1 rounded-full flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">visibility</span>
            {t('accounts.sharedByLabelView')}
          </span>
        )}
      </div>

      {/* Overview */}
      <div className="bg-white rounded-3xl border border-border-subtle shadow-sm p-6 space-y-4 text-center">
        <span className="text-5xl block">{typeMeta?.icon || '💰'}</span>
        <div>
          <h1 className="text-xl font-black text-primary">{account.name}</h1>
          <p className="text-[11px] text-text-muted mt-0.5">
            {t(`accounts.type.${account.type}`)} · {t('accounts.asOf', { date: new Date(account.balanceAsOf || account.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}
          </p>
        </div>
        <p className="text-3xl font-black text-primary">
          {sym}{fromMinorUnits(account.currentBalanceMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </p>
        <p className="text-[11px] text-text-muted">
          {t('accounts.unallocatedAmount', { amount: fmt(unallocatedMinor), pct: 100 - allocatedPct })}
        </p>
      </div>

      {/* Overview details */}
      {(account.accountNumber || account.interestRatePct != null || account.contributionFrequency || (account.nominees || []).length > 0) && (
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2 text-xs">
          {account.accountNumber && (
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{t('accounts.accountNumber')}</span>
              <button type="button" onClick={() => setRevealNumber((v) => !v)} className="font-bold text-on-surface flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px]">{revealNumber ? 'visibility_off' : 'visibility'}</span>
                {revealNumber ? account.accountNumber : maskAccountNumber(account.accountNumber)}
              </button>
            </div>
          )}
          {account.interestRatePct != null && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-muted shrink-0">{t('accounts.interestRateOptional')}</span>
              <span className="font-bold text-on-surface text-right">
                {account.compoundFrequency
                  ? t('accounts.interestRateDisplay', { rate: account.interestRatePct, frequency: t(`accounts.compound.${account.compoundFrequency}`) })
                  : t('accounts.interestRateDisplayNoCompound', { rate: account.interestRatePct })}
                {account.interestNextDate && ` · ${t('accounts.interestNextDateShort', { date: new Date(account.interestNextDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}`}
              </span>
            </div>
          )}
          {account.contributionFrequency && account.contributionAmountMinor != null && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-muted shrink-0">{t('accounts.contributionOptional')}</span>
              <span className="font-bold text-primary text-right">
                {t('accounts.sipBadge', {
                  amount: `${sym}${formatAmountCompact(fromMinorUnits(account.contributionAmountMinor), account.currency, profile?.numberSystem)}`,
                  frequency: t(`accounts.contributionFrequency.${account.contributionFrequency}`),
                  date: account.contributionNextDate ? new Date(account.contributionNextDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—',
                })}
              </span>
            </div>
          )}
          {(account.nominees || []).length > 0 && (
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-muted shrink-0">{t('accounts.nominees')}</span>
              <span className="font-bold text-on-surface text-right">
                {account.nominees!.map((n) => (account.nominees!.length > 1 ? `${n.name} (${n.pct}%)` : n.name)).join(', ')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
        {(['goals', 'contributions', 'history'] as const).map((tp) => (
          <button
            key={tp}
            type="button"
            onClick={() => setTab(tp)}
            className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', tab === tp ? 'bg-primary text-white' : 'text-text-muted')}
          >
            {t(`accounts.detailTab.${tp}`)}
          </button>
        ))}
      </div>

      {tab === 'goals' && (
        <div className="space-y-2.5">
          {linkedRows.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">{t('accounts.noGoalsLinked')}</p>
          ) : (
            <>
              <p className="text-[9px] font-bold text-text-muted pl-1">
                <span className="text-primary">{t('goals.allocationLegendNow')}</span>
                {' → '}
                <span className="text-success">{t('goals.allocationLegendAtGoal')}</span>
              </p>
              {linkedRows.map(({ entry, goal, currentMinor, finalMinor, metDate, targetPctNow, targetPctFinal }) => (
                <button
                  key={entry.goalId}
                  type="button"
                  onClick={() => navigate(`/goals/${entry.goalId}?from=accounts`)}
                  className="w-full bg-white rounded-2xl border border-border-subtle shadow-sm p-3 text-left space-y-1 hover:bg-primary/5 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg shrink-0">{goal?.icon || '🎯'}</span>
                    <span className="flex-1 min-w-0 text-sm font-bold text-on-surface truncate">{entry.goalName}</span>
                    <span className="text-xs font-black text-primary shrink-0">{entry.pct}%</span>
                  </div>
                  <p className="text-[11px] font-bold pl-[26px] truncate">
                    <span className="text-primary">{targetPctNow}% · {fmt(currentMinor)}</span>
                    <span className="text-text-muted"> → </span>
                    <span className="text-success">{targetPctFinal}% · {fmt(finalMinor)}</span>
                  </p>
                  {metDate && (
                    <p className="text-[10px] text-text-muted pl-[26px]">{t('goals.metByDate', { date: metDate })}</p>
                  )}
                </button>
              ))}
            </>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={openAllocEditor}
              className="w-full py-2.5 border border-border-subtle text-primary text-xs font-bold rounded-xl flex items-center justify-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">tune</span>
              {t('accounts.editAllocation')}
            </button>
          )}
        </div>
      )}

      {tab === 'contributions' && (
        <div className="space-y-2.5">
          {linkedRows.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">{t('accounts.noGoalsLinked')}</p>
          ) : (
            linkedRows.map(({ entry, goal, currentMinor }) => {
              if (!goal) return null;
              const open = expandedContrib.has(entry.goalId);
              return (
                <div key={entry.goalId} className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedContrib((prev) => {
                      const next = new Set(prev);
                      next.has(entry.goalId) ? next.delete(entry.goalId) : next.add(entry.goalId);
                      return next;
                    })}
                    className="w-full p-3 flex items-center gap-2 text-left"
                  >
                    <span className="text-lg shrink-0">{goal.icon || '🎯'}</span>
                    <span className="flex-1 min-w-0 text-sm font-bold text-on-surface truncate">{entry.goalName}</span>
                    <span className="material-symbols-outlined text-[18px] text-text-muted shrink-0">{open ? 'expand_less' : 'expand_more'}</span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3">
                      <GoalContributionSchedule
                        goal={goal}
                        linkedAccounts={[{
                          id: account.id, name: account.name, currency: account.currency,
                          pct: entry.pct, contributedMinor: currentMinor, reserved: entry.reservedAmountMinor != null,
                        }]}
                        linkedFullAccounts={[account]}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-2">
          {logEntries.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">{t('accounts.noHistoryYet')}</p>
          ) : (
            logEntries.map((e, idx) => (
              <div key={e.id} className="bg-white rounded-xl border border-border-subtle shadow-sm p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-text-muted">{(e.createdAt || '').slice(0, 16).replace('T', ' ')} · {e.createdByName}</span>
                  <span className="text-xs font-bold text-primary">
                    {fmt(e.balanceBeforeMinor)}{' → '}{fmt(e.balanceAfterMinor)}
                  </span>
                </div>
                {e.note && <p className="text-[10px] text-text-muted">{e.note}</p>}
                {(e.allocationChanges || []).filter((c: any) => c.beforePct !== c.afterPct).map((c: any, i: number) => (
                  <p key={i} className="text-[10px] text-text-muted">
                    {c.goalName}: {c.beforePct}% ({fmt(c.beforeAmountMinor)}) {' → '} {c.afterPct}% ({fmt(c.afterAmountMinor)})
                  </p>
                ))}
                {(e.images || []).length > 0 && (
                  <div className="flex gap-1.5 pt-1">
                    {e.images.map((src: string, i: number) => (
                      <button key={i} type="button" onClick={() => setHistoryLightbox(src)} className="w-12 h-12 rounded-lg overflow-hidden border border-border-subtle shrink-0">
                        <img src={src} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                {idx === 0 && canEdit && (
                  confirmUndo ? (
                    <div className="pt-1 space-y-1.5">
                      <p className="text-[10px] font-bold text-text-muted">{t('accounts.undoConfirm')}</p>
                      {undoError && <p className="text-[10px] font-bold text-error">{undoError}</p>}
                      <div className="flex gap-2">
                        <button type="button" onClick={handleUndoLatest} disabled={undoBusy} className="flex-1 py-1.5 rounded-lg bg-error/10 text-error text-[11px] font-bold disabled:opacity-50">
                          {undoBusy ? t('goals.saving') : t('accounts.undoConfirmYes')}
                        </button>
                        <button type="button" onClick={() => { setConfirmUndo(false); setUndoError(null); }} disabled={undoBusy} className="flex-1 py-1.5 rounded-lg border border-border-subtle text-text-muted text-[11px] font-bold disabled:opacity-50">
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirmUndo(true)} className="pt-1 flex items-center gap-1 text-[11px] font-bold text-text-muted hover:text-error">
                      <span className="material-symbols-outlined text-[14px]">undo</span>
                      {t('accounts.undoLatest')}
                    </button>
                  )
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Actions */}
      {canEdit && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => navigate(`/goals/accounts?edit=${account.id}`)} className="py-2.5 bg-primary text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-[16px]">edit</span>{t('accounts.editDetails')}
          </button>
          <button type="button" onClick={() => navigate('/goals/accounts?transfer=1')} className="py-2.5 border border-border-subtle text-text-muted text-xs font-bold rounded-xl flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-[16px]">swap_horiz</span>{t('accounts.transferFunds')}
          </button>
          {isOwner && (
            <>
              <button type="button" onClick={() => navigate(`/goals/accounts?share=${account.id}`)} className="py-2.5 border border-border-subtle text-text-muted text-xs font-bold rounded-xl flex items-center justify-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">share</span>{t('accounts.shareDetails')}
              </button>
              <button type="button" onClick={() => navigate(`/goals/accounts?delete=${account.id}`)} className="py-2.5 border border-error/30 text-error text-xs font-bold rounded-xl flex items-center justify-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">delete</span>{t('common.delete')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Edit Allocation modal */}
      {showAllocEditor && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !allocSaving && setShowAllocEditor(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('accounts.editAllocationFor', { name: account.name })}</h3>
            <p className="text-xs text-text-muted">{t('accounts.editAllocationHint')}</p>
            <div className="space-y-2">
              {allocEditorGoals.map((g) => (
                <div key={g.id} className="flex items-center gap-2 bg-surface rounded-xl p-2.5">
                  <span className="flex-1 text-xs font-bold text-on-surface truncate">{g.name}</span>
                  <input
                    type="text" inputMode="numeric" value={allocPcts[g.id] || 0}
                    onChange={(e) => setAllocPcts({ ...allocPcts, [g.id]: Math.max(0, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, '')) || 0)) })}
                    className="w-14 h-9 text-center bg-white border border-border-subtle rounded-lg font-black text-primary text-sm outline-none"
                  />
                  <span className="text-xs font-bold text-text-muted">%</span>
                </div>
              ))}
            </div>
            <p className={clsx('text-xs font-bold text-center', allocTotal > 100 ? 'text-error' : allocTotal === 100 ? 'text-success' : 'text-text-muted')}>
              {allocTotal}% {t('goals.allocated')}
            </p>
            {allocError && <p className="text-xs text-error font-bold text-center">{allocError}</p>}
            <button onClick={handleSaveAllocation} disabled={allocSaving} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {allocSaving ? t('goals.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {historyLightbox && <ImageLightbox src={historyLightbox} onClose={() => setHistoryLightbox(null)} />}
    </div>
  );
}
