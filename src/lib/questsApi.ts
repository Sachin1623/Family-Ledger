import { auth } from './firebase';
import { showPointsAward } from './pointsToastRef';

// Talks to the quest endpoints (see quests.ts on the server). Every quest is checked and paid by the server; the app only shows them.

export type QuestPeriod = 'onboarding' | 'daily' | 'weekly' | 'monthly' | 'journey';

export interface Quest {
  key: string;
  id: string;
  period: QuestPeriod;
  title: string;
  desc: string;
  icon: string;
  progress: number;
  target: number;
  xp: number;
  coins: number;
  claimed: boolean;
  claimable: boolean;
  go?: string;
}

export interface QuestBoard {
  day: string;
  onboardingFinished: boolean;
  onboarding: Quest[];
  onboardingBonus: Quest;
  daily: Quest[];
  dailyBonus: Quest;
  weekly: Quest[];
  weeklyEnds: string;
  monthly: Quest[];
  monthTheme: string;
  journey: Quest[];
  summary: { todayDone: number; todayTotal: number; claimable: number; pending: number };
}

export interface CheerPerson {
  uid: string;
  name: string;
  photoURL: string | null;
  cheeredToday: boolean;
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

export const fetchQuestBoard = () => call<QuestBoard>('/api/quests');

export async function claimQuest(key: string): Promise<{ xp: number; coins: number; alreadyAwarded: boolean }> {
  const r = await call<{ xp: number; coins: number; alreadyAwarded: boolean }>('/api/quests/claim', 'POST', { key });
  if (!r.alreadyAwarded) showPointsAward(r.xp, r.coins);
  return r;
}

export const fetchCheerPeople = () => call<{ people: CheerPerson[] }>('/api/quests/cheer-targets').then((r) => r.people);
export const sendCheer = (toUid: string) => call<{ ok: boolean; already: boolean }>('/api/quests/cheer', 'POST', { toUid });

export type QuestEventType = 'recap_shared' | 'spread_shared' | 'health_log' | 'invite_sent';

// Fire-and-forget: tells the server something a quest may count happened. Never blocks or throws into the caller's own action, and tells the open
// quest board (if any) to refresh.
export function questEvent(type: QuestEventType): void {
  call('/api/quests/event', 'POST', { type })
    .then(() => window.dispatchEvent(new Event('fl-quests-changed')))
    .catch(() => {
      /* a missed count only means a quest tick is late */
    });
}
