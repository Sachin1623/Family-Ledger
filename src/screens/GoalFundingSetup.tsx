import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collection, doc, query, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import {
  Goal, GoalLedgerEntry, GoalFundingSource, fromMinorUnits, decryptGoalAmounts, decryptLedgerEntries,
  goalHorizonDate, goalTotalMinor, monthsBehindTarget, projectGoalHorizonBreakdown,
} from '../lib/goals';
import { FinancialAccount, decryptAccountsList, accountAllocatedPctTotal } from '../lib/accounts';
import { applyAccountChange, notifyGoalsMet, JustCompletedGoal } from '../lib/accountAllocations';

// Focused, single-goal funding setup — reached right after creating a goal (GoalWizard navigates
// here instead of the goal's own detail page), or any time later via GoalDetail's own "Edit
// Allocation" button. Distinct from the general cross-goal GoalAllocationManager (/goals/allocate,
// still around for a bird's-eye view across every goal): this screen answers the three things
// actually asked for when setting up ONE goal's funding — which accounts have room to give, what
// picking a % would contribute right now, and — combining every account's own chosen %, interest
// rate, and SIP schedule — when the goal would actually be met.
export default function GoalFundingSetup() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { goalId } = useParams<{ goalId: string }>();

  const [goalDoc] = useDocument(goalId ? doc(db, 'goals', goalId) : null);
  const [goal, setGoal] = useState<Goal | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!goalDoc?.exists()) { setGoal(null); return; }
    decryptGoalAmounts({ id: goalDoc.id, ...(goalDoc.data() as any) })
      .then((decrypted) => { if (!cancelled) setGoal(decrypted); })
      .catch((err) => console.error('Failed to decrypt goal:', err));
    return () => { cancelled = true; };
  }, [goalDoc]);

  const isOwner = !!user && !!goal && goal.userId === user.uid;
  // Cash Savings never takes an account allocation (see goals.ts's Goal.isCashHolding), and only
  // the owner ever gets to set one up — both bounce straight back to the goal itself.
  useEffect(() => {
    if (goal && (goal.isCashHolding || !isOwner)) navigate(`/goals/${goal.id}`, { replace: true });
  }, [goal, isOwner, navigate]);

  // The goal's own ledger — needed only so the "before" side of the comparison below can call
  // goalHorizonDate() exactly the way GoalDetail's own "projected met" figure does (forward
  // simulation when a linked account exists, else the trailing-3-month-average fallback), rather
  // than a screen-local approximation that could quietly disagree with what GoalDetail shows.
  const [ledgerValue] = useCollection(goal ? collection(db, 'goals', goal.id, 'ledger') : null);
  const [ledger, setLedger] = useState<GoalLedgerEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!goal) { setLedger([]); return; }
    const raw = ledgerValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptLedgerEntries(goal.id, raw)
      .then((decrypted) => { if (!cancelled) setLedger(decrypted); })
      .catch((err) => console.error('Failed to decrypt ledger:', err));
    return () => { cancelled = true; };
  }, [ledgerValue, goal?.id]);

  const [accountsValue] = useCollection(
    goal && isOwner ? query(collection(db, 'financialAccounts'), where('userId', '==', goal.userId)) : null,
  );
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raws = (accountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []).filter((a: any) => !a.archived);
    decryptAccountsList(raws).then((decrypted) => { if (!cancelled) setAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [accountsValue]);

  // What this account already gives this goal today — the draft below starts from here, and
  // "available %" below is calculated as if this slice were already free (so raising it back up
  // to what it already was is always allowed, not blocked by its own existing share).
  const existingPctFor = (a: FinancialAccount) => (a.goalAllocations || []).find((e) => e.goalId === goalId)?.pct || 0;
  const availablePctFor = (a: FinancialAccount) => Math.max(0, 100 - (accountAllocatedPctTotal(a) - existingPctFor(a)));

  // Draft %s the user is choosing on this screen, seeded from each account's existing allocation
  // to this goal the first time it's seen — never overwritten afterward by a fresh Firestore
  // snapshot, so a live balance update elsewhere doesn't clobber an in-progress edit here.
  const [draftPct, setDraftPct] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!goal) return;
    setDraftPct((prev) => {
      let changed = false;
      const next = { ...prev };
      accounts.forEach((a) => {
        if (!(a.id in next)) { next[a.id] = existingPctFor(a); changed = true; }
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, goal?.id]);

  const chosenPctFor = (a: FinancialAccount) => draftPct[a.id] ?? existingPctFor(a);
  const contributionMinorFor = (a: FinancialAccount) => Math.round((a.currentBalanceMinor * chosenPctFor(a)) / 100);

  const setPct = (a: FinancialAccount, raw: string) => {
    const max = availablePctFor(a);
    const n = Math.max(0, Math.min(max, Math.round(Number(raw.replace(/[^0-9]/g, '')) || 0)));
    setDraftPct((prev) => ({ ...prev, [a.id]: n }));
  };

  // Everything below recomputes live as draftPct changes — the whole point of this screen.
  const draftBucket2Minor = accounts.reduce((s, a) => s + contributionMinorFor(a), 0);
  const projectedTotalMinor = (goal ? goal.currentAmountMinor : 0) + draftBucket2Minor;
  const remainingMinor = (goal ? goal.targetAmountMinor : 0) - projectedTotalMinor;

  // Forward funding sources for the projection — mirrors fundingSourcesForGoal's own exclusion
  // rule (goals.ts): an account already RESERVED (frozen, goal met) whose draft % hasn't actually
  // been touched contributes nothing further, since applyAccountChange will leave its freeze alone
  // on save; touching it (raising/lowering the %) is treated as the same explicit edit that
  // unfreezes it for real once saved, so it's included here too.
  const draftSources: GoalFundingSource[] = accounts
    .filter((a) => {
      const chosen = chosenPctFor(a);
      if (chosen <= 0) return false;
      const entry = (a.goalAllocations || []).find((e) => e.goalId === goalId);
      if (entry?.reservedAmountMinor != null && chosen === entry.pct) return false;
      return true;
    })
    .map((a) => ({
      id: a.id,
      pct: chosenPctFor(a),
      currentBalanceMinor: a.currentBalanceMinor,
      interestRatePct: a.interestRatePct ?? null,
      compoundFrequency: a.compoundFrequency ?? null,
      contributionAmountMinor: a.contributionAmountMinor ?? null,
      contributionFrequency: a.contributionFrequency ?? null,
      contributionNextDate: a.contributionNextDate ?? null,
    }));
  // One combined simulation run for BOTH the projected date AND each account's own share of the
  // growth between now and then (see goals.ts's projectGoalHorizonBreakdown) — the "Contribution
  // by Account" list below adds each account's own entry back onto its already-counted lump sum to
  // answer "how much will THIS account have contributed by the time the goal is actually met."
  const draftBreakdown = remainingMinor > 0 && draftSources.length > 0 ? projectGoalHorizonBreakdown(remainingMinor, draftSources) : null;
  const projectedDate = draftBreakdown?.date ?? null;
  const draftGrowthById = new Map<string, number>(draftSources.map((s, i) => [s.id as string, draftBreakdown?.perSourceGrowthMinor[i] ?? 0]));

  // "Before" — the goal's projection exactly as it stands today, from the accounts' currently
  // SAVED allocations (not the draft above at all) — this is the same figure GoalDetail's own page
  // shows, so switching over there and back always agrees with what this screen said "before" was.
  const originalProjected = goal && goal.status !== 'completed' ? goalHorizonDate(goal, ledger, accounts) : null;
  const originalTotalMinor = goal ? goalTotalMinor(goal) : 0;
  // monthsBehindTarget is a plain (dateA, dateB) -> months-between function despite its name (see
  // its doc comment in goals.ts) — reused here as a generic date-diff to compare the two projected
  // dates rather than a date against a target. Negative = the new projection lands earlier (sooner).
  const monthsDelta = originalProjected && projectedDate ? monthsBehindTarget(originalProjected, projectedDate) : null;

  // A recurring contribution can be weekly/quarterly/yearly (see accounts.ts's ContributionFrequency)
  // — normalized to a monthly-equivalent figure here purely for display, so "additional monthly
  // contribution" below means the same thing regardless of the account's own actual SIP cadence.
  const monthlyEquivalentMinor = (amountMinor: number | null | undefined, freq: string | null | undefined): number => {
    if (!amountMinor || !freq) return 0;
    if (freq === 'weekly') return Math.round((amountMinor * 52) / 12);
    if (freq === 'quarterly') return Math.round(amountMinor / 3);
    if (freq === 'yearly') return Math.round(amountMinor / 12);
    return amountMinor; // monthly
  };

  // This ONE tile's own marginal effect on the goal-met date — every OTHER account held at its
  // currently-SAVED % (untouched by whatever else this screen's other tiles are drafting right
  // now) with only this account swapped to its chosen draft %, so the resulting date isolates what
  // THIS specific change does, independent of any other in-progress edit elsewhere on the screen.
  // Feeds the exact same growth-aware projectGoalHorizonDate() engine as the aggregate card above
  // (interest compounding + SIP schedule both included), which is what part 1 of the feedback was
  // about — the previous version of this tile only ever compared static balances, never projected
  // forward at all.
  const whatIfFor = (target: FinancialAccount): { remainingMinor: number; date: string | null; targetGrowthMinor: number } => {
    let bucket2 = 0;
    const sources: GoalFundingSource[] = [];
    accounts.forEach((acc) => {
      const pct = acc.id === target.id ? chosenPctFor(acc) : existingPctFor(acc);
      bucket2 += Math.round((acc.currentBalanceMinor * pct) / 100);
      if (pct <= 0) return;
      const entry = (acc.goalAllocations || []).find((e) => e.goalId === goalId);
      if (entry?.reservedAmountMinor != null && pct === entry.pct) return;
      sources.push({
        id: acc.id, pct, currentBalanceMinor: acc.currentBalanceMinor,
        interestRatePct: acc.interestRatePct ?? null, compoundFrequency: acc.compoundFrequency ?? null,
        contributionAmountMinor: acc.contributionAmountMinor ?? null, contributionFrequency: acc.contributionFrequency ?? null,
        contributionNextDate: acc.contributionNextDate ?? null,
      });
    });
    const remainingMinor = (goal ? goal.targetAmountMinor : 0) - ((goal ? goal.currentAmountMinor : 0) + bucket2);
    if (remainingMinor <= 0 || sources.length === 0) return { remainingMinor, date: null, targetGrowthMinor: 0 };
    const breakdown = projectGoalHorizonBreakdown(remainingMinor, sources);
    const idx = sources.findIndex((s) => s.id === target.id);
    return { remainingMinor, date: breakdown.date, targetGrowthMinor: idx >= 0 ? breakdown.perSourceGrowthMinor[idx] : 0 };
  };

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChanges = accounts.some((a) => chosenPctFor(a) !== existingPctFor(a));

  const handleSave = async () => {
    if (!user || !goal || saving || !hasChanges) return;
    setSaving(true);
    setError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const touched = accounts.filter((a) => chosenPctFor(a) !== existingPctFor(a));
      let allCompleted: JustCompletedGoal[] = [];
      for (const a of touched) {
        const nextPct = chosenPctFor(a);
        const nextAllocations = (a.goalAllocations || []).filter((e) => e.goalId !== goal.id);
        if (nextPct > 0) nextAllocations.push({ goalId: goal.id, goalName: goal.name, pct: nextPct });
        const { justCompletedGoals } = await applyAccountChange(a.id, a.currentBalanceMinor, nextAllocations, actorName);
        allCompleted = allCompleted.concat(justCompletedGoals);
      }
      notifyGoalsMet(allCompleted);
      navigate(`/goals/${goal.id}`);
    } catch (err) {
      console.error('Failed to save allocations:', err);
      setError(t('goals.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!goal) {
    return <div className="p-8 text-center text-text-muted">{t('goals.loading')}</div>;
  }

  const fmt = (minor: number, currency?: string) => `${getCurrencySymbol(currency || goal.currency)}${fromMinorUnits(minor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  // One line summarizing the before/after comparison — only shown once the user has actually
  // changed something (comparing against yourself before any edit is a no-op).
  let improvementText: string | null = null;
  if (hasChanges) {
    if (remainingMinor <= 0 && originalProjected) {
      improvementText = t('goals.metImmediatelyVsOriginal', { date: originalProjected });
    } else if (monthsDelta !== null) {
      if (monthsDelta < 0) improvementText = t('goals.monthsSooner', { months: Math.abs(monthsDelta) });
      else if (monthsDelta > 0) improvementText = t('goals.monthsLater', { months: monthsDelta });
      else improvementText = t('goals.noChangeToProjection');
    } else if (projectedDate && !originalProjected) {
      improvementText = t('goals.newProjectionAdded', { date: projectedDate });
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl shrink-0">{goal.icon || '🎯'}</span>
          <div className="min-w-0">
            <h1 className="text-lg font-black text-primary truncate">{t('goals.fundingSetupTitle')}</h1>
            <p className="text-xs text-text-muted truncate">{goal.name}</p>
          </div>
        </div>
        <button onClick={() => navigate(`/goals/${goal.id}`)} className="p-2 -mr-2 text-text-muted hover:bg-surface rounded-full shrink-0">
          <span className="material-symbols-outlined text-[20px] block">close</span>
        </button>
      </div>
      <p className="text-xs text-text-muted -mt-3">{t('goals.fundingSetupSubtitle')}</p>

      {accounts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-6 text-center space-y-3">
          <p className="text-sm text-text-muted">{t('goals.noAccountsForAllocation')}</p>
          <button onClick={() => navigate('/goals?tab=accounts')} className="text-xs font-bold text-primary underline">
            {t('accounts.title')}
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {accounts.map((a) => {
            const available = availablePctFor(a);
            const chosen = chosenPctFor(a);
            const existing = existingPctFor(a);
            const fullyTaken = available === 0 && chosen === 0;
            const changed = chosen !== existing;

            // a) additional one-time contribution — the immediate lump-sum this % change credits,
            // over whatever this account already contributes today.
            const existingContributionMinor = Math.round((a.currentBalanceMinor * existing) / 100);
            const oneTimeDeltaMinor = contributionMinorFor(a) - existingContributionMinor;
            // b) additional monthly contribution — only the MARGINAL slice of this account's own
            // SIP that the % increase/decrease claims (the existing % already counted its share).
            const monthlyDeltaMinor = Math.round((monthlyEquivalentMinor(a.contributionAmountMinor, a.contributionFrequency) * (chosen - existing)) / 100);
            // c) resulting goal-met date, isolated to this one tile's change (see whatIfFor above).
            const whatIf = changed ? whatIfFor(a) : null;
            const tileMonthsDelta = whatIf?.date && originalProjected ? monthsBehindTarget(originalProjected, whatIf.date) : null;
            // This account's own share of the OVERALL goal target — before vs. after this change —
            // answering "how much of the goal does this account cover" directly, not just the raw
            // amount delta.
            const targetMinor = goal ? goal.targetAmountMinor : 0;
            const pctOfTargetBefore = targetMinor > 0 ? Math.round((existingContributionMinor / targetMinor) * 100) : 0;
            const pctOfTargetAfter = targetMinor > 0 ? Math.round((contributionMinorFor(a) / targetMinor) * 100) : 0;

            return (
              <div key={a.id} className={clsx('bg-white rounded-2xl border shadow-sm p-4 space-y-2.5', fullyTaken ? 'border-border-subtle opacity-60' : 'border-border-subtle')}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-primary shrink-0">account_balance</span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-on-surface truncate">{a.name}</p>
                      <p className="text-[10px] text-text-muted">{fmt(a.currentBalanceMinor, a.currency)}</p>
                    </div>
                  </div>
                  <span className={clsx('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0', available > 0 ? 'bg-primary/10 text-primary' : 'bg-surface-container text-text-muted')}>
                    {available > 0 ? t('goals.pctAvailable', { pct: available }) : t('goals.fullyAllocatedElsewhere')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text" inputMode="numeric"
                      value={chosen}
                      disabled={available === 0 && chosen === 0}
                      onChange={(e) => setPct(a, e.target.value)}
                      className="w-16 h-10 text-center bg-surface border border-border-subtle rounded-xl font-black text-primary text-sm outline-none disabled:opacity-40"
                    />
                    <span className="text-sm font-bold text-text-muted">%</span>
                  </div>
                  {available > 0 && (
                    <button type="button" onClick={() => setDraftPct((prev) => ({ ...prev, [a.id]: available }))} className="text-[10px] font-bold text-primary">
                      {t('goals.useMaxPct')}
                    </button>
                  )}
                  {!changed && chosen > 0 && (
                    <span className="flex-1 text-right text-xs font-bold text-success">
                      {t('goals.contributesAmount', { amount: fmt(contributionMinorFor(a)) })}
                    </span>
                  )}
                </div>

                {changed && (
                  <div className="bg-surface rounded-xl p-2.5 space-y-1 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-text-muted shrink-0">{t('goals.tileShareOfTarget')}</span>
                      <span className="text-right font-bold">
                        <span className="text-text-muted">{fmt(existingContributionMinor)} ({pctOfTargetBefore}%)</span>
                        {' → '}
                        <span className="text-primary">{fmt(contributionMinorFor(a))} ({pctOfTargetAfter}%)</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">{t('goals.tileOneTime')}</span>
                      <span className={clsx('font-bold', oneTimeDeltaMinor >= 0 ? 'text-success' : 'text-error')}>
                        {oneTimeDeltaMinor >= 0 ? '+' : '-'}{fmt(Math.abs(oneTimeDeltaMinor))}
                      </span>
                    </div>
                    {monthlyDeltaMinor !== 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">{t('goals.tileMonthly')}</span>
                        <span className={clsx('font-bold', monthlyDeltaMinor >= 0 ? 'text-success' : 'text-error')}>
                          {monthlyDeltaMinor >= 0 ? '+' : '-'}{fmt(Math.abs(monthlyDeltaMinor))}{t('goals.perMonthSuffix')}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">{t('goals.tileNewGoalDate')}</span>
                      <span className="font-bold text-primary text-right">
                        {whatIf && whatIf.remainingMinor <= 0
                          ? t('goals.metImmediatelyShort')
                          : whatIf?.date
                            ? `${t('goals.metByDate', { date: whatIf.date })}${tileMonthsDelta != null && tileMonthsDelta !== 0 ? ` · ${tileMonthsDelta < 0 ? t('goals.monthsSooner', { months: Math.abs(tileMonthsDelta) }) : t('goals.monthsLater', { months: tileMonthsDelta })}` : ''}`
                            : t('goals.projectionUnavailable')}
                      </span>
                    </div>
                    {whatIf && (whatIf.remainingMinor <= 0 || whatIf.date) && (
                      <div className="flex items-center justify-between border-t border-border-subtle pt-1">
                        <span className="text-text-muted">{t('goals.tileContributionAtGoalMet')}</span>
                        <span className="font-black text-primary">
                          {fmt(contributionMinorFor(a) + (whatIf.remainingMinor <= 0 ? 0 : whatIf.targetGrowthMinor))}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {accounts.length > 0 && (
        <div className="bg-primary/5 rounded-2xl border border-primary/20 p-4 space-y-3">
          <h2 className="text-xs font-bold text-primary">{t('goals.projectedSummaryTitle')}</h2>

          {hasChanges ? (
            <div className="bg-white rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">{t('goals.beforeAllocationLabel')}</span>
                <span className="text-right">
                  <span className="block font-bold text-on-surface">{fmt(originalTotalMinor)}</span>
                  <span className="block text-text-muted">
                    {originalProjected ? t('goals.metByDate', { date: originalProjected }) : t('goals.projectionUnavailable')}
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">{t('goals.afterAllocationLabel')}</span>
                <span className="text-right">
                  <span className="block font-black text-primary">{fmt(projectedTotalMinor)}</span>
                  <span className="block font-bold text-success">
                    {remainingMinor <= 0 ? t('goals.metImmediatelyShort') : projectedDate ? t('goals.metByDate', { date: projectedDate }) : t('goals.projectionUnavailable')}
                  </span>
                </span>
              </div>
              {improvementText && (
                <p className="text-[11px] font-black text-success text-center pt-1 border-t border-border-subtle">{improvementText}</p>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-muted">{t('goals.projectedTotalLabel')}</span>
                <span className="font-black text-primary">{fmt(projectedTotalMinor)} <span className="text-text-muted font-bold">/ {fmt(goal.targetAmountMinor)}</span></span>
              </div>
              <p className="text-xs text-on-surface font-bold">
                {remainingMinor <= 0
                  ? t('goals.projectedMetImmediately')
                  : projectedDate
                    ? t('goals.projectedMetOnDraft', { date: projectedDate })
                    : t('goals.projectedUnavailableDraft')}
              </p>
            </>
          )}

          {accounts.some((a) => chosenPctFor(a) > 0) && (
            <div className="bg-white rounded-xl p-3 space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.contributionByAccountTitle')}</p>
              {accounts.filter((a) => chosenPctFor(a) > 0).map((a) => {
                const contrib = contributionMinorFor(a);
                const pctOfTarget = goal.targetAmountMinor > 0 ? Math.round((contrib / goal.targetAmountMinor) * 100) : 0;
                // What this account will have grown its own share to BY the projected goal-met
                // date (today's lump sum + its slice of the combined simulation's growth) — this is
                // the "when my goal hits target, how much will this account have contributed"
                // figure, shown only when that date is actually known (or the goal is met today).
                const atGoalMetMinor = remainingMinor <= 0 ? contrib : projectedDate ? contrib + (draftGrowthById.get(a.id) || 0) : null;
                return (
                  <div key={a.id} className="text-xs space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-on-surface font-bold">
                        {a.name} <span className="text-text-muted font-normal">({chosenPctFor(a)}%)</span>
                      </span>
                      <span className="shrink-0 text-primary font-bold">
                        {fmt(contrib)} <span className="text-text-muted font-normal">({pctOfTarget}%)</span>
                      </span>
                    </div>
                    {atGoalMetMinor != null && (
                      <div className="flex items-center justify-between gap-2 pl-1">
                        <span className="text-text-muted">{t('goals.atGoalMetLabel')}</span>
                        <span className="font-bold text-success">{fmt(atGoalMetMinor)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-error font-bold text-center">{error}</p>}

      <div className="space-y-2">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="w-full py-3 bg-primary text-white font-bold rounded-xl text-sm disabled:opacity-40"
        >
          {saving ? t('goals.saving') : t('goals.saveAllocations')}
        </button>
        <button onClick={() => navigate(`/goals/${goal.id}`)} className="w-full py-2.5 text-xs font-bold text-text-muted">
          {t('goals.skipForNow')}
        </button>
      </div>
    </div>
  );
}
