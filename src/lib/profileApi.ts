import { auth } from './firebase';
import type { BadgeTier } from './cosmeticsApi';

// A person's profile as FamilyLedger members see it (see publicProfile.ts on the server). The server decides what the viewer may see; a section the viewer
// may not see is simply missing, and `sections` says which ones are allowed so the screen can show "private" instead of a gap. There is never any money here.

export type Visibility = 'only_me' | 'friends' | 'members';
export type SectionKey = 'level' | 'streaks' | 'badges' | 'flames' | 'week' | 'games' | 'recap' | 'journey' | 'friends' | 'birthday';

export interface ProfileData {
  relation: 'self' | 'friend' | 'member';
  visibleTo: Visibility;
  header: { uid: string; displayName: string; photoURL: string; memberSince: string | null; friends: number };
  sections: Record<SectionKey, boolean>;
  settings?: { main: Visibility; sections: Record<SectionKey, Visibility> };
  style: { flame: string; badges: string[] };
  level?: { level: number; xp: number };
  streaks?: { current: number; longest: number; games: Record<string, number> };
  birthday?: string;
  badges?: { earned: { id: string; name: string; icon: string; tier: BadgeTier }[]; total: number; shown: string[] };
  flames?: { owned: { id: string; name: string }[]; equipped: string };
  week?: { days: { date: string; logged: boolean }[]; expenses: number; daysLogged: number };
  recap?: { expenses: number; daysLogged: number; topCategory: string | null; vsLastWeek: number; questsDone: number; streakKept: boolean };
  games?: { game: string; played: number; won: number; friends: { rank: number; of: number } | null; everyone: { rank: number; of: number } | null }[];
  journey?: { groups: number; questsDone: number; friendStreaksRunning: number; bestFriendStreak: number };
  friendList?: { total: number; people: { uid: string; name: string; photoURL: string; flame: string }[] };
}

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

export const fetchProfile = (uid: string) => call<ProfileData>(`/api/profile/${uid}`);
export const saveVisibility = (patch: { main?: Visibility; sections?: Partial<Record<SectionKey, Visibility>> }) => call<{ ok: boolean }>('/api/profile/visibility', 'POST', patch);

export const VISIBILITY_LABEL: Record<Visibility, string> = { only_me: 'Only me', friends: 'Friends', members: 'All members' };
