import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { Goal, GoalLedgerEntry, goalHorizonDate, goalTargetReachedAt, goalTotalMinor, fromMinorUnits, decryptGoalsList, decryptLedgerEntries } from '../lib/goals';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';

// Reports & Timeline (Horizon View) — a chronological ladder of every active goal's projected
// completion, plus total accumulated + total-still-targeted wealth across every one of the
// user's own goals (archived ones excluded, same reasoning as everywhere else this session
// treats "archived" as out of the active picture but never actually gone). Goals are user-level,
// so this is always "my" reports — not scoped to any one group. If goals use different
// currencies, the aggregate totals below display in whichever currency the FIRST goal uses
// (a simplification — this app has no cross-currency conversion anywhere).
export default function GoalReports({ embedded = false }: { embedded?: boolean } = {}) {
  const { user, profile } = useAuth();
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
      .map((g) => {
        const ledger = ledgersByGoal.get(g.id) || [];
        return { goal: g, projected: goalHorizonDate(g, ledger, accounts), reachedDate: goalTargetReachedAt(g, ledger) };
      })
      .sort((a, b) => {
        const aDate = a.reachedDate || a.projected;
        const bDate = b.reachedDate || b.projected;
        if (!aDate && !bDate) return 0;
        if (!aDate) return 1;
        if (!bDate) return -1;
        return aDate.localeCompare(bDate);
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
        .map(({ goal, projected, reachedDate }) => {
          // A goal already at/past its target plots at the date it actually got there, never at
          // the (now-irrelevant) forward projection or the originally-aimed-for target date.
          const dateStr = reachedDate || projected || goal.targetDate;
          if (!dateStr) return null;
          // Same "how far off target" comparison as the Horizon View list and GoalsHub's own goal
          // cards — only meaningful when there's a real target date AND a real projection to
          // weigh it against; a goal already reached has nothing left to compare (it's done).
          const monthsBehindTarget = !reachedDate && goal.targetDate && projected
            ? (() => {
                const [ty, tm] = goal.targetDate.split('-').map(Number);
                const [py, pm] = projected.split('-').map(Number);
                return (py - ty) * 12 + (pm - tm);
              })()
            : null;
          return { goal, dateStr, isProjected: !!projected, isReached: !!reachedDate, monthsBehindTarget };
        })
        .filter((m): m is { goal: Goal; dateStr: string; isProjected: boolean; isReached: boolean; monthsBehindTarget: number | null } => !!m)
        .sort((a, b) => a.dateStr.localeCompare(b.dateStr)),
    [horizon],
  );
  const chartRange = useMemo(() => {
    if (chartMarkers.length === 0) return null;
    const currentYear = new Date().getFullYear();
    const years = chartMarkers.map((m) => Number(m.dateStr.slice(0, 4)));
    const minYear = currentYear;
    // A year of breathing room past the furthest goal keeps its marker off the card's right edge.
    // No shared tick scale anymore — each goal shows its own exact year under its own dot instead
    // (see the per-marker year labels in the chart render below).
    const maxYear = Math.max(currentYear + 1, ...years) + 1;
    return { minYear, maxYear };
  }, [chartMarkers]);
  const yearPct = (dateStr: string): number => {
    if (!chartRange) return 0;
    const [y, m, d] = dateStr.split('-').map(Number);
    const frac = y + (m - 1) / 12 + (d - 1) / 365;
    return Math.min(100, Math.max(0, ((frac - chartRange.minYear) / (chartRange.maxYear - chartRange.minYear)) * 100));
  };
  // Fixed 3-layer cycle, not a distance-based packer: goal 1 -> row 0, goal 2 -> row 1, goal 3 ->
  // row 2, goal 4 -> row 0 again, and so on (chartMarkers is already in date/pct order). A greedy
  // "only split rows when actually close together" packer still let two-close-but-not-close-enough
  // markers land on the same row and visually crowd each other — cycling through 3 fixed layers
  // unconditionally guarantees any two ADJACENT-in-order goals are always at least 2 rows apart,
  // which is what actually stopped the crowding.
  const CHART_ROW_COUNT = 3;
  const positionedMarkers = useMemo(() => {
    return chartMarkers.map((m, i) => ({ ...m, pct: yearPct(m.dateStr), row: i % CHART_ROW_COUNT }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMarkers, chartRange]);
  const chartMaxRow = useMemo(() => positionedMarkers.reduce((max, m) => Math.max(max, m.row), 0), [positionedMarkers]);
  // Same greedy row-packing as the name labels above, applied separately to the per-goal YEAR
  // labels below the axis — two goals close enough to share a row up top can still be close
  // enough that "2026" and "2027" render on top of each other down here, garbling into something
  // like "20267". A much smaller gap works for these (four narrow digits vs. a 2-line name), but
  // the principle — open another row rather than ever letting two labels collide — is identical.
  const MIN_YEAR_GAP_PCT = 9;
  const positionedYears = useMemo(() => {
    const lastPctByRow: number[] = [];
    return positionedMarkers.map((m) => {
      let row = 0;
      while (lastPctByRow[row] !== undefined && m.pct - lastPctByRow[row] < MIN_YEAR_GAP_PCT) row += 1;
      lastPctByRow[row] = m.pct;
      return { ...m, yearRow: row };
    });
  }, [positionedMarkers]);
  const chartMaxYearRow = useMemo(() => positionedYears.reduce((max, m) => Math.max(max, m.yearRow), 0), [positionedYears]);
  // Each row of labels/icons takes this much vertical space; the axis sits right below however
  // many rows this chart actually ended up needing, and the per-goal year labels sit just under
  // that (in their own possibly-multi-row stack) — so the whole chart's height flexes with the
  // data instead of being a fixed guess.
  const CHART_ROW_HEIGHT = 60;
  const YEAR_ROW_HEIGHT = 14;
  const chartAxisTop = 12 + (chartMaxRow + 1) * CHART_ROW_HEIGHT;
  const chartHeight = chartAxisTop + 16 + (chartMaxYearRow + 1) * YEAR_ROW_HEIGHT;
  // A label centered on its marker (translateX(-50%)) runs off the card at either end of the
  // axis — this anchors it left/center/right depending on how close to the edge it sits, so the
  // nearest and furthest goals' names stay fully inside the card instead of clipping.
  const markerAnchor = (pct: number): string => (pct < 10 ? 'translateX(0)' : pct > 90 ? 'translateX(-100%)' : 'translateX(-50%)');
  const markerLeftAlign = (pct: number): 'left' | 'right' | 'center' => (pct < 10 ? 'left' : pct > 90 ? 'right' : 'center');
  // Dot/line color reflects on-track vs. behind schedule when there's a real target date to
  // compare against (same threshold as GoalsHub's own goal cards and the Horizon View list below);
  // otherwise falls back to the original filled-vs-hollow "projected vs. target-only" distinction.
  const markerStatus = (m: { isProjected: boolean; isReached: boolean; monthsBehindTarget: number | null }): { dot: string; line: string } => {
    if (m.isReached) return { dot: 'bg-success', line: 'bg-success/60' };
    if (m.monthsBehindTarget !== null) {
      return m.monthsBehindTarget <= 0 ? { dot: 'bg-success', line: 'bg-success/60' } : { dot: 'bg-warning', line: 'bg-warning/60' };
    }
    return m.isProjected ? { dot: 'bg-primary', line: 'bg-primary/60' } : { dot: 'bg-white border-primary/40', line: 'bg-border-subtle' };
  };

  const totalAccumulatedMinor = reportableGoals.reduce((s, g) => s + goalTotalMinor(g), 0);
  const totalTargetMinor = reportableGoals.reduce((s, g) => s + g.targetAmountMinor, 0);
  const completedCount = reportableGoals.filter((g) => g.status === 'completed').length;

  return (
    <div className={embedded ? 'space-y-5' : 'p-4 md:p-8 max-w-2xl mx-auto space-y-5 pb-24'}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-primary">{t('goals.reportsTitle')}</h1>
          <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-text-muted">
          {t('goals.totalAccumulated')} <span className="text-success font-black">{currencySymbol}{formatAmountCompact(fromMinorUnits(totalAccumulatedMinor), reportableGoals[0]?.currency, profile?.numberSystem)}</span>
        </span>
        <span className="text-xs font-bold text-text-muted text-right">
          {t('goals.totalTargeted')} <span className="text-primary font-black">{currencySymbol}{formatAmountCompact(fromMinorUnits(totalTargetMinor), reportableGoals[0]?.currency, profile?.numberSystem)}</span>
        </span>
      </div>

      {completedCount > 0 && (
        <p className="text-xs font-bold text-success text-center">{t('goals.completedCount', { count: completedCount })}</p>
      )}

      {chartRange && (
        <div className="rounded-2xl border border-primary-container/20 shadow-sm p-4 pt-3 space-y-2 bg-gradient-to-br from-primary-container/10 via-white to-success/10 overflow-hidden">
          <h2 className="text-sm font-bold text-primary">{t('goals.goalHorizonChart')}</h2>
          <div className="relative" style={{ height: chartHeight }}>
            {positionedMarkers.map((m) => {
              const rowTop = 12 + m.row * CHART_ROW_HEIGHT;
              const NAME_HEIGHT = 24; // up to 2 clamped lines
              const ICON_HEIGHT = 24;
              const iconTop = rowTop + NAME_HEIGHT + 2;
              const lineTop = iconTop + ICON_HEIGHT;
              return (
                // Two separately-positioned pieces, not one shared anchored column: the NAME can
                // shift left/right (markerAnchor) so long text never clips off the card's edge,
                // but the ICON + connecting LINE always sit dead-centered on the marker's true pct
                // (translateX(-50%), unconditionally) — exactly matching the dot below. Sharing one
                // anchored 100px-wide box used to center the icon WITHIN that box instead of over
                // the actual data point whenever a marker sat near either edge (where the box's
                // own anchor becomes left/right-aligned to keep the text on-screen), which is what
                // made the connecting line — and the icon above it — visibly drift away from its
                // own dot.
                <React.Fragment key={m.goal.id}>
                  <div
                    className={clsx(
                      'absolute text-[9px] font-bold text-on-surface leading-tight line-clamp-2 cursor-pointer hover:text-primary',
                      markerLeftAlign(m.pct) === 'left' ? 'text-left' : markerLeftAlign(m.pct) === 'right' ? 'text-right' : 'text-center',
                    )}
                    style={{ left: `${m.pct}%`, top: rowTop, width: 100, transform: markerAnchor(m.pct) }}
                    onClick={() => navigate(`/goals/${m.goal.id}?from=reports`)}
                  >
                    {m.goal.name}
                  </div>
                  <div
                    className="absolute flex flex-col items-center cursor-pointer group"
                    style={{ left: `${m.pct}%`, top: iconTop, transform: 'translateX(-50%)' }}
                    onClick={() => navigate(`/goals/${m.goal.id}?from=reports`)}
                  >
                    <span className="text-xl leading-none group-hover:scale-110 transition-transform">{m.goal.icon || '🎯'}</span>
                    <div
                      className={clsx('w-[3px] rounded-full mt-0.5', markerStatus(m).line)}
                      style={{ height: Math.max(0, chartAxisTop - lineTop) }}
                    />
                  </div>
                </React.Fragment>
              );
            })}
            {/* Axis line + dots */}
            <div className="absolute left-0 right-0 h-px bg-primary-container/25" style={{ top: chartAxisTop }} />
            {positionedMarkers.map((m) => (
              <span
                key={`dot-${m.goal.id}`}
                className={clsx('absolute w-2 h-2 rounded-full border-2 border-white shadow', markerStatus(m).dot)}
                style={{ left: `${m.pct}%`, top: chartAxisTop - 4, transform: 'translateX(-50%)' }}
              />
            ))}
            {/* Each goal's own year, directly under its dot — not a generic shared axis scale, so
                it always reads exactly what year THIS goal lands in, never a nearby rounded tick.
                Anchored the same edge-safe way as the name label (never plain center-anchored) so
                the furthest-right goal's year isn't clipped off the card, and dropped into
                whichever row positionedYears assigned it so two close-together years never
                overlap into unreadable digits. */}
            {positionedYears.map((m) => (
              <span
                key={`year-${m.goal.id}`}
                className="absolute text-[10px] font-bold text-text-muted whitespace-nowrap"
                style={{ left: `${m.pct}%`, top: chartAxisTop + 10 + m.yearRow * YEAR_ROW_HEIGHT, transform: markerAnchor(m.pct) }}
              >
                {m.dateStr.slice(0, 4)}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-success inline-block" />{t('goals.chartLegendCompleted')}</span>
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-success inline-block" />{t('goals.onTrack')}</span>
            <span className="flex items-center gap-1 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-full bg-warning inline-block" />{t('goals.chartLegendBehind')}</span>
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
              {horizon.map(({ goal, projected, reachedDate }) => {
                // Same "how far off target" reasoning as GoalsHub.tsx's own goal cards — only
                // shown when there's a real target date AND a real projection to compare it to;
                // a goal already at/past target has nothing left to compare (it's done).
                const monthsBehindTarget = !reachedDate && goal.targetDate && projected
                  ? (() => {
                      const [ty, tm] = goal.targetDate.split('-').map(Number);
                      const [py, pm] = projected.split('-').map(Number);
                      return (py - ty) * 12 + (pm - tm);
                    })()
                  : null;
                return (
                  <div key={goal.id} className="relative cursor-pointer" onClick={() => navigate(`/goals/${goal.id}?from=reports`)}>
                    <span className={clsx('absolute -left-6 top-1 w-4 h-4 rounded-full border-2 border-white shadow', reachedDate ? 'bg-success' : projected ? 'bg-primary' : 'bg-border-subtle')} />
                    <div className="bg-white rounded-xl border border-border-subtle shadow-sm p-3 flex items-center gap-3">
                      <span className="text-xl shrink-0">{goal.icon || '🎯'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-on-surface truncate">{goal.name}</p>
                        <p className="text-[11px] text-text-muted flex items-center gap-1">
                          {reachedDate
                            ? t('goals.metOn', { date: reachedDate })
                            : (projected ? t('goals.projectedMet', { date: projected }) : t('goals.projectionUnavailable'))}
                          {reachedDate && (
                            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-black shrink-0 bg-success/10 text-success">
                              {t('goals.statusCompleted')}
                            </span>
                          )}
                          {monthsBehindTarget !== null && (
                            <span className={clsx(
                              'px-1.5 py-0.5 rounded-full text-[9px] font-black shrink-0',
                              monthsBehindTarget <= 0 ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
                            )}>
                              {monthsBehindTarget <= 0
                                ? (monthsBehindTarget <= -1 ? t('goals.aheadOfTarget', { months: Math.abs(monthsBehindTarget) }) : t('goals.onTrack'))
                                : t('goals.behindTarget', { months: monthsBehindTarget })}
                            </span>
                          )}
                        </p>
                      </div>
                      <span className="text-xs font-bold text-primary shrink-0">
                        {getCurrencySymbol(goal.currency)}{formatAmountCompact(fromMinorUnits(Math.max(0, goal.targetAmountMinor - goalTotalMinor(goal))), goal.currency, profile?.numberSystem)} {t('goals.toGo')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
