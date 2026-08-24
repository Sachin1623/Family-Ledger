// Syncs locally-queued Scramble scores (see scramble.ts's pending-score queue) to the leaderboard
// once there's actually a connection. Kept separate from scramble.ts, which has zero
// Firestore/auth dependencies on purpose — the game itself must be fully playable with no network.
import { auth, db } from './firebase';
import { doc, runTransaction } from 'firebase/firestore';
import { readPendingScores, removePendingScore, ScrambleScoreRecord } from './scramble';

async function syncOneScore(uid: string, userName: string, userPhoto: string, record: ScrambleScoreRecord) {
  const ref = doc(db, 'scrambleLeaderboard', `${uid}_${record.wordLength}_${record.timerMode}`);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? (snap.data() as any) : null;
    // Ranked by bestScore (best single match), not a lifetime sum — each match is a fixed-length
    // timed session, so summing would just reward playing more matches rather than playing better.
    const bestScore = Math.max(current?.bestScore ?? 0, record.score);
    const gamesPlayed = (current?.gamesPlayed || 0) + 1;
    tx.set(ref, {
      userId: uid,
      userName,
      userPhoto,
      wordLength: record.wordLength,
      timerMode: record.timerMode,
      bestScore,
      gamesPlayed,
      dictionaryVersion: record.dictionaryVersion,
      updatedAt: new Date().toISOString(),
    });
  });
}

// Stops at the first failure (most likely still offline) rather than hammering every queued
// record — whatever's left just stays queued for the next opportunistic call.
export async function flushPendingScrambleScores(): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const pending = readPendingScores();
  for (const record of pending) {
    try {
      await syncOneScore(user.uid, user.displayName || 'Someone', user.photoURL || '', record);
      removePendingScore(record.id);
    } catch (err) {
      console.error('Scramble score sync failed, will retry later:', err);
      break;
    }
  }
}
