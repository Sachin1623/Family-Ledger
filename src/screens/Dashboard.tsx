import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, doc, updateDoc } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, Reorder } from 'motion/react';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, formatAmountCompact, getCategoryClassification } from '../lib/constants';
import ExpenseQuickView from '../components/ExpenseQuickView';
import { ChatButton, ChatPanel, useGameChat } from '../components/GameChat';
import { FAVORITABLE_BY_KEY } from '../lib/favorites';
import { getBudgetStatus } from '../lib/budget';
import { groupIconEmoji } from '../lib/groupIcons';
import { clsx } from 'clsx';
import { currentLocalMonthKey } from '../lib/dateUtils';
import { openFeedPanel } from '../lib/feedPanelRef';
import { useLanguage } from '../context/LanguageContext';
import GroupQuickActionsMenu from '../components/GroupQuickActionsMenu';

const CATEGORIES = EXPENSE_CATEGORIES;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  CAD: 'C$',
  AUD: 'A$',
  AED: 'AED'
};

// Which groups are expanded is purely a per-device display preference — localStorage, not
// Firestore, so it doesn't need a rules change and stays snappy (no round-trip to toggle). Tracked
// as "expanded" (opt-in) rather than "collapsed" (opt-out) so groups default to COLLAPSED — a
// brand new group, or one from before this feature existed, is collapsed until the user
// explicitly expands it.
const EXPANDED_STORAGE_KEY = 'familyledger_expanded_groups';

function loadExpandedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

// Deterministic per-pair id for a 1:1 chat — sorted so it's the same regardless of who opens it
// first, matching the `${uid}_${groupId}` style ids already used elsewhere (members docs, etc.).
function dmChatId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('_');
}

export default function Dashboard() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useLanguage();

  // A tapped "new direct message" push (see /api/chat/send's dm_chat type + pushNotifications.ts)
  // deep-links here as `/?dm=<otherUid>` — then scrubbed from the URL so it doesn't reopen on
  // every subsequent render/back-navigation. Reacts to searchParams itself, not a mount-only
  // effect — Dashboard is the default landing screen, so it's very often ALREADY mounted when a
  // DM notification is tapped; React Router reuses that instance instead of remounting it, and a
  // mount-only effect would never see the new `dm=` param.
  const [activeDmUid, setActiveDmUid] = useState<string | null>(null);
  useEffect(() => {
    const dm = searchParams.get('dm');
    if (dm) {
      setActiveDmUid(dm);
      const next = new URLSearchParams(searchParams);
      next.delete('dm');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Fetch memberships for current user
  const [membershipsValue, membershipsLoading] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null
  );

  const memberships = membershipsValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [];

  // Direct 1:1 chat with a group co-member — opened from anywhere via `setActiveDmUid` (a member
  // row's chat button, or the `?dm=` deep link above). Reuses the exact same ChatPanel/comments
  // shape as group/game chat (see /api/chat/send's 'dm' surface), just scoped to a
  // `directChats/{sortedUidPair}` doc instead of a group or game. Only one DM can be open at a
  // time, same single-panel pattern as group chat.
  const activeDmChatId = user && activeDmUid ? dmChatId(user.uid, activeDmUid) : undefined;
  const { messages: dmMessages, loading: dmLoading } = useGameChat('directChats', activeDmChatId);
  const [activeDmUserValue] = useDocument(activeDmUid ? doc(db, 'users', activeDmUid) : null);
  const activeDmUserName = activeDmUserValue?.data()?.displayName;

  // Favorites are stored as bare keys (see lib/favorites.ts) — resolved against the shared
  // registry here so this row stays in sync with GamesHub/Tools without duplicating any labels.
  // Unknown keys (e.g. an item that's since been removed from the registry) are silently dropped
  // rather than rendering a broken tile.
  const favoriteItems = (profile?.favorites || [])
    .map((key: string) => FAVORITABLE_BY_KEY[key])
    .filter(Boolean);

  // Groups display in the user's own chosen order (`users/{uid}.groupOrder`, a plain array of
  // groupIds) — any group not yet in that list (brand new, or from before this feature existed)
  // just keeps its natural membership order, appended after the ones the user HAS arranged.
  const groupOrder: string[] = profile?.groupOrder || [];
  const orderedMemberships = useMemo(() => {
    const byGroupId = new Map((memberships as any[]).map((m) => [m.groupId, m]));
    const ordered: any[] = [];
    for (const gid of groupOrder) {
      const m = byGroupId.get(gid);
      if (m) {
        ordered.push(m);
        byGroupId.delete(gid);
      }
    }
    for (const m of memberships as any[]) if (byGroupId.has(m.groupId)) ordered.push(m);
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipsValue, groupOrder.join(',')]);

  const [favoritesCollapsed, setFavoritesCollapsed] = useState(true);
  const [showReorderModal, setShowReorderModal] = useState(false);
  const [dragOrder, setDragOrder] = useState<string[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);

  const openReorderModal = () => {
    setDragOrder(orderedMemberships.map((m: any) => m.groupId));
    setShowReorderModal(true);
  };

  const handleSaveOrder = async () => {
    if (!user) return;
    setSavingOrder(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { groupOrder: dragOrder });
      setShowReorderModal(false);
    } catch (err) {
      console.error('Failed to save group order:', err);
    } finally {
      setSavingOrder(false);
    }
  };

  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(loadExpandedGroups);
  const toggleCollapse = (groupId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      try {
        localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // localStorage unavailable (private browsing etc.) — expanded state just won't persist.
      }
      return next;
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 pb-24">
      {favoriteItems.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setFavoritesCollapsed((c) => !c)}
            className="w-full flex items-center justify-between mb-3"
          >
            <h3 className="text-sm font-black text-primary uppercase tracking-wider">{t('dashboard.favorites')}</h3>
            <span className={clsx('material-symbols-outlined text-text-muted transition-transform', favoritesCollapsed && '-rotate-90')}>expand_more</span>
          </button>
          <motion.div
            initial={false}
            animate={{ height: favoritesCollapsed ? 0 : 'auto', opacity: favoritesCollapsed ? 0 : 1 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              {favoriteItems.map((item) => (
                <div
                  key={item.key}
                  onClick={() => navigate(item.to)}
                  className="shrink-0 w-16 flex flex-col items-center gap-1 bg-white rounded-xl border border-border-subtle p-2 cursor-pointer hover:shadow-sm active:scale-95 transition-all"
                >
                  <div className="w-10 h-10 rounded-lg bg-primary/5 flex items-center justify-center">
                    <span className="text-xl">{item.icon}</span>
                  </div>
                  <p className="text-[9px] font-bold text-on-surface text-center leading-tight line-clamp-2">{item.label}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-2xl font-bold text-primary">{t('nav.groups')}</h3>
          <div className="flex items-center gap-2">
            {memberships.length > 1 && (
              <button
                onClick={openReorderModal}
                title={t('dashboard.reorderGroups')}
                className="w-10 h-10 rounded-xl border border-border-subtle text-primary flex items-center justify-center hover:bg-surface-container active:scale-95 transition-all"
              >
                <span className="material-symbols-outlined text-[20px]">swap_vert</span>
              </button>
            )}
            <button
              data-tour="dashboard-new-group"
              onClick={() => navigate('/create-group')}
              className="bg-primary text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 hover:opacity-90 active:scale-95 shadow-md text-sm"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              <span>{t('dashboard.newGroup')}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {membershipsLoading ? (
          <div className="col-span-full py-20 text-center text-text-muted">{t('dashboard.loading')}</div>
        ) : (
          <>
            {orderedMemberships.map((membership, index) => (
              <GroupCard
                key={membership.id}
                groupId={membership.groupId}
                index={index}
                isFirst={index === 0}
                collapsed={!expandedGroupIds.has(membership.groupId)}
                onToggleCollapse={() => toggleCollapse(membership.groupId)}
              />
            ))}
          </>
        )}
      </div>
      </section>

      {showReorderModal && (
        <div className="fixed inset-0 z-[280] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowReorderModal(false)} />
          <div className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <h2 className="text-base font-black text-primary">{t('dashboard.reorderGroups')}</h2>
              <button onClick={() => setShowReorderModal(false)} className="p-1.5 text-text-muted hover:bg-surface rounded-full">
                <span className="material-symbols-outlined text-[20px] block">close</span>
              </button>
            </div>
            <p className="text-xs text-text-muted shrink-0">Drag to set the order your groups show on the dashboard.</p>
            <Reorder.Group axis="y" values={dragOrder} onReorder={setDragOrder} className="space-y-2 overflow-y-auto flex-1">
              {dragOrder.map((groupId) => (
                <ReorderRow key={groupId} groupId={groupId} />
              ))}
            </Reorder.Group>
            <button
              onClick={handleSaveOrder}
              disabled={savingOrder}
              className="w-full py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-50 shrink-0"
            >
              {savingOrder ? t('common.saving') : t('common.done')}
            </button>
          </div>
        </div>
      )}

      {activeDmUid && user && (
        <ChatPanel
          collectionName="directChats"
          gameId={activeDmChatId!}
          messages={dmMessages}
          loading={dmLoading}
          myUid={user.uid}
          myDisplayName={profile?.displayName || user.displayName || 'Someone'}
          myPhotoURL={profile?.photoURL || user.photoURL || ''}
          otherUids={activeDmUid ? [activeDmUid] : []}
          onClose={() => setActiveDmUid(null)}
          title={activeDmUserName ? `Chat with ${activeDmUserName}` : 'Direct Message'}
        />
      )}
    </div>
  );
}

// A single draggable row inside the reorder modal — deliberately much simpler than the full
// GroupCard (just enough to identify the group while dragging), so there's no ambiguity between
// "start a drag" and "tap a button" the way there would be if the full card were made draggable.
const ReorderRow: React.FC<{ groupId: string }> = ({ groupId }) => {
  const [groupValue] = useDocument(doc(db, 'groups', groupId));
  const group = groupValue?.data();
  return (
    <Reorder.Item
      value={groupId}
      className="bg-white rounded-xl border border-border-subtle p-3 flex items-center gap-3 cursor-grab active:cursor-grabbing shadow-sm"
    >
      <span className="material-symbols-outlined text-text-muted shrink-0">drag_indicator</span>
      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
        {group?.photoURL ? (
          <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="text-lg">{groupIconEmoji(group?.icon)}</span>
        )}
      </div>
      <span className="font-bold text-sm text-on-surface truncate flex-1">{group?.name || '…'}</span>
    </Reorder.Item>
  );
};

function GroupCard({ groupId, index, isFirst, collapsed, onToggleCollapse }: any) {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [quickViewExpense, setQuickViewExpense] = useState<any>(null);
  const [showQuickActions, setShowQuickActions] = useState(false);
  // Filters the "Latest Spend" list below to just this member's own entries — tapping the same
  // avatar again clears it. Local to this card (not persisted), same lifecycle as `collapsed`.
  const [spendMemberFilter, setSpendMemberFilter] = useState<string | null>(null);
  // Same idea, for Essential/Optional (see lib/constants.ts's getCategoryClassification) — both
  // filters combine (AND), so a member + classification can be selected together.
  const [spendClassificationFilter, setSpendClassificationFilter] = useState<'essential' | 'optional' | null>(null);
  const [poking, setPoking] = useState(false);
  const [poked, setPoked] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const { messages: chatMessages, loading: chatLoading, hasUnseen: chatUnseen, markSeen: markChatSeen } = useGameChat('groups', groupId);

  const handlePokeAll = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user || poking) return;
    setPoking(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/poke-member', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, pokeAll: true }),
      });
      if (!res.ok) throw new Error('Failed to poke.');
      setPoked(true);
      setTimeout(() => setPoked(false), 2000);
    } catch (err) {
      console.error('Poke all error:', err);
    } finally {
      setPoking(false);
    }
  };

  const [groupValue, groupLoading] = useDocument(doc(db, 'groups', groupId));
  const group = groupValue?.data();

  const [membersValue] = useCollection(
    query(collection(db, 'members'), where('groupId', '==', groupId))
  );
  const members = membersValue?.docs.map(d => d.data()) || [];
  // Self first, then everyone else in their existing order — for the member-filter avatar row.
  const spendFilterMembers = useMemo(() => {
    const self = members.find((m: any) => m.userId === user?.uid);
    const others = members.filter((m: any) => m.userId !== user?.uid);
    return self ? [self, ...others] : members;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, user?.uid]);

  const [expensesValue] = useCollection(
    groupId ? query(collection(db, 'expenses'), where('groupId', '==', groupId)) : null
  );

  const expenses = useMemo(() => {
    const exps = expensesValue?.docs.map(d => ({ id: d.id, ...d.data() })) || [] as any[];
    return exps.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [expensesValue]);
  const monthKey = currentLocalMonthKey();
  // "Aug'26" style badge shown right next to the section label, so the month-scoping is explicit
  // rather than something a user has to infer.
  const monthLabel = useMemo(() => {
    const [y, m] = monthKey.split('-').map(Number);
    return `${new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' })}'${String(y).slice(-2)}`;
  }, [monthKey]);
  // Scoped to the current calendar month — this section used to show up to the last 20 entries
  // regardless of date, which could reach weeks or months back once a group had enough history.
  // "Latest Spend" is renamed below to make that month-scoping explicit rather than implicit.
  const latestSpendExpenses = useMemo(() => {
    let filtered = expenses.filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey));
    if (spendMemberFilter) filtered = filtered.filter((e: any) => e.paidBy === spendMemberFilter);
    if (spendClassificationFilter) {
      filtered = filtered.filter((e: any) => e.type !== 'income' && getCategoryClassification(group, e.category) === spendClassificationFilter);
    }
    return filtered;
  }, [expenses, monthKey, spendMemberFilter, spendClassificationFilter, group]);
  const previousMonthKey = useMemo(() => {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y, m - 2, 1); // m is 1-indexed; m-2 goes back one month from month index m-1
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [monthKey]);
  const [budgetValue] = useDocument(doc(db, 'groupBudgets', `${groupId}_${monthKey}`));
  const budget = budgetValue?.data();
  // Income entries offset spend (informational only otherwise — never split/settled, see
  // AddExpense.tsx), so both of these net them out rather than summing every entry's amount.
  const monthSpend = useMemo(() => {
    return expenses
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey))
      .reduce((sum: number, e: any) => sum + (e.type === 'income' ? -(e.amount || 0) : (e.amount || 0)), 0);
  }, [expenses, monthKey]);
  const previousMonthSpend = useMemo(() => {
    return expenses
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(previousMonthKey))
      .reduce((sum: number, e: any) => sum + (e.type === 'income' ? -(e.amount || 0) : (e.amount || 0)), 0);
  }, [expenses, previousMonthKey]);

  // Broken out separately (rather than just the net above) for income-enabled groups, whose
  // tile shows Income/Expense/Net individually for both the current and previous month.
  const monthIncome = useMemo(() => {
    return expenses
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey) && e.type === 'income')
      .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }, [expenses, monthKey]);
  const monthExpense = useMemo(() => {
    return expenses
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey) && e.type !== 'income')
      .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }, [expenses, monthKey]);
  const previousMonthIncome = useMemo(() => {
    return expenses
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(previousMonthKey) && e.type === 'income')
      .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }, [expenses, previousMonthKey]);
  const previousMonthExpense = useMemo(() => {
    return expenses
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(previousMonthKey) && e.type !== 'income')
      .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }, [expenses, previousMonthKey]);

  // If loading is done and group doesn't exist, it means it was deleted
  if (!groupLoading && groupValue && !groupValue.exists()) {
    return null;
  }

  const isEventGroup = group?.groupType === 'event';
  const currencySymbol = CURRENCY_SYMBOLS[group?.currency] || group?.currency || '$';
  // Budget tracks spending only — income entries (see monthIncome/monthSpend above) never offset
  // it, so a group budget can't look "under" just because someone logged income that month.
  const budgetStatus = budget ? getBudgetStatus(monthExpense, budget.amount) : null;

  const stopAnd = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  return (
    <>
    <motion.div
      data-tour={isFirst ? 'dashboard-group-card' : undefined}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.05 }}
      className="bg-white rounded-2xl border border-border-subtle p-6 shadow-sm hover:shadow-md transition-all cursor-pointer group relative overflow-hidden"
      onClick={() => navigate(`/groups/${groupId}`)}
    >
      <div className="relative z-10 space-y-2">
        {/* Header — icon, name, member count, feed/expand controls. Identical markup and sizing
            regardless of `collapsed`, so nothing here ever shifts position on toggle — only the
            "Latest Spend" section below actually grows/shrinks (see its own comment). */}
        <div className="flex items-center justify-between gap-2 -mx-6 -mt-6 mb-1 px-6 pt-4 pb-3 rounded-t-2xl bg-gradient-to-r from-[#4ADE80]/15 to-[#3B82F6]/15 border-b border-border-subtle">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 border border-primary/20 overflow-hidden shadow-inner">
              {group?.photoURL ? (
                <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span className="text-3xl">{groupIconEmoji(group?.icon)}</span>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="font-bold text-on-surface line-clamp-1">{group?.name || 'Loading...'}</h3>
                {group?.splitEnabled && (
                  <span className="material-symbols-outlined text-[14px] text-primary shrink-0" title="Split Enabled">call_split</span>
                )}
              </div>
              <p className="text-sm text-text-muted">{t('dashboard.membersCount', { count: members.length })}</p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={stopAnd(() => openFeedPanel(groupId))} title={t('dashboard.groupFeedTooltip')} className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-full transition-colors">
              <span className="material-symbols-outlined text-[20px] block">history</span>
            </button>
            <button onClick={stopAnd(onToggleCollapse)} title={collapsed ? t('dashboard.expandTooltip') : t('dashboard.collapseTooltip')} className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-full transition-colors">
              <span className="material-symbols-outlined text-[20px] block">{collapsed ? 'expand_more' : 'expand_less'}</span>
            </button>
          </div>
        </div>

        {/* Action icons — same row, same sizing, always. */}
        <div className="flex items-center gap-0.5 justify-start">
          <button onClick={stopAnd(() => navigate(`/add-expense?groupId=${groupId}`))} title={t('dashboard.addExpenseTooltip')} className="p-2 hover:bg-primary/10 rounded-full transition-colors">
            <span className="text-[22px] leading-none block">➕</span>
          </button>
          <span className="w-px h-5 bg-border-subtle mx-0.5 shrink-0" />
          <button onClick={handlePokeAll} disabled={poking} title={t('dashboard.pokeTooltip')} className="p-2 rounded-full transition-colors hover:bg-primary/10">
            <span className="text-[18px] leading-none block">{poked ? '✅' : '✋'}</span>
          </button>
          <span onClick={(e) => e.stopPropagation()}>
            <ChatButton onClick={() => { setShowChat(true); markChatSeen(); }} hasUnseen={chatUnseen} className="hover:bg-primary/10 rounded-full" />
          </span>
          <span className="w-px h-5 bg-border-subtle mx-0.5 shrink-0" />
          <button onClick={stopAnd(() => navigate(`/groups/${groupId}`))} title={t('dashboard.groupAnalysisTooltip')} className="p-2 hover:bg-primary/10 rounded-full transition-colors">
            <span className="text-[18px] leading-none block">📊</span>
          </button>
          <button onClick={stopAnd(() => navigate(`/groups/${groupId}/expenses?from=dashboard`))} title={t('dashboard.expenseReportTooltip')} className="p-2 hover:bg-primary/10 rounded-full transition-colors">
            <span className="text-[18px] leading-none block">🧾</span>
          </button>
          <span className="w-px h-5 bg-border-subtle mx-0.5 shrink-0" />
          <button onClick={stopAnd(() => setShowQuickActions(true))} title="Group actions" className="p-2 hover:bg-surface-container rounded-full transition-colors">
            <span className="material-symbols-outlined text-[20px] block">more_vert</span>
          </button>
        </div>

        {/* Budget bar — same layout, always. */}
        {budgetStatus && (
          <div className="space-y-1">
            <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider truncate">
              {t('common.budget')} {currencySymbol}{formatAmountCompact(budget.amount, group?.currency)}
            </div>
            <div className="relative pt-3.5">
              <span
                className={clsx('absolute -top-0.5 -translate-x-1/2 text-[10px] font-black whitespace-nowrap', budgetStatus.textClass)}
                style={{ left: `${Math.min(92, Math.max(8, Math.min(100, budgetStatus.percent)))}%` }}
              >
                {Math.round(budgetStatus.percent)}%
              </span>
              <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                <div className={clsx('h-full rounded-full transition-all', budgetStatus.barClass)} style={{ width: `${Math.min(100, budgetStatus.percent)}%` }} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 text-[9px] text-text-muted font-bold">
              <span className="truncate">{t('common.spent')} {currencySymbol}{formatAmountCompact(monthExpense, group?.currency)}</span>
              <span className={clsx(budgetStatus.percent > 100 ? 'text-error' : '', 'truncate text-right')}>
                {budgetStatus.percent > 100 ? t('common.overBy') : t('common.remaining')} {currencySymbol}{formatAmountCompact(Math.abs(budget.amount - monthExpense), group?.currency)}
              </span>
            </div>
          </div>
        )}

        {/* Latest Spend — the ONLY part of this card that actually grows/shrinks. Height-animated
            (not a plain conditional render) so toggling reads as a smooth expansion rather than a
            layout jump; `initial={false}` skips animating on first mount/re-render so a page
            refresh lands directly in the right state instead of visibly "opening". */}
        <motion.div
          initial={false}
          animate={{ height: collapsed ? 0 : 'auto', opacity: collapsed ? 0 : 1 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          <div className="pt-2">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h4 className="text-[11px] text-text-muted uppercase font-bold tracking-wider shrink-0 flex items-center gap-1.5">
                {t('dashboard.latestSpend')}
                <span className="normal-case font-black text-primary/70">{monthLabel}</span>
              </h4>
              {/* Self first, then everyone else — tap to show only that person's entries below,
                  tap again to clear. Capped at 30% of the row width and horizontally scrollable
                  so a large group never crowds out the label. */}
              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar w-[30%] justify-end">
                {spendFilterMembers.map((m: any) => (
                  <button
                    key={m.userId}
                    onClick={stopAnd(() => setSpendMemberFilter((prev) => (prev === m.userId ? null : m.userId)))}
                    title={m.userId === user?.uid ? 'Me' : m.displayName}
                    className={clsx(
                      'w-6 h-6 rounded-full overflow-hidden shrink-0 border-2 transition-all',
                      spendMemberFilter === m.userId ? 'border-primary' : 'border-transparent opacity-70',
                    )}
                  >
                    {m.photoURL ? (
                      <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-primary/10 text-primary text-[9px] font-bold">
                        {m.displayName?.slice(0, 1) || '?'}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
            {/* Essential/Optional — same tap-to-toggle-off pattern as the member avatars above,
                combines with it (AND) rather than replacing it. */}
            <div className="flex items-center gap-1.5 mb-3">
              {(['essential', 'optional'] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={stopAnd(() => setSpendClassificationFilter((prev) => (prev === opt ? null : opt)))}
                  className={clsx(
                    'px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all',
                    spendClassificationFilter === opt
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface-container/30 text-text-muted border-border-subtle hover:bg-surface-container',
                  )}
                >
                  {opt === 'essential' ? t('common.essential') : t('common.optional')}
                </button>
              ))}
            </div>
            {/* Scrolls internally (rather than letting the tile itself grow further) once there
                are enough entries to need it — shows up to the last 20, not just 5, without
                pushing every other group tile below it down the page. */}
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              {latestSpendExpenses.length > 0 ? (
                latestSpendExpenses.slice(0, 20).map((expense: any, idx: number) => {
                  const payer = members.find((m: any) => m.userId === expense.paidBy);
                  const isIncomeRow = expense.type === 'income';
                  const icon = (isIncomeRow ? INCOME_CATEGORIES : CATEGORIES).find(c => c.id === expense.category)?.icon || '🧾';
                  // Shared across the group — shows whenever ANY member has favorited this
                  // expense, not just the person currently looking at it (favoriting is a
                  // group-wide bookmark here, not a personal-only one; see AddExpense.tsx's
                  // favorites picker).
                  const isGroupFavorite = (expense.favoritedBy || []).length > 0;

                  return (
                    <div
                      key={idx}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setQuickViewExpense(expense);
                      }}
                      className="flex items-center justify-between bg-surface-container/30 p-2 rounded-xl hover:bg-surface-container/60 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <div className="w-6 h-6 rounded-full overflow-hidden bg-surface-container-high shrink-0 border border-border-subtle">
                          {payer?.photoURL ? (
                            <img src={payer.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-primary/10 text-primary text-[10px] font-bold">
                              {payer?.displayName?.slice(0, 1) || '?'}
                            </div>
                          )}
                        </div>
                        <span className="text-sm">{icon}</span>
                        {isGroupFavorite && (
                          <span className="material-symbols-outlined text-[13px] text-warning shrink-0" style={{ fontVariationSettings: "'FILL' 1" }} title="Favorite">star</span>
                        )}
                        <span className="text-sm truncate">{expense.description}</span>
                      </div>
                      <span className={clsx("text-sm font-bold flex-none ml-2", isIncomeRow ? "text-[#0F7A38]" : "text-primary")}>
                        {isIncomeRow && '+'}{currencySymbol}{expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-text-muted italic">{t('dashboard.noExpensesYet')}</p>
              )}
            </div>
          </div>
        </motion.div>

        {/* Footer — avatars + month totals, same layout, always. */}
        <div className="pt-4 border-t border-gray-50 space-y-3">
          <div className="flex -space-x-2">
            {members.slice(0, 3).map((member: any, i: number) => (
              <div key={i} className="w-8 h-8 rounded-full border-2 border-white bg-surface-container-high overflow-hidden shrink-0">
                {member.photoURL ? (
                  <img src={member.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-primary/10 text-primary text-[10px] font-bold">
                    {member.displayName?.slice(0, 1)}
                  </div>
                )}
              </div>
            ))}
            {members.length > 3 && (
              <div className="w-8 h-8 rounded-full border-2 border-white bg-primary text-[10px] text-white flex items-center justify-center font-bold shrink-0">
                +{members.length - 3}
              </div>
            )}
          </div>

          {group?.incomeEnabled ? (
            <>
              <div className="grid grid-cols-3 gap-1 text-center">
                <div>
                  <p className="text-[9px] text-text-muted uppercase font-bold tracking-wider">{t('common.income')}</p>
                  <p className="text-sm font-bold text-[#0F7A38]">
                    {currencySymbol}{monthIncome.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] text-text-muted uppercase font-bold tracking-wider">{t('common.expense')}</p>
                  <p className="text-sm font-bold text-primary">
                    {currencySymbol}{monthExpense.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] text-text-muted uppercase font-bold tracking-wider">
                    {monthIncome >= monthExpense ? t('common.netIncomeLabel') : t('common.netExpenseLabel')}
                  </p>
                  <p className={clsx('text-sm font-bold', monthIncome >= monthExpense ? 'text-success' : 'text-error')}>
                    {currencySymbol}{Math.abs(monthIncome - monthExpense).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
              {/* Event groups (one-off trips/parties) don't have a meaningful "previous month" —
                  there's no month-over-month cadence to compare against. */}
              {!isEventGroup && (
                <div className="grid grid-cols-3 gap-1 text-center opacity-60">
                  <p className="text-[8px] text-text-muted font-bold uppercase tracking-wider">
                    {t('dashboard.lastMoIncome', { amount: `${currencySymbol}${previousMonthIncome.toLocaleString(undefined, { maximumFractionDigits: 0 })}` })}
                  </p>
                  <p className="text-[8px] text-text-muted font-bold uppercase tracking-wider">
                    {t('common.expense')}: {currencySymbol}{previousMonthExpense.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-[8px] text-text-muted font-bold uppercase tracking-wider">
                    {previousMonthIncome >= previousMonthExpense
                      ? `${t('common.netIncomeLabel')} ${currencySymbol}${(previousMonthIncome - previousMonthExpense).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : `${t('common.netExpenseLabel')} ${currencySymbol}${(previousMonthExpense - previousMonthIncome).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between">
              {!isEventGroup ? (
                <p className="text-[9px] text-text-muted font-bold uppercase tracking-wider">
                  {t('dashboard.lastMonth', { amount: `${currencySymbol}${previousMonthSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}` })}
                </p>
              ) : <span />}
              <div className="text-right">
                <p className="text-[11px] text-text-muted uppercase font-bold tracking-wider">This Month</p>
                <p className="text-lg font-bold text-primary">
                  {currencySymbol}{monthSpend.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>

    {quickViewExpense && (
      <ExpenseQuickView
        expense={quickViewExpense}
        groupId={groupId}
        currencySymbol={currencySymbol}
        payerName={
          members.find((m: any) => m.userId === quickViewExpense.paidBy)?.userId === user?.uid
            ? 'Me'
            : (members.find((m: any) => m.userId === quickViewExpense.paidBy)?.displayName || 'Unknown')
        }
        payerPhoto={members.find((m: any) => m.userId === quickViewExpense.paidBy)?.photoURL}
        members={members}
        onClose={() => setQuickViewExpense(null)}
        returnTo="/"
      />
    )}

    {showQuickActions && (
      <GroupQuickActionsMenu
        groupId={groupId}
        group={group}
        members={members}
        budget={budget}
        onClose={() => setShowQuickActions(false)}
      />
    )}

    {showChat && user && (
      <ChatPanel
        collectionName="groups"
        gameId={groupId}
        messages={chatMessages}
        loading={chatLoading}
        myUid={user.uid}
        myDisplayName={profile?.displayName || user.displayName || 'Someone'}
        myPhotoURL={profile?.photoURL || user.photoURL || ''}
        otherUids={members.filter((m: any) => m.userId !== user.uid).map((m: any) => m.userId)}
        onClose={() => setShowChat(false)}
        title="Group Chat"
      />
    )}
    </>
  );
}
