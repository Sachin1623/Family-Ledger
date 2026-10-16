import React from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import {
  ScrambleActiveGame,
  loadActiveGame,
  submitAnswer,
  useHint,
  useShuffle,
  passWord,
  isMatchOver,
  secondsRemaining,
  finalizeMatch,
  startNewGame,
  MAX_HINTS_PER_MATCH,
  SHUFFLE_PENALTY,
  PASS_PENALTY,
  TIMER_MODE_LABEL,
  TIMER_MODE_SECONDS,
} from '../../lib/scramble';
import { flushPendingScrambleScores } from '../../lib/scrambleSync';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SCRAMBLE_HELP } from '../../lib/gameHelp';
import { fetchWordDefinitions, WordDefinitionResult } from '../../lib/dictionaryLookup';
import { useAuth } from '../../context/AuthContext';
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';

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

const CELEBRATION_LINES = [
  "New personal best! Somewhere, a dictionary just got nervous.",
  'Letters everywhere are filing complaints. Legendary round.',
  "That's a new record — the tiles never saw it coming.",
  'Certified word-whisperer. The alphabet fears you now.',
  'Big brain detected. Scramble: humbled.',
];

export default function ScrambleGame() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [game, setGame] = React.useState<ScrambleActiveGame | null>(() => loadActiveGame());
  const [pool, setPool] = React.useState<UiTile[]>([]);
  const [answer, setAnswer] = React.useState<UiTile[]>([]);
  const [feedback, setFeedback] = React.useState<{ kind: 'already-used' | 'invalid'; key: number } | null>(null);
  const [lastAward, setLastAward] = React.useState<{ points: number; key: number } | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const [showHelp, setShowHelp] = React.useState(false);
  const [result, setResult] = React.useState<{ score: number; wordsSolved: number; hintsUsed: number; brokeBest: boolean; previousBest: number } | null>(null);
  const [revealWords, setRevealWords] = React.useState<string[]>([]);
  const [revealDefs, setRevealDefs] = React.useState<Record<string, WordDefinitionResult>>({});
  const [revealLoading, setRevealLoading] = React.useState(false);
  const [celebrationLine] = React.useState(() => CELEBRATION_LINES[Math.floor(Math.random() * CELEBRATION_LINES.length)]);
  // Display-only streak: words solved since the last pass (kept in this screen, not saved with the match).
  const [streak, setStreak] = React.useState(0);
  const [lastSolved, setLastSolved] = React.useState<{ word: string; points: number; key: number } | null>(null);
  React.useEffect(() => {
    if (!lastSolved) return;
    const t = setTimeout(() => setLastSolved(null), 800);
    return () => clearTimeout(t);
  }, [lastSolved]);
  const [dragGhost, setDragGhost] = React.useState<{ letter: string; x: number; y: number } | null>(null);

  const answerZoneRef = React.useRef<HTMLDivElement>(null);
  const dragStateRef = React.useRef<{ tile: UiTile; from: 'pool' | 'answer'; startX: number; startY: number } | null>(null);
  const lastTapRef = React.useRef<{ id: string; time: number } | null>(null);

  React.useEffect(() => {
    if (!game) navigate('/games/scramble', { replace: true });
  }, [game, navigate]);

  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    if (!game || result) return;
    if (isMatchOver(game)) {
      const words: string[] = Array.from(new Set<string>(game.usedTargets));
      const r = finalizeMatch(game);
      setResult(r);
      setRevealWords(words);
      flushPendingScrambleScores();
      setRevealLoading(true);
      fetchWordDefinitions(words).then((defs) => setRevealDefs(defs)).finally(() => setRevealLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, game, result]);

  // A fresh round (new tile set) resets the pool/answer arrangement — tiles carry stable per-round
  // ids so drag/tap state never confuses two rounds' letters, even when a letter repeats.
  React.useEffect(() => {
    if (!game) return;
    setPool(game.currentRound.tiles.map((letter, i) => ({ id: `${game.roundIndex}-${i}`, letter })));
    setAnswer([]);
    setFeedback(null);
  }, [game?.roundIndex]);

  if (!game) return null;

  const remaining = secondsRemaining(game);
  const guessWord = answer.map((t) => t.letter).join('');

  const handleSubmit = () => {
    if (!guessWord || result) return;
    const res = submitAnswer(game, guessWord);
    if (res.status === 'correct') {
      setGame(res.game);
      setLastAward({ points: res.pointsAwarded, key: Date.now() });
      setStreak((n) => n + 1);
      setLastSolved({ word: guessWord, points: res.pointsAwarded, key: Date.now() });
    } else {
      setFeedback({ kind: res.status, key: Date.now() });
    }
  };

  const handleHint = () => {
    if (result) return;
    const { game: nextGame, letter } = useHint(game);
    if (letter) setGame(nextGame);
  };

  const handleShuffle = () => {
    if (result || pool.length < 2) return;
    setPool((p) => {
      const shuffled = p.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    });
    setGame(useShuffle(game));
  };

  const handlePass = () => {
    if (result) return;
    setStreak(0);
    setGame(passWord(game));
  };

  const handlePlayAgain = () => {
    const fresh = startNewGame(game.wordLength, game.timerMode);
    setGame(fresh);
    setStreak(0);
    setResult(null);
    setRevealWords([]);
    setRevealDefs({});
  };

  // Only confirms if there's actual progress at stake (a match that just started with nothing
  // solved yet doesn't need a "are you sure") — the match is autosaved either way (see
  // saveActiveGame in scramble.ts), so this is really just guarding against an accidental tap
  // mid-match, not warning about real data loss (ScrambleHome's "Resume" picks it back up).
  const handleQuit = () => {
    if (!result && (game.score > 0 || game.solvedAnswers.length > 0)) {
      if (!window.confirm("Leave this match? It's saved, so you can resume from Scramble whenever you're ready.")) return;
    }
    navigate('/tools?category=games');
  };

  // Tap and drag share one gesture: pointerdown starts tracking, pointerup decides which it was
  // based on how far the pointer moved. A stationary tap on a pool tile adds it; a stationary tap
  // on an answer tile only removes it on the SECOND tap within DOUBLE_TAP_MS (so a wrong-guess
  // recovery tap can't be triggered by accident). A real drag skips the double-tap requirement —
  // dropping a pool tile onto the answer zone adds it, dragging an answer tile off the zone removes
  // it, in either direction, immediately.
  const handleTileDown = (e: React.PointerEvent<HTMLDivElement>, tile: UiTile, from: 'pool' | 'answer') => {
    if (result) return;
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
    if (!drag || result) return;

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

  const total = TIMER_MODE_SECONDS[game.timerMode];
  const frac = Math.max(0, Math.min(1, remaining / total));
  const urgent = remaining <= 10 && !result;
  const ringColor = urgent ? '#ff4d5e' : '#f5c451';
  const slotCount = game.wordLength;
  const hintWord = game.currentRound.targetWord.toUpperCase();
  const stars = !result ? 0 : result.brokeBest ? 3 : result.score >= result.previousBest * 0.8 && result.score > 0 ? 2 : result.score > 0 ? 1 : 0;
  const myName = profile?.displayName || user?.displayName || 'Player';
  const winShare = result?.brokeBest
    ? buildWinShare({
        gameName: 'Scramble',
        winnerLabel: myName,
        standings: [{ name: myName, label: `${result.score} pts`, isWinner: true }],
        detail: `New personal best · ${game.wordLength}-letter, ${TIMER_MODE_LABEL[game.timerMode]}`,
        scoreLine: `a new personal best of ${result.score}`,
      })
    : null;
  const confetti = Array.from({ length: 34 }).map((_, i) => {
    const ang = (i / 34) * Math.PI * 2 + (i % 3) * 0.2;
    const dist = 110 + ((i * 37) % 100);
    return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, color: ['#fbbf24', '#f87171', '#60a5fa', '#4ade80', '#fff', '#c084fc'][i % 6], delay: (i % 7) * 0.04, rot: (i * 57) % 360 };
  });

  const tileFace = 'bg-gradient-to-b from-[#fff3c9] to-[#f1d27a] text-[#3a2a00] shadow-[0_5px_0_#b88a1d,0_9px_14px_rgba(0,0,0,0.45)]';

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}

      {/* Full-screen table (covers the app header and tab bar) */}
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#1d2b57_0%,#0c1230_55%,#070a18_100%)]">
        <style>{`
          @keyframes solvedPill{0%{transform:translateY(8px) scale(.7);opacity:0}25%{transform:translateY(0) scale(1.08);opacity:1}100%{transform:translateY(-14px) scale(1);opacity:0}}
          @keyframes scPts{0%{transform:translateY(24px) scale(.3);opacity:0}30%{transform:translateY(0) scale(1.25);opacity:1}100%{transform:translateY(-34px) scale(1);opacity:0}}
          @keyframes scTile{0%{transform:scale(.6) rotate(-8deg);opacity:0}60%{transform:scale(1.15) rotate(2deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
          @keyframes scBurst{0%{transform:translate(0,0) rotate(0) scale(.4);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
          @keyframes scRise{0%{transform:translateY(16px);opacity:0}100%{transform:translateY(0);opacity:1}}
          @keyframes scStar{0%{transform:scale(0) rotate(-40deg);opacity:0}70%{transform:scale(1.3) rotate(8deg);opacity:1}100%{transform:scale(1) rotate(0)}}
        `}</style>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={handleQuit} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">Scramble</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">{game.wordLength} LETTERS · {TIMER_MODE_LABEL[game.timerMode].toUpperCase()}</span>
          </div>
          <div className="flex-1" />
          <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
          <button onClick={handleQuit} className="p-1.5 text-red-300 shrink-0" aria-label="Quit match">
            <span className="material-symbols-outlined text-[22px] block">logout</span>
          </button>
        </header>

        <main className="relative flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-4 flex flex-col gap-3 max-w-md mx-auto w-full">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2 text-center"><p className="text-xl font-black text-amber-300 leading-tight tabular-nums">{game.score}</p><p className="text-[8.5px] font-extrabold tracking-[0.1em] text-white/55">SCORE</p></div>
            <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2 text-center"><p className="text-xl font-black leading-tight">{game.solvedAnswers.length}</p><p className="text-[8.5px] font-extrabold tracking-[0.1em] text-white/55">SOLVED</p></div>
            <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2 text-center"><p className="text-xl font-black leading-tight">🔥 {streak}</p><p className="text-[8.5px] font-extrabold tracking-[0.1em] text-white/55">STREAK</p></div>
          </div>

          <div className="self-center w-[104px] h-[104px] rounded-full flex items-center justify-center shrink-0" style={{ background: `conic-gradient(${ringColor} ${frac * 360}deg, #1f2a47 0deg)`, boxShadow: `0 0 28px ${ringColor}33` }}>
            <div className={clsx('w-[84px] h-[84px] rounded-full bg-[#0c1230] flex flex-col items-center justify-center', urgent && 'animate-pulse')}>
              <p className="text-[26px] font-black tabular-nums leading-none" style={{ color: urgent ? '#ff8a96' : '#fff' }}>{formatClock(remaining)}</p>
              <p className="text-[8px] font-extrabold tracking-[0.14em] text-white/50 mt-0.5">TIME LEFT</p>
            </div>
          </div>

          {/* Answer slots — one per letter, so the target length is always visible */}
          <div>
            <motion.div
              ref={answerZoneRef}
              animate={feedback ? { x: [0, -8, 8, -8, 0] } : {}}
              transition={{ duration: 0.35 }}
              className="relative flex justify-center gap-2 flex-wrap"
            >
              {Array.from({ length: Math.max(slotCount, answer.length) }).map((_, i) => {
                const tile = answer[i];
                const hinted = !tile && i < game.hintRevealLength;
                return tile ? (
                  <div
                    key={tile.id}
                    onPointerDown={(e) => handleTileDown(e, tile, 'answer')}
                    onPointerMove={handleTileMove}
                    onPointerUp={handleTileUp}
                    style={{ touchAction: 'none' }}
                    className={clsx('w-[52px] h-[58px] rounded-2xl flex items-center justify-center font-black text-[28px] uppercase cursor-pointer select-none', tileFace, feedback && '!from-[#ffd0d4] !to-[#ff8a96]')}
                  >
                    {tile.letter}
                  </div>
                ) : (
                  <div
                    key={`slot-${i}`}
                    className={clsx(
                      'w-[52px] h-[58px] rounded-2xl border-2 border-dashed flex items-center justify-center font-black text-[28px] uppercase',
                      hinted ? 'border-emerald-400/70 bg-emerald-500/10 text-emerald-300/70' : 'border-[#2c3a63] bg-[#0e1632]',
                    )}
                  >
                    {hinted ? hintWord[i] : ''}
                  </div>
                );
              })}
              <AnimatePresence>
                {lastAward && (
                  <motion.p
                    key={lastAward.key}
                    initial={{ opacity: 0, y: 0, scale: 0.8 }}
                    animate={{ opacity: 1, y: -30, scale: 1.1 }}
                    exit={{ opacity: 0 }}
                    onAnimationComplete={() => setLastAward(null)}
                    className="absolute -top-2 right-2 text-emerald-300 font-black text-xl pointer-events-none"
                  >
                    +{lastAward.points}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>
            <div className="h-5 mt-2 text-center">
              {feedback ? (
                <p className="text-[11px] font-bold text-red-300">{feedback.kind === 'invalid' ? 'Not a valid word — double-tap a letter to send it back.' : 'Already used this match — double-tap a letter to try again.'}</p>
              ) : game.hintRevealLength > 0 ? (
                <p className="text-[11px] font-bold text-white/55">
                  Hint: <span className="font-black text-emerald-300 tracking-[0.25em] uppercase">{hintWord.slice(0, game.hintRevealLength)}{'_'.repeat(game.wordLength - game.hintRevealLength)}</span>
                </p>
              ) : null}
            </div>
          </div>

          {/* Letter tray */}
          <div className="rounded-3xl bg-[#0e1632] border border-[#1f2a47] p-4 flex flex-wrap items-center justify-center gap-3 min-h-[92px]">
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
                className="w-[54px] h-[60px] rounded-2xl flex items-center justify-center text-white font-black text-[28px] uppercase cursor-pointer select-none shadow-[0_5px_0_rgba(0,0,0,0.35),0_9px_14px_rgba(0,0,0,0.5)]"
              >
                {tile.letter}
              </motion.div>
            ))}
          </div>

          <button
            onClick={handleSubmit}
            disabled={!guessWord}
            className={clsx('w-full py-3.5 rounded-2xl text-[15px] font-black transition-transform active:translate-y-0.5', guessWord ? 'bg-gradient-to-r from-amber-300 to-amber-200 text-[#1a1300] shadow-[0_5px_0_#b88a1d]' : 'bg-[#1b2543] text-[#5d6c92]')}
          >
            Submit
          </button>

          <div className="grid grid-cols-3 gap-2">
            <button onClick={handleShuffle} disabled={pool.length < 2} className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2.5 text-[11px] font-extrabold text-slate-200 disabled:opacity-40">
              <span className="material-symbols-outlined text-[18px] block mx-auto">shuffle</span>Shuffle<span className="block text-[8.5px] text-white/45 font-bold">−{SHUFFLE_PENALTY} pt</span>
            </button>
            <button onClick={handleHint} disabled={game.hintsUsed >= MAX_HINTS_PER_MATCH} className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2.5 text-[11px] font-extrabold text-slate-200 disabled:opacity-40">
              <span className="material-symbols-outlined text-[18px] block mx-auto">lightbulb</span>Hint<span className="block text-[8.5px] text-white/45 font-bold">{MAX_HINTS_PER_MATCH - game.hintsUsed} left</span>
            </button>
            <button onClick={handlePass} className="rounded-2xl bg-[#2a1520] border border-[#4a2030] py-2.5 text-[11px] font-extrabold text-red-300">
              <span className="material-symbols-outlined text-[18px] block mx-auto">skip_next</span>Pass<span className="block text-[8.5px] text-red-300/60 font-bold">−{PASS_PENALTY} pts</span>
            </button>
          </div>
          <p className="text-center text-[10px] font-semibold text-white/35">Tap letters to place · double-tap a placed letter to take it back · or drag</p>
        </main>

        {/* Word solved: a small points pill that fades fast, so the next word is never covered */}
        {lastSolved && !result && (
        <div className="pointer-events-none absolute left-0 right-0 top-[88px] z-[40] flex justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#2a1d05]/90 border border-amber-300/70 shadow-[0_0_18px_rgba(245,196,81,0.45)]" style={{ animation: 'solvedPill 0.75s ease-out both' }}>
            <span className="text-lg leading-none font-black text-amber-300">+{lastSolved.points}</span>
            {streak >= 2 && <span className="text-[11px] font-extrabold text-white/90">🔥 {streak}</span>}
          </div>
        </div>
        )}
      </div>

      {dragGhost && (
        <div
          className={clsx('fixed z-[300] w-14 h-14 rounded-2xl flex items-center justify-center font-black text-2xl uppercase pointer-events-none', tileFace)}
          style={{ left: dragGhost.x - 28, top: dragGhost.y - 28 }}
        >
          {dragGhost.letter}
        </div>
      )}

      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[280] flex items-center justify-center p-3 bg-[radial-gradient(circle_at_50%_30%,rgba(74,58,10,0.92),rgba(7,10,24,0.97)_72%)] backdrop-blur-sm">
            {result.brokeBest && (
              <div className="absolute left-1/2 top-[22%] pointer-events-none">
                {confetti.map((c, i) => (
                  <i key={i} className="absolute block w-2 h-3 rounded-[2px]" style={{ background: c.color, ['--dx' as any]: `${c.dx}px`, ['--dy' as any]: `${c.dy}px`, ['--rot' as any]: `${c.rot}deg`, animation: `scBurst 1.4s ease-out ${0.5 + c.delay}s both` }} />
                ))}
              </div>
            )}
            <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="w-full max-w-sm max-h-[92dvh] flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0c1230]/90 text-white">
              <div className="flex-1 overflow-y-auto p-5 space-y-3 text-center">
                <p className="text-[11px] font-extrabold tracking-[0.18em] text-amber-300">TIME'S UP</p>
                <div className="text-[1.9rem] tracking-[0.4rem] text-amber-300 drop-shadow-[0_0_14px_rgba(245,196,81,0.6)]">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className={i < stars ? '' : 'opacity-25'} style={i < stars ? { display: 'inline-block', animation: `scStar 0.5s cubic-bezier(.3,1.5,.5,1) ${0.3 + i * 0.25}s both` } : undefined}>★</span>
                  ))}
                </div>
                <p className="text-5xl font-black tabular-nums">{result.score}</p>
                <p className="text-[10px] font-extrabold tracking-[0.14em] text-white/55">{game.wordLength} LETTERS · {TIMER_MODE_LABEL[game.timerMode].toUpperCase()}</p>
                {result.brokeBest && (
                  <div className="inline-block rounded-full bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 px-3.5 py-1 text-[11px] font-black">🏆 NEW PERSONAL BEST · +{result.score - result.previousBest}</div>
                )}
                {result.brokeBest && <p className="text-xs font-bold text-white/80">{celebrationLine}</p>}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2"><p className="text-lg font-black">{result.wordsSolved}</p><p className="text-[8.5px] font-extrabold tracking-[0.1em] text-white/55">WORDS</p></div>
                  <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2"><p className="text-lg font-black">{result.hintsUsed}</p><p className="text-[8.5px] font-extrabold tracking-[0.1em] text-white/55">HINTS</p></div>
                  <div className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] py-2"><p className="text-lg font-black">{result.brokeBest ? result.score : result.previousBest}</p><p className="text-[8.5px] font-extrabold tracking-[0.1em] text-white/55">BEST</p></div>
                </div>

                {revealWords.length > 0 && (
                  <div className="space-y-1.5 text-left">
                    <p className="text-[10px] font-extrabold tracking-[0.14em] text-white/55 text-center">EVERY WORD THIS MATCH{revealLoading && ' — LOADING MEANINGS…'}</p>
                    {revealWords.map((w) => {
                      const def = revealDefs[w.toLowerCase()];
                      const solved = game.solvedAnswers.includes(w.toLowerCase());
                      return (
                        <div key={w} className="rounded-xl bg-[#121a2e] border border-[#1f2a47] p-2.5 space-y-0.5">
                          <p className="text-xs font-black uppercase tracking-wide flex items-center gap-1.5">
                            <span className={solved ? 'text-emerald-300' : 'text-white/55'}>{w}</span>
                            {solved && <span className="material-symbols-outlined text-[13px] text-emerald-300">check_circle</span>}
                          </p>
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
              </div>
              <div className="flex flex-col gap-2 p-4 pt-1 shrink-0">
                {winShare && <ShareWinButton card={winShare.card} caption={winShare.caption} />}
                <button onClick={handlePlayAgain} className="w-full py-3 rounded-2xl text-sm font-black text-emerald-950 bg-gradient-to-r from-emerald-500 to-emerald-400">Play Again</button>
                <button onClick={() => navigate('/tools?category=games')} className="w-full py-3 rounded-2xl text-sm font-extrabold text-white bg-white/10 border border-white/15">Done</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
