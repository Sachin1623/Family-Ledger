import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { ScrambleWordLength, ScrambleTimerMode, WORD_LENGTHS, TIMER_MODES, TIMER_MODE_LABEL } from '../../lib/scramble';
import LeaderboardArena, { ArenaEntry } from '../../components/LeaderboardArena';
import { LeaderboardPeriod, PERIOD_LABEL, periodValue } from '../../lib/leaderboardPeriods';

export default function ScrambleLeaderboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [wordLength, setWordLength] = useState<ScrambleWordLength>(6);
  const [timerMode, setTimerMode] = useState<ScrambleTimerMode>('3min');
  const [period, setPeriod] = useState<LeaderboardPeriod>('all');

  // Single-field where() only — no orderBy — so this needs no composite index. Filtered to the
  // other axis and sorted client-side, same pattern used throughout this app — kept as the FULL
  // ranked list (not capped) so a player's true rank can still be found even when it's outside
  // the visible top 50.
  const [entriesValue, loading] = useCollection(
    query(collection(db, 'scrambleLeaderboard'), where('wordLength', '==', wordLength)),
  );
  const entries: ArenaEntry[] = (entriesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [])
    .filter((e) => e.timerMode === timerMode)
    .map((e) => ({
      id: e.id,
      userId: e.userId,
      userName: e.userName,
      userPhoto: e.userPhoto,
      // Today / This week: the best single match inside that period (stored per day on the same document).
      value: period === 'all' ? e.bestScore ?? 0 : periodValue(e.dayScores, period, 'max'),
      sub: period === 'all' ? `${e.gamesPlayed} match${e.gamesPlayed !== 1 ? 'es' : ''}` : `best match ${PERIOD_LABEL[period].toLowerCase()}`,
    }))
    .filter((e) => period === 'all' || e.value > 0)
    .sort((a, b) => b.value - a.value);

  const pill = (on: boolean) => clsx('flex-1 py-1.5 rounded-full text-[11px] font-extrabold border', on ? 'bg-gradient-to-r from-amber-300 to-amber-200 text-[#1a1300] border-transparent' : 'bg-[#121a2e] text-white/55 border-[#1f2a47]');

  return (
    <LeaderboardArena
      title="Leaderboard"
      subtitle={`Scramble · best single match · ${PERIOD_LABEL[period]}`}
      backTo="/games/scramble"
      entries={entries}
      loading={loading}
      myUid={user?.uid}
      playLabel={`Play ${wordLength}-letter · ${TIMER_MODE_LABEL[timerMode]}`}
      onPlay={() => navigate('/games/scramble')}
      emptyText={period === 'all' ? 'No scores yet — be the first!' : `Nobody has played ${PERIOD_LABEL[period].toLowerCase()} yet — be the first!`}
      filters={
        <>
          <div className="flex gap-2">
            {(['today', 'week', 'all'] as LeaderboardPeriod[]).map((p) => (
              <button key={p} onClick={() => setPeriod(p)} className={pill(period === p)}>{PERIOD_LABEL[p]}</button>
            ))}
          </div>
          <div className="flex gap-1.5">
            {WORD_LENGTHS.map((n) => (
              <button key={n} onClick={() => setWordLength(n)} className={pill(wordLength === n)}>{n}</button>
            ))}
          </div>
          <div className="flex gap-2">
            {TIMER_MODES.map((m) => (
              <button key={m} onClick={() => setTimerMode(m)} className={pill(timerMode === m)}>{TIMER_MODE_LABEL[m]}</button>
            ))}
          </div>
        </>
      }
    />
  );
}
