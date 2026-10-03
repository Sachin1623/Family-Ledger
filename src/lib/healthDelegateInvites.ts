import { db } from './firebase';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';

// A friend-based health-delegate grant (medicine/glucose/bp) now requires the friend's consent
// before it actually takes effect — see firestore.rules' isHealthDelegateAccepted(). Previously,
// checking a friend's box in the owner's own Delegates settings took effect instantly with no
// notice to the friend at all. One doc per (owner, friend, kind) triple in `healthDelegateInvites`,
// surfaced to the friend on the Pending Actions screen (see usePendingActions.ts) alongside
// friend/group/game invites. Group-based delegation is untouched — there's no single "who" to ask
// consent of for an open-ended, owner-chosen group.
export type HealthDelegateKind = 'medicine' | 'glucose' | 'bp';

export interface HealthDelegateInvite {
  ownerUid: string;
  friendUid: string;
  kind: HealthDelegateKind;
  status: 'pending' | 'accepted' | 'declined';
  ownerName: string;
  ownerPhoto: string;
  createdAt: string;
  respondedAt: string | null;
}

export function healthDelegateInviteId(ownerUid: string, friendUid: string, kind: HealthDelegateKind): string {
  return `${ownerUid}_${friendUid}_${kind}`;
}

// Call right after an owner saves their delegate settings for one health kind, with the friendUids
// list from BEFORE and AFTER this save. Creates a fresh 'pending' invite for anyone newly selected
// (or re-selected after having declined — a declined invite is deleted then recreated, rather than
// updated in place, since only the FRIEND is allowed to transition an existing invite's status;
// the owner re-proposing is a delete+create, both of which the owner's own rules already permit).
// Leaves an already pending/accepted invite untouched so re-saving unrelated fields (the shared
// group, say) never re-prompts someone who already responded. Deletes the invite for anyone
// deselected, so a revoked delegate doesn't linger as a stale pending action on their own screen.
export async function syncHealthDelegateInvites(
  kind: HealthDelegateKind,
  ownerUid: string,
  ownerName: string,
  ownerPhoto: string,
  previousFriendUids: string[],
  nextFriendUids: string[],
): Promise<void> {
  const removed = previousFriendUids.filter((uid) => !nextFriendUids.includes(uid));
  await Promise.all([
    ...nextFriendUids.map(async (friendUid) => {
      const ref = doc(db, 'healthDelegateInvites', healthDelegateInviteId(ownerUid, friendUid, kind));
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data()?.status !== 'declined') return;
      if (snap.exists()) await deleteDoc(ref);
      await setDoc(ref, {
        ownerUid, friendUid, kind, status: 'pending', ownerName, ownerPhoto,
        createdAt: new Date().toISOString(), respondedAt: null,
      });
    }),
    ...removed.map((friendUid) =>
      deleteDoc(doc(db, 'healthDelegateInvites', healthDelegateInviteId(ownerUid, friendUid, kind))).catch(() => {}),
    ),
  ]);
}
