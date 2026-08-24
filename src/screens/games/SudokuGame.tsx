import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import {
  ActiveGame,
  Board,
  Difficulty,
  NotesMap,
  loadActiveGame,
  saveActiveGame,
  clearActiveGame,
  solve,
  conflictsFor,
  isComplete,
  isValidSolved,
  computeScore,
  recordLocalScore,
  queuePendingScore,
  advancePuzzleCursor,
  startNewGame,
  peersOf,
} from '../../lib/sudoku';
import { flushPendingSudokuScores } from '../../lib/sudokuSync';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import Fireworks from '../../components/Fireworks';
import { SUDOKU_HELP } from '../../lib/gameHelp';

interface HistoryEntry {
  board: Board;
  notes: NotesMap;
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const DIFFICULTY_COLOR: Record<string, string> = { easy: '#0F7A38', medium: '#B45309', hard: '#B91C1C' };

const CELEBRATION_LINES = [
  "BOOM! You just out-logic'd a grid of tiny squares. Legendary.",
  'Big brain detected. The numbers never stood a chance.',
  'Sudoku: defeated. Laundry: still undefeated.',
  'Somewhere, a math teacher just shed a single proud tear.',
  '9x9 grid: conquered. Ego: appropriately inflated.',
  'Row by row, column by column — flawless victory.',
  'That grid put up a fight. You put up a bigger one.',
  'Numbers 1 through 9 have officially been put in their place.',
  "You solved that faster than someone finds the TV remote in this house.",
  'Certified grid-whisperer. The digits fear you now.',
];

export default function SudokuGame() {
  const navigate = useNavigate();
  const { difficulty } = useParams<{ difficulty: Difficulty }>();
  const [game, setGame] = React.useState<ActiveGame | null>(() => (difficulty ? loadActiveGame(difficulty) : null));
  const solutionRef = React.useRef<Board | null>(null);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [notesMode, setNotesMode] = React.useState(false);
  // Tapping a number-pad digit while no cell (or a non-editable given) is selected can't place
  // anything — repurposed as a "highlight every cell with this digit" toggle instead of silently
  // doing nothing, which is otherwise the only useful thing that tap could mean.
  const [highlightDigit, setHighlightDigit] = React.useState<number | null>(null);
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const [completion, setCompletion] = React.useState<{ score: number } | null>(null);
  const [showHelp, setShowHelp] = React.useState(false);
  // A separate, tap-to-dismiss celebration overlay in front of the stats modal — triggered by the
  // SAME `completion` transition that opens the stats modal, so it's naturally tied to "once per
  // puzzle" without its own guard logic: `completion` only ever flips null -> {score} once per
  // puzzle (finishIfComplete/handlePlayAgain are the only two places that touch it), so this effect
  // only ever fires once per solve.
  const [celebrationLine, setCelebrationLine] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!game) {
      navigate('/games/sudoku', { replace: true });
      return;
    }
    solutionRef.current = solve(game.givens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timer — doesn't tick while the app is backgrounded, so leaving it open overnight
  // doesn't quietly tank the eventual score.
  React.useEffect(() => {
    if (!game || completion) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setGame((prev) => {
        if (!prev) return prev;
        const next = { ...prev, elapsedSeconds: prev.elapsedSeconds + 1 };
        saveActiveGame(next);
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [game?.difficulty, completion]);

  React.useEffect(() => {
    if (completion) setCelebrationLine(CELEBRATION_LINES[Math.floor(Math.random() * CELEBRATION_LINES.length)]);
  }, [completion]);

  if (!game) return null;

  const solution = solutionRef.current;

  const conflictSet = React.useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < 81; i++) {
      if (game.board[i] === 0) continue;
      if (conflictsFor(game.board, i, game.board[i]).length > 0) set.add(i);
    }
    return set;
  }, [game.board]);

  // A digit reaching 9 placements greys it out on the number pad — there are only 9 of each in a
  // valid grid, so it can't be placed anywhere else (still tappable for the highlight toggle).
  const digitCounts = React.useMemo(() => {
    const counts = new Array(10).fill(0);
    for (const v of game.board) if (v !== 0) counts[v] += 1;
    return counts;
  }, [game.board]);

  const pushHistory = () => {
    setHistory((h) => [...h, { board: game.board.slice(), notes: { ...game.notes } }]);
  };

  const updateGame = (partial: Partial<ActiveGame>) => {
    setGame((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      saveActiveGame(next);
      return next;
    });
  };

  const finishIfComplete = (board: Board) => {
    if (!isComplete(board) || !isValidSolved(board)) return;
    const score = computeScore({
      difficulty: game.difficulty,
      elapsedSeconds: game.elapsedSeconds,
      mistakes: game.mistakes,
      hintsUsed: game.hintsUsed,
    });
    recordLocalScore(game.difficulty, score);
    queuePendingScore({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      difficulty: game.difficulty,
      score,
      elapsedSeconds: game.elapsedSeconds,
      mistakes: game.mistakes,
      hintsUsed: game.hintsUsed,
      completedAt: new Date().toISOString(),
    });
    advancePuzzleCursor(game.difficulty);
    // Deferred through setGame rather than a direct clearActiveGame() call — the updateGame() call
    // that precedes this in handleDigit/handleHint ALSO defers its own saveActiveGame() through
    // React's state-update batching (the updater function only runs after the event handler
    // returns), so a direct synchronous clear here would run BEFORE that save actually fires —
    // and the save would silently resurrect a "completed" active game in localStorage right after
    // this clear, which is exactly why "Resume" was showing up for a puzzle just finished. Routing
    // through the same setGame mechanism guarantees this runs strictly after that save, since
    // React applies same-batch updater functions in the order they were queued.
    setGame((prev) => {
      if (prev) clearActiveGame(prev.difficulty);
      return prev;
    });
    flushPendingSudokuScores();
    setCompletion({ score });
  };

  const handleDigit = (digit: number) => {
    if (completion) return;
    if (selected == null || game.givens[selected] !== 0) {
      setHighlightDigit((prev) => (prev === digit ? null : digit));
      return;
    }
    setHighlightDigit(null);
    pushHistory();

    if (notesMode) {
      const current = game.notes[selected] || [];
      const nextNotes = current.includes(digit) ? current.filter((d) => d !== digit) : [...current, digit].sort();
      updateGame({ notes: { ...game.notes, [selected]: nextNotes } });
      return;
    }

    const board = game.board.slice();
    board[selected] = digit;
    const notes = { ...game.notes };
    delete notes[selected];
    for (const p of peersOf(selected)) {
      if (notes[p]?.includes(digit)) notes[p] = notes[p].filter((d) => d !== digit);
    }

    const wrong = solution ? solution[selected] !== digit : false;
    updateGame({ board, notes, mistakes: game.mistakes + (wrong ? 1 : 0) });
    finishIfComplete(board);
  };

  const handleErase = () => {
    if (completion || selected == null || game.givens[selected] !== 0 || game.board[selected] === 0) return;
    pushHistory();
    const board = game.board.slice();
    board[selected] = 0;
    updateGame({ board });
  };

  const handleUndo = () => {
    if (completion) return;
    setHistory((h) => {
      if (h.length === 0) return h;
      const last = h[h.length - 1];
      updateGame({ board: last.board, notes: last.notes });
      return h.slice(0, -1);
    });
  };

  const handleHint = () => {
    if (completion || !solution) return;
    let target = selected;
    if (target == null || game.board[target] !== 0) {
      const empties = game.board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
      if (empties.length === 0) return;
      target = empties[Math.floor(Math.random() * empties.length)];
      setSelected(target);
    }
    setHighlightDigit(null);
    pushHistory();
    const board = game.board.slice();
    board[target] = solution[target];
    const notes = { ...game.notes };
    delete notes[target];
    updateGame({ board, notes, hintsUsed: game.hintsUsed + 1 });
    finishIfComplete(board);
  };

  const handlePlayAgain = () => {
    const next = startNewGame(game.difficulty);
    setGame(next);
    setSelected(null);
    setHighlightDigit(null);
    setHistory([]);
    setCompletion(null);
    setCelebrationLine(null);
    solutionRef.current = solve(next.givens);
  };

  // Resets THIS SAME puzzle back to its given-only state — distinct from "Play Again"/"New",
  // which pulls a fresh puzzle. Keeps the same puzzleIndex, so it doesn't consume a puzzle from
  // the bank or count toward "played".
  const handleRestart = () => {
    if (!window.confirm('Restart this puzzle from scratch? Your progress will be lost.')) return;
    const restarted: ActiveGame = {
      ...game,
      board: game.givens.slice(),
      notes: {},
      mistakes: 0,
      hintsUsed: 0,
      elapsedSeconds: 0,
      startedAt: new Date().toISOString(),
    };
    saveActiveGame(restarted);
    setGame(restarted);
    setSelected(null);
    setHighlightDigit(null);
    setHistory([]);
  };

  const handleQuit = () => {
    if (!window.confirm('Quit this puzzle? Your progress will be lost.')) return;
    clearActiveGame(game.difficulty);
    navigate('/games/sudoku');
  };

  const selectedRow = selected != null ? Math.floor(selected / 9) : null;
  const selectedCol = selected != null ? selected % 9 : null;
  const selectedValue = selected != null ? game.board[selected] : 0;
  // An explicit number-pad highlight takes over from the plain "same as the selected cell's own
  // value" highlighting — lets scanning for a specific digit persist across selecting other cells.
  const highlightValue = highlightDigit ?? selectedValue;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-6 max-w-md mx-auto w-full space-y-5 pb-24">
        <div className="flex items-center justify-between">
          <button onClick={() => navigate('/games/sudoku')} className="text-xs font-bold text-primary flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            Sudoku
          </button>
          <div className="flex items-center gap-3 text-xs font-bold text-text-muted">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">schedule</span>
              {formatTime(game.elapsedSeconds)}
            </span>
            <span className="flex items-center gap-1 text-error">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {game.mistakes}
            </span>
            {!completion && (
              <button onClick={handleQuit} className="p-2 text-error shrink-0" aria-label="Quit puzzle">
                <span className="material-symbols-outlined text-[22px] block">logout</span>
              </button>
            )}
            <HelpButton onClick={() => setShowHelp(true)} />
          </div>
        </div>

        {showHelp && <GameHelpModal content={SUDOKU_HELP} onClose={() => setShowHelp(false)} />}

        {!completion && (
          <div className="flex items-center justify-end gap-4">
            <button onClick={handleRestart} className="flex items-center gap-1 text-[11px] font-bold text-text-muted">
              <span className="material-symbols-outlined text-[15px]">restart_alt</span>
              Restart
            </button>
          </div>
        )}

        <div className={clsx('space-y-5', completion && 'pointer-events-none opacity-60')}>
        <div
          className="grid grid-cols-9 bg-white rounded-2xl overflow-hidden border-2 shadow-sm"
          style={{ borderColor: DIFFICULTY_COLOR[game.difficulty] }}
        >
          {game.board.map((value, i) => {
            const row = Math.floor(i / 9);
            const col = i % 9;
            const isGiven = game.givens[i] !== 0;
            const isSelected = selected === i;
            const isPeer = selectedRow != null && selectedCol != null && (row === selectedRow || col === selectedCol);
            const isSameValue = value !== 0 && value === highlightValue;
            const hasConflict = conflictSet.has(i);
            const notes = game.notes[i];

            return (
              <button
                key={i}
                onClick={() => setSelected(i)}
                className={clsx(
                  'aspect-square flex items-center justify-center text-lg font-bold relative transition-colors',
                  col % 3 === 0 && col !== 0 && 'border-l-2',
                  row % 3 === 0 && row !== 0 && 'border-t-2',
                  'border-r border-b border-border-subtle',
                  isSelected ? 'bg-blue-300' : isSameValue ? 'bg-blue-200' : isPeer ? 'bg-blue-100' : isGiven ? 'bg-surface-container' : 'bg-white',
                  hasConflict ? 'text-error' : isGiven ? 'text-on-surface' : 'text-primary',
                )}
                style={{
                  borderLeftColor: col % 3 === 0 && col !== 0 ? DIFFICULTY_COLOR[game.difficulty] : undefined,
                  borderTopColor: row % 3 === 0 && row !== 0 ? DIFFICULTY_COLOR[game.difficulty] : undefined,
                }}
              >
                {value !== 0 ? (
                  value
                ) : notes && notes.length > 0 ? (
                  <div className="grid grid-cols-3 gap-0 w-full h-full p-0.5 text-[8px] font-bold text-text-muted leading-none">
                    {Array.from({ length: 9 }, (_, n) => n + 1).map((n) => (
                      <div key={n} className="flex items-center justify-center">{notes.includes(n) ? n : ''}</div>
                    ))}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setNotesMode((n) => !n)}
            className={clsx('flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-[10px] font-bold', notesMode ? 'bg-primary text-white' : 'text-text-muted')}
          >
            <span className="material-symbols-outlined text-[20px]">edit_note</span>
            Notes
          </button>
          <button onClick={handleUndo} disabled={history.length === 0} className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-[10px] font-bold text-text-muted disabled:opacity-30">
            <span className="material-symbols-outlined text-[20px]">undo</span>
            Undo
          </button>
          <button onClick={handleErase} className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-[10px] font-bold text-text-muted">
            <span className="material-symbols-outlined text-[20px]">backspace</span>
            Erase
          </button>
          <button onClick={handleHint} className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-[10px] font-bold text-text-muted">
            <span className="material-symbols-outlined text-[20px]">lightbulb</span>
            Hint ({game.hintsUsed})
          </button>
        </div>

        <div className="grid grid-cols-9 gap-1.5">
          {Array.from({ length: 9 }, (_, n) => n + 1).map((n) => {
            const isDone = digitCounts[n] >= 9;
            return (
              <button
                key={n}
                onClick={() => handleDigit(n)}
                className={clsx(
                  'aspect-square rounded-xl text-lg font-bold active:scale-95 transition-transform',
                  highlightDigit === n
                    ? 'bg-primary text-white border border-primary'
                    : isDone
                    ? 'bg-surface-container text-text-muted border border-border-subtle'
                    : 'bg-white border border-border-subtle text-primary',
                )}
              >
                {n}
              </button>
            );
          })}
        </div>
        </div>
      </main>

      <AnimatePresence>
        {completion && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[280] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-5 text-center overflow-hidden"
            >
              <Fireworks />
              <div className="relative w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto text-primary">
                <span className="material-symbols-outlined text-3xl">emoji_events</span>
              </div>
              <div className="relative">
                <h2 className="text-lg font-black text-primary">Puzzle Solved!</h2>
                <p className="text-sm text-text-muted mt-1 capitalize">{game.difficulty} · {formatTime(game.elapsedSeconds)}</p>
              </div>
              <div className="bg-surface rounded-2xl p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Score</p>
                <p className="text-3xl font-black text-primary">{completion.score.toLocaleString()}</p>
                <p className="text-[11px] text-text-muted mt-1">{game.mistakes} mistake{game.mistakes !== 1 ? 's' : ''} · {game.hintsUsed} hint{game.hintsUsed !== 1 ? 's' : ''}</p>
              </div>
              <div className="flex flex-col gap-2">
                <button onClick={handlePlayAgain} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">
                  Play Another {game.difficulty.charAt(0).toUpperCase() + game.difficulty.slice(1)}
                </button>
                <button onClick={() => navigate('/games/sudoku/leaderboard')} className="w-full py-3 text-primary font-bold rounded-2xl border border-border-subtle">
                  View Leaderboard
                </button>
                <button onClick={() => navigate('/games/sudoku')} className="w-full py-2 text-text-muted font-bold text-sm">
                  Back to Sudoku Home
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sits in front of the stats modal above — tapping anywhere dismisses it, revealing the
          modal's actual buttons underneath. Only ever mounted once per solve, since it's driven
          by the same `completion` transition (see the effect that sets `celebrationLine`). */}
      <AnimatePresence>
        {completion && celebrationLine && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setCelebrationLine(null)}
            className="fixed inset-0 z-[290] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 cursor-pointer"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.7, rotate: -6 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ type: 'spring', damping: 14, stiffness: 260 }}
              className="text-center space-y-4 max-w-xs"
            >
              <motion.div
                animate={{ y: [0, -10, 0] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
                className="text-6xl"
              >
                🎉🥳🎊
              </motion.div>
              <h2 className="text-2xl font-black text-white">You did it!</h2>
              <p className="text-base font-bold text-white/90">{celebrationLine}</p>
              <p className="text-xs font-bold text-white/60 uppercase tracking-wider pt-2">Tap anywhere to continue</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
