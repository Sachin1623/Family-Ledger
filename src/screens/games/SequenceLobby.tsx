import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode, sideCount, playerCountDescription, PLAYER_COUNT_OPTIONS, type SequencePlayerCount } from '../../lib/sequence';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SEQUENCE_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

export default function SequenceLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [playerCount, setPlayerCount] = useState<SequencePlayerCount>(2);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [fillingBotId, setFillingBotId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'sequenceGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'sequenceGames'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'sequenceGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
        handCount: 0,
        isBot: false,
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        playerCount,
        players: [hostPlayer],
        playerUids: [user.uid],
        currentTurnSeatIndex: 0,
        board: new Array(100).fill(null),
        lockedCells: [],
        sequenceCountBySide: new Array(sideCount(playerCount)).fill(0),
        winnerSide: null,
        cardsRemaining: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'sequenceGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/sequence/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Sequence game:', err);
      setError('Failed to create game.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm('Delete this game? This cannot be undone.')) return;
    setDeletingId(gameId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/sequence/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
    } catch (err: any) {
      console.error('Failed to delete Sequence game:', err);
      setError(err.message || 'Failed to delete game.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleFillBot = async (e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    if (!user) return;
    setFillingBotId(gameId);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/sequence/fill-bot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to add a bot.');
    } catch (err: any) {
      console.error('Failed to add bot to Sequence game:', err);
      setError(err.message || 'Failed to add a bot.');
    } finally {
      setFillingBotId(null);
    }
  };

  const handleJoinByCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const codeSnap = await getDoc(doc(db, 'sequenceGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/sequence/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Sequence"
      emoji="🃏"
      tagline="Line up 5 chips to win. 2–12 players, solo or in teams."
      gradient={['#5a2b7a', '#2a1240']}
      stats={lobbyStats(myGames, user?.uid, 'seat')}
      ranksPath="/games/ranks/sequence"
      help={{ content: SEQUENCE_HELP }}
      error={showNew ? null : error}
    >
      <GoldButton onClick={() => setShowNew(true)}>＋ New game</GoldButton>

      <CodeJoin value={joinCode} onChange={setJoinCode} onJoin={handleJoinByCode} joining={joining} />

      <section className="space-y-2">
        <SectionLabel>{`Your games · ${myGames.length}`}</SectionLabel>
        {loading && <p className="text-sm text-white/60 px-1">Loading…</p>}
        {!loading && myGames.length === 0 && <p className="text-sm text-white/50 italic px-1">No games in progress — start one above.</p>}
        <div className="space-y-2">
          {myGames.map((g) => (
            <LobbyGameCard
              key={g.id}
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName, isBot: p.isBot }))}
              title={g.status === 'waiting' ? 'Waiting for players' : `${g.playerCount}-player game`}
              subtitle={`Code ${g.code} · ${(g.players || []).length}/${g.playerCount} seated`}
              chip={turnChipFor(g, user?.uid, 'seat')}
              onClick={() => navigate(`/games/sequence/${g.id}`)}
              actions={
                <>
                  {g.hostUid === user?.uid && g.status === 'waiting' && (g.players || []).length < g.playerCount && (
                    <IconAction icon="smart_toy" label="Fill empty seat with a bot" tone="blue" onClick={(e) => handleFillBot(e, g.id)} disabled={fillingBotId === g.id} />
                  )}
                  {g.hostUid === user?.uid && g.status !== 'active' && (
                    <IconAction icon="delete" label="Delete game" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} />
                  )}
                </>
              }
            />
          ))}
        </div>
      </section>

      <NewGameSheet open={showNew} onClose={() => setShowNew(false)} title="New game" subtitle="Sequence" createLabel="Create game" creating={creating} onCreate={handleCreate} error={error}>
        <OptionCard label="Players">
          <PillPicker options={PLAYER_COUNT_OPTIONS as readonly SequencePlayerCount[]} value={playerCount} onChange={setPlayerCount} />
          <p className="text-[10px] font-bold text-white/55">{playerCountDescription(playerCount)}</p>
        </OptionCard>
      </NewGameSheet>
    </GameLobbyShell>
  );
}
