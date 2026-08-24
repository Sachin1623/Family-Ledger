// Registry for every guided tour in the app — one entry per feature, each with the route its
// steps live on and the ordered `data-tour="<selector>"` steps to spotlight there. Deliberately a
// flat, hand-maintained list (same pattern as favorites.ts) rather than derived from Tools.tsx/
// GamesHub.tsx's own arrays, so a tour's wording can be tuned independently of the tile it's
// launched from. `OnboardingTour.tsx` is the single engine that runs whichever tour's `id` shows
// up in the `?tour=` query param; `About.tsx` is what launches them (navigating to `route`
// with `?tour=<id>` appended). The 'dashboard' tour is special-cased in OnboardingTour.tsx to
// also auto-launch for brand-new accounts, exactly like the original single-tour version did.
export interface TourStep {
  selector: string;
  title: string;
  description: string;
}

export interface TourDef {
  id: string;
  route: string;
  icon: string;
  label: string;
  blurb: string;
  steps: TourStep[];
}

export const TOURS: TourDef[] = [
  {
    id: 'dashboard',
    route: '/',
    icon: 'groups',
    label: 'Groups & Dashboard',
    blurb: 'Create groups, see budgets at a glance, and find your way around.',
    steps: [
      {
        selector: 'header-search',
        title: 'Search anything',
        description: "Jump straight to any feature, or find an expense by description or category across every group you're in.",
      },
      {
        selector: 'dashboard-new-group',
        title: 'Start a group',
        description: 'Create a group to split expenses with family, roommates, or friends. Everyone you invite can add and see shared expenses.',
      },
      {
        selector: 'dashboard-group-card',
        title: 'Your groups at a glance',
        description: "Each group card shows this month's budget progress, the latest spends, and quick buttons to add an expense or manage the group.",
      },
      {
        selector: 'nav-settlements',
        title: 'Balances',
        description: 'See who owes who across all your groups, and settle up directly from here.',
      },
      {
        selector: 'nav-analysis',
        title: 'Analysis',
        description: 'Charts and breakdowns of your spending by category, group, and time period.',
      },
      {
        selector: 'nav-tools',
        title: 'Tools',
        description: 'To-Do lists, expense reminders, shared shopping lists, recurring expenses, and calculators all live here.',
      },
      {
        selector: 'nav-add-expense',
        title: 'Add an expense',
        description: 'The fastest way to log a new expense to any group — this button is always one tap away.',
      },
      {
        selector: 'header-profile',
        title: 'Your profile',
        description: 'Manage your account, notification preferences, and — if you ever need it — replay any tour from About.',
      },
    ],
  },
  {
    id: 'add-expense',
    route: '/add-expense',
    icon: 'add_circle',
    label: 'Add Expense',
    blurb: 'Log a spend (or income) in a few taps, with categories and budgets built in.',
    steps: [
      {
        selector: 'expense-amount',
        title: 'Type the amount',
        description: 'Tap here to bring up the keypad — you can even type a quick sum like 20+30-5 and it evaluates for you.',
      },
      {
        selector: 'expense-type-toggle',
        title: 'Expense or income',
        description: 'Groups with income tracking enabled let you log money coming in too, not just going out.',
      },
      {
        selector: 'expense-category',
        title: 'Pick a category',
        description: 'Categorizing every entry is what powers the charts and breakdowns in Analysis later.',
      },
      {
        selector: 'expense-save',
        title: 'Save it',
        description: "If the group has splitting enabled, you'll also choose how to split it before saving.",
      },
    ],
  },
  {
    id: 'balances',
    route: '/settlements',
    icon: 'account_balance_wallet',
    label: 'Balances',
    blurb: 'See who owes who, per group or across everything, and settle up.',
    steps: [
      {
        selector: 'settlements-filter',
        title: 'Overall or per-group',
        description: 'Switch between a combined view and any single group — debts are always calculated separately per group, never netted across them.',
      },
      {
        selector: 'settlements-summary',
        title: "What you're owed vs. what you owe",
        description: 'A quick two-number summary for whichever view is selected above.',
      },
      {
        selector: 'settlements-list',
        title: 'Who owes who?',
        description: 'The simplified list of who should pay who to settle everything up — tap an entry to record a settlement.',
      },
    ],
  },
  {
    id: 'analysis',
    route: '/analysis',
    icon: 'pie_chart',
    label: 'Analysis',
    blurb: 'Visual breakdowns of your spending by time, category, and group.',
    steps: [
      {
        selector: 'analysis-group-filter',
        title: 'Choose a group',
        description: 'View spending across all your groups combined, or zoom into just one.',
      },
      {
        selector: 'analysis-chart',
        title: 'Spending trend',
        description: 'A chart of spending over time — switch between daily, weekly, and monthly, and sort ascending or descending.',
      },
    ],
  },
  {
    id: 'recurring-expenses',
    route: '/recurring-expenses',
    icon: 'event_repeat',
    label: 'Recurring Expenses',
    blurb: "Set up rent or a subscription once — you'll be asked to confirm each time it's due.",
    steps: [
      {
        selector: 'recurring-add',
        title: 'Set up a repeating expense',
        description: "Nothing is added automatically — when it's due, you'll get a notification to accept, decline, or change it first.",
      },
      {
        selector: 'recurring-pending',
        title: 'Pending confirmations',
        description: 'Any due occurrences waiting on your decision show up here.',
      },
    ],
  },
  {
    id: 'feed',
    route: '/feed',
    icon: 'history',
    label: 'Activity Feed',
    blurb: 'A live feed of who added, edited, or deleted expenses across your groups.',
    steps: [
      {
        selector: 'header-feed',
        title: 'One tap away',
        description: 'This button opens the feed as a slide-over from anywhere in the app — you never have to leave the screen you\'re on.',
      },
      {
        selector: 'feed-list',
        title: 'Everything, in order',
        description: 'Group activity, game invites, chat messages, and personal reminders all show up here as they happen.',
      },
    ],
  },
  {
    id: 'chat',
    route: '/chat',
    icon: 'chat',
    label: 'Chat',
    blurb: 'Message anyone across your groups directly.',
    steps: [
      {
        selector: 'chat-members',
        title: 'Everyone across your groups',
        description: "Tap anyone here to open a direct message with them — you don't need to be in the same group chat to talk.",
      },
    ],
  },
  {
    id: 'todo',
    route: '/todo',
    icon: 'checklist',
    label: 'To-Do List',
    blurb: 'Personal or shared tasks, with reminders and a calendar view.',
    steps: [
      {
        selector: 'todo-add',
        title: 'Add a to-do',
        description: 'Set a reminder for any item, and optionally share it with a group so everyone can see and check it off together.',
      },
      {
        selector: 'todo-calendar',
        title: 'Calendar view',
        description: 'Dots mark days with something due — tap a date to filter the list below to just that day.',
      },
    ],
  },
  {
    id: 'expense-reminders',
    route: '/expense-reminders',
    icon: 'notifications_active',
    label: 'Expense Reminders',
    blurb: "For spends you make often but not on a strict schedule — get nudged to log one.",
    steps: [
      {
        selector: 'reminders-add',
        title: 'Create a reminder',
        description: 'Pre-fill a group, category, or amount if you want. Tapping the reminder later opens Add Expense for you to finish and submit.',
      },
    ],
  },
  {
    id: 'shopping-lists',
    route: '/shopping-lists',
    icon: 'shopping_cart',
    label: 'Shopping Lists',
    blurb: 'Share a list with a group — everyone can add items and check them off.',
    steps: [
      {
        selector: 'shopping-add',
        title: 'Start a list',
        description: "Keep it personal, or share it with a group so everyone can contribute items and check them off together.",
      },
    ],
  },
  {
    id: 'personal-loans',
    route: '/personal-loans',
    icon: 'handshake',
    label: 'Personal Loans',
    blurb: 'Track money given to or taken from friends and family — no group needed.',
    steps: [
      {
        selector: 'loans-summary',
        title: 'Owed to you vs. you owe',
        description: 'A running total across every contact you track a loan with.',
      },
      {
        selector: 'loans-add',
        title: 'Log a new entry',
        description: 'Record money lent or borrowed, with reminders and installment plans if you want them.',
      },
    ],
  },
  {
    id: 'calculator',
    route: '/calculator',
    icon: 'calculate',
    label: 'Calculator',
    blurb: 'A quick everyday calculator, right inside the app.',
    steps: [
      {
        selector: 'calc-display',
        title: 'The display',
        description: 'Shows your full expression as you type it — not just the running result.',
      },
      {
        selector: 'calc-keypad',
        title: 'Standard operators',
        description: '+, −, ×, ÷, and % with normal operator precedence — × and ÷ resolve before + and −.',
      },
    ],
  },
  {
    id: 'financial-calculators',
    route: '/financial-calculators',
    icon: 'account_balance',
    label: 'Financial Calculators',
    blurb: 'Loans, deposits, and investment planning tools — EMI, FD, RD, SIP, SWP, NPS, and more.',
    steps: [
      {
        selector: 'fincalc-chips',
        title: 'Pick a calculator',
        description: 'Bank tools (loans, deposits) and investment tools (SIP, SWP, NPS) are grouped separately.',
      },
      {
        selector: 'fincalc-result',
        title: 'Live results',
        description: 'Results update instantly as you change the inputs above — no separate "calculate" button.',
      },
    ],
  },
  {
    id: 'games',
    route: '/games',
    icon: 'stadium',
    label: 'Games',
    blurb: 'Play Ludo, Rummy, Business, Sweep, Chess, and more with your groups.',
    steps: [
      {
        selector: 'games-grid',
        title: 'Play with your groups',
        description: 'Every game here supports live multiplayer with chat, quick reactions, and leaderboards — tap one to create or join a table.',
      },
    ],
  },
  {
    id: 'shop-mode',
    route: '/shop/sales',
    icon: 'storefront',
    label: 'Shopkeeper Mode',
    blurb: 'A lightweight point-of-sale and customer ledger for small businesses.',
    steps: [
      {
        selector: 'shop-sales-title',
        title: 'Ring up sales',
        description: 'A separate, simplified mode for tracking sales, customers, and credit — switch back to your personal view anytime.',
      },
      {
        selector: 'shop-sales-new',
        title: 'New Sale',
        description: 'Record a sale against a customer, with WhatsApp receipts and credit tracking built in.',
      },
      {
        selector: 'header-shop-toggle',
        title: 'Switch views anytime',
        description: 'This toggle in the header jumps you between your personal FamilyLedger view and Shopkeeper mode.',
      },
    ],
  },
];

export const TOUR_BY_ID: Record<string, TourDef> = Object.fromEntries(TOURS.map((t) => [t.id, t]));
