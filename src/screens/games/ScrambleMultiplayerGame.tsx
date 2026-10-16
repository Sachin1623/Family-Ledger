import React from 'react';
import WaitingRoom from '../../components/WaitingRoom';
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
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';
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
  const [lastSolved, setLastSolved] = React.useState<{ word: string; points: number; key: number } | null>(null);
  React.useEffect(() => {
    if (!lastSolved) return;
    const t = setTimeout(() => setLastSolved(null), 800);
    return () => clearTimeout(t);
  }, [lastSolved]);
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
        setLastSolved({ word: guessWord, points: result.pointsAwarded, key: Date.now() });
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

  if (game.status === 'waiting') {
    return (
      <>
        {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}
        <WaitingRoom
          title="Scramble race"
          modeLabel={`${game.wordLength}-letter · ${game.totalWords} words · ${MATCH_TIMER_LABEL[game.matchTimerMode]}`}
          backTo="/games/scramble-multiplayer"
          headerActions={
            <>
              <VoiceChatButton voice={voice} />
              <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
            </>
          }
          code={game.code}
          shareLabel="Scramble"
          sharePath={`/games/scramble-multiplayer/${gameId}`}
          players={players.map((p) => ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL }))}
          maxPlayers={4}
          minToStart={2}
          hostUid={game.hostUid}
          myUid={user?.uid}
          isPlayer={isPlayer}
          joinLabel="Join game"
          onJoin={handleJoinGame}
          onStart={handleStart}
          startLabel="Start race"
          startBusy={starting}
          invitePicker={
            <InvitePicker
              groupIds={groupIds}
              alreadyIn={players.map((p) => p.uid)}
              onInvite={async (uids, poke) => {
                await callApi('/api/scramble/invite', { gameId, inviteeUids: uids, poke });
              }}
              extraCandidates={friendCandidates}
            />
          }
          error={error}
        />
      </>
    );
  }

  const tileFace = 'bg-gradient-to-b from-[#fff3c9] to-[#f1d27a] text-[#3a2a00] shadow-[0_5px_0_#b88a1d,0_9px_14px_rgba(0,0,0,0.45)]';
  const wordFrac = Math.max(0, Math.min(1, perWordRemaining / perWordSeconds));
  const wordUrgent = perWordRemaining <= 5;
  const ringColor = wordUrgent ? '#ff4d5e' : '#f5c451';
  const medal = (idx: number) => (idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}`);
  const slotCount = game.wordLength;
  const hintShown = revisitIndex === null ? hintPrefix : '';
  const winnerPlayer = players.find((p) => p.uid === game.winnerUid);
  const iWon = !!user && !!winnerPlayer && winnerPlayer.uid === user.uid;
  const confetti = Array.from({ length: 34 }).map((_, i) => {
    const ang = (i / 34) * Math.PI * 2 + (i % 3) * 0.2;
    const dist = 110 + ((i * 37) % 100);
    return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, color: ['#fbbf24', '#f87171', '#60a5fa', '#4ade80', '#fff', '#c084fc'][i % 6], delay: (i % 7) * 0.04, rot: (i * 57) % 360 };
  });

  const avatar = (p: (typeof players)[number], size = 'w-7 h-7 text-[10px]') => (
    <div className={clsx('relative shrink-0 rounded-full bg-slate-600 flex items-center justify-center font-black', size)}>
      <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
        {p.photoURL ? <img src={p.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : p.displayName?.slice(0, 1) || '?'}
      </div>
      <PresenceDot uid={p.uid} className="absolute -bottom-0.5 -right-0.5 w-2 h-2" />
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}

      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#1d2b57_0%,#0c1230_55%,#070a18_100%)]">
        <style>{`
          @keyframes mpTile{0%{transform:scale(.6) rotate(-8deg);opacity:0}60%{transform:scale(1.15) rotate(2deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
          @keyframes solvedPill{0%{transform:translateY(8px) scale(.7);opacity:0}25%{transform:translateY(0) scale(1.08);opacity:1}100%{transform:translateY(-14px) scale(1);opacity:0}}
          @keyframes mpPts{0%{transform:translateY(24px) scale(.3);opacity:0}30%{transform:translateY(0) scale(1.25);opacity:1}100%{transform:translateY(-34px) scale(1);opacity:0}}
          @keyframes mpBurst{0%{transform:translate(0,0) rotate(0) scale(.4);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
          @keyframes mpRise{0%{transform:translateY(16px);opacity:0}100%{transform:translateY(0);opacity:1}}
        `}</style>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={handleExit} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">Scramble</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">
              {game.status === 'finished' ? 'MATCH OVER' : `RACE · WORD ${Math.min(game.totalWords, (myProgress?.roundIndex ?? 0) + 1)} OF ${game.totalWords}`}
            </span>
          </div>
          <div className="flex-1" />
          {game.status === 'active' && (
            <div className={clsx('px-2.5 py-1 rounded-full text-sm font-black tabular-nums border', matchRemaining <= 15 ? 'bg-red-500/20 text-red-300 border-red-400/40 animate-pulse' : 'bg-white/10 text-white border-white/15')} title="Overall match timer">
              {formatClock(matchRemaining)}
            </div>
          )}
          <VoiceChatButton voice={voice} />
          <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
        </header>

        {error && <p className="relative text-xs font-bold text-red-300 px-4 pt-1">{error}</p>}

        <main className="relative flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-6 flex flex-col gap-3 max-w-md mx-auto w-full">

          {game.status === 'active' && (
            <>
              {/* live scoreboard */}
              <div className="flex flex-col gap-1.5">
                {ranked.map((p, idx) => {
                  const pr = progressByUid[p.uid];
                  const pct = Math.min(100, Math.round(((pr?.roundIndex ?? 0) / game.totalWords) * 100));
                  const me = p.uid === user?.uid;
                  return (
                    <div key={p.uid} className={clsx('flex items-center gap-2 rounded-2xl px-2.5 py-1.5 border-[1.5px] bg-[#121a2e]', me ? 'border-amber-300 shadow-[0_0_14px_rgba(245,196,81,0.25)]' : 'border-[#1f2a47]')}>
                      <span className="w-5 text-center text-sm">{medal(idx)}</span>
                      {avatar(p)}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-extrabold truncate">{me ? 'You' : p.displayName}{pr?.finished && <span className="ml-1 text-emerald-300">✓</span>}</p>
                        <div className="h-1.5 bg-[#1f2a47] rounded-full overflow-hidden mt-0.5">
                          <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-200 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="text-right shrink-0 leading-tight">
                        <p className={clsx('text-sm font-black tabular-nums', me ? 'text-amber-300' : 'text-white')}>{pr?.score ?? 0}</p>
                        <p className="text-[8.5px] font-bold text-white/45">{pr?.solvedCount ?? 0} solved</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {!isPlayer && (
                <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] p-4 text-center text-xs text-white/70">This match already started before you joined — you can still watch everyone's progress above.</div>
              )}

              {isPlayer && iAmFinished && revisitIndex === null && (
                <div className="rounded-2xl bg-emerald-500/10 border border-emerald-400/30 p-3 text-center text-sm font-extrabold text-emerald-200">
                  You've solved every word — waiting on the others to finish or time to run out.
                </div>
              )}

              {canPlayNow && (
                <>
                  {revisitIndex !== null && (
                    <div className="flex items-center justify-between rounded-2xl bg-amber-400/10 border border-amber-300/30 px-3 py-1.5">
                      <p className="text-[11px] font-extrabold text-amber-300">Revisiting Word #{revisitIndex + 1}</p>
                      <button onClick={() => setRevisitIndex(null)} className="text-[11px] font-extrabold text-white">Back to current</button>
                    </div>
                  )}

                  <div className="self-center w-[84px] h-[84px] rounded-full flex items-center justify-center shrink-0" style={{ background: `conic-gradient(${ringColor} ${wordFrac * 360}deg, #1f2a47 0deg)` }}>
                    <div className={clsx('w-[66px] h-[66px] rounded-full bg-[#0c1230] flex flex-col items-center justify-center', wordUrgent && 'animate-pulse')}>
                      <p className="text-[20px] font-black tabular-nums leading-none" style={{ color: wordUrgent ? '#ff8a96' : '#fff' }}>{formatClock(perWordRemaining)}</p>
                      <p className="text-[7px] font-extrabold tracking-[0.14em] text-white/50 mt-0.5">THIS WORD</p>
                    </div>
                  </div>

                  <div>
                    <motion.div ref={answerZoneRef} animate={feedback ? { x: [0, -8, 8, -8, 0] } : {}} transition={{ duration: 0.35 }} className="relative flex justify-center gap-2 flex-wrap">
                      {Array.from({ length: Math.max(slotCount, answer.length) }).map((_, i) => {
                        const tile = answer[i];
                        const hinted = !tile && i < hintShown.length;
                        return tile ? (
                          <div
                            key={tile.id}
                            onPointerDown={(e) => handleTileDown(e, tile, 'answer')}
                            onPointerMove={handleTileMove}
                            onPointerUp={handleTileUp}
                            style={{ touchAction: 'none' }}
                            className={clsx('w-[50px] h-[56px] rounded-2xl flex items-center justify-center font-black text-[27px] uppercase cursor-pointer select-none', tileFace, feedback && '!from-[#ffd0d4] !to-[#ff8a96]')}
                          >
                            {tile.letter}
                          </div>
                        ) : (
                          <div key={`slot-${i}`} className={clsx('w-[50px] h-[56px] rounded-2xl border-2 border-dashed flex items-center justify-center font-black text-[27px] uppercase', hinted ? 'border-emerald-400/70 bg-emerald-500/10 text-emerald-300/70' : 'border-[#2c3a63] bg-[#0e1632]')}>
                            {hinted ? hintShown[i] : ''}
                          </div>
                        );
                      })}
                      <AnimatePresence>
                        {lastAward && (
                          <motion.p key={lastAward.key} initial={{ opacity: 0, y: 0, scale: 0.8 }} animate={{ opacity: 1, y: -30, scale: 1.1 }} exit={{ opacity: 0 }} onAnimationComplete={() => setLastAward(null)} className="absolute -top-2 right-2 text-emerald-300 font-black text-xl pointer-events-none">
                            +{lastAward.points}
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </motion.div>
                    <div className="h-5 mt-2 text-center">
                      {feedback ? (
                        <p className="text-[11px] font-bold text-red-300">{feedback.kind === 'invalid' ? 'Not a valid word — double-tap a letter to send it back.' : 'Already used this match — double-tap a letter to try again.'}</p>
                      ) : hintShown.length > 0 ? (
                        <p className="text-[11px] font-bold text-white/55">Hint: <span className="font-black text-emerald-300 tracking-[0.25em] uppercase">{hintShown}{'_'.repeat(Math.max(0, game.wordLength - hintShown.length))}</span></p>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-3xl bg-[#0e1632] border border-[#1f2a47] p-3.5 flex flex-wrap items-center justify-center gap-2.5 min-h-[84px]">
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
                        className="w-[52px] h-[58px] rounded-2xl flex items-center justify-center text-white font-black text-[27px] uppercase cursor-pointer select-none shadow-[0_5px_0_rgba(0,0,0,0.35),0_9px_14px_rgba(0,0,0,0.5)]"
                      >
                        {tile.letter}
                      </motion.div>
                    ))}
                  </div>

                  <button onClick={handleSubmit} disabled={!guessWord || submitting} className={clsx('w-full py-3.5 rounded-2xl text-[15px] font-black transition-transform active:translate-y-0.5', guessWord && !submitting ? 'bg-gradient-to-r from-amber-300 to-amber-200 text-[#1a1300] shadow-[0_5px_0_#b88a1d]' : 'bg-[#1b2543] text-[#5d6c92]')}>
                    Submit
                  </button>

                  {revisitIndex === null && (
                    <div className="grid grid-cols-3 gap-2">
                      <button onClick={handleShuffle} disabled={shuffling || pool.length < 2} className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2.5 text-[11px] font-extrabold text-slate-200 disabled:opacity-40">
                        <span className="material-symbols-outlined text-[18px] block mx-auto">shuffle</span>Shuffle<span className="block text-[8.5px] text-white/45 font-bold">−{MULTIPLAYER_SHUFFLE_PENALTY} pt</span>
                      </button>
                      <button onClick={handleHint} disabled={hinting || (myProgress?.hintsUsedTotal ?? 0) >= MULTIPLAYER_MAX_HINTS} className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2.5 text-[11px] font-extrabold text-slate-200 disabled:opacity-40">
                        <span className="material-symbols-outlined text-[18px] block mx-auto">lightbulb</span>Hint<span className="block text-[8.5px] text-white/45 font-bold">{MULTIPLAYER_MAX_HINTS - (myProgress?.hintsUsedTotal ?? 0)} left · −{MULTIPLAYER_HINT_PENALTY}</span>
                      </button>
                      <button onClick={handlePass} disabled={passing} className="rounded-2xl bg-[#2a1520] border border-[#4a2030] py-2.5 text-[11px] font-extrabold text-red-300 disabled:opacity-40">
                        <span className="material-symbols-outlined text-[18px] block mx-auto">skip_next</span>Pass<span className="block text-[8.5px] text-red-300/60 font-bold">−{MULTIPLAYER_PASS_PENALTY} pts</span>
                      </button>
                    </div>
                  )}
                </>
              )}

              {isPlayer && myPassedRounds.length > 0 && (
                <div className="rounded-2xl bg-amber-400/10 border border-amber-300/25 p-2.5 space-y-1.5">
                  <p className="text-[10px] font-extrabold tracking-[0.1em] text-amber-300 uppercase">Passed words — revisit for +10 pts each</p>
                  <div className="flex flex-wrap gap-1.5">
                    {myPassedRounds.map((ri) => (
                      <button key={ri} onClick={() => setRevisitIndex(ri)} disabled={revisitIndex === ri} className={clsx('px-2.5 py-1 rounded-lg border text-[11px] font-extrabold', revisitIndex === ri ? 'bg-amber-300 text-amber-950 border-amber-300' : 'bg-white/5 border-amber-300/30 text-amber-200')}>
                        Word #{ri + 1}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {game.status === 'finished' && (
            <>
              <div className="relative rounded-3xl bg-[#0c1230]/90 border border-white/10 p-5 text-center space-y-1.5 overflow-hidden">
                {game.winnerUid && iWon && (
                  <div className="absolute left-1/2 top-[35%] pointer-events-none">
                    {confetti.map((c, i) => (
                      <i key={i} className="absolute block w-2 h-3 rounded-[2px]" style={{ background: c.color, ['--dx' as any]: `${c.dx}px`, ['--dy' as any]: `${c.dy}px`, ['--rot' as any]: `${c.rot}deg`, animation: `mpBurst 1.4s ease-out ${0.3 + c.delay}s both` }} />
                    ))}
                  </div>
                )}
                <p className="relative text-[11px] font-extrabold tracking-[0.18em] text-amber-300">{iWon ? 'VICTORY' : game.winnerUid ? 'WINNER' : 'MATCH OVER'}</p>
                <p className="relative text-5xl" style={{ animation: 'mpTile 0.6s cubic-bezier(.3,1.4,.5,1) both' }}>{game.winnerUid ? '🏆' : '🏁'}</p>
                <p className="relative text-2xl font-black">{winnerPlayer?.displayName || '—'}</p>
                {winnerPlayer && <p className="relative text-xs font-bold text-white/60">{progressByUid[winnerPlayer.uid]?.score ?? 0} pts · {progressByUid[winnerPlayer.uid]?.solvedCount ?? 0}/{game.totalWords} words</p>}
                {(() => {
                  if (!user || !winnerPlayer || !iWon) return null;
                  const top = progressByUid[winnerPlayer.uid]?.score ?? 0;
                  const second = ranked.find((p) => p.uid !== winnerPlayer.uid);
                  const share = buildWinShare({
                    gameName: 'Word Scramble',
                    winnerLabel: winnerPlayer.displayName,
                    standings: ranked.map((p) => ({ name: p.displayName, score: progressByUid[p.uid]?.score ?? 0, isWinner: p.uid === game.winnerUid })),
                    detail: `${progressByUid[winnerPlayer.uid]?.solvedCount ?? 0}/${game.totalWords} words solved`,
                    scoreLine: `${top} pts${second ? ` vs ${progressByUid[second.uid]?.score ?? 0}` : ''}`,
                  });
                  return <ShareWinButton card={share.card} caption={share.caption} className="relative pt-2" />;
                })()}
              </div>

              <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] divide-y divide-[#1f2a47] overflow-hidden">
                {ranked.map((p, idx) => {
                  const pr = progressByUid[p.uid];
                  return (
                    <div key={p.uid} className={clsx('p-3 flex items-center gap-3', p.uid === game.winnerUid && 'bg-amber-300/10')}>
                      <span className="w-6 text-center text-sm">{medal(idx)}</span>
                      {avatar(p, 'w-9 h-9 text-xs')}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-extrabold truncate">{p.displayName}{p.uid === user?.uid && ' (You)'}</p>
                        <p className="text-[10px] text-white/50">
                          {pr?.solvedCount ?? 0}/{game.totalWords} solved · {pr?.wrongGuesses ?? 0} wrong · {pr?.hintsUsedTotal ?? 0} hints
                          {(pr?.passedRounds?.length ?? 0) > 0 && <> · {pr!.passedRounds!.length} passed</>}
                        </p>
                      </div>
                      <p className="text-base font-black text-amber-300 shrink-0 tabular-nums">{pr?.score ?? 0}</p>
                    </div>
                  );
                })}
              </div>

              <div className="flex gap-2">
                <button onClick={() => navigate('/games/scramble-multiplayer')} className="flex-1 py-3.5 rounded-2xl text-sm font-extrabold text-white bg-white/10 border border-white/15">Back to Lobby</button>
                {isPlayer && (
                  <button onClick={() => (game.rematchGameId ? navigate(`/games/scramble-multiplayer/${game.rematchGameId}`) : handleRematch())} disabled={rematching} className="flex-1 py-3.5 bg-gradient-to-r from-emerald-500 to-emerald-400 text-emerald-950 font-black rounded-2xl disabled:opacity-50">
                    {game.rematchGameId ? 'Join Rematch' : rematching ? 'Starting…' : 'Quick Rematch'}
                  </button>
                )}
              </div>

              <section className="space-y-1.5">
                <p className="text-[10px] font-extrabold tracking-[0.14em] text-white/55 px-1">EVERY WORD THIS MATCH{revealLoading && ' — LOADING MEANINGS…'}</p>
                {!game.revealedWords || game.revealedWords.length === 0 ? (
                  <p className="text-xs text-white/45 italic px-1">Word list is still being revealed…</p>
                ) : (
                  <div className="space-y-1.5">
                    {game.revealedWords.map((w, i) => {
                      const def = revealDefs[w.toLowerCase()];
                      return (
                        <div key={i} className="rounded-xl bg-[#121a2e] border border-[#1f2a47] p-2.5 space-y-0.5">
                          <p className="text-xs font-black text-amber-300 uppercase tracking-wide">#{i + 1} · {w}</p>
                          {def?.status === 'found' ? (
                            <>
                              <p className="text-[11px] text-slate-200 leading-snug">{def.definition.meaning}</p>
                              {def.definition.example && <p className="text-[10px] text-white/45 italic leading-snug">"{def.definition.example}"</p>}
                            </>
                          ) : def?.status === 'error' ? (
                            <p className="text-[10px] text-amber-300 italic">Couldn't load a definition — check your connection.</p>
                          ) : (
                            !revealLoading && <p className="text-[10px] text-white/45 italic">No dictionary definition found.</p>
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

        {/* Word solved: a small points pill that fades fast, so the next word is never covered */}
        {lastSolved && game.status === 'active' && (
        <div className="pointer-events-none absolute left-0 right-0 top-[88px] z-[40] flex justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#2a1d05]/90 border border-amber-300/70 shadow-[0_0_18px_rgba(245,196,81,0.45)]" style={{ animation: 'solvedPill 0.75s ease-out both' }}>
            <span className="text-lg leading-none font-black text-amber-300">+{lastSolved.points}</span>
          </div>
        </div>
        )}
      </div>

      {dragGhost && (
        <div className={clsx('fixed z-[300] w-14 h-14 rounded-2xl flex items-center justify-center font-black text-2xl uppercase pointer-events-none', tileFace)} style={{ left: dragGhost.x - 28, top: dragGhost.y - 28 }}>
          {dragGhost.letter}
        </div>
      )}
    </div>
  );
}
