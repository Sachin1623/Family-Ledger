import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { inviteToGroup, inviteUserToGroup, searchUsers, FoundUser } from '../lib/inviteApi';
import { claimPoints } from '../lib/pointsApi';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { evaluateAmountSum } from '../lib/amountMath';
import { currentLocalMonthKey } from '../lib/dateUtils';
import { updateGlobalStats } from '../services/statsService';
import { useLanguage } from '../context/LanguageContext';

type SubPanel = null | 'addMembers' | 'budget' | 'exitDelete';

interface Props {
  groupId: string;
  group: any;
  members: any[];
  budget: any;
  onClose: () => void;
}

function MenuRow({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl hover:bg-surface-container transition-colors text-left',
        danger ? 'text-error' : 'text-on-surface',
      )}
    >
      <span className="material-symbols-outlined text-[22px] shrink-0">{icon}</span>
      <span className="font-bold text-sm">{label}</span>
    </button>
  );
}

function ToggleRow({
  icon,
  label,
  checked,
  busy,
  onToggle,
}: {
  icon: string;
  label: string;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="w-full flex items-center gap-3 px-4 py-3.5">
      <span className="material-symbols-outlined text-[22px] shrink-0 text-on-surface">{icon}</span>
      <span className="font-bold text-sm text-on-surface flex-1">{label}</span>
      <button
        onClick={onToggle}
        disabled={busy}
        className={clsx(
          'w-11 h-6 rounded-full transition-all relative shrink-0 disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-border-subtle',
        )}
      >
        <div className={clsx('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', checked ? 'left-6' : 'left-1')} />
      </button>
    </div>
  );
}

// Quick-access replacement for the old gear icon on each dashboard group tile — a single sheet
// covering the seven most common group actions without leaving the dashboard. Toggle-style
// actions (group type, split, income) fire immediately from inline switches; the rest swap the
// sheet's content to a dedicated sub-panel (back arrow returns to the main list). Reuses the
// exact same Firestore writes/side-effects (claimPoints, notifyGroupActivity, activity logging)
// as ManageGroup.tsx's equivalents, kept separate rather than shared so that screen — explicitly
// meant to stay untouched — can't be affected by changes made here.
export default function GroupQuickActionsMenu({ groupId, group, members, budget, onClose }: Props) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [subPanel, setSubPanel] = useState<SubPanel>(null);

  const currentMember = members.find((m: any) => m.userId === user?.uid);
  const isCreator = !!user?.uid && group?.createdBy === user.uid;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // --- Inline toggles ---
  const [togglingType, setTogglingType] = useState(false);
  const [togglingSplit, setTogglingSplit] = useState(false);
  const [togglingIncome, setTogglingIncome] = useState(false);

  const handleToggleType = async () => {
    setTogglingType(true);
    try {
      await updateDoc(doc(db, 'groups', groupId), { groupType: group?.groupType === 'event' ? 'regular' : 'event' });
    } catch (err) {
      console.error('Toggle group type error:', err);
    } finally {
      setTogglingType(false);
    }
  };

  const handleToggleSplit = async () => {
    setTogglingSplit(true);
    try {
      await updateDoc(doc(db, 'groups', groupId), { splitEnabled: !group?.splitEnabled });
    } catch (err) {
      console.error('Toggle split error:', err);
    } finally {
      setTogglingSplit(false);
    }
  };

  const handleToggleIncome = async () => {
    setTogglingIncome(true);
    try {
      await updateDoc(doc(db, 'groups', groupId), { incomeEnabled: !group?.incomeEnabled });
    } catch (err) {
      console.error('Toggle income error:', err);
    } finally {
      setTogglingIncome(false);
    }
  };

  // --- Add Members sub-panel ---
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteFeedback, setInviteFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState<FoundUser[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [invitingUid, setInvitingUid] = useState<string | null>(null);
  const [invitedUids, setInvitedUids] = useState<Set<string>>(new Set());

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

  const handleWhatsAppShare = () => {
    const link = `${window.location.origin}/join/${groupId}`;
    const inviterName = profile?.displayName || user?.displayName || 'A friend';
    const message = `Hi! ${inviterName} is inviting you to join the group "${group?.name}" on FamilyLedger. Join here: ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleEmailInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
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
    } catch (err) {
      setInviteFeedback({ type: 'error', text: err instanceof Error ? err.message : t('manageGroup.failedToSendInvite') });
    } finally {
      setInviting(false);
    }
  };

  const handleInviteFoundUser = async (foundUser: FoundUser) => {
    setInvitingUid(foundUser.uid);
    try {
      const result = await inviteUserToGroup(groupId, foundUser.uid);
      if (result.method === 'already_member') {
        setInviteFeedback({ type: 'error', text: t('manageGroup.alreadyInGroup', { name: foundUser.displayName }) });
      } else {
        setInvitedUids((prev) => new Set(prev).add(foundUser.uid));
        setInviteFeedback({ type: 'success', text: t('manageGroup.userNotified', { name: foundUser.displayName }) });
      }
    } catch (err) {
      setInviteFeedback({ type: 'error', text: err instanceof Error ? err.message : t('manageGroup.failedToSendInvite') });
    } finally {
      setInvitingUid(null);
    }
  };

  // --- Budget sub-panel ---
  const monthKey = currentLocalMonthKey();
  const budgetDocId = `${groupId}_${monthKey}`;
  const [budgetInput, setBudgetInput] = useState(budget?.amount ? String(budget.amount) : '');
  const [savingBudget, setSavingBudget] = useState(false);

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedBudget = evaluateAmountSum(budgetInput);
    if (!parsedBudget || parsedBudget <= 0 || !user) return;
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
      onClose();
    } catch (err) {
      console.error('Failed to save budget:', err);
      alert(t('manageGroup.failedToSaveBudget'));
    } finally {
      setSavingBudget(false);
    }
  };

  // --- Exit / Delete sub-panel ---
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleLeaveGroup = async () => {
    if (!currentMember || !user) return;
    setLeaving(true);
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
      notifyGroupActivity({ groupId, action: 'member_left', actorName });
      navigate('/');
    } catch (err) {
      console.error('Leave group error:', err);
      alert(t('manageGroup.failedToLeaveGroup'));
      setLeaving(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!user) return;
    setDeleting(true);
    try {
      try {
        await addDoc(collection(db, 'activities'), {
          userId: user.uid,
          type: 'group_deleted',
          personal: true,
          description: `You permanently deleted the group "${group?.name}".`,
          groupName: group?.name,
          createdAt: new Date().toISOString(),
        });
      } catch (actErr) {
        console.error('Failed to log delete activity:', actErr);
      }

      const expensesSnapshot = await getDocs(query(collection(db, 'expenses'), where('groupId', '==', groupId)));
      let totalExpenseAmount = 0;
      expensesSnapshot.forEach((d) => { totalExpenseAmount += d.data().amount || 0; });
      const expenseBatch = writeBatch(db);
      expensesSnapshot.forEach((d) => expenseBatch.delete(d.ref));
      await expenseBatch.commit();

      await updateGlobalStats({ groups: -1, expenses: -expensesSnapshot.size, amount: -totalExpenseAmount });

      await Promise.all(members.map(async (m: any) => {
        try {
          await deleteDoc(doc(db, 'members', m.id));
        } catch (memErr) {
          console.error('Failed to delete member doc:', m.id, memErr);
        }
      }));

      await deleteDoc(doc(db, 'groups', groupId));
      navigate('/');
    } catch (err: any) {
      console.error('Delete group error:', err);
      alert(err?.code === 'permission-denied' ? t('manageGroup.accessDeniedDelete') : t('manageGroup.failedToDeleteGroup', { message: err?.message || 'Unknown error' }));
      setDeleting(false);
    }
  };

  const title =
    subPanel === 'addMembers' ? 'Add Members' :
    subPanel === 'budget' ? (budget ? 'Edit Budget' : 'Set Budget') :
    subPanel === 'exitDelete' ? (isCreator ? 'Delete Group' : 'Exit Group') :
    (group?.name || '');

  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        onClick={stop}
        className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-2 py-2 border-b border-border-subtle sticky top-0 bg-white z-10">
          {subPanel ? (
            <button onClick={() => setSubPanel(null)} className="p-2 text-text-muted hover:bg-surface rounded-full">
              <span className="material-symbols-outlined text-[20px] block">arrow_back</span>
            </button>
          ) : <span className="w-9" />}
          <h3 className="font-black text-primary text-sm truncate px-2">{title}</h3>
          <button onClick={onClose} className="p-2 text-text-muted hover:bg-surface rounded-full">
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>

        <div className="p-2">
          {subPanel === null && (
            <div className="space-y-0.5">
              <MenuRow icon="person_add" label="Add Members" onClick={() => setSubPanel('addMembers')} />
              <ToggleRow icon="event" label="One-off Event" checked={group?.groupType === 'event'} busy={togglingType} onToggle={handleToggleType} />
              <ToggleRow icon="call_split" label="Split Expenses" checked={!!group?.splitEnabled} busy={togglingSplit} onToggle={handleToggleSplit} />
              <ToggleRow icon="payments" label="Track Income" checked={!!group?.incomeEnabled} busy={togglingIncome} onToggle={handleToggleIncome} />
              <MenuRow icon="account_balance_wallet" label={budget ? 'Edit Budget' : 'Set Budget'} onClick={() => setSubPanel('budget')} />
              <MenuRow
                icon={isCreator ? 'delete_forever' : 'logout'}
                label={isCreator ? 'Delete Group' : 'Exit Group'}
                danger
                onClick={() => setSubPanel('exitDelete')}
              />
              <div className="h-px bg-border-subtle my-1 mx-2" />
              <MenuRow icon="settings" label="Manage Group" onClick={() => { onClose(); navigate(`/groups/${groupId}/manage?from=dashboard`); }} />
            </div>
          )}

          {subPanel === 'addMembers' && (
            <div className="p-2 space-y-4">
              <button
                onClick={handleWhatsAppShare}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border border-border-subtle hover:bg-surface-container transition-colors text-left"
              >
                <span className="text-[22px] leading-none shrink-0">💬</span>
                <span className="font-bold text-sm text-on-surface">Share via WhatsApp</span>
              </button>

              <form onSubmit={handleEmailInvite} className="space-y-2">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">mail</span>
                  Invite by Email
                </label>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="flex-1 bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <button
                    type="submit"
                    disabled={inviting || !inviteEmail.trim()}
                    className="px-4 bg-primary text-white font-bold rounded-xl disabled:opacity-50 shrink-0"
                  >
                    {inviting ? '…' : 'Send'}
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">person_search</span>
                  {t('manageGroup.searchUsersLabel')}
                </label>
                <input
                  type="text"
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                  placeholder={t('manageGroup.searchUsersPlaceholder')}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
                {searchingUsers && <p className="text-xs text-text-muted px-1">Searching…</p>}
                {userSearchResults.length > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {userSearchResults.map((u) => (
                      <div key={u.uid} className="flex items-center gap-2 p-2 rounded-xl bg-surface-container/50">
                        <div className="w-8 h-8 rounded-full overflow-hidden bg-primary/10 shrink-0 flex items-center justify-center">
                          {u.photoURL ? (
                            <img src={u.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="text-xs font-bold text-primary">{u.displayName?.slice(0, 1)}</span>
                          )}
                        </div>
                        <span className="text-sm font-bold text-on-surface truncate flex-1">{u.displayName}</span>
                        <button
                          onClick={() => handleInviteFoundUser(u)}
                          disabled={invitingUid === u.uid || invitedUids.has(u.uid)}
                          className="text-xs font-bold text-primary px-3 py-1.5 rounded-lg bg-primary/10 disabled:opacity-50 shrink-0"
                        >
                          {invitedUids.has(u.uid) ? 'Invited' : invitingUid === u.uid ? '…' : 'Invite'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {inviteFeedback && (
                <div className={clsx(
                  'p-3 text-sm rounded-xl border',
                  inviteFeedback.type === 'success' ? 'bg-success/10 text-success border-success/20' : 'bg-red-50 text-red-700 border-red-200',
                )}>
                  {inviteFeedback.text}
                </div>
              )}
            </div>
          )}

          {subPanel === 'budget' && (
            <form onSubmit={handleSaveBudget} className="p-2 space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Monthly Budget Amount</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  placeholder="e.g. 20000"
                  autoFocus
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <button
                type="submit"
                disabled={savingBudget || !budgetInput.trim()}
                className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
              >
                {savingBudget ? 'Saving…' : 'Save Budget'}
              </button>
            </form>
          )}

          {subPanel === 'exitDelete' && (
            <div className="p-2 space-y-4">
              <div className="w-14 h-14 bg-error/10 rounded-2xl flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-error text-3xl">warning</span>
              </div>
              <p className="text-sm text-text-muted text-center leading-relaxed px-2">
                {isCreator
                  ? t('manageGroup.deleteGroupWarning', { name: group?.name })
                  : t('manageGroup.confirmLeaveGroup', { name: group?.name })}
              </p>
              <button
                onClick={isCreator ? handleDeleteGroup : handleLeaveGroup}
                disabled={isCreator ? deleting : leaving}
                className="w-full bg-error text-white py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 hover:opacity-90 active:scale-95 transition-all disabled:opacity-50"
              >
                {(isCreator ? deleting : leaving) ? (
                  <span className="material-symbols-outlined animate-spin">sync</span>
                ) : (
                  <span className="material-symbols-outlined">{isCreator ? 'delete_forever' : 'logout'}</span>
                )}
                {isCreator ? 'Delete Group' : 'Exit Group'}
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
