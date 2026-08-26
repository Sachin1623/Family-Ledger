import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { searchFeatures, SearchableFeature } from '../lib/searchIndex';
import { useFriendships } from '../lib/useFriendships';
import { EXPENSE_CATEGORIES, getCurrencySymbol } from '../lib/constants';
import { parseLocalDate } from '../lib/dateUtils';
import { useLanguage } from '../context/LanguageContext';

interface GroupComment {
  id: string;
  groupId: string;
  text: string;
  displayName?: string;
  createdAt?: string;
}

// Header search: results are split into four independent sources —
// 1. "Features" (searchFeatures) is a static, always-instant match against app screens/tools.
// 2. "Groups" matches group names, from the already-fetched `groups` list.
// 3. "Expenses" is a live Firestore query across every group the user belongs to, filtered
//    client-side by description/category substring (Firestore has no full-text "contains"
//    query, and this app's scale makes a client-side filter over already-cached data fine —
//    same tradeoff already made for e.g. ToDoList's/RecurringExpenses' cross-group queries).
// 4. "Comments" covers each group's own discussion thread (Comments.tsx's
//    groups/{groupId}/comments — not per-expense comments, which would need either a
//    collectionGroup query the current firestore.rules can't prove for an unfiltered `list`, or
//    a per-expense fan-out far larger than the per-group one below). Fetched once per search
//    session with a plain `getDocs` fan-out (one read per group) rather than a live listener,
//    since comments don't need to update in real time inside a transient search modal.
// The expenses/groups queries are only mounted while the search is open (see the `isOpen &&`
// gate below), so nothing runs as a background listener while the search modal is closed.
export default function GlobalSearch({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { user, admin } = useAuth();
  const { t } = useLanguage();
  const [queryText, setQueryText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQueryText('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const [membershipsValue] = useCollection(
    isOpen && user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    isOpen && groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [expensesValue] = useCollection(
    isOpen && groupIds.length > 0 ? query(collection(db, 'expenses'), where('groupId', 'in', groupIds)) : null,
  );

  // Every co-member across every group the user's in, deduped by uid — same query shape as
  // Dashboard's "Group Members" presence list.
  const [allMembersValue] = useCollection(
    isOpen && groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const members = useMemo(() => {
    const byUid = new Map<string, any>();
    allMembersValue?.docs.forEach((d) => {
      const m = d.data() as any;
      if (m.userId === user?.uid || byUid.has(m.userId)) return;
      byUid.set(m.userId, m);
    });
    return Array.from(byUid.values());
  }, [allMembersValue, user?.uid]);

  const [groupComments, setGroupComments] = useState<GroupComment[]>([]);
  const groupIdsKey = groupIds.join(',');
  useEffect(() => {
    if (!isOpen || !groupIdsKey) {
      setGroupComments([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      groupIdsKey.split(',').map((gid) =>
        getDocs(collection(db, 'groups', gid, 'comments')).then((snap) =>
          snap.docs.map((d) => ({ id: d.id, groupId: gid, ...d.data() } as GroupComment)),
        ),
      ),
    )
      .then((perGroup) => {
        if (!cancelled) setGroupComments(perGroup.flat());
      })
      .catch((err) => console.error('GlobalSearch: failed to fetch group comments:', err));
    return () => {
      cancelled = true;
    };
  }, [isOpen, groupIdsKey]);

  const featureResults = useMemo(() => searchFeatures(queryText, admin.isAdmin), [queryText, admin.isAdmin]);

  const groupResults = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return [];
    return groups.filter((g: any) => (g.name || '').toLowerCase().includes(q)).slice(0, 8);
  }, [queryText, groups]);

  const memberResults = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return [];
    return members.filter((m: any) => (m.displayName || '').toLowerCase().includes(q)).slice(0, 8);
  }, [queryText, members]);

  // Accepted friends may not share any group with the caller at all, so this is a separate
  // source from memberResults above (which is scoped to group co-members) — distinct sections in
  // the UI so it's clear which is which. Only queries while the search modal is open.
  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(isOpen ? user?.uid : undefined);
  const friendResults = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return [];
    return acceptedFriends
      .map(({ friendUid }) => friendUsersByUid.get(friendUid))
      .filter((u): u is { uid: string; displayName: string; photoURL: string } => !!u && (u.displayName || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [queryText, acceptedFriends, friendUsersByUid]);

  const commentResults = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return [];
    return groupComments
      .filter((c) => (c.text || '').toLowerCase().includes(q))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 8);
  }, [queryText, groupComments]);

  const expenseResults = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q || !expensesValue) return [];
    return expensesValue.docs
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .filter((e) => (e.description || '').toLowerCase().includes(q) || (e.category || '').toLowerCase().includes(q))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 8);
  }, [queryText, expensesValue]);

  const handleFeatureClick = (feature: SearchableFeature) => {
    navigate(feature.route);
    onClose();
  };

  const handleExpenseClick = (groupId: string) => {
    navigate(`/groups/${groupId}/expenses`);
    onClose();
  };

  const handleGroupClick = (groupId: string) => {
    navigate(`/groups/${groupId}`);
    onClose();
  };

  const handleMemberClick = (uid: string) => {
    navigate(`/?dm=${uid}`);
    onClose();
  };

  const handleFriendClick = (uid: string) => {
    navigate(`/u/${uid}`);
    onClose();
  };

  const handleCommentClick = (groupId: string) => {
    navigate(`/groups/${groupId}`);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[300] bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 pt-16 sm:pt-24">
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-3 border-b border-border-subtle shrink-0">
          <span className="material-symbols-outlined text-text-muted">search</span>
          <input
            ref={inputRef}
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder={t('search.placeholder')}
            className="flex-1 outline-none text-sm bg-transparent"
          />
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-surface-container text-text-muted">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {!queryText.trim() && (
            <p className="text-xs text-text-muted text-center py-10 px-6">
              {t('search.helpText')}
            </p>
          )}

          {queryText.trim() &&
            featureResults.length === 0 &&
            groupResults.length === 0 &&
            friendResults.length === 0 &&
            memberResults.length === 0 &&
            expenseResults.length === 0 &&
            commentResults.length === 0 && (
              <p className="text-xs text-text-muted text-center py-10 px-6">{t('search.noMatches', { query: queryText })}</p>
            )}

          {featureResults.length > 0 && (
            <div className="py-2">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-4 py-1">{t('search.sectionFeatures')}</p>
              {featureResults.map((f) => (
                <button
                  key={f.id}
                  onClick={() => handleFeatureClick(f)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container/40 text-left transition-colors"
                >
                  <div className="w-9 h-9 rounded-xl bg-primary/5 flex items-center justify-center text-primary shrink-0">
                    <span className="material-symbols-outlined text-[18px]">{f.icon}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{f.labelKey ? t(f.labelKey) : f.label}</p>
                    <p className="text-[11px] text-text-muted truncate">{f.descriptionKey ? t(f.descriptionKey) : f.description}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {groupResults.length > 0 && (
            <div className="py-2 border-t border-border-subtle">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-4 py-1">{t('search.sectionGroups')}</p>
              {groupResults.map((g: any) => (
                <button
                  key={g.id}
                  onClick={() => handleGroupClick(g.id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container/40 text-left transition-colors"
                >
                  <div className="w-9 h-9 rounded-xl bg-primary/5 flex items-center justify-center text-primary shrink-0 overflow-hidden">
                    {g.photoURL ? (
                      <img src={g.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="material-symbols-outlined text-[18px]">{g.icon || 'group'}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{g.name}</p>
                    <p className="text-[11px] text-text-muted truncate">{t('search.groupLabel')}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {friendResults.length > 0 && (
            <div className="py-2 border-t border-border-subtle">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-4 py-1">{t('search.sectionFriends')}</p>
              {friendResults.map((f) => (
                <button
                  key={f.uid}
                  onClick={() => handleFriendClick(f.uid)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container/40 text-left transition-colors"
                >
                  <div className="w-9 h-9 rounded-full bg-primary/5 flex items-center justify-center text-primary shrink-0 overflow-hidden">
                    {f.photoURL ? (
                      <img src={f.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="text-xs font-bold">{f.displayName?.slice(0, 1) || '?'}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{f.displayName}</p>
                    <p className="text-[11px] text-text-muted truncate">{t('search.sectionFriends')}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {memberResults.length > 0 && (
            <div className="py-2 border-t border-border-subtle">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-4 py-1">{t('search.sectionPeople')}</p>
              {memberResults.map((m: any) => (
                <button
                  key={m.userId}
                  onClick={() => handleMemberClick(m.userId)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container/40 text-left transition-colors"
                >
                  <div className="w-9 h-9 rounded-full bg-primary/5 flex items-center justify-center text-primary shrink-0 overflow-hidden">
                    {m.photoURL ? (
                      <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="text-xs font-bold">{m.displayName?.slice(0, 1) || '?'}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{m.displayName}</p>
                    <p className="text-[11px] text-text-muted truncate">{t('search.messageLabel')}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {expenseResults.length > 0 && (
            <div className="py-2 border-t border-border-subtle">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-4 py-1">{t('search.sectionExpenses')}</p>
              {expenseResults.map((e) => {
                const group = groups.find((g: any) => g.id === e.groupId);
                const catInfo = EXPENSE_CATEGORIES.find((c) => c.id === e.category);
                return (
                  <button
                    key={e.id}
                    onClick={() => handleExpenseClick(e.groupId)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container/40 text-left transition-colors"
                  >
                    <div className="w-9 h-9 rounded-xl bg-primary/5 flex items-center justify-center text-primary shrink-0">
                      <span className="text-base">{catInfo?.icon || '🧾'}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-on-surface truncate">{e.description || (catInfo ? t(`category.${catInfo.id}`) : t('search.expenseFallback'))}</p>
                      <p className="text-[11px] text-text-muted truncate">
                        {group?.name || t('search.unknownGroup')} · {e.date ? parseLocalDate(e.date).toLocaleDateString() : ''}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-primary shrink-0">
                      {getCurrencySymbol(group?.currency)}{Number(e.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {commentResults.length > 0 && (
            <div className="py-2 border-t border-border-subtle">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-4 py-1">{t('search.sectionComments')}</p>
              {commentResults.map((c) => {
                const group = groups.find((g: any) => g.id === c.groupId);
                return (
                  <button
                    key={c.id}
                    onClick={() => handleCommentClick(c.groupId)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container/40 text-left transition-colors"
                  >
                    <div className="w-9 h-9 rounded-xl bg-primary/5 flex items-center justify-center text-primary shrink-0">
                      <span className="material-symbols-outlined text-[18px]">forum</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-on-surface truncate">{c.text}</p>
                      <p className="text-[11px] text-text-muted truncate">
                        {group?.name || t('search.unknownGroup')}{c.displayName ? ` · ${c.displayName}` : ''}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
