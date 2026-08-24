import { useEffect, useMemo, useState } from 'react';
import { collection, documentId, getDocs, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';

export interface FriendUser {
  uid: string;
  displayName: string;
  photoURL: string;
}

// Every `friendships` doc involving `myUid`, split into the three buckets Friends.tsx renders.
// `participants` (an array field the server sets alongside the doc id) is what makes the query
// possible at all — Firestore can't query "is my uid one of the two halves of the document id"
// directly, only `array-contains`. See friendsApi.ts's friendshipId() for the id convention.
export function useFriendships(myUid: string | undefined) {
  const [friendshipsValue, loading, friendshipsError] = useCollection(
    myUid ? query(collection(db, 'friendships'), where('participants', 'array-contains', myUid)) : null,
  );
  if (friendshipsError) console.error('useFriendships query failed:', friendshipsError);

  const { accepted, incomingPending, outgoingPending, allOtherUids } = useMemo(() => {
    const accepted: { friendUid: string }[] = [];
    const incomingPending: { friendUid: string }[] = [];
    // `lastSentAt` only exists once a request has been resent at least once — falls back to
    // `createdAt` (the original send) so "last sent" always has a value to show.
    const outgoingPending: { friendUid: string; lastSentAt: string }[] = [];
    const allOtherUids: string[] = [];
    for (const d of friendshipsValue?.docs || []) {
      const data = d.data() as any;
      const otherUid = (data.participants || []).find((u: string) => u !== myUid);
      if (!otherUid) continue;
      allOtherUids.push(otherUid);
      if (data.status === 'accepted') accepted.push({ friendUid: otherUid });
      else if (data.requestedBy === myUid) outgoingPending.push({ friendUid: otherUid, lastSentAt: data.lastSentAt || data.createdAt });
      else incomingPending.push({ friendUid: otherUid });
    }
    return { accepted, incomingPending, outgoingPending, allOtherUids };
  }, [friendshipsValue, myUid]);

  // A single `where(documentId(), 'in', [...])` caps at 30 values — someone testing this feature
  // by clicking through many search results (or just accumulating friends/pending requests over
  // time) blows past that easily, so this chunks into batches of 30 and fans out with plain
  // `getDocs` rather than a single `useCollection` listener (which can't dynamically vary its
  // number of underlying queries). Trades away live-updating on the OTHER person's profile
  // changing mid-session for correctness at any friend-list size — an acceptable trade for a
  // name/photo snapshot.
  const [usersByUid, setUsersByUid] = useState<Map<string, FriendUser>>(new Map());
  useEffect(() => {
    if (allOtherUids.length === 0) { setUsersByUid(new Map()); return; }
    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < allOtherUids.length; i += 30) chunks.push(allOtherUids.slice(i, i + 30));
    Promise.all(chunks.map((chunk) => getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)))))
      .then((snaps) => {
        if (cancelled) return;
        const map = new Map<string, FriendUser>();
        snaps.forEach((snap) => snap.docs.forEach((d) => {
          const data = d.data() as any;
          map.set(d.id, { uid: d.id, displayName: data.displayName || 'Someone', photoURL: data.photoURL || '' });
        }));
        setUsersByUid(map);
      })
      .catch((err) => console.error('useFriendships: failed to batch-fetch user profiles:', err));
    return () => { cancelled = true; };
  }, [allOtherUids]);

  const acceptedUids = useMemo(() => new Set(accepted.map((f) => f.friendUid)), [accepted]);
  const pendingUids = useMemo(
    () => new Set([...incomingPending, ...outgoingPending].map((f) => f.friendUid)),
    [incomingPending, outgoingPending],
  );
  // Ready-made shape for InvitePicker's `extraCandidates` prop — accepted friends who may not
  // share a group with the caller at all, so game invites reach further than co-members only.
  const friendCandidates = useMemo(
    () => accepted.map((f) => ({ userId: f.friendUid, displayName: usersByUid.get(f.friendUid)?.displayName || 'Someone' })),
    [accepted, usersByUid],
  );

  return { accepted, incomingPending, outgoingPending, usersByUid, acceptedUids, pendingUids, friendCandidates, loading };
}
