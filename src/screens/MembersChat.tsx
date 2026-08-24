import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useAllGroupMembers } from '../lib/useAllGroupMembers';
import { useFriendships } from '../lib/useFriendships';
import { useDmChats } from '../lib/useDmChats';
import { isPresenceOnline, lastSeenLabel } from '../lib/presence';
import { useLanguage } from '../context/LanguageContext';

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

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('chat.title')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('chat.subtitle')}</p>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle overflow-hidden" data-tour="chat-members">
          {orderedMembers.length === 0 && (
            <p className="p-6 text-sm text-text-muted italic text-center">{t('chat.noMembersYet')}</p>
          )}
          {orderedMembers.map((m: any) => {
            const presence = presenceByUid.get(m.userId);
            const online = isPresenceOnline(presence);
            const unread = chatByOtherUid.get(m.userId)?.unreadFor?.[user?.uid || ''] || 0;
            return (
              <div
                key={m.userId}
                onClick={() => openChat(m.userId)}
                className="p-4 flex items-center gap-3 hover:bg-surface-container/20 transition-colors cursor-pointer"
              >
                <div className="relative shrink-0">
                  <div className="w-10 h-10 rounded-full bg-surface-container-high overflow-hidden">
                    {m.photoURL ? (
                      <img src={m.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-primary text-xs font-bold">
                        {m.displayName?.slice(0, 1)}
                      </div>
                    )}
                  </div>
                  <span
                    className={clsx(
                      'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white',
                      online ? 'bg-success' : 'bg-text-muted/50',
                    )}
                  />
                  {unread > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10px] font-bold flex items-center justify-center border-2 border-white">
                      {unread > 9 ? '9+' : unread}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-on-surface truncate">{m.displayName}</p>
                  <p className={clsx('text-[10px] font-bold', online ? 'text-success' : 'text-text-muted')}>
                    {online ? t('chat.online') : t('chat.lastSeen', { time: lastSeenLabel(presence) })}
                  </p>
                </div>
                <span className="material-symbols-outlined text-primary shrink-0">chat</span>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
