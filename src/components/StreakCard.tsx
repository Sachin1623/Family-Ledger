import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { claimPoints } from '../lib/pointsApi';
import Fireworks from './Fireworks';

// The streak flame on the dashboard: how many days in a row this person has looked after their family's spending, and what to do next.
//   lit    : logged today          -> a steady flame
//   risk   : logged yesterday only -> a pulsing flame, "Log now" and "No spend today"
//   out    : the streak has lapsed  -> a dim flame and a kind nudge to start again
// A flare plays when the number goes up while the card is on screen, and a celebration for the big milestones (7, 14, 30, 60, 100, 365).
// Days follow the person's own time zone, the same way the server counts them.

const MILESTONES = [3, 7, 14, 30, 60, 100, 365];
const SEEN_KEY = 'fl_streak_milestone_seen';

function localDay(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function FlameSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 120" className={className} aria-hidden="true">
      <path className="sc-out" d="M50 4c4 20 26 32 26 62 0 26-14 48-26 48S24 92 24 66C24 44 38 40 40 22c6 6 8 12 10-18z" />
      <path className="sc-mid" d="M50 40c3 14 16 22 16 42 0 16-8 28-16 28S34 98 34 82c0-14 10-18 16-42z" />
      <path className="sc-in" d="M50 70c2 8 8 12 8 22 0 8-4 14-8 14s-8-6-8-14c0-10 6-14 8-22z" />
    </svg>
  );
}

export default function StreakCard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [snap] = useDocument(user ? doc(db, 'userPoints', user.uid, 'meta', 'expenseStreak') : null);
  const data = snap?.data() as { current?: number; longest?: number; lastDateStr?: string; freezes?: number } | undefined;
  const [flare, setFlare] = useState(0);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const previous = useRef<number | null>(null);

  const today = localDay();
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  const current = data?.current ?? 0;
  const last = data?.lastDateStr;
  const state: 'lit' | 'risk' | 'out' | 'none' = !data || !current ? 'none' : last === today ? 'lit' : last === yesterday ? 'risk' : 'out';
  const shown = state === 'out' ? 0 : current;

  // Flare when the number goes up while this card is on screen; celebrate a new milestone once.
  useEffect(() => {
    if (!snap) return;
    if (previous.current !== null && current > previous.current && state === 'lit') {
      setFlare((n) => n + 1);
      if (MILESTONES.includes(current)) {
        let seen: number[] = [];
        try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { /* ignore */ }
        if (!seen.includes(current)) {
          setMilestone(current);
          try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, current])); } catch { /* ignore */ }
        }
      }
    }
    previous.current = current;
  }, [snap, current, state]);

  const message = useMemo(() => {
    if (state === 'lit') return shown >= 7 ? `${shown} days in a row. You are building real family-finance habits.` : 'Flame lit for today. See you tomorrow!';
    if (state === 'risk') return `Log one expense today to keep your ${shown}-day streak.`;
    if (state === 'out') return data?.longest ? `Your best was ${data.longest} days. Start a new streak today.` : 'Log an expense today to light your flame.';
    return 'Log an expense to light your flame and start a streak.';
  }, [state, shown, data?.longest]);

  const noSpend = async () => {
    if (busy) return;
    setBusy(true);
    await claimPoints('no_spend_today', {});
    setBusy(false);
  };

  if (!user) return null;
  const freezes = data?.freezes ?? 0;
  const risky = state === 'risk';

  return (
    <>
      <style>{`
        .sc-out{fill:#FF7A1A}.sc-mid{fill:#FFB020}.sc-in{fill:#FFF3C4}
        .sc-lit svg{animation:scSway 2.8s ease-in-out infinite;transform-origin:50% 90%}
        .sc-risk svg{animation:scPulse 1s ease-in-out infinite;transform-origin:50% 90%}
        .sc-risk .sc-out{fill:#FF5A36}
        .sc-out-state .sc-out,.sc-out-state .sc-mid,.sc-out-state .sc-in,.sc-none .sc-out,.sc-none .sc-mid,.sc-none .sc-in{fill:#8498A8}
        .sc-flare svg{animation:scIgnite .9s cubic-bezier(.2,1.4,.4,1) both}
        @keyframes scSway{0%,100%{transform:rotate(-2deg) scale(1)}50%{transform:rotate(2deg) scale(1.04)}}
        @keyframes scPulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(255,90,54,0))}50%{transform:scale(1.08);filter:drop-shadow(0 0 10px rgba(255,90,54,.8))}}
        @keyframes scIgnite{0%{transform:scale(.3) translateY(10px);opacity:.2}60%{transform:scale(1.3)}100%{transform:scale(1);opacity:1}}
        @keyframes scRoll{0%{transform:translateY(12px) scale(.8);opacity:.2}100%{transform:none;opacity:1}}
        .sc-roll{animation:scRoll .5s cubic-bezier(.2,1.6,.4,1)}
        @media (prefers-reduced-motion: reduce){.sc-lit svg,.sc-risk svg,.sc-flare svg,.sc-roll{animation:none!important}}
      `}</style>
      <div className={`rounded-2xl p-4 text-white shadow-sm ${risky ? 'ring-2 ring-orange-400' : ''}`} style={{ background: 'linear-gradient(135deg,#0d3b4e 0%,#1E3A8A 100%)' }}>
        <div className="flex items-center gap-4">
          <div
            key={flare}
            className={`w-14 h-16 shrink-0 ${flare ? 'sc-flare' : ''} ${state === 'lit' ? 'sc-lit' : state === 'risk' ? 'sc-risk' : state === 'out' ? 'sc-out-state' : 'sc-none'}`}
          >
            <FlameSvg className="w-full h-full overflow-visible" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span key={shown} className="sc-roll text-4xl font-black leading-none tabular-nums">{shown}</span>
              <span className="text-sm font-black text-amber-300 uppercase tracking-wide">{shown === 1 ? 'day streak' : 'day streak'}</span>
              {freezes > 0 && <span className="text-xs font-bold bg-sky-400/20 text-sky-200 rounded-full px-2 py-0.5">❄ {freezes}</span>}
            </div>
            <p className="text-[12px] text-white/80 leading-snug mt-1">{message}</p>
          </div>
        </div>
        {(risky || state === 'out' || state === 'none') && (
          <div className="flex gap-2 mt-3">
            <button type="button" onClick={() => navigate('/add-expense')} className="flex-1 py-2.5 rounded-xl bg-[#FF7A1A] text-white text-sm font-black active:scale-95">
              {risky ? 'Log now' : 'Log an expense'}
            </button>
            <button type="button" onClick={noSpend} disabled={busy} className="flex-1 py-2.5 rounded-xl bg-white/15 text-white text-sm font-black active:scale-95 disabled:opacity-60">
              {busy ? '…' : 'No spend today'}
            </button>
          </div>
        )}
      </div>

      {milestone !== null &&
        createPortal(
          <div className="fixed inset-0 z-[320] bg-black/70 flex items-center justify-center p-6" onClick={() => setMilestone(null)}>
            <div className="relative w-full max-w-xs rounded-3xl p-6 text-center text-white overflow-hidden" style={{ background: 'linear-gradient(160deg,#17405A,#0E2A3B)' }} onClick={(e) => e.stopPropagation()}>
              <Fireworks />
              <div className="w-20 h-24 mx-auto sc-flare"><FlameSvg className="w-full h-full overflow-visible" /></div>
              <p className="text-5xl font-black mt-1">{milestone}</p>
              <p className="text-lg font-black text-amber-300 uppercase tracking-wide">days in a row</p>
              <p className="text-sm text-white/85 mt-2 leading-snug">
                {milestone >= 30 ? 'A whole month of looking after your family\'s money. That is real responsibility.' : milestone >= 7 ? 'A full week! You earned bonus XP and a streak freeze.' : 'A great start. Keep your flame going.'}
              </p>
              <button type="button" onClick={() => setMilestone(null)} className="mt-5 w-full py-3 rounded-2xl bg-[#FF7A1A] text-white font-black">Keep going</button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
