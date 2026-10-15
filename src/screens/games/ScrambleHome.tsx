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
import { GameLobbyShell, GoldButton, SectionLabel, PillPicker } from '../../components/GameLobbyKit';

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
    <GameLobbyShell
      title="Scramble"
      emoji="🔤"
      tagline="Plays fully offline — scores sync when you're back online."
      gradient={['#2b5a7a', '#12283a']}
      stats={[{ label: `Best · ${wordLength}-letter`, value: best.bestScore > 0 ? best.bestScore.toLocaleString() : '—' }, { label: 'Played', value: best.gamesPlayed }]}
      ranksPath="/games/scramble/leaderboard"
      help={{ content: SCRAMBLE_HELP }}
    >
      {justFinished && (
        <div className="rounded-2xl border border-emerald-400/40 bg-emerald-500/10 p-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-extrabold tracking-[0.14em] text-emerald-300">LAST MATCH</p>
            <p className="text-sm font-bold mt-0.5">
              Scored <span className="font-black text-amber-300">{justFinished.score}</span>
              {justFinished.brokeBest && <span className="ml-1 font-extrabold text-emerald-300">— new personal best! 🎉</span>}
            </p>
          </div>
          <button onClick={() => setJustFinished(null)} className="p-1.5 text-white/60 shrink-0">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {canResume && (
        <div className="flex items-center gap-2.5 rounded-2xl border-[1.5px] border-amber-300 bg-gradient-to-r from-[#3b2a05] to-[#1a1300] px-3 py-2.5">
          <span className="text-xl">⏱</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-black">Match in progress</p>
            <p className="text-[10px] font-extrabold text-amber-300">{wordLength}-letter · {TIMER_MODE_LABEL[timerMode]}</p>
          </div>
          <button onClick={handlePlay} className="px-3.5 py-2 rounded-xl text-[11px] font-black bg-amber-300 text-[#1a1300]">Resume</button>
          <button onClick={handleNewInstead} className="px-3 py-2 rounded-xl text-[11px] font-black bg-white/10 border border-white/15">New</button>
        </div>
      )}

      <section className="rounded-2xl bg-[#121a2e] border border-[#1f2a47] p-3.5 space-y-3">
        <div>
          <SectionLabel>Word length</SectionLabel>
          <div className="mt-2"><PillPicker options={WORD_LENGTHS as readonly ScrambleWordLength[]} value={wordLength} onChange={setWordLength} /></div>
        </div>
        <div>
          <SectionLabel>Timer</SectionLabel>
          <div className="mt-2"><PillPicker options={TIMER_MODES as readonly ScrambleTimerMode[]} value={timerMode} onChange={setTimerMode} format={(m) => TIMER_MODE_LABEL[m]} /></div>
        </div>
        {overallBest && overallBest.bestScore > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-black/25 px-2.5 py-1.5">
            <div className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center text-[9px] font-black overflow-hidden shrink-0">
              {overallBest.userPhoto ? <img src={overallBest.userPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : overallBest.userName?.slice(0, 1) || '?'}
            </div>
            <p className="text-[10px] font-bold text-white/60 flex-1 truncate">World best · <span className="text-white">{overallBest.userName}</span>{overallBest.userId === user?.uid && ' (You)'}</p>
            <span className="text-[11px] font-black text-amber-300 shrink-0">{overallBest.bestScore.toLocaleString()}</span>
          </div>
        )}
      </section>

      {!canResume && <GoldButton onClick={handlePlay}>▶ Play {wordLength}-letter · {TIMER_MODE_LABEL[timerMode]}</GoldButton>}

      <button onClick={() => navigate('/games/scramble-multiplayer')} className="w-full flex items-center gap-3 rounded-2xl bg-[#121a2e] border border-[#1f2a47] px-3.5 py-3 text-left">
        <span className="text-2xl">🏁</span>
        <span className="flex-1">
          <span className="block text-sm font-black">Race the family</span>
          <span className="block text-[10px] font-bold text-white/55">Up to 4 players, the same words, live.</span>
        </span>
        <span className="material-symbols-outlined text-white/50">chevron_right</span>
      </button>

      <button onClick={() => navigate('/games/scramble/leaderboard')} className="w-full flex items-center gap-2 rounded-2xl bg-[#121a2e] border border-[#1f2a47] px-3 py-3 text-xs font-extrabold">
        🏅 <span>Leaderboard</span> <span className="ml-auto text-white/50">Today · This week · All time ›</span>
      </button>
    </GameLobbyShell>
  );
}
