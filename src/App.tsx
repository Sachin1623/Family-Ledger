import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { setNavigateFn } from './lib/navigationRef';
import { getParentPath } from './lib/navigationParents';
import { trackPageView } from './lib/firebase';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import { ShopModeProvider } from './context/ShopModeContext';
import { LanguageProvider } from './context/LanguageContext';
import Login from './screens/Login';
import Dashboard from './screens/Dashboard';
import CreateGroup from './screens/CreateGroup';
import ManageGroup from './screens/ManageGroup';
import AddExpense from './screens/AddExpense';
import GroupAnalysisSummary from './screens/GroupAnalysisSummary';
import GroupExpenses from './screens/GroupExpenses';
import Profile from './screens/Profile';
import ActivityFeed from './screens/ActivityFeed';
import Settlements from './screens/Settlements';
import JoinGroup from './screens/JoinGroup';
import AddFriendInvite from './screens/AddFriendInvite';
import About from './screens/About';
import PrivacyPolicy from './screens/PrivacyPolicy';
import DataUsage from './screens/DataUsage';
import DataDeletion from './screens/DataDeletion';
import Terms from './screens/Terms';
import Contact from './screens/Contact';
import Feedback from './screens/Feedback';
import WeeklySummary from './screens/WeeklySummary';
import RecurringExpenses from './screens/RecurringExpenses';
import RecurringApprovals from './screens/RecurringApprovals';
import ToDoList from './screens/ToDoList';
import Calculator from './screens/Calculator';
import FinancialCalculators from './screens/FinancialCalculators';
import GamesHub from './screens/games/GamesHub';
import SudokuHome from './screens/games/SudokuHome';
import SudokuGame from './screens/games/SudokuGame';
import SudokuLeaderboard from './screens/games/SudokuLeaderboard';
import ScrambleHome from './screens/games/ScrambleHome';
import ScrambleGame from './screens/games/ScrambleGame';
import ScrambleLeaderboard from './screens/games/ScrambleLeaderboard';
import ScrambleLobby from './screens/games/ScrambleLobby';
import ScrambleMultiplayerGame from './screens/games/ScrambleMultiplayerGame';
import LudoLobby from './screens/games/LudoLobby';
import LudoGame from './screens/games/LudoGame';
import RummyLobby from './screens/games/RummyLobby';
import RummyGame from './screens/games/RummyGame';
import GameRanks from './screens/games/GameRanks';
import BusinessLobby from './screens/games/BusinessLobby';
import BusinessGame from './screens/games/BusinessGame';
import SweepLobby from './screens/games/SweepLobby';
import SweepGame from './screens/games/SweepGame';
import ChessLobby from './screens/games/ChessLobby';
import ChessGame from './screens/games/ChessGame';
import SequenceLobby from './screens/games/SequenceLobby';
import SequenceGame from './screens/games/SequenceGame';
import Tools from './screens/Tools';
import MembersChat from './screens/MembersChat';
import Friends from './screens/Friends';
import MyProgress from './screens/MyProgress';
import Health from './screens/Health';
import HealthGlucose from './screens/HealthGlucose';
import PublicProfile from './screens/PublicProfile';
import ShoppingLists from './screens/ShoppingLists';
import ShoppingListDetail from './screens/ShoppingListDetail';
import ExpenseReminders from './screens/ExpenseReminders';
import PersonalLoans from './screens/PersonalLoans';
import LoanContactDetail from './screens/LoanContactDetail';
import ShopProfile from './screens/shop/ShopProfile';
import ShopCustomers from './screens/shop/ShopCustomers';
import ShopCustomerDetail from './screens/shop/ShopCustomerDetail';
import ShopSales from './screens/shop/ShopSales';
import ShopReports from './screens/shop/ShopReports';
import ShopActivity from './screens/shop/ShopActivity';
import AdminShopkeeperRequests from './screens/admin/AdminShopkeeperRequests';
import Navigation from './components/Navigation';
import Header from './components/Header';
import AdminDashboard from './screens/admin/AdminDashboard';
import AdminUsers from './screens/admin/AdminUsers';
import AdminUserDetail from './screens/admin/AdminUserDetail';
import AdminAnalytics from './screens/admin/AdminAnalytics';
import AdminManageAdmins from './screens/admin/AdminManageAdmins';
import AdminFeedback from './screens/admin/AdminFeedback';
import AdminAppVersion from './screens/admin/AdminAppVersion';
import AdminBroadcast from './screens/admin/AdminBroadcast';
import AdminChatReports from './screens/admin/AdminChatReports';
import UpdatePrompt from './components/UpdatePrompt';
import UpdateBanner from './components/UpdateBanner';
import ConsentBanner from './components/ConsentBanner';
import PointsToastBridge from './components/PointsToastBridge';
import PointsFlyAnimation from './components/PointsFlyAnimation';
import BroadcastBanner from './components/BroadcastBanner';
import AppLockScreen from './components/AppLockScreen';
import LudoTurnIndicator from './components/LudoTurnIndicator';
import GameTurnIndicator from './components/GameTurnIndicator';
import InviteBanner from './components/InviteBanner';
import OnboardingTour from './components/OnboardingTour';
import LoadingScreen from './components/LoadingScreen';

// Registers the router's navigate function into a module-level ref so code outside React
// (the push notification tap handler) can navigate — e.g. tapping a group-invite push opens
// the join screen directly instead of just bringing the app to the foreground.
const NavigationBridge = () => {
  const navigate = useNavigate();
  const location = useLocation();
  // Always-current pathname for the backButton listener below — that listener is registered
  // once (empty-ish dep array via `navigate`, which is stable) and would otherwise close over
  // whatever path was current at registration time forever.
  const pathnameRef = React.useRef(location.pathname);
  // Tracked alongside pathname (not merged into one string) so paths like '/' keep comparing
  // cleanly by themselves below — only getParentPath needs the two together, for the
  // /groups/:id/expenses "which page sent me here" case (see navigationParents.ts).
  const searchRef = React.useRef(location.search);
  React.useEffect(() => {
    pathnameRef.current = location.pathname;
    searchRef.current = location.search;
  }, [location.pathname, location.search]);

  React.useEffect(() => {
    setNavigateFn((path: string) => navigate(path));
    return () => setNavigateFn(null);
  }, [navigate]);

  // Automatic screen-view tracking — every route change is a GA4 `page_view`, same as it would be
  // for a normal multi-page website (React Router alone doesn't give Analytics anything to see).
  React.useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);

  // Scroll to top on every genuine page change — React Router doesn't do this itself (unlike a
  // real multi-page site), so scrolling down on one screen, navigating away, and coming back to a
  // DIFFERENT screen left the next screen's content scrolled down too. Resets both window scroll
  // (most screens) and AuthenticatedLayout's own `<main overflow-y-auto>` (the actual scrolling
  // container on screens tall enough to need it) since either could be the one that's scrolled.
  // Keyed on pathname only, not the full location — a query-param-only change (e.g. a `?chat=1`
  // deep link on a page you're already viewing) shouldn't yank your scroll position back to zero.
  React.useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector('main')?.scrollTo(0, 0);
  }, [location.pathname]);

  // Android App Links (verified deep links, see AndroidManifest.xml + assetlinks.json)
  // launch the app with the tapped URL, but Capacitor doesn't automatically navigate the
  // WebView to match it — without this, a join link would open the app but land on
  // whatever the default start page is, not the actual /join/:groupId screen.
  React.useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listenerPromise = CapacitorApp.addListener('appUrlOpen', (data) => {
      try {
        const url = new URL(data.url);
        navigate(url.pathname + url.search);
      } catch (err) {
        console.error('Failed to parse deep link URL:', data.url, err);
      }
    });
    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, [navigate]);

  // Hardware/gesture back button (Android). Without an explicit handler, Capacitor falls back to
  // the WebView's own session history, which doesn't reliably match the app's logical page
  // hierarchy (see getParentPath's comment for why — the same history-drift issue Header.tsx's
  // in-app back arrow was built to work around). This reuses that exact same parent-resolution
  // logic so hardware back and the on-screen arrow always agree, and exits the app instead of
  // going "back" from the root/login screen rather than getting stuck.
  React.useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listenerPromise = CapacitorApp.addListener('backButton', () => {
      const path = pathnameRef.current;
      if (path === '/' || path === '/login') {
        CapacitorApp.exitApp();
      } else {
        navigate(getParentPath(path, searchRef.current));
      }
    });
    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, [navigate]);

  return null;
};

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const location = window.location.pathname;
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} />;
  return <>{children}</>;
};

const AdminRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading, admin } = useAuth();
  const location = window.location.pathname;
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} />;
  if (!admin.isAdmin) return <Navigate to="/" replace />;
  return (
    <ProtectedRoute>
      <main className="flex-1 overflow-y-auto pb-32">{children}</main>
      <Navigation />
    </ProtectedRoute>
  );
};

// React Router doesn't remount a route's element when only a URL param changes and the same
// <Route> still matches — e.g. Rummy's "Play Again" navigates from /games/rummy/OLD_ID straight
// to /games/rummy/NEW_ID, which is the exact same route. Without this, every multiplayer game
// screen's local state (selected cards, UI toggles, animation refs, etc.) survives that
// navigation untouched, so a rematch could visibly show stale bits of the just-finished game
// until enough of the screen catches up to the freshly-loaded doc — worst case, looks like the
// previous match's screen never actually changed. Keying a wrapping Fragment by the param forces
// React to unmount the whole subtree and mount a genuinely fresh instance for the new gameId,
// exactly like a real page navigation would. Applied to every multiplayer game's :gameId route.
const GameRouteKey = ({ children }: { children: React.ReactNode }) => {
  const { gameId } = useParams();
  return <React.Fragment key={gameId}>{children}</React.Fragment>;
};

const AuthenticatedLayout = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();

  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: window.location.pathname }} />;

  return (
    <ProtectedRoute>
      <main className="flex-1 overflow-y-auto pb-32">{children}</main>
      <Navigation />
    </ProtectedRoute>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
      <ShopModeProvider>
      <NotificationProvider>
        <Router>
          <NavigationBridge />
          <PointsToastBridge />
          <PointsFlyAnimation />
          <UpdatePrompt />
          <UpdateBanner />
          <ConsentBanner />
          <BroadcastBanner />
          <AppLockScreen />
          <LudoTurnIndicator />
          <GameTurnIndicator />
          <InviteBanner />
          <OnboardingTour />
          <div className="min-h-screen bg-surface font-sans text-on-surface flex flex-col">
            <Header />
            <Routes>
              {/* Public & Utility Routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/join/:groupId" element={<JoinGroup />} />
              <Route path="/groups/join/:groupId" element={<JoinGroup />} />
              <Route path="/groups/:groupId/join" element={<JoinGroup />} />
              <Route path="/add-friend/:uid" element={<AddFriendInvite />} />
              <Route path="/about" element={<About />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/data-usage" element={<DataUsage />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/delete-account" element={<DataDeletion />} />

              {/* Protected App Routes */}
              <Route path="/" element={<AuthenticatedLayout><Dashboard /></AuthenticatedLayout>} />
              <Route path="/groups/:groupId" element={<AuthenticatedLayout><GroupAnalysisSummary /></AuthenticatedLayout>} />
              <Route path="/groups/:groupId/expenses" element={<AuthenticatedLayout><GroupExpenses /></AuthenticatedLayout>} />
              <Route path="/groups/:groupId/manage" element={<AuthenticatedLayout><ManageGroup /></AuthenticatedLayout>} />
              <Route path="/create-group" element={<AuthenticatedLayout><CreateGroup /></AuthenticatedLayout>} />
              <Route path="/add-expense" element={<AuthenticatedLayout><AddExpense /></AuthenticatedLayout>} />
              <Route path="/settlements" element={<AuthenticatedLayout><Settlements /></AuthenticatedLayout>} />
              <Route path="/settlements/:groupId" element={<AuthenticatedLayout><Settlements /></AuthenticatedLayout>} />
              <Route path="/analysis" element={<AuthenticatedLayout><GroupAnalysisSummary /></AuthenticatedLayout>} />
              <Route path="/feed" element={<AuthenticatedLayout><ActivityFeed /></AuthenticatedLayout>} />
              <Route path="/profile" element={<AuthenticatedLayout><Profile /></AuthenticatedLayout>} />
              <Route path="/feedback" element={<AuthenticatedLayout><Feedback /></AuthenticatedLayout>} />
              <Route path="/weekly-summary" element={<AuthenticatedLayout><WeeklySummary /></AuthenticatedLayout>} />
              <Route path="/recurring-expenses" element={<AuthenticatedLayout><RecurringExpenses /></AuthenticatedLayout>} />
              <Route path="/recurring-approvals" element={<AuthenticatedLayout><RecurringApprovals /></AuthenticatedLayout>} />
              <Route path="/todo" element={<AuthenticatedLayout><ToDoList /></AuthenticatedLayout>} />
              <Route path="/chat" element={<AuthenticatedLayout><MembersChat /></AuthenticatedLayout>} />
              <Route path="/friends" element={<AuthenticatedLayout><Friends /></AuthenticatedLayout>} />
              <Route path="/progress" element={<AuthenticatedLayout><MyProgress /></AuthenticatedLayout>} />
              <Route path="/health" element={<AuthenticatedLayout><Health /></AuthenticatedLayout>} />
              <Route path="/health/glucose" element={<AuthenticatedLayout><HealthGlucose /></AuthenticatedLayout>} />
              <Route path="/u/:uid" element={<AuthenticatedLayout><PublicProfile /></AuthenticatedLayout>} />
              <Route path="/calculator" element={<AuthenticatedLayout><Calculator /></AuthenticatedLayout>} />
              <Route path="/financial-calculators" element={<AuthenticatedLayout><FinancialCalculators /></AuthenticatedLayout>} />
              <Route path="/games" element={<AuthenticatedLayout><GamesHub /></AuthenticatedLayout>} />
              <Route path="/games/sudoku" element={<AuthenticatedLayout><SudokuHome /></AuthenticatedLayout>} />
              <Route path="/games/sudoku/play/:difficulty" element={<AuthenticatedLayout><SudokuGame /></AuthenticatedLayout>} />
              <Route path="/games/sudoku/leaderboard" element={<AuthenticatedLayout><SudokuLeaderboard /></AuthenticatedLayout>} />
              <Route path="/games/scramble" element={<AuthenticatedLayout><ScrambleHome /></AuthenticatedLayout>} />
              <Route path="/games/scramble/play" element={<AuthenticatedLayout><ScrambleGame /></AuthenticatedLayout>} />
              <Route path="/games/scramble/leaderboard" element={<AuthenticatedLayout><ScrambleLeaderboard /></AuthenticatedLayout>} />
              <Route path="/games/scramble-multiplayer" element={<AuthenticatedLayout><ScrambleLobby /></AuthenticatedLayout>} />
              <Route path="/games/scramble-multiplayer/:gameId" element={<GameRouteKey><AuthenticatedLayout><ScrambleMultiplayerGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/ludo" element={<AuthenticatedLayout><LudoLobby /></AuthenticatedLayout>} />
              <Route path="/games/ludo/:gameId" element={<GameRouteKey><AuthenticatedLayout><LudoGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/rummy" element={<AuthenticatedLayout><RummyLobby /></AuthenticatedLayout>} />
              <Route path="/games/rummy/:gameId" element={<GameRouteKey><AuthenticatedLayout><RummyGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/ranks/:gameType" element={<AuthenticatedLayout><GameRanks /></AuthenticatedLayout>} />
              <Route path="/games/business" element={<AuthenticatedLayout><BusinessLobby /></AuthenticatedLayout>} />
              <Route path="/games/business/:gameId" element={<GameRouteKey><AuthenticatedLayout><BusinessGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/sweep" element={<AuthenticatedLayout><SweepLobby /></AuthenticatedLayout>} />
              <Route path="/games/sweep/:gameId" element={<GameRouteKey><AuthenticatedLayout><SweepGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/chess" element={<AuthenticatedLayout><ChessLobby /></AuthenticatedLayout>} />
              <Route path="/games/chess/:gameId" element={<GameRouteKey><AuthenticatedLayout><ChessGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/sequence" element={<AuthenticatedLayout><SequenceLobby /></AuthenticatedLayout>} />
              <Route path="/games/sequence/:gameId" element={<GameRouteKey><AuthenticatedLayout><SequenceGame /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/tools" element={<AuthenticatedLayout><Tools /></AuthenticatedLayout>} />
              <Route path="/shopping-lists" element={<AuthenticatedLayout><ShoppingLists /></AuthenticatedLayout>} />
              <Route path="/shopping-lists/:listId" element={<AuthenticatedLayout><ShoppingListDetail /></AuthenticatedLayout>} />
              <Route path="/expense-reminders" element={<AuthenticatedLayout><ExpenseReminders /></AuthenticatedLayout>} />
              <Route path="/personal-loans" element={<AuthenticatedLayout><PersonalLoans /></AuthenticatedLayout>} />
              <Route path="/personal-loans/:contactId" element={<AuthenticatedLayout><LoanContactDetail /></AuthenticatedLayout>} />

              {/* Shopkeeper mode */}
              <Route path="/shop/profile" element={<AuthenticatedLayout><ShopProfile /></AuthenticatedLayout>} />
              <Route path="/shop/customers" element={<AuthenticatedLayout><ShopCustomers /></AuthenticatedLayout>} />
              <Route path="/shop/customers/:customerId" element={<AuthenticatedLayout><ShopCustomerDetail /></AuthenticatedLayout>} />
              <Route path="/shop/sales" element={<AuthenticatedLayout><ShopSales /></AuthenticatedLayout>} />
              <Route path="/shop/reports" element={<AuthenticatedLayout><ShopReports /></AuthenticatedLayout>} />
              <Route path="/shop/activity" element={<AuthenticatedLayout><ShopActivity /></AuthenticatedLayout>} />

              {/* Admin Routes */}
              <Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
              <Route path="/admin/users" element={<AdminRoute><AdminUsers /></AdminRoute>} />
              <Route path="/admin/users/:uid" element={<AdminRoute><AdminUserDetail /></AdminRoute>} />
              <Route path="/admin/analytics" element={<AdminRoute><AdminAnalytics /></AdminRoute>} />
              <Route path="/admin/manage-admins" element={<AdminRoute><AdminManageAdmins /></AdminRoute>} />
              <Route path="/admin/feedback" element={<AdminRoute><AdminFeedback /></AdminRoute>} />
              <Route path="/admin/app-version" element={<AdminRoute><AdminAppVersion /></AdminRoute>} />
              <Route path="/admin/broadcast" element={<AdminRoute><AdminBroadcast /></AdminRoute>} />
              <Route path="/admin/shopkeeper-requests" element={<AdminRoute><AdminShopkeeperRequests /></AdminRoute>} />
              <Route path="/admin/chat-reports" element={<AdminRoute><AdminChatReports /></AdminRoute>} />

              {/* Global Catch-all */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </Router>
      </NotificationProvider>
      </ShopModeProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
