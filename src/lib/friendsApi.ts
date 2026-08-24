import { auth } from './firebase';

// `friendships/{id}` is always `[uidA,uidB].sort().join('_')` — same idiom as `directChats`'
// chatId — so any two uids resolve to the same doc regardless of who's "me" in a given call.
export function friendshipId(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export type FriendRequestResult =
  | { status: 'pending' }
  | { status: 'accepted' }
  | { status: 'already_friends' }
  | { status: 'already_pending' }
  | { status: 'resent' };

// Sends a friend request by uid (picked from a co-members/search list) or by email (typed in
// directly) — mirrors inviteToGroup/inviteUserToGroup's dual-mode shape. If the other person
// already sent a request the other way, the server silently merges it into an acceptance instead
// of creating a second conflicting pending doc.
export async function requestFriend(target: { uid: string } | { email: string }): Promise<FriendRequestResult> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/friends/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Re-nudges a single request the caller already sent and is still pending — pushes a fresh
// notification + feed entry to the recipient, same as the first send, without touching the
// underlying friendship doc's status.
export async function resendFriendRequest(uid: string): Promise<void> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/friends/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, resend: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
}

// Re-nudges every request the caller has sent and is still pending, in one action.
export async function resendAllFriendRequests(): Promise<number> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/friends/resend-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data.resent || 0;
}

// Accepts a pending friend request — must be called by the recipient (the server rejects a
// requester trying to accept their own request). Declining/cancelling/unfriending don't go
// through the backend at all — they're a plain `deleteDoc(doc(db, 'friendships', friendshipId(a,
// b)))` from the caller, allowed directly by firestore.rules for either participant.
export async function acceptFriendRequest(friendUid: string): Promise<void> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/friends/respond', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ friendUid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
}

export interface FriendSuggestion {
  uid: string;
  displayName: string;
  photoURL: string;
  mutualCount: number;
}

// "People you may know" — a friends-of-friends traversal, computed server-side since it needs to
// fan out across every one of the caller's friends' own friend lists (see /api/friends/suggestions
// in server.ts). A one-shot fetch, not a live listener — refreshed whenever Friends.tsx's
// Suggestions tab is opened rather than staying perfectly in sync with every accept/decline.
export async function getFriendSuggestions(): Promise<FriendSuggestion[]> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const res = await fetch('/api/friends/suggestions', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data.suggestions || [];
}
