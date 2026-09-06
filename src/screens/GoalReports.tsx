import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { Goal, GoalLedgerEntry, goalHorizonDate, goalTotalMinor, fromMinorUnits, decryptGoalsList, decryptLedgerEntries } from '../lib/goals';
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
  // Greedy row-packing, not a hard 2-row alternation: for each marker (already in date order), it
  // goes in the LOWEST row whose most-recently-placed marker is far enough away (in %) that their
  // 2-line-clamped name labels can't collide. A fixed 2-row toggle could still overlap a THIRD
  // goal landing close to both of the first two (it just cycles back to row 0 again); this instead
  // opens as many rows as it actually needs — the chart grows taller to fit them (see
  // CHART_ROW_HEIGHT below) rather than ever letting two labels sit on top of each other.
  const MIN_MARKER_GAP_PCT = 16;
  const positionedMarkers = useMemo(() => {
    const lastPctByRow: number[] = [];
    return chartMarkers.map((m) => {
      const pct = yearPct(m.dateStr);
      let row = 0;
      while (lastPctByRow[row] !== undefined && pct - lastPctByRow[row] < MIN_MARKER_GAP_PCT) row += 1;
      lastPctByRow[row] = pct;
      return { ...m, pct, row };
    });
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

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.totalAccumulated')}</p>
          <p className="text-lg font-black text-success mt-1">{currencySymbol}{formatAmountCompact(fromMinorUnits(totalAccumulatedMinor), reportableGoals[0]?.currency, profile?.numberSystem)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.totalTargeted')}</p>
          <p className="text-lg font-black text-primary mt-1">{currencySymbol}{formatAmountCompact(fromMinorUnits(totalTargetMinor), reportableGoals[0]?.currency, profile?.numberSystem)}</p>
        </div>
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
                    style={{ height: Math.max(0, chartAxisTop - rowTop - blockHeight), marginLeft: markerLeftAlign(m.pct) === 'left' ? 2 : markerLeftAlign(m.pct) === 'right' ? -2 : 0 }}
                  />
                </div>
              );
            })}
            {/* Axis line + dots */}
            <div className="absolute left-0 right-0 h-px bg-primary-container/25" style={{ top: chartAxisTop }} />
            {positionedMarkers.map((m) => (
              <span
                key={`dot-${m.goal.id}`}
                className={clsx('absolute w-2 h-2 rounded-full border-2 border-white shadow', m.isProjected ? 'bg-primary' : 'bg-white border-primary/40')}
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
                      {getCurrencySymbol(goal.currency)}{formatAmountCompact(fromMinorUnits(goal.targetAmountMinor - goalTotalMinor(goal)), goal.currency, profile?.numberSystem)} {t('goals.toGo')}
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
