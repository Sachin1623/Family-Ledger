import { auth } from './firebase';

// Streak rescue and friend streaks (see streaks.ts on the server). The server checks and does everything; the app only shows it.

export const COST_PER_MISSED_DAY = 15;

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

const changed = () => window.dispatchEvent(new Event('fl-streak-changed'));

// Your own streak: bring a frozen (or just broken) streak back, with coins or with a freeze you have earned.
export async function restoreStreak(method: 'coins' | 'freeze'): Promise<void> {
  await call('/api/streak/restore', 'POST', { method });
  changed();
}

export interface FriendPerson {
  uid: string;
  name: string;
  photoURL: string | null;
}

export interface ActiveFriendStreak {
  pairId: string;
  partner: FriendPerson;
  current: number;
  longest: number;
  state: 'lit' | 'waiting' | 'frozen';
  myDone: boolean;
  partnerDone: boolean;
  frozenDaysLeft: number;
  canRescue: boolean;
  rescueKind: 'frozen' | 'lost' | null;
  lostValue: number;
  rescueCost: number;
  rescuesLeft: number;
}

// Everything about my friend streaks: the ones running (up to `max` at once, one per friend), invites I sent that are waiting, and invites I received.
export interface FriendStreaks {
  streaks: ActiveFriendStreak[];
  outgoing: { pairId: string; partner: FriendPerson }[];
  incoming: { pairId: string; from: string; name: string; at: string }[];
  max: number;
}

export const fetchFriendStreaks = () => call<FriendStreaks>('/api/friend-streak');
export const fetchStreakCandidates = () => call<{ people: (FriendPerson & { taken: boolean })[] }>('/api/friend-streak/candidates').then((r) => r.people);
export const inviteToStreak = async (toUid: string) => { await call('/api/friend-streak/invite', 'POST', { toUid }); changed(); };
export const answerStreakInvite = async (pairId: string, accept: boolean) => { await call('/api/friend-streak/respond', 'POST', { pairId, accept }); changed(); };
export const endFriendStreak = async (pairId: string) => { await call('/api/friend-streak/end', 'POST', { pairId }); changed(); };
export const nudgeFriend = (pairId: string) => call<{ ok: boolean; already?: boolean }>('/api/friend-streak/nudge', 'POST', { pairId });
export const rescueFriendStreak = async (pairId: string) => { await call('/api/friend-streak/rescue', 'POST', { pairId }); changed(); };
