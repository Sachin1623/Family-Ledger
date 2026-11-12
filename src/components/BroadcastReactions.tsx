import React from 'react';
import { auth } from '../lib/firebase';

// Four one-tap reactions under a broadcast. What everyone chose is shown only after the person has picked (so they vote before seeing the crowd),
// and only once enough people have reacted for the number to mean something. A pick can be changed later from "Watch again".
const REACTIONS = [
  { key: 'like', emoji: '👍', label: 'Like' },
  { key: 'love', emoji: '❤️', label: 'Love' },
  { key: 'party', emoji: '🎉', label: 'Celebrate' },
  { key: 'think', emoji: '🤔', label: 'Not sure' },
] as const;
const SHOW_COUNTS_FROM = 25;

type State = { counts: Record<string, number>; total: number; mine: string | null };

async function call(id: string, method: 'GET' | 'POST', reaction?: string): Promise<State> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('not signed in');
  const res = await fetch(`/api/broadcast-reactions/${encodeURIComponent(id)}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify({ reaction }) : undefined,
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// `preview`: a test broadcast. The buttons work on this screen only, so the sender can see how it looks without anything being counted.
// `onPicked`: called a moment after the person picks (long enough to read what everyone chose), used when the reactions are the last step before the
// broadcast closes. `large`: the bigger buttons for that step.
export default function BroadcastReactions({ broadcastId, preview = false, onPicked, large = false }: { broadcastId: string; preview?: boolean; onPicked?: () => void; large?: boolean }) {
  const [state, setState] = React.useState<State | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (preview) { setState({ counts: {}, total: 0, mine: null }); return; }
    let cancelled = false;
    setState(null); setFailed(false);
    call(broadcastId, 'GET').then((s) => { if (!cancelled) setState(s); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [broadcastId, preview]);

  // closes a beat after the tap (enough to see the pick land), not after the server answers: the save carries on in the background
  const finish = () => { if (onPicked) setTimeout(onPicked, 600); };
  const pick = async (key: string) => {
    if (busy || state?.mine === key) return;
    if (preview) { setState({ counts: {}, total: 0, mine: key }); finish(); return; }
    setBusy(true);
    setFailed(false);
    // show the pick at once; the server's totals replace it when they arrive
    setState((s) => (s ? { ...s, mine: key } : { counts: {}, total: 0, mine: key }));
    finish();
    try {
      setState(await call(broadcastId, 'POST', key));
    } catch {
      setFailed(true);
      call(broadcastId, 'GET').then(setState).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const mine = state?.mine || null;
  const total = state?.total || 0;
  const enough = total >= SHOW_COUNTS_FROM;
  return (
    <div className={`rounded-2xl bg-surface ${large ? 'px-3 py-3' : 'px-3 py-2.5'}`}>
      <div className="flex items-center justify-between gap-1">
        {REACTIONS.map((r) => {
          const on = mine === r.key;
          const pctOf = enough && mine ? Math.round(((state?.counts[r.key] || 0) / total) * 100) : null;
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => pick(r.key)}
              aria-label={r.label}
              aria-pressed={on}
              className={`flex-1 flex flex-col items-center gap-0.5 rounded-xl py-1.5 transition-all active:scale-90 ${on ? 'bg-primary/10 ring-2 ring-primary/40' : mine ? 'opacity-60' : ''}`}
            >
              <span className={large ? 'text-[34px] leading-none' : 'text-[24px] leading-none'}>{r.emoji}</span>
              <span className="text-[10px] font-black text-text-muted h-3">{pctOf !== null ? `${pctOf}%` : ''}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-center text-text-muted mt-1 min-h-[16px]">
        {failed ? 'Could not save that. Try again.' : !state ? '' : !mine ? 'Tap one to react to this update.' : enough ? `${total.toLocaleString()} people reacted` : 'You are one of the first to react'}
      </p>
    </div>
  );
}
