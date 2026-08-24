// Syncs locally-queued Sudoku scores (see sudoku.ts's pending-score queue) to the leaderboard once
// there's actually a connection. Kept separate from sudoku.ts, which has zero Firestore/auth
// dependencies on purpose — the game itself must be fully playable with no network at all.
import { auth, db } from './firebase';
import { doc, runTransaction } from 'firebase/firestore';
import { readPendingScores, removePendingScore, SudokuScoreRecord } from './sudoku';

async function syncOneScore(uid: string, userName: string, userPhoto: string, record: SudokuScoreRecord) {
  const ref = doc(db, 'sudokuLeaderboard', `${uid}_${record.difficulty}`);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? (snap.data() as any) : null;
    // totalScore is the running SUM of every completed puzzle's score (used for the Leaderboard
    // ranking) — every finished puzzle counts (Sudoku has no losing state, so "won" just means
    // completed). Pre-existing docs from before this change only ever stored `bestScore` (a max,
    // not a sum) with no per-game history to retroactively total up — a one-time seed from that
    // old best score, rather than a hard reset to 0, is the least-lossy way to carry it forward.
    // bestScore is separately tracked as the single highest-scoring puzzle, used by the "Overall
    // best" widget on Sudoku Home (which shows the best individual game, not the lifetime sum).
    const totalScore = (current?.totalScore ?? current?.bestScore ?? 0) + record.score;
    const bestScore = Math.max(current?.bestScore ?? 0, record.score);
    const gamesPlayed = (current?.gamesPlayed || 0) + 1;
    tx.set(ref, {
      userId: uid,
      userName,
      userPhoto,
      difficulty: record.difficulty,
      totalScore,
      bestScore,
      gamesPlayed,
      updatedAt: new Date().toISOString(),
    });
  });
}

// Stops at the first failure (most likely still offline) rather than hammering every queued
// record — whatever's left just stays queued for the next opportunistic call.
export async function flushPendingSudokuScores(): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const pending = readPendingScores();
  for (const record of pending) {
    try {
      await syncOneScore(user.uid, user.displayName || 'Someone', user.photoURL || '', record);
      removePendingScore(record.id);
    } catch (err) {
      console.error('Sudoku score sync failed, will retry later:', err);
      break;
    }
  }
}
