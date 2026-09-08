import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import {
  Goal, fromMinorUnits, goalTotalMinor, fundingSourcesForGoal,
  projectGoalHorizonSchedule, aggregateScheduleByYear,
} from '../lib/goals';
import { FinancialAccount } from '../lib/accounts';

interface LinkedAccountSummary { id: string; name: string; currency: string; pct: number; contributedMinor: number; reserved: boolean }

// The "Contributions" tab on GoalDetail — answers "how am I actually going to reach this goal,
// month by month/year by year, and from which account." Distinct from GoalFundingSetup (which
// edits DRAFT %s before saving): this is a read-only view of the goal's ACTUALLY SAVED allocations,
// projected forward with each linked account's own interest rate/compounding and SIP schedule
// (same engine as GoalFundingSetup — see goals.ts's projectGoalHorizonSchedule, the single
// walk-forward simulation everything else in this app's goal projections now derives from).
export default function GoalContributionSchedule({
  goal, linkedAccounts, linkedFullAccounts,
}: {
  goal: Goal;
  linkedAccounts: LinkedAccountSummary[];
  linkedFullAccounts: FinancialAccount[];
}) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [view, setView] = useState<'yearly' | 'monthly'>('yearly');

  const currencySymbol = getCurrencySymbol(goal.currency);
  const fmt = (minor: number) => `${currencySymbol}${fromMinorUnits(minor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const fmtCompact = (minor: number) => `${currencySymbol}${formatAmountCompact(fromMinorUnits(minor), goal.currency, profile?.numberSystem)}`;
  const nameById = useMemo(() => new Map(linkedAccounts.map((a) => [a.id, a.name])), [linkedAccounts]);
  // Today's already-counted lump sum per account — added to each row's own growth-only cumulative
  // (see goals.ts's projectGoalHorizonSchedule doc comment) so the table's "total so far" column
  // means the account's actual real contribution at that point in time, not just what it grew by.
  const contributedById = useMemo(() => new Map<string, number>(linkedAccounts.map((a) => [a.id, a.contributedMinor])), [linkedAccounts]);

  // Reserved (frozen, already-met) accounts are deliberately excluded by fundingSourcesForGoal —
  // their share is already fully counted in the goal's current total and will never grow further,
  // so they have nothing to contribute to a FORWARD schedule. They still show in the header summary
  // below (via linkedAccounts, which includes them) with their frozen amount as both "now" and "at
  // goal met" — just not as a column in the month/year table, which is about future growth only.
  const sources = useMemo(() => fundingSourcesForGoal(goal.id, linkedFullAccounts), [goal.id, linkedFullAccounts]);
  const currentTotalMinor = goalTotalMinor(goal);
  const remainingMinor = goal.targetAmountMinor - currentTotalMinor;
  const schedule = useMemo(
    () => (remainingMinor > 0 ? projectGoalHorizonSchedule(remainingMinor, sources) : { date: null, entries: [] }),
    [remainingMinor, sources],
  );
  const yearly = useMemo(() => aggregateScheduleByYear(schedule.entries, sources.length), [schedule.entries, sources.length]);
  const lastEntry = schedule.entries[schedule.entries.length - 1];
  const finalCumulativeById = new Map<string, number>(sources.map((s, i) => [s.id as string, lastEntry ? lastEntry.perSourceCumulativeMinor[i] : 0]));

  if (linkedAccounts.length === 0) {
    return <p className="text-xs text-text-muted text-center py-6">{t('goals.noAccountAllocationsYet')}</p>;
  }

  const formatMonthKey = (monthKey: string) => {
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  };

  const rows = view === 'yearly' ? yearly : schedule.entries;

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2">
        <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.currentVsAtGoalMet')}</p>
        {linkedAccounts.map((a) => {
          const atGoalMetMinor = remainingMinor <= 0 || a.reserved
            ? a.contributedMinor
            : schedule.date ? a.contributedMinor + (finalCumulativeById.get(a.id) || 0) : null;
          return (
            <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-bold text-on-surface">
                {a.name} <span className="text-text-muted font-normal">({a.pct}%)</span>
              </span>
              <span className="text-right shrink-0">
                <span className="block text-text-muted">{t('goals.nowLabel')} {fmt(a.contributedMinor)}</span>
                <span className="block font-bold text-success">
                  {t('goals.atGoalMetLabel')} {atGoalMetMinor != null ? fmt(atGoalMetMinor) : t('goals.projectionUnavailable')}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {sources.length === 0 ? (
        <p className="text-xs text-text-muted text-center py-4">{t('goals.scheduleNoGrowthSources')}</p>
      ) : schedule.entries.length === 0 ? (
        <p className="text-xs text-text-muted text-center py-4">{t('goals.projectionUnavailable')}</p>
      ) : (
        <>
          <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
            <button
              type="button" onClick={() => setView('yearly')}
              className={clsx('flex-1 py-1.5 rounded-lg text-xs font-bold transition-all', view === 'yearly' ? 'bg-primary text-white' : 'text-text-muted')}
            >
              {t('goals.yearlyView')}
            </button>
            <button
              type="button" onClick={() => setView('monthly')}
              className={clsx('flex-1 py-1.5 rounded-lg text-xs font-bold transition-all', view === 'monthly' ? 'bg-primary text-white' : 'text-text-muted')}
            >
              {t('goals.monthlyView')}
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-border-subtle">
                    <th className="text-left font-bold text-text-muted p-2 whitespace-nowrap">{view === 'yearly' ? t('goals.yearColumn') : t('goals.monthColumn')}</th>
                    {sources.map((s) => (
                      <th key={s.id} className="text-right font-bold text-text-muted p-2 whitespace-nowrap">{nameById.get(s.id as string) || '—'}</th>
                    ))}
                    <th className="text-right font-bold text-primary p-2 whitespace-nowrap">{t('goals.totalColumn')}</th>
                  </tr>
                  <tr className="border-b border-border-subtle text-[9px] font-normal text-text-muted">
                    <th className="p-0"></th>
                    {sources.map((s) => <th key={s.id} className="p-0 pb-1 font-normal text-right">{t('goals.addedVsTotalHint')}</th>)}
                    <th className="p-0 pb-1 font-normal text-right">{t('goals.addedVsTotalHint')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr key={idx} className="border-b border-border-subtle last:border-0">
                      <td className="p-2 font-bold text-on-surface whitespace-nowrap align-top">
                        {'year' in row ? row.year : formatMonthKey(row.monthKey)}
                      </td>
                      {sources.map((s, i) => (
                        <td key={s.id} className="p-2 text-right whitespace-nowrap align-top">
                          <span className="block text-text-muted">+{fmtCompact(row.perSourceMinor[i])}</span>
                          <span className="block text-on-surface font-bold">{fmtCompact((contributedById.get(s.id as string) || 0) + row.perSourceCumulativeMinor[i])}</span>
                        </td>
                      ))}
                      <td className="p-2 text-right whitespace-nowrap align-top">
                        <span className="block text-primary/70">+{fmtCompact(row.totalMinor)}</span>
                        <span className="block font-black text-primary">{fmtCompact(currentTotalMinor + row.cumulativeMinor)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
