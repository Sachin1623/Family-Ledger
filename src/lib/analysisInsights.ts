// Pure calculations behind the Analysis Summary "Overview" tab and its insight cards. Everything here runs
// on the expenses the screen has ALREADY loaded — no extra database reads. Amounts are plain numbers in the
// group's currency; dates are the stored "YYYY-MM-DD" strings (read by slicing, so no timezone surprises).

export interface InsightExpense {
  date: string;
  amount: number;
  category: string;
  type?: string;
  description?: string;
  groupId?: string;
}

const isIncome = (e: InsightExpense) => e.type === 'income';
const monthOf = (e: InsightExpense) => String(e.date || '').slice(0, 7);
const dayOf = (e: InsightExpense) => Number(String(e.date || '').slice(8, 10)) || 0;
const dateObj = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

export function monthKeyFor(year: number, monthIndex: number): string {
  const d = new Date(year, monthIndex, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function shiftMonthKey(key: string, delta: number): string {
  return monthKeyFor(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta);
}
export function daysInMonthKey(key: string): number {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
}

export interface MonthSummary {
  spent: number;
  income: number;
  count: number;
  byCategory: Record<string, number>;
  byDay: number[]; // index 0 = day 1
}

export function summarizeMonth(exps: InsightExpense[], key: string): MonthSummary {
  const byDay = new Array(daysInMonthKey(key)).fill(0);
  const byCategory: Record<string, number> = {};
  let spent = 0;
  let income = 0;
  let count = 0;
  for (const e of exps) {
    if (monthOf(e) !== key) continue;
    count++;
    if (isIncome(e)) {
      income += e.amount || 0;
      continue;
    }
    spent += e.amount || 0;
    byCategory[e.category] = (byCategory[e.category] || 0) + (e.amount || 0);
    const d = dayOf(e);
    if (d >= 1 && d <= byDay.length) byDay[d - 1] += e.amount || 0;
  }
  return { spent, income, count, byCategory, byDay };
}

/** Where this month is heading at the pace so far; only meaningful for the month that's still in progress. */
export function projectMonth(spent: number, key: string, today: Date): { dayOfMonth: number; days: number; projected: number } | null {
  const nowKey = monthKeyFor(today.getFullYear(), today.getMonth());
  if (key !== nowKey) return null;
  const days = daysInMonthKey(key);
  const dayOfMonth = today.getDate();
  if (dayOfMonth < 3) return { dayOfMonth, days, projected: spent }; // too early to extrapolate honestly
  return { dayOfMonth, days, projected: (spent / dayOfMonth) * days };
}

/** Day of month on which the running total is on course to pass the budget (null if it won't). */
export function budgetCrossDay(spent: number, budget: number, dayOfMonth: number, days: number): number | null {
  if (budget <= 0 || spent >= budget) return null;
  const perDay = spent / Math.max(1, dayOfMonth);
  if (perDay <= 0) return null;
  const day = Math.ceil(budget / perDay);
  return day <= days ? day : null;
}

export interface CategoryMover {
  category: string;
  thisMonth: number;
  lastMonth: number;
  delta: number;
  ratio: number | null;
}

export function categoryMovers(thisSummary: MonthSummary, lastSummary: MonthSummary): CategoryMover[] {
  const cats = new Set([...Object.keys(thisSummary.byCategory), ...Object.keys(lastSummary.byCategory)]);
  return Array.from(cats)
    .map((category) => {
      const a = thisSummary.byCategory[category] || 0;
      const b = lastSummary.byCategory[category] || 0;
      return { category, thisMonth: a, lastMonth: b, delta: a - b, ratio: b > 0 ? a / b : null };
    })
    .filter((m) => m.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

export interface Anomaly {
  expense: InsightExpense;
  typical: number;
  times: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The one entry this month that is furthest above what's normal for its own category (needs real history). */
export function findAnomaly(all: InsightExpense[], key: string): Anomaly | null {
  const byCat: Record<string, number[]> = {};
  for (const e of all) {
    if (isIncome(e) || monthOf(e) === key) continue;
    (byCat[e.category] ||= []).push(e.amount || 0);
  }
  const monthSpent = all.filter((e) => !isIncome(e) && monthOf(e) === key).reduce((s, e) => s + (e.amount || 0), 0);
  let best: Anomaly | null = null;
  for (const e of all) {
    if (isIncome(e) || monthOf(e) !== key) continue;
    const history = byCat[e.category];
    if (!history || history.length < 5) continue;
    const typical = median(history);
    if (typical <= 0) continue;
    const times = (e.amount || 0) / typical;
    if (times < 4 || (e.amount || 0) < monthSpent * 0.08) continue;
    if (!best || times > best.times) best = { expense: e, typical, times };
  }
  return best;
}

/** Average spend per weekday (Mon..Sun) over the `weeks` most recent weeks that contain data. */
export function weekdayAverages(all: InsightExpense[], today: Date, weeks = 13): number[] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weeks * 7 + 1);
  const totals = new Array(7).fill(0);
  for (const e of all) {
    if (isIncome(e) || !e.date) continue;
    const d = dateObj(e.date);
    if (d < start || d > today) continue;
    totals[(d.getDay() + 6) % 7] += e.amount || 0;
  }
  return totals.map((t) => t / weeks);
}

export interface RecurringItem {
  name: string;
  amount: number; // typical amount per occurrence
  months: number;
}

/** Same description, charged in 3+ different months at a steady amount — a subscription, rent, a fee. */
export function detectRecurring(all: InsightExpense[]): RecurringItem[] {
  const groups: Record<string, { name: string; amounts: number[]; months: Set<string> }> = {};
  for (const e of all) {
    if (isIncome(e)) continue;
    const name = (e.description || '').trim();
    if (name.length < 2) continue;
    const k = name.toLowerCase();
    const g = (groups[k] ||= { name, amounts: [], months: new Set() });
    g.amounts.push(e.amount || 0);
    g.months.add(monthOf(e));
  }
  const out: RecurringItem[] = [];
  for (const g of Object.values(groups)) {
    if (g.months.size < 3) continue;
    const m = median(g.amounts);
    if (m <= 0) continue;
    const steady = g.amounts.filter((a) => Math.abs(a - m) <= m * 0.15).length / g.amounts.length;
    // At most ~1.5 charges a month on average, and mostly the same amount — otherwise it's just a frequent habit.
    if (steady < 0.7 || g.amounts.length > g.months.size * 1.5) continue;
    out.push({ name: g.name, amount: m, months: g.months.size });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export interface Payee {
  name: string;
  total: number;
  count: number;
}

export function topPayees(exps: InsightExpense[], limit = 5): Payee[] {
  const groups: Record<string, Payee> = {};
  for (const e of exps) {
    if (isIncome(e)) continue;
    const name = (e.description || '').trim();
    if (!name) continue;
    const g = (groups[name.toLowerCase()] ||= { name, total: 0, count: 0 });
    g.total += e.amount || 0;
    g.count++;
  }
  return Object.values(groups).sort((a, b) => b.total - a.total).slice(0, limit);
}

/** Expense totals per month index (0..11) for a calendar year. */
export function yearTotals(all: InsightExpense[], year: number): number[] {
  const out = new Array(12).fill(0);
  for (const e of all) {
    if (isIncome(e) || String(e.date || '').slice(0, 4) !== String(year)) continue;
    out[Number(String(e.date).slice(5, 7)) - 1] += e.amount || 0;
  }
  return out;
}
