import { useState } from 'react';
import { useFriendships } from './useFriendships';
import { useFamilies } from './useFamilies';

// The dual sharing model — an optional whole-group share AND/OR specific friends, each with its
// own 'view'/'edit' role — used identically by Goals (GoalWizard.tsx) and Financial Accounts
// (AccountsHub.tsx) today, hand-copied between the two. This is that same state/logic extracted
// into one hook so a third feature (Policy Vault) doesn't become a third copy-paste; GoalWizard/
// AccountsHub are left as-is for now (not a forced refactor of already-working files).
export type ShareRole = 'view' | 'edit';

export function useSharePicker(myUid: string | undefined) {
  const [shareGroupId, setShareGroupId] = useState<string | null>(null);
  const [shareGroupRole, setShareGroupRole] = useState<ShareRole>('view');
  const [shareFriendUids, setShareFriendUids] = useState<string[]>([]);
  const [shareFriendRoles, setShareFriendRoles] = useState<Record<string, ShareRole>>({});
  const [friendSearch, setFriendSearch] = useState('');

  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(myUid);
  const { families: myFamilies, membersByFamilyId } = useFamilies(myUid);

  const isFamilyFullySelected = (familyId: string) => {
    const members = membersByFamilyId.get(familyId) || [];
    return members.length > 0 && members.every((m) => shareFriendUids.includes(m.userId));
  };
  const toggleFamily = (familyId: string) => {
    const memberUids = (membersByFamilyId.get(familyId) || []).map((m) => m.userId);
    const allSelected = isFamilyFullySelected(familyId);
    setShareFriendUids((prev) => (allSelected ? prev.filter((u) => !memberUids.includes(u)) : Array.from(new Set([...prev, ...memberUids]))));
  };
  const toggleFriend = (uid: string) => {
    setShareFriendUids((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]));
  };
  const setFriendRole = (uid: string, role: ShareRole) => {
    setShareFriendRoles((prev) => ({ ...prev, [uid]: role }));
  };
  // Only the currently-selected friends' roles are ever written — a friend removed from the share
  // list shouldn't leave a stale role entry behind. Missing entries (a friend just added, never
  // explicitly given a role) default to 'view', same as the field's own absent-value default.
  const buildFriendRoles = (): Record<string, ShareRole> =>
    Object.fromEntries(shareFriendUids.map((uid) => [uid, shareFriendRoles[uid] || 'view']));
  const filteredFriends = acceptedFriends.filter(({ friendUid }) => {
    if (!friendSearch.trim()) return true;
    const fname = friendUsersByUid.get(friendUid)?.displayName || '';
    return fname.toLowerCase().includes(friendSearch.trim().toLowerCase());
  });

  // Bulk-seed every field at once — used when loading an existing record for editing, so the
  // caller doesn't have to call 5 setters individually.
  const seedShare = (initial: { groupId: string | null; groupRole?: ShareRole | null; friendUids?: string[]; friendRoles?: Record<string, ShareRole> }) => {
    setShareGroupId(initial.groupId);
    setShareGroupRole(initial.groupRole || 'view');
    setShareFriendUids(initial.friendUids || []);
    setShareFriendRoles(initial.friendRoles || {});
  };

  return {
    shareGroupId, setShareGroupId,
    shareGroupRole, setShareGroupRole,
    shareFriendUids, setShareFriendUids,
    shareFriendRoles, setShareFriendRoles,
    friendSearch, setFriendSearch,
    myFamilies, membersByFamilyId,
    acceptedFriends, friendUsersByUid,
    isFamilyFullySelected, toggleFamily, toggleFriend, setFriendRole, buildFriendRoles, filteredFriends,
    seedShare,
  };
}

export type SharePicker = ReturnType<typeof useSharePicker>;
