import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode } from '../../lib/rummy';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { RUMMY_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

export default function RummyLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'rummyGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'rummyGames'));

      // Retry on the rare code collision, same pattern as ludoGameCodes.
      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'rummyGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
        handCount: 0,
        hasSecondJoker: false,
        pureRun543At: null,
        dropped: false,
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        players: [hostPlayer],
        playerUids: [user.uid],
        currentTurnSeatIndex: 0,
        turnPhase: 'draw',
        stockCount: 0,
        discardPile: [],
        wildcardRank1: null,
        wildcardRank2: null,
        jokerCard1: null,
        jokerCard2: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        winnerUid: null,
        finishedAt: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'rummyGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/rummy/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Rummy game:', err);
      setError('Failed to create game.');
    } finally {
      setCreating(false);
    }
  };

  // Host-only, and only while the game hasn't actually started (server also enforces this) — an
  // active game has other players mid-match, so they Drop instead of the host deleting it out
  // from under them.
  const handleDelete = async (e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setDeletingId(gameId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/rummy/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
    } catch (err: any) {
      console.error('Failed to delete Rummy game:', err);
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
      const codeSnap = await getDoc(doc(db, 'rummyGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/rummy/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="27-Hand Rummy"
      emoji="🎴"
      tagline="Our own Rummy twist. Build your hand, call it first."
      gradient={['#7a2b3a', '#3a1222']}
      stats={lobbyStats(myGames, user?.uid, 'seat')}
      ranksPath="/games/ranks/rummy"
      help={{ content: RUMMY_HELP }}
      error={error}
    >
      <GoldButton onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : '＋ New game'}</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your games · ${myGames.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myGames.length === 0 && <p className="text-sm text-white/50 italic px-1">Nothing in progress — start one above.</p>}
        <div className="space-y-2">
          {myGames.map((g) => (
            <LobbyGameCard
              key={g.id}
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName, isBot: p.isBot }))}
              title={g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
              subtitle={`Code ${g.code}`}
              chip={turnChipFor(g, user?.uid, 'seat')}
              onClick={() => navigate(`/games/rummy/${g.id}`)}
              actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
            />
          ))}
        </div>
      </section>
    </GameLobbyShell>
  );
}
