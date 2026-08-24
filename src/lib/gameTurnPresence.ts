import { useEffect } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { useAuth } from '../context/AuthContext';

// Shared presence + cleanup logic for the "it's your turn" indicator system (see server.ts's
// notifyGameTurn / GameTurnIndicator.tsx) — reused by every server-mediated or client-authoritative
// multiplayer game screen (Rummy, Sweep, Sequence, Business, Chess) instead of each one
// duplicating the same visibility-tracking boilerplate LudoTurnIndicator.tsx pioneered.
//
// Two responsibilities:
//   1. Presence — writes `users/{uid}.activeGameRef = { gameType, gameId }` while this exact game
//      screen is visible, `null` otherwise (including on unmount/backgrounding), so notifyGameTurn
//      can skip pushing/indicating when the recipient is already looking right at the live
//      Firestore listener that already shows it's their turn.
//   2. Defensive cleanup — if a turn-indicator pill is already showing for THIS exact game when
//      the player lands here some other way (e.g. a lobby list, not tapping the pill itself),
//      clear it so it doesn't linger after they've already seen the game.
export function useGameTurnPresence(gameType: string, gameId: string | undefined) {
  const { user, profile } = useAuth();

  useEffect(() => {
    if (!user || !gameId) return;
    const setPresence = (val: { gameType: string; gameId: string } | null) => {
      setDoc(doc(db, 'users', user.uid), { activeGameRef: val }, { merge: true }).catch(() => {});
    };
    const onVisibility = () => setPresence(document.visibilityState === 'visible' ? { gameType, gameId } : null);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      setPresence(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, gameType, gameId]);

  useEffect(() => {
    if (!user || !gameId) return;
    const indicator = profile?.gameTurnIndicator as { gameType?: string; gameId?: string } | null | undefined;
    if (indicator?.gameType === gameType && indicator?.gameId === gameId) {
      setDoc(doc(db, 'users', user.uid), { gameTurnIndicator: null }, { merge: true }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, gameType, gameId, profile?.gameTurnIndicator]);
}

// Client-side half for the CLIENT-authoritative games (Business, Chess) — these advance the turn
// via a direct `updateDoc`, so (unlike the server-mediated games, which call notifyGameTurn
// directly from within their own turn-advancing endpoint) there's no server-side moment to hook
// this into. Call this right after the updateDoc that hands the turn to `nextPlayerUid` succeeds.
export function notifyGameTurnClient(
  user: { getIdToken: () => Promise<string> } | null | undefined,
  params: { gameType: string; gameId: string; nextPlayerUid: string; opponentNames: string | null },
) {
  if (!user || params.nextPlayerUid === undefined) return;
  user
    .getIdToken()
    .then((idToken) =>
      fetch('/api/notify-game-turn', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }),
    )
    .catch((err) => console.error('notify-game-turn failed:', err));
}
