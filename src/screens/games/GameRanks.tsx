import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { sideForSeat as sequenceSideForSeat } from '../../lib/sequence';
import { useLanguage } from '../../context/LanguageContext';

type GameType = 'ludo' | 'rummy' | 'rummy13' | 'business' | 'sweep' | 'chess' | 'sequence' | 'spadePledge';
type Period = 'day' | 'week' | 'month' | 'year' | 'lifetime';

// 'individual': a single `winnerUid` per game (Ludo/Rummy/Business). 'team': fixed partnerships,
// `winnerTeam` compared against a player's own `team` field (Sweep, 4-player). 'color': each
// player has an individual `color` and the game has a `result` of that color, `'draw'`, or `null`
// (Chess) — the only mode where a decided game can have NO winner at all without being an
// "ended early" no-result game, since a draw is a real, countable outcome. 'side': like 'team',
// but the team assignment isn't a stored field — Sequence's playerCount decides per-game whether
// it's individual (2/3 players) or partnerships (4/6/8/9/10/12), so "which side is seat N on" has
// to be recomputed per game via `sideForSeat`, not read off a fixed `team` property.
type ResultMode = 'individual' | 'team' | 'color' | 'side';

const PERIODS: { id: Period; labelKey: string }[] = [
  { id: 'day', labelKey: 'gameRanks.today' },
  { id: 'week', labelKey: 'gameRanks.thisWeek' },
  { id: 'month', labelKey: 'gameRanks.thisMonth' },
  { id: 'year', labelKey: 'gameRanks.thisYear' },
  { id: 'lifetime', labelKey: 'gameRanks.lifetime' },
];

const GAME_META: Record<GameType, { gameLabelKey: string; collection: string; backTo: string; resultMode: ResultMode }> = {
  ludo: { gameLabelKey: 'games.ludo', collection: 'ludoGames', backTo: '/games/ludo', resultMode: 'individual' },
  rummy: { gameLabelKey: 'games.rummy', collection: 'rummyGames', backTo: '/games/rummy', resultMode: 'individual' },
  rummy13: { gameLabelKey: 'games.rummy13', collection: 'rummy13Tables', backTo: '/games/rummy13', resultMode: 'individual' },
  business: { gameLabelKey: 'games.business', collection: 'businessGames', backTo: '/games/business', resultMode: 'individual' },
  sweep: { gameLabelKey: 'games.sweep', collection: 'sweepGames', backTo: '/games/sweep', resultMode: 'team' },
  chess: { gameLabelKey: 'games.chess', collection: 'chessGames', backTo: '/games/chess', resultMode: 'color' },
  sequence: { gameLabelKey: 'games.sequence', collection: 'sequenceGames', backTo: '/games/sequence', resultMode: 'side' },
  spadePledge: { gameLabelKey: 'games.spadePledge', collection: 'spadePledgeTables', backTo: '/games/spadePledge', resultMode: 'team' },
};

type Outcome = 'win' | 'loss' | 'draw';

// A game "counts" toward ranks only once it has a genuine decided outcome — excludes "ended
// early" games with no result, same idea across all three result shapes.
function hasDecidedOutcome(g: any, resultMode: ResultMode): boolean {
  if (resultMode === 'team') return g.winnerTeam != null;
  if (resultMode === 'side') return g.winnerSide != null;
  if (resultMode === 'color') return g.result != null;
  return !!g.winnerUid;
}

// Player `uid`'s outcome in game `g`. Team games: compare their own `team` to `winnerTeam`. Side
// games (Sequence): recompute their side from `seatIndex`/`playerCount` and compare to
// `winnerSide` — there's no stored `team` field, since whether a given seat even HAS a partner
// depends on that game's playerCount. Color games (Chess): compare their own `color` to `result`,
// with `'draw'` handled explicitly since it's a real third outcome, not a fallthrough loss.
// Individual games: direct `winnerUid` match, and can never be a draw.
function getOutcome(g: any, uid: string, resultMode: ResultMode): Outcome {
  if (resultMode === 'team') {
    const me = (g.players || []).find((p: any) => p.uid === uid);
    return me && g.winnerTeam === me.team ? 'win' : 'loss';
  }
  if (resultMode === 'side') {
    const me = (g.players || []).find((p: any) => p.uid === uid);
    return me && sequenceSideForSeat(me.seatIndex, g.playerCount) === g.winnerSide ? 'win' : 'loss';
  }
  if (resultMode === 'color') {
    if (g.result === 'draw') return 'draw';
    const me = (g.players || []).find((p: any) => p.uid === uid);
    return me && g.result === me.color ? 'win' : 'loss';
  }
  return g.winnerUid === uid ? 'win' : 'loss';
}

// Whether uidA and uidB were on the SAME side in game `g` — used to split the "other players
// I've played with" list into partners (share your outcome) vs opponents (you beat or lost to).
// Only 'team'/'side' games can ever have partners at all.
function isSameSide(g: any, uidA: string, uidB: string, resultMode: ResultMode): boolean {
  const players: any[] = g.players || [];
  const a = players.find((p) => p.uid === uidA);
  const b = players.find((p) => p.uid === uidB);
  if (!a || !b) return false;
  if (resultMode === 'team') return a.team === b.team;
  if (resultMode === 'side') return sequenceSideForSeat(a.seatIndex, g.playerCount) === sequenceSideForSeat(b.seatIndex, g.playerCount);
  return false;
}

// Calendar-based boundaries (start of today / this ISO week (Mon) / this month / this year), not
// rolling windows — matches how "today's"/"this week's" rankings are usually understood.
function getPeriodStart(period: Period): Date | null {
  const now = new Date();
  if (period === 'lifetime') return null;
  if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = d.getDay();
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return d;
  }
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date(now.getFullYear(), 0, 1); // year
}

interface OpponentStats {
  uid: string;
  displayName: string;
  photoURL: string;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
}

export default function GameRanks() {
  const navigate = useNavigate();
  const { gameType: rawGameType } = useParams<{ gameType: string }>();
  const gameType: GameType = (['rummy', 'rummy13', 'business', 'sweep', 'chess', 'sequence', 'spadePledge'].includes(rawGameType || '') ? rawGameType : 'ludo') as GameType;
  const meta = GAME_META[gameType];
  // 'side' games (Sequence) can ALSO have partners, just not on every game (2/3-player Sequence is
  // individual) — the Partners section still renders, it's just empty for those periods/matchups.
  const teamCapable = meta.resultMode === 'team' || meta.resultMode === 'side';
  const { user } = useAuth();
  const { t } = useLanguage();
  const [period, setPeriod] = useState<Period>('lifetime');

  // Same single-where-clause pattern used everywhere else in this app (LudoLobby's "Your Games"
  // query, SudokuLeaderboard) — combining an array-contains filter with an equality filter would
  // need a composite index, so status=='finished' and the date-period cutoff are both applied
  // client-side instead.
  const [gamesValue, loading] = useCollection(
    user ? query(collection(db, meta.collection), where('playerUids', 'array-contains', user.uid)) : null,
  );
  // A finished game can be deleted from the live collection above (see the game's own "delete"
  // button — it only ever refuses to delete an ACTIVE game, so a just-finished win/loss is fair
  // game). `gameOutcomes` is a permanent, un-deletable record of exactly the outcome fields Ranks
  // needs, written at the same moment the game finishes — merged in here (by id, live doc wins if
  // both exist) so a deleted game's result still counts. Only rummy/sweep/sequence write to it so
  // far; the query is harmless (just empty) for the other game types until they do too.
  const [outcomesValue] = useCollection(
    user ? query(collection(db, 'gameOutcomes'), where('playerUids', 'array-contains', user.uid)) : null,
  );

  const finishedInPeriod = useMemo(() => {
    if (!user) return [];
    const periodStart = getPeriodStart(period);
    const byId = new Map<string, any>();
    (outcomesValue?.docs || []).forEach((d) => {
      if ((d.data() as any).gameType === gameType) byId.set(d.id, d.data());
    });
    (gamesValue?.docs || []).forEach((d) => byId.set(d.id, d.data())); // live doc wins if both exist
    return Array.from(byId.values()).filter(
      (g: any) =>
        g.status === 'finished' &&
        hasDecidedOutcome(g, meta.resultMode) &&
        (!periodStart || (g.finishedAt && new Date(g.finishedAt) >= periodStart)),
    );
  }, [gamesValue, outcomesValue, user, period, meta.resultMode, gameType]);

  const myRecord = useMemo(() => {
    if (!user) return { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
    const mine = finishedInPeriod.filter((g) => (g.players || []).some((p: any) => p.uid === user.uid));
    let wins = 0, losses = 0, draws = 0;
    for (const g of mine) {
      const outcome = getOutcome(g, user.uid, meta.resultMode);
      if (outcome === 'win') wins += 1;
      else if (outcome === 'draw') draws += 1;
      else losses += 1;
    }
    return { wins, losses, draws, gamesPlayed: mine.length };
  }, [finishedInPeriod, user, meta.resultMode]);

  // Opponents (different side, or the only kind of "other player" in individual/color games) go
  // into `headToHead` with THEIR record against you. Partners (same side — only possible in
  // team-based games like 4-player Sweep, or Sequence at playerCount >3) go into a separate
  // `partners` list instead, since they share your exact outcome every game rather than being
  // someone you beat or lost to. Checked per-game (not from a single top-level flag), since
  // Sequence's team-ness varies by that game's own playerCount.
  const { headToHead, partners } = useMemo(() => {
    if (!user) return { headToHead: [] as OpponentStats[], partners: [] as OpponentStats[] };
    const oppByUid = new Map<string, OpponentStats>();
    const partnerByUid = new Map<string, OpponentStats>();
    for (const g of finishedInPeriod) {
      const players: any[] = g.players || [];
      const me = players.find((p) => p.uid === user.uid);
      if (!me) continue;
      for (const p of players) {
        if (p.uid === user.uid) continue;
        const sameTeam = isSameSide(g, user.uid, p.uid, meta.resultMode);
        const map = sameTeam ? partnerByUid : oppByUid;
        const entry = map.get(p.uid) || {
          uid: p.uid,
          displayName: p.displayName || t('gameRanks.player'),
          photoURL: p.photoURL || '',
          wins: 0,
          losses: 0,
          draws: 0,
          gamesPlayed: 0,
        };
        entry.gamesPlayed += 1;
        // For opponents this counts THEIR record against you; for partners it counts YOUR
        // (shared) record together — they're never independent since you're on the same team.
        const outcome = sameTeam ? getOutcome(g, user.uid, meta.resultMode) : getOutcome(g, p.uid, meta.resultMode);
        if (outcome === 'win') entry.wins += 1;
        else if (outcome === 'draw') entry.draws += 1;
        else entry.losses += 1;
        entry.displayName = p.displayName || entry.displayName;
        entry.photoURL = p.photoURL || entry.photoURL;
        map.set(p.uid, entry);
      }
    }
    const sortFn = (a: OpponentStats, b: OpponentStats) => b.wins - a.wins || b.gamesPlayed - a.gamesPlayed;
    return { headToHead: Array.from(oppByUid.values()).sort(sortFn), partners: Array.from(partnerByUid.values()).sort(sortFn) };
  }, [finishedInPeriod, user, meta.resultMode, t]);

  // The opponents list above ranks everyone else by THEIR record against you — but never placed
  // you in that same ranking yourself, so there was no way to see where your own record actually
  // stands next to theirs. Inserts your own overall record (`myRecord`, from the summary card
  // above) into the SAME sorted list at its real position, rather than only ever showing you as
  // the implicit "other side" of every opponent row.
  const { headToHeadRanked, myHeadToHeadRank } = useMemo(() => {
    if (!user || headToHead.length === 0) return { headToHeadRanked: headToHead, myHeadToHeadRank: 0 };
    const me: OpponentStats = {
      uid: user.uid,
      displayName: user.displayName || t('gameRanks.you'),
      photoURL: user.photoURL || '',
      wins: myRecord.wins,
      losses: myRecord.losses,
      draws: myRecord.draws,
      gamesPlayed: myRecord.gamesPlayed,
    };
    const combined = [...headToHead, me].sort((a, b) => b.wins - a.wins || b.gamesPlayed - a.gamesPlayed);
    return { headToHeadRanked: combined, myHeadToHeadRank: combined.findIndex((e) => e.uid === user.uid) + 1 };
  }, [headToHead, myRecord, user, t]);

  // Current winning streak (most recent games first, within the chosen period) and the closest rival — the
  // opponent whose head-to-head with you is nearest to level — for the "Next up" bar.
  const winStreak = useMemo(() => {
    if (!user) return 0;
    const mine = finishedInPeriod
      .filter((g) => (g.players || []).some((p: any) => p.uid === user.uid))
      .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
    let n = 0;
    for (const g of mine) {
      if (getOutcome(g, user.uid, meta.resultMode) === 'win') n += 1;
      else break;
    }
    return n;
  }, [finishedInPeriod, user, meta.resultMode]);

  const rival = useMemo(() => {
    const pool = headToHead.filter((s) => s.gamesPlayed >= 2);
    if (pool.length === 0) return null;
    // From YOUR side: your wins against them are their losses.
    return [...pool].sort((a, b) => Math.abs(a.losses - a.wins) - Math.abs(b.losses - b.wins) || b.gamesPlayed - a.gamesPlayed)[0];
  }, [headToHead]);

  const winPct = myRecord.gamesPlayed > 0 ? Math.round((myRecord.wins / myRecord.gamesPlayed) * 100) : 0;
  const winDeg = myRecord.gamesPlayed > 0 ? (myRecord.wins / myRecord.gamesPlayed) * 360 : 0;
  const lossDeg = myRecord.gamesPlayed > 0 ? (myRecord.losses / myRecord.gamesPlayed) * 360 : 0;
  const gameName = t(meta.gameLabelKey);

  const avatar = (s: { photoURL?: string; displayName?: string }, tone = 'from-[#6f86b3] to-[#3a4a75]') => (
    <div className={clsx('w-[30px] h-[30px] rounded-full bg-gradient-to-br flex items-center justify-center text-[11px] font-black overflow-hidden shrink-0', tone)}>
      {s.photoURL ? <img src={s.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (s.displayName || '?').slice(0, 1).toUpperCase()}
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#2a2250_0%,#0e1230_55%,#070a18_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate(meta.backTo)} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">{t('gameRanks.titleTemplate', { game: gameName })}</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">{t('gameRanks.subtitle').toUpperCase()}</span>
          </div>
        </header>

        <div className="relative shrink-0 px-3 pt-3">
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={clsx('flex-1 whitespace-nowrap px-3 py-1.5 rounded-full text-[11px] font-extrabold border shrink-0', period === p.id ? 'bg-gradient-to-r from-amber-300 to-amber-200 text-[#1a1300] border-transparent' : 'bg-[#121a2e] text-white/55 border-[#1f2a47]')}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <main className={clsx('relative flex-1 min-h-0 overflow-y-auto px-3 pt-3 space-y-3 max-w-md mx-auto w-full', rival ? 'pb-36' : 'pb-8')}>
          {/* my record */}
          <div className="rounded-[1.1rem] bg-[#121a2e] border border-[#1f2a47] p-3 flex items-center gap-3.5">
            <div className="w-[84px] h-[84px] rounded-full shrink-0 flex items-center justify-center" style={{ background: myRecord.gamesPlayed > 0 ? `conic-gradient(#3ddc84 0deg ${winDeg}deg, #ff6b78 ${winDeg}deg ${winDeg + lossDeg}deg, #8a96b4 ${winDeg + lossDeg}deg 360deg)` : '#1f2a47' }}>
              <div className="w-[60px] h-[60px] rounded-full bg-[#0e1230] flex flex-col items-center justify-center">
                <p className="text-[17px] font-black leading-none">{winPct}%</p>
                <p className="text-[8px] font-extrabold tracking-[0.1em] text-white/50 mt-0.5">{t('gameRanks.wins').toUpperCase()}</p>
              </div>
            </div>
            <div className="flex-1 grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded-xl bg-[#0e1230] py-2"><p className="text-[17px] font-black text-emerald-400">{myRecord.wins}</p><p className="text-[8px] font-extrabold tracking-[0.08em] text-white/50">{t('gameRanks.wins').toUpperCase()}</p></div>
              <div className="rounded-xl bg-[#0e1230] py-2"><p className="text-[17px] font-black text-red-400">{myRecord.losses}</p><p className="text-[8px] font-extrabold tracking-[0.08em] text-white/50">{t('gameRanks.losses').toUpperCase()}</p></div>
              {meta.resultMode === 'color' ? (
                <div className="rounded-xl bg-[#0e1230] py-2"><p className="text-[17px] font-black">{myRecord.draws}</p><p className="text-[8px] font-extrabold tracking-[0.08em] text-white/50">{t('gameRanks.draws').toUpperCase()}</p></div>
              ) : (
                <div className="rounded-xl bg-[#0e1230] py-2"><p className="text-[17px] font-black">{myRecord.gamesPlayed}</p><p className="text-[8px] font-extrabold tracking-[0.08em] text-white/50">{t('gameRanks.games').toUpperCase()}</p></div>
              )}
            </div>
          </div>
          <p className="text-center text-[11px] font-bold text-white/55">
            {winStreak >= 2 && <>🔥 {winStreak}-game winning streak · </>}{myRecord.gamesPlayed} {t('gameRanks.games').toLowerCase()}
          </p>

          {teamCapable && (
            <section className="space-y-1.5">
              <h2 className="text-[10px] font-black tracking-[0.14em] text-amber-300 px-1">{t('gameRanks.partners').toUpperCase()}</h2>
              {loading && <p className="p-4 text-sm text-white/60 text-center">{t('common.loading')}</p>}
              {!loading && partners.length === 0 && <p className="p-4 text-sm text-white/50 italic text-center">{t('gameRanks.noTeammateGames')}</p>}
              {partners.map((s) => (
                <div key={s.uid} className="flex items-center gap-2.5 rounded-2xl bg-[#121a2e] border border-[#1f2a47] px-3 py-2">
                  <span className="w-6 text-center text-base">🤝</span>
                  {avatar(s)}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-extrabold truncate">{s.displayName}</p>
                    <p className="text-[9px] font-bold text-white/50">{t('gameRanks.gamesAsTeammates', { count: s.gamesPlayed })}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[13px] font-black tabular-nums">
                      <span className="text-emerald-400">{s.wins}W</span> – <span className="text-red-400">{s.losses}L</span>
                      {s.draws > 0 && <> – <span className="text-white/55">{s.draws}D</span></>}
                    </p>
                    <p className="text-[9px] font-bold text-white/50">{t('gameRanks.percentTogether', { percent: s.gamesPlayed > 0 ? Math.round((s.wins / s.gamesPlayed) * 100) : 0 })}</p>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="space-y-1.5">
            <h2 className="text-[10px] font-black tracking-[0.14em] text-amber-300 px-1">{(teamCapable ? t('gameRanks.opponents') : t('gameRanks.headToHead')).toUpperCase()}</h2>
            {loading && <p className="p-4 text-sm text-white/60 text-center">{t('common.loading')}</p>}
            {!loading && headToHead.length === 0 && <p className="p-4 text-sm text-white/50 italic text-center">{t('gameRanks.noFinishedGames')}</p>}
            {headToHeadRanked.map((s, idx) => {
              const isMe = !!user && s.uid === user.uid;
              // From YOUR side: your wins against them are their losses, and vice versa.
              const mine = s.losses;
              const theirs = s.wins;
              const lead = mine - theirs;
              const share = s.gamesPlayed > 0 ? Math.round(((isMe ? s.wins : mine) / s.gamesPlayed) * 100) : 0;
              return (
                <div key={s.uid} className={clsx('flex items-center gap-2.5 rounded-2xl px-3 py-2 border', isMe ? 'border-amber-300 bg-[#1d1a14] shadow-[0_0_14px_rgba(245,196,81,0.2)]' : 'border-[#1f2a47] bg-[#121a2e]')}>
                  <span className={clsx('w-6 text-center text-sm font-black', isMe ? 'text-amber-300' : 'text-white/50')}>{idx + 1}</span>
                  {avatar(s)}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-extrabold truncate">{isMe ? t('gameRanks.you') : s.displayName}</p>
                    <p className="text-[9px] font-bold text-white/50 flex items-center gap-1.5 flex-wrap">
                      {isMe ? t('gameRanks.gamesTogether', { count: s.gamesPlayed }) : lead > 0 ? `You lead ${mine}–${theirs}` : lead < 0 ? `You trail ${mine}–${theirs}` : `Level at ${mine}–${theirs}`}
                      {!isMe && lead > 0 && <span className="px-1.5 py-px rounded-md bg-emerald-400/15 text-emerald-400 text-[8px] font-black">WINNING</span>}
                      {!isMe && lead < 0 && <span className="px-1.5 py-px rounded-md bg-red-400/15 text-red-400 text-[8px] font-black">REVENGE?</span>}
                    </p>
                    <div className="h-1 rounded-full bg-[#1f2a47] overflow-hidden mt-1">
                      <div className={clsx('h-full rounded-full', !isMe && lead < 0 ? 'bg-gradient-to-r from-red-400 to-red-300' : 'bg-gradient-to-r from-emerald-400 to-emerald-200')} style={{ width: `${share}%` }} />
                    </div>
                  </div>
                  <p className={clsx('text-[13px] font-black tabular-nums shrink-0', isMe && 'text-amber-300')}>{isMe ? `${s.wins}–${s.losses}` : `${mine}–${theirs}`}</p>
                </div>
              );
            })}
          </section>
        </main>

        {rival && (() => {
          const lead = rival.losses - rival.wins;
          const n = Math.abs(lead);
          return (
            <div className="absolute left-2.5 right-2.5 bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-w-md mx-auto rounded-[1.1rem] border-[1.5px] border-emerald-400 bg-[#0f2a22] p-3 shadow-[0_8px_24px_rgba(0,0,0,0.65)]">
              <p className="text-[10px] font-extrabold tracking-[0.1em] text-emerald-400">NEXT UP</p>
              <p className="text-xs font-bold mt-0.5">
                {lead > 0 ? <>{rival.displayName} is {n} win{n === 1 ? '' : 's'} behind you — <span className="text-emerald-300">challenge them</span></>
                  : lead < 0 ? <>{rival.displayName} leads you by {n} — <span className="text-emerald-300">time for revenge</span></>
                  : <>You and {rival.displayName} are level — <span className="text-emerald-300">settle it</span></>}
              </p>
              <button onClick={() => navigate(meta.backTo)} className="mt-2 w-full py-2.5 rounded-xl text-xs font-black text-emerald-950 bg-gradient-to-r from-emerald-500 to-emerald-300 shadow-[0_4px_0_#0a7a57] active:translate-y-0.5">
                ▶ New {gameName} game
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
