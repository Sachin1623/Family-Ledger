import { useMemo, useState } from 'react';
import { collection, doc, query, updateDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';

export interface ReportsSharer {
  uid: string;
  displayName: string;
  photoURL: string;
}

// Who has shared THEIR whole Reports & Timeline with me (for GoalReports.tsx's view switcher),
// plus a save() for granting/revoking MY OWN share (users/{myUid}.reportsSharedWith — see
// firestore.rules' hasReportsAccessTo() for how that field actually gates read access to the
// owner's goals/financialAccounts). The caller's own current grant list doesn't need its own
// query here — it's already live on their own `profile` doc from useAuth().
export function useReportsSharing(myUid: string | undefined) {
  const [sharedWithMeValue] = useCollection(
    myUid ? query(collection(db, 'users'), where('reportsSharedWith', 'array-contains', myUid)) : null,
  );
  const sharedWithMe: ReportsSharer[] = useMemo(
    () => (sharedWithMeValue?.docs || []).map((d) => {
      const data = d.data() as any;
      return { uid: d.id, displayName: data.displayName || 'Someone', photoURL: data.photoURL || '' };
    }),
    [sharedWithMeValue],
  );

  const [saving, setSaving] = useState(false);
  const save = async (nextGrantedTo: string[]) => {
    if (!myUid) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', myUid), { reportsSharedWith: nextGrantedTo });
    } finally {
      setSaving(false);
    }
  };

  return { sharedWithMe, saving, save };
}
