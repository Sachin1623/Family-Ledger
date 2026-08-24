// Lets an amount field accept quick sums like "20+30-5" instead of just a single number.
// Only +/- are supported (deliberately no */÷, which would need operator-precedence rules
// nobody asked for). Falls back to treating the whole string as one number if it isn't a
// valid sum expression, so plain amounts keep working exactly as before. Shared by every
// amount field in the app (originally lived only in AddExpense.tsx) so they all evaluate
// "100+50" the same way.
export function evaluateAmountSum(expr: string): number | null {
  const cleaned = expr.trim();
  if (!cleaned) return null;
  if (!/^[+-]?\d+(\.\d+)?([+-]\d+(\.\d+)?)*$/.test(cleaned)) {
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  const terms: string[] = cleaned.match(/[+-]?\d+(\.\d+)?/g) || [];
  return terms.reduce((sum: number, t: string) => sum + parseFloat(t), 0);
}

// True once the expression has an internal +/- operator (not just a leading sign on the first
// number) — gates the "= 45.00" live-preview badge so it doesn't show for a plain single amount.
export function hasAmountSumOperator(expr: string): boolean {
  return /[+-]/.test(expr.trim().slice(1));
}
