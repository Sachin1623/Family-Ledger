import { useMemo } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';

export interface DmChat {
  id: string; // `[uidA, uidB].sort().join('_')` — see Dashboard.tsx's dmChatId
  participants: string[];
  lastMessageAt?: string;
  lastMessageText?: string;
  lastMessageBy?: string;
  unreadFor?: Record<string, number>;
}

// Every DM chat the current user is a participant in — one query via the `participants`
// array written by /api/chat/send (see server.ts), rather than a per-member fan-out. Shared by
// MembersChat.tsx (ordering + per-member unread badges) and Navigation.tsx (the nav bar's
// unread-chat-count badge) so both stay in sync off the same live listener shape.
export function useDmChats(myUid: string | undefined) {
  const [value, loading] = useCollection(
    myUid ? query(collection(db, 'directChats'), where('participants', 'array-contains', myUid)) : null,
  );
  const chats = useMemo(
    () => (value?.docs.map((d) => ({ id: d.id, ...d.data() }) as DmChat) || []),
    [value],
  );
  const chatByOtherUid = useMemo(() => {
    const map = new Map<string, DmChat>();
    for (const c of chats) {
      const otherUid = (c.participants || []).find((uid) => uid !== myUid);
      if (otherUid) map.set(otherUid, c);
    }
    return map;
  }, [chats, myUid]);
  const unreadChatCount = useMemo(
    () => chats.filter((c) => (c.unreadFor?.[myUid || ''] || 0) > 0).length,
    [chats, myUid],
  );
  return { chats, chatByOtherUid, unreadChatCount, loading };
}
