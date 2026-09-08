import React from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
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
// Goals/Accounts: pulled from nav on 2026-08-31 over a money-tracking invariant that didn't hold
// (goals could be credited both by Post-This-Month's-Savings AND by real account-balance sync,
// independently — see accountAllocations.ts's header comment for the full "Reserve-on-target-met,
// accounts-only funding" rework that fixed it). Goals now only ever gain money through
// applyAccountChange() — Post Month's Savings only ever credits Cash Savings — so re-enabled here
// for good on 2026-09-04.
const PERSONAL_LINKS = [
  { to: '/', icon: '👥', labelKey: 'nav.groups' },
  // Renamed from "Balances"/💰 — icon deliberately the real `call_split` Material Symbol (the
  // same one GroupCard's "Split Enabled" badge uses), not an emoji substitute, so it reads as the
  // exact same "split" concept elsewhere in the app. The one exception to this file's own emoji
  // pilot (see header comment) — a per-request deviation, not a reversal of that direction.
  { to: '/settlements', materialIcon: 'call_split', labelKey: 'nav.balances', tour: 'nav-settlements' },
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
  const [searchParams] = useSearchParams();
  // Count of distinct DM chats with unread messages for me — not a total message count, per
  // spec (a badge showing "37" for one very chatty conversation would be more noise than signal
  // on a small bottom-nav icon).
  const { unreadChatCount } = useDmChats(shopMode ? undefined : user?.uid);
  const links = shopMode ? SHOP_LINKS : PERSONAL_LINKS;

  // The floating action button is "Add Expense" everywhere by default, but that action has no
  // meaning anywhere under Goals — swapped for "New Goal"/"New Account" on GoalsHub's own matching
  // tab (read straight off ?tab=, which GoalsHub keeps synced to the URL), and hidden entirely on
  // every other Goals child page (GoalDetail, GoalWizard, GoalFundingSetup, the standalone
  // /goals/accounts /goals/allocate /goals/reports routes, and GoalsHub's own Reports/Allocation
  // tabs) rather than showing an Add Expense button that doesn't belong there. `openAdd=1` is a
  // deep-link AccountsHub reacts to (see its own openAddParam effect) to open the Add Account form
  // the same way `?open=<id>` already opens a specific existing account.
  const isGoalsArea = location.pathname === '/goals' || location.pathname.startsWith('/goals/');
  const goalsTab = location.pathname === '/goals' ? searchParams.get('tab') : null;
  let fab: { to: string; label: string; icon: string; tour?: string } | null = null;
  if (shopMode) {
    fab = null;
  } else if (goalsTab === 'goals') {
    fab = { to: '/goals/new?from=goals', label: t('goals.newGoal'), icon: '🎯' };
  } else if (goalsTab === 'accounts') {
    fab = { to: '/goals?tab=accounts&openAdd=1', label: t('accounts.addAccount'), icon: '🏦' };
  } else if (isGoalsArea) {
    fab = null;
  } else if (location.pathname !== '/add-expense') {
    fab = { to: '/add-expense', label: t('nav.addExpense'), icon: '➕', tour: 'nav-add-expense' };
  }

  return (
    <>
      {fab && (
        <NavLink
          key={fab.to}
          to={fab.to}
          data-tour={fab.tour}
          className="fixed right-4 z-40 flex items-center gap-2 pl-4 pr-5 h-12 rounded-full bg-primary text-white font-bold text-sm shadow-lg active:scale-95 transition-transform"
          style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
        >
          <span className="text-lg leading-none">{fab.icon}</span>
          {fab.label}
        </NavLink>
      )}
      {/* pb-[env(safe-area-inset-bottom)] pushes the actual tap targets (the h-16 row below) up
          above the device's own gesture/home-indicator area on iOS, and Android's equivalent — the
          nav's real height used to stop exactly at the physical screen edge, right where an
          accidental OS-level back-swipe/gesture is most likely to land. Evaluates to 0 with no
          layout change on devices/browsers with no inset (most Android phones, desktop web).
          z-30 (not z-50) is deliberate — every floating modal in the app (Add Account, Add Goal,
          the Spend Categories panel, etc.) uses `fixed inset-0 z-50` as its own backdrop, but
          this <Navigation/> is mounted AFTER a screen's own modal content in the DOM (it's a
          sibling rendered at the end of AuthenticatedLayout, not inside the screen itself). Two
          elements tied at the same z-index stack by DOM order, so at z-50 this nav bar was always
          winning that tie and painting over the bottom of every modal — including whatever
          primary action button happened to sit there. Sitting one layer below the z-50 modal
          convention (but still above ordinary page content, which has no explicit z-index) fixes
          every current and future floating window at once, instead of bumping z-index on dozens
          of individual modals. */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-border-subtle flex flex-col z-30 pb-[env(safe-area-inset-bottom)]">
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
                      {(link as any).materialIcon ? (
                        <span className="material-symbols-outlined text-[22px] block">{(link as any).materialIcon}</span>
                      ) : link.icon}
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
