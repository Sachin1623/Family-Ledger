import { auth } from './firebase';

// Same join-link + wa.me shape as ManageGroup.tsx's own buildInviteShareMessage/handleSendWhatsApp
// (kept as a separate small helper rather than having ManageGroup import this — that screen's
// version also threads an optional recipient phone number through a whole invite-picker UI this
// doesn't have, and duplicating one three-line function is cheaper than coupling the two).
// `groupName` personalizes the message when known; omit it to fall back to a generic line.
export function buildGroupInviteWhatsAppUrl(groupId: string, groupName?: string): string {
  const link = `${window.location.origin}/join/${groupId}`;
  const message = groupName
    ? `Hey! Join our "${groupName}" group on FamilyLedger so we can track and split expenses together: ${link}`
    : `Hey! I'm using FamilyLedger to track and split expenses with family — join my group: ${link}`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export type InviteResult =
  | { method: 'push'; sent: number }
  | { method: 'email' }
  | { method: 'already_member' };

// Invites someone to a group by email via the backend: if they already have a FamilyLedger
// account they get a push notification, otherwise they get an email with a join link.
export async function inviteToGroup(groupId: string, email: string): Promise<InviteResult> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/invite-to-group', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Same backend endpoint as inviteToGroup, keyed by uid instead of a typed email — used by the
// "Search FamilyLedger Users" picker (see ManageGroup.tsx), where the target is already a known
// account rather than something the inviter typed in. Always resolves to a push notification
// (never the email-invite path) since a found uid always has an account already.
export async function inviteUserToGroup(groupId: string, uid: string): Promise<InviteResult> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/invite-to-group', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, uid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export interface FoundUser {
  uid: string;
  displayName: string;
  photoURL: string;
  shortId: string | null;
}

// Searches other FamilyLedger users by short ID, exact email, or a name substring — used by the
// invite picker to find someone to add directly instead of only sharing a join link. Results
// exclude the caller and (when groupId is passed) anyone already in that group.
export async function searchUsers(query: string, groupId?: string): Promise<FoundUser[]> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/search-users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, groupId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data.users || [];
}
