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
  '/pending-actions': '/',
  // Recurring Expenses is genuinely reached from Dashboard (its header button) or ManageGroup,
  // never from Tools — '/' is its correct parent. Everything below IS a Tools.tsx tile, though
  // (see TOOLS array there), so back from any of them belongs on '/tools', not the dashboard.
  '/recurring-expenses': '/',
  '/recurring-approvals': '/',
  // Each of these is a specific Tools.tsx tile — the plain '/tools' Tools.tsx used to fall back
  // to happens to land on the right tab only for the 'finance' category (index 0's default), so
  // every tile outside Finance needs its actual tab spelled out or back lands on the wrong one
  // (caught 2026-09-26 on Policy Vault and To-Do, both of which are NOT in the finance tab).
  '/todo': '/tools?category=productivity',
  '/calculator': '/tools?category=finance',
  '/financial-calculators': '/tools?category=finance',
  '/games': '/tools?category=games',
  '/tools': '/',
  '/shopping-lists': '/tools?category=productivity',
  '/expense-reminders': '/tools?category=finance',
  '/reminders': '/tools?category=productivity',
  '/goals': '/',
  '/goals/allocate': '/goals',
  '/goals/reports': '/goals',
  '/goals/reconcile': '/goals',
  '/goals/accounts': '/goals',
  '/personal-loans': '/tools?category=finance',
  '/policies': '/tools?category=finance',
  '/policies/new': '/policies',
  '/friends': '/tools?category=social',
  '/progress': '/tools?category=social',
  // Tools.tsx links each tracker directly, skipping the /health hub (same shortcut as the Games
  // tab's own tiles — see the /games entry above) — so back from any of the three goes straight to
  // Tools' Health tab, not to the hub. /health itself still exists as its own route (reached e.g.
  // by a notification deep link) and goes to the same place for the same 'wrong default tab' reason
  // as every other entry in this block.
  '/health': '/tools?category=health',
  '/health/glucose': '/tools?category=health',
  '/health/blood-pressure': '/tools?category=health',
  '/health/medicines': '/tools?category=health',
  '/baby-vaccinations': '/tools?category=health',
  '/baby-vaccinations/add-child': '/baby-vaccinations',
  '/baby-vaccinations/deleted-babies': '/baby-vaccinations',
  // Every game below skips the /games hub entirely — Tools.tsx links every game directly (see its
  // own header comment), so that's the real entry point players use, and back should return there
  // with the Games tab already selected rather than bouncing through the hub. Applies to both a
  // game's own lobby/home AND its actual gameplay screen (via PARENT_PATTERNS below) — only truly
  // nested sub-pages (a leaderboard, Scramble's multiplayer mode reached from within Scramble
  // itself) still go to their immediate in-game parent instead.
  '/games/sudoku': '/tools?category=games',
  '/games/sudoku/leaderboard': '/games/sudoku',
  '/games/scramble': '/tools?category=games',
  // Exception to the shortcut above: mid-game back returns to Scramble's own home rather than
  // skipping past it (matches Sudoku/Chess).
  '/games/scramble/play': '/games/scramble',
  '/games/scramble/leaderboard': '/games/scramble',
  '/games/scramble-multiplayer': '/games/scramble',
  '/games/ludo': '/tools?category=games',
  '/games/rummy': '/tools?category=games',
  '/games/business': '/tools?category=games',
  '/games/sweep': '/tools?category=games',
  '/games/chess': '/tools?category=games',
  '/games/sequence': '/tools?category=games',
  '/games/rummy13': '/tools?category=games',
  '/games/spadePledge': '/tools?category=games',
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
  [/^\/games\/ranks\/[^/]+$/, '/games'],
  // Every game below is an exception to the direct-to-Tools shortcut used by their own lobby
  // overrides above: mid-game back returns to the game's own home/lobby rather than skipping past
  // it (Scramble's equivalent exception is in PARENT_OVERRIDES above, since /games/scramble/play is
  // a fixed path, not a dynamic :id).
  [/^\/games\/sudoku\/play\/[^/]+$/, '/games/sudoku'],
  [/^\/games\/chess\/[^/]+$/, '/games/chess'],
  [/^\/games\/ludo\/[^/]+$/, '/games/ludo'],
  [/^\/games\/rummy\/[^/]+$/, '/games/rummy'],
  [/^\/games\/business\/[^/]+$/, '/games/business'],
  [/^\/games\/rummy13\/[^/]+$/, '/games/rummy13'],
  [/^\/games\/sweep\/[^/]+$/, '/games/sweep'],
  [/^\/games\/sequence\/[^/]+$/, '/games/sequence'],
  [/^\/games\/spadePledge\/[^/]+$/, '/games/spadePledge'],
  [/^\/games\/scramble-multiplayer\/[^/]+$/, '/games/scramble-multiplayer'],
  // Edit Profile is only ever reached from View Profile (see BabyVaccinations.tsx / VaccineProfileView.tsx) — back returns there, not straight to the dashboard.
  [/^\/baby-vaccinations\/edit-profile\/[^/]+$/, (p) => p.replace('/edit-profile/', '/profile/')],
  [/^\/baby-vaccinations\/profile\/[^/]+$/, '/baby-vaccinations'],
  [/^\/baby-vaccinations\/log-visit\/[^/]+\/[^/]+$/, '/baby-vaccinations'],
  [/^\/baby-vaccinations\/visit\/[^/]+\/[^/]+$/, '/baby-vaccinations'],
  [/^\/baby-vaccinations\/caregivers\/[^/]+$/, '/baby-vaccinations'],
  [/^\/baby-vaccinations\/reminders\/[^/]+$/, '/baby-vaccinations'],
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
  [/^\/policies\/[^/]+\/edit$/, (p) => p.replace(/\/edit$/, '')],
  [/^\/policies\/[^/]+$/, '/policies'],
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
  // AlarmsHub.tsx's Medicine (Person -> Incident -> Medicine) and Vaccination (Baby -> Visit)
  // drill-downs are React state elsewhere in this app, but here they're carried entirely in query
  // params (cat/person/incident/baby) specifically so this one function can walk back one level at
  // a time — AlarmsHub itself has no in-page back buttons of its own.
  if (pathname === '/alarms') {
    const params = new URLSearchParams(search || '');
    const cat = params.get('cat');
    const person = params.get('person');
    const incident = params.get('incident');
    const baby = params.get('baby');
    if (cat === 'medicine' && person && incident) return `/alarms?cat=medicine&person=${person}`;
    if (cat === 'medicine' && person) return '/alarms?cat=medicine';
    if (cat === 'vaccination' && baby) return '/alarms?cat=vaccination';
    if (cat) return '/alarms';
    return '/';
  }
  if (PARENT_OVERRIDES[pathname]) return PARENT_OVERRIDES[pathname];
  for (const [pattern, parent] of PARENT_PATTERNS) {
    if (pattern.test(pathname)) return typeof parent === 'function' ? parent(pathname) : parent;
  }
  return '/';
}
