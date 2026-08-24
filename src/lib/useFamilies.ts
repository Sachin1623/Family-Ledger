import { useMemo } from 'react';
import { collection, documentId, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';

export interface FamilyMemberRow {
  id: string;
  userId: string;
  familyId: string;
  role: 'owner' | 'member';
  displayName: string;
  photoURL: string;
}

// Families `myUid` belongs to (owner or member), plus every member row for each — two extra
// queries chained off the membership list, same "my memberships -> the docs they point to" shape
// as Dashboard's own groups query.
export function useFamilies(myUid: string | undefined) {
  const [myMembershipsValue] = useCollection(
    myUid ? query(collection(db, 'familyMembers'), where('userId', '==', myUid)) : null,
  );
  const familyIds = useMemo(
    () => Array.from(new Set((myMembershipsValue?.docs || []).map((d) => (d.data() as any).familyId))),
    [myMembershipsValue],
  );
  const myRoleByFamilyId = useMemo(() => {
    const map = new Map<string, string>();
    myMembershipsValue?.docs.forEach((d) => map.set((d.data() as any).familyId, (d.data() as any).role));
    return map;
  }, [myMembershipsValue]);

  const [familiesValue] = useCollection(
    familyIds.length > 0 ? query(collection(db, 'families'), where(documentId(), 'in', familyIds.slice(0, 30))) : null,
  );
  const families = useMemo(
    () => (familiesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })),
    [familiesValue],
  );

  const [allMembersValue] = useCollection(
    familyIds.length > 0 ? query(collection(db, 'familyMembers'), where('familyId', 'in', familyIds.slice(0, 30))) : null,
  );
  const membersByFamilyId = useMemo(() => {
    const map = new Map<string, FamilyMemberRow[]>();
    (allMembersValue?.docs || []).forEach((d) => {
      const data = d.data() as any;
      const row: FamilyMemberRow = {
        id: d.id, userId: data.userId, familyId: data.familyId, role: data.role,
        displayName: data.displayName || 'Someone', photoURL: data.photoURL || '',
      };
      const arr = map.get(data.familyId) || [];
      arr.push(row);
      map.set(data.familyId, arr);
    });
    return map;
  }, [allMembersValue]);

  return { families, myRoleByFamilyId, membersByFamilyId };
}
