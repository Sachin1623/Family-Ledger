import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import { doc, updateDoc, collection, query, where } from 'firebase/firestore';
import { useDocument, useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useFriendships } from '../../lib/useFriendships';
import {
  ScrambleMultiplayerGameDoc,
  PER_WORD_TIMER_SECONDS,
  MATCH_TIMER_LABEL,
  MULTIPLAYER_MAX_HINTS,
  MULTIPLAYER_HINT_PENALTY,
  MULTIPLAYER_PASS_PENALTY,
  MULTIPLAYER_SHUFFLE_PENALTY,
  matchSecondsRemaining,
} from '../../lib/scrambleMultiplayer';
import { fetchWordDefinitions, WordDefinitionResult } from '../../lib/dictionaryLookup';
import InvitePicker from '../../components/InvitePicker';
import PresenceDot from '../../components/PresenceDot';
import ShareGameButton from '../../components/ShareGameButton';
import Fireworks from '../../components/Fireworks';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { VoiceChatButton, useGameVoice } from '../../components/GameVoiceChat';
import { SCRAMBLE_HELP } from '../../lib/gameHelp';

const TILE_COLORS = ['#0F7A38', '#B45309', '#B91C1C', '#1D4ED8', '#7C3AED', '#BE185D', '#0891B2', '#CA8A04', '#4D7C0F', '#C2410C'];
const DOUBLE_TAP_MS = 400;
const DRAG_MOVE_THRESHOLD = 10;

interface UiTile {
  id: string;
  letter: string;
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ScrambleMultiplayerGame() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { friendCandidates } = useFriendships(user?.uid);

  const [gameSnap] = useDocument(gameId ? doc(db, 'scrambleGames', gameId) : null);
  const game = gameSnap?.exists() ? (gameSnap.data() as ScrambleMultiplayerGameDoc) : null;
  const voice = useGameVoice('scrambleGames', gameId, game?.players || []);
  const [privateSnap] = useDocument(
    gameId && user && game?.status === 'active' ? doc(db, 'scrambleGames', gameId, 'private', user.uid) : null,
  );
  const hintPrefix: string = (privateSnap?.exists() ? privateSnap.data()?.hintPrefix : '') || '';

  const [groupsMembersValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = groupsMembersValue?.docs.map((d) => d.data().groupId) || [];

  const [showHelp, setShowHelp] = React.useState(false);
  const [showInvite, setShowInvite] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const [pool, setPool] = React.useState<UiTile[]>([]);
  const [answer, setAnswer] = React.useState<UiTile[]>([]);
  const [feedback, setFeedback] = React.useState<{ kind: 'already-used' | 'invalid'; key: number } | null>(null);
  const [lastAward, setLastAward] = React.useState<{ points: number; key: number } | null>(null);
  const [perWordStartedAt, setPerWordStartedAt] = React.useState(Date.now());
  const [dragGhost, setDragGhost] = React.useState<{ letter: string; x: number; y: number } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [hinting, setHinting] = React.useState(false);
  const [shuffling, setShuffling] = React.useState(false);
  const [passing, setPassing] = React.useState(false);
  const [revisitIndex, setRevisitIndex] = React.useState<number | null>(null);
  const [rematching, setRematching] = React.useState(false);
  const [revealDefs, setRevealDefs] = React.useState<Record<string, WordDefinitionResult>>({});
  const [revealLoading, setRevealLoading] = React.useState(false);
  const finalizedRef = React.useRef(false);

  const answerZoneRef = React.useRef<HTMLDivElement>(null);
  const dragStateRef = React.useRef<{ tile: UiTile; from: 'pool' | 'answer'; startX: number; startY: number } | null>(null);
  const lastTapRef = React.useRef<{ id: string; time: number } | null>(null);

  const myProgress = user && game?.progress ? game.progress[user.uid] : undefined;
  const myRoundIndex = myProgress?.roundIndex ?? 0;
  const myTileString = game?.roundTiles?.[myRoundIndex] || '';
  // While revisiting a passed word (see the "Passed Words" panel below), the pool/answer/hint area
  // shows THAT round's tiles instead of the player's actual current round — revisitIndex is purely
  // a local viewing choice, never written to `progress.roundIndex`, which must stay a monotonic
  // record of forward sequential progress.
  const activeRoundIndex = revisitIndex ?? myRoundIndex;
  const activeTileString = revisitIndex !== null ? game?.roundTiles?.[revisitIndex] || '' : myTileString;
  const activeTiles = activeTileString.split('');

  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  // A fresh round (or a switch into/out of revisiting a passed word) resets the tile arrangement
  // AND the soft per-word clock. Keyed on the actual tile STRING, not just the round index — while
  // the lobby is still "waiting", myRoundIndex defaults to 0 (no progress doc yet); once the match
  // starts, the real progress doc also starts at roundIndex 0, so the index alone never changes and
  // a reset keyed only on it would miss the waiting→active transition, leaving the pool stuck empty
  // from the pre-start render.
  React.useEffect(() => {
    setPool(activeTiles.map((letter, i) => ({ id: `${activeRoundIndex}-${i}`, letter })));
    setAnswer([]);
    setFeedback(null);
    setPerWordStartedAt(Date.now());
    // Scrolls back to the top of the page on every round change — without this, a player who
    // scrolled down to check "Everyone's Progress" mid-match stays scrolled down through the round
    // transition (React never resets scroll on its own), landing on the NEW round already
    // off-screen above the fold and forcing a scroll back up just to see it.
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoundIndex, activeTileString, gameId]);

  // Server clock is authoritative — this just nudges the match to actually finalize once the
  // deadline passes, in case nobody happens to submit/hint again after time's up.
  React.useEffect(() => {
    if (!gameId || !user || game?.status !== 'active' || finalizedRef.current) return;
    if (matchSecondsRemaining(game.matchEndsAt) > 0) return;
    finalizedRef.current = true;
    user.getIdToken().then((idToken) =>
      fetch('/api/scramble/finalize-if-expired', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId }),
      }).catch(() => {}),
    );
  }, [now, gameId, user, game?.status, game?.matchEndsAt]);

  // Once the match is finished and the server has revealed the full word sequence, fetch a
  // definition + example sentence for every word in one batch, shown on the results screen.
  React.useEffect(() => {
    if (!game || game.status !== 'finished' || !game.revealedWords || game.revealedWords.length === 0) return;
    setRevealLoading(true);
    fetchWordDefinitions(game.revealedWords)
      .then((defs) => setRevealDefs(defs))
      .finally(() => setRevealLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.status, game?.revealedWords?.join(',')]);

  if (!gameId) return null;
  if (!game) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface">
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    );
  }

  const players = game.players || [];
  const isHost = game.hostUid === user?.uid;
  const isPlayer = !!user && players.some((p) => p.uid === user.uid);
  const matchRemaining = matchSecondsRemaining(game.matchEndsAt);
  const perWordSeconds = PER_WORD_TIMER_SECONDS[game.timerMode] || 30;
  const perWordRemaining = Math.max(0, perWordSeconds - Math.floor((now - perWordStartedAt) / 1000));
  const guessWord = answer.map((t) => t.letter).join('');
  const iAmFinished = !!myProgress?.finished;
  const myPassedRounds = myProgress?.passedRounds || [];

  const callApi = async (path: string, body: any) => {
    if (!user) return null;
    const idToken = await user.getIdToken();
    const res = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Request failed.');
    return json;
  };

  const handleJoinGame = async () => {
    if (!user || isPlayer || players.length >= 4) return;
    setError(null);
    try {
      const newPlayer = {
        uid: user.uid,
        displayName: profile?.displayName || user.displayName || 'Player',
        photoURL: profile?.photoURL || user.photoURL || '',
        seatIndex: players.length,
      };
      await updateDoc(doc(db, 'scrambleGames', gameId!), {
        players: [...players, newPlayer],
        playerUids: [...(game.playerUids || []), user.uid],
      });
    } catch (err) {
      console.error('Failed to join Scramble game:', err);
      setError('Failed to join — the game may already be full or started.');
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await callApi('/api/scramble/start', { gameId });
    } catch (err: any) {
      setError(err.message || 'Failed to start game.');
    } finally {
      setStarting(false);
    }
  };

  const handleSubmit = async () => {
    if (!guessWord || submitting) return;
    if (revisitIndex === null && iAmFinished) return;
    setSubmitting(true);
    try {
      const result =
        revisitIndex !== null
          ? await callApi('/api/scramble/submit-passed', { gameId, roundIndex: revisitIndex, guess: guessWord })
          : await callApi('/api/scramble/submit', { gameId, guess: guessWord });
      if (result?.status === 'correct') {
        setLastAward({ points: result.pointsAwarded, key: Date.now() });
        if (revisitIndex !== null) setRevisitIndex(null);
      } else if (result?.status === 'invalid' || result?.status === 'already-used') {
        setFeedback({ kind: result.status, key: Date.now() });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to submit answer.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleHint = async () => {
    if (hinting || iAmFinished || revisitIndex !== null) return;
    setHinting(true);
    try {
      await callApi('/api/scramble/hint', { gameId });
    } catch (err: any) {
      setError(err.message || 'Failed to use hint.');
    } finally {
      setHinting(false);
    }
  };

  // Re-rolls the pool tiles' on-screen order immediately (same as single-player) while the small
  // point penalty is applied server-side in the background — the round's actual letter set never
  // changes, so there's nothing to wait on before showing the reshuffle.
  const handleShuffle = async () => {
    if (shuffling || pool.length < 2) return;
    setPool((p) => {
      const shuffled = p.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    });
    setShuffling(true);
    try {
      await callApi('/api/scramble/shuffle', { gameId });
    } catch (err: any) {
      setError(err.message || 'Failed to shuffle.');
    } finally {
      setShuffling(false);
    }
  };

  const handlePass = async () => {
    if (passing || iAmFinished || revisitIndex !== null) return;
    setPassing(true);
    try {
      await callApi('/api/scramble/pass', { gameId });
    } catch (err: any) {
      setError(err.message || 'Failed to pass this word.');
    } finally {
      setPassing(false);
    }
  };

  const handleRematch = async () => {
    if (rematching) return;
    setRematching(true);
    setError(null);
    try {
      const json = await callApi('/api/scramble/rematch', { gameId });
      if (json?.gameId) navigate(`/games/scramble-multiplayer/${json.gameId}`);
    } catch (err: any) {
      setError(err.message || 'Failed to start rematch.');
    } finally {
      setRematching(false);
    }
  };

  // Same unified tap/drag gesture handling as single-player Scramble — a stationary tap on a pool
  // tile adds it, a stationary tap on an answer tile needs a SECOND tap within DOUBLE_TAP_MS to
  // remove it (so a wrong-guess recovery tap can't fire by accident), and a real drag skips the
  // double-tap requirement in either direction.
  const handleTileDown = (e: React.PointerEvent<HTMLDivElement>, tile: UiTile, from: 'pool' | 'answer') => {
    if (revisitIndex === null && iAmFinished) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = { tile, from, startX: e.clientX, startY: e.clientY };
    setDragGhost({ letter: tile.letter, x: e.clientX, y: e.clientY });
  };

  const handleTileMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    setDragGhost({ letter: dragStateRef.current.tile.letter, x: e.clientX, y: e.clientY });
  };

  const handleTileUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    setDragGhost(null);
    if (!drag || (revisitIndex === null && iAmFinished)) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const moved = Math.hypot(dx, dy) > DRAG_MOVE_THRESHOLD;

    if (!moved) {
      if (drag.from === 'pool') {
        setPool((p) => p.filter((t) => t.id !== drag.tile.id));
        setAnswer((a) => [...a, drag.tile]);
        setFeedback(null);
      } else {
        const tapNow = Date.now();
        const last = lastTapRef.current;
        if (last && last.id === drag.tile.id && tapNow - last.time < DOUBLE_TAP_MS) {
          setAnswer((a) => a.filter((t) => t.id !== drag.tile.id));
          setPool((p) => [...p, drag.tile]);
          lastTapRef.current = null;
        } else {
          lastTapRef.current = { id: drag.tile.id, time: tapNow };
        }
      }
      return;
    }

    const rect = answerZoneRef.current?.getBoundingClientRect();
    const overAnswerZone = !!rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (drag.from === 'pool' && overAnswerZone) {
      setPool((p) => p.filter((t) => t.id !== drag.tile.id));
      setAnswer((a) => [...a, drag.tile]);
      setFeedback(null);
    } else if (drag.from === 'answer' && !overAnswerZone) {
      setAnswer((a) => a.filter((t) => t.id !== drag.tile.id));
      setPool((p) => [...p, drag.tile]);
    }
  };

  const progressByUid = game.progress || {};
  const ranked = [...players].sort((a, b) => (progressByUid[b.uid]?.score || 0) - (progressByUid[a.uid]?.score || 0));
  const canPlayNow = isPlayer && (revisitIndex !== null || !iAmFinished);

  // Only confirms while there's actually something to walk away from — a live match this player
  // hasn't finished their own words in yet. The match itself lives in Firestore regardless (this
  // player can always come back via "Your Games" in the lobby while it's still active), so this is
  // guarding against an accidental tap during a live race, not warning about real data loss.
  const handleExit = () => {
    if (game.status === 'active' && isPlayer && !iAmFinished) {
      if (!window.confirm("Leave this match? It's still live — you can rejoin from Scramble Multiplayer's \"Your Games\" list while it's in progress.")) return;
    }
    navigate('/games/scramble-multiplayer');
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      {/* Header + (while actively playing) the core play controls share one sticky block pinned to
          the top of the viewport — this is what keeps the play area always in view: no matter how
          tall "Everyone's Progress" grows below it, the word/letters/buttons never scroll out of
          reach, and there's no fragile pixel-offset math needed for a second sticky region. */}
      <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm border-b border-border-subtle pt-[env(safe-area-inset-top)]">
        <div className="max-w-xl mx-auto w-full p-4 flex items-center justify-between gap-2">
          <button onClick={handleExit} className="text-xs font-bold text-primary flex items-center gap-1 shrink-0">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            Scramble
          </button>
          {game.status === 'active' && (
            <div className="flex items-center gap-1.5">
              <div
                className={clsx(
                  'px-3 py-1.5 rounded-full text-sm font-black tabular-nums',
                  matchRemaining <= 15 ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary',
                )}
                title="Overall match timer"
              >
                {formatClock(matchRemaining)}
              </div>
              <div className="px-2.5 py-1.5 rounded-full text-xs font-bold text-text-muted bg-surface border border-border-subtle" title="Per-word timer (no penalty)">
                {formatClock(perWordRemaining)}
              </div>
            </div>
          )}
          <VoiceChatButton voice={voice} />
          <HelpButton onClick={() => setShowHelp(true)} />
        </div>

        {game.status === 'active' && canPlayNow && (
          <div className="max-w-xl mx-auto w-full px-3 pb-3 space-y-2">
            <div className="flex items-center justify-around text-center">
              <div>
                <p className="text-xl font-black text-primary leading-tight">{myProgress?.score ?? 0}</p>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Score</p>
              </div>
              <div>
                <p className="text-xl font-black text-on-surface leading-tight">{myProgress?.solvedCount ?? 0}/{game.totalWords}</p>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Solved</p>
              </div>
              <div>
                <p className="text-xl font-black text-on-surface leading-tight">{game.wordLength}</p>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Letters</p>
              </div>
            </div>

            {revisitIndex !== null && (
              <div className="flex items-center justify-between bg-warning/10 rounded-xl px-3 py-1.5">
                <p className="text-[11px] font-bold text-warning">Revisiting Word #{revisitIndex + 1}</p>
                <button onClick={() => setRevisitIndex(null)} className="text-[11px] font-bold text-primary">
                  Back to current
                </button>
              </div>
            )}

            <div>
              <motion.div
                ref={answerZoneRef}
                animate={feedback ? { x: [0, -8, 8, -8, 0] } : {}}
                transition={{ duration: 0.35 }}
                className={clsx(
                  'relative min-h-[48px] rounded-xl border-2 border-dashed p-2 flex flex-wrap items-center gap-1.5',
                  feedback ? 'border-error/50 bg-error/5' : 'border-border-subtle bg-white',
                )}
              >
                {answer.length === 0 && <p className="text-xs text-text-muted italic px-1">Tap or drag letters here…</p>}
                {answer.map((tile) => (
                  <div
                    key={tile.id}
                    onPointerDown={(e) => handleTileDown(e, tile, 'answer')}
                    onPointerMove={handleTileMove}
                    onPointerUp={handleTileUp}
                    style={{ touchAction: 'none' }}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center text-white font-black text-base sm:text-lg uppercase shadow-sm cursor-pointer select-none bg-primary"
                  >
                    {tile.letter}
                  </div>
                ))}
                <AnimatePresence>
                  {lastAward && (
                    <motion.p
                      key={lastAward.key}
                      initial={{ opacity: 0, y: 0, scale: 0.8 }}
                      animate={{ opacity: 1, y: -30, scale: 1.1 }}
                      exit={{ opacity: 0 }}
                      onAnimationComplete={() => setLastAward(null)}
                      className="absolute top-1 right-3 text-success font-black text-lg pointer-events-none"
                    >
                      +{lastAward.points}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>
              <AnimatePresence mode="wait">
                {feedback && (
                  <motion.p
                    key={feedback.key}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-xs font-bold text-center text-error mt-1"
                  >
                    {feedback.kind === 'invalid' ? "Not a valid word — double-tap a letter to send it back." : 'Already used this match — double-tap a letter to try again.'}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            <div className="bg-white rounded-xl border border-border-subtle p-2.5 flex flex-wrap items-center justify-center gap-1.5 min-h-[56px]">
              {pool.map((tile, i) => (
                <motion.div
                  key={tile.id}
                  layout
                  onPointerDown={(e) => handleTileDown(e, tile, 'pool')}
                  onPointerMove={handleTileMove}
                  onPointerUp={handleTileUp}
                  style={{ touchAction: 'none', backgroundColor: TILE_COLORS[i % TILE_COLORS.length] }}
                  initial={{ opacity: 0, scale: 0.5, rotate: -10 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center text-white font-black text-base sm:text-lg uppercase shadow-sm cursor-pointer select-none"
                >
                  {tile.letter}
                </motion.div>
              ))}
            </div>

            {revisitIndex === null && hintPrefix.length > 0 && (
              <p className="text-center text-xs text-text-muted">
                Hint: <span className="font-black text-primary tracking-widest uppercase">{hintPrefix}{'_'.repeat(Math.max(0, game.wordLength - hintPrefix.length))}</span>
              </p>
            )}

            <button
              onClick={handleSubmit}
              disabled={!guessWord || submitting}
              className="w-full py-2.5 bg-primary text-white rounded-xl text-sm font-bold disabled:opacity-40"
            >
              Submit
            </button>

            {revisitIndex === null && (
              <>
                <div className="flex gap-2">
                  <button
                    onClick={handleShuffle}
                    disabled={shuffling || pool.length < 2}
                    className="flex-1 py-2 rounded-xl text-xs font-bold text-primary bg-primary/5 disabled:opacity-40 flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">shuffle</span>
                    Shuffle (-{MULTIPLAYER_SHUFFLE_PENALTY} pt)
                  </button>
                  <button
                    onClick={handleHint}
                    disabled={hinting || (myProgress?.hintsUsedTotal ?? 0) >= MULTIPLAYER_MAX_HINTS}
                    className="flex-1 py-2 rounded-xl text-xs font-bold text-primary bg-primary/5 disabled:opacity-40 flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">lightbulb</span>
                    Hint ({MULTIPLAYER_MAX_HINTS - (myProgress?.hintsUsedTotal ?? 0)} left, -{MULTIPLAYER_HINT_PENALTY} pts)
                  </button>
                </div>
                <button
                  onClick={handlePass}
                  disabled={passing}
                  className="w-full py-2 rounded-xl text-xs font-bold text-error bg-error/5 disabled:opacity-40 flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">skip_next</span>
                  Pass Word (-{MULTIPLAYER_PASS_PENALTY} pts)
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}
      {error && <p className="text-xs font-bold text-error px-4 pt-2 max-w-xl mx-auto w-full">{error}</p>}

      <main className="flex-1 p-3 max-w-xl mx-auto w-full space-y-2.5 pb-10">
        {game.status === 'waiting' && (
          <>
            <div className="bg-white rounded-2xl border border-border-subtle p-5 flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Share code</p>
                <p className="text-2xl font-black text-primary tracking-widest">{game.code}</p>
                <p className="text-[10px] text-text-muted mt-1">{game.wordLength}-letter · {game.totalWords} words · {MATCH_TIMER_LABEL[game.matchTimerMode]}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => navigator.clipboard?.writeText(game.code)}
                  className="px-3 py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[14px]">content_copy</span> Copy
                </button>
                <ShareGameButton
                  gameLabel="Scramble"
                  code={game.code}
                  path={`/games/scramble-multiplayer/${gameId}`}
                  className="px-3 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1"
                />
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
              {players.map((p) => (
                <div key={p.uid} className="p-4 flex items-center gap-3">
                  <div className="relative w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold overflow-hidden shrink-0">
                    {p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : p.displayName?.slice(0, 1) || '?'}
                    <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                  </div>
                  <p className="text-sm font-bold text-on-surface">{p.displayName}</p>
                  {p.uid === game.hostUid && <span className="ml-auto text-[10px] font-bold text-primary uppercase">Host</span>}
                </div>
              ))}
              {Array.from({ length: Math.max(0, 2 - players.length) }).map((_, i) => (
                <div key={i} className="p-4 flex items-center gap-3 opacity-40">
                  <div className="w-9 h-9 rounded-full border-2 border-dashed border-border-subtle" />
                  <p className="text-sm text-text-muted italic">Waiting for player…</p>
                </div>
              ))}
            </div>

            {!isPlayer && user && players.length < 4 && (
              <button onClick={handleJoinGame} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
                Join Game
              </button>
            )}

            {isPlayer && (
              <button
                onClick={() => setShowInvite((v) => !v)}
                className="w-full py-2.5 border border-border-subtle text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">group_add</span>
                Invite Group Members
              </button>
            )}

            {isPlayer && showInvite && (
              <InvitePicker
                groupIds={groupIds}
                alreadyIn={players.map((p) => p.uid)}
                onInvite={async (uids, poke) => {
                  await callApi('/api/scramble/invite', { gameId, inviteeUids: uids, poke });
                }}
                extraCandidates={friendCandidates}
              />
            )}

            {isHost ? (
              <button
                onClick={handleStart}
                disabled={starting || players.length < 2}
                className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
              >
                {starting ? 'Starting…' : players.length < 2 ? 'Need 2+ players' : 'Start Game'}
              </button>
            ) : (
              <p className="text-center text-xs text-text-muted">Waiting for the host to start the game…</p>
            )}
          </>
        )}

        {game.status === 'active' && !isPlayer && (
          <div className="bg-white rounded-2xl border border-border-subtle p-5 text-center">
            <p className="text-sm text-text-muted">This match already started before you joined — you can still watch everyone's progress below.</p>
          </div>
        )}

        {game.status === 'active' && (
          <>
            {isPlayer && iAmFinished && revisitIndex === null && (
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 text-center">
                <p className="text-sm font-bold text-primary">You've solved every word — waiting on the others to finish or time to run out.</p>
              </div>
            )}

            {isPlayer && myPassedRounds.length > 0 && (
              <div className="bg-warning/5 border border-warning/20 rounded-xl p-2.5 space-y-1.5">
                <p className="text-[10px] font-bold text-warning uppercase tracking-wider">Passed Words — Revisit for +10 pts each</p>
                <div className="flex flex-wrap gap-1.5">
                  {myPassedRounds.map((ri) => (
                    <button
                      key={ri}
                      onClick={() => setRevisitIndex(ri)}
                      disabled={revisitIndex === ri}
                      className={clsx(
                        'px-2.5 py-1 rounded-lg border text-[11px] font-bold',
                        revisitIndex === ri ? 'bg-warning text-white border-warning' : 'bg-white border-warning/30 text-warning',
                      )}
                    >
                      Word #{ri + 1}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <section className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Everyone's Progress</p>
              <div className="bg-white rounded-xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
                {ranked.map((p) => {
                  const pr = progressByUid[p.uid];
                  const pct = Math.min(100, Math.round(((pr?.roundIndex ?? 0) / game.totalWords) * 100));
                  return (
                    <div key={p.uid} className="p-2 flex items-center gap-2">
                      <div className="relative w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-[10px] font-bold overflow-hidden shrink-0">
                        {p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : p.displayName?.slice(0, 1) || '?'}
                        <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-on-surface truncate">
                          {p.displayName}{p.uid === user?.uid && ' (You)'}
                          {pr?.finished && <span className="ml-1 text-success">✓</span>}
                        </p>
                        <div className="h-1 bg-surface rounded-full overflow-hidden mt-0.5">
                          <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-black text-primary">{pr?.score ?? 0}</p>
                        <p className="text-[9px] text-text-muted">{pr?.solvedCount ?? 0} solved · {pr?.wrongGuesses ?? 0} wrong</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {game.status === 'finished' && (
          <>
            <div className="relative bg-white rounded-3xl border border-border-subtle p-6 text-center space-y-2 overflow-hidden">
              {game.winnerUid && <Fireworks />}
              <p className="relative text-xs font-bold text-text-muted uppercase tracking-wider">Winner</p>
              <p className="relative text-2xl font-black text-primary">
                {players.find((p) => p.uid === game.winnerUid)?.displayName || '—'}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
              {ranked.map((p, idx) => {
                const pr = progressByUid[p.uid];
                return (
                  <div key={p.uid} className={clsx('p-4 flex items-center gap-3', p.uid === game.winnerUid && 'bg-primary/5')}>
                    <span className="w-6 text-center text-sm font-black text-text-muted">{idx + 1}</span>
                    <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
                      {p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : p.displayName?.slice(0, 1) || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-on-surface truncate">{p.displayName}{p.uid === user?.uid && ' (You)'}</p>
                      <p className="text-[10px] text-text-muted">
                        {pr?.solvedCount ?? 0}/{game.totalWords} solved · {pr?.wrongGuesses ?? 0} wrong · {pr?.hintsUsedTotal ?? 0} hints
                        {(pr?.passedRounds?.length ?? 0) > 0 && <> · {pr!.passedRounds!.length} passed</>}
                      </p>
                    </div>
                    <p className="text-sm font-black text-primary shrink-0">{pr?.score ?? 0}</p>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <button onClick={() => navigate('/games/scramble-multiplayer')} className="flex-1 py-3.5 rounded-2xl text-sm font-bold text-text-muted border border-border-subtle">
                Back to Lobby
              </button>
              {isPlayer && (
                <button
                  onClick={() => (game.rematchGameId ? navigate(`/games/scramble-multiplayer/${game.rematchGameId}`) : handleRematch())}
                  disabled={rematching}
                  className="flex-1 py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
                >
                  {game.rematchGameId ? 'Join Rematch' : rematching ? 'Starting…' : 'Quick Rematch'}
                </button>
              )}
            </div>

            <section className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
                Every Word This Match{revealLoading && ' — loading definitions…'}
              </p>
              {!game.revealedWords || game.revealedWords.length === 0 ? (
                <p className="text-xs text-text-muted italic px-1">Word list is still being revealed…</p>
              ) : (
                <div className="space-y-1.5">
                  {game.revealedWords.map((w, i) => {
                    const def = revealDefs[w.toLowerCase()];
                    return (
                      <div key={i} className="bg-white rounded-xl border border-border-subtle p-3 space-y-1">
                        <p className="text-xs font-black text-primary uppercase tracking-wide">
                          #{i + 1} · {w}
                        </p>
                        {def?.status === 'found' ? (
                          <>
                            <p className="text-xs text-on-surface leading-snug">{def.definition.meaning}</p>
                            {def.definition.example && <p className="text-[11px] text-text-muted italic leading-snug">"{def.definition.example}"</p>}
                          </>
                        ) : def?.status === 'error' ? (
                          <p className="text-[11px] text-warning italic">Couldn't load a definition — check your connection.</p>
                        ) : (
                          !revealLoading && <p className="text-[11px] text-text-muted italic">No dictionary definition found.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {dragGhost && (
        <div
          className="fixed z-[300] w-12 h-12 rounded-xl flex items-center justify-center text-white font-black text-xl uppercase shadow-lg pointer-events-none bg-primary"
          style={{ left: dragGhost.x - 24, top: dragGhost.y - 24 }}
        >
          {dragGhost.letter}
        </div>
      )}
    </div>
  );
}
