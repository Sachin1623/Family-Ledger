import { useMemo } from 'react';
import { collection, documentId, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';
import { BabyProfile } from './vaccinations';

// Every baby profile the signed-in user can act on for vaccination purposes: their OWN profiles
// plus any they have ACCEPTED caregiver access to (babyCaregiverInvites) — mirrors
// useMedicineDelegators.ts's own+delegate merge for medicines. Extracted so BabyVaccinations.tsx
// (which arms alarms), GlobalVaccineReminderScheduler.tsx (which re-arms them app-wide every
// session) and AlarmsHub.tsx (which lists them) share one derivation instead of three independent
// reimplementations that can silently drift apart — that drift (AlarmsHub.tsx querying
// owner-only while BabyVaccinations.tsx already included caregivers) is exactly what let a
// caregiver's overdue vaccine alarm fire while invisible in the Alarms hub.
export function useVaccineCaregivers(uid: string | undefined) {
  const [ownProfilesValue] = useCollection(uid ? query(collection(db, 'babyProfiles'), where('ownerUid', '==', uid)) : null);
  const [myCaregiverInvitesValue] = useCollection(
    uid ? query(collection(db, 'babyCaregiverInvites'), where('caregiverUid', '==', uid), where('status', '==', 'accepted')) : null,
  );
  const caregiverProfileIds = useMemo(
    () => (myCaregiverInvitesValue?.docs || []).map((d) => d.data().profileId as string),
    [myCaregiverInvitesValue],
  );
  const [caregiverProfilesValue] = useCollection(
    caregiverProfileIds.length > 0 ? query(collection(db, 'babyProfiles'), where(documentId(), 'in', caregiverProfileIds.slice(0, 30))) : null,
  );
  const profiles: BabyProfile[] = useMemo(() => {
    const byId = new Map<string, BabyProfile>();
    ownProfilesValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    caregiverProfilesValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values()).filter((p) => !p.deletedAt);
  }, [ownProfilesValue, caregiverProfilesValue]);

  // False until every query this derivation depends on has produced its first result — a caller
  // that acts on `profiles` (e.g. re-arming alarms) must not treat the empty first render as
  // "this user has no babies".
  const loaded =
    ownProfilesValue !== undefined
    && myCaregiverInvitesValue !== undefined
    && (caregiverProfileIds.length === 0 || caregiverProfilesValue !== undefined);

  return { profiles, loaded };
}
