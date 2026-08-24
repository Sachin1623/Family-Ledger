// Shared budget-status color tiers, used on the group tile (Dashboard) and the budget card
// (ManageGroup): plain red/amber/green — green under 70% spent, amber 70-100%, red over 100%.
// Previously had a fourth "blue" tier for 90-100%; folded into amber for a standard RAG scheme.
export interface BudgetStatus {
  percent: number;
  tier: 'green' | 'amber' | 'red';
  bgClass: string;
  textClass: string;
  barClass: string;
}

export function getBudgetStatus(spend: number, budgetAmount: number): BudgetStatus {
  const percent = budgetAmount > 0 ? (spend / budgetAmount) * 100 : 0;
  if (percent > 100) {
    return { percent, tier: 'red', bgClass: 'bg-error/10', textClass: 'text-error', barClass: 'bg-error' };
  }
  if (percent >= 70) {
    return { percent, tier: 'amber', bgClass: 'bg-amber-500/10', textClass: 'text-amber-600', barClass: 'bg-amber-500' };
  }
  return { percent, tier: 'green', bgClass: 'bg-success/10', textClass: 'text-success', barClass: 'bg-success' };
}
