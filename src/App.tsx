import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { StatusBar } from '@capacitor/status-bar';
import { Capacitor } from '@capacitor/core';
import { setNavigateFn } from './lib/navigationRef';
import { getParentPath } from './lib/navigationParents';
import { consumeModalBackHandler } from './lib/modalBackHandler';
import { trackPageView } from './lib/firebase';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import { ShopModeProvider } from './context/ShopModeContext';
import { FabActionProvider } from './context/FabActionContext';
import { LanguageProvider } from './context/LanguageContext';
import Login from './screens/Login';
import { lazyScreen } from './lib/lazyScreen';
import { hasAuthHint } from './lib/authHint';
const Dashboard = lazyScreen(() => import('./screens/Dashboard'));
const CreateGroup = lazyScreen(() => import('./screens/CreateGroup'));
const ManageGroup = lazyScreen(() => import('./screens/ManageGroup'));
const AddExpense = lazyScreen(() => import('./screens/AddExpense'));
const GroupAnalysisSummary = lazyScreen(() => import('./screens/GroupAnalysisSummary'));
const GroupExpenses = lazyScreen(() => import('./screens/GroupExpenses'));
const Profile = lazyScreen(() => import('./screens/Profile'));
const ActivityFeed = lazyScreen(() => import('./screens/ActivityFeed'));
const Settlements = lazyScreen(() => import('./screens/Settlements'));
const JoinGroup = lazyScreen(() => import('./screens/JoinGroup'));
const AddFriendInvite = lazyScreen(() => import('./screens/AddFriendInvite'));
const About = lazyScreen(() => import('./screens/About'));
const PrivacyPolicy = lazyScreen(() => import('./screens/PrivacyPolicy'));
const DataUsage = lazyScreen(() => import('./screens/DataUsage'));
const DataDeletion = lazyScreen(() => import('./screens/DataDeletion'));
const Terms = lazyScreen(() => import('./screens/Terms'));
const Contact = lazyScreen(() => import('./screens/Contact'));
const Feedback = lazyScreen(() => import('./screens/Feedback'));
const PendingActions = lazyScreen(() => import('./screens/PendingActions'));
const AlarmsHub = lazyScreen(() => import('./screens/AlarmsHub'));
const BabyVaccinations = lazyScreen(() => import('./screens/BabyVaccinations'));
const AddBabyProfile = lazyScreen(() => import('./screens/AddBabyProfile'));
const LogVaccineVisit = lazyScreen(() => import('./screens/LogVaccineVisit'));
const VaccineVisitDetail = lazyScreen(() => import('./screens/VaccineVisitDetail'));
const VaccineCaregivers = lazyScreen(() => import('./screens/VaccineCaregivers'));
const VaccineReminders = lazyScreen(() => import('./screens/VaccineReminders'));
const VaccineProfileView = lazyScreen(() => import('./screens/VaccineProfileView'));
const VaccineDeletedBabies = lazyScreen(() => import('./screens/VaccineDeletedBabies'));
const WeeklySummary = lazyScreen(() => import('./screens/WeeklySummary'));
const RecurringExpenses = lazyScreen(() => import('./screens/RecurringExpenses'));
const RecurringApprovals = lazyScreen(() => import('./screens/RecurringApprovals'));
const ToDoList = lazyScreen(() => import('./screens/ToDoList'));
const Calculator = lazyScreen(() => import('./screens/Calculator'));
const FinancialCalculators = lazyScreen(() => import('./screens/FinancialCalculators'));
const GamesHub = lazyScreen(() => import('./screens/games/GamesHub'));
const SudokuHome = lazyScreen(() => import('./screens/games/SudokuHome'));
const SudokuGame = lazyScreen(() => import('./screens/games/SudokuGame'));
const SudokuLeaderboard = lazyScreen(() => import('./screens/games/SudokuLeaderboard'));
const ScrambleHome = lazyScreen(() => import('./screens/games/ScrambleHome'));
const ScrambleGame = lazyScreen(() => import('./screens/games/ScrambleGame'));
const ScrambleLeaderboard = lazyScreen(() => import('./screens/games/ScrambleLeaderboard'));
const ScrambleLobby = lazyScreen(() => import('./screens/games/ScrambleLobby'));
const ScrambleMultiplayerGame = lazyScreen(() => import('./screens/games/ScrambleMultiplayerGame'));
const LudoLobby = lazyScreen(() => import('./screens/games/LudoLobby'));
const LudoGame = lazyScreen(() => import('./screens/games/LudoGame'));
const RummyLobby = lazyScreen(() => import('./screens/games/RummyLobby'));
const RummyGame = lazyScreen(() => import('./screens/games/RummyGame'));
const Rummy13Lobby = lazyScreen(() => import('./screens/games/Rummy13Lobby'));
const Rummy13Game = lazyScreen(() => import('./screens/games/Rummy13Game'));
const SpadePledgeLobby = lazyScreen(() => import('./screens/games/SpadePledgeLobby'));
const SpadePledgeGame = lazyScreen(() => import('./screens/games/SpadePledgeGame'));
const GameRanks = lazyScreen(() => import('./screens/games/GameRanks'));
const BusinessLobby = lazyScreen(() => import('./screens/games/BusinessLobby'));
const BusinessGame = lazyScreen(() => import('./screens/games/BusinessGame'));
const SweepLobby = lazyScreen(() => import('./screens/games/SweepLobby'));
const SweepGame = lazyScreen(() => import('./screens/games/SweepGame'));
const ChessLobby = lazyScreen(() => import('./screens/games/ChessLobby'));
const ChessGame = lazyScreen(() => import('./screens/games/ChessGame'));
const SequenceLobby = lazyScreen(() => import('./screens/games/SequenceLobby'));
const SequenceGame = lazyScreen(() => import('./screens/games/SequenceGame'));
const Tools = lazyScreen(() => import('./screens/Tools'));
const MembersChat = lazyScreen(() => import('./screens/MembersChat'));
const Friends = lazyScreen(() => import('./screens/Friends'));
const MyProgress = lazyScreen(() => import('./screens/MyProgress'));
const MyStyle = lazyScreen(() => import('./screens/MyStyle'));
const Health = lazyScreen(() => import('./screens/Health'));
const CareCircle = lazyScreen(() => import('./screens/CareCircle'));
const HealthGlucose = lazyScreen(() => import('./screens/HealthGlucose'));
const HealthBloodPressure = lazyScreen(() => import('./screens/HealthBloodPressure'));
const HealthMedicines = lazyScreen(() => import('./screens/HealthMedicines'));
const PublicProfile = lazyScreen(() => import('./screens/PublicProfile'));
const ProfileVisibility = lazyScreen(() => import('./screens/ProfileVisibility'));
const ShoppingLists = lazyScreen(() => import('./screens/ShoppingLists'));
const ShoppingListDetail = lazyScreen(() => import('./screens/ShoppingListDetail'));
const ExpenseReminders = lazyScreen(() => import('./screens/ExpenseReminders'));
const GoalsHub = lazyScreen(() => import('./screens/GoalsHub'));
const GoalDetail = lazyScreen(() => import('./screens/GoalDetail'));
const GoalWizard = lazyScreen(() => import('./screens/GoalWizard'));
const GoalAllocationManager = lazyScreen(() => import('./screens/GoalAllocationManager'));
const GoalFundingSetup = lazyScreen(() => import('./screens/GoalFundingSetup'));
const GoalReports = lazyScreen(() => import('./screens/GoalReports'));
const AccountsHub = lazyScreen(() => import('./screens/AccountsHub'));
const AccountDetail = lazyScreen(() => import('./screens/AccountDetail'));
const PersonalLoans = lazyScreen(() => import('./screens/PersonalLoans'));
const LoanContactDetail = lazyScreen(() => import('./screens/LoanContactDetail'));
const PolicyVault = lazyScreen(() => import('./screens/PolicyVault'));
const PolicyWizard = lazyScreen(() => import('./screens/PolicyWizard'));
const PolicyDetail = lazyScreen(() => import('./screens/PolicyDetail'));
const ShopProfile = lazyScreen(() => import('./screens/shop/ShopProfile'));
const ShopCustomers = lazyScreen(() => import('./screens/shop/ShopCustomers'));
const ShopCustomerDetail = lazyScreen(() => import('./screens/shop/ShopCustomerDetail'));
const ShopSales = lazyScreen(() => import('./screens/shop/ShopSales'));
const ShopReports = lazyScreen(() => import('./screens/shop/ShopReports'));
const ShopActivity = lazyScreen(() => import('./screens/shop/ShopActivity'));
const AdminShopkeeperRequests = lazyScreen(() => import('./screens/admin/AdminShopkeeperRequests'));
import Navigation from './components/Navigation';
import Header from './components/Header';
import FloatingCalculator from './components/FloatingCalculator';
const AdminDashboard = lazyScreen(() => import('./screens/admin/AdminDashboard'));
const AdminUsers = lazyScreen(() => import('./screens/admin/AdminUsers'));
const AdminUserDetail = lazyScreen(() => import('./screens/admin/AdminUserDetail'));
const AdminAnalytics = lazyScreen(() => import('./screens/admin/AdminAnalytics'));
const AdminGrowth = lazyScreen(() => import('./screens/admin/AdminGrowth'));
const AdminMetrics = lazyScreen(() => import('./screens/admin/AdminMetrics'));
const AdminManageAdmins = lazyScreen(() => import('./screens/admin/AdminManageAdmins'));
const AdminFeedback = lazyScreen(() => import('./screens/admin/AdminFeedback'));
const AdminAppVersion = lazyScreen(() => import('./screens/admin/AdminAppVersion'));
const AdminBuilds = lazyScreen(() => import('./screens/admin/AdminBuilds'));
const AdminBroadcast = lazyScreen(() => import('./screens/admin/AdminBroadcast'));
const AdminChatReports = lazyScreen(() => import('./screens/admin/AdminChatReports'));
import UpdatePrompt from './components/UpdatePrompt';
import UpdateBanner from './components/UpdateBanner';
import ConsentBanner from './components/ConsentBanner';
import GlobalChatPopup from './components/GlobalChatPopup';
import ReceiptShareBridge from './components/ReceiptShareBridge';
const ReceiptShare = lazyScreen(() => import('./screens/ReceiptShare'));
import PointsToastBridge from './components/PointsToastBridge';
import PointsFlyAnimation from './components/PointsFlyAnimation';
import BroadcastBanner from './components/BroadcastBanner';
import SpreadWordPrompt from './components/SpreadWordPrompt';
import AppLockScreen from './components/AppLockScreen';
import LudoTurnIndicator from './components/LudoTurnIndicator';
import GameTurnIndicator from './components/GameTurnIndicator';
import AccountGoalNudgePrompt from './components/AccountGoalNudgePrompt';
import GlobalReminderScheduler from './components/GlobalReminderScheduler';
import GlobalMedicineReminderScheduler from './components/GlobalMedicineReminderScheduler';
import GlobalVaccineReminderScheduler from './components/GlobalVaccineReminderScheduler';
import GlobalAlarmRingingBanner from './components/GlobalAlarmRingingBanner';
import FeedbackRatingPrompt from './components/FeedbackRatingPrompt';
import AppPermissionsReminder from './components/AppPermissionsReminder';
import AlarmPermissionsPrompt from './components/AlarmPermissionsPrompt';
import InviteBanner from './components/InviteBanner';
import OnboardingTour from './components/OnboardingTour';
import ProfileSetupWizard from './components/ProfileSetupWizard';
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
  // DIFFERENT screen left the next screen's content scrolled down too. #route-scroll (see App's
  // root JSX) is the ONE real scrolling container for every route now — window.scrollTo is kept
  // alongside it only as a harmless no-op safety net, not because it's ever actually the element
  // that scrolled. Keyed on pathname only, not the full location — a query-param-only change
  // (e.g. a `?chat=1` deep link on a page you're already viewing) shouldn't yank scroll to zero.
  React.useEffect(() => {
    window.scrollTo(0, 0);
    document.getElementById('route-scroll')?.scrollTo(0, 0);
  }, [location.pathname]);

  // Android 15+ (targetSdk 35+) makes edge-to-edge display mandatory and Android 16 removes the
  // opt-out entirely — the WebView now draws behind the system status bar by default regardless
  // of app intent, with zero native inset handling of our own (no WindowCompat call, no
  // OnApplyWindowInsetsListener in MainActivity.java). Header.tsx's own env(safe-area-inset-top)
  // padding assumed that value was always 0 on Android, which stopped being true the moment a
  // device actually runs 15/16 — reported as the header/profile-picture badge rendering cut off
  // under the status bar. setOverlaysWebView(false) explicitly insets the WebView below the
  // status bar again, overriding the forced-edge-to-edge default. No-ops (and is safe to call) on
  // iOS/older Android/web — only actually changes anything on an affected device.
  React.useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    StatusBar.setOverlaysWebView({ overlay: false }).catch((err) => console.error('Failed to set status bar overlay:', err));
  }, []);

  // Android App Links (verified deep links, see AndroidManifest.xml + assetlinks.json)
  // launch the app with the tapped URL, but Capacitor doesn't automatically navigate the
  // WebView to match it — without this, a join link would open the app but land on
  // whatever the default start page is, not the actual /join/:groupId screen.
  React.useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listenerPromise = CapacitorApp.addListener('appUrlOpen', (data) => {
      try {
        const url = new URL(data.url);
        if (url.protocol === 'file:') return; // a receipt handed to the app (see ReceiptShareBridge), not a deep link
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
      // A floating modal (e.g. AccountsHub's Add Account form) covers the screen but isn't its
      // own route — getParentPath below only knows about the route underneath it, so without this
      // check, back would skip straight past the modal to that route's own logical parent instead
      // of just closing the modal first, one layer at a time like the on-screen X does.
      if (consumeModalBackHandler()) return;
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
  if (loading && hasAuthHint()) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} />;
  return <>{children}</>;
};

const AdminRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading, admin } = useAuth();
  const location = window.location.pathname;
  if (loading && hasAuthHint()) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} />;
  if (!admin.isAdmin) return <Navigate to="/" replace />;
  return (
    <ProtectedRoute>
      {/* h-full: resolves against #route-scroll's own real, capped height (see App's root JSX),
          so any page can size a child to "exactly the visible area" via h-full/percentage heights
          if it needs to (e.g. a page that wants ONE of its own regions non-scrollable while another
          scrolls). Doesn't change anything for a page that doesn't opt into that — overflow is
          still the default `visible`, so taller-than-available content still just flows past this
          box's bottom edge and gets caught by #route-scroll's own overflow-y-auto exactly as
          before. */}
      <main className="h-full pb-32">{children}</main>
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

  if (loading && hasAuthHint()) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: window.location.pathname }} />;

  return (
    <ProtectedRoute>
      <main className="h-full pb-32">{children}</main>
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
      <FabActionProvider>
        <Router>
          <NavigationBridge />
          <ReceiptShareBridge />
          <PointsToastBridge />
          <PointsFlyAnimation />
          <UpdatePrompt />
          <UpdateBanner />
          <ConsentBanner />
          <GlobalChatPopup />
          <BroadcastBanner />
          <SpreadWordPrompt />
          <AppLockScreen />
          <LudoTurnIndicator />
          <GameTurnIndicator />
          <GlobalReminderScheduler />
          <GlobalMedicineReminderScheduler />
          <GlobalVaccineReminderScheduler />
          <GlobalAlarmRingingBanner />
          <FeedbackRatingPrompt />
          <AppPermissionsReminder />
          <AlarmPermissionsPrompt />
          <InviteBanner />
          <ProfileSetupWizard />
          {/* first-login tour and account/goal nudge removed: no guides for new users */}
          
          {/* h-dvh + overflow-hidden (not the old min-h-screen, which had no ceiling) makes this
              the one true viewport-bounded box in the whole tree. Header stays in normal flow (it's
              sticky, not fixed, so it still needs real space reserved above the scroll area) and
              the div below is the SINGLE scrolling container for every route's content — public
              and authenticated alike. Without a genuinely bounded ancestor here, `overflow-y-auto`
              on that div (or on AuthenticatedLayout's own <main>) never actually triggers: flexbox
              just grows the whole tree to fit its content instead of clipping it, so the browser
              WINDOW ends up doing the scrolling instead — which is harmless for plain scrolling,
              but breaks every `position: sticky` element inside, since a `sticky` element sticks
              relative to its nearest ancestor that's a genuine scroll container, not to whatever
              actually happens to be moving on screen. (Reported as "header not fixed, still
              scrolls" — see BabyVaccinations.tsx / HealthGlucose.tsx / LogVaccineVisit.tsx's own
              sticky headers, none of which could ever have worked before this fix.) */}
          <div className="h-dvh bg-surface font-sans text-on-surface flex flex-col overflow-hidden">
            <Header />
            <FloatingCalculator />
            <div id="route-scroll" className="flex-1 min-h-0 overflow-y-auto">
            <React.Suspense fallback={<LoadingScreen fullScreen={false} />}>
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
              <Route path="/receipt-share" element={<AuthenticatedLayout><ReceiptShare /></AuthenticatedLayout>} />
              <Route path="/settlements" element={<AuthenticatedLayout><Settlements /></AuthenticatedLayout>} />
              <Route path="/settlements/:groupId" element={<AuthenticatedLayout><Settlements /></AuthenticatedLayout>} />
              <Route path="/analysis" element={<AuthenticatedLayout><GroupAnalysisSummary /></AuthenticatedLayout>} />
              <Route path="/feed" element={<AuthenticatedLayout><ActivityFeed /></AuthenticatedLayout>} />
              <Route path="/profile" element={<AuthenticatedLayout><Profile /></AuthenticatedLayout>} />
              <Route path="/feedback" element={<AuthenticatedLayout><Feedback /></AuthenticatedLayout>} />
              <Route path="/pending-actions" element={<AuthenticatedLayout><PendingActions /></AuthenticatedLayout>} />
              <Route path="/weekly-summary" element={<AuthenticatedLayout><WeeklySummary /></AuthenticatedLayout>} />
              <Route path="/recurring-expenses" element={<AuthenticatedLayout><RecurringExpenses /></AuthenticatedLayout>} />
              <Route path="/recurring-approvals" element={<AuthenticatedLayout><RecurringApprovals /></AuthenticatedLayout>} />
              <Route path="/alarms" element={<AuthenticatedLayout><AlarmsHub /></AuthenticatedLayout>} />
              <Route path="/todo" element={<AuthenticatedLayout><ToDoList /></AuthenticatedLayout>} />
              <Route path="/chat" element={<AuthenticatedLayout><MembersChat /></AuthenticatedLayout>} />
              <Route path="/friends" element={<AuthenticatedLayout><Friends /></AuthenticatedLayout>} />
              <Route path="/progress" element={<AuthenticatedLayout><MyProgress /></AuthenticatedLayout>} />
              <Route path="/my-style" element={<AuthenticatedLayout><MyStyle /></AuthenticatedLayout>} />
              <Route path="/health" element={<AuthenticatedLayout><Health /></AuthenticatedLayout>} />
              <Route path="/health/glucose" element={<AuthenticatedLayout><HealthGlucose /></AuthenticatedLayout>} />
              <Route path="/health/blood-pressure" element={<AuthenticatedLayout><HealthBloodPressure /></AuthenticatedLayout>} />
              <Route path="/health/medicines" element={<AuthenticatedLayout><HealthMedicines /></AuthenticatedLayout>} />
              <Route path="/health/care-circle" element={<AuthenticatedLayout><CareCircle /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations" element={<AuthenticatedLayout><BabyVaccinations /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/add-child" element={<AuthenticatedLayout><AddBabyProfile /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/edit-profile/:profileId" element={<AuthenticatedLayout><AddBabyProfile /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/profile/:profileId" element={<AuthenticatedLayout><VaccineProfileView /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/deleted-babies" element={<AuthenticatedLayout><VaccineDeletedBabies /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/log-visit/:profileId/:visitKey" element={<AuthenticatedLayout><LogVaccineVisit /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/visit/:profileId/:visitKey" element={<AuthenticatedLayout><VaccineVisitDetail /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/caregivers/:profileId" element={<AuthenticatedLayout><VaccineCaregivers /></AuthenticatedLayout>} />
              <Route path="/baby-vaccinations/reminders/:profileId" element={<AuthenticatedLayout><VaccineReminders /></AuthenticatedLayout>} />
              <Route path="/u/:uid" element={<AuthenticatedLayout><PublicProfile /></AuthenticatedLayout>} />
              <Route path="/profile/visibility" element={<AuthenticatedLayout><ProfileVisibility /></AuthenticatedLayout>} />
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
              <Route path="/games/rummy13" element={<AuthenticatedLayout><Rummy13Lobby /></AuthenticatedLayout>} />
              <Route path="/games/rummy13/:tableId" element={<GameRouteKey><AuthenticatedLayout><Rummy13Game /></AuthenticatedLayout></GameRouteKey>} />
              <Route path="/games/spadePledge" element={<AuthenticatedLayout><SpadePledgeLobby /></AuthenticatedLayout>} />
              <Route path="/games/spadePledge/:tableId" element={<GameRouteKey><AuthenticatedLayout><SpadePledgeGame /></AuthenticatedLayout></GameRouteKey>} />
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
              <Route path="/reminders" element={<Navigate to="/tools?category=productivity" replace />} />
              <Route path="/goals" element={<AuthenticatedLayout><GoalsHub /></AuthenticatedLayout>} />
              <Route path="/goals/new" element={<AuthenticatedLayout><GoalWizard /></AuthenticatedLayout>} />
              <Route path="/goals/allocate" element={<AuthenticatedLayout><GoalAllocationManager /></AuthenticatedLayout>} />
              <Route path="/goals/reports" element={<AuthenticatedLayout><GoalReports /></AuthenticatedLayout>} />
              <Route path="/goals/accounts" element={<AuthenticatedLayout><AccountsHub /></AuthenticatedLayout>} />
              <Route path="/goals/accounts/:accountId" element={<AuthenticatedLayout><AccountDetail /></AuthenticatedLayout>} />
              <Route path="/goals/:goalId" element={<AuthenticatedLayout><GoalDetail /></AuthenticatedLayout>} />
              <Route path="/goals/:goalId/edit" element={<AuthenticatedLayout><GoalWizard /></AuthenticatedLayout>} />
              <Route path="/goals/:goalId/allocate" element={<AuthenticatedLayout><GoalFundingSetup /></AuthenticatedLayout>} />
              <Route path="/personal-loans" element={<AuthenticatedLayout><PersonalLoans /></AuthenticatedLayout>} />
              <Route path="/personal-loans/:contactId" element={<AuthenticatedLayout><LoanContactDetail /></AuthenticatedLayout>} />
              <Route path="/policies" element={<AuthenticatedLayout><PolicyVault /></AuthenticatedLayout>} />
              <Route path="/policies/new" element={<AuthenticatedLayout><PolicyWizard /></AuthenticatedLayout>} />
              <Route path="/policies/:policyId" element={<AuthenticatedLayout><PolicyDetail /></AuthenticatedLayout>} />
              <Route path="/policies/:policyId/edit" element={<AuthenticatedLayout><PolicyWizard /></AuthenticatedLayout>} />

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
              <Route path="/admin/metrics" element={<AdminRoute><AdminMetrics /></AdminRoute>} />
              <Route path="/admin/growth" element={<AdminRoute><AdminGrowth /></AdminRoute>} />
              <Route path="/admin/manage-admins" element={<AdminRoute><AdminManageAdmins /></AdminRoute>} />
              <Route path="/admin/feedback" element={<AdminRoute><AdminFeedback /></AdminRoute>} />
              <Route path="/admin/app-version" element={<AdminRoute><AdminAppVersion /></AdminRoute>} />
              <Route path="/admin/builds" element={<AdminRoute><AdminBuilds /></AdminRoute>} />
              <Route path="/admin/broadcast" element={<AdminRoute><AdminBroadcast /></AdminRoute>} />
              <Route path="/admin/shopkeeper-requests" element={<AdminRoute><AdminShopkeeperRequests /></AdminRoute>} />
              <Route path="/admin/chat-reports" element={<AdminRoute><AdminChatReports /></AdminRoute>} />

              {/* Global Catch-all */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </React.Suspense>
            </div>
          </div>
        </Router>
      </FabActionProvider>
      </NotificationProvider>
      </ShopModeProvider>
      </LanguageProvider>
    </AuthProvider>
  );
}
