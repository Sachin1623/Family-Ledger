import React from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, orderBy, limit, doc, setDoc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { motion } from 'motion/react';
import { clsx } from 'clsx';
import { useNavigate } from 'react-router-dom';
import { getCurrencySymbol, EXPENSE_CATEGORIES } from '../lib/constants';
import { useLanguage } from '../context/LanguageContext';
import { useAppUpdateAvailable, hardReloadApp } from '../lib/appUpdate';
import { MONTH_KEYS } from './MonthCalendar';

// The activity list itself (data-fetching + rendering), shared by the full-page /feed route
// (ActivityFeed.tsx, kept for direct navigation/deep links) and the Header's slide-over FeedPanel
// — extracted so neither has to duplicate the three-query merge/dedupe or the per-type
// icon/color/description logic. `onNavigateAway` lets a container (the slide-over) close itself
// right before routing elsewhere; the full-page route just leaves it undefined (no-op).
// `initialGroupId` seeds the group filter below (used by ActivityFeed.tsx's `?groupId=` deep
// link — e.g. tapping a group card's Feed button) without this component needing to know
// anything about query params itself.
export default function FeedList({ onNavigateAway, initialGroupId }: { onNavigateAway?: () => void; initialGroupId?: string }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const uid = user?.uid;

  const [filterGroupId, setFilterGroupId] = React.useState<string>(initialGroupId || 'all');
  const [filterMemberUid, setFilterMemberUid] = React.useState<string>('all');
  const [filterCategory, setFilterCategory] = React.useState<string>('all');
  // Reacts to a NEW initialGroupId arriving (e.g. tapping a different group's Feed button while
  // this panel/page is already mounted) rather than only seeding it once on mount.
  React.useEffect(() => {
    if (initialGroupId) setFilterGroupId(initialGroupId);
  }, [initialGroupId]);

  // Clears the header's unread-feed badge the moment this mounts — whether that's the full page
  // or the slide-over panel opening.
  React.useEffect(() => {
    if (!uid) return;
    setDoc(doc(db, 'users', uid), { lastFeedViewedAt: new Date().toISOString() }, { merge: true }).catch((err) =>
      console.error('Failed to update lastFeedViewedAt:', err),
    );
  }, [uid]);

  // Fetch memberships to know which groups to poll for. Memoized on uid (a stable
  // primitive) rather than the user object, which can get a new reference on every
  // auth-state refresh — otherwise this query object is rebuilt every render, and
  // useCollection treats each rebuild as a brand-new subscription, never settling.
  const membershipsQuery = React.useMemo(
    () => (uid ? query(collection(db, 'members'), where('userId', '==', uid)) : null),
    [uid],
  );
  const [membershipsValue] = useCollection(membershipsQuery);

  // Stable groupIds reference — only changes when the actual set of group IDs changes,
  // not on every render (membershipsValue?.docs.map(...) otherwise creates a new array
  // every time, which would defeat the query memoization below).
  const groupIdsKey = (membershipsValue?.docs.map((d) => d.data().groupId) || []).slice().sort().join(',');
  const groupIds = React.useMemo(() => (groupIdsKey ? groupIdsKey.split(',') : []), [groupIdsKey]);

  // Fetch these groups
  const groupsQuery = React.useMemo(
    () => (groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null),
    [groupIds],
  );
  const [groupsValue] = useCollection(groupsQuery);

  const groupsMap = React.useMemo(() => {
    const map: Record<string, any> = {};
    groupsValue?.docs.forEach(doc => {
      map[doc.id] = doc.data();
    });
    return map;
  }, [groupsValue]);

  // Fetch activities for these groups
  const activitiesQuery = React.useMemo(
    () => (groupIds.length > 0
      ? query(collection(db, 'activities'), where('groupId', 'in', groupIds), orderBy('createdAt', 'desc'), limit(100))
      : null),
    [groupIds],
  );
  const [specificGroupActivitiesValue, specificGroupLoading] = useCollection(activitiesQuery);

  // Fetch personal activities — anything keyed to this user specifically rather than a group:
  // group_deleted/invite_received (pre-membership), plus every notification that has no group to
  // fan out through (pokes, game invites/pokes/chat, DMs, expense/todo/loan reminders — see
  // logFeedActivity in server.ts). Deliberately not filtered by `type` — that would mean adding a
  // new personal notification type here every time one's introduced server-side, and Firestore's
  // `in` operator tops out at 30 values anyway. A user's own group-activity entries (add_expense
  // etc., where they're also `userId` as the actor) come back here too, but the id-based dedupe
  // below already collapses that overlap with the groupId-based query.
  const personalActivitiesQuery = React.useMemo(
    () => (uid ? query(collection(db, 'activities'), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(30)) : null),
    [uid],
  );
  const [personalActivitiesValue, personalLoading] = useCollection(personalActivitiesQuery);

  // The full merged/deduped/sorted candidate list, NOT yet truncated to a display count —
  // filters below need to see everything that could match before the list gets cut down,
  // otherwise filtering to e.g. one group could show fewer results than actually exist just
  // because the unfiltered top-30 happened to be dominated by other groups.
  const allActivities = React.useMemo(() => {
    const rawSpecificActs = specificGroupActivitiesValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [];
    const personalActs = personalActivitiesValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [];

    // Merge, filter unique, and sort
    const all = [...rawSpecificActs, ...personalActs];
    const unique = all.filter((a: any, index, self) =>
      index === self.findIndex((t) => t.id === a.id)
    );

    return unique.sort((a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [specificGroupActivitiesValue, personalActivitiesValue]);

  // Filter option lists — derived from whichever activities are actually loaded (not a separate
  // query), same "derive from what's on screen" approach the rest of this app's client-side
  // filters already use (e.g. Settlements.tsx's group tabs).
  const filterableGroups = React.useMemo(
    () => groupIds.map((gid) => ({ id: gid, name: groupsMap[gid]?.name || t('common.group') })).filter((g) => g.name),
    [groupIds, groupsMap, t],
  );
  const filterableMembers = React.useMemo(() => {
    const map = new Map<string, string>();
    allActivities.forEach((a: any) => {
      if (a.userId && a.userName) map.set(a.userId, a.userName);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allActivities]);
  const filterableCategories = React.useMemo(() => {
    const ids = new Set<string>();
    allActivities.forEach((a: any) => {
      if (a.data?.category) ids.add(a.data.category);
    });
    return Array.from(ids).map((id) => ({ id, name: EXPENSE_CATEGORIES.find((c) => c.id === id)?.name || id }));
  }, [allActivities]);

  // A pending reload isn't a real Firestore activity for anyone in particular — it's injected
  // here, unconditionally ahead of every group/member/category filter below, straight from the
  // same live signal UpdateBanner.tsx uses, so it shows up in "recent updates" too rather than
  // only as the floating banner.
  const { available: updateAvailable } = useAppUpdateAvailable();

  const activities = React.useMemo(() => {
    const filtered = allActivities
      .filter((a: any) => filterGroupId === 'all' || a.groupId === filterGroupId)
      .filter((a: any) => filterMemberUid === 'all' || a.userId === filterMemberUid)
      .filter((a: any) => filterCategory === 'all' || a.data?.category === filterCategory)
      .slice(0, 30);
    if (!updateAvailable) return filtered;
    const updateEntry = {
      id: 'system-update', type: 'system_update', userName: 'FamilyLedger', userPhoto: '',
      createdAt: new Date().toISOString(), data: {}, description: t('update.available'),
    };
    return [updateEntry, ...filtered];
  }, [allActivities, filterGroupId, filterMemberUid, filterCategory, updateAvailable, t]);

  const loading = (groupIds.length > 0 && specificGroupLoading) || personalLoading;

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'add_expense': return 'add_circle';
      case 'edit_expense': return 'edit';
      case 'delete_expense': return 'delete';
      case 'create_group': return 'groups';
      case 'update_group_icon': return 'palette';
      case 'invite': return 'person_add';
      case 'invite_received': return 'mail';
      case 'group_deleted': return 'delete_forever';
      case 'weekly_summary': return 'insights';
      case 'add_income': return 'trending_up';
      case 'leave': return 'logout';
      case 'comment': case 'dm_chat': return 'chat';
      case 'todo_created': return 'checklist';
      case 'todo_completed': return 'task_alt';
      case 'todo_reminder': return 'notifications_active';
      case 'budget_set': case 'budget_reminder': return 'account_balance_wallet';
      case 'recurring_created': case 'recurring_changed': return 'autorenew';
      case 'recurring_deleted': return 'event_busy';
      case 'recurring_confirm_pending': return 'pending_actions';
      case 'shopping_list_created': return 'shopping_cart';
      case 'poke': return 'back_hand';
      case 'made_admin': return 'verified_user';
      case 'expense_reminder': return 'notifications_active';
      case 'settlement_reminder': return 'payments';
      case 'loan_reminder': case 'loan_installment_due': case 'loan_activity': return 'payments';
      case 'admin_feedback': return 'feedback';
      case 'feedback_reply': return 'forum';
      case 'feedback_resolved': return 'task_alt';
      case 'friend_request': return 'person_add';
      case 'friend_accepted': return 'how_to_reg';
      case 'system_update': return 'system_update';
      default:
        if (type.endsWith('_chat')) return 'chat';
        if (type.endsWith('_invite')) return 'sports_esports';
        if (type.endsWith('_poke')) return 'back_hand';
        return 'history';
    }
  };

  const getActivityColor = (type: string) => {
    if (type === 'delete_expense' || type === 'group_deleted' || type === 'recurring_deleted') return 'bg-error';
    if (type === 'weekly_summary') return 'bg-accent';
    if (type === 'recurring_confirm_pending' || type === 'budget_reminder' || type === 'expense_reminder' || type === 'settlement_reminder' || type === 'todo_reminder' || type === 'loan_reminder' || type === 'loan_installment_due') return 'bg-warning';
    if (type === 'system_update') return 'bg-primary';
    if (type === 'feedback_resolved') return 'bg-success';
    if (type === 'admin_feedback' || type === 'feedback_reply') return 'bg-primary';
    if (type === 'made_admin') return 'bg-success';
    if (type === 'edit_expense' || type === 'recurring_created' || type === 'recurring_changed') return 'bg-secondary';
    if (type === 'add_expense' || type === 'add_income' || type === 'join' || type === 'todo_completed') return 'bg-success';
    if (type.includes('group') || type === 'invite' || type === 'invite_received' || type === 'friend_request' || type === 'friend_accepted') return 'bg-primary';
    if (type === 'poke' || type.endsWith('_poke')) return 'bg-warning';
    if (type.endsWith('_invite')) return 'bg-primary';
    if (type.endsWith('_chat') || type === 'dm_chat') return 'bg-secondary';
    return 'bg-secondary';
  };

  const renderActivityDescription = (activity: any) => {
    // Game invites/pokes are dynamically-typed per game ('ludo_invite', 'chess_poke', ...) rather
    // than a fixed literal, so they're handled before the switch instead of as a `case`.
    if (activity.type.endsWith('_invite') || activity.type.endsWith('_poke')) {
      const routeSegment = activity.data?.routeSegment || activity.type.replace(/_(invite|poke)$/, '');
      const gameName = t(`games.${routeSegment}`);
      const name = activity.userName || t('common.someone');
      const code = activity.data?.code || '';
      const isPoke = activity.type.endsWith('_poke');
      return (
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-primary uppercase tracking-wider">
            {t(isPoke ? 'feed.gamePokeLabel' : 'feed.gameInviteLabel', { game: gameName })}
          </p>
          <p className="text-sm font-bold text-on-surface">
            {t(isPoke ? 'feed.gamePoked' : 'feed.gameInvited', { name, game: gameName, code })}
          </p>
        </div>
      );
    }
    switch (activity.type) {
      case 'invite':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.inviteSent')}</p>
            <p className="text-sm font-bold text-on-surface">{t('feed.invitedTo', { name: activity.data?.invitedEmail || t('common.someone'), group: activity.data?.groupName || t('feed.theGroup') })}</p>
          </div>
        );
      case 'invite_received':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.youreInvited')}</p>
            <p className="text-sm font-bold text-on-surface">{t('feed.joinGroup', { group: activity.data?.groupName || t('feed.aGroup') })}</p>
            <p className="text-[10px] text-text-muted font-bold">{t('feed.invitedByTapToJoin', { name: activity.data?.invitedBy || t('todo.aMember') })}</p>
          </div>
        );
      case 'add_expense':
      case 'add_income':
      case 'edit_expense':
      case 'delete_expense':
        const isDelete = activity.type === 'delete_expense';
        const isEdit = activity.type === 'edit_expense';
        const isIncome = activity.type === 'add_income';
        return (
          <div className="space-y-1">
            <p className={clsx(
              "text-[10px] font-bold uppercase tracking-wider",
              isDelete ? "text-error" : isEdit ? "text-secondary" : "text-success"
            )}>
              {isDelete ? t('feed.expenseDeleted') : isEdit ? t('feed.expenseUpdated') : isIncome ? t('feed.incomeAdded') : t('feed.expenseAdded')}
            </p>
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-bold text-on-surface line-clamp-1">{activity.data?.description}</p>
              <p className={clsx(
                "text-sm font-bold shrink-0",
                isDelete ? "text-error line-through opacity-50" : isEdit ? "text-secondary" : "text-success"
              )}>
                {getCurrencySymbol(groupsMap[activity.groupId]?.currency || activity.data?.currencyCode) || activity.data?.currencySymbol || '$'}
                {(activity.data?.newAmount || activity.data?.amount)?.toLocaleString()}
              </p>
            </div>
            <p className="text-[10px] text-text-muted font-bold tracking-tight">{groupsMap[activity.groupId]?.name || activity.data?.groupName || t('feed.inGroup')}</p>
          </div>
        );
      case 'update_group_icon':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.groupIconChanged')}</p>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-surface-container flex items-center justify-center border border-border-subtle">
                <span className="material-symbols-outlined text-[14px] text-text-muted">{activity.data?.oldIcon || 'help'}</span>
              </div>
              <span className="material-symbols-outlined text-text-muted text-[14px]">arrow_forward</span>
              <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center border border-primary/20">
                <span className="material-symbols-outlined text-[14px] text-primary">{activity.data?.icon}</span>
              </div>
            </div>
          </div>
        );
      case 'join':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-success uppercase tracking-wider">{t('feed.newMember')}</p>
            <p className="text-sm font-bold text-on-surface">{t('feed.joined', { name: activity.userName || t('common.someone') })}</p>
            <p className="text-[10px] text-text-muted font-bold">{activity.data?.groupName || t('feed.theGroup')}</p>
          </div>
        );
      case 'weekly_summary':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-accent uppercase tracking-widest leading-none">{t('feed.yourWeeklyRecap')}</p>
            <p className="text-sm font-bold text-on-surface leading-tight line-clamp-2">{activity.description}</p>
          </div>
        );
      case 'comment': {
        const name = activity.userName || t('common.someone');
        const context = activity.data?.contextLabel;
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.newComment')}</p>
            <p className="text-sm font-bold text-on-surface">
              {context ? t('feed.commentedOn', { name, context }) : t('feed.commentedInGroup', { name })}
            </p>
            {activity.data?.description && (
              <p className="text-sm text-on-surface line-clamp-2">{activity.data.description}</p>
            )}
          </div>
        );
      }
      case 'recurring_created':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">{t('feed.recurringCreatedLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.recurringSetUp', {
                name: activity.userName || t('common.someone'),
                description: activity.data?.description || '',
                amount: activity.data?.amount != null ? `${getCurrencySymbol(groupsMap[activity.groupId]?.currency)}${Number(activity.data.amount).toLocaleString()}` : '',
              })}
            </p>
          </div>
        );
      case 'recurring_changed':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">{t('feed.recurringChangedLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.recurringChangedActivity', { name: activity.userName || t('common.someone'), description: activity.data?.description || '' })}
            </p>
          </div>
        );
      case 'recurring_deleted':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-error uppercase tracking-wider">{t('feed.recurringDeletedLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.recurringDeletedActivity', { name: activity.userName || t('common.someone'), description: activity.data?.description || '' })}
            </p>
          </div>
        );
      case 'shopping_list_created':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.shoppingListLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {activity.data?.contextLabel
                ? t('feed.shoppingListCreatedScheduled', { name: activity.userName || t('common.someone'), description: activity.data?.description || '', context: activity.data.contextLabel })
                : t('feed.shoppingListCreatedActivity', { name: activity.userName || t('common.someone'), description: activity.data?.description || '' })}
            </p>
          </div>
        );
      case 'todo_created':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-success uppercase tracking-wider">{t('feed.todoAddedLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.todoCreatedActivity', { name: activity.userName || t('common.someone'), description: activity.data?.description || '' })}
            </p>
          </div>
        );
      case 'todo_completed':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-success uppercase tracking-wider">{t('feed.todoCompletedLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.todoCompletedActivity', { name: activity.userName || t('common.someone'), description: activity.data?.description || '' })}
            </p>
          </div>
        );
      case 'budget_set':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.budgetSetLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.budgetSetActivity', {
                name: activity.userName || t('common.someone'),
                amount: activity.data?.amount != null ? `${getCurrencySymbol(groupsMap[activity.groupId]?.currency)}${Number(activity.data.amount).toLocaleString()}` : '',
                month: activity.data?.month != null ? t(MONTH_KEYS[activity.data.month]) : '',
                year: activity.data?.year ?? '',
              })}
            </p>
          </div>
        );
      case 'recurring_confirm_pending':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.recurringConfirmPendingLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.recurringConfirmPendingActivity', { description: activity.data?.description || activity.description || '' })}
            </p>
          </div>
        );
      case 'expense_reminder':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.expenseReminderLabel')}</p>
            <p className="text-sm font-medium text-on-surface">{t('feed.expenseReminderActivity')}</p>
          </div>
        );
      case 'todo_reminder':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.todoReminderLabel')}</p>
            <p className="text-sm font-medium text-on-surface">
              {t('feed.todoReminderActivity', { text: activity.data?.text || activity.description || '' })}
            </p>
          </div>
        );
      case 'budget_reminder':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.budgetReminderLabel')}</p>
            <p className="text-sm font-medium text-on-surface">
              {t(activity.data?.isNewMonth ? 'feed.budgetReminderNewMonth' : 'feed.budgetReminderStillNone', { group: groupsMap[activity.groupId]?.name || t('feed.theGroup') })}
            </p>
          </div>
        );
      case 'loan_reminder':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.loanReminderLabel')}</p>
            <p className="text-sm font-medium text-on-surface">
              {t(activity.data?.forOwner === false ? 'feed.loanReminderCounterparty' : 'feed.loanReminderOwner', { name: activity.data?.contactName || t('common.someone') })}
            </p>
          </div>
        );
      case 'loan_installment_due':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.loanInstallmentDueLabel')}</p>
            <p className="text-sm font-medium text-on-surface">
              {t('feed.loanInstallmentDueActivity', {
                frequency: activity.data?.frequency === 'weekly' ? t('analysis.weekly') : t('analysis.monthly'),
                amount: activity.data?.amount ?? '',
              })}
            </p>
          </div>
        );
      case 'made_admin': {
        const name = activity.userName || t('common.someone');
        const groupName = groupsMap[activity.groupId || activity.data?.groupId]?.name || t('feed.theGroup');
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-success uppercase tracking-wider">{t('feed.madeAdminLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.madeAdminActivity', { name, group: groupName })}
            </p>
          </div>
        );
      }
      case 'poke': {
        const isGroupPoke = activity.data?.pokedAll === true;
        const name = activity.userName || t('common.someone');
        const groupName = groupsMap[activity.groupId || activity.data?.groupId]?.name || t('feed.theGroup');
        const body = t('feed.addExpensesReminder', { group: groupName });
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-warning uppercase tracking-wider">{t('feed.pokeLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t(isGroupPoke ? 'feed.pokedGroupActivity' : 'feed.pokedYouActivity', { name, body })}
            </p>
          </div>
        );
      }
      case 'feedback_resolved': {
        const typeKey = activity.data?.feedbackType === 'suggestion' ? 'feed.feedbackTypeSuggestion'
          : activity.data?.feedbackType === 'bug' ? 'feed.feedbackTypeBug' : 'feed.feedbackTypeFeedback';
        const text = activity.data?.text;
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-success uppercase tracking-wider">{t('feed.feedbackResolvedLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {text
                ? t('feed.feedbackResolvedActivity', { type: t(typeKey), text })
                : t('feed.feedbackResolvedActivityNoText', { type: t(typeKey) })}
            </p>
          </div>
        );
      }
      case 'feedback_reply':
        return (
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('feed.feedbackReplyLabel')}</p>
            <p className="text-sm font-bold text-on-surface">
              {t('feed.feedbackReplyActivity', { text: activity.data?.text || activity.description || '' })}
            </p>
          </div>
        );
      default:
        return (
          <p className="text-sm font-medium text-on-surface leading-tight">
            {activity.description}
          </p>
        );
    }
  };

  const goTo = (path: string) => {
    onNavigateAway?.();
    navigate(path);
  };

  const hasActiveFilter = filterGroupId !== 'all' || filterMemberUid !== 'all' || filterCategory !== 'all';

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <select
          value={filterGroupId}
          onChange={(e) => setFilterGroupId(e.target.value)}
          className="shrink-0 text-[11px] font-bold bg-white border border-border-subtle rounded-lg px-2 py-1.5 outline-none text-on-surface"
        >
          <option value="all">{t('groupExpenses.allGroups')}</option>
          {filterableGroups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select
          value={filterMemberUid}
          onChange={(e) => setFilterMemberUid(e.target.value)}
          className="shrink-0 text-[11px] font-bold bg-white border border-border-subtle rounded-lg px-2 py-1.5 outline-none text-on-surface"
        >
          <option value="all">{t('groupExpenses.allMembers')}</option>
          {filterableMembers.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="shrink-0 text-[11px] font-bold bg-white border border-border-subtle rounded-lg px-2 py-1.5 outline-none text-on-surface"
        >
          <option value="all">{t('analysis.allCategories')}</option>
          {filterableCategories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {hasActiveFilter && (
          <button
            onClick={() => { setFilterGroupId('all'); setFilterMemberUid('all'); setFilterCategory('all'); }}
            className="shrink-0 text-[11px] font-bold text-primary px-2 py-1.5"
          >
            {t('common.clear')}
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
      <div className="divide-y divide-border-subtle">
        {loading && <div className="p-10 text-center text-text-muted">{t('feed.loadingActivity')}</div>}
        {!loading && activities.length === 0 && (
          <div className="p-10 text-center text-text-muted font-bold">
            {hasActiveFilter ? t('feed.noActivityMatches') : t('feed.noActivityYet')}
          </div>
        )}
        {activities.map((activity, index) => (
        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.05 }}
          key={activity.id || index}
          className="p-5 flex items-start gap-4 hover:bg-surface-container/20 transition-colors cursor-pointer"
          onClick={() => {
            const type = activity.type;
            const data = activity.data || {};
            if (type === 'system_update') {
              hardReloadApp();
            } else if (type === 'weekly_summary') {
              goTo('/weekly-summary');
            } else if (type === 'friend_request' && data.friendUid) {
              goTo(`/friends?request=${data.friendUid}`);
            } else if (type === 'friend_accepted') {
              goTo('/friends');
            } else if (type === 'invite_received' && data.groupId) {
              goTo(`/join/${data.groupId}`);
            } else if (type === 'recurring_confirm_pending') {
              goTo('/recurring-approvals');
            } else if ((type === 'recurring_created' || type === 'recurring_changed' || type === 'recurring_deleted') && activity.groupId) {
              goTo(`/recurring-expenses?groupId=${activity.groupId}`);
            } else if (type === 'made_admin' && (activity.groupId || data.groupId)) {
              goTo(`/groups/${activity.groupId || data.groupId}/manage`);
            } else if (type === 'poke' && (activity.groupId || data.groupId)) {
              goTo(`/add-expense?groupId=${activity.groupId || data.groupId}`);
            } else if (type === 'group_chat' && activity.groupId) {
              goTo(`/groups/${activity.groupId}?chat=1`);
            } else if (type === 'comment' && activity.groupId && data.expenseId) {
              // An expense-level comment — open that expense's detail/comment view directly
              // instead of just the group page. Group-level "discussion" comments have no
              // expenseId and fall through to the generic activity.groupId branch below.
              goTo(`/groups/${activity.groupId}/expenses?expenseId=${data.expenseId}`);
            } else if ((type === 'add_expense' || type === 'edit_expense' || type === 'delete_expense' || type === 'add_income') && activity.groupId) {
              goTo(`/groups/${activity.groupId}/expenses`);
            } else if (type.endsWith('_chat') && data.gameId) {
              goTo(`/games/${type.split('_')[0]}/${data.gameId}?chat=1`);
            } else if ((type.endsWith('_invite') || type.endsWith('_poke')) && data.gameId) {
              goTo(`/games/${type.split('_')[0]}/${data.gameId}`);
            } else if (type === 'dm_chat' && data.otherUid) {
              goTo(`/?dm=${data.otherUid}`);
            } else if (type === 'expense_reminder') {
              const params = new URLSearchParams();
              if (data.groupId) params.set('groupId', data.groupId);
              if (data.category) params.set('category', data.category);
              if (data.amount) params.set('amount', data.amount);
              if (data.reminderId) params.set('reminderId', data.reminderId);
              goTo(`/add-expense${params.toString() ? `?${params.toString()}` : ''}`);
            } else if (type === 'settlement_reminder' && data.groupId && data.settleWith) {
              const params = new URLSearchParams({ groupId: data.groupId, settleWith: data.settleWith, description: 'Settlement', category: 'misc' });
              if (data.amount) params.set('amount', String(data.amount));
              goTo(`/add-expense?${params.toString()}`);
            } else if (type === 'todo_reminder') {
              goTo('/todo');
            } else if ((type === 'loan_reminder' || type === 'loan_installment_due' || type === 'loan_activity') && data.contactId) {
              goTo(`/personal-loans/${data.contactId}`);
            } else if (type === 'budget_reminder' && activity.groupId) {
              goTo(`/groups/${activity.groupId}/manage`);
            } else if (type === 'admin_feedback') {
              goTo('/admin/feedback');
            } else if (type === 'feedback_reply' || type === 'feedback_resolved') {
              goTo('/feedback');
            } else if (activity.groupId) {
              goTo(`/groups/${activity.groupId}`);
            }
          }}
        >
          <div className="relative shrink-0">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold overflow-hidden border-2 border-white shadow-md ring-1 ring-border-subtle/30">
              {activity.userPhoto ? (
                <img
                  src={activity.userPhoto}
                  alt=""
                  className="w-full h-full object-cover transform scale-110"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-primary/20 text-primary text-sm uppercase font-black">
                  {activity.userName?.slice(0, 1) || '?'}
                </div>
              )}
            </div>
            <div className={clsx(
              "absolute -bottom-0.5 -right-0.5 rounded-full w-6 h-6 flex items-center justify-center border-2 border-white text-white shadow-md z-10",
              getActivityColor(activity.type)
            )}>
              <span className="material-symbols-outlined text-[12px] font-black">
                {getActivityIcon(activity.type)}
              </span>
            </div>
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[12px] font-black text-primary uppercase tracking-tight truncate max-w-[160px]">
                {activity.userName || t('common.someone')}
              </span>
              <span className="text-[10px] text-text-muted font-bold opacity-30">•</span>
              <span className="text-[10px] text-text-muted font-medium">
                {new Date(activity.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {renderActivityDescription(activity)}
            <p className="text-[10px] text-text-muted mt-1.5 font-bold opacity-60">
              {new Date(activity.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        </motion.div>
        ))}
      </div>
      </div>
    </div>
  );
}
