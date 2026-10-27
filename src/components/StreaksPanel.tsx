import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import StreakCard, { type StreakSummary } from './StreakCard';
import FriendStreakCard, { type FriendSummary } from './FriendStreakCard';
import StreakFlame from './StreakFlame';

// The streak area on the home page. Closed by default: one slim line with the numbers that matter (the day streak, whether today is done, how many
// friend streaks are running and whether an invite is waiting). Tap it to open the full flame card and the friend streaks, and "Show less" to fold them away.
// Both cards stay mounted while closed, so the summary is always current, a milestone celebration still plays, and nothing has to reload on opening.

export default function StreaksPanel() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<StreakSummary | null>(null);
  const [friends, setFriends] = useState<FriendSummary | null>(null);
  if (!user) return null;

  const state = mine?.state ?? 'none';
  const hot = state === 'lit' || state === 'risk';
  const status =
    state === 'lit' ? { text: '✓ Done today', cls: 'bg-white/15 text-white' }
    : state === 'risk' ? { text: 'Log today', cls: 'bg-[#FF7A1A] text-white animate-pulse' }
    : state === 'frozen' ? { text: `❄ Frozen · ${mine?.daysToSave}d left`, cls: 'bg-white/20 text-white' }
    : mine?.lost ? { text: 'Restore it', cls: 'bg-white/20 text-white' }
    : { text: 'Start today', cls: 'bg-[#FF7A1A] text-white' };
  const needsAttention = state === 'risk' || state === 'frozen' || !!mine?.lost || (friends?.waiting ?? 0) > 0;

  return (
    <div className="space-y-2">
      {!open && mine && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label="Open streaks"
          className={`w-full flex items-center gap-2 rounded-2xl px-3 py-2 text-left text-white shadow-sm active:scale-[0.99] transition-transform ${state === 'risk' ? 'ring-2 ring-orange-400' : ''}`}
          style={{ background: hot ? 'linear-gradient(135deg,#3a1208 0%,#7c2d12 55%,#9a3412 100%)' : state === 'frozen' ? 'linear-gradient(135deg,#0c4a6e 0%,#0284c7 100%)' : 'linear-gradient(135deg,#0d3b4e 0%,#1E3A8A 100%)' }}
        >
          <span className="shrink-0 overflow-visible" style={{ width: 24, height: 30 }}><StreakFlame state={state} size={24} flame={mine.flame} /></span>
          <span className="text-2xl font-black leading-none tabular-nums">{state === 'out' ? 0 : mine.shown}</span>
          <span className="text-[11px] font-black text-amber-300 uppercase tracking-wide leading-none">day streak</span>
          {mine.freezes > 0 && <span className="text-[10px] font-bold bg-sky-400/20 text-sky-200 rounded-full px-1.5 py-0.5 leading-none">❄ {mine.freezes}</span>}
          <span className={`text-[11px] font-black rounded-full px-2 py-1 leading-none whitespace-nowrap ${status.cls}`}>{status.text}</span>
          <span className="flex-1 min-w-0" />
          {friends && (
            <span className="flex items-center gap-1 text-[11px] font-bold text-white/90 leading-none whitespace-nowrap">
              <span aria-hidden>👥</span>
              {friends.waiting > 0
                ? <span className="rounded-full bg-orange-400 text-orange-950 font-black px-1.5 py-0.5">{friends.waiting} invite{friends.waiting === 1 ? '' : 's'}</span>
                : friends.running > 0
                  ? <span>{friends.running}<span className="hidden sm:inline"> friend streak{friends.running === 1 ? '' : 's'}{friends.best > 0 ? ` · best ${friends.best}` : ''}</span></span>
                  : <span>Invite<span className="hidden sm:inline"> a friend</span></span>}
            </span>
          )}
          <span className={`material-symbols-outlined text-[20px] shrink-0 ${needsAttention ? 'text-amber-300' : 'text-white/70'}`}>expand_more</span>
        </button>
      )}
      <div className={open ? 'space-y-2' : 'hidden'}>
        <StreakCard onSummary={setMine} />
        <FriendStreakCard onSummary={setFriends} />
        <button type="button" onClick={() => setOpen(false)} aria-expanded aria-label="Show less" className="mx-auto flex items-center gap-0.5 text-[11px] font-bold text-text-muted active:scale-95">
          Show less<span className="material-symbols-outlined text-[16px]">expand_less</span>
        </button>
      </div>
    </div>
  );
}
