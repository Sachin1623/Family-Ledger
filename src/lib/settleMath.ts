// The per-group "who owes whom" netting, extracted from Settlements.tsx so the GroupExpenses edit
// modal's "this re-opens a settled balance" warning computes balances the exact same way the
// Settlements screen does — no second, subtly-different implementation.
//
// Convention (matches Settlements.tsx:124-187): for each expense, whoever is in `paidBy` is owed
// each split participant's `amount`; a settle-up is just an ordinary expense whose split points
// the debt back the other way, so it nets out here automatically. Ids are opaque strings — a real
// uid or a placeholder participant id, both net identically.

export function netBalances(expenses: any[]): Record<string, number> {
  const bal: Record<string, number> = {};
  for (const expense of expenses || []) {
    const payerId = expense.paidBy;
    const splits = expense.splitInfo?.splits || [];
    if (!payerId || splits.length === 0) continue;
    for (const split of splits) {
      const benefitId = split.userId;
      const amt = Number(split.amount) || 0;
      if (!benefitId || benefitId === payerId || amt === 0) continue;
      bal[benefitId] = (bal[benefitId] || 0) - amt;
      bal[payerId] = (bal[payerId] || 0) + amt;
    }
  }
  return bal;
}

// Max absolute change to any single person's net balance between two expense sets, plus how many
// people move by more than a cent. Used for the informed-consent line before saving a retroactive
// split change.
export function balanceDelta(before: any[], after: any[]): { maxDelta: number; affected: number } {
  const b = netBalances(before);
  const a = netBalances(after);
  const ids = new Set([...Object.keys(b), ...Object.keys(a)]);
  let maxDelta = 0;
  let affected = 0;
  for (const id of ids) {
    const d = Math.abs((a[id] || 0) - (b[id] || 0));
    if (d > 0.01) affected += 1;
    if (d > maxDelta) maxDelta = d;
  }
  return { maxDelta, affected };
}
