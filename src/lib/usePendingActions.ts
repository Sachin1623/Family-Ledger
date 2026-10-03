import { useMemo } from 'react';
import { collection, collectionGroup, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from './firebase';
import { useFriendships } from './useFriendships';
import { HealthDelegateKind } from './healthDelegateInvites';

// Every item across the app that needs an explicit accept/reject decision from the signed-in
// user — not just information — surfaced together on the Pending Actions screen (and counted for
// Header.tsx's menu badge). Four sources, each already modeled as its own status-bearing doc the
// recipient can read and respond to:
//   - friendships (status:'pending', recipient != requestedBy)
//   - healthDelegateInvites (status:'pending', friendUid == me)
//   - groups/{groupId}/invites, read via a collectionGroup query (status:'pending', targetUid == me)
//   - gameInvites (toUid == me — existence alone means pending; accepting/rejecting both just
//     delete it, see PendingActions.tsx)
//   - babyCaregiverInvites (status:'pending', caregiverUid == me) — same consent shape as
//     healthDelegateInvites, scoped to a child profile instead of a real person + metric kind
export type PendingActionKind = 'friend' | 'health' | 'group' | 'game' | 'babyCaregiver';

export interface PendingActionItem {
  key: string;
  kind: PendingActionKind;
  createdAt: string;
  senderUid: string;
  senderName: string;
  senderPhoto: string;
  // Kind-specific fields used by PendingActions.tsx to render details and act.
  friendUid?: string; // friend
  inviteDocId?: string; healthKind?: HealthDelegateKind; ownerUid?: string; // health
  groupInvitePath?: string; groupId?: string; groupName?: string; // group
  gameInviteId?: string; gameId?: string; routeSegment?: string; gameLabel?: string; code?: string; // game
  babyProfileId?: string; babyProfileName?: string; // babyCaregiver
}

// GAME_TABLE_COLLECTIONS mirrors the identical map server.ts's account-deletion cascade already
// needed (search for "rummy13Tables" there) — the one place a game's routeSegment and its actual
// Firestore collection diverge (e.g. 'rummy13' -> 'rummy13Tables', 'ludo' -> 'ludoGames'). Used by
// PendingActions.tsx to check whether a game invite's table still exists before offering Accept.
export const GAME_TABLE_COLLECTIONS: Record<string, string> = {
  rummy: 'rummyGames',
  rummy13: 'rummy13Tables',
  spadePledge: 'spadePledgeTables',
  sequence: 'sequenceGames',
  ludo: 'ludoGames',
  sweep: 'sweepGames',
  business: 'businessGames',
  chess: 'chessGames',
};

export function usePendingActions(myUid: string | undefined) {
  const { incomingPending, usersByUid } = useFriendships(myUid);

  const [healthInvitesValue] = useCollection(
    myUid
      ? query(collection(db, 'healthDelegateInvites'), where('friendUid', '==', myUid), where('status', '==', 'pending'))
      : null,
  );
  // Filtered/sorted client-side rather than with an orderBy/composite index — this app's
  // established pattern for small, per-user result sets (see e.g. processBudgetReminders' own
  // comment on the same tradeoff) — a signed-in user's own pending count is never large enough for
  // that to matter.
  const [groupInvitesValue] = useCollection(
    myUid ? query(collectionGroup(db, 'invites'), where('targetUid', '==', myUid)) : null,
  );
  const [gameInvitesValue] = useCollection(
    myUid ? query(collection(db, 'gameInvites'), where('toUid', '==', myUid)) : null,
  );
  const [babyCaregiverInvitesValue] = useCollection(
    myUid
      ? query(collection(db, 'babyCaregiverInvites'), where('caregiverUid', '==', myUid), where('status', '==', 'pending'))
      : null,
  );

  const items: PendingActionItem[] = useMemo(() => {
    const out: PendingActionItem[] = [];

    incomingPending.forEach((f) => {
      const u = usersByUid.get(f.friendUid);
      out.push({
        key: `friend_${f.friendUid}`, kind: 'friend', createdAt: '',
        senderUid: f.friendUid, senderName: u?.displayName || 'Someone', senderPhoto: u?.photoURL || '',
        friendUid: f.friendUid,
      });
    });

    (healthInvitesValue?.docs || []).forEach((d) => {
      const data = d.data() as any;
      out.push({
        key: `health_${d.id}`, kind: 'health', createdAt: data.createdAt || '',
        senderUid: data.ownerUid, senderName: data.ownerName || 'Someone', senderPhoto: data.ownerPhoto || '',
        inviteDocId: d.id, healthKind: data.kind, ownerUid: data.ownerUid,
      });
    });

    (groupInvitesValue?.docs || []).forEach((d) => {
      const data = d.data() as any;
      if (data.status !== 'pending') return;
      const groupId = d.ref.parent.parent?.id || '';
      out.push({
        key: `group_${d.ref.path}`, kind: 'group', createdAt: data.createdAt || '',
        senderUid: data.invitedBy || '', senderName: '', senderPhoto: '',
        groupInvitePath: d.ref.path, groupId, groupName: data.groupName || 'a group',
      });
    });

    (gameInvitesValue?.docs || []).forEach((d) => {
      const data = d.data() as any;
      out.push({
        key: `game_${d.id}`, kind: 'game', createdAt: data.createdAt || '',
        senderUid: data.hostUid || '', senderName: data.hostName || 'Someone', senderPhoto: data.hostPhoto || '',
        gameInviteId: d.id, gameId: data.gameId, routeSegment: data.routeSegment, gameLabel: data.gameLabel, code: data.code,
      });
    });

    (babyCaregiverInvitesValue?.docs || []).forEach((d) => {
      const data = d.data() as any;
      out.push({
        key: `babyCaregiver_${d.id}`, kind: 'babyCaregiver', createdAt: data.createdAt || '',
        senderUid: data.ownerUid, senderName: data.ownerName || 'Someone', senderPhoto: data.ownerPhoto || '',
        inviteDocId: d.id, babyProfileId: data.profileId, babyProfileName: data.profileName,
      });
    });

    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [incomingPending, usersByUid, healthInvitesValue, groupInvitesValue, gameInvitesValue, babyCaregiverInvitesValue]);

  // Group invites' sender name/photo isn't stored on the invite doc itself (only `invitedBy`, a
  // uid) — resolved as a second pass via usersByUid where available, falling back to a plain
  // lookup PendingActions.tsx performs for any uid not already covered by the friendships batch.
  return { items, usersByUid };
}
