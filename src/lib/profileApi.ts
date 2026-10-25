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

// A profile opens from the copy saved on this phone the last time it was loaded (so it appears at once), and is refreshed from the server a moment later.
const CACHE_PREFIX = 'fl_profile_';
const memoryCache = new Map<string, ProfileData>();

export function readCachedProfile(uid: string): ProfileData | null {
  const hit = memoryCache.get(uid);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + uid);
    if (!raw) return null;
    const data = JSON.parse(raw) as ProfileData;
    memoryCache.set(uid, data);
    return data;
  } catch {
    return null;
  }
}

export async function fetchProfile(uid: string): Promise<ProfileData> {
  const data = await call<ProfileData>(`/api/profile/${uid}`);
  memoryCache.set(uid, data);
  try {
    localStorage.setItem(CACHE_PREFIX + uid, JSON.stringify(data));
  } catch {
    /* storage full or unavailable: the profile just loads normally next time */
  }
  return data;
}

// Quietly loads a profile ahead of time (the person's own, right after the app opens) so tapping it is instant.
export function prefetchProfile(uid: string): void {
  fetchProfile(uid).catch(() => {});
}
export async function saveVisibility(patch: { main?: Visibility; sections?: Partial<Record<SectionKey, Visibility>> }): Promise<{ ok: boolean }> {
  const r = await call<{ ok: boolean }>('/api/profile/visibility', 'POST', patch);
  // my own saved profile copy is now out of date: forget it so it is not shown with the old settings
  memoryCache.forEach((v, k) => {
    if (v.relation === 'self') {
      memoryCache.delete(k);
      try { localStorage.removeItem(CACHE_PREFIX + k); } catch { /* ignore */ }
    }
  });
  return r;
}

export const VISIBILITY_LABEL: Record<Visibility, string> = { only_me: 'Only me', friends: 'Friends', members: 'All members' };
