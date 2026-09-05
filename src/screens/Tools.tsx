import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { FavoriteButton } from '../components/FavoriteButton';
import { useLanguage } from '../context/LanguageContext';

interface ToolEntry {
  to: string;
  favKey: string | null;
  icon: string;
  titleKey: string;
  descKey: string;
}

// Categorized into tabs now that there are enough tools to make one flat list unwieldy — same
// tab-bar pattern already used on HealthMedicines.tsx, Profile.tsx, and GroupAnalysisSummary.tsx.
// Grouped by what the tool is actually FOR, not by data model: Financial Calculators sits with
// Calculator/Personal Loans/Expense Reminders (all money-adjacent utilities) rather than off on
// its own; Progress rides with Social & Fun since it's built around friend rankings/streaks, not
// pure personal stats.
const TOOL_CATEGORIES: { key: string; label: string; tools: ToolEntry[] }[] = [
  {
    key: 'finance',
    label: 'Finance',
    tools: [
      { to: '/expense-reminders', favKey: 'expense-reminders', icon: '🔔', titleKey: 'tools.expenseReminders', descKey: 'tools.expenseRemindersDesc' },
      { to: '/personal-loans', favKey: 'personal-loans', icon: '🤝', titleKey: 'tools.personalLoans', descKey: 'tools.personalLoansDesc' },
      { to: '/calculator', favKey: 'calculator', icon: '🧮', titleKey: 'tools.calculator', descKey: 'tools.calculatorDesc' },
      { to: '/financial-calculators', favKey: 'financial-calculators', icon: '🏦', titleKey: 'tools.financialCalculators', descKey: 'tools.financialCalculatorsDesc' },
    ],
  },
  {
    key: 'productivity',
    label: 'Productivity',
    tools: [
      { to: '/todo', favKey: 'todo', icon: '✅', titleKey: 'tools.todo', descKey: 'tools.todoDesc' },
      { to: '/reminders', favKey: 'shared-reminders', icon: '⏰', titleKey: 'tools.sharedReminders', descKey: 'tools.sharedRemindersDesc' },
      { to: '/shopping-lists', favKey: 'shopping-lists', icon: '🛒', titleKey: 'tools.shoppingLists', descKey: 'tools.shoppingListsDesc' },
    ],
  },
  {
    key: 'social',
    label: 'Social',
    tools: [
      { to: '/friends', favKey: 'friends', icon: '🧑‍🤝‍🧑', titleKey: 'tools.friends', descKey: 'tools.friendsDesc' },
      { to: '/progress', favKey: 'progress', icon: '🏆', titleKey: 'tools.progress', descKey: 'tools.progressDesc' },
    ],
  },
  {
    key: 'games',
    label: 'Games',
    // Every individual game lobby directly, not the /games hub — same reasoning as Health below:
    // the hub (GamesHub.tsx) is itself only ever this exact list, so this skips a redundant hop.
    // Duplicated from GamesHub.tsx's own GAMES array (not imported — it's a plain local const
    // there, and this app's own convention is to duplicate small data arrays like this rather
    // than couple two screens over one; see GroupQuickActionsMenu.tsx's header comment for the
    // same reasoning applied elsewhere). Keep the two in sync if a game is ever added/removed.
    tools: [
      { to: '/games/sudoku', favKey: 'game-sudoku', icon: '🔢', titleKey: 'games.sudoku', descKey: 'games.sudokuDesc' },
      { to: '/games/scramble', favKey: 'game-scramble', icon: '🔤', titleKey: 'games.scramble', descKey: 'games.scrambleDesc' },
      { to: '/games/chess', favKey: 'game-chess', icon: '♟️', titleKey: 'games.chess', descKey: 'games.chessDesc' },
      { to: '/games/ludo', favKey: 'game-ludo', icon: '🎲', titleKey: 'games.ludo', descKey: 'games.ludoDesc' },
      { to: '/games/rummy', favKey: 'game-rummy', icon: '🃏', titleKey: 'games.rummy', descKey: 'games.rummyDesc' },
      { to: '/games/business', favKey: 'game-business', icon: '🏙️', titleKey: 'games.business', descKey: 'games.businessDesc' },
      { to: '/games/sweep', favKey: 'game-sweep', icon: '🧹', titleKey: 'games.sweep', descKey: 'games.sweepDesc' },
      { to: '/games/sequence', favKey: 'game-sequence', icon: '🔴', titleKey: 'games.sequence', descKey: 'games.sequenceDesc' },
    ],
  },
  {
    key: 'health',
    label: 'Health',
    // Every individual health tracker directly, not the /health hub — that hub (Health.tsx) is
    // itself only ever this exact 3-tracker list, so this skips a redundant hop. Icons/i18n keys/
    // favKeys match Health.tsx's own HEALTH_TRACKERS exactly.
    tools: [
      { to: '/health/glucose', favKey: 'glucose-tracker', icon: '🩸', titleKey: 'health.glucoseTracker', descKey: 'health.glucoseTrackerDesc' },
      { to: '/health/blood-pressure', favKey: 'bp-tracker', icon: '❤️', titleKey: 'bp.tracker', descKey: 'bp.trackerDesc' },
      { to: '/health/medicines', favKey: 'medicine-tracker', icon: '💊', titleKey: 'medicine.tracker', descKey: 'medicine.trackerDesc' },
    ],
  },
];

export default function Tools() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const [activeCategory, setActiveCategory] = useState(TOOL_CATEGORIES[0].key);
  // Deep-link from the header menu's category shortcuts (?category=games, etc.) — keyed on the
  // live searchParams object, not mount-only, since navigating here again while already on /tools
  // (clicking a different header-menu shortcut) doesn't remount this component. See
  // feedback_mount_only_query_param_effects in memory for why a mount-only effect would miss that.
  useEffect(() => {
    const cat = searchParams.get('category');
    if (cat && TOOL_CATEGORIES.some((c) => c.key === cat)) setActiveCategory(cat);
  }, [searchParams]);
  const activeTools = TOOL_CATEGORIES.find((c) => c.key === activeCategory)?.tools || [];

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('tools.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('tools.subtitle')}</p>
        </div>

        <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
          {TOOL_CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              type="button"
              onClick={() => setActiveCategory(cat.key)}
              className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', activeCategory === cat.key ? 'bg-primary text-white' : 'text-text-muted')}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden">
          {activeTools.map((tool) => (
            <div
              key={tool.to}
              onClick={() => navigate(tool.to)}
              className="p-4 flex items-center justify-between hover:bg-surface-container/20 transition-colors cursor-pointer group"
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center shrink-0">
                  <span className="text-xl">{tool.icon}</span>
                </div>
                <div>
                  <p className="font-bold text-primary text-sm">{t(tool.titleKey)}</p>
                  <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t(tool.descKey)}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {tool.favKey && <FavoriteButton itemKey={tool.favKey} />}
                <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
