import Health from './Health';
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { arrayRemove, arrayUnion, collection, doc, query as query_, updateDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { todayLocalDateString } from '../lib/dateUtils';
import { isMedicineDueOn, type Medicine } from '../lib/medicines';
import { FavoriteButton } from '../components/FavoriteButton';
import { useLanguage } from '../context/LanguageContext';
import { openCalculator } from '../lib/calculatorRef';

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
      { to: '/policies', favKey: 'policy-vault', icon: '🛡️', titleKey: 'tools.policyVault', descKey: 'tools.policyVaultDesc' },
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
      { to: '/games/rummy13', favKey: 'game-rummy13', icon: '🎴', titleKey: 'games.rummy13', descKey: 'games.rummy13Desc' },
      { to: '/games/business', favKey: 'game-business', icon: '🏙️', titleKey: 'games.business', descKey: 'games.businessDesc' },
      { to: '/games/sweep', favKey: 'game-sweep', icon: '🧹', titleKey: 'games.sweep', descKey: 'games.sweepDesc' },
      { to: '/games/sequence', favKey: 'game-sequence', icon: '🔴', titleKey: 'games.sequence', descKey: 'games.sequenceDesc' },
      { to: '/games/spadePledge', favKey: 'game-spadePledge', icon: '♠️', titleKey: 'games.spadePledge', descKey: 'games.spadePledgeDesc' },
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
      { to: '/baby-vaccinations', favKey: 'baby-vaccinations', icon: '👶', titleKey: 'babyVax.tracker', descKey: 'babyVax.trackerDesc' },
    ],
  },
];

// Poster look for the Games page: each game its own colour, a big emoji, a one-line blurb and a tag.
type GameKind = 'solo' | 'cards' | 'board';
const GAME_POSTERS: Record<string, { from: string; to: string; short: string; tag: string; kind: GameKind }> = {
  'game-sudoku': { from: '#16a34a', to: '#0f5c2a', short: '1,500+ puzzles · offline', tag: 'SOLO', kind: 'solo' },
  'game-scramble': { from: '#2563eb', to: '#1a3d8f', short: 'Solo or race up to 4', tag: 'SOLO · ONLINE', kind: 'solo' },
  'game-chess': { from: '#475569', to: '#1e293b', short: '2 players, online', tag: 'ONLINE', kind: 'board' },
  'game-ludo': { from: '#dc2626', to: '#7f1d1d', short: 'Up to 4 players', tag: 'ONLINE', kind: 'board' },
  'game-rummy': { from: '#7c3aed', to: '#4c1d95', short: '3 decks, 2 jokers', tag: 'ONLINE', kind: 'cards' },
  'game-rummy13': { from: '#be185d', to: '#6b0f3a', short: 'Single deal or Pool 101/201', tag: 'ONLINE', kind: 'cards' },
  'game-business': { from: '#0f766e', to: '#0e4f5c', short: 'Indian city board', tag: 'ONLINE', kind: 'board' },
  'game-sweep': { from: '#d97706', to: '#78350f', short: '2 or 4 players', tag: 'ONLINE', kind: 'cards' },
  'game-sequence': { from: '#0891b2', to: '#0b4f66', short: 'Line up 5 chips', tag: 'ONLINE', kind: 'board' },
  'game-spadePledge': { from: '#334155', to: '#0f172a', short: 'Bid and take tricks', tag: 'ONLINE', kind: 'cards' },
};

// How each category looks on the Tools home: a colour, an emoji, one line of what's inside.
const CATEGORY_STYLE: Record<string, { from: string; to: string; emoji: string; blurb: string }> = {
  health: { from: '#0f766e', to: '#0e4f5c', emoji: '💚', blurb: 'Medicines, glucose, BP, baby vaccines' },
  games: { from: '#5a2b7a', to: '#2a1240', emoji: '🎲', blurb: 'Play with family, solo or online' },
  finance: { from: '#1d5a8a', to: '#0f2f4a', emoji: '🏦', blurb: 'Loans, policies, calculators' },
  productivity: { from: '#c2410c', to: '#7c2d12', emoji: '✅', blurb: 'To-dos, reminders, shopping' },
  social: { from: '#be185d', to: '#6b0f3a', emoji: '🧑‍🤝‍🧑', blurb: 'Friends & progress' },
};
const HOME_ORDER = ['health', 'games', 'finance', 'productivity', 'social'];

export default function Tools() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { user, profile } = useAuth();
  const [searchParams] = useSearchParams();
  // null = the Tools home (category cards); otherwise the opened category.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [gameFilter, setGameFilter] = useState<'all' | GameKind>('all');
  // Deep-link from the header menu's category shortcuts (?category=games, etc.) — keyed on the
  // live searchParams object, not mount-only, since navigating here again while already on /tools
  // (clicking a different header-menu shortcut) doesn't remount this component. See
  // feedback_mount_only_query_param_effects in memory for why a mount-only effect would miss that.
  useEffect(() => {
    const cat = searchParams.get('category');
    if (cat && TOOL_CATEGORIES.some((c) => c.key === cat)) setActiveCategory(cat);
  }, [searchParams]);

  // Opening a category is a normal navigation (/tools?category=…), so the header's back arrow returns to this
  // Tools home. Tapping the Tools tab again (a fresh navigation to /tools with no ?category) returns to the Tools home.
  const location = useLocation();
  useEffect(() => {
    if (!new URLSearchParams(location.search).get('category')) {
      setActiveCategory(null);
      setQuery('');
    }
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (tool: ToolEntry) => (tool.to === '/calculator' ? openCalculator() : navigate(tool.to));

  // Today's medicine doses — the one live line on the Tools home (the same small reads the Health home does).
  const todayStr = todayLocalDateString();
  const [medsValue] = useCollection(user ? query_(collection(db, 'medicines'), where('userId', '==', user.uid)) : null);
  const [dosesValue] = useCollection(user ? query_(collection(db, 'medicineLogs'), where('userId', '==', user.uid), where('dateStr', '==', todayStr)) : null);
  const dosesLeft = useMemo(() => {
    const meds = (medsValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) } as Medicine)).filter((m) => m.active !== false && isMedicineDueOn(m, todayStr));
    const total = meds.reduce((n, m) => n + (m.times?.length || 0), 0);
    return total === 0 ? null : Math.max(0, total - (dosesValue?.docs.length || 0));
  }, [medsValue, dosesValue, todayStr]);

  const allTools = useMemo(() => TOOL_CATEGORIES.flatMap((c) => c.tools.map((tool) => ({ ...tool, category: c.key, categoryLabel: c.label }))), []);
  const favorites: string[] = profile?.favorites || [];
  const favoriteTools = allTools.filter((tool) => tool.favKey && favorites.includes(tool.favKey));
  const q = query.trim().toLowerCase();
  const matches = q ? allTools.filter((tool) => `${t(tool.titleKey)} ${t(tool.descKey)} ${tool.categoryLabel}`.toLowerCase().includes(q)) : [];

  const row = (tool: ToolEntry & { categoryLabel?: string }) => (
    <div
      key={tool.to}
      role="button"
      tabIndex={0}
      onClick={() => open(tool)}
      onKeyDown={(e) => { if (e.key === 'Enter') open(tool); }}
      className="flex items-center gap-3 rounded-2xl bg-white border border-slate-200 px-3 py-2.5 shadow-sm cursor-pointer active:scale-[0.99] transition-transform"
    >
      <div className="w-11 h-11 rounded-2xl bg-slate-100 flex items-center justify-center text-xl shrink-0">{tool.icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-black text-slate-900 truncate">{t(tool.titleKey)}</p>
        <p className="text-[11px] font-semibold text-slate-500 leading-snug">{t(tool.descKey)}{tool.categoryLabel ? ` · ${tool.categoryLabel}` : ''}</p>
      </div>
      {tool.favKey && <FavoriteButton itemKey={tool.favKey} />}
      <span className="material-symbols-outlined text-slate-300 text-[20px]">chevron_right</span>
    </div>
  );

  const toggleFavorite = async (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    if (!user) return;
    await updateDoc(doc(db, 'users', user.uid), { favorites: favorites.includes(key) ? arrayRemove(key) : arrayUnion(key) }).catch((err) => console.error('Failed to toggle favorite:', err));
  };

  const posterGrid = (tools: ToolEntry[]) => {
    const shown = tools.filter((tool) => gameFilter === 'all' || GAME_POSTERS[tool.favKey || '']?.kind === gameFilter);
    return (
      <>
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {([['all', 'All'], ['solo', 'Solo'], ['cards', 'Cards'], ['board', 'Board']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setGameFilter(id)} className={clsx('shrink-0 px-4 py-2 rounded-full text-[11px] font-extrabold border-[1.5px] transition-colors', gameFilter === id ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200')}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {shown.map((tool) => {
            const st = GAME_POSTERS[tool.favKey || ''];
            if (!st) return row(tool);
            const fav = !!tool.favKey && favorites.includes(tool.favKey);
            return (
              <div
                key={tool.to}
                role="button"
                tabIndex={0}
                onClick={() => open(tool)}
                onKeyDown={(e) => { if (e.key === 'Enter') open(tool); }}
                className="relative overflow-hidden rounded-[1.4rem] p-3.5 min-h-[132px] text-white shadow-md cursor-pointer active:scale-[0.97] transition-transform"
                style={{ background: `linear-gradient(135deg, ${st.from}, ${st.to})` }}
              >
                <p className="text-[14px] font-black leading-tight pr-6">{t(tool.titleKey)}</p>
                <p className="text-[10px] font-bold text-white/85 mt-1 max-w-[6.2rem] leading-snug">{st.short}</p>
                <span className="inline-block mt-2.5 text-[8.5px] font-black bg-white/20 px-2 py-1 rounded-full">{st.tag}</span>
                <span className="absolute right-1.5 bottom-0.5 text-[46px] leading-none drop-shadow-[0_4px_8px_rgba(0,0,0,0.4)]">{tool.icon}</span>
                {tool.favKey && (
                  <button type="button" onClick={(e) => toggleFavorite(e, tool.favKey!)} className="absolute right-1.5 top-1.5 p-1.5" aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}>
                    <span className="material-symbols-outlined text-[20px] block" style={{ color: fav ? '#fbbf24' : 'rgba(255,255,255,0.6)', fontVariationSettings: `'FILL' ${fav ? 1 : 0}` }}>star</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const card = (key: string, size: 'full' | 'half' | 'slim') => {
    const cat = TOOL_CATEGORIES.find((c) => c.key === key);
    const st = CATEGORY_STYLE[key];
    if (!cat || !st) return null;
    const live = key === 'health' && dosesLeft !== null ? (dosesLeft === 0 ? 'All doses done today' : `${dosesLeft} dose${dosesLeft === 1 ? '' : 's'} left today`) : null;
    return (
      <button
        key={key}
        type="button"
        onClick={() => navigate(`/tools?category=${key}`)}
        className={clsx('relative block w-full overflow-hidden rounded-3xl text-left text-white shadow-md active:scale-[0.985] transition-transform', size === 'full' ? 'p-4 pr-28 min-h-[112px]' : size === 'half' ? 'p-3.5 min-h-[104px]' : 'p-3.5 pr-24 min-h-[84px]')}
        style={{ background: `linear-gradient(135deg, ${st.from}, ${st.to})` }}
      >
        <p className={clsx('font-black', size === 'full' ? 'text-[17px]' : 'text-[15px]')}>{cat.label}</p>
        <p className="text-[10.5px] font-bold text-white/85 mt-0.5 leading-snug">{size === 'half' ? `${cat.tools.length} tools` : st.blurb}</p>
        {size !== 'half' && (
          <span className="inline-block mt-2 text-[9.5px] font-black bg-white/20 px-2.5 py-1 rounded-full">{live || `${cat.tools.length} tools`}</span>
        )}
        <span className={clsx('absolute right-3 bottom-1 leading-none drop-shadow-[0_4px_10px_rgba(0,0,0,0.35)]', size === 'full' ? 'text-[58px]' : 'text-[42px]')}>{st.emoji}</span>
      </button>
    );
  };

  const activeCat = activeCategory ? TOOL_CATEGORIES.find((c) => c.key === activeCategory) : null;
  const activeStyle = activeCategory ? CATEGORY_STYLE[activeCategory] : null;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        {!activeCat ? (
          <>
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3.5 py-2.5 shadow-sm">
              <span className="material-symbols-outlined text-slate-400 text-[20px]">search</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tools…" className="flex-1 min-w-0 bg-transparent outline-none text-sm font-semibold text-slate-800 placeholder:text-slate-400" />
              {query && <button onClick={() => setQuery('')} className="text-slate-400" aria-label="Clear search"><span className="material-symbols-outlined text-[18px] block">close</span></button>}
            </div>

            {q ? (
              <div className="space-y-2">
                {matches.length === 0 && <p className="text-sm font-semibold text-slate-500 text-center py-8">No tool matches “{query}”.</p>}
                {matches.map((tool) => row(tool))}
              </div>
            ) : (
              <>
                {card('health', 'full')}
                {card('games', 'full')}
                <div className="grid grid-cols-2 gap-3">
                  {card('finance', 'half')}
                  {card('productivity', 'half')}
                </div>
                {card('social', 'slim')}

                {favoriteTools.length > 0 && (
                  <section className="space-y-2 pt-1">
                    <h2 className="text-[10px] font-black tracking-[0.14em] text-slate-500 px-1">⭐ FAVOURITES</h2>
                    <div className="space-y-2">{favoriteTools.map((tool) => row(tool))}</div>
                  </section>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {activeStyle && (
              <div className="relative overflow-hidden rounded-3xl p-4 text-white shadow-md" style={{ background: `linear-gradient(135deg, ${activeStyle.from}, ${activeStyle.to})` }}>
                <h1 className="text-xl font-black">{activeCat.label}</h1>
                <p className="text-[11px] font-bold text-white/85 mt-0.5">{activeStyle.blurb}</p>
                <span className="absolute right-3 bottom-0 text-[52px] leading-none drop-shadow-[0_4px_10px_rgba(0,0,0,0.35)]">{activeStyle.emoji}</span>
              </div>
            )}
            {activeCat.key === 'health' ? <Health embedded /> : activeCat.key === 'games' ? posterGrid(activeCat.tools) : <div className="space-y-2">{activeCat.tools.map((tool) => row(tool))}</div>}
          </>
        )}
      </main>
    </div>
  );
}
