import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { Difficulty } from '../../lib/sudoku';

const DIFFICULTIES: { id: Difficulty; label: string; color: string }[] = [
  { id: 'easy', label: 'Easy', color: '#0F7A38' },
  { id: 'medium', label: 'Medium', color: '#B45309' },
  { id: 'hard', label: 'Hard', color: '#B91C1C' },
];

export default function SudokuLeaderboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');

  // Single-field where() only — no orderBy — so this needs no composite index. Sorted client-side
  // instead (same pattern used throughout this app) — kept as the FULL ranked list (not capped)
  // so a player's true rank can still be found even when it's outside the visible top 50.
  const [entriesValue, loading] = useCollection(
    query(collection(db, 'sudokuLeaderboard'), where('difficulty', '==', difficulty)),
  );
  const allEntries = (entriesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    // `totalScore` is the sum of every completed puzzle's score at this difficulty — falls back to
    // the older `bestScore` field for any doc not yet synced since the sum-based change.
    .sort((a, b) => (b.totalScore ?? b.bestScore ?? 0) - (a.totalScore ?? a.bestScore ?? 0));
  const entries = allEntries.slice(0, 50);
  const myRank = allEntries.findIndex((e) => e.userId === user?.uid) + 1; // 0 if I have no entry yet
  const myEntry = myRank > 0 ? allEntries[myRank - 1] : null;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <button onClick={() => navigate('/games/sudoku')} className="text-xs font-bold text-primary flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Sudoku
        </button>

        <div>
          <h1 className="text-2xl font-black text-primary">Leaderboard</h1>
          <p className="text-sm text-text-muted mt-1">Top scores across all FamilyLedger players.</p>
        </div>

        <div className="flex gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              onClick={() => setDifficulty(d.id)}
              className={clsx('flex-1 py-2.5 rounded-xl text-xs font-bold border capitalize', difficulty === d.id ? 'text-white border-transparent' : 'bg-white text-text-muted border-border-subtle')}
              style={difficulty === d.id ? { backgroundColor: d.color } : undefined}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
          {loading && <p className="p-6 text-sm text-text-muted text-center">Loading…</p>}
          {!loading && entries.length === 0 && <p className="p-6 text-sm text-text-muted italic text-center">No scores yet — be the first!</p>}
          {entries.map((entry, idx) => {
            const isMe = entry.userId === user?.uid;
            return (
              <div key={entry.id} className={clsx('p-4 flex items-center gap-3', isMe && 'bg-primary/5')}>
                <span className="w-6 text-center text-sm font-black text-text-muted">{idx + 1}</span>
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
                  {entry.userPhoto ? (
                    <img src={entry.userPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    entry.userName?.slice(0, 1) || '?'
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-on-surface truncate">{entry.userName}{isMe && ' (You)'}</p>
                  <p className="text-[10px] text-text-muted">{entry.gamesPlayed} game{entry.gamesPlayed !== 1 ? 's' : ''}</p>
                </div>
                <p className="text-sm font-black text-primary shrink-0">{(entry.totalScore ?? entry.bestScore ?? 0).toLocaleString()}</p>
              </div>
            );
          })}
        </div>

        {/* Pinned own-rank row — only needed when I'm ranked outside the visible top 50, since
            inside it I'm already highlighted above like everyone else. */}
        {myRank > 50 && myEntry && (
          <div className="bg-primary/5 rounded-2xl border-2 border-primary/20 p-4 flex items-center gap-3">
            <span className="w-6 text-center text-sm font-black text-primary">{myRank}</span>
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
              {myEntry.userPhoto ? (
                <img src={myEntry.userPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                myEntry.userName?.slice(0, 1) || '?'
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-on-surface truncate">{myEntry.userName} (You)</p>
              <p className="text-[10px] text-text-muted">{myEntry.gamesPlayed} game{myEntry.gamesPlayed !== 1 ? 's' : ''}</p>
            </div>
            <p className="text-sm font-black text-primary shrink-0">{(myEntry.totalScore ?? myEntry.bestScore ?? 0).toLocaleString()}</p>
          </div>
        )}
      </main>
    </div>
  );
}
