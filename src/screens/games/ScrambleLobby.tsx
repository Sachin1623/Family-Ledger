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

export default function ScrambleLobby() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [wordLength, setWordLength] = useState<ScrambleWordLength>(6);
  const [totalWords, setTotalWords] = useState<(typeof TOTAL_WORDS_OPTIONS)[number]>(10);
  const [timerMode, setTimerMode] = useState<ScramblePerWordTimer>('30s');
  const [matchTimerMode, setMatchTimerMode] = useState<ScrambleMatchTimer>('5min');
  const [creating, setCreating] = useState(false);
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
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-primary">Scramble — Multiplayer</h1>
            <p className="text-sm text-text-muted mt-1">Online, 2-4 players — race through the same word sequence.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => navigate('/games/scramble/leaderboard')}
              className="flex items-center gap-1.5 px-3 py-2 bg-primary/5 text-primary rounded-xl text-xs font-bold"
            >
              <span className="material-symbols-outlined text-[16px]">leaderboard</span>
              Leaderboard
            </button>
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </div>

        {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}

        {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-4">
          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Word Length</p>
            <div className="flex flex-wrap gap-2">
              {WORD_LENGTHS.map((n) => (
                <button
                  key={n}
                  onClick={() => setWordLength(n)}
                  className={clsx(
                    'w-9 h-9 rounded-lg text-xs font-bold border',
                    wordLength === n ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Words in Match</p>
            <div className="flex gap-2">
              {TOTAL_WORDS_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setTotalWords(n)}
                  className={clsx(
                    'flex-1 py-2.5 rounded-xl text-sm font-bold border',
                    totalWords === n ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Per-Word Timer (display only)</p>
            <div className="flex gap-2">
              {PER_WORD_TIMER_OPTIONS.map((m) => (
                <button
                  key={m}
                  onClick={() => setTimerMode(m)}
                  className={clsx(
                    'flex-1 py-2.5 rounded-xl text-sm font-bold border',
                    timerMode === m ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {PER_WORD_TIMER_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Match Timer</p>
            <div className="flex gap-2">
              {MATCH_TIMER_OPTIONS.map((m) => (
                <button
                  key={m}
                  onClick={() => setMatchTimerMode(m)}
                  className={clsx(
                    'flex-1 py-2.5 rounded-xl text-sm font-bold border',
                    matchTimerMode === m ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {MATCH_TIMER_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
        >
          <span className="material-symbols-outlined">add_circle</span>
          {creating ? 'Creating…' : 'New Game'}
        </button>

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
          <p className="text-xs font-bold text-text-muted uppercase tracking-wider">Join by Code</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="e.g. K7XQ2R"
              maxLength={6}
              className="flex-1 bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none tracking-widest font-bold uppercase"
            />
            <button
              onClick={handleJoinByCode}
              disabled={joining || !joinCode.trim()}
              className="px-5 py-2 bg-primary/10 text-primary rounded-xl text-sm font-bold disabled:opacity-50"
            >
              {joining ? '…' : 'Join'}
            </button>
          </div>
        </div>

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">Your Games</h2>
          {loading && <p className="text-sm text-text-muted px-1">Loading…</p>}
          {!loading && myGames.length === 0 && <p className="text-sm text-text-muted italic px-1">No games in progress.</p>}
          <div className="space-y-2">
            {myGames.map((g) => (
              <div
                key={g.id}
                onClick={() => navigate(`/games/scramble-multiplayer/${g.id}`)}
                className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center justify-between cursor-pointer hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex -space-x-2">
                    {(g.players || []).map((p: any) => (
                      <div key={p.uid} className="w-8 h-8 rounded-full border-2 border-white bg-primary flex items-center justify-center text-white text-xs font-bold">
                        {p.displayName?.slice(0, 1) || '?'}
                      </div>
                    ))}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">
                      {g.status === 'waiting' ? 'Waiting for players' : 'In progress'}
                    </p>
                    <p className="text-[10px] text-text-muted uppercase font-bold tracking-wider">
                      Code: {g.code} · {g.wordLength}-letter · {g.totalWords} words
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {g.hostUid === user?.uid && g.status === 'waiting' && (
                    <button
                      onClick={(e) => handleDelete(e, g.id)}
                      disabled={deletingId === g.id}
                      className="p-2 text-error/70 disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  )}
                  <span className="material-symbols-outlined text-text-muted">chevron_right</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
