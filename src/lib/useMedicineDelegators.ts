import { useEffect, useMemo, useState } from 'react';
import { collection, documentId, getDocs, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';
import { Medicine } from './medicines';

// Every uid the signed-in user is a MEDICINE delegate for (group-based or accepted friend-based
// grant), plus every medicine belonging to them + those delegators, plus a batched display-name
// lookup for the alarm-text "whose dose is this" prefix. Extracted out of
// GlobalMedicineReminderScheduler.tsx (its original home) once AlarmsHub.tsx needed the exact same
// derivation — same query shapes HealthMedicines.tsx's own (separately maintained)
// delegatorsForMe/delegatorUids computation uses, just without that screen's extra UI-only fields
// (photoURL, resolveSharer, etc.) neither caller needs.
export function useMedicineDelegators(uid: string | undefined) {
  const [membershipsValue] = useCollection(
    uid ? query(collection(db, 'members'), where('userId', '==', uid)) : null,
  );
  const groupIds = useMemo(() => membershipsValue?.docs.map((d) => d.data().groupId as string) || [], [membershipsValue]);

  const [delegatedToMeByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'medicineDelegateSettings'), where('medicine.groupId', 'in', groupIds)) : null,
  );
  const [delegatedToMeByFriendValue] = useCollection(
    uid ? query(collection(db, 'medicineDelegateSettings'), where('medicine.friendUids', 'array-contains', uid)) : null,
  );
  // A friend-based grant only actually works (per firestore.rules' isHealthDelegateAccepted) once
  // accepted — same acceptance gate HealthMedicines.tsx's own delegatorsForMe applies.
  const [myAcceptedMedicineInvitesValue] = useCollection(
    uid
      ? query(collection(db, 'healthDelegateInvites'), where('friendUid', '==', uid), where('kind', '==', 'medicine'), where('status', '==', 'accepted'))
      : null,
  );
  const acceptedMedicineOwnerUids = useMemo(
    () => new Set((myAcceptedMedicineInvitesValue?.docs || []).map((d) => d.data().ownerUid as string)),
    [myAcceptedMedicineInvitesValue],
  );
  const delegatorUids = useMemo(() => {
    const uids = new Set<string>();
    delegatedToMeByGroupValue?.docs.forEach((d) => uids.add(d.id));
    delegatedToMeByFriendValue?.docs.forEach((d) => { if (acceptedMedicineOwnerUids.has(d.id)) uids.add(d.id); });
    uids.delete(uid || '');
    return Array.from(uids);
  }, [delegatedToMeByGroupValue, delegatedToMeByFriendValue, acceptedMedicineOwnerUids, uid]);

  const [myMedicinesValue] = useCollection(uid ? query(collection(db, 'medicines'), where('userId', '==', uid)) : null);
  const [delegatedMedicinesValue] = useCollection(
    delegatorUids.length > 0 ? query(collection(db, 'medicines'), where('userId', 'in', delegatorUids.slice(0, 30))) : null,
  );
  const medicines: Medicine[] = useMemo(() => [
    ...(myMedicinesValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []),
    ...(delegatedMedicinesValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []),
  ], [myMedicinesValue, delegatedMedicinesValue]);

  // Batched `users` lookup (same chunk-of-30 pattern useFriendships.ts uses) rather than pulling in
  // that whole hook's group/friend machinery just for display names.
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (delegatorUids.length === 0) { setOwnerNames({}); return; }
    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < delegatorUids.length; i += 30) chunks.push(delegatorUids.slice(i, i + 30));
    Promise.all(chunks.map((chunk) => getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)))))
      .then((snaps) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        snaps.forEach((snap) => snap.docs.forEach((d) => { map[d.id] = (d.data() as any).displayName || 'Someone'; }));
        setOwnerNames(map);
      })
      .catch((err) => console.error('useMedicineDelegators: failed to batch-fetch owner names:', err));
    return () => { cancelled = true; };
  }, [delegatorUids]);

  return { delegatorUids, medicines, ownerNames };
}
