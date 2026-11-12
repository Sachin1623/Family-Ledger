import React from 'react';
import ShoppingFab from './ShoppingFab';
import TodoFab from './TodoFab';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import VoiceQuickAdd from './VoiceQuickAdd';
import QuestFab from './QuestFab';
import { DialItem, useDialSlot, useFabDial, setDialOpen } from './FabDial';
import { speechAvailableHere } from '../lib/speech';
import { clsx } from 'clsx';
import { useShopMode } from '../context/ShopModeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useFabAction } from '../context/FabActionContext';

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
  { to: '/', icon: '🏠', labelKey: 'nav.home' },
  // the real `call_split` Material Symbol, the same one the group card's "Split Enabled" badge uses, so it reads as the same "split" idea
  { to: '/settlements', materialIcon: 'call_split', labelKey: 'nav.settleUp', tour: 'nav-settlements' },
  { to: '/analysis', icon: '📊', labelKey: 'nav.insights', tour: 'nav-analysis' },
  { to: '/goals', icon: '🎯', labelKey: 'nav.goals' },
  // Tools became "More": everything else, searchable. Chat moved up into the header, next to the bell.
  { to: '/tools', icon: '⋯', labelKey: 'nav.more', tour: 'nav-tools' },
];

// Pages where "Add Expense" has no meaning at all — no floating action button shown, rather than
// one whose target doesn't belong there. Exact-path entries plus two prefix/pattern checks below
// (every game screen, and any group's own Manage tab) since those aren't single fixed paths.
const HIDDEN_FAB_EXACT_PATHS = new Set([
  '/health/blood-pressure',
  '/friends',
  '/progress',
  // flame styles and badges: a page of its own to browse and tap, so no floating buttons over it
  '/my-style',
  // the to-do page has its own add bar above the bottom bar
  '/todo',
  '/profile/visibility',
  '/health/glucose',
  '/create-group',
  // Own account settings — "Add Expense" has no relationship to anything on this page.
  '/profile',
]);
function isHiddenFabPath(pathname: string): boolean {
  if (HIDDEN_FAB_EXACT_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/games')) return true;
  // a person's profile page (their own or someone else's): no floating buttons over it
  if (pathname.startsWith('/u/')) return true;
  // a shopping list has its own add-item bar above the bottom bar
  if (pathname.startsWith('/shopping-lists/')) return true;
  if (/^\/groups\/[^/]+\/manage$/.test(pathname)) return true;
  // Every baby-vaccinations screen except the dashboard itself already has its own primary
  // action (Save Visit, Send Invite, ...) in a bottom bar — a second "Add Expense"-flavored FAB
  // floating over it would just compete for the same corner.
  if (pathname.startsWith('/baby-vaccinations/') && pathname !== '/baby-vaccinations') return true;
  // Every /admin page (dashboard + every child page: users, analytics, growth, feedback, ...) —
  // an admin operating on other people's accounts should never see a button to add THEIR OWN
  // expense floating over it.
  if (pathname.startsWith('/admin')) return true;
  return false;
}

// Pages with their own, more relevant "add" action — each registers it via usePageFabAction
// (FabActionContext.tsx) while mounted, read here through `fabAction`.
const ACTION_FAB_PATHS = new Set([
  '/health/medicines',
  '/expense-reminders',
  '/personal-loans',
  '/todo',
  '/shopping-lists',
  '/baby-vaccinations',
  '/recurring-expenses',
]);

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
  const { fabAction } = useFabAction();
  const navigate = useNavigate();
  const [showVoice, setShowVoice] = React.useState(false);
  const dial = useFabDial();
  const [menuDot, setMenuDot] = React.useState<boolean>(() => !!(window as any).flMenuDot);
  React.useEffect(() => {
    const on = () => setMenuDot(!!(window as any).flMenuDot);
    window.addEventListener('fl-menu-dot', on);
    return () => window.removeEventListener('fl-menu-dot', on);
  }, []);
  // the shortcuts fold away whenever the person moves to another screen or presses Escape
  React.useEffect(() => { setDialOpen(false); }, [location.pathname]);
  React.useEffect(() => {
    if (!dial.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDialOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dial.open]);
  // a long press on Add Expense opens the shortcuts too (the tap still adds an expense)
  const pressTimer = React.useRef<number | null>(null);
  const longPressed = React.useRef(false);
  const links = shopMode ? SHOP_LINKS : PERSONAL_LINKS;

  // The floating action button is "Add Expense" everywhere by default, but that action has no
  // meaning anywhere under Goals — swapped for "New Goal"/"New Account" on GoalsHub's own matching
  // tab (read straight off ?tab=, which GoalsHub keeps synced to the URL), and hidden entirely on
  // every other Goals child page (GoalDetail, GoalWizard, GoalFundingSetup, the standalone
  // /goals/accounts /goals/allocate /goals/reports routes, and GoalsHub's own Reports/Allocation
  // tabs) rather than showing an Add Expense button that doesn't belong there. `openAdd=1` is a
  // deep-link AccountsHub reacts to (see its own openAddParam effect) to open the Add Account form
  // the same way `?open=<id>` already opens a specific existing account.
  //
  // A further set of pages has its own more relevant "add" concept (Medicine Reminders -> Add
  // Incident, Personal Loans -> New Entry, etc.) — those swap in the page's own registered
  // `fabAction` (see FabActionContext.tsx / usePageFabAction), and a last set has no add concept
  // at all (trackers, games, group management) and hides the button entirely (isHiddenFabPath).
  const isGoalsArea = location.pathname === '/goals' || location.pathname.startsWith('/goals/');
  const goalsTab = location.pathname === '/goals' ? searchParams.get('tab') : null;
  let fab: { to?: string; onClick?: () => void; label: string; icon: string; tour?: string } | null = null;
  if (shopMode) {
    fab = null;
  } else if (isHiddenFabPath(location.pathname)) {
    fab = null;
  } else if (goalsTab === 'goals') {
    fab = { to: '/goals/new?from=goals', label: t('goals.newGoal'), icon: '🎯', tour: 'goals-list-fab-hint' };
  } else if (goalsTab === 'accounts') {
    fab = { to: '/goals?tab=accounts&openAdd=1', label: t('accounts.addAccount'), icon: '🏦' };
  } else if (isGoalsArea) {
    fab = null;
  } else if (location.pathname === '/policies') {
    fab = { to: '/policies/new', label: t('policies.addPolicy'), icon: '🛡️' };
  } else if (ACTION_FAB_PATHS.has(location.pathname) && fabAction) {
    fab = { onClick: fabAction.onClick, label: fabAction.label, icon: fabAction.icon };
  } else if (location.pathname !== '/add-expense') {
    fab = { to: '/add-expense', label: t('nav.addExpense'), icon: '➕', tour: 'nav-add-expense' };
  }

  // A mic beside the Add Expense button: say the expense, then land on Add Expense already filled in. Only where Add Expense itself is the button.
  const showMic = !!fab && fab.to === '/add-expense' && speechAvailableHere();
  const talkSlot = useDialSlot('talk', showMic);

  return (
    <>
      <QuestFab />
      <TodoFab />
      <ShoppingFab />
      {showVoice && (
        <VoiceQuickAdd
          onDone={() => setShowVoice(false)}
          afterAdd={() => { if (location.pathname !== '/') navigate('/'); }}
        />
      )}
      {dial.open && <div className="fixed inset-0 z-[39] bg-[#06222f]/45 backdrop-blur-[1px]" onClick={() => setDialOpen(false)} aria-hidden="true" />}
      {showMic && (
        <DialItem slot={talkSlot} label="Talk an expense" ariaLabel={t('voiceExpense.talk')} onClick={() => setShowVoice(true)}>
          <span className="material-symbols-outlined text-[26px] text-[#06222f]">mic</span>
        </DialItem>
      )}
      {fab && (fab.to ? (
        <div className="fixed right-4 z-40 flex items-center gap-2" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}>
          {dial.count > 0 && (
            <button
              type="button"
              onClick={() => setDialOpen(!dial.open)}
              aria-label={dial.open ? 'Close shortcuts' : dial.pendingCount > 0 ? `More shortcuts, ${dial.pendingCount} waiting` : 'More shortcuts'}
              aria-expanded={dial.open}
              className="relative w-12 h-12 rounded-full bg-white text-[#06222f] border-2 border-[#06222f] shadow-lg flex items-center justify-center active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[26px] transition-transform duration-200" style={{ transform: dial.open ? 'rotate(45deg)' : 'none' }}>{dial.open ? 'add' : 'apps'}</span>
              {!dial.open && dial.pendingCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-error text-white text-[11px] font-black flex items-center justify-center shadow ring-2 ring-white">{dial.pendingCount}</span>
              )}
            </button>
          )}
          <NavLink
            key={fab.to}
            to={fab.to}
            data-tour={fab.tour}
            onPointerDown={() => { longPressed.current = false; pressTimer.current = window.setTimeout(() => { longPressed.current = true; if (dial.count > 0) setDialOpen(true); }, 450); }}
            onPointerUp={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
            onPointerLeave={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
            onClick={(e) => { if (longPressed.current && dial.count > 0) { e.preventDefault(); longPressed.current = false; } else setDialOpen(false); }}
            className="flex items-center gap-2 pl-4 pr-5 h-12 rounded-full bg-primary text-white font-bold text-sm shadow-lg active:scale-95 transition-transform"
          >
            <span className="text-lg leading-none">{fab.icon}</span>
            {fab.label}
          </NavLink>
        </div>
      ) : (
        <button
          type="button"
          onClick={fab.onClick}
          data-tour={fab.tour}
          className="fixed right-4 z-40 flex items-center gap-2 pl-4 pr-5 h-12 rounded-full bg-primary text-white font-bold text-sm shadow-lg active:scale-95 transition-transform"
          style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
        >
          <span className="text-lg leading-none">{fab.icon}</span>
          {fab.label}
        </button>
      ))}
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
                    {link.to === '/tools' && menuDot && !shopMode && (
                      <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-error border-2 border-white" aria-label="Something is waiting in the menu" />
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
