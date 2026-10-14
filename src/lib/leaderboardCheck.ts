// After a Sudoku / Scramble score is saved, ask the server to check whether anyone just got pushed down
// from a top-10 spot (they get a competitive "you've been overtaken" alert). Fire-and-forget: a failure
// here must never affect saving a score or playing.
import { auth } from './firebase';

export async function checkLeaderboard(board: 'sudoku' | 'scramble', key: string | number): Promise<void> {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const idToken = await user.getIdToken();
    await fetch('/api/leaderboard/check', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ board, key: String(key) }),
    });
  } catch {
    // best-effort
  }
}
