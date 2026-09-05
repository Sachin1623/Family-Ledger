import React, { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, doc } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { PieChart, Pie, Cell, ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import { getCurrencySymbol, EXPENSE_CATEGORIES, INCOME_CATEGORIES, getCategoryClassification, getGroupCategories, getCategoryNameOverride } from '../lib/constants';
import { groupIconEmoji } from '../lib/groupIcons';
import { ChatButton, ChatPanel, useGameChat } from '../components/GameChat';
import { shareWithAi } from '../lib/aiShare';
import { buildGroupAiPrompt } from '../lib/buildAiPrompt';
import { parseLocalDate, todayLocalDateString, currentLocalMonthKey } from '../lib/dateUtils';
import { shareOrDownloadFile } from '../lib/fileShare';
import { useLanguage } from '../context/LanguageContext';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Small pill toggle shared by the three archived-groups toggles on this page (Spending by Group's
// own, and the one Category + Member Contributions share) — same on/off pill styling already used
// elsewhere on this screen for the essential/optional filter, just compact enough to sit in a
// section header next to its existing icon button.
function ArchiveToggle({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={checked}
      className={clsx(
        'p-2 rounded-xl border transition-all shrink-0',
        checked ? 'bg-primary text-white border-primary' : 'bg-primary/5 text-primary border-primary/10 hover:bg-primary/10',
      )}
    >
      <span className="material-symbols-outlined text-[18px] block">archive</span>
    </button>
  );
}

// This-month/last-month readout shared by Spending by Group, Spending by Category, and Member
// Contributions — deliberately computed from the real current calendar month regardless of
// whatever month/year/category filters are currently narrowing the rest of the page, since a
// stable "how am I doing right now vs last month" comparison is the whole point of showing it.
// `t` is passed in rather than this being its own component, same as describeCadence() elsewhere
// in this codebase, to avoid re-deriving `useLanguage()` in a tiny leaf just for one string.
function MonthComparisonLine({
  thisMonth,
  lastMonth,
  currencySymbol,
  t,
}: {
  thisMonth: number;
  lastMonth: number;
  currencySymbol: string;
  t: (key: string, vars?: Record<string, any>) => string;
}) {
  if (thisMonth === 0 && lastMonth === 0) return null;
  const delta = thisMonth - lastMonth;
  const pct = lastMonth > 0 ? Math.round((Math.abs(delta) / lastMonth) * 100) : null;
  return (
    <div className="flex items-center gap-1.5 text-[9px] font-bold text-text-muted mt-0.5 flex-wrap">
      <span>{t('analysis.thisMonth')} {currencySymbol}{thisMonth.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      <span className="opacity-40">·</span>
      <span>{t('analysis.lastMonth')} {currencySymbol}{lastMonth.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      {pct !== null && delta !== 0 && (
        <span className={delta > 0 ? 'text-error' : 'text-success'}>
          {delta > 0 ? '▲' : '▼'} {pct}%
        </span>
      )}
    </div>
  );
}

// Renders a slice's percentage AT the ring's own mid-radius (halfway between inner and outer),
// so the text always sits inside the donut itself — never an external leader-line label that
// could extend past the chart's own container. Recharts calls this with cx/cy/midAngle/radii/
// percent for every slice automatically when passed as <Pie label={...}>.
const RADIAN = Math.PI / 180;
// Attached to all three stacked Bar segments (essential/optional/income) — only the ONE that's
// actually the topmost non-zero segment for a given bar draws anything, so the total-value label
// always sits at the real top of that specific bar regardless of which segments happen to be
// zero for that period (varies point to point — a period with no income shouldn't get its label
// positioned as if it had some).
function topStackSegment(point: { essential: number; optional: number; income: number }): 'essential' | 'optional' | 'income' {
  if (point.income > 0) return 'income';
  if (point.optional > 0) return 'optional';
  return 'essential';
}
function makeStackTotalLabel(segment: 'essential' | 'optional' | 'income', trendData: any[], currencySymbol: string) {
  return (props: any) => {
    const { x, y, width, index } = props;
    const point = trendData[index];
    if (!point || !point.value || topStackSegment(point) !== segment) return <g key={`stack-label-empty-${segment}-${index}`} />;
    return (
      <text key={`stack-label-${segment}-${index}`} x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#0F4761">
        {`${currencySymbol}${Math.round(point.value)}`}
      </text>
    );
  };
}

function renderDonutPercentLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) {
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight="bold">
      {`${Math.round(percent * 100)}%`}
    </text>
  );
}

interface AnalysisBookmark {
  id: string;
  name: string;
  filters: {
    selectedGroupId: string | 'all' | null;
    entryTypeFilter: 'all' | 'expense' | 'income';
    selectedCategory: string | 'all';
    selectedMemberId: string | null;
    selectedMonths: number[];
    selectedYears: number[];
    viewType: 'time' | 'category' | 'member';
    timeStep: 'daily' | 'weekly' | 'monthly';
    // Optional — bookmarks saved before this filter existed simply won't have it; applyBookmark
    // defaults to 'all' in that case.
    selectedClassification?: 'all' | 'essential' | 'optional';
  };
}

function bookmarksStorageKey(uid: string) {
  return `familyledger_analysis_bookmarks_${uid}`;
}

function loadBookmarks(uid: string): AnalysisBookmark[] {
  try {
    const raw = localStorage.getItem(bookmarksStorageKey(uid));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function GroupAnalysisSummary() {
  const { groupId: routeGroupId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [selectedGroupId, setSelectedGroupId] = useState<string | 'all' | null>(routeGroupId || 'all');
  // A tapped "new chat message" push/in-app banner (see /api/chat/send's bannerTo +
  // InviteBanner.tsx) deep-links here as `/groups/:groupId?chat=1` — auto-opens the chat panel
  // instead of just landing on the group page, same `?param` pattern as Dashboard.tsx's `?dm=` for
  // direct messages. Reacts to `searchParams` itself (not a mount-only effect) — if this screen is
  // already mounted (the user's already browsing a group, this one or another) when the
  // notification is tapped, React Router reuses the same component instance instead of remounting
  // it, so a mount-only effect would never see the new `chat=1` and the panel would silently never
  // open.
  const [searchParams, setSearchParams] = useSearchParams();
  const [showChat, setShowChat] = useState(false);
  useEffect(() => {
    if (searchParams.get('chat') === '1') {
      setShowChat(true);
      const next = new URLSearchParams(searchParams);
      next.delete('chat');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const chatGroupId = selectedGroupId && selectedGroupId !== 'all' ? selectedGroupId : undefined;
  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('groups', chatGroupId);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'time' | 'category' | 'member'>('time');
  const [timeStep, setTimeStep] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [sortOrder, setSortOrder] = useState<'none' | 'asc' | 'desc'>('none');
  // Independent of `sortOrder` above (which sorts by the Y axis — spend value). This sorts by the
  // X axis instead — chronologically for the time view, alphabetically for category/member — and
  // takes priority over `sortOrder` whenever it's set. `null` means "not active," falling all the
  // way back to the exact pre-existing behavior (chronological for time, value-desc otherwise).
  const [xSortOrder, setXSortOrder] = useState<'asc' | 'desc' | null>('asc');
  const [selectedCategory, setSelectedCategory] = useState<string | 'all'>('all');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showYearDropdown, setShowYearDropdown] = useState(false);
  const [showTimeStepDropdown, setShowTimeStepDropdown] = useState(false);
  const [entryTypeFilter, setEntryTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [selectedClassification, setSelectedClassification] = useState<'all' | 'essential' | 'optional'>('all');
  // Archived groups are still fully present in `expenses`/`categoryFilteredExpenses` (nothing
  // upstream filters them out — the "All Groups" combined chart, trend line, essential/optional
  // split, and favorites list all still include them exactly as before). These two toggles only
  // gate the three specific sections the archive feature was scoped to: Spending by Group (its
  // own toggle) and Spending by Category + Member Contributions (sharing one, since they were
  // asked for together and there's no reason those two would ever want to disagree).
  const [showArchivedInGroupSpending, setShowArchivedInGroupSpending] = useState(false);
  const [includeArchivedInCategoryMember, setIncludeArchivedInCategoryMember] = useState(false);
  // Quick month/year filters — multi-select (e.g. "every January and July across 2024 and 2025"),
  // empty means "no restriction" for that axis. Kept independent of `timeStep`/`viewType` (which
  // only control how the chart GROUPS/labels data, not which expenses are included at all).
  const [selectedMonths, setSelectedMonths] = useState<number[]>([]);
  const [selectedYears, setSelectedYears] = useState<number[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [bookmarks, setBookmarks] = useState<AnalysisBookmark[]>([]);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  // Splits what used to be one long scroll (chart+filters, essential/optional, favorites,
  // group/category breakdowns, member contributions, AI analysis) into tabs — same tab-bar
  // pattern already used on HealthMedicines.tsx and Profile.tsx. Every filter (category/member/
  // month/year/entry-type/essential-optional) still applies globally across all five tabs' data
  // exactly as before — only the FILTER CONTROLS themselves stay inside the Trend tab (that's
  // where they've always lived); the active-filter count + Clear All now sits above the tab bar
  // instead, so switching to another tab never loses the "something's filtered" signal.
  // Categories and Groups were originally one combined "Breakdown" tab, split into two per
  // explicit request — Essential vs Optional rides along with Categories (both are ways of
  // slicing spend by category), Groups only ever has anything to show in the "All Groups" view
  // (same pre-existing condition as before, just no longer sharing a 2-column grid with Categories).
  const [analysisTab, setAnalysisTab] = useState<'trend' | 'categories' | 'groups' | 'members'>('trend');

  // Every "view transactions" link on this screen carries the currently-active filters over to
  // Group Expenses as query params (read back by GroupExpenses.tsx), so switching screens doesn't
  // silently drop context back to an unfiltered list. `categoryOverride`/`memberOverride` let a
  // specific category/member row's own tap target that ONE value regardless of what the
  // screen-wide selectedCategory/selectedMemberId filter is currently set to.
  const buildExpensesLink = (categoryOverride?: string, memberOverride?: string) => {
    const base = selectedGroupId === 'all' || !selectedGroupId ? '/groups/all/expenses' : `/groups/${selectedGroupId}/expenses`;
    const params = new URLSearchParams();
    if (entryTypeFilter !== 'all') params.set('type', entryTypeFilter);
    if (selectedClassification !== 'all') params.set('classification', selectedClassification);
    const cat = categoryOverride || (selectedCategory !== 'all' ? selectedCategory : '');
    if (cat) params.set('category', cat);
    const member = memberOverride || selectedMemberId;
    if (member) params.set('memberId', member);
    if (selectedMonths.length > 0) params.set('months', selectedMonths.join(','));
    if (selectedYears.length > 0) params.set('years', selectedYears.join(','));
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  useEffect(() => {
    if (user) setBookmarks(loadBookmarks(user.uid));
  }, [user]);

  const toggleMonth = (m: number) => setSelectedMonths((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  const toggleYear = (y: number) => setSelectedYears((prev) => (prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y]));

  const activeFilterCount =
    (entryTypeFilter !== 'all' ? 1 : 0) +
    (selectedClassification !== 'all' ? 1 : 0) +
    (selectedCategory !== 'all' ? 1 : 0) +
    (selectedMemberId ? 1 : 0) +
    selectedMonths.length +
    selectedYears.length;

  const clearAllFilters = () => {
    setEntryTypeFilter('all');
    setSelectedClassification('all');
    setSelectedCategory('all');
    setSelectedMemberId(null);
    setSelectedMonths([]);
    setSelectedYears([]);
  };

  const persistBookmarks = (next: AnalysisBookmark[]) => {
    setBookmarks(next);
    if (user) {
      try {
        localStorage.setItem(bookmarksStorageKey(user.uid), JSON.stringify(next));
      } catch {
        // localStorage unavailable — bookmarks just won't persist across sessions this time.
      }
    }
  };

  const saveCurrentAsBookmark = () => {
    const name = newBookmarkName.trim();
    if (!name) return;
    const bookmark: AnalysisBookmark = {
      id: `${Date.now()}`,
      name,
      filters: { selectedGroupId, entryTypeFilter, selectedCategory, selectedMemberId, selectedMonths, selectedYears, viewType, timeStep, selectedClassification },
    };
    persistBookmarks([...bookmarks, bookmark]);
    setNewBookmarkName('');
  };

  const applyBookmark = (b: AnalysisBookmark) => {
    setSelectedGroupId(b.filters.selectedGroupId);
    setEntryTypeFilter(b.filters.entryTypeFilter);
    setSelectedClassification(b.filters.selectedClassification || 'all');
    setSelectedCategory(b.filters.selectedCategory);
    setSelectedMemberId(b.filters.selectedMemberId);
    setSelectedMonths(b.filters.selectedMonths);
    setSelectedYears(b.filters.selectedYears);
    setViewType(b.filters.viewType);
    setTimeStep(b.filters.timeStep);
    setShowBookmarks(false);
  };

  const deleteBookmark = (id: string) => {
    persistBookmarks(bookmarks.filter((b) => b.id !== id));
  };

  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [aiSharing, setAiSharing] = useState(false);
  const [aiShareMessage, setAiShareMessage] = useState<string | null>(null);

  const [membershipsValue, loadingMemberships] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null
  );
  const memberships = membershipsValue?.docs.map(doc => doc.data()) || [];
  const groupIds = memberships.map((m: any) => m.groupId);

  useEffect(() => {
    if (routeGroupId) {
      setSelectedGroupId(routeGroupId);
      
      // If we have loaded memberships and this specific group ID is NOT in them, redirect to join
      if (routeGroupId !== 'all' && membershipsValue && !loadingMemberships && !groupIds.includes(routeGroupId)) {
        // Redirect to join page if not a member
        navigate(`/join/${routeGroupId}`);
      }
    }
  }, [routeGroupId, groupIds, membershipsValue, loadingMemberships, navigate]);

  const [groupValue] = useDocument(
    selectedGroupId && selectedGroupId !== 'all' ? doc(db, 'groups', selectedGroupId) : null
  );
  const groupData = groupValue?.data();

  // Monthly budgets for the selected group, keyed by "YYYY-MM" — only meaningful for a
  // single specific group (not the combined "All Groups" view), and only overlaid on the
  // monthly bar chart, never weekly/daily.
  const [groupBudgetsValue] = useCollection(
    selectedGroupId && selectedGroupId !== 'all'
      ? query(collection(db, 'groupBudgets'), where('groupId', '==', selectedGroupId))
      : null
  );
  const budgetsByMonth = useMemo(() => {
    const map: Record<string, number> = {};
    groupBudgetsValue?.docs.forEach((d) => {
      const data = d.data();
      map[data.month] = data.amount;
    });
    return map;
  }, [groupBudgetsValue]);

  const [allGroupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null
  );
  const allGroups = allGroupsValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[];

  // Group-aware: hides whatever the relevant group(s) hid and includes their custom categories —
  // in "all my groups" mode there's no single group to scope to, so it's the union across every
  // group the user belongs to (de-duped by id; custom ids can't collide across groups, see
  // makeCustomCategoryId), same idiom as GroupExpenses.tsx's filterCategoryOptions.
  const CATEGORIES_LIST = useMemo(() => {
    const wantExpense = entryTypeFilter !== 'income';
    const wantIncome = entryTypeFilter !== 'expense';
    if (selectedGroupId === 'all' || !selectedGroupId) {
      const map = new Map<string, { id: string; name: string; icon: string }>();
      allGroups.forEach((g: any) => {
        if (wantExpense) getGroupCategories(g, 'expense').forEach((c) => { if (!map.has(c.id)) map.set(c.id, c); });
        if (wantIncome) getGroupCategories(g, 'income').forEach((c) => { if (!map.has(c.id)) map.set(c.id, c); });
      });
      return Array.from(map.values());
    }
    return [
      ...(wantExpense ? getGroupCategories(groupData, 'expense') : []),
      ...(wantIncome ? getGroupCategories(groupData, 'income') : []),
    ];
  }, [entryTypeFilter, selectedGroupId, allGroups, groupData]);
  // Income and expense categories live under different i18n namespaces (income.* vs category.*)
  // — this screen shows both once entryTypeFilter is 'income'/'all', so every category label
  // needs to resolve the right one instead of assuming category.* (which silently rendered the
  // raw, untranslated key string for an income category id, looking like the category was
  // missing entirely). A renamed/custom category resolves through whichever group actually owns
  // it — in single-group mode that's simply the viewed group; in "all groups" mode, the one group
  // (if any) whose customCategories contains this id.
  const categoryLabel = (id: string) => {
    const scopeGroup = selectedGroupId !== 'all' && selectedGroupId
      ? groupData
      : allGroups.find((g: any) => (g.customCategories || []).some((c: any) => c.id === id));
    const override = getCategoryNameOverride(scopeGroup, id);
    if (override) return override;
    return t(`${INCOME_CATEGORIES.some((c) => c.id === id) ? 'income' : 'category'}.${id}`);
  };

  // Fetch ALL members for relevant groups to have a full map of displays
  const [allRelevantMembersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null
  );
  const allRelevantMembers = allRelevantMembersValue?.docs.map(doc => ({ id: doc.id, ...doc.data() } as any)) || [];

  const currencySymbol = useMemo(() => {
    if (selectedGroupId && selectedGroupId !== 'all') {
      return getCurrencySymbol(groupData?.currency);
    }
    // If "All Groups", default to the first group's currency or $
    if (allGroups.length > 0) {
      return getCurrencySymbol(allGroups[0].currency);
    }
    return '$';
  }, [groupData?.currency, selectedGroupId, allGroups]);

  const groupMembers = useMemo(() => {
    const raw = selectedGroupId === 'all' 
      ? allRelevantMembers 
      : allRelevantMembers.filter(m => m.groupId === selectedGroupId);
    
    // Always deduplicate by userId to prevent rendering errors
    const unique = new Map();
    raw.forEach(m => {
      if (!unique.has(m.userId)) unique.set(m.userId, m);
    });
    return Array.from(unique.values());
  }, [allRelevantMembers, selectedGroupId]);

  const selectedMember = groupMembers.find(m => m.userId === selectedMemberId);

  const [expensesValue] = useCollection(
    selectedGroupId === 'all' 
      ? (groupIds.length > 0 ? query(collection(db, 'expenses'), where('groupId', 'in', groupIds)) : null)
      : (selectedGroupId ? query(collection(db, 'expenses'), where('groupId', '==', selectedGroupId)) : null)
  );
  
  const allExpenses = useMemo(() => {
    const exps = expensesValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[];
    // Only include expenses from groups that actually exist and the user is a member of.
    // Income entries are included/excluded per entryTypeFilter (defaults to expense-only, this
    // screen's original behavior) rather than always excluded — see the All/Expenses/Income
    // toggle in the filters row below.
    const activeGroupIds = allGroups.map(g => g.id);
    return exps.filter((exp: any) => {
      if (!activeGroupIds.includes(exp.groupId)) return false;
      if (entryTypeFilter === 'all') return true;
      return entryTypeFilter === 'income' ? exp.type === 'income' : exp.type !== 'income';
    });
  }, [expensesValue, allGroups, entryTypeFilter]);
  
  // Every year actually present in this scope's data, for the quick year-filter row — always
  // includes the current year even with zero history yet, so a brand-new group isn't left with
  // nothing to tap.
  const availableYears = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    allExpenses.forEach((exp) => years.add(parseLocalDate(exp.date).getFullYear()));
    return Array.from(years).sort((a, b) => b - a);
  }, [allExpenses]);

  // Category/type/month/year all apply uniformly across the whole screen — chart, category and
  // group breakdowns, favorites — everything reads from this one filtered set. Only
  // `selectedMemberId` is held back into a further-filtered `expenses` below, since it's the one
  // filter that would make a couple of comparison-style sections (Spending by Group, Member
  // Contributions) collapse to a single trivial entry if applied to them too.
  const categoryFilteredExpenses = useMemo(() => {
    let filtered = allExpenses;
    if (selectedCategory && selectedCategory !== 'all') {
      filtered = filtered.filter(exp => exp.category === selectedCategory);
    }
    if (selectedMonths.length > 0) {
      filtered = filtered.filter(exp => selectedMonths.includes(parseLocalDate(exp.date).getMonth()));
    }
    if (selectedYears.length > 0) {
      filtered = filtered.filter(exp => selectedYears.includes(parseLocalDate(exp.date).getFullYear()));
    }
    // Income has no Essential/Optional concept, so it's never excluded by this filter — only
    // expense rows are actually checked against their (possibly per-group-overridden)
    // classification. See lib/constants.ts's getCategoryClassification.
    if (selectedClassification !== 'all') {
      filtered = filtered.filter(exp => {
        if (exp.type === 'income') return true;
        const expGroup = selectedGroupId === 'all' ? allGroups.find((g) => g.id === exp.groupId) : groupData;
        return getCategoryClassification(expGroup, exp.category) === selectedClassification;
      });
    }
    return filtered;
  }, [allExpenses, selectedCategory, selectedMonths, selectedYears, selectedClassification, selectedGroupId, allGroups, groupData]);

  const expenses = useMemo(() => {
    if (!selectedMemberId) return categoryFilteredExpenses;
    return categoryFilteredExpenses.filter(exp => exp.paidBy === selectedMemberId);
  }, [categoryFilteredExpenses, selectedMemberId]);

  // Essential vs Optional split of whatever's currently in `expenses` — same filtered scope the
  // bar chart above and every other section on this screen reads from. Income rows are excluded
  // outright (no classification concept applies to them), same as the filter itself.
  const essentialOptionalData = useMemo(() => {
    let essential = 0;
    let optional = 0;
    expenses.forEach((exp: any) => {
      if (exp.type === 'income') return;
      const expGroup = selectedGroupId === 'all' ? allGroups.find((g) => g.id === exp.groupId) : groupData;
      if (getCategoryClassification(expGroup, exp.category) === 'essential') essential += exp.amount || 0;
      else optional += exp.amount || 0;
    });
    return [
      { name: t('common.essential'), value: essential, color: '#16A34A' },
      { name: t('common.optional'), value: optional, color: '#EAB308' },
    ].filter((d) => d.value > 0);
  }, [expenses, selectedGroupId, allGroups, groupData, t]);

  const isArchivedExpense = (exp: any) => !!allGroups.find((g: any) => g.id === exp.groupId)?.archived;

  // Spending by Group has its own toggle; Category + Member Contributions share the other one —
  // both start from the same `expenses`/`categoryFilteredExpenses` everything else on this page
  // still reads unfiltered.
  const groupSpendingExpenses = useMemo(() => {
    return showArchivedInGroupSpending ? expenses : expenses.filter((exp: any) => !isArchivedExpense(exp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, allGroups, showArchivedInGroupSpending]);

  const categoryMemberExpenses = useMemo(() => {
    return includeArchivedInCategoryMember ? expenses : expenses.filter((exp: any) => !isArchivedExpense(exp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, allGroups, includeArchivedInCategoryMember]);

  // Member Contributions deliberately reads categoryFilteredExpenses (not `expenses` — see the
  // comment above where that's defined), so it needs its own archived-filtered variant rather
  // than reusing categoryMemberExpenses.
  const categoryMemberContributionExpenses = useMemo(() => {
    return includeArchivedInCategoryMember ? categoryFilteredExpenses : categoryFilteredExpenses.filter((exp: any) => !isArchivedExpense(exp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryFilteredExpenses, allGroups, includeArchivedInCategoryMember]);

  // This-month/last-month readouts for the same three sections — deliberately built from
  // `allExpenses` (group-scoped + entryTypeFilter-respecting, but NOT re-filtered by whatever
  // month/year/category the user currently has selected elsewhere on the page), so the numbers
  // always answer "how does my real current month compare to last month," not "how does the
  // currently-filtered view compare." Each still respects its own section's archived-groups
  // toggle, same as the totals right above.
  const thisMonthKey = currentLocalMonthKey();
  const lastMonthKey = useMemo(() => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const monthComparisonByGroup = useMemo(() => {
    const thisMonth: Record<string, number> = {};
    const lastMonth: Record<string, number> = {};
    const source = showArchivedInGroupSpending ? allExpenses : allExpenses.filter((exp: any) => !isArchivedExpense(exp));
    source.forEach((exp: any) => {
      const g = allGroups.find((gr: any) => gr.id === exp.groupId);
      if (!g) return;
      const mk = String(exp.date || '').slice(0, 7);
      if (mk === thisMonthKey) thisMonth[g.name] = (thisMonth[g.name] || 0) + exp.amount;
      else if (mk === lastMonthKey) lastMonth[g.name] = (lastMonth[g.name] || 0) + exp.amount;
    });
    return { thisMonth, lastMonth };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allExpenses, allGroups, showArchivedInGroupSpending, thisMonthKey, lastMonthKey]);

  const monthComparisonByCategory = useMemo(() => {
    const thisMonth: Record<string, number> = {};
    const lastMonth: Record<string, number> = {};
    const source = includeArchivedInCategoryMember ? allExpenses : allExpenses.filter((exp: any) => !isArchivedExpense(exp));
    source.forEach((exp: any) => {
      const mk = String(exp.date || '').slice(0, 7);
      if (mk === thisMonthKey) thisMonth[exp.category] = (thisMonth[exp.category] || 0) + exp.amount;
      else if (mk === lastMonthKey) lastMonth[exp.category] = (lastMonth[exp.category] || 0) + exp.amount;
    });
    return { thisMonth, lastMonth };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allExpenses, allGroups, includeArchivedInCategoryMember, thisMonthKey, lastMonthKey]);

  const monthComparisonByMember = useMemo(() => {
    const thisMonth: Record<string, number> = {};
    const lastMonth: Record<string, number> = {};
    const source = includeArchivedInCategoryMember ? allExpenses : allExpenses.filter((exp: any) => !isArchivedExpense(exp));
    source.forEach((exp: any) => {
      if (!exp.paidBy) return;
      const mk = String(exp.date || '').slice(0, 7);
      if (mk === thisMonthKey) thisMonth[exp.paidBy] = (thisMonth[exp.paidBy] || 0) + exp.amount;
      else if (mk === lastMonthKey) lastMonth[exp.paidBy] = (lastMonth[exp.paidBy] || 0) + exp.amount;
    });
    return { thisMonth, lastMonth };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allExpenses, allGroups, includeArchivedInCategoryMember, thisMonthKey, lastMonthKey]);

  // Data processing
  const categoryData = useMemo(() => {
    const counts: Record<string, number> = {};
    // Initialize all categories with 0 to show them even if no expenses exist
    CATEGORIES_LIST.forEach(cat => {
      counts[cat.id] = 0;
    });

    categoryMemberExpenses.forEach(exp => {
      counts[exp.category] = (counts[exp.category] || 0) + exp.amount;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [categoryMemberExpenses, CATEGORIES_LIST]);

  const groupSpendingData = useMemo(() => {
    if (selectedGroupId !== 'all') return [];
    const counts: Record<string, number> = {};
    groupSpendingExpenses.forEach(exp => {
      const g = allGroups.find(gr => gr.id === exp.groupId);
      if (g) {
        counts[g.name] = (counts[g.name] || 0) + exp.amount;
      }
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [groupSpendingExpenses, allGroups, selectedGroupId]);

  const totalSpending = useMemo(() => {
    return categoryMemberExpenses.reduce((acc, exp) => acc + exp.amount, 0);
  }, [categoryMemberExpenses]);

  const trendData = useMemo(() => {
    const dataMap: Record<string, { value: number; essential: number; optional: number; income: number; label: string }> = {};

    expenses.forEach(exp => {
      let key = '';
      let label = '';

      if (viewType === 'time') {
        const date = parseLocalDate(exp.date);
        const yy = date.getFullYear().toString().slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');

        if (timeStep === 'monthly') {
          key = `${date.getFullYear()}-${mm}`;
          label = `${mm}-${yy}`;
        } else if (timeStep === 'weekly') {
          // Calculate ISO week number (for grouping/sorting)
          const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
          const dayNum = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() + 4 - dayNum);
          const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
          key = `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;

          // Label shows the Monday of that week as DD-MM-YY
          const dayOfWeek = date.getDay();
          const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          const monday = new Date(date);
          monday.setDate(date.getDate() + diffToMonday);
          const mDd = String(monday.getDate()).padStart(2, '0');
          const mMm = String(monday.getMonth() + 1).padStart(2, '0');
          const mYy = String(monday.getFullYear()).slice(-2);
          label = `${mDd}-${mMm}-${mYy}`;
        } else {
          key = `${date.getFullYear()}-${mm}-${dd}`;
          label = `${dd}-${mm}-${yy}`;
        }
      } else if (viewType === 'category') {
        key = exp.category;
        label = categoryLabel(exp.category);
      } else if (viewType === 'member') {
        key = exp.paidBy;
        label = groupMembers.find(m => m.userId === exp.paidBy)?.displayName || t('common.unknown');
      }
      
      // Stacked-bar breakdown: income never carries an Essential/Optional classification, so it
      // gets its own stack segment rather than being forced into one bucket or the other — this
      // way the stacked bar's total height always still equals `value` exactly, whatever mix of
      // expense/income the current entryTypeFilter includes.
      const isIncome = exp.type === 'income';
      const expGroup = selectedGroupId === 'all' ? allGroups.find((g: any) => g.id === exp.groupId) : groupData;
      const classification = !isIncome ? getCategoryClassification(expGroup, exp.category) : null;
      const prev = dataMap[key] || { value: 0, essential: 0, optional: 0, income: 0, label };
      dataMap[key] = {
        value: prev.value + exp.amount,
        essential: prev.essential + (classification === 'essential' ? exp.amount : 0),
        optional: prev.optional + (classification === 'optional' ? exp.amount : 0),
        income: prev.income + (isIncome ? exp.amount : 0),
        label,
      };
    });

    const showBudget = viewType === 'time' && timeStep === 'monthly' && selectedGroupId !== 'all';

    let result = Object.entries(dataMap)
      .map(([key, data]) => ({
        name: data.label,
        value: data.value,
        essential: data.essential,
        optional: data.optional,
        income: data.income,
        originalKey: key,
        ...(showBudget && budgetsByMonth[key] != null ? { budget: budgetsByMonth[key] } : {}),
      }));

    // For the time view, "most recent 30 buckets" is always resolved chronologically FIRST,
    // before any display sort is applied — otherwise picking e.g. "sort by date, newest first"
    // would flip the array before slicing and `.slice(-30)` would grab the 30 OLDEST buckets
    // instead of the most recent ones, the opposite of what choosing that sort implies.
    if (viewType === 'time') {
      result.sort((a, b) => a.originalKey.localeCompare(b.originalKey));
      result = result.slice(-30);
    }

    if (xSortOrder) {
      if (viewType === 'time') {
        result.sort((a, b) => (xSortOrder === 'asc' ? a.originalKey.localeCompare(b.originalKey) : b.originalKey.localeCompare(a.originalKey)));
      } else {
        result.sort((a, b) => (xSortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)));
      }
    } else if (viewType === 'time' && sortOrder === 'none') {
      // Already in chronological-ascending order from the slice step above — nothing more to do.
    } else {
      if (sortOrder === 'asc') {
        result.sort((a, b) => a.value - b.value);
      } else {
        result.sort((a, b) => b.value - a.value);
      }
    }

    return result;
  }, [expenses, timeStep, sortOrder, xSortOrder, viewType, groupMembers, CATEGORIES_LIST, selectedGroupId, budgetsByMonth, allGroups, groupData, t]);

  const handleDownload = async () => {
    if (expenses.length === 0) {
      alert('No data to download');
      return;
    }

    const headers = ['Date', 'Description', 'Category', 'Member', 'Amount', 'Currency', 'Group', 'Added At'];
    const csvContent = [
      headers.join(','),
      ...expenses.map(exp => {
        const member = groupMembers.find(m => m.userId === exp.paidBy);
        const group = allGroups.find(g => g.id === exp.groupId);
        return [
          exp.date,
          `"${exp.description.replace(/"/g, '""')}"`,
          exp.category,
          member?.displayName || exp.paidBy,
          exp.amount,
          group?.currency || 'USD',
          `"${group?.name.replace(/"/g, '""') || exp.groupId}"`,
          exp.createdAt || exp.date
        ].join(',');
      })
    ].join('\n');
    const filename = `expenses_analysis_${todayLocalDateString()}.csv`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    await shareOrDownloadFile(blob, filename, 'text/csv');
  };

  const handleAiAnalysis = async () => {
    if (expenses.length === 0) {
      setAiShareMessage('Add some expenses first — there\'s nothing to analyze yet.');
      return;
    }
    setAiSharing(true);
    setAiShareMessage(null);
    try {
      const categoryNames: Record<string, string> = {};
      CATEGORIES_LIST.forEach((c) => { categoryNames[c.id] = c.name; });

      const prompt = buildGroupAiPrompt({
        groupName: groupData?.name || 'this group',
        currencySymbol,
        expenses,
        members: groupMembers as any,
        categoryNames,
      });

      const result = await shareWithAi(prompt, `Analyze ${groupData?.name || 'group'} spending`);
      if (!result.success) {
        if (result.reason === 'no_ai_app_installed') {
          setAiShareMessage('No supported AI app found. Install Google Gemini, Microsoft Copilot, ChatGPT, or Claude to use this feature.');
        } else if (result.reason === 'clipboard_fallback') {
          setAiShareMessage('Your browser can\'t share directly to apps, so the analysis prompt was copied to your clipboard instead — paste it into your AI app of choice.');
        } else if (result.reason !== 'cancelled') {
          setAiShareMessage('Could not share the analysis. Please try again.');
        }
      }
    } catch (err) {
      console.error('AI share failed:', err);
      setAiShareMessage('Could not share the analysis. Please try again.');
    } finally {
      setAiSharing(false);
    }
  };

  const COLORS = ['#0F4761', '#16A34A', '#F59E0B', '#F87171', '#818CF8', '#F472B6', '#10B981', '#3B82F6'];
  const CATEGORY_COLORS: Record<string, string> = {
    'housing': '#0F4761',
    'food': '#16A34A',
    'groceries': '#10B981',
    'travel': '#F59E0B',
    'bills': '#F87171',
    'personal': '#818CF8',
    'health': '#F472B6',
    'education': '#10B981',
    'ent': '#3B82F6',
    'finance': '#6366F1',
    'shopping': '#EC4899',
    'household': '#14B8A6',
    'misc': '#71787d'
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <div className="p-4 bg-white border-b border-border-subtle flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-xl font-bold text-primary truncate max-w-[200px]">
              {t('analysis.title')}
            </h1>
            {groupData?.splitEnabled && (
              <span className="material-symbols-outlined text-[18px] text-primary shrink-0" title="Split Enabled">call_split</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {chatGroupId && (
              <ChatButton
                onClick={() => { setShowChat(true); markChatSeen(); }}
                hasUnseen={chatUnseen}
                className="hover:bg-primary/10 rounded-full"
              />
            )}
            <div className="relative">
              <button
                onClick={() => setShowBookmarks((v) => !v)}
                className="relative p-2 hover:bg-surface-container rounded-full text-text-muted"
                title="Saved filter bookmarks"
              >
                <span className="material-symbols-outlined" style={{ fontVariationSettings: showBookmarks ? "'FILL' 1" : undefined }}>bookmark</span>
                {bookmarks.length > 0 && (
                  <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </button>
              <AnimatePresence>
                {showBookmarks && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowBookmarks(false)} />
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: -6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -6 }}
                      className="absolute right-0 top-11 z-50 w-64 bg-white rounded-2xl border border-border-subtle shadow-2xl p-3 space-y-2"
                    >
                      <p className="text-[10px] font-black text-text-muted uppercase tracking-widest px-1">Bookmarked Filters</p>
                      {bookmarks.length === 0 ? (
                        <p className="text-xs text-text-muted italic px-1 py-1">No bookmarks yet — set some filters below, then save them here.</p>
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {bookmarks.map((b) => (
                            <div key={b.id} className="flex items-center gap-1 group">
                              <button
                                onClick={() => applyBookmark(b)}
                                className="flex-1 min-w-0 text-left px-2.5 py-2 rounded-xl text-xs font-bold text-on-surface hover:bg-surface-container transition-colors truncate"
                              >
                                {b.name}
                              </button>
                              <button
                                onClick={() => deleteBookmark(b.id)}
                                className="p-1.5 text-text-muted hover:text-error shrink-0"
                                aria-label={`Delete ${b.name}`}
                              >
                                <span className="material-symbols-outlined text-[16px] block">delete</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="pt-2 border-t border-border-subtle flex items-center gap-1.5">
                        <input
                          type="text"
                          value={newBookmarkName}
                          onChange={(e) => setNewBookmarkName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentAsBookmark(); }}
                          placeholder="Save current filters as…"
                          className="flex-1 min-w-0 bg-surface px-2.5 py-2 rounded-xl border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20"
                        />
                        <button
                          onClick={saveCurrentAsBookmark}
                          disabled={!newBookmarkName.trim()}
                          className="p-2 bg-primary text-white rounded-xl disabled:opacity-40 shrink-0"
                          aria-label="Save bookmark"
                        >
                          <span className="material-symbols-outlined text-[16px] block">add</span>
                        </button>
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
            <button onClick={handleDownload} className="p-2 hover:bg-surface-container rounded-full text-text-muted">
              <span className="material-symbols-outlined">download</span>
            </button>
          </div>
        </div>

        {!routeGroupId && (
          <div className="relative" data-tour="analysis-group-filter">
            <select
              className="w-full bg-surface-container border border-border-subtle rounded-xl text-xs font-bold px-4 py-2.5 pr-10 appearance-none focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer h-10 shadow-sm"
              onChange={(e) => setSelectedGroupId(e.target.value)}
              value={selectedGroupId || ''}
            >
              <option value="all">{t('analysis.allMyGroups')}</option>
              {/* Archived groups stay fully selectable (their own history is still real data
                  worth looking at) — just pushed to the bottom and marked, rather than mixed in
                  with the groups actually in current use. A stable sort (archived-ness is the
                  only key) keeps everything else in its existing order. */}
              {[...allGroups].sort((a: any, b: any) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)).map((g: any) => (
                <option key={g.id} value={g.id}>{g.name}{g.archived ? ` (${t('analysis.archivedTag')})` : ''}</option>
              ))}
            </select>
            <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none text-[20px]">expand_more</span>
          </div>
        )}
      </div>

      <main className="flex-1 p-4 md:p-8 max-w-4xl mx-auto w-full space-y-6">
        {allGroups.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-text-muted gap-4">
            <span className="material-symbols-outlined text-5xl">group_off</span>
            <p className="font-bold">{t('analysis.notPartOfAnyGroups')}</p>
          </div>
        ) : (
          <>
            {/* Global filters — apply to every tab's data (chart, category/group/member
                breakdowns, favorites), not just Trend, so they live above the tab bar instead of
                being nested inside the Trend tile. */}
            <div className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm space-y-3">
              {/* Row 1 — every toggle-style filter (type + essential/optional) packed into one
                  wrapped row instead of two stacked ones. No explicit "All" pill — tapping the
                  active filter again clears it back to "all" internally, so the row only ever
                  shows real choices. */}
              <div className="flex items-center gap-2 flex-wrap">
                {([
                  { group: 'type' as const, key: 'expense', label: t('common.expense'), icon: 'shopping_cart', bubble: 'bg-amber-100 text-amber-600' },
                  { group: 'type' as const, key: 'income', label: t('common.income'), icon: 'payments', bubble: 'bg-blue-100 text-blue-600' },
                  { group: 'classification' as const, key: 'essential', label: t('common.essential'), icon: 'verified', bubble: 'bg-green-100 text-green-600' },
                  { group: 'classification' as const, key: 'optional', label: t('common.optional'), icon: 'sell', bubble: 'bg-orange-100 text-orange-600' },
                ] as const).map((opt) => {
                  const active = opt.group === 'type' ? entryTypeFilter === opt.key : selectedClassification === opt.key;
                  const onClick = () => {
                    if (opt.group === 'type') { setEntryTypeFilter(entryTypeFilter === opt.key ? 'all' : (opt.key as 'expense' | 'income')); setSelectedCategory('all'); }
                    else setSelectedClassification(selectedClassification === opt.key ? 'all' : (opt.key as 'essential' | 'optional'));
                  };
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={onClick}
                      className={clsx(
                        'flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border transition-all',
                        active ? 'border-primary bg-primary/5 shadow-sm' : 'border-border-subtle bg-white hover:bg-surface-container/40',
                      )}
                    >
                      <span className={clsx('w-7 h-7 rounded-full flex items-center justify-center shrink-0', opt.bubble)}>
                        <span className="material-symbols-outlined text-[15px]">{opt.icon}</span>
                      </span>
                      <span className={clsx('text-xs font-bold', active ? 'text-primary' : 'text-text-muted')}>{opt.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Row 2 — a year dropdown and the category/member dropdowns stay fixed; only the
                  month strip between them scrolls, so the dropdowns on the right are never pushed
                  off-screen by however many months are selected/scrolled to. */}
              <div className="flex items-center gap-1.5">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowYearDropdown(!showYearDropdown)}
                    className="bg-surface-container/30 h-8 px-3 rounded-lg text-[10px] font-bold text-primary flex items-center justify-between gap-1 border border-border-subtle hover:bg-surface-container transition-all shadow-sm"
                  >
                    <span className="whitespace-nowrap">{selectedYears.length === 0 ? t('analysis.allYears') : selectedYears.slice().sort((a, b) => a - b).join(', ')}</span>
                    <span className="material-symbols-outlined text-[16px] shrink-0">expand_more</span>
                  </button>
                  <AnimatePresence>
                    {showYearDropdown && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowYearDropdown(false)} />
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="absolute left-0 mt-1 w-36 bg-white border border-border-subtle rounded-xl shadow-2xl z-50 py-1 max-h-48 overflow-y-auto"
                        >
                          <button onClick={() => { setSelectedYears([]); setShowYearDropdown(false); }} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-surface-container transition-colors">{t('analysis.allYears')}</button>
                          {availableYears.map((year) => (
                            <button
                              key={year}
                              onClick={() => toggleYear(year)}
                              className={clsx(
                                'w-full flex items-center justify-between gap-2 text-left px-4 py-2.5 text-xs font-bold hover:bg-surface-container transition-colors',
                                selectedYears.includes(year) && 'text-primary',
                              )}
                            >
                              {year}
                              {selectedYears.includes(year) && <span className="material-symbols-outlined text-[16px]">check</span>}
                            </button>
                          ))}
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>

                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5 flex-1 min-w-0">
                  {MONTH_LABELS.map((label, idx) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleMonth(idx)}
                      className={clsx(
                        'shrink-0 px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition-all',
                        selectedMonths.includes(idx)
                          ? 'bg-primary text-white border-primary'
                          : 'bg-surface-container/30 text-text-muted border-border-subtle hover:bg-surface-container',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="w-px h-5 bg-border-subtle shrink-0 mx-0.5" />
                <div className="relative shrink-0">
                  <button
                    onClick={() => setShowCategoryDropdown(!showCategoryDropdown)}
                    className="w-32 bg-surface-container/30 h-8 px-3 rounded-lg text-[10px] font-bold text-primary flex items-center justify-between gap-1 border border-border-subtle hover:bg-surface-container transition-all shadow-sm"
                  >
                    <span className="truncate">{selectedCategory === 'all' ? t('analysis.allCategories') : categoryLabel(selectedCategory)}</span>
                    <span className="material-symbols-outlined text-[16px] shrink-0">expand_more</span>
                  </button>
                  <AnimatePresence>
                    {showCategoryDropdown && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="absolute right-0 mt-1 w-48 bg-white border border-border-subtle rounded-xl shadow-2xl z-[60] py-1 max-h-48 overflow-y-auto"
                      >
                        <button onClick={() => { setSelectedCategory('all'); setShowCategoryDropdown(false); }} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-surface-container transition-colors">{t('analysis.allCategories')}</button>
                        {CATEGORIES_LIST.map(cat => (
                          <button key={cat.id} onClick={() => { setSelectedCategory(cat.id); setShowCategoryDropdown(false); }} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-surface-container transition-colors">
                            {categoryLabel(cat.id)}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="relative shrink-0">
                  <button
                    onClick={() => setShowMemberDropdown(!showMemberDropdown)}
                    className="w-32 bg-surface-container/30 h-8 px-3 rounded-lg text-[10px] font-bold text-primary flex items-center justify-between gap-1 border border-border-subtle hover:bg-surface-container transition-all shadow-sm"
                  >
                    <span className="truncate">{selectedMember ? selectedMember.displayName : t('analysis.allMembers')}</span>
                    <span className="material-symbols-outlined text-[16px] shrink-0">expand_more</span>
                  </button>
                  <AnimatePresence>
                    {showMemberDropdown && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="absolute right-0 mt-1 w-48 bg-white border border-border-subtle rounded-xl shadow-2xl z-[60] py-1"
                      >
                        <button onClick={() => { setSelectedMemberId(null); setShowMemberDropdown(false); }} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-surface-container transition-colors">{t('analysis.allMembers')}</button>
                        {groupMembers.map(m => (
                          <button key={m.userId} onClick={() => { setSelectedMemberId(m.userId); setShowMemberDropdown(false); }} className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-surface-container transition-colors">
                            {m.displayName}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

            {/* Always visible regardless of tab — a filter set on the Trend tab still narrows
                every other tab's data, so this stays as the one place that signals "something's
                filtered" and offers a way out of it, wherever you currently are. */}
            {activeFilterCount > 0 && (
              <div className="flex items-center justify-between gap-2 bg-primary/5 px-3 py-2 rounded-xl">
                <p className="text-[10px] font-bold text-primary">
                  {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active
                </p>
                <button onClick={clearAllFilters} className="text-[10px] font-black text-primary uppercase tracking-wide hover:underline">
                  Clear All
                </button>
              </div>
            )}

            <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
              {([
                ['trend', 'Trend'],
                ['categories', 'Categories'],
                ['groups', 'Groups'],
                ['members', 'Members'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAnalysisTab(key)}
                  className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', analysisTab === key ? 'bg-primary text-white' : 'text-text-muted')}
                >
                  {label}
                </button>
              ))}
            </div>

            {analysisTab === 'trend' && (
            <motion.section
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white p-6 rounded-[2rem] border border-border-subtle shadow-sm space-y-4"
              data-tour="analysis-chart"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold text-primary">{t('analysis.spendingTrend')}</h2>
                <button
                  onClick={() => navigate(buildExpensesLink())}
                  className="p-2 bg-primary/5 rounded-xl border border-primary/10 text-primary hover:bg-primary/10 transition-all"
                  title={t('analysis.viewTransactions')}
                >
                  <span className="material-symbols-outlined text-[18px]">receipt_long</span>
                </button>
              </div>

              {/* Responsive Bar Chart — horizontally scrollable so bars/labels never get squished */}
              <div className="h-[250px] w-full pt-4 overflow-x-auto no-scrollbar">
                {trendData.length > 0 ? (
                  <div style={{ height: '100%', width: `${Math.max(trendData.length * 64, 320)}px` }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trendData} margin={{ top: 25, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gradEssential" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#4ADE80" />
                          <stop offset="100%" stopColor="#16A34A" />
                        </linearGradient>
                        <linearGradient id="gradOptional" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#FDE047" />
                          <stop offset="100%" stopColor="#EAB308" />
                        </linearGradient>
                        <linearGradient id="gradIncome" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#60A5FA" />
                          <stop offset="100%" stopColor="#2563EB" />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="name"
                        fontSize={10}
                        tick={{ fill: '#0F4761', fontWeight: 'bold' }}
                        axisLine={false}
                        tickLine={false}
                        dy={5}
                        interval={0}
                      />
                      <YAxis hide width={0} />
                      <Tooltip
                        cursor={{ fill: 'transparent' }}
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const point: any = payload[0].payload;
                            const diff = point.budget != null ? point.value - point.budget : null;
                            return (
                              <div className="bg-[#0F4761] text-white px-3 py-1.5 rounded-lg text-[10px] font-bold shadow-lg transform -translate-y-8 space-y-0.5">
                                <div>{currencySymbol}{point.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                                {point.essential > 0 && <div className="text-green-300 font-normal">{t('common.essential')}: {currencySymbol}{point.essential.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>}
                                {point.optional > 0 && <div className="text-yellow-300 font-normal">{t('common.optional')}: {currencySymbol}{point.optional.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>}
                                {point.income > 0 && <div className="text-blue-300 font-normal">{t('common.income')}: {currencySymbol}{point.income.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>}
                                {diff != null && (
                                  <div className={diff > 0 ? 'text-red-300' : 'text-green-300'}>
                                    Budget {currencySymbol}{point.budget.toLocaleString()} · {diff > 0 ? 'Over' : 'Under'} by {currencySymbol}{Math.abs(diff).toLocaleString()}
                                  </div>
                                )}
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      {/* Stacked essential/optional/income — same stackId so each bar's total
                          height still equals `value`. Income (no Essential/Optional concept)
                          gets its own segment rather than being folded into either. No `radius`
                          on any segment — recharts renders a rounded corner as a non-zero-height
                          sliver even when a segment's actual value is 0, which is exactly what
                          was showing as a stray colored line across the chart whenever a period
                          had $0 income (i.e. almost always) — and pushing the total-value label's
                          height off the real stack top with it. The label is attached to
                          whichever segment is ACTUALLY the topmost non-zero one for each specific
                          bar (varies per period), computed via topStackSegment, instead of
                          assuming it's always the same series. */}
                      <Bar dataKey="essential" stackId="a" fill="url(#gradEssential)" barSize={32} name={t('common.essential')} label={makeStackTotalLabel('essential', trendData, currencySymbol)} />
                      <Bar dataKey="optional" stackId="a" fill="url(#gradOptional)" barSize={32} name={t('common.optional')} label={makeStackTotalLabel('optional', trendData, currencySymbol)} />
                      <Bar dataKey="income" stackId="a" fill="url(#gradIncome)" barSize={32} name={t('common.income')} label={makeStackTotalLabel('income', trendData, currencySymbol)} />
                      {timeStep === 'monthly' && selectedGroupId !== 'all' && (
                        <Line
                          dataKey="budget"
                          stroke="#EF4444"
                          strokeWidth={2}
                          dot={{ r: 3, fill: '#EF4444' }}
                          connectNulls
                          label={(props: any) => {
                            const { x, y, value, index } = props;
                            const entry: any = trendData[index];
                            if (value == null || !entry) return <g key={`budget-label-${index}`} />;
                            const diff = entry.value - value;
                            const isOver = diff > 0;
                            return (
                              <text
                                key={`budget-label-${index}`}
                                x={x}
                                y={y - 10}
                                textAnchor="middle"
                                fontSize={9}
                                fontWeight="bold"
                                fill={isOver ? '#DC2626' : '#16A34A'}
                              >
                                {isOver ? '+' : '-'}{currencySymbol}{Math.abs(diff).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </text>
                            );
                          }}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-text-muted text-sm italic">{t('analysis.noDataYet')}</div>
                )}
              </div>

              {/* Controls Row - Re-positioned below the graph */}
              <div className="flex items-center justify-between pt-2">
                <div className="bg-surface-container/50 p-1 rounded-xl flex gap-1 items-center">
                  {(['daily', 'weekly', 'monthly'] as const).map(step => (
                    <button
                      key={step}
                      onClick={() => setTimeStep(step)}
                      className={clsx(
                        "w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold transition-all",
                        timeStep === step 
                          ? "bg-white text-primary shadow-sm" 
                          : "text-text-muted hover:text-primary"
                      )}
                    >
                      {step === 'daily' ? 'D' : step === 'weekly' ? 'W' : 'M'}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5">
                  {/* X-axis sort and Y-axis (value) sort are mutually exclusive — activating one
                      resets the other to off, so only one drives the bar order at a time instead
                      of leaving both buttons looking "on" while only the X-axis sort (which takes
                      priority in the trendData useMemo above) actually has any effect. */}
                  <button
                    onClick={() => setXSortOrder(prev => {
                      const next = prev === null ? 'asc' : prev === 'asc' ? 'desc' : null;
                      if (next !== null) setSortOrder('none');
                      return next;
                    })}
                    className={clsx(
                      "w-8 h-8 rounded-lg border transition-all flex items-center justify-center",
                      xSortOrder ? "bg-primary text-white border-primary" : "bg-surface-container/50 border-border-subtle text-primary hover:bg-surface-container",
                    )}
                    title={
                      xSortOrder === null
                        ? `Sort X-axis (${viewType === 'time' ? 'date' : 'name'}): off`
                        : `Sort X-axis (${viewType === 'time' ? 'date' : 'name'}): ${xSortOrder === 'asc' ? 'Ascending' : 'Descending'}`
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {xSortOrder === null ? 'swap_horiz' : xSortOrder === 'asc' ? 'south_east' : 'north_east'}
                    </span>
                  </button>
                  <button
                    onClick={() => setSortOrder(prev => {
                      const next = prev === 'none' ? 'desc' : prev === 'desc' ? 'asc' : 'none';
                      if (next !== 'none') setXSortOrder(null);
                      return next;
                    })}
                    className={clsx(
                      "w-8 h-8 rounded-lg border transition-all flex items-center justify-center",
                      sortOrder !== 'none' ? "bg-primary text-white border-primary" : "bg-surface-container/50 border-border-subtle text-primary hover:bg-surface-container",
                    )}
                    title={
                      sortOrder === 'none'
                        ? 'Sort Y-axis (value): off'
                        : `Sort Y-axis (value): ${sortOrder === 'desc' ? 'Descending' : 'Ascending'}`
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {sortOrder === 'none' ? 'swap_vert' : sortOrder === 'desc' ? 'south_east' : 'north_east'}
                    </span>
                  </button>
                </div>
              </div>
            </motion.section>
            )}

            {analysisTab === 'categories' && essentialOptionalData.length > 0 && (
              <section className="bg-white p-6 rounded-2xl border border-border-subtle shadow-sm space-y-3 overflow-hidden">
                <h3 className="font-bold text-primary">Essential vs Optional</h3>
                {/* Percentage renders INSIDE each slice (positioned at the ring's own mid-radius,
                    not as an external leader-line label) so it can never overflow the chart's box
                    regardless of container size — the leader-line labels recharts uses by default
                    were exactly what was spilling outside the small side-by-side layout this
                    replaced. */}
                <div className="w-44 h-44 mx-auto">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={essentialOptionalData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="55%"
                        outerRadius="90%"
                        paddingAngle={2}
                        strokeWidth={0}
                        label={renderDonutPercentLabel}
                        labelLine={false}
                      >
                        {essentialOptionalData.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number, name: string) => [`${currencySymbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-wrap justify-center gap-x-5 gap-y-1.5">
                  {essentialOptionalData.map((entry) => (
                    <div key={entry.name} className="flex items-center gap-1.5 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                      <span className="text-xs font-bold text-on-surface truncate">{entry.name}</span>
                      <span className="text-xs font-black text-primary shrink-0">
                        {currencySymbol}{entry.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {analysisTab === 'groups' && (
              <section>
              {/* Spending by Group - List view. Only ever has anything to show in the "All
                  Groups" view (a single selected group has nothing to compare itself against) —
                  same pre-existing condition as when this shared a 2-column grid with Categories. */}
              {selectedGroupId === 'all' ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white p-6 rounded-2xl border border-border-subtle shadow-sm flex flex-col min-h-[350px]"
                >
                  <div className="flex justify-between items-center mb-6 gap-2">
                    <h3 className="font-bold text-primary shrink-0">{t('analysis.spendingByGroup')}</h3>
                    <div className="flex items-center gap-1.5">
                      <ArchiveToggle checked={showArchivedInGroupSpending} onToggle={() => setShowArchivedInGroupSpending((v) => !v)} label={t('analysis.showArchived')} />
                      <button
                        onClick={() => navigate(buildExpensesLink())}
                        className="p-2 bg-primary/5 rounded-xl border border-primary/10 text-primary hover:bg-primary/10 transition-all shrink-0"
                        title={t('analysis.viewTransactions')}
                      >
                        <span className="material-symbols-outlined text-[18px]">receipt_long</span>
                      </button>
                    </div>
                  </div>
                  <div className="space-y-6 overflow-y-auto">
                    {groupSpendingData.length > 0 ? (
                      groupSpendingData.sort((a, b) => b.value - a.value).map((entry, index) => {
                        const total = groupSpendingData.reduce((acc, curr) => acc + curr.value, 0);
                        const pct = (entry.value / total) * 100;
                        const group = allGroups.find(g => g.name === entry.name);
                        return (
                          <div key={entry.name} className="space-y-1 cursor-pointer hover:bg-surface-container/5 p-2 rounded-xl transition-all" onClick={() => group && setSelectedGroupId(group.id)}>
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-primary/5 border border-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                                {group?.photoURL ? (
                                  <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  <span className="text-sm">
                                    {groupIconEmoji(group?.icon)}
                                  </span>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-center mb-1">
                                  <span className="font-bold text-primary truncate text-xs flex items-center gap-1">
                                    {group?.archived && <span className="material-symbols-outlined text-[13px] text-text-muted shrink-0" title={t('analysis.archivedTag')}>archive</span>}
                                    {entry.name}
                                  </span>
                                  <span className="font-bold text-success text-xs ml-2">{getCurrencySymbol(group?.currency)}{entry.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                                <div className="h-2 w-full bg-surface-container rounded-full overflow-hidden">
                                  <motion.div 
                                    initial={{ width: 0 }}
                                    animate={{ width: `${pct}%` }}
                                    className="h-full bg-primary rounded-full shadow-sm"
                                    style={{ backgroundColor: COLORS[index % COLORS.length] }}
                                  />
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <MonthComparisonLine
                                thisMonth={monthComparisonByGroup.thisMonth[entry.name] || 0}
                                lastMonth={monthComparisonByGroup.lastMonth[entry.name] || 0}
                                currencySymbol={getCurrencySymbol(group?.currency)}
                                t={t}
                              />
                              <div className="text-[9px] text-text-muted font-bold uppercase tracking-wider text-right shrink-0">
                                {Math.round(pct)}% Share
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="h-full flex items-center justify-center text-text-muted text-sm italic">{t('analysis.noDataYet')}</div>
                    )}
                  </div>
                </motion.div>
              ) : (
                <div className="h-64 flex flex-col items-center justify-center text-text-muted gap-3">
                  <span className="material-symbols-outlined text-4xl">group_work</span>
                  <p className="text-sm font-bold text-center max-w-xs">Switch to "All my groups" above to compare spending across your groups.</p>
                </div>
              )}
              </section>
            )}

            {analysisTab === 'categories' && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white p-6 rounded-2xl border border-border-subtle shadow-sm flex flex-col"
              >
                <div className="flex justify-between items-start mb-6 gap-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-primary">{t('analysis.spendingByCategory')}</h3>
                    <p className="text-xl font-bold text-success mt-1">
                      {currencySymbol}{totalSpending.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {selectedGroupId === 'all' && (
                      <ArchiveToggle checked={includeArchivedInCategoryMember} onToggle={() => setIncludeArchivedInCategoryMember((v) => !v)} label={t('analysis.includeArchived')} />
                    )}
                    <button
                      onClick={() => navigate(buildExpensesLink())}
                      className="p-2 bg-primary/5 rounded-xl border border-primary/10 text-primary hover:bg-primary/10 transition-all"
                      title={t('analysis.viewTransactions')}
                    >
                      <span className="material-symbols-outlined text-[18px]">receipt_long</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-6 overflow-y-auto">
                  {categoryData.length > 0 ? (
                    categoryData.sort((a, b) => b.value - a.value).map((entry, index) => {
                      const pct = totalSpending > 0 ? (entry.value / totalSpending) * 100 : 0;
                      return (
                        <div
                          key={entry.name}
                          onClick={() => navigate(buildExpensesLink(entry.name))}
                          className="space-y-1 p-1 hover:bg-surface-container/40 rounded-xl transition-all cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-primary/5 border border-primary/10 flex items-center justify-center flex-shrink-0">
                              <span className="text-sm">
                                {CATEGORIES_LIST.find(c => c.id === entry.name)?.icon || '🧾'}
                              </span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-center mb-1">
                                <span className="font-bold text-primary truncate text-xs">
                                  {CATEGORIES_LIST.find(c => c.id === entry.name) ? categoryLabel(entry.name) : entry.name}
                                </span>
                                <span className="font-bold text-success text-xs ml-2">{currencySymbol}{entry.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                              </div>
                              <div className="h-2 w-full bg-surface-container rounded-full overflow-hidden">
                                <motion.div 
                                  initial={{ width: 0 }}
                                  animate={{ width: `${pct}%` }}
                                  className="h-full rounded-full shadow-sm"
                                  style={{ backgroundColor: CATEGORY_COLORS[entry.name.toLowerCase()] || COLORS[index % COLORS.length] }}
                                />
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <MonthComparisonLine
                              thisMonth={monthComparisonByCategory.thisMonth[entry.name] || 0}
                              lastMonth={monthComparisonByCategory.lastMonth[entry.name] || 0}
                              currencySymbol={currencySymbol}
                              t={t}
                            />
                            <div className="text-[9px] text-text-muted font-bold uppercase tracking-wider text-right shrink-0">
                              {Math.round(pct)}% Share
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="h-full flex items-center justify-center text-text-muted text-sm italic">{t('analysis.noDataYet')}</div>
                  )}
                </div>
              </motion.div>
            )}

            {analysisTab === 'members' && (
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-white p-6 rounded-2xl border border-border-subtle shadow-sm"
            >
              <div className="flex justify-between items-center mb-6 gap-2">
                <h3 className="font-bold text-primary shrink-0">{t('analysis.memberContributions')}</h3>
                <div className="flex items-center gap-1.5">
                  {selectedGroupId === 'all' && (
                    <ArchiveToggle checked={includeArchivedInCategoryMember} onToggle={() => setIncludeArchivedInCategoryMember((v) => !v)} label={t('analysis.includeArchived')} />
                  )}
                  <button
                    onClick={() => navigate(buildExpensesLink())}
                    className="p-2 bg-primary/5 rounded-xl border border-primary/10 text-primary hover:bg-primary/10 transition-all shrink-0"
                    title={t('analysis.viewTransactions')}
                  >
                    <span className="material-symbols-outlined text-[18px]">receipt_long</span>
                  </button>
                </div>
              </div>
              <div className="space-y-6">
                {[...groupMembers]
                  .sort((a: any, b: any) => {
                    const spendOf = (m: any) => categoryMemberContributionExpenses.filter(exp => exp.paidBy === m.userId).reduce((acc, curr) => acc + curr.amount, 0);
                    return spendOf(b) - spendOf(a);
                  })
                  .map((member: any) => {
                  const memberExpenses = categoryMemberContributionExpenses.filter(exp => exp.paidBy === member.userId);
                  const contribution = memberExpenses.reduce((acc, curr) => acc + curr.amount, 0);
                  const total = categoryMemberContributionExpenses.reduce((acc, curr) => acc + curr.amount, 0);
                  const pct = total > 0 ? (contribution / total) * 100 : 0;
                  
                  // Sort categories by amount
                  const catBuckets: Record<string, number> = {};
                  memberExpenses.forEach(exp => {
                    catBuckets[exp.category] = (catBuckets[exp.category] || 0) + exp.amount;
                  });
                  const sortedCats = Object.entries(catBuckets).sort((a, b) => b[1] - a[1]);

                  return (
                    <div key={member.userId} className="space-y-3 cursor-pointer hover:bg-surface-container/40 p-2 rounded-xl transition-all" onClick={() => navigate(buildExpensesLink(undefined, member.userId))}>
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <img src={member.photoURL || `https://ui-avatars.com/api/?name=${member.displayName}`} className="w-8 h-8 rounded-full border border-border-subtle" alt="avatar" />
                          <div>
                            <span className="text-sm font-bold block">{member.displayName}</span>
                            <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider">{t('analysis.ofTotal', { pct: Math.round(pct) })}</span>
                          </div>
                          {member.userId !== user?.uid && (
                            <button
                              onClick={(e) => { e.stopPropagation(); navigate(`/?dm=${member.userId}`); }}
                              title={t('analysis.chatWith', { name: member.displayName })}
                              className="p-1.5 text-primary hover:bg-primary/10 rounded-full transition-colors shrink-0"
                            >
                              <span className="material-symbols-outlined text-[16px] block">chat</span>
                            </button>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="text-sm font-bold text-primary block">{currencySymbol}{contribution.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                          <span className="text-[10px] text-text-muted font-medium">{t('analysis.transactionsCount', { count: memberExpenses.length })}</span>
                        </div>
                      </div>
                      <div className="h-3 w-full bg-surface-container rounded-full overflow-hidden flex shadow-inner">
                        {sortedCats.map(([cat, amount], i) => (
                          <motion.div 
                            key={cat}
                            initial={{ width: 0 }}
                            animate={{ width: `${(amount / contribution) * 100}%` }}
                            className="h-full"
                            style={{ 
                              backgroundColor: CATEGORY_COLORS[cat] || '#71787d',
                              zIndex: 10 - i
                            }}
                          />
                        ))}
                      </div>
                      <MonthComparisonLine
                        thisMonth={monthComparisonByMember.thisMonth[member.userId] || 0}
                        lastMonth={monthComparisonByMember.lastMonth[member.userId] || 0}
                        currencySymbol={currencySymbol}
                        t={t}
                      />
                      {/* Legend for this member's categories */}
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {sortedCats.map(([cat, amount]) => (
                          <div key={cat} className="flex items-center gap-1">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[cat] || '#71787d' }} />
                            <span className="text-[9px] font-bold text-text-muted uppercase tracking-tighter">
                              {categoryLabel(cat)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.section>
            )}

            {analysisTab === 'trend' && selectedGroupId && selectedGroupId !== 'all' && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22 }}
                className="bg-white p-6 rounded-2xl border border-border-subtle shadow-sm space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-primary">{t('analysis.aiAnalysis')}</h3>
                    <p className="text-xs text-text-muted">Share this group's spending with an AI assistant for insights</p>
                  </div>
                  <button
                    onClick={handleAiAnalysis}
                    disabled={aiSharing}
                    className="px-4 py-2.5 bg-primary text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 shrink-0 self-start sm:self-auto"
                  >
                    <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
                    {aiSharing ? 'Preparing…' : 'Analyze'}
                  </button>
                </div>
                {aiShareMessage && (
                  <p className="text-xs text-text-muted bg-surface p-3 rounded-xl border border-border-subtle">{aiShareMessage}</p>
                )}
              </motion.section>
            )}

          </>
        )}
      </main>

      {showChat && user && chatGroupId && (
        <ChatPanel
          collectionName="groups"
          gameId={chatGroupId}
          messages={chatMessages}
          loading={chatLoading}
          myUid={user.uid}
          myDisplayName={profile?.displayName || user.displayName || 'Someone'}
          myPhotoURL={profile?.photoURL || user.photoURL || ''}
          otherUids={allRelevantMembers
            .filter((m: any) => m.groupId === chatGroupId && m.userId !== user.uid)
            .map((m: any) => m.userId)}
          onClose={() => setShowChat(false)}
          title="Group Chat"
        />
      )}
    </div>
  );
}
