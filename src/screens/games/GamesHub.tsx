import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FavoriteButton } from '../../components/FavoriteButton';
import { useLanguage } from '../../context/LanguageContext';

const GAMES = [
  {
    to: '/games/sudoku',
    favKey: 'game-sudoku',
    icon: '🔢',
    titleKey: 'games.sudoku',
    descKey: 'games.sudokuDesc',
    available: true,
  },
  {
    to: '/games/scramble',
    favKey: 'game-scramble',
    icon: '🔤',
    titleKey: 'games.scramble',
    descKey: 'games.scrambleDesc',
    available: true,
  },
  {
    to: '/games/chess',
    favKey: 'game-chess',
    icon: '♟️',
    titleKey: 'games.chess',
    descKey: 'games.chessDesc',
    available: true,
  },
  {
    to: '/games/ludo',
    favKey: 'game-ludo',
    icon: '🎲',
    titleKey: 'games.ludo',
    descKey: 'games.ludoDesc',
    available: true,
  },
  {
    to: '/games/rummy',
    favKey: 'game-rummy',
    icon: '🃏',
    titleKey: 'games.rummy',
    descKey: 'games.rummyDesc',
    available: true,
  },
  {
    to: '/games/business',
    favKey: 'game-business',
    icon: '🏙️',
    titleKey: 'games.business',
    descKey: 'games.businessDesc',
    available: true,
  },
  {
    to: '/games/sweep',
    favKey: 'game-sweep',
    icon: '🧹',
    titleKey: 'games.sweep',
    descKey: 'games.sweepDesc',
    available: true,
  },
  {
    to: '/games/sequence',
    favKey: 'game-sequence',
    icon: '🔴',
    titleKey: 'games.sequence',
    descKey: 'games.sequenceDesc',
    available: true,
  },
];

export default function GamesHub() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('games.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('games.subtitle')}</p>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden" data-tour="games-grid">
          {GAMES.map((game) => (
            <div
              key={game.titleKey}
              onClick={() => game.available && navigate(game.to)}
              className={`p-4 flex items-center justify-between transition-colors group ${
                game.available ? 'hover:bg-surface-container/20 cursor-pointer' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center shrink-0">
                  <span className="text-xl">{game.icon}</span>
                </div>
                <div>
                  <p className="font-bold text-primary text-sm">{t(game.titleKey)}</p>
                  <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t(game.descKey)}</p>
                </div>
              </div>
              {game.available && (
                <div className="flex items-center gap-1 shrink-0">
                  <FavoriteButton itemKey={game.favKey} />
                  <span className="material-symbols-outlined text-text-muted group-hover:translate-x-1 transition-transform">chevron_right</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
