import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, documentId, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useAllGroupMembers } from '../lib/useAllGroupMembers';
import { useFriendships } from '../lib/useFriendships';
import { useDmChats } from '../lib/useDmChats';
import { isPresenceOnline, lastSeenLabel } from '../lib/presence';
import { useLanguage } from '../context/LanguageContext';
import { searchUsers, FoundUser } from '../lib/inviteApi';
import { groupIconEmoji } from '../lib/groupIcons';

// Every co-member across every group the user belongs to, in one place, each row a 1-tap DM —
// the Tools-page replacement for the presence dropdown that used to sit on top of Dashboard.
export default function MembersChat() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const myGroupIds = useMemo(() => membershipsValue?.docs.map((d) => d.data().groupId) || [], [membershipsValue]);
  const { sortedMembers, presenceByUid } = useAllGroupMembers(myGroupIds, user?.uid);
  // The groups themselves, for the Groups tab (each opens that group's chat).
  const [groupsValue] = useCollection(myGroupIds.length > 0 ? query(collection(db, 'groups'), where(documentId(), 'in', myGroupIds.slice(0, 30))) : null);
  const myGroups = useMemo(() => (groupsValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })).filter((g: any) => !g.archived), [groupsValue]);
  const [tab, setTab] = useState<'all' | 'groups' | 'people'>('all');
  const { accepted: acceptedFriends, usersByUid: friendsByUid } = useFriendships(user?.uid);
  const { chatByOtherUid } = useDmChats(user?.uid);

  // Accepted friends who don't already share a group (and so wouldn't otherwise appear here at
  // all) get merged in — a co-member's row still wins on dedup since it already carries live
  // group-membership data this hook doesn't have for a friend-only contact.
  const allChattable = useMemo(() => {
    const byUid = new Map<string, any>();
    sortedMembers.forEach((m: any) => byUid.set(m.userId, m));
    acceptedFriends.forEach(({ friendUid }) => {
      if (byUid.has(friendUid)) return;
      const f = friendsByUid.get(friendUid);
      byUid.set(friendUid, { userId: friendUid, displayName: f?.displayName || 'Someone', photoURL: f?.photoURL || '' });
    });
    return Array.from(byUid.values());
  }, [sortedMembers, acceptedFriends, friendsByUid]);

  // Members with an existing DM get sorted to the top by most-recent message; everyone else
  // (never messaged) follows, ordered by their own last-active time — overrides the hook's
  // default online-first/alphabetical order above.
  const orderedMembers = useMemo(() => {
    return [...allChattable].sort((a: any, b: any) => {
      const chatA = chatByOtherUid.get(a.userId);
      const chatB = chatByOtherUid.get(b.userId);
      if (chatA && chatB) return (chatB.lastMessageAt || '').localeCompare(chatA.lastMessageAt || '');
      if (chatA || chatB) return chatA ? -1 : 1;
      const activeA = presenceByUid.get(a.userId)?.lastActiveAt || '';
      const activeB = presenceByUid.get(b.userId)?.lastActiveAt || '';
      return activeB.localeCompare(activeA);
    });
  }, [allChattable, chatByOtherUid, presenceByUid]);

  const openChat = (uid: string) => navigate(`/?dm=${uid}`);

  // Search: filters the co-member/friend list already on screen by name, and — once the query is
  // specific enough (2+ chars) — also looks up the wider FamilyLedger user directory via the same
  // /api/search-users endpoint Friends.tsx uses, so a chat can be started with someone who isn't
  // yet a co-member or accepted friend (DMs have no such restriction in firestore.rules — being
  // one of the two halves of the chat id is the only membership check).
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FoundUser[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      searchUsers(q)
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const trimmedQuery = searchQuery.trim();
  const filteredMembers = trimmedQuery
    ? orderedMembers.filter((m: any) => m.displayName?.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : orderedMembers;
  const knownUids = useMemo(() => new Set(allChattable.map((m: any) => m.userId)), [allChattable]);
  const otherResults = trimmedQuery.length >= 2 ? searchResults.filter((u) => u.uid !== user?.uid && !knownUids.has(u.uid)) : [];



  // ── Inbox look ──────────────────────────────────────────────────────────────────────────────────
  const COLORS = ['#16a085', '#2b7bd6', '#c2410c', '#7c3aed', '#be185d', '#0891b2', '#65a30d'];
  const colorFor = (key: string) => COLORS[Math.abs([...key].reduce((a, c) => a + c.charCodeAt(0), 0)) % COLORS.length];
  const timeLabel = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (days < 2) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const activeNow = orderedMembers.filter((m: any) => isPresenceOnline(presenceByUid.get(m.userId))).slice(0, 12);
  const showGroups = tab !== 'people' && !trimmedQuery;
  const groupRows = showGroups ? myGroups : trimmedQuery ? myGroups.filter((g: any) => g.name?.toLowerCase().includes(trimmedQuery.toLowerCase())) : [];
  const peopleWithChat = filteredMembers.filter((m: any) => chatByOtherUid.get(m.userId));
  const peopleWithoutChat = filteredMembers.filter((m: any) => !chatByOtherUid.get(m.userId));
  const peopleRows = tab === 'groups' ? [] : tab === 'people' ? filteredMembers : [...peopleWithChat, ...peopleWithoutChat];
  const showGroupsBlock = tab !== 'people' && groupRows.length > 0;

  const personRow = (m: any) => {
    const presence = presenceByUid.get(m.userId);
    const online = isPresenceOnline(presence);
    const chat = chatByOtherUid.get(m.userId);
    const unread = chat?.unreadFor?.[user?.uid || ''] || 0;
    const preview = chat?.lastMessageText ? `${chat.lastMessageBy === user?.uid ? 'You: ' : ''}${chat.lastMessageText}` : online ? t('chat.online') : t('chat.lastSeen', { time: lastSeenLabel(presence) });
    return (
      <div key={m.userId} onClick={() => openChat(m.userId)} className="flex items-center gap-3 px-1 py-2.5 border-b border-slate-100 cursor-pointer active:bg-slate-50">
        <div className="relative shrink-0">
          <div className="w-12 h-12 rounded-full overflow-hidden flex items-center justify-center text-white text-base font-black" style={{ backgroundColor: colorFor(m.userId) }}>
            {m.photoURL ? <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : m.displayName?.slice(0, 1)}
          </div>
          <span className={clsx('absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white', online ? 'bg-emerald-500' : 'bg-slate-300')} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={clsx('text-[14px] truncate', unread > 0 ? 'font-black text-slate-900' : 'font-extrabold text-slate-900')}>{m.displayName}</p>
          <p className={clsx('text-[12px] truncate', unread > 0 ? 'font-bold text-slate-700' : 'font-semibold text-slate-500')}>{preview}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] font-extrabold text-slate-400">{timeLabel(chat?.lastMessageAt)}</p>
          {unread > 0 && <span className="inline-flex mt-1 min-w-[20px] h-5 px-1.5 rounded-full bg-teal-700 text-white text-[10px] font-black items-center justify-center">{unread > 9 ? '9+' : unread}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('chat.title')}</h1>
          <p className="text-sm text-text-muted mt-0.5">{t('chat.subtitle')}</p>
        </div>

        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('chat.searchPlaceholder')}
            className="w-full pl-10 pr-9 py-2.5 text-sm font-semibold rounded-2xl border border-slate-200 outline-none focus:border-teal-600 bg-white shadow-sm"
          />
          <span className="material-symbols-outlined text-[20px] text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">search</span>
          {searching && <span className="material-symbols-outlined animate-spin text-[16px] text-slate-400 absolute right-3 top-1/2 -translate-y-1/2">sync</span>}
        </div>

        {!trimmedQuery && activeNow.length > 0 && (
          <div>
            <p className="text-[10px] font-black tracking-[0.12em] text-slate-500 mb-2 px-1">ACTIVE NOW</p>
            <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">
              {activeNow.map((m: any) => (
                <button key={m.userId} onClick={() => openChat(m.userId)} className="shrink-0 w-14 text-center">
                  <div className="relative w-12 h-12 mx-auto">
                    <div className="w-12 h-12 rounded-full overflow-hidden flex items-center justify-center text-white text-base font-black" style={{ backgroundColor: colorFor(m.userId) }}>
                      {m.photoURL ? <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : m.displayName?.slice(0, 1)}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white bg-emerald-500" />
                  </div>
                  <p className="text-[10px] font-extrabold text-slate-700 mt-1 truncate">{(m.displayName || '').split(' ')[0]}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex bg-slate-200/70 rounded-2xl p-1 gap-0.5">
          {([['all', 'All'], ['groups', 'Groups'], ['people', 'People']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={clsx('flex-1 py-2 rounded-xl text-[11px] font-extrabold transition-all', tab === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>{label}</button>
          ))}
        </div>

        <div data-tour="chat-members">
          {showGroupsBlock && groupRows.map((g: any) => (
            <div key={g.id} onClick={() => navigate(`/groups/${g.id}?chat=1`)} className="flex items-center gap-3 px-1 py-2.5 border-b border-slate-100 cursor-pointer active:bg-slate-50">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-teal-700 to-slate-800 flex items-center justify-center text-xl shrink-0">{groupIconEmoji(g.icon)}</div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-extrabold text-slate-900 truncate">{g.name}</p>
                <p className="text-[12px] font-semibold text-slate-500">Group chat</p>
              </div>
              <span className="material-symbols-outlined text-slate-300">chat</span>
            </div>
          ))}
          {peopleRows.map((m: any) => personRow(m))}
          {tab === 'groups' && groupRows.length === 0 && (
            <p className="p-6 text-sm text-slate-500 italic text-center">No groups yet.</p>
          )}
          {tab !== 'groups' && peopleRows.length === 0 && !showGroupsBlock && otherResults.length === 0 && (
            <p className="p-6 text-sm text-slate-500 italic text-center">{trimmedQuery ? t('chat.noSearchResults') : t('chat.noMembersYet')}</p>
          )}
        </div>

        {otherResults.length > 0 && (
          <div>
            <p className="text-[10px] font-black tracking-[0.12em] text-slate-500 mb-1 px-1">{t('chat.otherResults').toUpperCase()}</p>
            {otherResults.map((u) => (
              <div key={u.uid} onClick={() => openChat(u.uid)} className="flex items-center gap-3 px-1 py-2.5 border-b border-slate-100 cursor-pointer active:bg-slate-50">
                <div className="w-12 h-12 rounded-full overflow-hidden flex items-center justify-center text-white font-black shrink-0" style={{ backgroundColor: colorFor(u.uid) }}>
                  {u.photoURL ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : u.displayName?.slice(0, 1)}
                </div>
                <p className="min-w-0 flex-1 text-[14px] font-extrabold text-slate-900 truncate">{u.displayName}</p>
                <span className="material-symbols-outlined text-slate-300">chat</span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
