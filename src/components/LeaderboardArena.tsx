import React from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';

export interface ArenaEntry {
  id: string;
  userId: string;
  userName?: string;
  userPhoto?: string;
  value: number;
  sub: string;
}

const PODIUM = [
  { place: 2, ring: '#CFD8EE', size: 'w-14 h-14 text-xl', base: 'h-[72px]', baseBg: 'linear-gradient(180deg, rgba(207,216,238,0.33), rgba(207,216,238,0.06))' },
  { place: 1, ring: '#F5C451', size: 'w-[72px] h-[72px] text-2xl', base: 'h-[108px]', baseBg: 'linear-gradient(180deg, rgba(245,196,81,0.4), rgba(245,196,81,0.06))' },
  { place: 3, ring: '#D08A4A', size: 'w-14 h-14 text-xl', base: 'h-[54px]', baseBg: 'linear-gradient(180deg, rgba(208,138,74,0.33), rgba(208,138,74,0.06))' },
];

function Avatar({ entry, className, style }: { entry: ArenaEntry; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={clsx('relative shrink-0 rounded-full bg-gradient-to-br from-[#6f86b3] to-[#3a4a75] flex items-center justify-center font-black overflow-hidden', className)} style={style}>
      {entry.userPhoto ? <img src={entry.userPhoto} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (entry.userName || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

// The shared dark "arena" for score leaderboards (Sudoku, Scramble): filter chips, a podium for the top three, the
// rest as rows, and a pinned bar with your own rank, how far you are behind the next player, and a way to climb.
export default function LeaderboardArena({
  title,
  subtitle,
  backTo,
  filters,
  entries,
  loading,
  myUid,
  valueLabel = 'pts',
  playLabel,
  onPlay,
  emptyText = 'No scores yet — be the first!',
}: {
  title: string;
  subtitle: string;
  backTo: string;
  filters: React.ReactNode;
  /** Full ranked list, best first. */
  entries: ArenaEntry[];
  loading: boolean;
  myUid?: string;
  valueLabel?: string;
  playLabel: string;
  onPlay: () => void;
  emptyText?: string;
}) {
  const navigate = useNavigate();
  const visible = entries.slice(0, 50);
  const top3 = visible.slice(0, 3);
  const rest = visible.slice(3);
  const myRank = entries.findIndex((e) => e.userId === myUid) + 1;
  const me = myRank > 0 ? entries[myRank - 1] : null;
  const ahead = myRank > 1 ? entries[myRank - 2] : null;
  const behind = ahead && me ? ahead.value - me.value : 0;
  const lead = myRank === 1 && entries.length > 1 && me ? me.value - entries[1].value : 0;
  const fmt = (n: number) => n.toLocaleString();
  const firstName = (e: ArenaEntry) => (e.userName || 'Someone').split(' ')[0];
  // Podium order is 2nd · 1st · 3rd, so the winner stands tallest in the middle.
  const podiumSlots = PODIUM.map((slot) => ({ slot, entry: top3[slot.place - 1] })).filter((x) => x.entry);

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#2a2250_0%,#0e1230_55%,#070a18_100%)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />

        <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
          <button onClick={() => navigate(backTo)} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center" aria-label="Back">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="leading-tight">
            <h1 className="text-[15px] font-black">{title}</h1>
            <span className="text-[8px] font-bold tracking-[0.14em] text-white/60">{subtitle.toUpperCase()}</span>
          </div>
          <div className="flex-1" />
          <span className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm">🏅</span>
        </header>

        <div className="relative shrink-0 px-3 pt-3 space-y-2">{filters}</div>

        <main className={clsx('relative flex-1 min-h-0 overflow-y-auto px-3 pt-3 space-y-2 max-w-md mx-auto w-full', me ? 'pb-44' : 'pb-8')}>
          {loading && <p className="p-6 text-sm text-white/60 text-center">Loading…</p>}
          {!loading && entries.length === 0 && <p className="p-6 text-sm text-white/60 italic text-center">{emptyText}</p>}

          {!loading && podiumSlots.length > 0 && (
            <div className="flex items-end justify-center gap-2 pt-7 pb-1">
              {podiumSlots.map(({ slot, entry }) => (
                <div key={entry.id} className="flex flex-col items-center w-[94px]">
                  <div className="relative">
                    {slot.place === 1 && <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-2xl drop-shadow-[0_0_8px_#f5c451]">👑</span>}
                    <Avatar entry={entry} className={slot.size} style={{ border: `${slot.place === 1 ? 4 : 3}px solid ${slot.ring}`, boxShadow: slot.place === 1 ? '0 0 24px rgba(245,196,81,0.55)' : undefined }} />
                  </div>
                  <p className={clsx('mt-1.5 text-[11px] font-extrabold max-w-full truncate', entry.userId === myUid && 'text-amber-300')}>{entry.userId === myUid ? 'You' : entry.userName}</p>
                  <p className="text-xs font-black text-amber-300 tabular-nums">{fmt(entry.value)}</p>
                  <div className={clsx('w-full mt-1.5 rounded-t-xl flex items-start justify-center pt-1.5 text-lg font-black', slot.base)} style={{ background: slot.baseBg, color: slot.place === 1 ? '#F5C451' : undefined }}>
                    {slot.place}
                  </div>
                </div>
              ))}
            </div>
          )}

          {rest.map((entry, i) => {
            const isMe = entry.userId === myUid;
            return (
              <div key={entry.id} className={clsx('flex items-center gap-2.5 rounded-2xl px-3 py-2 border', isMe ? 'border-amber-300 bg-[#1d1a14] shadow-[0_0_14px_rgba(245,196,81,0.2)]' : 'border-[#1f2a47] bg-[#121a2e]')}>
                <span className={clsx('w-6 text-center text-sm font-black', isMe ? 'text-amber-300' : 'text-white/50')}>{i + 4}</span>
                <Avatar entry={entry} className="w-[30px] h-[30px] text-[11px]" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-extrabold truncate">{isMe ? 'You' : entry.userName}</p>
                  <p className="text-[9px] font-bold text-white/50">{entry.sub}</p>
                </div>
                <p className={clsx('text-[13px] font-black tabular-nums shrink-0', isMe && 'text-amber-300')}>{fmt(entry.value)}</p>
              </div>
            );
          })}
        </main>

        {/* Pinned: where I stand, who's next, and a way to climb. Shown only once I have a score on this board. */}
        {!loading && me && (
          <div className="absolute left-2.5 right-2.5 bottom-[max(0.75rem,env(safe-area-inset-bottom))] rounded-[1.1rem] border-[1.5px] border-amber-300 bg-gradient-to-br from-[#2a1d05] to-[#1a1300] p-3 shadow-[0_8px_24px_rgba(0,0,0,0.65)] max-w-md mx-auto">
            <p className="text-[10px] font-extrabold tracking-[0.1em] text-amber-300">YOUR RANK · #{myRank} OF {entries.length}</p>
            <p className="text-xs font-bold mt-0.5">
              {fmt(me.value)} {valueLabel}
              {ahead ? <> · <span className="text-red-300">{fmt(behind)} behind {firstName(ahead)}</span></> : lead > 0 ? <> · <span className="text-emerald-300">{fmt(lead)} clear at the top</span></> : null}
            </p>
            <button onClick={onPlay} className="mt-2 w-full py-2.5 rounded-xl text-xs font-black text-[#1a1300] bg-gradient-to-r from-amber-300 to-amber-200 shadow-[0_4px_0_#b88a1d] active:translate-y-0.5">
              ▶ {myRank === 1 ? 'Defend your spot' : playLabel}
            </button>
          </div>
        )}
        {!loading && !me && entries.length > 0 && (
          <div className="absolute left-2.5 right-2.5 bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-w-md mx-auto">
            <button onClick={onPlay} className="w-full py-3 rounded-2xl text-sm font-black text-[#1a1300] bg-gradient-to-r from-amber-300 to-amber-200 shadow-[0_4px_0_#b88a1d]">▶ {playLabel} to get on the board</button>
          </div>
        )}
      </div>
    </div>
  );
}
