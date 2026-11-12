import { useMemo } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useLiveQuery } from './liveCache';
import { db } from './firebase';

// How many friend requests are waiting for ME to answer (sent to me, not yet accepted). Reads the same `friendships` query useFriendships uses, so the
// listener is shared with it, and nothing else is fetched (no user profiles), which keeps it cheap enough for the header on every screen.
export function useFriendRequestCount(myUid: string | undefined): number {
  const [value] = useLiveQuery(
    myUid ? query(collection(db, 'friendships'), where('participants', 'array-contains', myUid)) : null,
  );
  return useMemo(() => {
    if (!myUid || !value) return 0;
    return value.docs.filter((d) => {
      const data = d.data() as any;
      return data.status !== 'accepted' && data.requestedBy !== myUid;
    }).length;
  }, [value, myUid]);
}
