// Static index of app features/screens for the header's global search. Only screens reachable
// without a specific record's ID are listed here (per-group screens like GroupExpenses need a
// groupId and aren't generically "searchable" the same way) — matching expenses are handled
// separately in GlobalSearch.tsx since they come from live Firestore data, not a static list.
export interface SearchableFeature {
  id: string;
  label: string;
  description: string;
  // Optional i18n keys used only for display in GlobalSearch.tsx — matching in searchFeatures()
  // below always runs against the English label/description/keywords, so search stays correct
  // for typed English terms regardless of the UI's current language.
  labelKey?: string;
  descriptionKey?: string;
  icon: string;
  route: string;
  keywords?: string[];
  adminOnly?: boolean;
}

export const SEARCHABLE_FEATURES: SearchableFeature[] = [
  { id: 'groups', label: 'Groups', description: 'View your groups, budgets & recent expenses', labelKey: 'nav.groups', descriptionKey: 'search.groupsDesc', icon: 'group', route: '/', keywords: ['dashboard', 'home'] },
  { id: 'add-expense', label: 'Add Expense', description: 'Log a new expense', labelKey: 'nav.addExpense', descriptionKey: 'search.addExpenseDesc', icon: 'add_circle', route: '/add-expense', keywords: ['new expense', 'log spend'] },
  { id: 'create-group', label: 'Create Group', description: 'Start a new shared group', labelKey: 'createGroup.create', icon: 'group_add', route: '/create-group' },
  { id: 'balances', label: 'Balances', description: 'See who owes who across your groups', labelKey: 'nav.balances', descriptionKey: 'search.balancesDesc', icon: 'account_balance_wallet', route: '/settlements', keywords: ['settlements', 'settle up', 'owe'] },
  { id: 'analysis', label: 'Analysis', description: 'Spending breakdown & charts', labelKey: 'nav.analysis', descriptionKey: 'search.analysisDesc', icon: 'analytics', route: '/analysis', keywords: ['charts', 'stats', 'breakdown'] },
  { id: 'tools', label: 'Tools', description: 'To-Do list, reminders, shopping lists, calculators', labelKey: 'nav.tools', descriptionKey: 'search.toolsDesc', icon: 'construction', route: '/tools' },
  { id: 'progress', label: 'My Progress', description: 'Your points, level, streaks and badges', labelKey: 'tools.progress', descriptionKey: 'tools.progressDesc', icon: 'military_tech', route: '/progress', keywords: ['points', 'xp', 'level', 'streak', 'coins'] },
  { id: 'friends', label: 'Friends & Family', description: 'Connect with friends, chat and invite them to groups, family rosters', labelKey: 'tools.friends', descriptionKey: 'tools.friendsDesc', icon: 'group', route: '/friends', keywords: ['friend', 'family', 'add friend'] },
  { id: 'todo', label: 'To-Do List', description: 'Tasks, reminders & group sharing', labelKey: 'tools.todo', descriptionKey: 'tools.todoDesc', icon: 'checklist', route: '/todo', keywords: ['tasks', 'reminders'] },
  { id: 'expense-reminders', label: 'Expense Reminders', description: 'Get nudged to log frequent, irregular spends', labelKey: 'tools.expenseReminders', descriptionKey: 'tools.expenseRemindersDesc', icon: 'notifications_active', route: '/expense-reminders' },
  { id: 'recurring-expenses', label: 'Recurring Expenses', description: 'Rent, subscriptions & bills that repeat automatically', labelKey: 'search.recurringExpenses', descriptionKey: 'search.recurringExpensesDesc', icon: 'event_repeat', route: '/recurring-expenses', keywords: ['subscriptions', 'bills', 'rent'] },
  { id: 'recurring-approvals', label: 'Recurring Approvals', description: 'Confirm pending recurring expense occurrences', labelKey: 'search.recurringApprovals', descriptionKey: 'search.recurringApprovalsDesc', icon: 'fact_check', route: '/recurring-approvals' },
  { id: 'shopping-lists', label: 'Shopping Lists', description: 'Share with a group, contribute together', labelKey: 'tools.shoppingLists', descriptionKey: 'tools.shoppingListsDesc', icon: 'shopping_cart', route: '/shopping-lists', keywords: ['groceries'] },
  { id: 'personal-loans', label: 'Personal Loans', description: 'Track money given to or taken from family & friends', labelKey: 'tools.personalLoans', descriptionKey: 'tools.personalLoansDesc', icon: 'handshake', route: '/personal-loans', keywords: ['iou', 'lend', 'borrow', 'debt'] },
  { id: 'calculator', label: 'Calculator', description: 'Quick everyday math', labelKey: 'tools.calculator', descriptionKey: 'tools.calculatorDesc', icon: 'calculate', route: '/calculator' },
  { id: 'financial-calculators', label: 'Financial Calculators', description: 'Loans, FD/RD, SIP, SWP, NPS & more', labelKey: 'tools.financialCalculators', descriptionKey: 'tools.financialCalculatorsDesc', icon: 'account_balance', route: '/financial-calculators', keywords: ['loan', 'sip', 'fd', 'rd', 'emi'] },
  { id: 'games', label: 'Games', description: 'Sudoku offline, Ludo online multiplayer, more coming soon', labelKey: 'tools.games', descriptionKey: 'search.gamesDesc', icon: 'stadia_controller', route: '/games', keywords: ['sudoku', 'chess', 'ludo', 'business', 'puzzle', 'scramble', 'word'] },
  // Individual games — child screens of the "Games" hub above, each its own direct route (its
  // lobby, not the hub) so typing e.g. "chess" jumps straight into that game instead of only
  // matching the parent hub via keywords.
  { id: 'game-sudoku', label: 'Sudoku', description: 'Classic number puzzle, offline', labelKey: 'games.sudoku', descriptionKey: 'games.sudokuDesc', icon: 'grid_on', route: '/games/sudoku', keywords: ['puzzle', 'number'] },
  { id: 'game-scramble', label: 'Word Scramble', description: 'Unscramble the word, solo or multiplayer', labelKey: 'games.scramble', descriptionKey: 'games.scrambleDesc', icon: 'abc', route: '/games/scramble', keywords: ['word', 'puzzle'] },
  { id: 'game-chess', label: 'Chess', description: 'Play chess online with friends', labelKey: 'games.chess', descriptionKey: 'games.chessDesc', icon: 'stadia_controller', route: '/games/chess' },
  { id: 'game-ludo', label: 'Ludo', description: 'Classic board game, online multiplayer', labelKey: 'games.ludo', descriptionKey: 'games.ludoDesc', icon: 'casino', route: '/games/ludo', keywords: ['board game', 'dice'] },
  { id: 'game-rummy', label: '27-Hand Rummy', description: 'Card game, online multiplayer', labelKey: 'games.rummy', descriptionKey: 'games.rummyDesc', icon: 'style', route: '/games/rummy', keywords: ['cards'] },
  { id: 'game-business', label: 'Business', description: 'Monopoly-style board game', labelKey: 'games.business', descriptionKey: 'games.businessDesc', icon: 'location_city', route: '/games/business', keywords: ['monopoly', 'board game'] },
  { id: 'game-sweep', label: 'Sweep', description: 'Card game, online multiplayer', labelKey: 'games.sweep', descriptionKey: 'games.sweepDesc', icon: 'style', route: '/games/sweep', keywords: ['cards'] },
  { id: 'game-sequence', label: 'Sequence', description: 'Board & card game, online multiplayer', labelKey: 'games.sequence', descriptionKey: 'games.sequenceDesc', icon: 'grid_4x4', route: '/games/sequence', keywords: ['board game', 'cards'] },
  { id: 'health', label: 'Health', description: 'Glucose, blood pressure & medicine tracking', labelKey: 'nav.health', icon: 'favorite', route: '/health', keywords: ['glucose', 'blood pressure', 'medicine', 'medication'] },
  // Individual health trackers — child screens of the "Health" hub above.
  { id: 'health-glucose', label: 'Glucose Tracker', description: 'Log & chart blood glucose readings', labelKey: 'health.glucoseTracker', descriptionKey: 'health.glucoseTrackerDesc', icon: 'water_drop', route: '/health/glucose', keywords: ['sugar', 'diabetes'] },
  { id: 'health-blood-pressure', label: 'Blood Pressure Tracker', description: 'Log & chart blood pressure readings', labelKey: 'bp.tracker', descriptionKey: 'bp.trackerDesc', icon: 'favorite', route: '/health/blood-pressure', keywords: ['bp', 'hypertension'] },
  { id: 'health-medicines', label: 'Medicine Tracker', description: 'Doses, schedules & reminders', labelKey: 'medicine.tracker', descriptionKey: 'medicine.trackerDesc', icon: 'medication', route: '/health/medicines', keywords: ['pills', 'dose', 'alarm', 'reminder'] },
  { id: 'reminders', label: 'Shared Reminders', description: 'Reminders shared with your group members', icon: 'alarm', route: '/reminders' },
  { id: 'goals', label: 'Goals', description: 'Savings goals, linked accounts & allocation', labelKey: 'nav.goals', icon: 'savings', route: '/goals', keywords: ['savings', 'target', 'accounts'] },
  // Child screens of Goals — Accounts and Allocation are also tabs on /goals itself now, but keep
  // their own direct routes here too since both are still independently reachable.
  { id: 'goals-new', label: 'New Goal', description: 'Create a new savings goal', labelKey: 'goals.newGoal', icon: 'add_task', route: '/goals/new' },
  { id: 'goals-reports', label: 'Goal Reports', description: 'Progress & history across your goals', labelKey: 'search.goalReports', icon: 'insights', route: '/goals/reports' },
  { id: 'goals-accounts', label: 'Financial Accounts', description: 'Bank/investment accounts linked to your goals', labelKey: 'accounts.title', icon: 'account_balance', route: '/goals/accounts', keywords: ['bank', 'account'] },
  { id: 'goals-allocate', label: 'Allocation Manager', description: 'Which account funds which goal, and how much', labelKey: 'goals.allocationManagerTitle', icon: 'account_balance', route: '/goals/allocate' },
  { id: 'feed', label: 'Activity Feed', description: 'Recent activity across your groups', labelKey: 'header.feed', icon: 'history', route: '/feed' },
  { id: 'profile', label: 'Profile', description: 'Account settings & notification preferences', labelKey: 'header.profile', descriptionKey: 'search.profileDesc', icon: 'person', route: '/profile', keywords: ['settings', 'account'] },
  { id: 'feedback', label: 'Feedback & Support', description: 'Suggestions, feedback & bug reports', labelKey: 'profile.feedbackSupport', descriptionKey: 'profile.feedbackSupportDesc', icon: 'forum', route: '/feedback', keywords: ['bug', 'support', 'contact'] },
  { id: 'about', label: 'About FamilyLedger', description: 'Features & version info', labelKey: 'profile.aboutFamilyLedger', icon: 'info', route: '/about' },
  { id: 'admin', label: 'Admin Panel', description: 'Admin dashboard', labelKey: 'search.adminPanel', descriptionKey: 'search.adminPanelDesc', icon: 'admin_panel_settings', route: '/admin', adminOnly: true },
  { id: 'admin-users', label: 'Admin: Users', description: 'Manage users, reset passwords, wipe accounts', labelKey: 'search.adminUsers', descriptionKey: 'search.adminUsersDesc', icon: 'group', route: '/admin/users', adminOnly: true },
  { id: 'admin-analytics', label: 'Admin: Analytics', description: 'Platform-wide usage analytics', labelKey: 'search.adminAnalytics', descriptionKey: 'search.adminAnalyticsDesc', icon: 'query_stats', route: '/admin/analytics', adminOnly: true },
  { id: 'admin-feedback', label: 'Admin: Feedback', description: 'Review user-submitted feedback', labelKey: 'search.adminFeedback', descriptionKey: 'search.adminFeedbackDesc', icon: 'forum', route: '/admin/feedback', adminOnly: true },
  { id: 'admin-app-version', label: 'Admin: App Version', description: 'Set the latest versionCode users get nudged to update to', labelKey: 'search.adminAppVersion', descriptionKey: 'search.adminAppVersionDesc', icon: 'system_update', route: '/admin/app-version', adminOnly: true },
  { id: 'admin-broadcast', label: 'Admin: Broadcast Message', description: 'Send a push + in-app announcement to every user', labelKey: 'search.adminBroadcast', descriptionKey: 'search.adminBroadcastDesc', icon: 'campaign', route: '/admin/broadcast', adminOnly: true },
  { id: 'admin-shopkeeper-requests', label: 'Admin: Shopkeeper Requests', description: 'Review and approve requests to enable Shopkeeper mode', labelKey: 'search.adminShopkeeperRequests', descriptionKey: 'search.adminShopkeeperRequestsDesc', icon: 'storefront', route: '/admin/shopkeeper-requests', adminOnly: true },
  { id: 'admin-manage-admins', label: 'Admin: Manage Admins', description: 'Grant or revoke admin access', labelKey: 'search.adminManageAdmins', descriptionKey: 'search.adminManageAdminsDesc', icon: 'shield_person', route: '/admin/manage-admins', adminOnly: true },
];

export function searchFeatures(query: string, isAdmin: boolean): SearchableFeature[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SEARCHABLE_FEATURES.filter((f) => {
    if (f.adminOnly && !isAdmin) return false;
    return (
      f.label.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q) ||
      (f.keywords || []).some((k) => k.toLowerCase().includes(q))
    );
  });
}
