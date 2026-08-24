import React from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import {
  Difficulty,
  bankSize,
  getCompletedCount,
  loadActiveGame,
  readBestScores,
  startNewGame,
} from '../../lib/sudoku';
import { flushPendingSudokuScores } from '../../lib/sudokuSync';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SUDOKU_HELP } from '../../lib/gameHelp';

const DIFFICULTIES: { id: Difficulty; label: string; color: string }[] = [
  { id: 'easy', label: 'Easy', color: '#0F7A38' },
  { id: 'medium', label: 'Medium', color: '#B45309' },
  { id: 'hard', label: 'Hard', color: '#B91C1C' },
];

export default function SudokuHome() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const best = readBestScores();
  const [showHelp, setShowHelp] = React.useState(false);

  React.useEffect(() => {
    flushPendingSudokuScores();
  }, []);

  // "Overall best" per difficulty = whoever holds the single highest-scoring puzzle at that
  // difficulty (`bestScore`, distinct from `totalScore`, the lifetime sum used on the separate
  // Leaderboard screen). Fetched once, unfiltered, and grouped client-side by difficulty (same
  // no-composite-index convention as the Leaderboard screen) since the whole collection is small
  // (one doc per user per difficulty).
  const [leaderboardValue] = useCollection(collection(db, 'sudokuLeaderboard'));
  const overallBestByDifficulty = React.useMemo(() => {
    const map: Partial<Record<Difficulty, any>> = {};
    leaderboardValue?.docs.forEach((d) => {
      const data = d.data() as any;
      const diff = data.difficulty as Difficulty;
      const score = data.bestScore ?? 0;
      if (score <= 0) return;
      const currentBest = map[diff];
      const currentScore = currentBest ? (currentBest.bestScore ?? 0) : -1;
      if (score > currentScore) map[diff] = data;
    });
    return map;
  }, [leaderboardValue]);

  // Local storage only knows about puzzles finished on THIS device — if the overall best happens
  // to be the signed-in user (e.g. they set it from another device), fall back to their own synced
  // Firestore entry instead of showing a stale/zero local value.
  const myLeaderboardEntry = React.useMemo(() => {
    const map: Partial<Record<Difficulty, any>> = {};
    leaderboardValue?.docs.forEach((d) => {
      const data = d.data() as any;
      if (data.userId === user?.uid) map[data.difficulty as Difficulty] = data;
    });
    return map;
  }, [leaderboardValue, user?.uid]);

  // Each difficulty keeps its own independent active-game slot (see sudoku.ts), so easy/medium/
  // hard can each be mid-puzzle at once — starting or resuming one never touches another. Only
  // confirm when "New" would actually discard a puzzle already in progress at that difficulty.
  const handlePlay = (difficulty: Difficulty) => {
    const existing = loadActiveGame(difficulty);
    if (existing && existing.board.some((v, i) => v !== existing.givens[i])) {
      if (!window.confirm(`This will discard your in-progress ${difficulty} game. Continue?`)) return;
    }
    startNewGame(difficulty);
    navigate(`/games/sudoku/play/${difficulty}`);
  };

  const handleResume = (difficulty: Difficulty) => navigate(`/games/sudoku/play/${difficulty}`);

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-black text-primary">Sudoku</h1>
            <p className="text-sm text-text-muted mt-1">Plays fully offline — scores sync when you're back online.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <HelpButton onClick={() => setShowHelp(true)} />
            <button
              onClick={() => navigate('/games/sudoku/leaderboard')}
              className="flex items-center gap-1.5 px-3 py-2 bg-primary/5 text-primary rounded-xl text-xs font-bold"
            >
              <span className="material-symbols-outlined text-[16px]">leaderboard</span>
              Leaderboard
            </button>
          </div>
        </div>

        {showHelp && <GameHelpModal content={SUDOKU_HELP} onClose={() => setShowHelp(false)} />}

        <div className="space-y-3">
          {DIFFICULTIES.map((d) => {
            const activeGame = loadActiveGame(d.id);
            const myBest = Math.max(best[d.id].bestScore, myLeaderboardEntry[d.id]?.bestScore ?? 0);
            return (
              <div key={d.id} className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                    <p className="font-bold text-on-surface">{d.label}</p>
                  </div>
                  <p className="text-[10px] text-text-muted font-bold uppercase tracking-wider">
                    {bankSize(d.id).toLocaleString()} puzzles
                  </p>
                </div>
                <div className="flex items-center justify-between text-[11px] text-text-muted">
                  {myBest > 0 && (
                    <span>My best: <span className="font-bold text-primary">{myBest.toLocaleString()}</span></span>
                  )}
                  <span>Played: <span className="font-bold text-on-surface">{getCompletedCount(d.id)}</span></span>
                </div>
                {overallBestByDifficulty[d.id] && (
                  <div className="flex items-center gap-2 bg-surface rounded-xl px-2.5 py-1.5">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary text-[9px] font-bold overflow-hidden shrink-0">
                      {overallBestByDifficulty[d.id].userPhoto ? (
                        <img
                          src={overallBestByDifficulty[d.id].userPhoto}
                          alt=""
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        overallBestByDifficulty[d.id].userName?.slice(0, 1) || '?'
                      )}
                    </div>
                    <p className="text-[10px] text-text-muted flex-1 truncate">
                      Overall best: <span className="font-bold text-on-surface">{overallBestByDifficulty[d.id].userName}</span>
                      {overallBestByDifficulty[d.id].userId === user?.uid && ' (You)'}
                    </p>
                    <span className="text-[11px] font-black text-primary shrink-0">
                      {(overallBestByDifficulty[d.id].bestScore ?? 0).toLocaleString()}
                    </span>
                  </div>
                )}
                {activeGame ? (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleResume(d.id)}
                      className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white"
                      style={{ backgroundColor: d.color }}
                    >
                      Resume
                    </button>
                    <button
                      onClick={() => handlePlay(d.id)}
                      className="px-4 py-2.5 rounded-xl text-sm font-bold text-text-muted border border-border-subtle"
                    >
                      New
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handlePlay(d.id)}
                    className={clsx('w-full py-2.5 rounded-xl text-sm font-bold text-white')}
                    style={{ backgroundColor: d.color }}
                  >
                    Play
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
