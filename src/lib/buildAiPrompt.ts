interface PromptExpense {
  amount: number;
  category: string;
  paidBy: string;
  date: string;
}

interface PromptMember {
  userId: string;
  displayName: string;
}

// Builds a data-rich, specific prompt (not just a data dump) so whichever AI assistant the
// user shares it with can give genuinely useful analysis rather than a generic summary.
export function buildGroupAiPrompt(params: {
  groupName: string;
  currencySymbol: string;
  expenses: PromptExpense[];
  members: PromptMember[];
  categoryNames: Record<string, string>;
}): string {
  const { groupName, currencySymbol, expenses, members, categoryNames } = params;

  const totalSpend = expenses.reduce((sum, e) => sum + e.amount, 0);
  const memberName = (uid: string) => members.find((m) => m.userId === uid)?.displayName || 'Unknown';

  const byCategory: Record<string, number> = {};
  expenses.forEach((e) => {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });
  const categoryLines = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `- ${categoryNames[cat] || cat}: ${currencySymbol}${amt.toFixed(2)} (${((amt / totalSpend) * 100 || 0).toFixed(0)}%)`)
    .join('\n');

  const byMember: Record<string, number> = {};
  expenses.forEach((e) => {
    byMember[e.paidBy] = (byMember[e.paidBy] || 0) + e.amount;
  });
  const memberLines = Object.entries(byMember)
    .sort((a, b) => b[1] - a[1])
    .map(([uid, amt]) => `- ${memberName(uid)}: ${currencySymbol}${amt.toFixed(2)}`)
    .join('\n');

  const dates = expenses.map((e) => e.date).filter(Boolean).sort();
  const dateRange = dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : 'no dated entries';

  // Last 30 days vs the 30 days before that, to give the AI a trend signal to react to.
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const last30 = expenses.filter((e) => now - new Date(e.date).getTime() <= THIRTY_DAYS);
  const prev30 = expenses.filter((e) => {
    const age = now - new Date(e.date).getTime();
    return age > THIRTY_DAYS && age <= THIRTY_DAYS * 2;
  });
  const last30Total = last30.reduce((s, e) => s + e.amount, 0);
  const prev30Total = prev30.reduce((s, e) => s + e.amount, 0);

  return `I'm sharing spending data for my "${groupName}" expense group from the FamilyLedger app. Please analyze it and help me understand our spending better.

SUMMARY
- Total spend: ${currencySymbol}${totalSpend.toFixed(2)} across ${expenses.length} transactions
- Date range: ${dateRange}
- Members: ${members.map((m) => m.displayName).join(', ') || 'none'}
- Last 30 days: ${currencySymbol}${last30Total.toFixed(2)} (previous 30 days: ${currencySymbol}${prev30Total.toFixed(2)})

SPENDING BY CATEGORY
${categoryLines || '(no expenses yet)'}

SPENDING BY MEMBER (who paid)
${memberLines || '(no expenses yet)'}

Please:
1. Identify the 2-3 biggest spending categories and whether that split looks reasonable for a group like this.
2. Point out anything unusual — a category that jumped recently, or one member consistently paying much more than others.
3. Suggest 2-3 concrete, practical ways we could reduce spending or split costs more fairly, based specifically on the numbers above (not generic budgeting advice).
4. If the last-30-days vs previous-30-days trend is meaningfully up or down, call that out and guess why based on the category data.

Keep the response focused and actionable — a few short sections, not a long essay.`;
}
