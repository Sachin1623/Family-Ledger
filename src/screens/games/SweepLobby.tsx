import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { generateGameCode } from '../../lib/sweep';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SWEEP_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

const SWEEP_POINT_OPTIONS = [25, 50] as const;

export default function SweepLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [playerCount, setPlayerCount] = useState<2 | 4>(4);
  const [sweepPoints, setSweepPoints] = useState<25 | 50>(25);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'sweepGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'sweepGames'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'sweepGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
        team: 0,
        handCount: 0,
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        playerCount,
        sweepPoints,
        players: [hostPlayer],
        playerUids: [user.uid],
        dealerSeatIndex: 0,
        currentTurnSeatIndex: 0,
        dealNumber: 0,
        floor: { looseCards: [], houses: [] },
        floorHiddenCount: 0,
        bidderSeatIndex: null,
        bidValue: null,
        cardsPlayedThisDeal: 0,
        lastCaptureTeam: null,
        capturedByTeam: { team0: [], team1: [] },
        sweepsThisDeal: [],
        netScore: 0,
        lastDealSummary: null,
        dealHistory: [],
        winnerTeam: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'sweepGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/sweep/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Sweep game:', err);
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
      const res = await fetch('/api/sweep/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
    } catch (err: any) {
      console.error('Failed to delete Sweep game:', err);
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
      const codeSnap = await getDoc(doc(db, 'sweepGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/sweep/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Sweep"
      emoji="🧹"
      tagline="Capture the table, build houses, sweep it clean. 2 or 4 players."
      gradient={['#7a5a1d', '#3a2a0a']}
      stats={lobbyStats(myGames, user?.uid, 'seat')}
      ranksPath="/games/ranks/sweep"
      help={{ content: SWEEP_HELP }}
      error={showNew ? null : error}
    >
      <GoldButton onClick={() => setShowNew(true)}>＋ New game</GoldButton>

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
              title={g.status === 'waiting' ? 'Waiting for players' : `${g.playerCount}-player game`}
              subtitle={`Code ${g.code} · ${g.playerCount} players`}
              chip={turnChipFor(g, user?.uid, 'seat')}
              onClick={() => navigate(`/games/sweep/${g.id}`)}
              actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
            />
          ))}
        </div>
      </section>

      <NewGameSheet open={showNew} onClose={() => setShowNew(false)} title="New game" subtitle="Sweep" createLabel="Create game" creating={creating} onCreate={handleCreate} error={error}>
        <OptionCard label="Players">
          <CardPicker options={[{ id: '2', emoji: '👤', label: '2 players', sub: 'head to head' }, { id: '4', emoji: '🤝', label: '4 players', sub: '2 teams of 2' }]} value={String(playerCount) as '2' | '4'} onChange={(v) => setPlayerCount(Number(v) as 2 | 4)} />
        </OptionCard>
        <OptionCard label="Sweep bonus">
          <PillPicker options={SWEEP_POINT_OPTIONS} value={sweepPoints} onChange={setSweepPoints} format={(n) => `${n} pts`} />
        </OptionCard>
      </NewGameSheet>
    </GameLobbyShell>
  );
}
