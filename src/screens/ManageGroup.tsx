import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { doc, collection, query, where, updateDoc, deleteDoc, addDoc, getDocs, writeBatch, setDoc } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { updateGlobalStats } from '../services/statsService';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, getCurrencySymbol, formatAmountCompact } from '../lib/constants';
import { inviteToGroup, inviteUserToGroup, searchUsers, FoundUser } from '../lib/inviteApi';
import { useFriendships } from '../lib/useFriendships';
import { claimPoints, getLeaderboard, LeaderboardEntry } from '../lib/pointsApi';
import { getBudgetStatus } from '../lib/budget';
import { describeFrequency } from '../lib/frequency';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { currentLocalMonthKey } from '../lib/dateUtils';
import { GROUP_ICONS, groupIconEmoji } from '../lib/groupIcons';
import { useLanguage } from '../context/LanguageContext';

export default function ManageGroup() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteFeedback, setInviteFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pokingUserId, setPokingUserId] = useState<string | null>(null);
  const [pokedUserId, setPokedUserId] = useState<string | null>(null);
  const [pokingAll, setPokingAll] = useState(false);
  const [pokedAll, setPokedAll] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactPickerFailed, setContactPickerFailed] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState<FoundUser[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [invitingUid, setInvitingUid] = useState<string | null>(null);
  const [invitedUids, setInvitedUids] = useState<Set<string>>(new Set());

  const [groupValue, groupLoading] = useDocument(doc(db, 'groups', groupId!));
  const [membersValue, membersLoading] = useCollection(
    query(collection(db, 'members'), where('groupId', '==', groupId!))
  );
  const [pendingInvitesValue] = useCollection(
    query(collection(db, 'groups', groupId!, 'invites'), where('status', '==', 'pending'))
  );
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);

  const group = groupValue?.data();
  const [groupIcon, setGroupIcon] = useState('🏠');
  const [showIconGrid, setShowIconGrid] = useState(false);
  const [recurringTypeFilter, setRecurringTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // Monthly budget — doc ID is deterministic (`${groupId}_${YYYY-MM}`) so setting it is a
  // plain upsert. Month-to-date spend is computed client-side from this group's expenses.
  const monthKey = currentLocalMonthKey();
  const budgetDocId = `${groupId}_${monthKey}`;
  const [budgetValue] = useDocument(doc(db, 'groupBudgets', budgetDocId));
  const budget = budgetValue?.data();
  const [showBudgetForm, setShowBudgetForm] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);

  const [showGroupLeaderboard, setShowGroupLeaderboard] = useState(false);
  const [groupLeaderboard, setGroupLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loadingGroupLeaderboard, setLoadingGroupLeaderboard] = useState(false);
  React.useEffect(() => {
    if (!showGroupLeaderboard || !groupId) return;
    setLoadingGroupLeaderboard(true);
    getLeaderboard('group', groupId)
      .then(setGroupLeaderboard)
      .catch((err) => console.error('getLeaderboard (group) failed:', err))
      .finally(() => setLoadingGroupLeaderboard(false));
  }, [showGroupLeaderboard, groupId]);

  // Opportunistic "did last month's budget hold" check — there's no natural moment a user visits
  // exactly when a month rolls over, so this just tries on every ManageGroup visit instead of
  // needing a cron job. Harmless no-op server-side if last month had no budget, was already
  // claimed, or wasn't actually met.
  React.useEffect(() => {
    if (!groupId) return;
    const prevMonthDate = new Date();
    prevMonthDate.setDate(1);
    prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
    const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
    claimPoints('budget_met', { groupId, monthKey: prevMonthKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const [groupExpensesValue] = useCollection(
    query(collection(db, 'expenses'), where('groupId', '==', groupId!))
  );

  // Group-wide recurring expenses — visible to every member (with who set each one up),
  // but only the creator can pause/edit/delete their own rule (enforced by firestore.rules).
  const [recurringValue, , recurringError] = useCollection(
    query(collection(db, 'recurringExpenses'), where('groupId', '==', groupId!))
  );
  const recurringRules = recurringValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];
  if (recurringError) console.error('recurringExpenses (group) query error:', recurringError.code, recurringError.message);
  // Budget tracks spending only — income entries are excluded outright (never netted against
  // spend), so logging income in a month can't make its budget look more under control.
  const monthSpend = React.useMemo(() => {
    return (groupExpensesValue?.docs || [])
      .map((d) => d.data())
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey) && e.type !== 'income')
      .reduce((sum, e: any) => sum + (e.amount || 0), 0);
  }, [groupExpensesValue, monthKey]);

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedBudget = evaluateAmountSum(budgetInput);
    if (!parsedBudget || parsedBudget <= 0 || !groupId || !user) return;
    setSavingBudget(true);
    try {
      await setDoc(doc(db, 'groupBudgets', budgetDocId), {
        groupId,
        month: monthKey,
        amount: parsedBudget,
        setBy: user.uid,
        createdAt: new Date().toISOString(),
      }, { merge: true });
      claimPoints('budget_set', { budgetDocId });
      const now = new Date();
      notifyGroupActivity({
        groupId,
        action: 'budget_set',
        amount: parsedBudget,
        month: now.getMonth(),
        year: now.getFullYear(),
        actorName: profile?.displayName || user.displayName || 'Someone',
      });
      setShowBudgetForm(false);
      setBudgetInput('');
    } catch (error) {
      console.error('Failed to save budget:', error);
      alert(t('manageGroup.failedToSaveBudget'));
    } finally {
      setSavingBudget(false);
    }
  };

  React.useEffect(() => {
    if (group?.icon) setGroupIcon(group.icon);
  }, [group?.icon]);

  const resizeImage = (file: File, maxWidth = 800, maxHeight = 800): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxWidth) {
              height *= maxWidth / width;
              width = maxWidth;
            }
          } else {
            if (height > maxHeight) {
              width *= maxHeight / height;
              height = maxHeight;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
      };
    });
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !groupId) return;

    setUploadingPhoto(true);
    try {
      const resized = await resizeImage(file);
      await updateDoc(doc(db, 'groups', groupId), {
        photoURL: resized
      });

      // Log Activity
      await addDoc(collection(db, 'activities'), {
        groupId,
        userId: user!.uid,
        userName: profile?.displayName || user?.displayName || 'Someone',
        userPhoto: profile?.photoURL || user?.photoURL || '',
        type: 'update_group_photo',
        description: `${profile?.displayName || user?.displayName || 'Someone'} updated the group photo`,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Photo update error:', error);
      alert(t('manageGroup.failedToUpdatePhoto'));
    } finally {
      setUploadingPhoto(false);
    }
  };

  const ICONS = GROUP_ICONS;

  const handleUpdateIcon = async (newIcon: string) => {
    try {
      const oldIcon = group?.icon || groupIcon;
      await updateDoc(doc(db, 'groups', groupId!), { icon: newIcon });
      setGroupIcon(newIcon);
      
      // Log Activity
      await addDoc(collection(db, 'activities'), {
        groupId,
        userId: user!.uid,
        userName: profile?.displayName || user?.displayName || 'Someone',
        userPhoto: profile?.photoURL || user?.photoURL || '',
        type: 'update_group_icon',
        description: `${profile?.displayName || user?.displayName || 'Someone'} changed the group icon`,
        data: { 
          icon: newIcon,
          oldIcon,
          groupName: group.name
        },
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Update icon error:', error);
    }
  };
  const members = membersValue?.docs.map(doc => ({ id: doc.id, ...doc.data() } as any)) || [];
  const { accepted: acceptedFriendsForInvite, usersByUid: friendUsersByUid } = useFriendships(user?.uid);
  const memberUidsForInvite = new Set(members.map((m: any) => m.userId));
  const addableFriends = acceptedFriendsForInvite
    .map(({ friendUid }) => friendUsersByUid.get(friendUid))
    .filter((u): u is { uid: string; displayName: string; photoURL: string } =>
      !!u && !memberUidsForInvite.has(u.uid) && !invitedUids.has(u.uid));
  const currentMember = members.find((m: any) => m.userId === user?.uid);
  const isAdminOrOwner = currentMember?.role === 'admin' || currentMember?.role === 'owner';
  const isCreator = !!user?.uid && group?.createdBy === user.uid;

  const handleToggleSplit = async () => {
    try {
      await updateDoc(doc(db, 'groups', groupId!), { splitEnabled: !group.splitEnabled });
    } catch (error) {
      console.error('Toggle split error:', error);
    }
  };

  const handleToggleIncome = async () => {
    try {
      await updateDoc(doc(db, 'groups', groupId!), { incomeEnabled: !group.incomeEnabled });
    } catch (error) {
      console.error('Toggle income error:', error);
    }
  };

  const handleSetGroupType = async (groupType: 'regular' | 'event') => {
    try {
      await updateDoc(doc(db, 'groups', groupId!), { groupType });
    } catch (error) {
      console.error('Set group type error:', error);
    }
  };

  // Debounced live search as the user types their ID/email/name — mirrors the debounce pattern
  // used elsewhere in this app for search-as-you-type (e.g. GlobalSearch.tsx). Declared here,
  // above the loading/not-found early returns below, because hooks must run unconditionally on
  // every render — placing this after those guards made it skip entirely on the first (loading)
  // render and then run on every render after, which is exactly what triggered React's "Rendered
  // more hooks than during the previous render" error.
  useEffect(() => {
    const q = userSearchQuery.trim();
    if (q.length < 2) {
      setUserSearchResults([]);
      return;
    }
    setSearchingUsers(true);
    const handle = setTimeout(() => {
      searchUsers(q, groupId)
        .then(setUserSearchResults)
        .catch((err) => console.error('User search failed:', err))
        .finally(() => setSearchingUsers(false));
    }, 400);
    return () => clearTimeout(handle);
  }, [userSearchQuery, groupId]);

  if (groupLoading || membersLoading) {
    return <div className="h-screen flex items-center justify-center">{t('manageGroup.loading')}</div>;
  }

  if (!group) {
    return <div className="h-screen flex items-center justify-center">{t('manageGroup.groupNotFound')}</div>;
  }

  const handleShare = async (type: 'native' | 'copy') => {
    const link = `${window.location.origin}/join/${groupId}`;
    const inviterName = profile?.displayName || user?.displayName || 'A friend';
    const appName = "FamilyLedger";
    const messageText = `Hi! ${inviterName} is inviting you to join the group "${group.name}" on ${appName}.`;

    if (type === 'native' && navigator.share) {
      try {
        await navigator.share({
          title: 'FamilyLedger Invite',
          text: messageText,
          url: link
        });
      } catch (err) {
        console.log('Share failed:', err);
      }
    } else {
      navigator.clipboard.writeText(`${messageText} Join here: ${link}`);
      alert(t('manageGroup.inviteCopied'));
    }
  };

  // Web Contact Picker API (Chrome for Android, incl. modern Android WebView — no native
  // plugin/AAB rebuild needed). Not universally supported, so callers must feature-detect via
  // `contactPickerSupported` and fall back to a manual phone number field.
  const contactPickerSupported =
    typeof navigator !== 'undefined' && 'contacts' in navigator && typeof (navigator as any).contacts?.select === 'function';

  const handlePickContact = async () => {
    try {
      const contacts = await (navigator as any).contacts.select(['name', 'tel'], { multiple: false });
      const picked = contacts?.[0];
      if (!picked) return; // user cancelled the picker — not an error, leave the field as-is
      if (!picked.tel?.[0]) {
        alert(t('manageGroup.contactNoPhone'));
        return;
      }
      setContactName(picked.name?.[0] || '');
      setContactPhone(picked.tel[0].trim());
    } catch (err) {
      // The API exists on this WebView (passes contactPickerSupported's feature check) but
      // throws when actually invoked — some Android WebView versions expose a stub that isn't
      // fully implemented. Fall back to manual entry instead of leaving the button looking dead.
      console.error('Contact picker error:', err);
      setContactPickerFailed(true);
      alert(t('manageGroup.contactPickerFailedMsg'));
    }
  };

  const buildInviteShareMessage = () => {
    const link = `${window.location.origin}/join/${groupId}`;
    return `Hey I am using Family Ledger to track and organise my expenses lets manage our expenses together: ${link}`;
  };

  const handleSendWhatsApp = () => {
    const digits = contactPhone.replace(/[^\d+]/g, '').replace(/^\+/, '');
    const url = digits
      ? `https://wa.me/${digits}?text=${encodeURIComponent(buildInviteShareMessage())}`
      : `https://wa.me/?text=${encodeURIComponent(buildInviteShareMessage())}`;
    window.open(url, '_blank');
  };

  const handleSendSms = () => {
    const url = contactPhone
      ? `sms:${contactPhone}?body=${encodeURIComponent(buildInviteShareMessage())}`
      : `sms:?body=${encodeURIComponent(buildInviteShareMessage())}`;
    window.location.href = url;
  };

  const handleEmailInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || !groupId) return;

    setInviting(true);
    setInviteFeedback(null);
    try {
      const result = await inviteToGroup(groupId, email);
      if (result.method === 'already_member') {
        setInviteFeedback({ type: 'error', text: t('manageGroup.alreadyInGroup', { name: email }) });
      } else if (result.method === 'push') {
        setInviteFeedback({ type: 'success', text: t('manageGroup.alreadyOnAppNotified', { name: email }) });
      } else {
        setInviteFeedback({ type: 'success', text: t('manageGroup.inviteEmailSent', { email }) });
      }
      setInviteEmail('');
    } catch (error) {
      setInviteFeedback({ type: 'error', text: error instanceof Error ? error.message : t('manageGroup.failedToSendInvite') });
    } finally {
      setInviting(false);
    }
  };

  const handleInviteFoundUser = async (foundUser: FoundUser) => {
    if (!groupId) return;
    setInvitingUid(foundUser.uid);
    try {
      const result = await inviteUserToGroup(groupId, foundUser.uid);
      if (result.method === 'already_member') {
        setInviteFeedback({ type: 'error', text: t('manageGroup.alreadyInGroup', { name: foundUser.displayName }) });
      } else {
        setInvitedUids((prev) => new Set(prev).add(foundUser.uid));
        setInviteFeedback({ type: 'success', text: t('manageGroup.userNotified', { name: foundUser.displayName }) });
      }
    } catch (error) {
      setInviteFeedback({ type: 'error', text: error instanceof Error ? error.message : t('manageGroup.failedToSendInvite') });
    } finally {
      setInvitingUid(null);
    }
  };

  const handleArchive = async () => {
    // Simplified archive action
    alert(t('manageGroup.groupArchived'));
  };

  const handleResendInvite = async (email: string, inviteId: string) => {
    if (!groupId) return;
    setResendingInviteId(inviteId);
    try {
      await inviteToGroup(groupId, email);
    } catch (error) {
      alert(error instanceof Error ? error.message : t('manageGroup.failedToResendInvite'));
    } finally {
      setResendingInviteId(null);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    if (!groupId) return;
    try {
      await deleteDoc(doc(db, 'groups', groupId, 'invites', inviteId));
    } catch (error) {
      console.error('Cancel invite error:', error);
      alert(t('manageGroup.failedToCancelInvite'));
    }
  };

  const updateMemberRole = async (memberId: string, newRole: string, targetUserId?: string) => {
    if (!isAdminOrOwner) return;
    try {
      await updateDoc(doc(db, 'members', memberId), { role: newRole });
      if (newRole === 'admin' && targetUserId && groupId) {
        user
          ?.getIdToken()
          .then((idToken) =>
            fetch('/api/notify-role-change', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ groupId, targetUserId }),
            }),
          )
          .catch((err) => console.error('notify-role-change failed:', err));
      }
    } catch (error) {
      console.error('Update role error:', error);
    }
  };

  const handleRemoveMember = async (memberId: string, memberName: string) => {
    if (!isCreator) return;
    if (!confirm(t('manageGroup.confirmRemoveMember', { name: memberName }))) return;
    try {
      await deleteDoc(doc(db, 'members', memberId));
    } catch (error) {
      console.error('Remove member error:', error);
    }
  };

  // The group creator can't leave (they'd orphan the group — Delete Group is the equivalent
  // action for them). Everyone else can. The activity log write happens *before* deleting the
  // membership doc, not after — firestore.rules' activities create rule requires the writer to
  // currently be a group member (isMember(groupId)), which would already be false by the time a
  // post-delete write ran.
  const handleLeaveGroup = async () => {
    if (!currentMember || !user || isCreator) return;
    if (!window.confirm(t('manageGroup.confirmLeaveGroup', { name: group.name }))) return;
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      await addDoc(collection(db, 'activities'), {
        groupId,
        userId: user.uid,
        userName: actorName,
        userPhoto: profile?.photoURL || user.photoURL || '',
        type: 'leave',
        description: `${actorName} left the group`,
        createdAt: new Date().toISOString(),
      });
      await deleteDoc(doc(db, 'members', currentMember.id));
      notifyGroupActivity({
        groupId: groupId!,
        action: 'member_left',
        actorName,
      });
      navigate('/');
    } catch (error) {
      console.error('Leave group error:', error);
      alert(t('manageGroup.failedToLeaveGroup'));
    }
  };

  const handlePoke = async (targetUserId: string) => {
    if (!groupId || pokingUserId) return;
    setPokingUserId(targetUserId);
    try {
      const idToken = await user!.getIdToken();
      const res = await fetch('/api/poke-member', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, targetUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('manageGroup.failedToPoke'));
      setPokedUserId(targetUserId);
      setTimeout(() => setPokedUserId(null), 2000);
    } catch (error) {
      console.error('Poke error:', error);
      alert(error instanceof Error ? error.message : t('manageGroup.failedToPoke'));
    } finally {
      setPokingUserId(null);
    }
  };

  const handlePokeAll = async () => {
    if (!groupId || pokingAll) return;
    setPokingAll(true);
    try {
      const idToken = await user!.getIdToken();
      const res = await fetch('/api/poke-member', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, pokeAll: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('manageGroup.failedToPokeAll'));
      setPokedAll(true);
      setTimeout(() => setPokedAll(false), 2000);
    } catch (error) {
      console.error('Poke all error:', error);
      alert(error instanceof Error ? error.message : t('manageGroup.failedToPokeAll'));
    } finally {
      setPokingAll(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    const path = `groups/${groupId}`;
    try {
      // 0. Log personal activity for the deletion record
      try {
        await addDoc(collection(db, 'activities'), {
          userId: user!.uid,
          type: 'group_deleted',
          personal: true,
          description: `You permanently deleted the group "${group.name}".`,
          groupName: group.name,
          createdAt: new Date().toISOString()
        });
      } catch (actErr) {
        console.error('Failed to log delete activity:', actErr);
      }

      // 1. Delete all expenses for this group
      const expensesSnapshot = await getDocs(query(collection(db, 'expenses'), where('groupId', '==', groupId)));
      const expenseCount = expensesSnapshot.size;
      let totalExpenseAmount = 0;
      expensesSnapshot.forEach(doc => {
        totalExpenseAmount += doc.data().amount || 0;
      });
      
      const expenseBatch = writeBatch(db);
      expensesSnapshot.forEach((doc) => {
        expenseBatch.delete(doc.ref);
      });
      await expenseBatch.commit();
      
      // Update global stats
      await updateGlobalStats({
        groups: -1,
        expenses: -expenseCount,
        amount: -totalExpenseAmount
      });

      // 2. Delete all membership documents for this group (do this while we still have group owner permissions if rules require)
      // Grouping them to run in parallel
      await Promise.all(members.map(async (member: any) => {
        try {
          await deleteDoc(doc(db, 'members', member.id));
        } catch (memErr) {
          console.log('Failed to delete member doc:', member.id, memErr);
        }
      }));

      // 3. Delete the group document
      await deleteDoc(doc(db, 'groups', groupId!));
      
      navigate('/');
    } catch (error: any) {
      console.error('Delete error:', error);
      
      const errInfo = {
        error: error?.message || String(error),
        errorCode: error?.code,
        authInfo: {
          userId: user?.uid,
          email: user?.email,
          emailVerified: user?.emailVerified,
        },
        operationType: 'delete',
        path: path
      };
      console.error('Firestore Error Payload:', JSON.stringify(errInfo));
      
      if (error?.code === 'permission-denied') {
        alert(t('manageGroup.accessDeniedDelete'));
      } else {
        alert(t('manageGroup.failedToDeleteGroup', { message: error?.message || 'Unknown error' }));
      }
    } finally {
      setLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      {/* Custom Delete Confirmation Modal */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl space-y-6"
            >
              <div className="w-16 h-16 bg-error/10 rounded-2xl flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-error text-3xl">warning</span>
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-primary">{t('manageGroup.deleteGroupTitle')}</h3>
                <p className="text-sm text-text-muted leading-relaxed">
                  {t('manageGroup.deleteGroupWarning', { name: group.name })}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleDelete}
                  disabled={loading}
                  className="w-full bg-error text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:opacity-90 active:scale-95 transition-all disabled:opacity-50"
                >
                  {loading ? (
                    <span className="material-symbols-outlined animate-spin">sync</span>
                  ) : (
                    <span className="material-symbols-outlined">delete_forever</span>
                  )}
                  {loading ? t('manageGroup.deletingEllipsis') : t('manageGroup.deletePermanently')}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={loading}
                  className="w-full py-4 rounded-2xl font-bold text-text-muted hover:bg-surface-container transition-all"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <main className="flex-1 p-4 pb-16 max-w-4xl mx-auto w-full space-y-4">
        {/* Group Info & Icon Section */}
        <section className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 shadow-inner overflow-hidden">
                  {group.photoURL ? (
                    <img src={group.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="text-3xl">{groupIconEmoji(group.icon || groupIcon)}</span>
                  )}
                  {uploadingPhoto && (
                    <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>
                {isAdminOrOwner && (
                  <label className="absolute -bottom-1 -right-1 w-6 h-6 bg-white rounded-full shadow-lg border border-border-subtle flex items-center justify-center text-primary hover:bg-surface transition-all active:scale-90 cursor-pointer">
                    <span className="material-symbols-outlined text-[14px]">photo_camera</span>
                    <input type="file" className="hidden" accept="image/*" onChange={handlePhotoChange} disabled={uploadingPhoto} />
                  </label>
                )}
                {isAdminOrOwner && !group.photoURL && (
                  <button 
                    onClick={() => setShowIconGrid(!showIconGrid)}
                    className="absolute -top-1 -right-1 w-6 h-6 bg-white rounded-full shadow-lg border border-border-subtle flex items-center justify-center text-primary hover:bg-surface transition-all active:scale-90"
                  >
                    <span className="material-symbols-outlined text-[14px]">edit</span>
                  </button>
                )}
              </div>

              <div className="flex-1 min-w-0 space-y-1">
                {isAdminOrOwner ? (
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-text-muted uppercase tracking-wider px-1">{t('createGroup.groupName')}</label>
                    <input 
                      type="text"
                      className="w-full text-lg font-bold text-primary bg-surface/50 border border-border-subtle rounded-xl px-3 py-1 outline-none focus:border-primary transition-all"
                      value={group.name}
                      onChange={async (e) => {
                        await updateDoc(doc(db, 'groups', groupId!), { name: e.target.value });
                      }}
                    />
                  </div>
                ) : (
                  <h2 className="text-lg font-bold text-primary truncate">{group.name}</h2>
                )}
                <p className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('manageGroup.createdMembers', { date: new Date(group.createdAt).toLocaleDateString(), count: members.length })}</p>
              </div>
            </div>

            {isAdminOrOwner && (
              <div className="space-y-1 pt-2 border-t border-border-subtle/50">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('manageGroup.groupDescription')}</label>
                <textarea
                  value={group.description || ''}
                  onChange={async (e) => {
                    const newDesc = e.target.value;
                    await updateDoc(doc(db, 'groups', groupId!), { description: newDesc });
                  }}
                  className="w-full p-2 text-xs rounded-xl border border-border-subtle focus:ring-1 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none bg-surface/30"
                  placeholder={t('createGroup.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
            )}

            {isAdminOrOwner && (
              <div className="space-y-1 pt-2 border-t border-border-subtle/50">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('createGroup.groupType')}</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleSetGroupType('regular')}
                    className={clsx(
                      'flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all',
                      (group.groupType || 'regular') === 'regular'
                        ? 'bg-primary text-white border-primary'
                        : 'bg-surface text-text-muted border-border-subtle'
                    )}
                  >
                    {t('createGroup.regularMonthly')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetGroupType('event')}
                    className={clsx(
                      'flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all',
                      group.groupType === 'event'
                        ? 'bg-primary text-white border-primary'
                        : 'bg-surface text-text-muted border-border-subtle'
                    )}
                  >
                    {t('createGroup.oneOffEvent')}
                  </button>
                </div>
                <p className="text-[10px] text-text-muted px-1">
                  {t('manageGroup.eventGroupsDesc')}
                </p>
              </div>
            )}

            {isAdminOrOwner && (
              <div className="space-y-2 pt-2 border-t border-border-subtle/50">
                <div
                  onClick={handleToggleSplit}
                  className="flex items-center justify-between p-3 bg-surface rounded-xl border border-border-subtle cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <div className={clsx(
                      'w-9 h-9 rounded-full flex items-center justify-center transition-colors',
                      group.splitEnabled ? 'bg-primary text-white' : 'bg-white text-text-muted border border-border-subtle'
                    )}>
                      <span className="material-symbols-outlined text-[18px]">call_split</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-primary">{t('createGroup.expenseSplitting')}</span>
                      <span className="text-[10px] text-text-muted">{t('createGroup.expenseSplittingDesc')}</span>
                    </div>
                  </div>
                  <div className={clsx('w-11 h-6 rounded-full transition-all relative', group.splitEnabled ? 'bg-primary' : 'bg-border-subtle')}>
                    <div className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', group.splitEnabled ? 'left-6' : 'left-1')} />
                  </div>
                </div>

                <div
                  onClick={handleToggleIncome}
                  className="flex items-center justify-between p-3 bg-surface rounded-xl border border-border-subtle cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <div className={clsx(
                      'w-9 h-9 rounded-full flex items-center justify-center transition-colors',
                      group.incomeEnabled ? 'bg-primary text-white' : 'bg-white text-text-muted border border-border-subtle'
                    )}>
                      <span className="material-symbols-outlined text-[18px]">add_card</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-primary">{t('createGroup.trackIncome')}</span>
                      <span className="text-[10px] text-text-muted">{t('createGroup.trackIncomeDesc')}</span>
                    </div>
                  </div>
                  <div className={clsx('w-11 h-6 rounded-full transition-all relative', group.incomeEnabled ? 'bg-primary' : 'bg-border-subtle')}>
                    <div className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', group.incomeEnabled ? 'left-6' : 'left-1')} />
                  </div>
                </div>
              </div>
            )}

            <AnimatePresence>
              {showIconGrid && isAdminOrOwner && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="w-full overflow-hidden"
                >
                  <div className="pt-2">
                    <label className="text-[9px] font-bold text-text-muted uppercase tracking-wider mb-2 block">{t('manageGroup.selectIcon')}</label>
                    <div className="grid grid-cols-5 gap-2">
                      {ICONS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => { handleUpdateIcon(item.icon); setShowIconGrid(false); }}
                          className={clsx(
                            "p-2 rounded-lg border transition-all active:scale-95",
                            groupIconEmoji(group.icon || groupIcon) === item.icon
                              ? "bg-primary text-white border-primary shadow-md"
                              : "bg-surface text-on-surface border-border-subtle hover:bg-surface-container"
                          )}
                        >
                          <span className="text-base">{item.icon}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white p-3.5 rounded-2xl border border-border-subtle shadow-sm min-w-0">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('manageGroup.totalSpend')}</p>
            <p
              className="text-lg font-bold text-primary mt-0.5 truncate"
              title={`${getCurrencySymbol(group.currency)}${((group.totalSpending || 0) - (group.totalIncome || 0)).toLocaleString()}`}
            >
              {getCurrencySymbol(group.currency)}{formatAmountCompact((group.totalSpending || 0) - (group.totalIncome || 0), group.currency)}
            </p>
          </div>
          <div className="bg-white p-3.5 rounded-2xl border border-border-subtle shadow-sm">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('manageGroup.members')}</p>
            <p className="text-lg font-bold text-primary mt-0.5">{members.length}</p>
          </div>
        </div>

        {/* Monthly Budget */}
        <section className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-primary">
              {t('manageGroup.budgetHeader', { month: new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) })}
            </h3>
            {budget && (
              <button
                onClick={() => { setBudgetInput(String(budget.amount)); setShowBudgetForm(true); }}
                className="text-[11px] font-bold text-primary underline"
              >
                {t('common.edit')}
              </button>
            )}
          </div>

          {!showBudgetForm && budget && (() => {
            const remaining = budget.amount - monthSpend;
            const isOver = remaining < 0;
            const status = getBudgetStatus(monthSpend, budget.amount);
            return (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-3">
                  <div className="min-w-0">
                    <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{t('common.budget')}</p>
                    <p className="text-sm font-bold text-primary truncate" title={`${getCurrencySymbol(group.currency)}${budget.amount.toLocaleString()}`}>
                      {getCurrencySymbol(group.currency)}{formatAmountCompact(budget.amount, group.currency)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{t('common.spent')}</p>
                    <p className="text-sm font-bold text-primary truncate" title={`${getCurrencySymbol(group.currency)}${monthSpend.toLocaleString()}`}>
                      {getCurrencySymbol(group.currency)}{formatAmountCompact(monthSpend, group.currency)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{isOver ? t('common.overBy') : t('common.remaining')}</p>
                    <p className={clsx("text-sm font-bold truncate", status.textClass)} title={`${getCurrencySymbol(group.currency)}${Math.abs(remaining).toLocaleString()}`}>
                      {getCurrencySymbol(group.currency)}{formatAmountCompact(Math.abs(remaining), group.currency)}
                    </p>
                  </div>
                </div>
                <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden">
                  <div
                    className={clsx("h-full rounded-full transition-all", status.barClass)}
                    style={{ width: `${Math.min(100, status.percent)}%` }}
                  />
                </div>
                <p className={clsx("text-[10px] font-bold text-right", status.textClass)}>{t('manageGroup.percentUsed', { percent: Math.round(status.percent) })}</p>
              </div>
            );
          })()}

          {!showBudgetForm && !budget && (
            <button
              onClick={() => setShowBudgetForm(true)}
              className="w-full py-2.5 bg-primary/5 border border-primary/20 text-primary font-bold rounded-xl text-xs"
            >
              {t('manageGroup.setBudget')}
            </button>
          )}

          {showBudgetForm && (
            <form onSubmit={handleSaveBudget} className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-1 bg-surface px-3 rounded-xl border border-border-subtle">
                <span className="text-sm font-bold text-primary">{getCurrencySymbol(group.currency)}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  placeholder="0.00"
                  autoFocus
                  className="flex-1 h-10 bg-transparent text-sm outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={savingBudget || !budgetInput}
                className="px-4 h-10 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50"
              >
                {savingBudget ? t('common.saving') : t('common.save')}
              </button>
              <button
                type="button"
                onClick={() => setShowBudgetForm(false)}
                className="w-10 h-10 rounded-xl text-text-muted flex items-center justify-center"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            {hasAmountSumOperator(budgetInput) && evaluateAmountSum(budgetInput) !== null && (
              <p className="text-xs font-bold text-success px-1">= {getCurrencySymbol(group.currency)}{evaluateAmountSum(budgetInput)!.toFixed(2)}</p>
            )}
            </form>
          )}
        </section>

        {/* Recurring Expenses (group-wide, read-only here — manage your own via Recurring Expenses screen) */}
        {recurringError && (
          <p className="text-xs text-error px-1">
            {t('manageGroup.couldntLoadRecurring', { error: recurringError.code || recurringError.message })}
          </p>
        )}
        {recurringRules.length > 0 && (
          <section className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-primary">{t('search.recurringExpenses')}</h3>
              <button
                onClick={() => navigate('/recurring-expenses')}
                className="text-[11px] font-bold text-primary underline"
              >
                {t('manageGroup.manage')}
              </button>
            </div>
            <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1 w-fit">
              {(['all', 'expense', 'income'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setRecurringTypeFilter(opt)}
                  className={clsx(
                    'px-3 py-1.5 rounded-md text-xs font-bold transition-all',
                    recurringTypeFilter === opt ? 'bg-white text-primary shadow-sm' : 'text-text-muted',
                  )}
                >
                  {opt === 'all' ? t('groupExpenses.all') : opt === 'income' ? t('common.income') : t('common.expense')}
                </button>
              ))}
            </div>
            <div className="space-y-2">
              {recurringRules
                .filter((rule: any) => recurringTypeFilter === 'all' || (recurringTypeFilter === 'income' ? rule.type === 'income' : rule.type !== 'income'))
                .map((rule: any) => {
                const creator = members.find((m: any) => m.userId === rule.userId);
                const isIncome = rule.type === 'income';
                const catInfo = (isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).find((c: any) => c.id === rule.category);
                return (
                  <div
                    key={rule.id}
                    className={clsx(
                      "flex items-center gap-3 p-2 rounded-xl border border-border-subtle",
                      !rule.active && "opacity-50"
                    )}
                  >
                    <div className={clsx('w-9 h-9 rounded-full flex items-center justify-center shrink-0', isIncome ? 'bg-success/10 text-success' : 'bg-primary/5 text-primary')}>
                      <span className="text-lg">{catInfo?.icon || '🔁'}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-primary truncate flex items-center gap-1.5">
                        <span className={clsx(
                          'text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
                          isIncome ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary',
                        )}>
                          {isIncome ? t('common.income') : t('common.expense')}
                        </span>
                        <span className="truncate">
                          {rule.description || (catInfo ? t(`${isIncome ? 'income' : 'category'}.${catInfo.id}`) : '')} — {isIncome ? '+' : ''}{getCurrencySymbol(group.currency)}{Number(rule.amount).toFixed(2)}
                        </span>
                      </p>
                      <p className="text-[10px] text-text-muted truncate">
                        {describeFrequency(rule)}{!rule.active && ` · ${t('manageGroup.paused')}`}
                        {rule.splitMembers?.length > 0 && ` · ${t('manageGroup.splitNWays', { count: rule.splitMembers.length })}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0" title={t('manageGroup.setUpBy', { name: creator?.displayName || t('todo.aMember') })}>
                      <div className="w-6 h-6 rounded-full overflow-hidden bg-primary/10">
                        {creator?.photoURL ? (
                          <img src={creator.photoURL} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="material-symbols-outlined text-[14px] flex items-center justify-center h-full">person</span>
                        )}
                      </div>
                      <span className="text-[10px] font-bold text-text-muted truncate max-w-[60px]">
                        {creator?.userId === user?.uid ? t('common.me') : creator?.displayName || t('common.member')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Invite Section */}
        {!!currentMember && (
          <section className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm space-y-3">
            <div>
              <h3 className="text-sm font-bold text-primary">{t('manageGroup.inviteMembers')}</h3>
              <p className="text-[11px] text-text-muted mt-0.5">{t('manageGroup.anyoneCanInvite')}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleShare('native')}
                className="flex-1 bg-primary/5 text-primary py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-primary/10 active:scale-[0.98] transition-all border border-primary/10 shadow-sm"
              >
                <span className="material-symbols-outlined text-[18px]">{navigator.share ? 'share' : 'content_copy'}</span>
                <span>{navigator.share ? t('manageGroup.shareLink') : t('manageGroup.copyLinkBtn')}</span>
              </button>
              <button
                onClick={() => handleShare('copy')}
                className="w-10 h-10 bg-surface border border-border-subtle rounded-xl flex items-center justify-center text-primary active:scale-95 transition-all"
                title={t('manageGroup.copyFullMessage')}
              >
                <span className="material-symbols-outlined text-[18px]">chat</span>
              </button>
            </div>

            <div className="pt-2 border-t border-border-subtle/50 space-y-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                {t('manageGroup.inviteViaWhatsapp')}
              </label>
              {contactPickerSupported && !contactPickerFailed ? (
                <button
                  type="button"
                  onClick={handlePickContact}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-border-subtle bg-surface/30 text-xs"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="material-symbols-outlined text-[18px] text-primary">contacts</span>
                    <span className="truncate font-medium text-on-surface">
                      {contactName || contactPhone
                        ? `${contactName || t('manageGroup.contactFallback')}${contactPhone ? ` · ${contactPhone}` : ''}`
                        : t('manageGroup.chooseContact')}
                    </span>
                  </span>
                  <span className="text-[10px] font-bold text-primary shrink-0">{contactPhone ? t('manageGroup.change') : t('manageGroup.pick')}</span>
                </button>
              ) : (
                <input
                  type="tel"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder={t('manageGroup.phoneOptional')}
                  className="w-full px-3 py-2.5 text-xs rounded-xl border border-border-subtle focus:ring-1 focus:ring-primary/20 focus:border-primary outline-none transition-all bg-surface/30"
                />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSendWhatsApp}
                  className="flex-1 bg-[#25D366]/10 text-[#128C4A] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#25D366]/20 active:scale-[0.98] transition-all border border-[#25D366]/20"
                >
                  <span className="material-symbols-outlined text-[18px]">chat</span>
                  WhatsApp
                </button>
                <button
                  type="button"
                  onClick={handleSendSms}
                  className="flex-1 bg-primary/5 text-primary py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-primary/10 active:scale-[0.98] transition-all border border-primary/10"
                >
                  <span className="material-symbols-outlined text-[18px]">sms</span>
                  {t('search.messageLabel')}
                </button>
              </div>
              <p className="text-[10px] text-text-muted px-1">
                {contactPickerSupported && !contactPickerFailed
                  ? t('manageGroup.pickContactHelp')
                  : t('manageGroup.addPhoneHelp')}
              </p>
            </div>

            <div className="pt-2 border-t border-border-subtle/50 space-y-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('manageGroup.inviteByEmail')}</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !inviting) handleEmailInvite(); }}
                  placeholder="name@example.com"
                  className="flex-1 min-w-0 px-3 py-2.5 text-xs rounded-xl border border-border-subtle focus:ring-1 focus:ring-primary/20 focus:border-primary outline-none transition-all bg-surface/30"
                />
                <button
                  onClick={handleEmailInvite}
                  disabled={inviting || !inviteEmail.trim()}
                  className="px-4 bg-primary text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all disabled:opacity-50 flex-shrink-0"
                >
                  {inviting ? (
                    <span className="material-symbols-outlined animate-spin text-[16px]">sync</span>
                  ) : (
                    <span className="material-symbols-outlined text-[16px]">send</span>
                  )}
                  <span>{t('manageGroup.send')}</span>
                </button>
              </div>
              {inviteFeedback && (
                <p className={clsx(
                  "text-[11px] font-medium px-1",
                  inviteFeedback.type === 'success' ? 'text-success' : 'text-error'
                )}>
                  {inviteFeedback.text}
                </p>
              )}
              <p className="text-[10px] text-text-muted px-1">
                {t('manageGroup.emailInviteHelp')}
              </p>
            </div>

            <div className="pt-2 border-t border-border-subtle/50 space-y-2">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                {t('manageGroup.searchUsersLabel')}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                  placeholder={t('manageGroup.searchUsersPlaceholder')}
                  className="w-full px-3 py-2.5 text-xs rounded-xl border border-border-subtle focus:ring-1 focus:ring-primary/20 focus:border-primary outline-none transition-all bg-surface/30"
                />
                {searchingUsers && (
                  <span className="material-symbols-outlined animate-spin text-[16px] text-text-muted absolute right-3 top-1/2 -translate-y-1/2">sync</span>
                )}
              </div>
              {userSearchQuery.trim().length >= 2 && !searchingUsers && userSearchResults.length === 0 && (
                <p className="text-[11px] text-text-muted px-1">{t('manageGroup.noMatchingUsers')}</p>
              )}
              {userSearchResults.length > 0 && (
                <div className="space-y-1.5">
                  {userSearchResults.map((foundUser) => {
                    const alreadyInvited = invitedUids.has(foundUser.uid);
                    return (
                      <div key={foundUser.uid} className="flex items-center justify-between gap-2 p-2 rounded-xl bg-surface/50 border border-border-subtle">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-surface-container-high overflow-hidden shrink-0">
                            {foundUser.photoURL ? (
                              <img src={foundUser.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-primary/10 text-primary text-xs font-bold">
                                {foundUser.displayName.slice(0, 1)}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-on-surface truncate">{foundUser.displayName}</p>
                            {foundUser.shortId && (
                              <p className="text-[10px] text-text-muted font-bold tracking-wide">{t('manageGroup.idLabel', { id: foundUser.shortId })}</p>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleInviteFoundUser(foundUser)}
                          disabled={invitingUid === foundUser.uid || alreadyInvited}
                          className="px-3 py-1.5 bg-primary text-white rounded-lg text-[11px] font-bold flex items-center gap-1 active:scale-[0.98] transition-all disabled:opacity-50 shrink-0"
                        >
                          {invitingUid === foundUser.uid ? (
                            <span className="material-symbols-outlined animate-spin text-[14px]">sync</span>
                          ) : alreadyInvited ? (
                            t('manageGroup.invited')
                          ) : (
                            t('manageGroup.invite')
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-[10px] text-text-muted px-1">
                {t('manageGroup.findUsersHelp')}
              </p>
            </div>

            {addableFriends.length > 0 && (
              <div className="pt-2 border-t border-border-subtle/50 space-y-2">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                  {t('manageGroup.inviteFromFriends')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {addableFriends.map((u) => (
                    <button
                      key={u.uid}
                      onClick={() => handleInviteFoundUser({ uid: u.uid, displayName: u.displayName, photoURL: u.photoURL, shortId: null })}
                      disabled={invitingUid === u.uid}
                      className="px-3 py-1.5 rounded-full text-xs font-bold border border-border-subtle bg-white text-text-muted flex items-center gap-1 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[14px]">add</span>
                      {u.displayName}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Pending Invites */}
        {!!pendingInvitesValue?.docs.length && (
          <section className="bg-white p-4 rounded-2xl border border-border-subtle shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-primary">{t('manageGroup.pendingInvites')}</h3>
            <div className="space-y-2">
              {pendingInvitesValue.docs.map((inviteDoc) => {
                const invite = { id: inviteDoc.id, ...inviteDoc.data() } as any;
                const canManage = isCreator || invite.invitedBy === user?.uid;
                return (
                  <div key={invite.id} className="flex items-center justify-between gap-2 p-3 rounded-xl bg-surface/50 border border-border-subtle">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-on-surface truncate">{invite.email}</p>
                      <p className="text-[10px] text-text-muted font-bold uppercase tracking-wide">
                        {invite.resendCount > 0 ? t('manageGroup.pendingResent', { count: invite.resendCount }) : t('manageGroup.pendingLabel')}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => handleResendInvite(invite.email, invite.id)}
                          disabled={resendingInviteId === invite.id}
                          className="px-3 h-8 rounded-lg text-[11px] font-bold text-primary border border-primary/30 hover:bg-primary/5 transition-all disabled:opacity-50 flex items-center gap-1"
                        >
                          <span className={clsx("material-symbols-outlined text-[14px]", resendingInviteId === invite.id && "animate-spin")}>
                            {resendingInviteId === invite.id ? 'sync' : 'refresh'}
                          </span>
                          {t('manageGroup.resend')}
                        </button>
                        <button
                          onClick={() => handleCancelInvite(invite.id)}
                          className="w-8 h-8 rounded-lg text-error hover:bg-error/5 transition-all flex items-center justify-center"
                          title={t('manageGroup.cancelInvite')}
                        >
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Group leaderboard — friends-scoped ranking lives on My Progress; this is the same idea
            scoped to just this group's roster, using the same server endpoint with a different
            `scope` param. */}
        <section className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2">
          <button
            onClick={() => setShowGroupLeaderboard((v) => !v)}
            className="w-full flex items-center justify-between text-sm font-bold text-primary"
          >
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[18px]">leaderboard</span>
              {t('manageGroup.groupLeaderboard')}
            </span>
            <span className="material-symbols-outlined text-[18px] text-text-muted">{showGroupLeaderboard ? 'expand_less' : 'expand_more'}</span>
          </button>
          {showGroupLeaderboard && (
            <div className="pt-1 space-y-1.5">
              {loadingGroupLeaderboard && <p className="text-xs text-text-muted italic text-center py-3">{t('common.loading')}</p>}
              {!loadingGroupLeaderboard && groupLeaderboard.map((entry, idx) => {
                const isMe = entry.uid === user?.uid;
                const podiumIcon = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null;
                return (
                  <div
                    key={entry.uid}
                    onClick={() => !isMe && navigate(`/u/${entry.uid}`)}
                    className={clsx('flex items-center gap-2.5 p-2 rounded-xl', isMe ? 'bg-primary/5' : 'bg-surface/40 cursor-pointer')}
                  >
                    <span className={clsx('w-6 text-center shrink-0', podiumIcon ? 'text-sm' : 'text-[10px] font-bold text-text-muted')}>{podiumIcon || idx + 1}</span>
                    <p className="flex-1 min-w-0 text-xs font-bold text-on-surface truncate">{isMe ? t('progress.you') : entry.displayName}</p>
                    <span className="text-[11px] font-black text-primary shrink-0">{entry.xp} XP</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Members List */}
        <section className="space-y-4">
          <div className="flex justify-between items-center px-1">
            <h3 className="text-xl font-bold text-primary">{t('manageGroup.members')}</h3>
            <span className="bg-success/10 text-success text-[11px] font-bold px-3 py-1 rounded-full uppercase">{t('manageGroup.activeCount', { count: members.length })}</span>
          </div>
          {members.length > 1 && (
            <button
              onClick={handlePokeAll}
              disabled={pokingAll}
              className={clsx(
                "w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-50",
                pokedAll ? "bg-success/10 text-success" : "bg-primary/5 text-primary hover:bg-primary/10 border border-primary/10"
              )}
            >
              <span className="material-symbols-outlined text-[16px]">
                {pokingAll ? 'sync' : pokedAll ? 'check' : 'back_hand'}
              </span>
              {pokedAll ? t('manageGroup.everyonePoked') : pokingAll ? t('manageGroup.poking') : t('manageGroup.pokeAll')}
            </button>
          )}
          <div className="space-y-3">
            {members.map((member: any) => (
              <div key={member.id} className="bg-white p-4 rounded-2xl border border-border-subtle flex items-center justify-between shadow-sm group">
                <div
                  className={clsx("flex items-center gap-3", member.userId !== user?.uid && "cursor-pointer")}
                  onClick={() => member.userId !== user?.uid && navigate(`/u/${member.userId}`)}
                >
                  <div className="relative">
                    <img src={member.photoURL || `https://ui-avatars.com/api/?name=${member.displayName}`} className="w-12 h-12 rounded-full border border-border-subtle" alt={member.displayName} />
                    {member.role === 'owner' && (
                      <div className="absolute -bottom-1 -right-1 bg-primary text-white p-0.5 rounded-full border-2 border-white scale-75">
                        <span className="material-symbols-outlined text-[14px]">verified_user</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="font-bold text-primary">{member.displayName} {member.userId === user?.uid && t('manageGroup.youSuffix')}</p>
                    <p className="text-xs text-text-muted capitalize">{t(member.role === 'owner' ? 'manageGroup.roleOwner' : member.role === 'admin' ? 'manageGroup.roleAdmin' : 'manageGroup.roleMember')} {member.userId === group.createdBy && t('manageGroup.creatorSuffix')}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {member.userId !== user?.uid && (
                    <button
                      onClick={() => handlePoke(member.userId)}
                      disabled={pokingUserId === member.userId}
                      title={t('manageGroup.pokeTitle', { name: member.displayName })}
                      className={clsx(
                        "text-[10px] font-bold px-2 py-1.5 rounded-lg uppercase flex items-center gap-1 transition-all disabled:opacity-50",
                        pokedUserId === member.userId
                          ? "bg-success/10 text-success"
                          : "bg-primary/5 text-primary hover:bg-primary/10"
                      )}
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {pokingUserId === member.userId ? 'sync' : pokedUserId === member.userId ? 'check' : 'back_hand'}
                      </span>
                      {pokedUserId === member.userId ? t('manageGroup.poked') : t('manageGroup.poke')}
                    </button>
                  )}
                  {isAdminOrOwner && member.userId !== user?.uid && member.role !== 'owner' && (
                    <div className="flex items-center gap-1">
                      {member.role === 'admin' ? (
                        <button
                          onClick={() => updateMemberRole(member.id, 'member')}
                          className="text-[10px] font-bold text-primary border border-primary px-2 py-1 rounded-lg uppercase hover:bg-primary/5"
                          title={t('manageGroup.demoteTitle')}
                        >
                          {t('manageGroup.roleAdmin')}
                        </button>
                      ) : (
                        <button
                          onClick={() => updateMemberRole(member.id, 'admin', member.userId)}
                          className="text-[10px] font-bold text-text-muted border border-border-subtle px-2 py-1 rounded-lg uppercase hover:bg-surface transition-colors"
                          title={t('manageGroup.promoteTitle')}
                        >
                          {t('manageGroup.makeAdmin')}
                        </button>
                      )}
                    </div>
                  )}

                  {isCreator && member.userId !== user?.uid && (
                    <button
                      onClick={() => handleRemoveMember(member.id, member.displayName)}
                      className="text-error hover:scale-110 transition-all p-1"
                      title={t('manageGroup.removeFromGroup')}
                    >
                      <span className="material-symbols-outlined text-lg">person_remove</span>
                    </button>
                  )}
                  {member.role === 'owner' && (
                    <span className="text-[10px] font-bold text-primary border border-primary/20 px-2 py-1 rounded-lg uppercase">{t('manageGroup.roleOwner')}</span>
                  )}
                  {!isAdminOrOwner && member.userId !== user?.uid && member.role === 'admin' && (
                    <span className="text-[10px] font-bold text-primary border border-primary/20 px-2 py-1 rounded-lg uppercase">{t('manageGroup.roleAdmin')}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Danger Zone */}
        {isCreator && (
          <section className="pt-4 border-t border-error/10 pb-20">
            <div className="bg-error/5 border border-error/10 h-14 px-4 rounded-xl flex items-center justify-between gap-3 shadow-sm">
              <div className="flex items-center gap-2.5 overflow-hidden">
                <div className="w-8 h-8 rounded-full bg-error/10 flex items-center justify-center text-error flex-shrink-0">
                  <span className="material-symbols-outlined text-[18px]">warning</span>
                </div>
                <div className="truncate">
                  <p className="font-bold text-error text-[13px] truncate">{t('manageGroup.deleteGroup')}</p>
                  <p className="text-[9px] text-text-muted uppercase font-bold tracking-tight truncate">{t('manageGroup.permanentAction')}</p>
                </div>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={loading}
                className={clsx(
                  "px-4 h-9 border border-error/50 text-error bg-error/5 rounded-lg flex items-center gap-2 transition-all active:scale-95 text-xs font-bold flex-shrink-0",
                  loading ? "opacity-50 cursor-not-allowed" : "hover:bg-error hover:text-white"
                )}
              >
                <span className="material-symbols-outlined text-[18px]">{loading ? 'sync' : 'delete'}</span>
                <span>{loading ? t('manageGroup.deleting') : t('manageGroup.deleteGroup')}</span>
              </button>
            </div>
          </section>
        )}

        {!isCreator && !!currentMember && (
          <section className="pt-4 border-t border-error/10 pb-20">
            <div className="bg-error/5 border border-error/10 h-14 px-4 rounded-xl flex items-center justify-between gap-3 shadow-sm">
              <div className="flex items-center gap-2.5 overflow-hidden">
                <div className="w-8 h-8 rounded-full bg-error/10 flex items-center justify-center text-error flex-shrink-0">
                  <span className="material-symbols-outlined text-[18px]">logout</span>
                </div>
                <div className="truncate">
                  <p className="font-bold text-error text-[13px] truncate">{t('manageGroup.leaveGroup')}</p>
                  <p className="text-[9px] text-text-muted uppercase font-bold tracking-tight truncate">{t('manageGroup.needNewInvite')}</p>
                </div>
              </div>
              <button
                onClick={handleLeaveGroup}
                className="px-4 h-9 border border-error/50 text-error bg-error/5 rounded-lg flex items-center gap-2 transition-all active:scale-95 text-xs font-bold flex-shrink-0 hover:bg-error hover:text-white"
              >
                <span className="material-symbols-outlined text-[18px]">logout</span>
                <span>{t('manageGroup.leaveGroup')}</span>
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
