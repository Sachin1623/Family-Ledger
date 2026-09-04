// Net savings (income - spend) for a given month, bucketed by each contributing group's OWN
// currency — a user's groups aren't necessarily all the same currency, so this deliberately does
// NOT collapse to one number itself; see src/lib/fx.ts's convertBucketsToCurrency for turning this
// into one real total once a target currency is chosen. Shared by GoalsHub.tsx's live "this
// month" figure and its own catch-up walk-back over past months, so both compute it identically.
export interface ExpenseLike {
  date?: string;
  type?: string;
  amount?: number;
  groupId?: string;
}

export function computeNetSavingsBuckets(
  expenses: ExpenseLike[],
  monthKey: string,
  groupCurrencyByGroupId: Record<string, string>,
): Record<string, number> {
  const buckets: Record<string, number> = {};
  expenses.forEach((exp) => {
    if (typeof exp.date !== 'string' || !exp.date.startsWith(monthKey)) return;
    const currency = (exp.groupId && groupCurrencyByGroupId[exp.groupId]) || 'INR';
    const delta = exp.type === 'income' ? exp.amount || 0 : -(exp.amount || 0);
    buckets[currency] = (buckets[currency] || 0) + delta;
  });
  return buckets;
}
