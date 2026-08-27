// Registry of everything a user can mark as a favorite for quick access — games and the other
// utility pages under Tools. Deliberately a flat, hand-maintained list (not auto-derived from
// GamesHub/Tools' own arrays) so favoriting stays meaningful even if those screens' wording or
// grouping changes independently; `key` is what actually gets stored on `users/{uid}.favorites`,
// `to`/`icon`/`label` are just for rendering the favorite elsewhere (e.g. Dashboard's quick-access
// row) without that screen needing to know where an item "really" lives.
export interface FavoritableItem {
  key: string;
  to: string;
  icon: string;
  label: string;
}

export const FAVORITABLE_ITEMS: FavoritableItem[] = [
  { key: 'game-sudoku', to: '/games/sudoku', icon: '🔢', label: 'Sudoku' },
  { key: 'game-scramble', to: '/games/scramble', icon: '🔤', label: 'Scramble' },
  { key: 'game-ludo', to: '/games/ludo', icon: '🎲', label: 'Ludo' },
  { key: 'game-rummy', to: '/games/rummy', icon: '🃏', label: '27-Hand Rummy' },
  { key: 'game-business', to: '/games/business', icon: '🏙️', label: 'Business' },
  { key: 'game-sweep', to: '/games/sweep', icon: '🧹', label: 'Sweep' },
  { key: 'game-chess', to: '/games/chess', icon: '♟️', label: 'Chess' },
  { key: 'game-sequence', to: '/games/sequence', icon: '🔴', label: 'Sequence' },
  { key: 'todo', to: '/todo', icon: '✅', label: 'To-Do List' },
  { key: 'expense-reminders', to: '/expense-reminders', icon: '🔔', label: 'Expense Reminders' },
  { key: 'shopping-lists', to: '/shopping-lists', icon: '🛒', label: 'Shopping Lists' },
  { key: 'personal-loans', to: '/personal-loans', icon: '🤝', label: 'Personal Loans' },
  { key: 'calculator', to: '/calculator', icon: '🧮', label: 'Calculator' },
  { key: 'financial-calculators', to: '/financial-calculators', icon: '🏦', label: 'Financial Calculators' },
  { key: 'recurring-expenses', to: '/recurring-expenses', icon: '🔁', label: 'Recurring Expenses' },
  { key: 'health', to: '/health', icon: '🩺', label: 'Health' },
];

export const FAVORITABLE_BY_KEY: Record<string, FavoritableItem> = Object.fromEntries(
  FAVORITABLE_ITEMS.map((item) => [item.key, item]),
);
