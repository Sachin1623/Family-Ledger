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
import { GameLobbyShell, GoldButton, SectionLabel, CodeJoin, LobbyGameCard, IconAction, NewGameSheet, OptionCard, PillPicker, CardPicker, SwitchRow, turnChipFor, lobbyStats } from '../../components/GameLobbyKit';

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

  const totalPlayed = DIFFICULTIES.reduce((n, d) => n + getCompletedCount(d.id), 0);
  const overallBest = Math.max(0, ...DIFFICULTIES.map((d) => Math.max(best[d.id].bestScore, myLeaderboardEntry[d.id]?.bestScore ?? 0)));
  const inProgress = DIFFICULTIES.filter((d) => !!loadActiveGame(d.id)).length;
  const TINT: Record<string, { card: string; dot: string }> = {
    easy: { card: 'border-green-600/40 bg-[#0f2a1c]', dot: 'bg-green-600/25' },
    medium: { card: 'border-amber-600/40 bg-[#2a1d0a]', dot: 'bg-amber-600/25' },
    hard: { card: 'border-red-600/40 bg-[#2a1013]', dot: 'bg-red-600/25' },
  };

  return (
    <GameLobbyShell
      title="Sudoku"
      emoji="🔢"
      tagline="Plays fully offline — scores sync when you're back online."
      gradient={['#1d5a3a', '#0f2f24']}
      stats={[{ label: 'Puzzles', value: totalPlayed }, { label: 'Best', value: overallBest.toLocaleString() }, { label: 'In progress', value: inProgress }]}
      ranksPath="/games/sudoku/leaderboard"
      help={{ content: SUDOKU_HELP }}
    >
      <section className="space-y-2.5">
        <SectionLabel>Choose a difficulty</SectionLabel>
        {DIFFICULTIES.map((d) => {
          const activeGame = loadActiveGame(d.id);
          const myBest = Math.max(best[d.id].bestScore, myLeaderboardEntry[d.id]?.bestScore ?? 0);
          const world = overallBestByDifficulty[d.id];
          return (
            <div key={d.id} className={clsx('rounded-[1.1rem] border-[1.5px] p-3 space-y-2.5', TINT[d.id].card)}>
              <div className="flex items-center gap-3">
                <span className={clsx('w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0', TINT[d.id].dot)}>
                  <span className="w-4 h-4 rounded-full" style={{ backgroundColor: d.color }} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black">{d.label}</p>
                  <p className="text-[10px] font-bold text-white/60">
                    {myBest > 0 ? <>My best {myBest.toLocaleString()}</> : 'Not tried yet'} · played {getCompletedCount(d.id)} · {bankSize(d.id).toLocaleString()} puzzles
                  </p>
                </div>
                {!activeGame && (
                  <button onClick={() => handlePlay(d.id)} className="px-4 py-2 rounded-xl text-xs font-black bg-white text-[#0c1230] shrink-0">Play</button>
                )}
              </div>
              {world && (
                <div className="flex items-center gap-2 rounded-xl bg-black/25 px-2.5 py-1.5">
                  <div className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center text-[9px] font-black overflow-hidden shrink-0">
                    {world.userPhoto ? <img src={world.userPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : world.userName?.slice(0, 1) || '?'}
                  </div>
                  <p className="text-[10px] font-bold text-white/60 flex-1 truncate">World best · <span className="text-white">{world.userName}</span>{world.userId === user?.uid && ' (You)'}</p>
                  <span className="text-[11px] font-black text-amber-300 shrink-0">{(world.bestScore ?? 0).toLocaleString()}</span>
                </div>
              )}
              {activeGame && (
                <div className="flex gap-2 items-center rounded-xl border border-amber-300/60 bg-gradient-to-r from-[#3b2a05] to-[#1a1300] px-2.5 py-2">
                  <span className="text-lg">⏱</span>
                  <p className="flex-1 text-[11px] font-extrabold">Puzzle in progress</p>
                  <button onClick={() => handleResume(d.id)} className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-amber-300 text-[#1a1300]">Resume</button>
                  <button onClick={() => handlePlay(d.id)} className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-white/10 border border-white/15">New</button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <button onClick={() => navigate('/games/sudoku/leaderboard')} className="w-full flex items-center gap-2 rounded-2xl bg-[#121a2e] border border-[#1f2a47] px-3 py-3 text-xs font-extrabold">
        🏅 <span>Leaderboard</span> <span className="ml-auto text-white/50">Today · This week · All time ›</span>
      </button>
    </GameLobbyShell>
  );
}
