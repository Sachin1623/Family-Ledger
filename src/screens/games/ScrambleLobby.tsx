import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, doc, getDoc, setDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import {
  generateGameCode,
  TOTAL_WORDS_OPTIONS,
  PER_WORD_TIMER_OPTIONS,
  PER_WORD_TIMER_LABEL,
  MATCH_TIMER_OPTIONS,
  MATCH_TIMER_LABEL,
  ScramblePerWordTimer,
  ScrambleMatchTimer,
} from '../../lib/scrambleMultiplayer';
import { WORD_LENGTHS, ScrambleWordLength } from '../../lib/scramble';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SCRAMBLE_HELP } from '../../lib/gameHelp';
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

export default function ScrambleLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [wordLength, setWordLength] = useState<ScrambleWordLength>(6);
  const [totalWords, setTotalWords] = useState<(typeof TOTAL_WORDS_OPTIONS)[number]>(10);
  const [timerMode, setTimerMode] = useState<ScramblePerWordTimer>('30s');
  const [matchTimerMode, setMatchTimerMode] = useState<ScrambleMatchTimer>('5min');
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [myGamesValue, loading] = useCollection(
    user ? query(collection(db, 'scrambleGames'), where('playerUids', 'array-contains', user.uid)) : null,
  );
  const myGames = (myGamesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((g) => g.status !== 'finished')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    setError(null);
    try {
      const gameRef = doc(collection(db, 'scrambleGames'));

      let code = generateGameCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await getDoc(doc(db, 'scrambleGameCodes', code));
        if (!existing.exists()) break;
        code = generateGameCode();
      }

      const hostPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: 0,
      };

      await setDoc(gameRef, {
        hostUid: user.uid,
        code,
        status: 'waiting',
        wordLength,
        totalWords,
        timerMode,
        matchTimerMode,
        players: [hostPlayer],
        playerUids: [user.uid],
        createdAt: new Date().toISOString(),
        startedAt: null,
        matchEndsAt: null,
        finishedAt: null,
        winnerUid: null,
        rematchGameId: null,
      });
      await setDoc(doc(db, 'scrambleGameCodes', code), { gameId: gameRef.id, hostUid: user.uid });

      navigate(`/games/scramble-multiplayer/${gameRef.id}`);
    } catch (err) {
      console.error('Failed to create Scramble game:', err);
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
      const res = await fetch('/api/scramble/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete game.');
    } catch (err: any) {
      console.error('Failed to delete Scramble game:', err);
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
      const codeSnap = await getDoc(doc(db, 'scrambleGameCodes', code));
      if (!codeSnap.exists()) {
        setError('No game found with that code.');
        return;
      }
      navigate(`/games/scramble-multiplayer/${codeSnap.data().gameId}`);
    } catch (err) {
      console.error('Failed to look up code:', err);
      setError('Failed to look up that code.');
    } finally {
      setJoining(false);
    }
  };

  return (
    <GameLobbyShell
      title="Scramble Race"
      emoji="🔤"
      tagline="Race the family through the same word list. 2–4 players."
      gradient={['#2b5a7a', '#12283a']}
      stats={lobbyStats(myGames, user?.uid, 'none')}
      ranksPath="/games/scramble/leaderboard"
      help={{ content: SCRAMBLE_HELP }}
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
              players={(g.players || []).map((p: any) => ({ uid: p.uid, photoURL: p.photoURL, displayName: p.displayName }))}
              title={g.status === 'waiting' ? 'Waiting for players' : 'Race in progress'}
              subtitle={`Code ${g.code} · ${g.wordLength}-letter · ${g.totalWords} words`}
              chip={turnChipFor(g, user?.uid, 'none')}
              onClick={() => navigate(`/games/scramble-multiplayer/${g.id}`)}
              actions={g.hostUid === user?.uid && g.status !== 'active' ? <IconAction icon="delete" label="Delete game" onClick={(e) => handleDelete(e, g.id)} disabled={deletingId === g.id} /> : null}
            />
          ))}
        </div>
      </section>

      <NewGameSheet open={showNew} onClose={() => setShowNew(false)} title="New game" subtitle="Scramble race" createLabel="Create game" creating={creating} onCreate={handleCreate} error={error}>
        <OptionCard label="Word length">
          <PillPicker options={WORD_LENGTHS as readonly ScrambleWordLength[]} value={wordLength} onChange={setWordLength} />
        </OptionCard>
        <OptionCard label="Words in match">
          <PillPicker options={TOTAL_WORDS_OPTIONS as readonly number[]} value={totalWords as number} onChange={(n) => setTotalWords(n as (typeof TOTAL_WORDS_OPTIONS)[number])} />
        </OptionCard>
        <OptionCard label="Per-word timer (display only)">
          <PillPicker options={PER_WORD_TIMER_OPTIONS as readonly ScramblePerWordTimer[]} value={timerMode} onChange={setTimerMode} format={(m) => PER_WORD_TIMER_LABEL[m]} />
        </OptionCard>
        <OptionCard label="Match timer">
          <PillPicker options={MATCH_TIMER_OPTIONS as readonly ScrambleMatchTimer[]} value={matchTimerMode} onChange={setMatchTimerMode} format={(m) => MATCH_TIMER_LABEL[m]} />
        </OptionCard>
      </NewGameSheet>
    </GameLobbyShell>
  );
}
