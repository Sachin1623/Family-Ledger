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

export interface FriendStreakState {
  status: 'none' | 'invited_out' | 'active' | 'ended';
  pairId?: string;
  partner?: FriendPerson;
  current?: number;
  longest?: number;
  state?: 'lit' | 'waiting' | 'frozen';
  myDone?: boolean;
  partnerDone?: boolean;
  frozenDaysLeft?: number;
  canRescue?: boolean;
  rescueKind?: 'frozen' | 'lost' | null;
  lostValue?: number;
  rescueCost?: number;
  rescuesLeft?: number;
  incoming: { pairId: string; from: string; name: string; at: string }[];
}

export const fetchFriendStreak = () => call<FriendStreakState>('/api/friend-streak');
export const fetchStreakCandidates = () => call<{ people: FriendPerson[] }>('/api/friend-streak/candidates').then((r) => r.people);
export const inviteToStreak = async (toUid: string) => { await call('/api/friend-streak/invite', 'POST', { toUid }); changed(); };
export const answerStreakInvite = async (pairId: string, accept: boolean) => { await call('/api/friend-streak/respond', 'POST', { pairId, accept }); changed(); };
export const endFriendStreak = async () => { await call('/api/friend-streak/end', 'POST', {}); changed(); };
export const nudgeFriend = () => call<{ ok: boolean; already?: boolean }>('/api/friend-streak/nudge', 'POST', {});
export const rescueFriendStreak = async () => { await call('/api/friend-streak/rescue', 'POST', {}); changed(); };
