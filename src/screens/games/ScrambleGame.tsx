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
} from '../../lib/scramble';
import { flushPendingScrambleScores } from '../../lib/scrambleSync';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SCRAMBLE_HELP } from '../../lib/gameHelp';
import { fetchWordDefinitions, WordDefinitionResult } from '../../lib/dictionaryLookup';

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
    setGame(passWord(game));
  };

  const handlePlayAgain = () => {
    const fresh = startNewGame(game.wordLength, game.timerMode);
    setGame(fresh);
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
    navigate('/games/scramble');
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

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <header className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm border-b border-border-subtle">
        <div className="max-w-xl mx-auto w-full p-4 flex items-center justify-between gap-2">
          <button onClick={handleQuit} className="text-xs font-bold text-primary flex items-center gap-1 shrink-0">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            Scramble
          </button>
          <div
            className={clsx(
              'px-3 py-1.5 rounded-full text-sm font-black tabular-nums',
              remaining <= 10 ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary',
            )}
          >
            {formatClock(remaining)}
          </div>
          <HelpButton onClick={() => setShowHelp(true)} />
        </div>
      </header>

      {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}

      <main className="flex-1 p-3 max-w-xl mx-auto w-full space-y-2.5 pb-10">
        <div className="flex items-center justify-around text-center">
          <div>
            <p className="text-xl font-black text-primary leading-tight">{game.score}</p>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Score</p>
          </div>
          <div>
            <p className="text-xl font-black text-on-surface leading-tight">{game.solvedAnswers.length}</p>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Solved</p>
          </div>
          <div>
            <p className="text-xl font-black text-on-surface leading-tight">{game.wordLength}</p>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Letters</p>
          </div>
        </div>

        {/* Your answer — tap or drag a letter here twice-tap (or drag out) to remove it */}
        <div>
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 px-1">Your Word</p>
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

        {/* Letter pool */}
        <div>
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1 px-1">Letters</p>
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
        </div>

        {game.hintRevealLength > 0 && (
          <p className="text-center text-xs text-text-muted">
            Hint:{' '}
            <span className="font-black text-primary tracking-widest uppercase">
              {game.currentRound.targetWord.slice(0, game.hintRevealLength)}
              {'_'.repeat(game.wordLength - game.hintRevealLength)}
            </span>
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={!guessWord}
          className="w-full py-2.5 bg-primary text-white rounded-xl text-sm font-bold disabled:opacity-40"
        >
          Submit
        </button>

        <div className="flex gap-2">
          <button
            onClick={handleShuffle}
            disabled={pool.length < 2}
            className="flex-1 py-2 rounded-xl text-xs font-bold text-primary bg-primary/5 disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">shuffle</span>
            Shuffle (-{SHUFFLE_PENALTY} pt)
          </button>
          <button
            onClick={handleHint}
            disabled={game.hintsUsed >= MAX_HINTS_PER_MATCH}
            className="flex-1 py-2 rounded-xl text-xs font-bold text-primary bg-primary/5 disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">lightbulb</span>
            Hint ({MAX_HINTS_PER_MATCH - game.hintsUsed} left)
          </button>
        </div>

        <button
          onClick={handlePass}
          className="w-full py-2 rounded-xl text-xs font-bold text-error bg-error/5 flex items-center justify-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[16px]">skip_next</span>
          Pass Word (-{PASS_PENALTY} pts)
        </button>
      </main>

      {dragGhost && (
        <div
          className="fixed z-[300] w-12 h-12 rounded-xl flex items-center justify-center text-white font-black text-xl uppercase shadow-lg pointer-events-none bg-primary"
          style={{ left: dragGhost.x - 24, top: dragGhost.y - 24 }}
        >
          {dragGhost.letter}
        </div>
      )}

      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[280] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-sm max-h-[85vh] flex flex-col overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto p-6 space-y-4 text-center">
                {result.brokeBest && <p className="text-sm font-bold text-success">{celebrationLine}</p>}
                <div>
                  <p className="text-4xl font-black text-primary">{result.score}</p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-wider mt-1">
                    {TIMER_MODE_LABEL[game.timerMode]} · {game.wordLength}-letter mode
                  </p>
                </div>
                <div className="flex items-center justify-around text-center bg-surface rounded-2xl p-3">
                  <div>
                    <p className="text-lg font-black text-on-surface">{result.wordsSolved}</p>
                    <p className="text-[10px] font-bold text-text-muted uppercase">Words</p>
                  </div>
                  <div>
                    <p className="text-lg font-black text-on-surface">{result.hintsUsed}</p>
                    <p className="text-[10px] font-bold text-text-muted uppercase">Hints</p>
                  </div>
                  <div>
                    <p className={clsx('text-lg font-black', result.brokeBest ? 'text-success' : 'text-on-surface')}>
                      {result.brokeBest ? `+${result.score - result.previousBest}` : result.previousBest}
                    </p>
                    <p className="text-[10px] font-bold text-text-muted uppercase">{result.brokeBest ? 'Beat Best' : 'Your Best'}</p>
                  </div>
                </div>

                {revealWords.length > 0 && (
                  <div className="space-y-1.5 text-left">
                    <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider text-center">
                      Every Word This Match{revealLoading && ' — loading definitions…'}
                    </p>
                    {revealWords.map((w) => {
                      const def = revealDefs[w.toLowerCase()];
                      const solved = game.solvedAnswers.includes(w.toLowerCase());
                      return (
                        <div key={w} className="bg-surface rounded-xl p-3 space-y-1">
                          <p className="text-xs font-black uppercase tracking-wide flex items-center gap-1.5">
                            <span className={solved ? 'text-success' : 'text-text-muted'}>{w}</span>
                            {solved && <span className="material-symbols-outlined text-[13px] text-success">check_circle</span>}
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
              </div>
              <div className="flex gap-2 p-6 pt-0 shrink-0">
                <button onClick={() => navigate('/games/scramble')} className="flex-1 py-3 rounded-xl text-sm font-bold text-text-muted border border-border-subtle">
                  Done
                </button>
                <button onClick={handlePlayAgain} className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-primary">
                  Play Again
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
