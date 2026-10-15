import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { Difficulty } from '../../lib/sudoku';
import LeaderboardArena, { ArenaEntry } from '../../components/LeaderboardArena';
import { LeaderboardPeriod, PERIOD_LABEL, periodValue } from '../../lib/leaderboardPeriods';

const DIFFICULTIES: { id: Difficulty; label: string; color: string }[] = [
  { id: 'easy', label: 'Easy', color: '#16A34A' },
  { id: 'medium', label: 'Medium', color: '#D97706' },
  { id: 'hard', label: 'Hard', color: '#DC2626' },
];

export default function SudokuLeaderboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [period, setPeriod] = useState<LeaderboardPeriod>('all');

  // Single-field where() only — no orderBy — so this needs no composite index. Sorted client-side
  // instead (same pattern used throughout this app) — kept as the FULL ranked list (not capped)
  // so a player's true rank can still be found even when it's outside the visible top 50.
  const [entriesValue, loading] = useCollection(
    query(collection(db, 'sudokuLeaderboard'), where('difficulty', '==', difficulty)),
  );
  const entries: ArenaEntry[] = (entriesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    // `totalScore` is the sum of every completed puzzle's score at this difficulty — falls back to
    // the older `bestScore` field for any doc not yet synced since the sum-based change.
    .map((e) => ({
      id: e.id,
      userId: e.userId,
      userName: e.userName,
      userPhoto: e.userPhoto,
      // Today / This week read the per-day totals stored on the same document (sum of that period's puzzles).
      value: period === 'all' ? e.totalScore ?? e.bestScore ?? 0 : periodValue(e.dayScores, period, 'sum'),
      sub: period === 'all' ? `${e.gamesPlayed} game${e.gamesPlayed !== 1 ? 's' : ''}` : PERIOD_LABEL[period].toLowerCase(),
    }))
    .filter((e) => period === 'all' || e.value > 0)
    .sort((a, b) => b.value - a.value);
  const current = DIFFICULTIES.find((d) => d.id === difficulty)!;

  return (
    <LeaderboardArena
      title="Leaderboard"
      subtitle={`Sudoku · ${PERIOD_LABEL[period]}`}
      backTo="/games/sudoku"
      entries={entries}
      loading={loading}
      myUid={user?.uid}
      playLabel={`Play ${current.label} to climb`}
      onPlay={() => navigate('/games/sudoku')}
      filters={
        <>
        <div className="flex gap-2">
          {(['today', 'week', 'all'] as LeaderboardPeriod[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={clsx('flex-1 py-1.5 rounded-full text-[11px] font-extrabold border', period === p ? 'bg-gradient-to-r from-amber-300 to-amber-200 text-[#1a1300] border-transparent' : 'bg-[#121a2e] text-white/55 border-[#1f2a47]')}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              onClick={() => setDifficulty(d.id)}
              className={clsx('flex-1 py-2 rounded-full text-[11px] font-extrabold border', difficulty === d.id ? 'text-white border-transparent' : 'bg-[#121a2e] text-white/55 border-[#1f2a47]')}
              style={difficulty === d.id ? { backgroundColor: d.color } : undefined}
            >
              {d.label}
            </button>
          ))}
        </div>
        </>
      }
      emptyText={period === 'all' ? 'No scores yet — be the first!' : `Nobody has played ${PERIOD_LABEL[period].toLowerCase()} yet — be the first!`}
    />
  );
}
