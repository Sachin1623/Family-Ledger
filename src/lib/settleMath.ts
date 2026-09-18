// The per-group "who owes whom" netting, extracted from Settlements.tsx so the GroupExpenses edit
// modal's "this re-opens a settled balance" warning computes balances the exact same way the
// Settlements screen does — no second, subtly-different implementation.
//
// Convention (matches Settlements.tsx:124-187): for each expense, whoever is in `paidBy` is owed
// each split participant's `amount`; a settle-up is just an ordinary expense whose split points
// the debt back the other way, so it nets out here automatically. Ids are opaque strings — a real
// uid or a placeholder participant id, both net identically.
//
// An expense can optionally have MULTIPLE payers (`expense.payers`, e.g. two people each handed
// over cash for one bill) instead of the single `paidBy` — see AddExpense.tsx's payer picker.
// `paidBy` is still always set (to the first payer) for any older code path that only reads that
// field, but netBalances() prefers `payers` when present.

// How much THIS specific member contributed to THIS expense — their own amount from
// `expense.payers` when present, the full `expense.amount` when they're the sole (paidBy) payer,
// or 0 if they weren't a payer on it at all. Used anywhere that attributes "how much did X pay"
// per person (GroupAnalysisSummary's member charts/CSV export, buildAiPrompt's per-member
// summary) — same multi-payer awareness as netBalances() below, kept as its own small function
// since those callers want one person's contribution to one expense, not a whole group's net.
export function memberContribution(expense: any, memberId: string): number {
  if (!expense || !memberId) return 0;
  if (Array.isArray(expense.payers) && expense.payers.length > 0) {
    return expense.payers.find((p: any) => p.userId === memberId)?.amount || 0;
  }
  return expense.paidBy === memberId ? (Number(expense.amount) || 0) : 0;
}

export function netBalances(expenses: any[]): Record<string, number> {
  const bal: Record<string, number> = {};
  for (const expense of expenses || []) {
    const splits = expense.splitInfo?.splits || [];
    if (splits.length === 0) continue;
    const multiPayers: { userId: string; amount: number }[] = Array.isArray(expense.payers) ? expense.payers : [];
    if (multiPayers.length > 0) {
      // Multiple payers, each credited their own real contribution — the debt a multi-payer
      // expense creates isn't naturally "owed to one specific person" the way a single-payer
      // expense is, so every split participant's consumption is debited independently of who
      // financed it; the group-level settle-up (simplifyDebts) still nets everyone out correctly
      // regardless, exactly like it already combines debts across many separate expenses today.
      for (const payer of multiPayers) {
        const amt = Number(payer.amount) || 0;
        if (!payer.userId || amt === 0) continue;
        bal[payer.userId] = (bal[payer.userId] || 0) + amt;
      }
      for (const split of splits) {
        const benefitId = split.userId;
        const amt = Number(split.amount) || 0;
        if (!benefitId || amt === 0) continue;
        bal[benefitId] = (bal[benefitId] || 0) - amt;
      }
      continue;
    }
    // Single payer — unchanged from before `payers` existed. The payer is credited exactly the
    // sum of everyone ELSE'S split cost, their own split ignored entirely (they already
    // "pre-paid" it by being the one who paid the bill) — deliberately NOT rewritten as a
    // one-payer special case of the multi-payer formula above, since that would credit the payer
    // `expense.amount` itself rather than the sum of splits; those only agree when splits sum
    // exactly to the total, which is normally true but isn't an invariant worth risking real
    // balances on for every historical expense already in production.
    const payerId = expense.paidBy;
    if (!payerId) continue;
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

// Turns a set of net balances into a minimal-transaction settle-up plan — the same greedy
// largest-ower-to-largest-receiver matching Settlements.tsx has always used inline (see its own
// comment there), extracted here so a second caller (Dashboard's expanded group card — "who
// specifically do I owe/does owe me," not just my own net total) computes it identically rather
// than risking a second, subtly-different implementation. Ids are opaque strings, same convention
// as netBalances() above; amounts are always positive (owerId owes receiverId `amount`).
export function simplifyDebts(balances: Record<string, number>): { owerId: string; receiverId: string; amount: number }[] {
  const owers = Object.entries(balances).filter(([, bal]) => bal < -0.01).sort((a, b) => a[1] - b[1]);
  const receivers = Object.entries(balances).filter(([, bal]) => bal > 0.01).sort((a, b) => b[1] - a[1]);
  const result: { owerId: string; receiverId: string; amount: number }[] = [];
  let owerIdx = 0;
  let receiverIdx = 0;
  while (owerIdx < owers.length && receiverIdx < receivers.length) {
    const [owerId, owerBal] = owers[owerIdx];
    const [receiverId, receiverBal] = receivers[receiverIdx];
    const amount = Math.min(Math.abs(owerBal), receiverBal);
    result.push({ owerId, receiverId, amount });
    owers[owerIdx][1] += amount;
    receivers[receiverIdx][1] -= amount;
    if (Math.abs(owers[owerIdx][1]) < 0.01) owerIdx++;
    if (Math.abs(receivers[receiverIdx][1]) < 0.01) receiverIdx++;
  }
  return result;
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
