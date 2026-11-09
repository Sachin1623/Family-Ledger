import { collection, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { useLiveQuery } from './liveCache';

// Every shopping list the person can open: their own, their groups', and ones friends shared with them. Newest first.
export function useShoppingLists(uid: string | undefined) {
  const [membershipsValue] = useLiveQuery(uid ? query(collection(db, 'members'), where('userId', '==', uid)) : null);
  const groupIds: string[] = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [mine, loading] = useLiveQuery(uid ? query(collection(db, 'shoppingLists'), where('userId', '==', uid)) : null);
  const [shared] = useLiveQuery(groupIds.length > 0 ? query(collection(db, 'shoppingLists'), where('groupId', 'in', groupIds)) : null);
  const [friends] = useLiveQuery(uid ? query(collection(db, 'shoppingLists'), where('sharedWith', 'array-contains', uid)) : null);
  const byId = new Map<string, any>();
  friends?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
  mine?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
  shared?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
  const lists = Array.from(byId.values()).sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { lists, loading };
}
