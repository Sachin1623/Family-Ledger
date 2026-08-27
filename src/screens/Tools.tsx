import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FavoriteButton } from '../components/FavoriteButton';
import { useLanguage } from '../context/LanguageContext';

const TOOLS = [
  { to: '/progress', favKey: 'progress', icon: '🏆', titleKey: 'tools.progress', descKey: 'tools.progressDesc' },
  { to: '/friends', favKey: 'friends', icon: '🧑‍🤝‍🧑', titleKey: 'tools.friends', descKey: 'tools.friendsDesc' },
  { to: '/todo', favKey: 'todo', icon: '✅', titleKey: 'tools.todo', descKey: 'tools.todoDesc' },
  { to: '/expense-reminders', favKey: 'expense-reminders', icon: '🔔', titleKey: 'tools.expenseReminders', descKey: 'tools.expenseRemindersDesc' },
  { to: '/shopping-lists', favKey: 'shopping-lists', icon: '🛒', titleKey: 'tools.shoppingLists', descKey: 'tools.shoppingListsDesc' },
  { to: '/personal-loans', favKey: 'personal-loans', icon: '🤝', titleKey: 'tools.personalLoans', descKey: 'tools.personalLoansDesc' },
  { to: '/calculator', favKey: 'calculator', icon: '🧮', titleKey: 'tools.calculator', descKey: 'tools.calculatorDesc' },
  { to: '/financial-calculators', favKey: 'financial-calculators', icon: '🏦', titleKey: 'tools.financialCalculators', descKey: 'tools.financialCalculatorsDesc' },
  { to: '/games', favKey: null, icon: '🎮', titleKey: 'tools.games', descKey: 'tools.gamesDesc' },
  { to: '/health', favKey: 'health', icon: '🩺', titleKey: 'tools.health', descKey: 'tools.healthDesc' },
];

export default function Tools() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('tools.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('tools.subtitle')}</p>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden">
          {TOOLS.map((tool) => (
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
