import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode, emptyTokens, COLORS, COLOR_HEX } from '../../lib/ludo';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { LUDO_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

export default function LudoLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'ludoGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'ludoGames'));

      // Retry on the rare code collision (6-char alphanumeric from a 32-symbol alphabet — very
      // unlikely, but ludoGameCodes docs are id'd by the code itself, so a collision would
      // otherwise silently overwrite someone else's game pointer).
      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'ludoGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        color: COLORS[0],
        seatIndex: 0,
        tokens: emptyTokens(),
        finishedCount: 0,
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        players: [hostPlayer],
        playerUids: [user.uid],
        currentTurnSeatIndex: 0,
        diceValue: null,
        consecutiveSixes: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        winnerUid: null,
        finishedAt: null,
      });
      await setDoc(doc(db, 'ludoGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/ludo/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Ludo game:', err);
      setError('Failed to create game.');
    } finally {
      setCreating(false);
    }
  };

  // Host-only, and only while the game hasn't actually started (server also enforces this) — an
  // active game has other players mid-match.
  const handleDelete = async (e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setDeletingId(gameId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/ludo/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
    } catch (err: any) {
      console.error('Failed to delete Ludo game:', err);
      setError(err.message || 'Failed to delete game.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleJoinByCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const codeSnap = await getDoc(doc(db, 'ludoGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/ludo/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Ludo"
      emoji="🎲"
      tagline="Race your tokens home. Up to 4 players, online."
      gradient={['#7a2b3a', '#3a1222']}
      stats={lobbyStats(myGames, user?.uid, 'none')}
      ranksPath="/games/ranks/ludo"
      help={{ content: LUDO_HELP }}
      error={error}
    >
      <GoldButton onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : '＋ New game'}</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your games · ${myGames.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myGames.length === 0 && <p className="text-sm text-white/50 italic px-1">No games in progress — start one above.</p>}
        <div className="space-y-2">
          {myGames.map((g) => (
            <LobbyGameCard
              key={g.id}
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName, color: COLOR_HEX[p.color as keyof typeof COLOR_HEX] }))}
              title={g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
              subtitle={`${(g.players || []).length} player${(g.players || []).length === 1 ? '' : 's'} · code ${g.code}`}
              chip={turnChipFor(g, user?.uid, 'none')}
              onClick={() => navigate(`/games/ludo/${g.id}`)}
              actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete game" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
            />
          ))}
        </div>
      </section>
    </GameLobbyShell>
  );
}
