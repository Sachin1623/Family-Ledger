import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { auth } from '../lib/firebase';

// "Nudge" for any multiplayer game: when you are waiting for someone else's move, this sends them a friendly push (and an in-app banner if their app is
// open). The server enforces who may nudge whom and the limits (one every 2 minutes, 6 per game), see /api/game-nudge. Meant for the dark game screens.
export type NudgeGame = 'rummy' | 'rummy13' | 'spadePledge' | 'sweep' | 'sequence' | 'business' | 'chess' | 'ludo';

export default function NudgeButton({ gameType, gameId, targetUid, targetName, compact }: { gameType: NudgeGame; gameId: string; targetUid: string; targetName: string; compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [wait, setWait] = useState(0); // seconds until another nudge is allowed
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  useEffect(() => {
    if (wait === 0 && state === 'sent') setState('idle');
  }, [wait, state]);

  const first = targetName.split(' ')[0] || 'them';
  const send = async () => {
    if (state !== 'idle' || wait > 0) return;
    setState('sending');
    setMessage(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/game-nudge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType, gameId, targetUid }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setState('sent');
        setWait(120);
      } else {
        setState('idle');
        if (res.status === 429 && data.retryAfter) setWait(Number(data.retryAfter));
        setMessage(data.error || 'Could not send the nudge.');
        setTimeout(() => setMessage(null), 4000);
      }
    } catch {
      setState('idle');
      setMessage('Could not send the nudge.');
      setTimeout(() => setMessage(null), 4000);
    }
  };

  const label = state === 'sending' ? 'Nudging…' : state === 'sent' ? `Nudged ✓${wait > 0 ? ` · ${wait}s` : ''}` : wait > 0 ? `Nudge in ${wait}s` : `👋 Nudge ${first}`;
  return (
    <span className="inline-flex flex-col items-center">
      <button
        type="button"
        onClick={send}
        disabled={state !== 'idle' || wait > 0}
        className={clsx(
          'rounded-full border font-extrabold transition-all active:scale-95 disabled:opacity-70 whitespace-nowrap',
          compact ? 'px-2.5 py-0.5 text-[10px]' : 'px-4 py-1.5 text-[11px]',
          state === 'sent' ? 'bg-emerald-400/15 border-emerald-300/40 text-emerald-300' : 'bg-white/10 border-white/25 text-white',
        )}
      >
        {label}
      </button>
      {message && <span className="mt-1 text-[10px] font-bold text-amber-300 text-center max-w-[220px]">{message}</span>}
    </span>
  );
}
