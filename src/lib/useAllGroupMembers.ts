import { useMemo } from 'react';
import { collection, query, where, documentId } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';
import { isPresenceOnline } from './presence';

// Every co-member across every group `myGroupIds` belongs to, deduped by uid and sorted
// online-first — shared by anywhere that needs "everyone I could chat with" (originally lived
// inline in Dashboard.tsx's since-removed Group Members dropdown, now also used by the all-
// members Chat tool). Firestore's `in` operator tops out at 30 values, so this only covers a
// user's first 30 groups / first 30 distinct co-members — plenty for a family-ledger app, but
// noted here in case that ever needs revisiting.
export function useAllGroupMembers(myGroupIds: string[], excludeUid: string | undefined) {
  const [allMembersValue] = useCollection(
    myGroupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', myGroupIds.slice(0, 30))) : null,
  );
  const distinctMembers = useMemo(() => {
    const byUid = new Map<string, any>();
    for (const d of allMembersValue?.docs || []) {
      const m = d.data() as any;
      if (m.userId === excludeUid || byUid.has(m.userId)) continue;
      byUid.set(m.userId, m);
    }
    return Array.from(byUid.values());
  }, [allMembersValue, excludeUid]);
  const memberUids = useMemo(() => distinctMembers.map((m) => m.userId), [distinctMembers]);
  const [presenceValue] = useCollection(
    memberUids.length > 0 ? query(collection(db, 'users'), where(documentId(), 'in', memberUids.slice(0, 30))) : null,
  );
  const presenceByUid = useMemo(() => {
    const map = new Map<string, any>();
    for (const d of presenceValue?.docs || []) map.set(d.id, d.data());
    return map;
  }, [presenceValue]);
  const sortedMembers = useMemo(() => {
    return [...distinctMembers].sort((a, b) => {
      const aOnline = isPresenceOnline(presenceByUid.get(a.userId));
      const bOnline = isPresenceOnline(presenceByUid.get(b.userId));
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
  }, [distinctMembers, presenceByUid]);

  return { sortedMembers, presenceByUid };
}
