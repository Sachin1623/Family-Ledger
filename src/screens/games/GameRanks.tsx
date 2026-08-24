import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { sideForSeat as sequenceSideForSeat } from '../../lib/sequence';
import { useLanguage } from '../../context/LanguageContext';

type GameType = 'ludo' | 'rummy' | 'business' | 'sweep' | 'chess' | 'sequence';
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
  business: { gameLabelKey: 'games.business', collection: 'businessGames', backTo: '/games/business', resultMode: 'individual' },
  sweep: { gameLabelKey: 'games.sweep', collection: 'sweepGames', backTo: '/games/sweep', resultMode: 'team' },
  chess: { gameLabelKey: 'games.chess', collection: 'chessGames', backTo: '/games/chess', resultMode: 'color' },
  sequence: { gameLabelKey: 'games.sequence', collection: 'sequenceGames', backTo: '/games/sequence', resultMode: 'side' },
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
  const gameType: GameType = (['rummy', 'business', 'sweep', 'chess', 'sequence'].includes(rawGameType || '') ? rawGameType : 'ludo') as GameType;
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

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <button onClick={() => navigate(meta.backTo)} className="text-xs font-bold text-primary flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          {t(meta.gameLabelKey)}
        </button>

        <div>
          <h1 className="text-2xl font-black text-primary">{t('gameRanks.titleTemplate', { game: t(meta.gameLabelKey) })}</h1>
          <p className="text-sm text-text-muted mt-1">{t('gameRanks.subtitle')}</p>
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={clsx(
                'px-3.5 py-2 rounded-xl text-xs font-bold border shrink-0',
                period === p.id ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
              )}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle p-5 flex items-center justify-around text-center">
          <div>
            <p className="text-2xl font-black text-success">{myRecord.wins}</p>
            <p className="text-[10px] font-bold text-text-muted uppercase">{t('gameRanks.wins')}</p>
          </div>
          <div>
            <p className="text-2xl font-black text-error">{myRecord.losses}</p>
            <p className="text-[10px] font-bold text-text-muted uppercase">{t('gameRanks.losses')}</p>
          </div>
          {meta.resultMode === 'color' && (
            <div>
              <p className="text-2xl font-black text-text-muted">{myRecord.draws}</p>
              <p className="text-[10px] font-bold text-text-muted uppercase">{t('gameRanks.draws')}</p>
            </div>
          )}
          <div>
            <p className="text-2xl font-black text-primary">{myRecord.gamesPlayed}</p>
            <p className="text-[10px] font-bold text-text-muted uppercase">{t('gameRanks.games')}</p>
          </div>
        </div>

        {teamCapable && (
          <section className="space-y-2">
            <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">{t('gameRanks.partners')}</h2>
            <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
              {loading && <p className="p-6 text-sm text-text-muted text-center">{t('common.loading')}</p>}
              {!loading && partners.length === 0 && (
                <p className="p-6 text-sm text-text-muted italic text-center">{t('gameRanks.noTeammateGames')}</p>
              )}
              {partners.map((s, idx) => (
                <div key={s.uid} className="p-4 flex items-center gap-3">
                  <span className="w-6 text-center text-sm font-black text-text-muted">{idx + 1}</span>
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
                    {s.photoURL ? (
                      <img src={s.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      s.displayName?.slice(0, 1) || '?'
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-on-surface truncate">{s.displayName}</p>
                    <p className="text-[10px] text-text-muted">
                      {t('gameRanks.gamesAsTeammates', { count: s.gamesPlayed })}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-black">
                      <span className="text-success">{s.wins}W</span> - <span className="text-error">{s.losses}L</span>
                      {s.draws > 0 && <> - <span className="text-text-muted">{s.draws}D</span></>}
                    </p>
                    <p className="text-[10px] text-text-muted">
                      {t('gameRanks.percentTogether', { percent: s.gamesPlayed > 0 ? Math.round((s.wins / s.gamesPlayed) * 100) : 0 })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Your own rank at a glance, right above the full ranked list below — same row styling
            as every row in that list, so it reads as "here's where you'd be if you scrolled to
            find yourself," not a separate/different kind of summary. */}
        {myHeadToHeadRank > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">{t('gameRanks.yourRank')}</h2>
            <div className="bg-primary/5 rounded-2xl border-2 border-primary/20 p-4 flex items-center gap-3">
              <span className="w-6 text-center text-sm font-black text-primary">{myHeadToHeadRank}</span>
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
                {user?.photoURL ? (
                  <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  (user?.displayName || 'Y').slice(0, 1)
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface truncate">{t('gameRanks.you')}</p>
                <p className="text-[10px] text-text-muted">{t('gameRanks.gamesTogether', { count: myRecord.gamesPlayed })}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-black">
                  <span className="text-success">{myRecord.wins}W</span> - <span className="text-error">{myRecord.losses}L</span>
                </p>
              </div>
            </div>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-xs font-bold text-primary uppercase tracking-widest px-1">
            {teamCapable ? t('gameRanks.opponents') : t('gameRanks.headToHead')}
          </h2>
          <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {loading && <p className="p-6 text-sm text-text-muted text-center">{t('common.loading')}</p>}
            {!loading && headToHead.length === 0 && (
              <p className="p-6 text-sm text-text-muted italic text-center">{t('gameRanks.noFinishedGames')}</p>
            )}
            {headToHeadRanked.map((s, idx) => {
              const isMe = user && s.uid === user.uid;
              return (
                <div key={s.uid} className={clsx('p-4 flex items-center gap-3', isMe && 'bg-primary/5')}>
                  <span className="w-6 text-center text-sm font-black text-text-muted">{idx + 1}</span>
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs overflow-hidden shrink-0">
                    {s.photoURL ? (
                      <img src={s.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      s.displayName?.slice(0, 1) || '?'
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-on-surface truncate">{isMe ? t('gameRanks.you') : s.displayName}</p>
                    <p className="text-[10px] text-text-muted">
                      {t('gameRanks.gamesTogether', { count: s.gamesPlayed })}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-black">
                      <span className="text-success">{s.wins}W</span> - <span className="text-error">{s.losses}L</span>
                    </p>
                    {!isMe && (
                      <p className="text-[10px] text-text-muted">
                        {t('gameRanks.percentForThem', { percent: s.gamesPlayed > 0 ? Math.round((s.wins / s.gamesPlayed) * 100) : 0 })}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
