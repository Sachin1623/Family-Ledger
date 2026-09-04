import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
import { useShopMode } from '../context/ShopModeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useDmChats } from '../lib/useDmChats';

// Pilot for the app-wide "vibrant, colorful icons" pass — native emoji instead of monochrome
// Material Symbols. Zero new dependency (every OS/browser renders emoji in full color already,
// no icon font/asset to bundle), starting here since the bottom nav is the single most-seen
// piece of UI in the app. If this direction lands well, the same swap extends everywhere else
// Material Symbols is still used.
// "Add Expense" used to live here as the 7th tab (a special big-plus styled one — see git
// history) — it's now a floating action button instead (below), always reachable without
// competing for space with the rest of the nav.
// Goals/Accounts: temporarily re-enabled for local/mobile testing only (2026-08-31) — the
// money-tracking invariant across Accounts, Goals, and monthly savings posting still isn't fixed
// (see memory: project_goals_accounts_shelved), so this should go back out before any real publish
// to Cloud Run/Play Store until that's resolved.
// "Add Expense" used to live here as the 7th tab (a special big-plus styled one — see git
// history) — it's now a floating action button instead (below), always reachable without
// competing for space with the rest of the nav.
const PERSONAL_LINKS = [
  { to: '/', icon: '👥', labelKey: 'nav.groups' },
  { to: '/settlements', icon: '💰', labelKey: 'nav.balances', tour: 'nav-settlements' },
  { to: '/analysis', icon: '📊', labelKey: 'nav.analysis', tour: 'nav-analysis' },
  { to: '/chat', icon: '💬', labelKey: 'nav.chat' },
  { to: '/goals', icon: '🎯', labelKey: 'nav.goals' },
  { to: '/tools', icon: '🛠️', labelKey: 'nav.tools', tour: 'nav-tools' },
];

const SHOP_LINKS = [
  { to: '/shop/sales', icon: '💳', labelKey: 'nav.sales' },
  { to: '/shop/customers', icon: '👥', labelKey: 'nav.customers' },
  { to: '/shop/reports', icon: '📈', labelKey: 'nav.reports' },
  { to: '/shop/profile', icon: '🏪', labelKey: 'nav.shop' },
];

export default function Navigation() {
  const { shopMode } = useShopMode();
  const { user } = useAuth();
  const { t } = useLanguage();
  const location = useLocation();
  // Count of distinct DM chats with unread messages for me — not a total message count, per
  // spec (a badge showing "37" for one very chatty conversation would be more noise than signal
  // on a small bottom-nav icon).
  const { unreadChatCount } = useDmChats(shopMode ? undefined : user?.uid);
  const links = shopMode ? SHOP_LINKS : PERSONAL_LINKS;
  // Hidden in shop mode (no expense-tracking concept there) and on the Add Expense screen itself
  // (it's a full-screen modal over whatever page was open — showing the button that opens it
  // stacked on top of itself would be redundant).
  const showAddExpenseFab = !shopMode && location.pathname !== '/add-expense';

  return (
    <>
      {showAddExpenseFab && (
        <NavLink
          to="/add-expense"
          data-tour="nav-add-expense"
          className="fixed right-4 z-40 flex items-center gap-2 pl-4 pr-5 h-12 rounded-full bg-primary text-white font-bold text-sm shadow-lg active:scale-95 transition-transform"
          style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
        >
          <span className="text-lg leading-none">➕</span>
          {t('nav.addExpense')}
        </NavLink>
      )}
      {/* pb-[env(safe-area-inset-bottom)] pushes the actual tap targets (the h-16 row below) up
          above the device's own gesture/home-indicator area on iOS, and Android's equivalent — the
          nav's real height used to stop exactly at the physical screen edge, right where an
          accidental OS-level back-swipe/gesture is most likely to land. Evaluates to 0 with no
          layout change on devices/browsers with no inset (most Android phones, desktop web). */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-border-subtle flex flex-col z-50 pb-[env(safe-area-inset-bottom)]">
        {/* Navigation Items Layer */}
        <div className="h-16 flex justify-around items-center">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              data-tour={(link as any).tour}
              className={({ isActive }) => clsx(
                'flex flex-col items-center justify-center w-full h-full gap-1 transition-all active:scale-90',
                isActive ? (shopMode ? 'text-[#7C3AED]' : 'text-primary') : 'text-text-muted'
              )}
            >
              {({ isActive }) => (
                <>
                  <div className="relative">
                    <div className={clsx(
                      'w-8 h-8 rounded-full flex items-center justify-center transition-all text-xl',
                      isActive && (shopMode ? 'bg-[#7C3AED]/10 scale-110' : 'bg-primary/10 scale-110')
                    )}>
                      {link.icon}
                    </div>
                    {link.to === '/chat' && unreadChatCount > 0 && (
                      <span className="absolute -top-0.5 -end-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-error text-white text-[9px] font-bold flex items-center justify-center border-2 border-white">
                        {unreadChatCount > 9 ? '9+' : unreadChatCount}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-bold">{t(link.labelKey)}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </>
  );
}
