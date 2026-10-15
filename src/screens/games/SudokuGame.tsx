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
  readBestScores,
} from '../../lib/sudoku';
import { flushPendingSudokuScores } from '../../lib/sudokuSync';
import { useAuth } from '../../context/AuthContext';
import ShareWinButton from '../../components/ShareWinButton';
import { buildWinShare } from '../../lib/winShareImage';
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

const DIFFICULTY_BADGE: Record<string, string> = { easy: '#16a34a', medium: '#d97706', hard: '#dc2626' };

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
  const { profile, user } = useAuth();
  const [game, setGame] = React.useState<ActiveGame | null>(() => (difficulty ? loadActiveGame(difficulty) : null));
  const solutionRef = React.useRef<Board | null>(null);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [notesMode, setNotesMode] = React.useState(false);
  // Tapping a number-pad digit while no cell (or a non-editable given) is selected can't place
  // anything — repurposed as a "highlight every cell with this digit" toggle instead of silently
  // doing nothing, which is otherwise the only useful thing that tap could mean.
  const [highlightDigit, setHighlightDigit] = React.useState<number | null>(null);
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const [completion, setCompletion] = React.useState<{ score: number; prevBest: number; stars: number } | null>(null);
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
    // 3 stars for a clean solve (no mistakes, no hints), fewer as slips and hints add up.
    const slips = game.mistakes + game.hintsUsed * 1.5;
    const stars = slips === 0 ? 3 : slips <= 3 ? 2 : 1;
    const prevBest = readBestScores()[game.difficulty].bestScore;
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
    setCompletion({ score, prevBest, stars });
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
    navigate('/tools?category=games');
  };

  const selectedRow = selected != null ? Math.floor(selected / 9) : null;
  const selectedCol = selected != null ? selected % 9 : null;
  const selectedValue = selected != null ? game.board[selected] : 0;
  // An explicit number-pad highlight takes over from the plain "same as the selected cell's own
  // value" highlighting — lets scanning for a specific digit persist across selecting other cells.
  const highlightValue = highlightDigit ?? selectedValue;

  const filled = game.board.filter((v) => v !== 0).length;
  const accent = DIFFICULTY_BADGE[game.difficulty] || '#22c55e';

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      {showHelp && <GameHelpModal content={SUDOKU_HELP} onClose={() => setShowHelp(false)} />}

      {/* Full-screen game table (covers the app header and tab bar), same look as the other games. */}
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_25%,#0f4d46_0%,#0a2c3d_55%,#06141f_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate('/games/sudoku')} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <h1 className="text-[15px] font-black flex items-center">
            Sudoku
            <span className="ml-2 px-2.5 py-0.5 rounded-full text-[10px] font-black tracking-wider uppercase text-white" style={{ background: accent }}>{game.difficulty}</span>
          </h1>
          <div className="flex-1" />
          {!completion && (
            <button onClick={handleRestart} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Restart puzzle">
              <span className="material-symbols-outlined text-[18px]">restart_alt</span>
            </button>
          )}
          <HelpButton onClick={() => setShowHelp(true)} className="!text-white" />
          {!completion && (
            <button onClick={handleQuit} className="p-1.5 text-red-300 shrink-0" aria-label="Quit puzzle">
              <span className="material-symbols-outlined text-[22px] block">logout</span>
            </button>
          )}
        </header>

        {/* stat chips */}
        <div className="relative shrink-0 flex justify-center gap-2 px-3 pt-3">
          <div className="flex items-center gap-1.5 h-9 rounded-full px-3.5 bg-black/35 border border-white/15">
            <span className="material-symbols-outlined text-[18px] text-cyan-300">schedule</span>
            <div className="leading-none"><p className="text-[15px] font-black tabular-nums">{formatTime(game.elapsedSeconds)}</p><p className="text-[7px] tracking-[0.14em] text-white/55 font-bold mt-0.5">TIME</p></div>
          </div>
          <div className="flex items-center gap-1.5 h-9 rounded-full px-3.5 bg-black/35 border border-red-400/60">
            <span className="material-symbols-outlined text-[18px] text-red-300">error</span>
            <div className="leading-none"><p className="text-[15px] font-black tabular-nums">{game.mistakes}</p><p className="text-[7px] tracking-[0.14em] text-white/55 font-bold mt-0.5">MISTAKES</p></div>
          </div>
          <div className="flex items-center gap-1.5 h-9 rounded-full px-3.5 bg-black/35 border border-white/15">
            <span className="material-symbols-outlined text-[18px] text-amber-300">lightbulb</span>
            <div className="leading-none"><p className="text-[15px] font-black tabular-nums">{game.hintsUsed}</p><p className="text-[7px] tracking-[0.14em] text-white/55 font-bold mt-0.5">HINTS</p></div>
          </div>
        </div>

        {/* progress */}
        <div className="relative shrink-0 mx-4 mt-2.5">
          <div className="flex justify-between text-[10px] font-extrabold text-white/70 mb-1">
            <span>BOARD COMPLETE</span>
            <span className="tabular-nums">{filled} / 81</span>
          </div>
          <div className="h-2 rounded-full bg-white/12 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-green-400 shadow-[0_0_12px_#22d3ee] transition-all" style={{ width: `${(filled / 81) * 100}%` }} />
          </div>
        </div>

        <div className={clsx('relative flex-1 min-h-0 overflow-y-auto flex flex-col', completion && 'pointer-events-none opacity-60')}>
          {/* board */}
          <div className="mx-auto w-full max-w-[26rem] px-3 pt-3">
            <div className="p-1.5 rounded-[18px] bg-gradient-to-br from-[#1f6f68] to-[#0d3b4a] shadow-[0_14px_30px_rgba(0,0,0,0.55),inset_0_2px_0_rgba(255,255,255,0.25),0_0_22px_rgba(34,211,238,0.25)]">
              <div className="grid grid-cols-9 bg-[#06202b] rounded-xl overflow-hidden gap-px">
                {game.board.map((value, i) => {
                  const row = Math.floor(i / 9);
                  const col = i % 9;
                  const isGiven = game.givens[i] !== 0;
                  const isSelected = selected === i;
                  const isPeer = selectedRow != null && selectedCol != null && (row === selectedRow || col === selectedCol || (Math.floor(row / 3) === Math.floor(selectedRow / 3) && Math.floor(col / 3) === Math.floor(selectedCol / 3)));
                  const isSameValue = value !== 0 && value === highlightValue;
                  const hasConflict = conflictSet.has(i);
                  const notes = game.notes[i];

                  return (
                    <button
                      key={i}
                      onClick={() => setSelected(i)}
                      className={clsx(
                        'aspect-square flex items-center justify-center font-black relative transition-colors text-[clamp(1.1rem,5.4vw,1.5rem)]',
                        col % 3 === 0 && col !== 0 && 'border-l-2 border-l-cyan-400/80',
                        row % 3 === 0 && row !== 0 && 'border-t-2 border-t-cyan-400/80',
                        isSelected
                          ? 'bg-gradient-to-b from-cyan-600 to-cyan-800 shadow-[inset_0_0_0_2.5px_#22d3ee,0_0_14px_#22d3ee] z-[2]'
                          : isSameValue
                          ? 'bg-gradient-to-b from-amber-700 to-amber-900'
                          : isPeer
                          ? 'bg-gradient-to-b from-[#19505e] to-[#13414f]'
                          : 'bg-gradient-to-b from-[#123b4a] to-[#0d2e3b]',
                        hasConflict ? 'text-red-400 [text-shadow:0_0_10px_#ef4444]' : isGiven ? 'text-white [text-shadow:0_2px_0_rgba(0,0,0,0.4)]' : 'text-teal-300 [text-shadow:0_0_10px_#14b8a6]',
                      )}
                    >
                      {value !== 0 ? (
                        value
                      ) : notes && notes.length > 0 ? (
                        <div className="grid grid-cols-3 gap-0 w-full h-full p-0.5 text-[8px] font-extrabold text-sky-300 leading-none">
                          {Array.from({ length: 9 }, (_, n) => n + 1).map((n) => (
                            <div key={n} className="flex items-center justify-center">{notes.includes(n) ? n : ''}</div>
                          ))}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* tools */}
          <div className="flex justify-center gap-4 pt-4">
            {[
              { key: 'notes', icon: 'edit_note', label: 'Notes', on: notesMode, onClick: () => setNotesMode((n) => !n), disabled: false, badge: null as number | null },
              { key: 'undo', icon: 'undo', label: 'Undo', on: false, onClick: handleUndo, disabled: history.length === 0, badge: null },
              { key: 'erase', icon: 'backspace', label: 'Erase', on: false, onClick: handleErase, disabled: false, badge: null },
              { key: 'hint', icon: 'lightbulb', label: 'Hint', on: false, onClick: handleHint, disabled: false, badge: game.hintsUsed },
            ].map((t) => (
              <button key={t.key} onClick={t.onClick} disabled={t.disabled} className={clsx('flex flex-col items-center gap-1 text-[10px] font-extrabold text-white/80', t.disabled && 'opacity-40')}>
                <span
                  className={clsx(
                    'relative w-12 h-12 rounded-full flex items-center justify-center border shadow-[0_4px_0_rgba(0,0,0,0.3)] active:translate-y-[2px]',
                    t.on ? 'bg-gradient-to-b from-amber-300 to-amber-600 text-amber-950 border-amber-300 shadow-[0_4px_0_#92400e,0_0_14px_rgba(251,191,36,0.5)]' : 'bg-white/10 border-white/20',
                  )}
                >
                  <span className="material-symbols-outlined text-[22px]">{t.icon}</span>
                  {t.badge != null && t.badge > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center border-2 border-[#0a2c3d]">{t.badge}</span>
                  )}
                </span>
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-3" />

          {/* number keys: how many of each digit are still missing */}
          <div className="grid grid-cols-9 gap-1.5 px-3 pt-3 pb-4 mx-auto w-full max-w-[28rem]">
            {Array.from({ length: 9 }, (_, n) => n + 1).map((n) => {
              const left = Math.max(0, 9 - digitCounts[n]);
              const isDone = left === 0;
              const active = highlightDigit === n;
              return (
                <button
                  key={n}
                  onClick={() => handleDigit(n)}
                  className={clsx(
                    'relative h-14 rounded-xl flex items-center justify-center text-2xl font-black active:translate-y-[3px] transition-transform',
                    active
                      ? 'bg-gradient-to-b from-amber-200 to-amber-500 text-amber-950 shadow-[0_5px_0_#92400e,0_0_14px_rgba(251,191,36,0.5)] -translate-y-0.5'
                      : isDone
                      ? 'bg-gradient-to-b from-[#0f3a47] to-[#0b2c37] text-green-400 shadow-[0_5px_0_#06202b] opacity-75'
                      : 'bg-gradient-to-b from-[#e8f7ff] to-[#b6d8e6] text-[#0a2c3d] shadow-[0_5px_0_#5b8fa3,0_8px_12px_rgba(0,0,0,0.35)]',
                  )}
                >
                  {n}
                  <span className={clsx('absolute bottom-0.5 text-[8px] font-extrabold', isDone ? 'text-green-400' : active ? 'text-amber-900' : 'text-[#3b6b80]')}>
                    {isDone ? '✓' : `${left} left`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {completion && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[280] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="relative w-full max-w-sm p-6 space-y-5 text-center overflow-hidden rounded-3xl border border-cyan-300/30 text-white shadow-[0_0_40px_rgba(34,211,238,0.25)] bg-[radial-gradient(ellipse_at_50%_0%,#0f4d46_0%,#0a2c3d_60%,#06141f_100%)]"
            >
              <Fireworks />
              <style>{`
                @keyframes sdStar{0%{transform:scale(0) rotate(-40deg);opacity:0}70%{transform:scale(1.35) rotate(8deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
                @keyframes sdShine{0%,100%{filter:drop-shadow(0 0 4px #fbbf24)}50%{filter:drop-shadow(0 0 14px #fde047)}}
              `}</style>
              <div className="relative flex items-end justify-center gap-2">
                {[0, 1, 2].map((k) => {
                  const on = k < completion.stars;
                  return (
                    <span
                      key={k}
                      className={`leading-none ${k === 1 ? 'text-[3.6rem] -mb-1' : 'text-[2.8rem]'} ${on ? 'text-amber-300' : 'text-white/15'}`}
                      style={on ? { animation: `sdStar 0.5s cubic-bezier(.3,1.5,.5,1) ${0.15 + k * 0.2}s both, sdShine 1.6s ease-in-out ${1}s infinite` } : undefined}
                    >
                      ★
                    </span>
                  );
                })}
              </div>
              <div className="relative">
                <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-300 to-amber-600">PUZZLE SOLVED!</h2>
                <p className="text-xs font-extrabold text-white/70 mt-1 uppercase tracking-[0.16em]">
                  {completion.stars === 3 ? 'Flawless — no slips, no hints' : completion.stars === 2 ? 'Nicely done' : 'Solved — try for a cleaner run'}
                </p>
              </div>
              <div className="relative rounded-2xl p-4 bg-black/30 border border-white/15">
                <p className="text-[10px] font-extrabold text-white/60 uppercase tracking-[0.16em]">Score · {game.difficulty}</p>
                <p className="text-5xl font-black text-amber-300 [text-shadow:0_0_18px_rgba(251,191,36,0.5)]">{completion.score.toLocaleString()}</p>
                {completion.prevBest === 0 ? (
                  <p className="mt-1 inline-block px-3 py-0.5 rounded-full bg-green-500 text-green-950 text-[11px] font-black">🎉 FIRST SOLVE ON THE BOARD</p>
                ) : completion.score > completion.prevBest ? (
                  <p className="mt-1 inline-block px-3 py-0.5 rounded-full bg-amber-400 text-amber-950 text-[11px] font-black">🏅 NEW PERSONAL BEST (was {completion.prevBest.toLocaleString()})</p>
                ) : (
                  <p className="mt-1 text-[11px] font-bold text-white/60">Personal best: {completion.prevBest.toLocaleString()}</p>
                )}
              </div>
              <div className="relative grid grid-cols-3 gap-2">
                {[
                  { icon: 'schedule', label: 'TIME', value: formatTime(game.elapsedSeconds), tint: 'text-cyan-300' },
                  { icon: 'error', label: 'MISTAKES', value: String(game.mistakes), tint: 'text-red-300' },
                  { icon: 'lightbulb', label: 'HINTS', value: String(game.hintsUsed), tint: 'text-amber-300' },
                ].map((t) => (
                  <div key={t.label} className="rounded-xl bg-black/30 border border-white/15 py-2">
                    <span className={`material-symbols-outlined text-[18px] ${t.tint}`}>{t.icon}</span>
                    <p className="text-lg font-black tabular-nums leading-tight">{t.value}</p>
                    <p className="text-[8px] tracking-[0.14em] text-white/55 font-bold">{t.label}</p>
                  </div>
                ))}
              </div>
              <div className="relative flex flex-col gap-2">
                <ShareWinButton
                  {...(() => {
                    const w = buildWinShare({
                      gameName: 'Sudoku',
                      hero: { kind: 'sudoku' as const, board: game.board, givens: game.givens, difficulty: game.difficulty, time: formatTime(game.elapsedSeconds), stars: completion.stars },
                      winnerLabel: profile?.displayName || user?.displayName || 'Me',
                      standings: [{ name: profile?.displayName || user?.displayName || 'Me', label: `${completion.score.toLocaleString()} pts`, isWinner: true }],
                      detail: `${game.difficulty.charAt(0).toUpperCase()}${game.difficulty.slice(1)} · ${formatTime(game.elapsedSeconds)} · ${'★'.repeat(completion.stars)}`,
                    });
                    return { card: w.card, caption: w.caption };
                  })()}
                />
                <button onClick={handlePlayAgain} className="w-full py-3 rounded-full text-sm font-black tracking-wide text-white bg-gradient-to-b from-green-400 to-green-700 shadow-[0_5px_0_#0f5f2e,0_9px_16px_rgba(0,0,0,0.4)] active:translate-y-[3px] active:shadow-[0_2px_0_#0f5f2e]">
                  PLAY ANOTHER {game.difficulty.toUpperCase()}
                </button>
                <button onClick={() => navigate('/games/sudoku/leaderboard')} className="w-full py-3 rounded-full text-sm font-black bg-white/10 border border-white/25">
                  🏅 View Leaderboard
                </button>
                <button onClick={() => navigate('/tools?category=games')} className="w-full py-2 text-white/60 font-bold text-sm">
                  Back to Games
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
        {completion && celebrationLine && (() => {
          const confetti = Array.from({ length: 36 }).map((_, i) => {
            const ang = (i / 36) * Math.PI * 2 + (i % 3) * 0.2;
            const dist = 120 + ((i * 37) % 100);
            return { dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, color: ['#fbbf24', '#f87171', '#60a5fa', '#4ade80', '#fff', '#22d3ee'][i % 6], delay: (i % 7) * 0.04, rot: (i * 57) % 360 };
          });
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setCelebrationLine(null)}
              className="fixed inset-0 z-[290] flex items-center justify-center p-6 cursor-pointer overflow-hidden"
              style={{ background: 'radial-gradient(circle at 50% 45%, rgba(34,211,238,0.35), rgba(0,0,0,0.85) 70%)' }}
            >
              <style>{`
                @keyframes sdPop{0%{transform:scale(.2) rotate(-8deg);opacity:0}55%{transform:scale(1.25) rotate(3deg);opacity:1}100%{transform:scale(1) rotate(-2deg)}}
                @keyframes sdTile{0%{transform:scale(0) rotate(-20deg);opacity:0}70%{transform:scale(1.2) rotate(4deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
                @keyframes sdGlow{0%,100%{box-shadow:0 0 0 2px #22d3ee,0 0 10px #22d3ee}50%{box-shadow:0 0 0 2px #fde047,0 0 26px #fde047}}
                @keyframes sdBurst{0%{transform:translate(0,0) rotate(0) scale(.4);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
                @keyframes sdRise{0%{transform:translateY(16px);opacity:0}100%{transform:translateY(0);opacity:1}}
              `}</style>
              <div className="absolute left-1/2 top-[45%]">
                {confetti.map((c, i) => (
                  <i
                    key={i}
                    className="absolute block w-2 h-3 rounded-[2px]"
                    style={{ background: c.color, ['--dx' as any]: `${c.dx}px`, ['--dy' as any]: `${c.dy}px`, ['--rot' as any]: `${c.rot}deg`, animation: `sdBurst 1.3s ease-out ${1.0 + c.delay}s both` }}
                  />
                ))}
              </div>
              <div className="relative text-center flex flex-col items-center max-w-xs">
                {/* the nine digits drop into a 3x3 block, one after another */}
                <div className="grid grid-cols-3 gap-1.5 mb-4">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n, k) => (
                    <span
                      key={n}
                      className="w-11 h-11 rounded-lg flex items-center justify-center text-xl font-black text-white bg-gradient-to-b from-[#19505e] to-[#0d2e3b]"
                      style={{ animation: `sdTile 0.4s cubic-bezier(.3,1.4,.5,1) ${0.05 + k * 0.08}s both, sdGlow 1.4s ease-in-out ${0.9}s infinite` }}
                    >
                      {n}
                    </span>
                  ))}
                </div>
                <p
                  className="text-[3.6rem] leading-none font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-300 to-amber-600 drop-shadow-[0_6px_0_rgba(0,0,0,0.45)]"
                  style={{ filter: 'drop-shadow(0 0 22px #22d3ee)', animation: 'sdPop 0.6s cubic-bezier(.2,1.3,.4,1) 0.9s both' }}
                >
                  SOLVED!
                </p>
                <p className="mt-3 text-sm font-extrabold text-white leading-snug" style={{ animation: 'sdRise 0.4s ease-out 1.35s both' }}>{celebrationLine}</p>
                <p className="mt-3 inline-block px-4 py-1.5 rounded-full text-xs font-black text-white bg-teal-600 shadow-lg capitalize" style={{ animation: 'sdRise 0.4s ease-out 1.5s both' }}>
                  {game.difficulty} · {formatTime(game.elapsedSeconds)} · {completion.score.toLocaleString()} pts
                </p>
                <p className="mt-5 text-[11px] font-bold text-white/55 uppercase tracking-wider" style={{ animation: 'sdRise 0.4s ease-out 1.8s both' }}>Tap anywhere to continue</p>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
