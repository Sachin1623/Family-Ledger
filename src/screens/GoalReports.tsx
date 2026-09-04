import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { Goal, GoalLedgerEntry, goalHorizonDate, goalTotalMinor, fromMinorUnits, decryptGoalsList, decryptLedgerEntries } from '../lib/goals';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';

// Reports & Timeline (Horizon View) — a chronological ladder of every active goal's projected
// completion, plus total accumulated + total-still-targeted wealth across every one of the
// user's own goals (archived ones excluded, same reasoning as everywhere else this session
// treats "archived" as out of the active picture but never actually gone). Goals are user-level,
// so this is always "my" reports — not scoped to any one group. If goals use different
// currencies, the aggregate totals below display in whichever currency the FIRST goal uses
// (a simplification — this app has no cross-currency conversion anywhere).
export default function GoalReports() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [goalsValue] = useCollection(user ? query(collection(db, 'goals'), where('userId', '==', user.uid)) : null);
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = goalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setAllGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt goals:', err));
    return () => { cancelled = true; };
  }, [goalsValue]);
  const reportableGoals = allGoals.filter((g) => g.status !== 'archived');
  const currencySymbol = getCurrencySymbol(reportableGoals[0]?.currency);

  const [ledgersByGoal, setLedgersByGoal] = useState<Map<string, GoalLedgerEntry[]>>(new Map());
  useEffect(() => {
    if (reportableGoals.length === 0) { setLedgersByGoal(new Map()); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        reportableGoals.map(async (g) => {
          const snap = await getDocs(collection(db, 'goals', g.id, 'ledger'));
          const raw = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
          return [g.id, await decryptLedgerEntries(g.id, raw)] as const;
        }),
      );
      if (!cancelled) setLedgersByGoal(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [reportableGoals.map((g) => g.id).join(',')]);

  // Every one of the user's own accounts, decrypted — feeds goalHorizonDate() below with each
  // linked account's interest rate/compounding and SIP schedule, not just its balance.
  const [accountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('userId', '==', user.uid)) : null);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = accountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raw).then((decrypted) => { if (!cancelled) setAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [accountsValue]);

  const horizon = useMemo(() => {
    // Cash Savings has no target and no projection (see goalProgressPct/goalHorizonDate — both
    // already resolve to "nothing" for a target-0 goal), so it'd only clutter this timeline. Its
    // balance still counts toward Total Accumulated below — it's real money, just untargeted.
    return reportableGoals
      .filter((g) => g.status === 'active' && !g.isCashHolding)
      .map((g) => ({ goal: g, projected: goalHorizonDate(g, ledgersByGoal.get(g.id) || [], accounts) }))
      .sort((a, b) => {
        if (!a.projected && !b.projected) return 0;
        if (!a.projected) return 1;
        if (!b.projected) return -1;
        return a.projected.localeCompare(b.projected);
      });
  }, [reportableGoals, ledgersByGoal, accounts]);

  // --- "Goal Horizon" chart: a single year-axis timeline with every placeable goal's icon plotted
  // at its own completion date. A goal with a real projected date (goalHorizonDate) plots there,
  // solid-dotted; one with no projection yet but a user-set targetDate falls back to THAT instead
  // (hollow-dotted, so it visually reads as "aimed for," not "calculated") — same idea as the
  // vertical Horizon View list below, just laid out on a real timeline instead of a plain ladder.
  // A goal with neither simply can't be placed and is left off the chart (still shown below).
  const chartMarkers = useMemo(
    () =>
      horizon
        .map(({ goal, projected }) => {
          const dateStr = projected || goal.targetDate;
          return dateStr ? { goal, dateStr, isProjected: !!projected } : null;
        })
        .filter((m): m is { goal: Goal; dateStr: string; isProjected: boolean } => !!m)
        .sort((a, b) => a.dateStr.localeCompare(b.dateStr)),
    [horizon],
  );
  const chartRange = useMemo(() => {
    if (chartMarkers.length === 0) return null;
    const currentYear = new Date().getFullYear();
    const years = chartMarkers.map((m) => Number(m.dateStr.slice(0, 4)));
    const minYear = currentYear;
    // A year of breathing room past the furthest goal — deliberately NOT force-labeled with its
    // own tick (that used to render a crowded, near-duplicate tick right next to the real last
    // one, e.g. "2046 2047"): the regular step-spaced ticks below are enough, this just keeps the
    // furthest marker off the card's right edge.
    const maxYear = Math.max(currentYear + 1, ...years) + 1;
    const span = maxYear - minYear;
    const step = span <= 8 ? 1 : span <= 16 ? 2 : span <= 40 ? 5 : 10;
    const ticks: number[] = [];
    for (let y = minYear; y <= maxYear; y += step) ticks.push(y);
    return { minYear, maxYear, ticks };
  }, [chartMarkers]);
  const yearPct = (dateStr: string): number => {
    if (!chartRange) return 0;
    const [y, m, d] = dateStr.split('-').map(Number);
    const frac = y + (m - 1) / 12 + (d - 1) / 365;
    return Math.min(100, Math.max(0, ((frac - chartRange.minYear) / (chartRange.maxYear - chartRange.minYear)) * 100));
  };
  // Alternates each marker between two label rows whenever it lands close (in %) to the previous
  // one, so two goals with nearby dates don't render their name labels on top of each other.
  const positionedMarkers = useMemo(() => {
    let lastPct = -100;
    let row: 0 | 1 = 0;
    return chartMarkers.map((m) => {
      const pct = yearPct(m.dateStr);
      row = pct - lastPct < 14 ? (row === 0 ? 1 : 0) : 0;
      lastPct = pct;
      return { ...m, pct, row };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMarkers, chartRange]);
  // A label centered on its marker (translateX(-50%)) runs off the card at either end of the
  // axis — this anchors it left/center/right depending on how close to the edge it sits, so the
  // nearest and furthest goals' names stay fully inside the card instead of clipping.
  const markerAnchor = (pct: number): string => (pct < 10 ? 'translateX(0)' : pct > 90 ? 'translateX(-100%)' : 'translateX(-50%)');
  const markerLeftAlign = (pct: number): 'left' | 'right' | 'center' => (pct < 10 ? 'left' : pct > 90 ? 'right' : 'center');

  const totalAccumulatedMinor = reportableGoals.reduce((s, g) => s + goalTotalMinor(g), 0);
  const totalTargetMinor = reportableGoals.reduce((s, g) => s + g.targetAmountMinor, 0);
  const completedCount = reportableGoals.filter((g) => g.status === 'completed').length;

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-5 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-primary">{t('goals.reportsTitle')}</h1>
        <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
          <span className="material-symbols-outlined text-[20px] block">close</span>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.totalAccumulated')}</p>
          <p className="text-lg font-black text-success mt-1">{currencySymbol}{fromMinorUnits(totalAccumulatedMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.totalTargeted')}</p>
          <p className="text-lg font-black text-primary mt-1">{currencySymbol}{fromMinorUnits(totalTargetMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
      </div>

      {completedCount > 0 && (
        <p className="text-xs font-bold text-success text-center">{t('goals.completedCount', { count: completedCount })}</p>
      )}

      {chartRange && (
        <div className="rounded-2xl border border-primary-container/20 shadow-sm p-4 pt-3 space-y-2 bg-gradient-to-br from-primary-container/10 via-white to-success/10 overflow-hidden">
          <h2 className="text-sm font-bold text-primary">{t('goals.goalHorizonChart')}</h2>
          <div className="relative" style={{ height: 176 }}>
            {positionedMarkers.map((m) => {
              const rowTop = m.row === 1 ? 2 : 74;
              const blockHeight = 52; // 2-line label + gap + icon
              return (
                <div
                  key={m.goal.id}
                  className="absolute flex flex-col items-center cursor-pointer group"
                  style={{ left: `${m.pct}%`, top: rowTop, width: 100, transform: markerAnchor(m.pct) }}
                  onClick={() => navigate(`/goals/${m.goal.id}`)}
                >
                  <span
                    className={clsx(
                      'text-[9px] font-bold text-on-surface leading-tight line-clamp-2 w-full group-hover:text-primary',
                      markerLeftAlign(m.pct) === 'left' ? 'text-left' : markerLeftAlign(m.pct) === 'right' ? 'text-right' : 'text-center',
                    )}
                  >
                    {m.goal.name}
                  </span>
                  <span className="text-xl leading-none mt-1">{m.goal.icon || '🎯'}</span>
                  <div
                    className={clsx('w-px mt-0.5', m.isProjected ? 'bg-primary/40' : 'bg-border-subtle')}
                    style={{ height: 130 - rowTop - blockHeight, marginLeft: markerLeftAlign(m.pct) === 'left' ? 2 : markerLeftAlign(m.pct) === 'right' ? -2 : 0 }}
                  />
                </div>
              );
            })}
            {/* Axis line + dots */}
            <div className="absolute left-0 right-0 h-px bg-primary-container/25" style={{ top: 130 }} />
            {positionedMarkers.map((m) => (
              <span
                key={`dot-${m.goal.id}`}
                className={clsx('absolute w-2 h-2 rounded-full border-2 border-white shadow', m.isProjected ? 'bg-primary' : 'bg-white border-primary/40')}
                style={{ left: `${m.pct}%`, top: 126, transform: 'translateX(-50%)' }}
              />
            ))}
            {/* Year ticks */}
            {chartRange.ticks.map((y) => (
              <span
                key={y}
                className="absolute text-[10px] font-bold text-text-muted"
                style={{ left: `${yearPct(`${y}-01-01`)}%`, top: 140, transform: 'translateX(-50%)' }}
              >
                {y}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-1">
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-primary inline-block" />{t('goals.chartLegendProjected')}</span>
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-white border-2 border-primary/40 inline-block" />{t('goals.chartLegendTargetDate')}</span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-primary px-1">{t('goals.horizonView')}</h2>
        {horizon.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-8">{t('goals.noActiveGoalsForAllocation')}</p>
        ) : (
          <div className="relative pl-6">
            <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-border-subtle" />
            <div className="space-y-4">
              {horizon.map(({ goal, projected }) => (
                <div key={goal.id} className="relative cursor-pointer" onClick={() => navigate(`/goals/${goal.id}`)}>
                  <span className={clsx('absolute -left-6 top-1 w-4 h-4 rounded-full border-2 border-white shadow', projected ? 'bg-primary' : 'bg-border-subtle')} />
                  <div className="bg-white rounded-xl border border-border-subtle shadow-sm p-3 flex items-center gap-3">
                    <span className="text-xl shrink-0">{goal.icon || '🎯'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-on-surface truncate">{goal.name}</p>
                      <p className="text-[11px] text-text-muted">
                        {projected ? t('goals.projectedMet', { date: projected }) : t('goals.projectionUnavailable')}
                      </p>
                    </div>
                    <span className="text-xs font-bold text-primary shrink-0">
                      {getCurrencySymbol(goal.currency)}{fromMinorUnits(goal.targetAmountMinor - goalTotalMinor(goal)).toLocaleString(undefined, { maximumFractionDigits: 0 })} {t('goals.toGo')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
