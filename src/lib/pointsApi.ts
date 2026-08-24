import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { showPointsAward } from './pointsToastRef';

// Fire-and-forget claim, called right after an existing (unchanged) write elsewhere in the app —
// server.ts's /api/points/claim re-reads the real document via the Admin SDK to confirm the
// action genuinely happened before awarding anything, so this never needs to send an amount, just
// which action and which document. Never blocks or throws into the caller's own action — a failed
// or rejected claim (e.g. a retried call for something already awarded) is silently a no-op from
// the UI's point of view, just without a toast.
export async function claimPoints(actionType: string, refs: Record<string, any>): Promise<void> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return;
    const res = await fetch('/api/points/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionType, ...refs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A rejection is expected/normal for some calls (e.g. a to-do completed late, or a habit
      // occurrence claimed for a day that isn't actually marked done yet) — logged, not thrown,
      // so it's visible in devtools for debugging without surfacing an error to the user over
      // something that was never going to award points anyway.
      console.warn(`claimPoints(${actionType}) rejected:`, data.error || res.status);
      return;
    }
    if (!data.alreadyAwarded && (data.xp || data.coins)) {
      showPointsAward(data.xp || 0, data.coins || 0);
    }
  } catch (err) {
    console.error(`claimPoints(${actionType}) failed:`, err);
  }
}

// Rummy/Sweep/Sequence award points INLINE, server-side, as part of the game's own finish
// transaction (unlike Ludo, whose finish write is client-direct and so needs
// claimPoints('ludo_result', ...) to trigger an award at all — see LudoGame.tsx). Every player's
// own client still needs to know how much IT earned to show the flying-coins animation, so this
// reads the two possible ledger docs directly — pointsLedger's rules already let a user read only
// their own entries — rather than adding a server endpoint solely to echo back what the
// transaction already wrote.
export async function showGamePointsIfAny(gameType: string, gameId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const [playedSnap, wonSnap] = await Promise.all([
      getDoc(doc(db, 'pointsLedger', `${uid}_game_played_${gameType}_${gameId}`)),
      getDoc(doc(db, 'pointsLedger', `${uid}_game_won_${gameType}_${gameId}`)),
    ]);
    const xp = (playedSnap.data()?.xp || 0) + (wonSnap.data()?.xp || 0);
    const coins = (playedSnap.data()?.coins || 0) + (wonSnap.data()?.coins || 0);
    showPointsAward(xp, coins);
  } catch (err) {
    console.error(`showGamePointsIfAny(${gameType}) failed:`, err);
  }
}

export interface PublicPoints {
  xp: number;
  level: number;
  gameStreaks: Record<string, number>;
  expenseStreakLongest: number;
  badges: { id: string; awardedAt: string; streakDays?: number }[];
}

// The public-profile counterpart of claimPoints — level/XP/badges/streaks only, never coins or
// the raw activity ledger (see server.ts's /api/public-points/:uid for why those stay private).
export async function getPublicPoints(uid: string): Promise<PublicPoints> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch(`/api/public-points/${uid}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export interface LeaderboardEntry {
  uid: string;
  displayName: string;
  photoURL: string;
  xp: number;
  level: number;
  coins: number;
}

export async function getLeaderboard(scope: 'friends' | 'group', groupId?: string): Promise<LeaderboardEntry[]> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const params = new URLSearchParams({ scope, ...(groupId ? { groupId } : {}) });
  const res = await fetch(`/api/points/leaderboard?${params.toString()}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data.entries || [];
}
