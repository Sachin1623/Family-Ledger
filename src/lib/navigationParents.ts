// Resolves a screen's logical "back" destination from the CURRENT PATH itself, rather than
// trusting browser/router history — any `replace: true` navigation elsewhere (SudokuGame
// bouncing back to /games/sudoku when there's no active game, GroupExpenses clearing its own nav
// state, deep links with no prior in-app history) can leave the history stack not matching the
// app's actual page hierarchy, which made history-based back navigation land on the wrong page.
// Shared by Header.tsx's in-app back arrow AND App.tsx's hardware/gesture back button handler, so
// both always agree on where "back" goes.
const PARENT_OVERRIDES: Record<string, string> = {
  '/create-group': '/',
  '/add-expense': '/',
  '/settlements': '/',
  '/analysis': '/',
  '/feed': '/',
  '/chat': '/',
  '/profile': '/',
  '/feedback': '/',
  // Recurring Expenses is genuinely reached from Dashboard (its header button) or ManageGroup,
  // never from Tools — '/' is its correct parent. Everything below IS a Tools.tsx tile, though
  // (see TOOLS array there), so back from any of them belongs on '/tools', not the dashboard.
  '/recurring-expenses': '/',
  '/recurring-approvals': '/',
  '/todo': '/tools',
  '/calculator': '/tools',
  '/financial-calculators': '/tools',
  '/games': '/tools',
  '/tools': '/',
  '/shopping-lists': '/tools',
  '/expense-reminders': '/tools',
  '/reminders': '/tools',
  '/goals': '/',
  '/goals/allocate': '/goals',
  '/goals/reports': '/goals',
  '/goals/reconcile': '/goals',
  '/goals/accounts': '/goals',
  '/personal-loans': '/tools',
  '/friends': '/tools',
  '/progress': '/tools',
  '/health': '/tools',
  '/health/glucose': '/health',
  '/health/blood-pressure': '/health',
  '/health/medicines': '/health',
  '/games/sudoku': '/games',
  '/games/sudoku/leaderboard': '/games/sudoku',
  '/games/scramble': '/games',
  '/games/scramble/play': '/games/scramble',
  '/games/scramble/leaderboard': '/games/scramble',
  '/games/scramble-multiplayer': '/games/scramble',
  '/games/ludo': '/games',
  '/games/rummy': '/games',
  '/games/business': '/games',
  '/games/sweep': '/games',
  '/games/chess': '/games',
  '/shop/profile': '/shop/sales',
  '/shop/customers': '/shop/sales',
  '/shop/sales': '/',
  '/shop/reports': '/shop/sales',
  '/shop/activity': '/shop/sales',
  '/admin': '/',
  '/about': '/profile',
  '/privacy': '/profile',
  '/data-usage': '/privacy',
  '/terms': '/profile',
  '/contact': '/profile',
  '/delete-account': '/profile',
};

const PARENT_PATTERNS: [RegExp, string | ((path: string) => string)][] = [
  [/^\/games\/sudoku\/play\/[^/]+$/, '/games/sudoku'],
  [/^\/games\/ranks\/[^/]+$/, '/games'],
  [/^\/games\/ludo\/[^/]+$/, '/games/ludo'],
  [/^\/games\/rummy\/[^/]+$/, '/games/rummy'],
  [/^\/games\/business\/[^/]+$/, '/games/business'],
  [/^\/games\/sweep\/[^/]+$/, '/games/sweep'],
  [/^\/games\/chess\/[^/]+$/, '/games/chess'],
  [/^\/games\/scramble-multiplayer\/[^/]+$/, '/games/scramble-multiplayer'],
  [/^\/groups\/[^/]+\/expenses$/, (p) => p.replace(/\/expenses$/, '')],
  [/^\/groups\/[^/]+\/manage$/, (p) => p.replace(/\/manage$/, '')],
  [/^\/groups\/[^/]+$/, '/'],
  [/^\/goals\/[^/]+\/edit$/, (p) => p.replace(/\/edit$/, '')],
  [/^\/goals\/[^/]+\/allocate$/, (p) => p.replace(/\/allocate$/, '')],
  [/^\/goals\/accounts\/[^/]+$/, '/goals/accounts'],
  [/^\/goals\/[^/]+$/, '/goals'],
  [/^\/settlements\/[^/]+$/, '/settlements'],
  [/^\/shopping-lists\/[^/]+$/, '/shopping-lists'],
  [/^\/personal-loans\/[^/]+$/, '/personal-loans'],
  [/^\/shop\/customers\/[^/]+$/, '/shop/customers'],
  [/^\/admin\/users\/[^/]+$/, '/admin/users'],
  [/^\/admin\//, '/admin'],
  // Reachable from several places (Friends list, a group's member list, the leaderboard) with no
  // single true parent — defaults to Friends as the most common entry point, same tradeoff as any
  // other multi-entry-point dynamic-id route in this table.
  [/^\/u\/[^/]+$/, '/friends'],
];

export function getParentPath(pathname: string, search?: string): string {
  // Group Expenses' and Manage Group's back destinations depend on how they were reached, unlike
  // everything else here (which is a pure function of the path alone): the generic patterns below
  // always resolve to the group's Analysis page, which is correct when you drilled in from there
  // — but the Dashboard group tile's own "Expense report"/"Manage" quick-access icons tag their
  // links with `?from=dashboard` specifically so back returns to the Dashboard instead, skipping
  // over Analysis. Checked before PARENT_OVERRIDES/PARENT_PATTERNS since those match on path alone.
  if (
    (/^\/groups\/[^/]+\/expenses$/.test(pathname) || /^\/groups\/[^/]+\/manage$/.test(pathname)) &&
    new URLSearchParams(search || '').get('from') === 'dashboard'
  ) {
    return '/';
  }
  // Same idea, for GoalsHub's own internal tabs (Reports/Goals/Accounts/Allocation) — those are
  // React state, not routes, so navigating to New Goal and back would otherwise always land on
  // GoalsHub's default 'reports' tab regardless of which one was actually open. GoalsHub.tsx tags
  // its "New Goal" links with `?from=<tab>` on the way out and reads `?tab=` back on mount.
  if (pathname === '/goals/new') {
    const from = new URLSearchParams(search || '').get('from');
    return from ? `/goals?tab=${from}` : '/goals';
  }
  // Same idea for a specific goal's own detail page — GoalsHub's goal cards, GoalReports' chart/
  // list, and GoalAllocationManager's rows all tag their links with `?from=<tab>` on the way in
  // (see each screen's own navigate() calls), so back returns to the exact tab that was open
  // instead of always landing on GoalsHub's default 'reports' tab. Checked before PARENT_PATTERNS
  // below (whose generic `/goals/:id` -> '/goals' rule would otherwise win and drop the tab) but
  // only when this IS a plain goal-id path — PARENT_OVERRIDES/other patterns still take priority
  // for anything more specific (e.g. `/goals/new`, `/goals/:id/edit`, already handled elsewhere).
  if (/^\/goals\/[^/]+$/.test(pathname) && !PARENT_OVERRIDES[pathname]) {
    const from = new URLSearchParams(search || '').get('from');
    if (from) return `/goals?tab=${from}`;
  }
  // Same for an account's own detail page (`/goals/accounts/:id`) — reached from the account
  // tiles in GoalsHub's Accounts tab (tagged `?from=accounts`), so back returns to that tab
  // rather than GoalsHub's default. Untagged (e.g. opened from the standalone `/goals/accounts`
  // route or a deep link) falls through to the `/goals/accounts` pattern below.
  if (/^\/goals\/accounts\/[^/]+$/.test(pathname)) {
    const from = new URLSearchParams(search || '').get('from');
    if (from) return `/goals?tab=${from}`;
  }
  if (PARENT_OVERRIDES[pathname]) return PARENT_OVERRIDES[pathname];
  for (const [pattern, parent] of PARENT_PATTERNS) {
    if (pattern.test(pathname)) return typeof parent === 'function' ? parent(pathname) : parent;
  }
  return '/';
}
