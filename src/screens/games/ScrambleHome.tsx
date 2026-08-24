import React from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import {
  ScrambleWordLength,
  ScrambleTimerMode,
  WORD_LENGTHS,
  TIMER_MODES,
  TIMER_MODE_LABEL,
  getBest,
  loadActiveGame,
  clearActiveGame,
  startNewGame,
  isMatchOver,
  finalizeMatch,
} from '../../lib/scramble';
import { flushPendingScrambleScores } from '../../lib/scrambleSync';
import { GameHelpModal, HelpButton } from '../../components/GameHelpModal';
import { SCRAMBLE_HELP } from '../../lib/gameHelp';

const WORD_LENGTH_PREF_KEY = 'fl_scramble_pref_length';
const TIMER_MODE_PREF_KEY = 'fl_scramble_pref_timer';

export default function ScrambleHome() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [showHelp, setShowHelp] = React.useState(false);
  const [wordLength, setWordLength] = React.useState<ScrambleWordLength>(() => {
    const saved = Number(localStorage.getItem(WORD_LENGTH_PREF_KEY));
    return (WORD_LENGTHS as number[]).includes(saved) ? (saved as ScrambleWordLength) : 6;
  });
  const [timerMode, setTimerMode] = React.useState<ScrambleTimerMode>(() => {
    const saved = localStorage.getItem(TIMER_MODE_PREF_KEY) as ScrambleTimerMode | null;
    return saved && (TIMER_MODES as string[]).includes(saved) ? saved : '3min';
  });
  const [activeGame, setActiveGame] = React.useState(() => loadActiveGame());
  const [justFinished, setJustFinished] = React.useState<{ score: number; brokeBest: boolean } | null>(null);

  React.useEffect(() => {
    flushPendingScrambleScores();
  }, []);

  // A match left running past its own deadline (app backgrounded/closed and not reopened until
  // now) gets finalized the moment we're back here, rather than leaving a stale "Resume" that
  // would just instantly end the second it opens.
  React.useEffect(() => {
    const game = loadActiveGame();
    if (game && isMatchOver(game)) {
      const result = finalizeMatch(game);
      setActiveGame(null);
      setJustFinished({ score: result.score, brokeBest: result.brokeBest });
    }
  }, []);

  React.useEffect(() => { localStorage.setItem(WORD_LENGTH_PREF_KEY, String(wordLength)); }, [wordLength]);
  React.useEffect(() => { localStorage.setItem(TIMER_MODE_PREF_KEY, timerMode); }, [timerMode]);

  const best = getBest(wordLength, timerMode);

  const [leaderboardValue] = useCollection(
    query(collection(db, 'scrambleLeaderboard'), where('wordLength', '==', wordLength)),
  );
  const overallBest = React.useMemo(() => {
    let top: any = null;
    leaderboardValue?.docs.forEach((d) => {
      const data = d.data() as any;
      if (data.timerMode !== timerMode) return;
      if (!top || (data.bestScore ?? 0) > (top.bestScore ?? 0)) top = data;
    });
    return top;
  }, [leaderboardValue, timerMode]);

  const canResume = !!activeGame && activeGame.wordLength === wordLength && activeGame.timerMode === timerMode && !isMatchOver(activeGame);

  const handlePlay = () => {
    if (canResume) {
      navigate('/games/scramble/play');
      return;
    }
    if (activeGame && !isMatchOver(activeGame)) {
      if (!window.confirm('This will discard your in-progress match. Continue?')) return;
    }
    clearActiveGame();
    const game = startNewGame(wordLength, timerMode);
    setActiveGame(game);
    navigate('/games/scramble/play');
  };

  const handleNewInstead = () => {
    if (!window.confirm('This will discard your in-progress match. Continue?')) return;
    clearActiveGame();
    const game = startNewGame(wordLength, timerMode);
    setActiveGame(game);
    navigate('/games/scramble/play');
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-black text-primary">Scramble</h1>
            <p className="text-sm text-text-muted mt-1">Plays fully offline — scores sync when you're back online.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <HelpButton onClick={() => setShowHelp(true)} />
            <button
              onClick={() => navigate('/games/scramble/leaderboard')}
              className="flex items-center gap-1.5 px-3 py-2 bg-primary/5 text-primary rounded-xl text-xs font-bold"
            >
              <span className="material-symbols-outlined text-[16px]">leaderboard</span>
              Leaderboard
            </button>
          </div>
        </div>

        {showHelp && <GameHelpModal content={SCRAMBLE_HELP} onClose={() => setShowHelp(false)} />}

        <button
          onClick={() => navigate('/games/scramble-multiplayer')}
          className="w-full bg-primary/5 border border-primary/20 rounded-2xl p-4 flex items-center justify-between"
        >
          <div className="text-left">
            <p className="text-sm font-bold text-primary">Play Multiplayer</p>
            <p className="text-[11px] text-text-muted mt-0.5">Race up to 4 players through the same word sequence, live.</p>
          </div>
          <span className="material-symbols-outlined text-primary">chevron_right</span>
        </button>

        {justFinished && (
          <div className="bg-primary/5 border border-primary/20 rounded-2xl p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-primary uppercase tracking-wider">Last match</p>
              <p className="text-sm text-on-surface mt-0.5">
                Scored <span className="font-black text-primary">{justFinished.score}</span>
                {justFinished.brokeBest && <span className="ml-1 font-bold text-success">— new personal best! 🎉</span>}
              </p>
            </div>
            <button onClick={() => setJustFinished(null)} className="p-1.5 text-text-muted shrink-0">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-4">
          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Word Length</p>
            <div className="flex flex-wrap gap-2">
              {WORD_LENGTHS.map((n) => (
                <button
                  key={n}
                  onClick={() => setWordLength(n)}
                  className={clsx(
                    'w-10 h-10 rounded-xl text-sm font-bold border',
                    wordLength === n ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Timer</p>
            <div className="flex gap-2">
              {TIMER_MODES.map((m) => (
                <button
                  key={m}
                  onClick={() => setTimerMode(m)}
                  className={clsx(
                    'flex-1 py-2.5 rounded-xl text-sm font-bold border',
                    timerMode === m ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {TIMER_MODE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
          <div className="flex items-center justify-between text-[11px] text-text-muted">
            {best.bestScore > 0 && (
              <span>My best: <span className="font-bold text-primary">{best.bestScore.toLocaleString()}</span></span>
            )}
            <span>Played: <span className="font-bold text-on-surface">{best.gamesPlayed}</span></span>
          </div>
          {overallBest && overallBest.bestScore > 0 && (
            <div className="flex items-center gap-2 bg-surface rounded-xl px-2.5 py-1.5">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary text-[9px] font-bold overflow-hidden shrink-0">
                {overallBest.userPhoto ? (
                  <img src={overallBest.userPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  overallBest.userName?.slice(0, 1) || '?'
                )}
              </div>
              <p className="text-[10px] text-text-muted flex-1 truncate">
                Overall best: <span className="font-bold text-on-surface">{overallBest.userName}</span>
                {overallBest.userId === user?.uid && ' (You)'}
              </p>
              <span className="text-[11px] font-black text-primary shrink-0">{overallBest.bestScore.toLocaleString()}</span>
            </div>
          )}

          {canResume ? (
            <div className="flex gap-2">
              <button onClick={handlePlay} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white bg-primary">
                Resume
              </button>
              <button onClick={handleNewInstead} className="px-4 py-2.5 rounded-xl text-sm font-bold text-text-muted border border-border-subtle">
                New
              </button>
            </div>
          ) : (
            <button onClick={handlePlay} className="w-full py-2.5 rounded-xl text-sm font-bold text-white bg-primary">
              Play
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
