import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useShopMode } from '../context/ShopModeContext';
import { useLanguage } from '../context/LanguageContext';
import GlobalSearch from './GlobalSearch';
import FeedPanel from './FeedPanel';
import { getParentPath } from '../lib/navigationParents';
import { setOpenFeedPanelFn } from '../lib/feedPanelRef';
import HeaderProfileBadge from './HeaderProfileBadge';
import { useAppUpdateAvailable, hardReloadApp } from '../lib/appUpdate';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile } = useAuth();
  const { hasShopAccess, shopMode, setShopMode } = useShopMode();
  const { t } = useLanguage();
  const isHome = location.pathname === '/';
  const isLogin = location.pathname === '/login';

  const toggleShopMode = () => {
    const next = !shopMode;
    setShopMode(next);
    navigate(next ? '/shop/sales' : '/');
  };

  // Unread feed count — cleared by ActivityFeed.tsx writing `lastFeedViewedAt` the moment it's
  // opened. Reuses the exact groupIds -> activities query shape already proven in
  // ActivityFeed.tsx (same firestore.rules path, no changes needed there).
  const groupIdsKey = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  )[0]?.docs.map((d) => d.data().groupId).slice().sort().join(',') || '';
  const groupIds = React.useMemo(() => (groupIdsKey ? groupIdsKey.split(',') : []), [groupIdsKey]);
  const [activitiesValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'activities'), where('groupId', 'in', groupIds)) : null,
  );
  // Personal notifications (pokes, game invites/pokes/chat, DMs, expense/todo/loan reminders —
  // see logFeedActivity in server.ts) have no groupId to fan out through, so they'd never bump
  // this badge without a separate query — same `userId == auth.uid` shape ActivityFeed.tsx's
  // personalActivitiesQuery already uses.
  const [personalActivitiesValue] = useCollection(
    user ? query(collection(db, 'activities'), where('userId', '==', user.uid)) : null,
  );
  const unreadFeedCount = React.useMemo(() => {
    const lastViewed = profile?.lastFeedViewedAt;
    const isNew = (createdAt: string | undefined) => !lastViewed || (createdAt && createdAt > lastViewed);
    // Group-scoped docs: `userId` is whoever CAUSED it — exclude your own actions (you added/
    // edited an expense, sent a chat message, etc.), same fix as the game/group chat dot below.
    const groupUnread = (activitiesValue?.docs || [])
      .filter((d) => {
        const data = d.data();
        return data.userId !== user?.uid && isNew(data.createdAt);
      })
      .map((d) => d.id);
    // Personal docs: `userId` here IS the recipient (always equal to the viewer's own uid, since
    // that's what this query filters on) — `personal: true` is what actually distinguishes "a
    // notification for me" from "my own group action that also lists me as userId" (those are
    // already covered, correctly excluded, by the group query above; counting them again here
    // would double-count them and never exclude them, since userId===self is true for ALL of
    // this query's results by construction). See logFeedActivity in server.ts.
    const personalUnread = (personalActivitiesValue?.docs || [])
      .filter((d) => {
        const data = d.data();
        return data.personal === true && isNew(data.createdAt);
      })
      .map((d) => d.id);
    return new Set([...groupUnread, ...personalUnread]).size;
  }, [activitiesValue, personalActivitiesValue, profile?.lastFeedViewedAt, user?.uid]);

  // Red header reload button: unlike UpdateBanner (a dismissible bottom nudge, still shown for
  // the same signal), this is deliberately always-visible and un-dismissable — it disappears on
  // its own the moment this tab's JS actually matches the latest deployed Cloud Run revision,
  // rather than staying dismissed while still running stale code.
  const { available: updateAvailable } = useAppUpdateAvailable();
  const [reloadingFromHeader, setReloadingFromHeader] = React.useState(false);

  const [isInIframe, setIsInIframe] = React.useState(false);

  React.useEffect(() => {
    setIsInIframe(window.self !== window.top);
  }, []);

  const openInNewWindow = () => {
    window.open(window.location.href, '_blank');
  };

  const getProfileImage = () => {
    if (profile?.photoURL && profile.photoURL.length > 0) return profile.photoURL;
    if (user?.photoURL && user.photoURL.length > 0) return user.photoURL;
    return null;
  };

  const profileImage = getProfileImage();
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [feedOpen, setFeedOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [feedGroupId, setFeedGroupId] = React.useState<string | undefined>(undefined);

  // Lets other components (a group card's Feed button, say) open this SAME slide-over — see
  // feedPanelRef.ts. Mirrors NavigationBridge's setNavigateFn registration pattern in App.tsx.
  React.useEffect(() => {
    setOpenFeedPanelFn((groupId) => {
      setFeedGroupId(groupId);
      setFeedOpen(true);
    });
    return () => setOpenFeedPanelFn(null);
  }, []);

  return (
    <header className={clsx(
      // `viewport-fit=cover` (index.html) lets the WebView draw edge-to-edge on iOS, which is
      // what makes the notch/status-bar icons overlap plain top-0 content in the first place —
      // padding-top adds the safe-area inset on top of the normal 0.5rem breathing room instead
      // of replacing it. Evaluates to just that 0.5rem on Android/web, where the inset is 0.
      //
      // Both direct children below are `shrink-0` (deliberately — see the comment on the left one),
      // so on a narrow enough device their combined natural width (back button + logo on the left,
      // up to 5 icon buttons + the profile badge on the right) can exceed the viewport. Without
      // `overflow-x-auto` that just silently clips whatever's rightmost — the profile badge, since
      // it's the last child — off the edge of the screen with no way to reach it. `no-scrollbar`
      // (index.css) hides the scrollbar so this reads as "everything fits" on every device that
      // genuinely has room, and only reveals a swipeable row on the few narrow ones that don't —
      // same idiom already used elsewhere in this app for horizontal-scroll strips.
      "sticky top-0 z-50 border-b px-4 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 flex items-center justify-between min-h-[60px] transition-colors overflow-x-auto no-scrollbar",
      shopMode ? "bg-[#7C3AED]/5 border-[#7C3AED]/20" : "bg-white border-border-subtle",
    )}>
      {/* `shrink-0` here is load-bearing — without it, this side has no protection against the
          right-hand icon cluster's natural width, and flexbox squeezes THIS side (specifically
          the logo <img>, a replaced element that visually shrinks to fit) instead of ever
          admitting the icon cluster doesn't fit. The logo must always render at its real size. */}
      <div className="flex items-center gap-2 shrink-0">
        {!isHome && !isLogin && (
          <button
            onClick={() => navigate(getParentPath(location.pathname, location.search))}
            className="w-10 h-10 rounded-full hover:bg-surface flex items-center justify-center text-primary transition-colors shrink-0"
          >
            {/* Material Symbols glyphs don't auto-mirror for RTL — a horizontal flip reads
                correctly since arrow_back is a simple directional chevron shape. */}
            <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
          </button>
        )}
        {/* logo.svg's own viewBox is 400x120 (a wide wordmark, not square) — `w-10 h-10` (a
            square box) was a real regression: object-contain then letterboxes it down to a
            sliver instead of showing the wordmark at readable size. `h-10 w-auto` lets it size
            to its natural ~3.3:1 ratio, so it actually reads as "FamilyLedger" again. */}
        <div
          onClick={() => navigate(shopMode ? '/shop/sales' : '/')}
          className="h-10 shrink-0 cursor-pointer transform active:scale-95 transition-transform"
        >
          <img src="/logo.svg" alt="FamilyLedger" className="h-full w-auto object-contain" />
        </div>
        {shopMode && (
          <span className="hidden sm:inline text-[9px] font-black uppercase tracking-widest text-[#7C3AED] bg-[#7C3AED]/10 px-2 py-1 rounded-full shrink-0">
            {t('header.shopMode')}
          </span>
        )}
      </div>

      {/* Shop/Feed live inside the overflow menu below now (see menuOpen); search has its own
          icon next to the bell (moved out of the menu per feedback — it's used often enough to
          deserve one tap, not two). This row's remaining elements are the reload nudge, search,
          the bell, the menu trigger, and the combined profile/level/coins badge. */}
      <div className="flex items-center gap-1.5 shrink-0">
        {user && updateAvailable && (
          <button
            onClick={async () => {
              setReloadingFromHeader(true);
              await hardReloadApp();
            }}
            disabled={reloadingFromHeader}
            className="w-10 h-10 rounded-full bg-error text-white flex items-center justify-center shadow-md active:scale-95 transition-all disabled:opacity-60 animate-pulse"
            title={t('update.available')}
          >
            <span className={clsx('material-symbols-outlined', reloadingFromHeader && 'animate-spin')}>
              {reloadingFromHeader ? 'sync' : 'refresh'}
            </span>
          </button>
        )}
        {user && !shopMode && (
          <button
            data-tour="header-search"
            onClick={() => setSearchOpen(true)}
            className="w-10 h-10 rounded-full hover:bg-surface flex items-center justify-center text-text-muted transition-colors"
            title={t('header.search')}
          >
            <span className="material-symbols-outlined">search</span>
          </button>
        )}
        {user && (
          <button
            onClick={() => {
              if (shopMode) { navigate('/shop/activity'); return; }
              setFeedGroupId(undefined);
              setFeedOpen(true);
            }}
            className="relative w-10 h-10 rounded-full hover:bg-surface flex items-center justify-center text-text-muted transition-colors"
            title={t('feed.title')}
          >
            <span className="material-symbols-outlined">notifications</span>
            {!shopMode && unreadFeedCount > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-error text-white text-[9px] font-bold flex items-center justify-center">
                {unreadFeedCount > 9 ? '9+' : unreadFeedCount}
              </span>
            )}
          </button>
        )}
        {user && (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="relative w-10 h-10 rounded-full hover:bg-surface flex items-center justify-center text-text-muted transition-colors"
              title="Menu"
            >
              <span className="material-symbols-outlined">menu</span>
            </button>
            {menuOpen && (
              <>
                {/* Click-outside catcher — plain backdrop, no dim/blur, so the rest of the header
                    stays fully visible while the menu is open. */}
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-12 z-50 w-56 bg-white rounded-2xl border border-border-subtle shadow-xl py-1.5 overflow-hidden">
                  {hasShopAccess && (
                    <button
                      data-tour="header-shop-toggle"
                      onClick={() => { setMenuOpen(false); toggleShopMode(); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-bold text-on-surface hover:bg-surface transition-colors text-left"
                    >
                      <span className="material-symbols-outlined text-[20px] text-text-muted">storefront</span>
                      {shopMode ? 'Switch to personal view' : 'Switch to Shopkeeper view'}
                    </button>
                  )}
                  {isInIframe && (
                    <button
                      onClick={() => { setMenuOpen(false); openInNewWindow(); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-bold text-on-surface hover:bg-surface transition-colors text-left"
                    >
                      <span className="material-symbols-outlined text-[20px] text-text-muted">open_in_new</span>
                      Open in new window
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {user && !shopMode && <HeaderProfileBadge />}
        {user && shopMode && (
          <button
            onClick={() => navigate('/profile')}
            className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center text-primary hover:bg-primary/10 transition-all overflow-hidden border border-primary/20 active:scale-95 shrink-0"
            title="View Profile"
          >
            {profileImage ? (
              <img src={profileImage} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-primary/10 text-primary font-bold text-xs">
                {profile?.displayName?.slice(0, 1) || user?.displayName?.slice(0, 1) || (
                  <span className="material-symbols-outlined text-[20px]">person</span>
                )}
              </div>
            )}
          </button>
        )}
      </div>
      <GlobalSearch isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
      <FeedPanel open={feedOpen} onClose={() => setFeedOpen(false)} initialGroupId={feedGroupId} />
    </header>
  );
}
