import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  InsightExpense,
  summarizeMonth,
  projectMonth,
  budgetCrossDay,
  categoryMovers,
  findAnomaly,
  weekdayAverages,
  detectRecurring,
  topPayees,
  yearTotals,
  shiftMonthKey,
  daysInMonthKey,
} from '../lib/analysisInsights';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

interface CommonProps {
  /** Currency symbol + compact amount, e.g. "₹1.2L" */
  fmt: (n: number) => string;
  categoryLabel: (id: string) => string;
  categoryIcon: (id: string) => string;
}

const card = 'bg-white p-4 rounded-2xl border border-border-subtle shadow-sm';
const cardTitle = 'text-xs font-black text-primary mb-3 flex items-center justify-between gap-2';
const cardHint = 'text-[10px] font-bold text-text-muted';

const pctChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

// ───────────────────────────────────────────────────────────────────────────────────── Overview tab

export function OverviewTab({
  expenses,
  monthKey,
  onMonthChange,
  currentMonthKey,
  budget,
  hasIncomeData,
  fmt,
  categoryLabel,
  categoryIcon,
}: CommonProps & {
  /** Every loaded expense for the scope (month/category filters deliberately NOT applied — the Overview has its own month stepper). */
  expenses: InsightExpense[];
  monthKey: string;
  onMonthChange: (key: string) => void;
  currentMonthKey: string;
  budget: number | null;
  hasIncomeData: boolean;
}) {
  const today = useMemo(() => new Date(), []);
  const lastKey = shiftMonthKey(monthKey, -1);
  const cur = useMemo(() => summarizeMonth(expenses, monthKey), [expenses, monthKey]);
  const prev = useMemo(() => summarizeMonth(expenses, lastKey), [expenses, lastKey]);
  const pace = useMemo(() => projectMonth(cur.spent, monthKey, today), [cur.spent, monthKey, today]);
  const movers = useMemo(() => categoryMovers(cur, prev), [cur, prev]);
  const anomaly = useMemo(() => findAnomaly(expenses, monthKey), [expenses, monthKey]);
  const weekday = useMemo(() => weekdayAverages(expenses, today), [expenses, today]);

  const monthIdx = Number(monthKey.slice(5, 7)) - 1;
  const title = `${MONTH_NAMES[monthIdx]} ${monthKey.slice(0, 4)}`;
  const change = pctChange(cur.spent, prev.spent);
  const isCurrent = monthKey === currentMonthKey;
  const days = daysInMonthKey(monthKey);
  const elapsed = isCurrent ? today.getDate() : days;
  const perDay = elapsed > 0 ? cur.spent / elapsed : 0;
  const saved = cur.income - cur.spent;
  const barMax = Math.max(cur.spent, budget || 0, pace?.projected || 0, 1);
  const cross = isCurrent && budget ? budgetCrossDay(cur.spent, budget, elapsed, days) : null;

  // Plain-language highlights, strongest first. Each one is only added when the data really supports it.
  const insights = useMemo(() => {
    const out: { icon: string; tone: string; text: React.ReactNode }[] = [];
    const up = movers.find((m) => m.delta > 0 && m.ratio !== null && m.ratio >= 1.5 && m.delta >= cur.spent * 0.05);
    if (up) {
      const share = cur.spent > 0 ? Math.round((up.thisMonth / cur.spent) * 100) : 0;
      out.push({
        icon: categoryIcon(up.category),
        tone: 'bg-error/10',
        text: (
          <>
            <b>{categoryLabel(up.category)} is {up.ratio! >= 2 ? `${up.ratio!.toFixed(1)}×` : `up ${Math.round((up.ratio! - 1) * 100)}%`} last month</b> — {fmt(up.thisMonth)} vs {fmt(up.lastMonth)}, now {share}% of all spend.
          </>
        ),
      });
    } else if (up === undefined) {
      const newCat = movers.find((m) => m.lastMonth === 0 && m.thisMonth >= cur.spent * 0.1);
      if (newCat) {
        out.push({
          icon: categoryIcon(newCat.category),
          tone: 'bg-warning/10',
          text: (
            <>
              <b>New this month: {categoryLabel(newCat.category)}</b> — {fmt(newCat.thisMonth)} with nothing in {MONTH_NAMES[Number(lastKey.slice(5, 7)) - 1]}.
            </>
          ),
        });
      }
    }
    const down = movers.find((m) => m.delta < 0 && m.ratio !== null && m.ratio <= 0.7 && -m.delta >= prev.spent * 0.04);
    if (down) {
      out.push({
        icon: categoryIcon(down.category),
        tone: 'bg-success/10',
        text: (
          <>
            <b>{categoryLabel(down.category)} is down {Math.round((1 - down.ratio!) * 100)}%</b> — {fmt(-down.delta)} less than last month.
          </>
        ),
      });
    }
    const maxW = Math.max(...weekday);
    const total = weekday.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const idx = weekday.indexOf(maxW);
      const others = (total - maxW) / 6;
      if (others > 0 && maxW >= others * 1.5) {
        out.push({
          icon: '📅',
          tone: 'bg-primary/10',
          text: (
            <>
              <b>{DAY_NAMES[idx]} are your heaviest days</b> — about {(maxW / others).toFixed(1)}× a typical other day.
            </>
          ),
        });
      }
    }
    if (isCurrent && budget && cross) {
      out.push({ icon: '💡', tone: 'bg-warning/10', text: <><b>At this pace you'll pass your budget on {MONTH_NAMES[monthIdx].slice(0, 3)} {cross}.</b></> });
    } else if (isCurrent && budget && cur.spent >= budget) {
      out.push({ icon: '🚨', tone: 'bg-error/10', text: <><b>You've already used your whole {fmt(budget)} budget</b> — {fmt(cur.spent - budget)} over.</> });
    }
    if (out.length === 0 && cur.count > 0) {
      out.push({ icon: '✅', tone: 'bg-success/10', text: <><b>Nothing unusual this month</b> — spending is in line with the previous one.</> });
    }
    return out.slice(0, 4);
  }, [movers, weekday, cur, prev, budget, cross, isCurrent, fmt, categoryIcon, categoryLabel, lastKey, monthIdx]);

  return (
    <div className="space-y-4">
      {/* Hero */}
      <div className="rounded-[1.5rem] p-5 text-white shadow-md" style={{ background: 'linear-gradient(135deg,#06384a,#0b5a6e)' }}>
        <p className="text-[10px] font-bold uppercase tracking-widest opacity-75">{isCurrent ? `Spent in ${MONTH_NAMES[monthIdx]}` : `Spent · ${title}`}</p>
        <p className="text-3xl font-black mt-1">{fmt(cur.spent)}</p>
        {change !== null ? (
          <p className={clsx('text-xs font-bold mt-0.5', change > 0 ? 'text-red-300' : 'text-emerald-300')}>
            {change > 0 ? '▲' : '▼'} {Math.abs(change)}% vs {MONTH_NAMES[Number(lastKey.slice(5, 7)) - 1]} ({fmt(prev.spent)})
          </p>
        ) : (
          <p className="text-xs font-bold mt-0.5 opacity-75">{prev.spent === 0 && cur.spent > 0 ? `Nothing recorded in ${MONTH_NAMES[Number(lastKey.slice(5, 7)) - 1]}` : ' '}</p>
        )}
        {(budget || pace) && (
          <>
            <div className="relative h-2 rounded-full bg-white/20 mt-3">
              <div className="h-full rounded-full bg-emerald-300" style={{ width: `${Math.min(100, (cur.spent / barMax) * 100)}%` }} />
              {budget ? <div className="absolute -top-0.5 w-0.5 h-3 bg-white" style={{ left: `${Math.min(100, (budget / barMax) * 100)}%` }} /> : null}
            </div>
            <p className="text-[10px] font-semibold opacity-85 mt-1.5">
              {pace && `Day ${pace.dayOfMonth} of ${pace.days} · on pace for ≈ ${fmt(pace.projected)} by month-end`}
              {budget ? `${pace ? ' · ' : ''}budget ${fmt(budget)}${cur.spent > budget ? ` (▲ ${Math.round(((cur.spent - budget) / budget) * 100)}% over)` : ''}` : ''}
            </p>
          </>
        )}
      </div>

      {/* Quick numbers */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white rounded-2xl border border-border-subtle p-3">
          <p className="text-[9px] font-black uppercase text-text-muted">Income</p>
          <p className="text-base font-black text-success mt-0.5">{hasIncomeData ? fmt(cur.income) : '—'}</p>
        </div>
        <div className="bg-white rounded-2xl border border-border-subtle p-3">
          <p className="text-[9px] font-black uppercase text-text-muted">Saved</p>
          <p className={clsx('text-base font-black mt-0.5', !hasIncomeData ? 'text-text-muted' : saved < 0 ? 'text-error' : 'text-success')}>
            {hasIncomeData ? `${saved < 0 ? '−' : ''}${fmt(Math.abs(saved))}` : '—'}
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-border-subtle p-3">
          <p className="text-[9px] font-black uppercase text-text-muted">Per day</p>
          <p className="text-base font-black text-primary mt-0.5">{fmt(perDay)}</p>
        </div>
      </div>

      {cur.count === 0 && (
        <div className={clsx(card, 'text-center text-xs font-bold text-text-muted')}>No entries in {title} yet.</div>
      )}

      {insights.length > 0 && (
        <div className={card}>
          <p className={cardTitle}>What stands out <span className={cardHint}>worked out from your entries</span></p>
          <div className="divide-y divide-border-subtle">
            {insights.map((it, i) => (
              <div key={i} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className={clsx('w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-base', it.tone)}>{it.icon}</span>
                <p className="text-xs leading-snug text-on-surface">{it.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {anomaly && (
        <div className="flex items-start gap-2.5 bg-warning/10 border border-warning/30 rounded-2xl p-3">
          <span className="material-symbols-outlined text-[18px] text-warning shrink-0">warning</span>
          <p className="text-xs font-bold text-on-surface leading-snug">
            Unusual: <b>{fmt(anomaly.expense.amount)}</b>{anomaly.expense.description ? ` “${anomaly.expense.description}”` : ''} on {anomaly.expense.date.slice(8, 10)} {MONTH_NAMES[monthIdx].slice(0, 3)} is {Math.round(anomaly.times)}× your usual {categoryLabel(anomaly.expense.category)} entry ({fmt(anomaly.typical)}).
          </p>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────────── Trend-tab cards

export function SpendingCalendar({ expenses, monthKey, fmt, categoryLabel }: Pick<CommonProps, 'fmt' | 'categoryLabel'> & { expenses: InsightExpense[]; monthKey: string }) {
  const [openDay, setOpenDay] = useState<number | null>(null);
  const s = useMemo(() => summarizeMonth(expenses, monthKey), [expenses, monthKey]);
  const days = s.byDay.length;
  const lead = (new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1).getDay() + 6) % 7;
  const max = Math.max(...s.byDay, 1);
  const dayEntries = useMemo(
    () => (openDay ? expenses.filter((e) => e.type !== 'income' && e.date === `${monthKey}-${String(openDay).padStart(2, '0')}`) : []),
    [expenses, monthKey, openDay],
  );
  const shade = (v: number) => {
    if (v <= 0) return 'bg-surface-container/60 text-text-muted';
    const r = v / max;
    if (r > 0.75) return 'bg-emerald-700 text-white';
    if (r > 0.4) return 'bg-emerald-500 text-white';
    if (r > 0.15) return 'bg-emerald-300 text-emerald-950';
    return 'bg-emerald-100 text-emerald-900';
  };
  return (
    <div className={card}>
      <p className={cardTitle}>Spending calendar <span className={cardHint}>{MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1]} · tap a day</span></p>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DAY_LETTERS.map((l, i) => <span key={i} className="text-[9px] font-black text-text-muted">{l}</span>)}
        {Array.from({ length: lead }).map((_, i) => <span key={`p${i}`} />)}
        {Array.from({ length: days }).map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpenDay(openDay === i + 1 ? null : i + 1)}
            className={clsx('aspect-square rounded-md text-[10px] font-bold flex items-center justify-center', shade(s.byDay[i]), openDay === i + 1 && 'ring-2 ring-primary')}
          >
            {i + 1}
          </button>
        ))}
      </div>
      {openDay && (
        <div className="mt-3 pt-3 border-t border-border-subtle space-y-1.5">
          <p className="text-[11px] font-black text-primary">{openDay} {MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1]} · {fmt(s.byDay[openDay - 1])}</p>
          {dayEntries.length === 0 ? (
            <p className="text-[11px] text-text-muted font-semibold">Nothing spent this day.</p>
          ) : dayEntries.map((e, i) => (
            <div key={i} className="flex items-center justify-between text-[11px] font-semibold">
              <span className="truncate pr-2">{e.description || categoryLabel(e.category)}</span>
              <span className="font-black text-primary shrink-0">{fmt(e.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WeekdayCard({ expenses, fmt }: Pick<CommonProps, 'fmt'> & { expenses: InsightExpense[] }) {
  const today = useMemo(() => new Date(), []);
  const avg = useMemo(() => weekdayAverages(expenses, today), [expenses, today]);
  const max = Math.max(...avg);
  if (max <= 0) return null;
  const hi = avg.indexOf(max);
  const others = (avg.reduce((a, b) => a + b, 0) - max) / 6;
  return (
    <div className={card}>
      <p className={cardTitle}>Which days you spend <span className={cardHint}>average, last 3 months</span></p>
      <div className="flex items-end gap-2 h-20">
        {avg.map((v, i) => (
          <div key={i} className={clsx('flex-1 rounded-t-md', v >= max * 0.7 ? 'bg-primary' : 'bg-primary/25')} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
        ))}
      </div>
      <div className="flex gap-2 mt-1">{DAY_LETTERS.map((l, i) => <span key={i} className="flex-1 text-center text-[9px] font-bold text-text-muted">{l}</span>)}</div>
      {others > 0 && max >= others * 1.3 && (
        <p className="text-[11px] font-bold text-text-muted mt-2">{DAY_NAMES[hi]} average {fmt(max)} — {(max / others).toFixed(1)}× a typical other day</p>
      )}
    </div>
  );
}

export function RecurringCard({ expenses, monthKey, fmt }: Pick<CommonProps, 'fmt'> & { expenses: InsightExpense[]; monthKey: string }) {
  const items = useMemo(() => detectRecurring(expenses), [expenses]);
  const spent = useMemo(() => summarizeMonth(expenses, monthKey).spent, [expenses, monthKey]);
  if (items.length === 0) return null;
  const fixed = items.reduce((s, i) => s + i.amount, 0);
  return (
    <div className={card}>
      <p className={cardTitle}>Repeating costs <span className={cardHint}>spotted from your entries</span></p>
      <div className="divide-y divide-border-subtle">
        {items.slice(0, 6).map((it) => (
          <div key={it.name} className="flex items-center justify-between py-2 text-xs font-semibold first:pt-0">
            <span className="truncate pr-2">{it.name}</span>
            <span className="font-black text-primary shrink-0">{fmt(it.amount)} <span className="text-text-muted font-bold">· {it.months} months</span></span>
          </div>
        ))}
      </div>
      <p className="text-[11px] font-black text-primary mt-2">
        About {fmt(fixed)} a month is already committed{spent > 0 ? ` (${Math.min(100, Math.round((fixed / spent) * 100))}% of this month's spend)` : ''}
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────── Categories-tab cards

export function MoversCard({ expenses, monthKey, fmt, categoryLabel, categoryIcon }: CommonProps & { expenses: InsightExpense[]; monthKey: string }) {
  const rows = useMemo(() => {
    const m = categoryMovers(summarizeMonth(expenses, monthKey), summarizeMonth(expenses, shiftMonthKey(monthKey, -1)));
    return m.slice(0, 5);
  }, [expenses, monthKey]);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => Math.abs(r.delta)), 1);
  return (
    <div className={card}>
      <p className={cardTitle}>Biggest changes vs last month <span className={cardHint}>{MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1]}</span></p>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.category} className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-xl bg-surface-container flex items-center justify-center text-base shrink-0">{categoryIcon(r.category)}</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold truncate">{categoryLabel(r.category)}</p>
              <div className="h-1.5 rounded-full bg-surface-container mt-1 overflow-hidden">
                <div className={clsx('h-full rounded-full', r.delta > 0 ? 'bg-error' : 'bg-success')} style={{ width: `${(Math.abs(r.delta) / max) * 100}%` }} />
              </div>
            </div>
            <span className={clsx('text-xs font-black shrink-0', r.delta > 0 ? 'text-error' : 'text-success')}>{r.delta > 0 ? '▲' : '▼'} {fmt(Math.abs(r.delta))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PayeesCard({ expenses, fmt }: Pick<CommonProps, 'fmt'> & { expenses: InsightExpense[] }) {
  const rows = useMemo(() => topPayees(expenses, 5), [expenses]);
  if (rows.length === 0) return null;
  return (
    <div className={card}>
      <p className={cardTitle}>Where the money goes <span className={cardHint}>top descriptions</span></p>
      <div className="divide-y divide-border-subtle">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between py-2 text-xs font-semibold first:pt-0 last:pb-0">
            <span className="truncate pr-2">{r.name}</span>
            <span className="shrink-0"><b className="text-primary font-black">{fmt(r.total)}</b> <span className="text-text-muted font-bold">· {r.count}×</span></span>
          </div>
        ))}
      </div>
      <p className="text-[10px] font-bold text-text-muted mt-2">Grouped by what you typed as the description (receipts you share fill this in automatically).</p>
    </div>
  );
}

export function YearGlance({ expenses, year, fmt }: Pick<CommonProps, 'fmt'> & { expenses: InsightExpense[]; year: number }) {
  const totals = useMemo(() => yearTotals(expenses, year), [expenses, year]);
  const last = useMemo(() => yearTotals(expenses, year - 1), [expenses, year]);
  const nowMonth = new Date().getFullYear() === year ? new Date().getMonth() : 11;
  const shown = totals.slice(0, nowMonth + 1);
  const max = Math.max(...shown, 1);
  const nonZero = shown.filter((v) => v > 0);
  if (nonZero.length === 0) return null;
  const avg = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
  const top = shown.indexOf(Math.max(...shown));
  const sameLast = last[nowMonth];
  return (
    <div className={card}>
      <p className={cardTitle}>Year at a glance <span className={cardHint}>{year}</span></p>
      <div className="flex items-end gap-1.5 h-16">
        {shown.map((v, i) => (
          <div key={i} className={clsx('flex-1 rounded-t-md', i === top ? 'bg-primary' : 'bg-primary/25')} style={{ height: `${Math.max(3, (v / max) * 100)}%` }} />
        ))}
      </div>
      <div className="flex gap-1.5 mt-1">{shown.map((_, i) => <span key={i} className="flex-1 text-center text-[9px] font-bold text-text-muted">{MONTH_SHORT[i]}</span>)}</div>
      <p className="text-[11px] font-bold text-text-muted mt-2">
        Monthly average {fmt(avg)} · highest {MONTH_NAMES[top]}{sameLast > 0 ? ` · same month last year ${fmt(sameLast)}` : ''}
      </p>
    </div>
  );
}
