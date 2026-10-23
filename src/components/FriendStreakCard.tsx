import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import {
  answerStreakInvite, endFriendStreak, fetchFriendStreak, fetchStreakCandidates, inviteToStreak, nudgeFriend, rescueFriendStreak,
  type FriendPerson, type FriendStreakState,
} from '../lib/streakApi';

// A streak shared with one friend, under the streak flame on the home page. Started by an invitation the friend accepts. It grows on a day when
// BOTH of you logged something. A missed day freezes it for up to 3 days; either of you can pay coins to unfreeze it (2 times per streak).

function Avatar({ p, size = 40, ring }: { p: { name: string; photoURL: string | null }; size?: number; ring?: boolean }) {
  return p.photoURL ? (
    <img src={p.photoURL} alt="" className={clsx('rounded-full object-cover bg-white', ring && 'ring-2 ring-white/80')} style={{ width: size, height: size }} />
  ) : (
    <span className={clsx('rounded-full bg-white/20 text-white font-black flex items-center justify-center', ring && 'ring-2 ring-white/80')} style={{ width: size, height: size }}>
      {p.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function FriendStreakCard() {
  const { user, profile } = useAuth();
  const [state, setState] = useState<FriendStreakState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [people, setPeople] = useState<FriendPerson[] | null>(null);
  const [menu, setMenu] = useState(false);
  const loadedAt = useRef(0);

  // reload when my own streak changes (I just logged), so my tick appears at once
  const [mySnap] = useDocument(user ? doc(db, 'userPoints', user.uid, 'meta', 'expenseStreak') : null);
  const myLast = (mySnap?.data() as { lastDateStr?: string } | undefined)?.lastDateStr;

  const refresh = useCallback(async () => {
    try {
      setState(await fetchFriendStreak());
      loadedAt.current = Date.now();
    } catch {
      /* the card simply stays as it was */
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
    const onChanged = () => refresh();
    const onVisible = () => document.visibilityState === 'visible' && Date.now() - loadedAt.current > 30_000 && refresh();
    window.addEventListener('fl-streak-changed', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('fl-streak-changed', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, refresh]);
  useEffect(() => {
    if (user && myLast) refresh();
  }, [myLast, user, refresh]);

  const run = async (name: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (success) setNote(success);
      await refresh();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const openPicker = async () => {
    setPicking(true);
    setPeople(null);
    setError(null);
    try {
      setPeople(await fetchStreakCandidates());
    } catch {
      setPeople([]);
    }
  };

  if (!user) return null;
  if (!state) return null;

  const incoming = state.incoming?.[0];
  const frame = 'rounded-2xl p-4 text-white shadow-sm';

  let body: React.ReactNode;

  if (state.status === 'active' && state.partner) {
    const p = state.partner;
    const frozen = state.state === 'frozen';
    const me = { name: profile?.displayName || user.displayName || 'You', photoURL: profile?.photoURL || user.photoURL || null };
    body = (
      <div className={frame} style={{ background: frozen ? 'linear-gradient(135deg,#0c4a6e 0%,#0369a1 100%)' : 'linear-gradient(135deg,#7c2d12 0%,#c2410c 55%,#ea580c 100%)' }}>
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2 shrink-0">
            <Avatar p={me} ring />
            <Avatar p={p} ring />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-white/70">Friend streak</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black leading-none tabular-nums">{state.current}</span>
              <span className="text-xs font-black uppercase tracking-wide text-amber-200">{frozen ? 'frozen ❄' : 'days together'}</span>
            </div>
            <p className="text-[12px] text-white/85 leading-snug mt-0.5 truncate">with {p.name}{state.longest && state.longest > (state.current || 0) ? ` · best ${state.longest}` : ''}</p>
          </div>
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMenu((m) => !m)} className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center" aria-label="More">
              <span className="material-symbols-outlined text-[20px]">more_vert</span>
            </button>
            {menu && (
              <div className="absolute right-0 top-9 z-10 w-44 rounded-xl bg-white text-primary shadow-xl py-1">
                <button type="button" className="w-full text-left px-3 py-2 text-xs font-bold text-error" onClick={() => { setMenu(false); run('end', endFriendStreak); }}>End this streak</button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-2 mt-3 text-[11px] font-black">
          <span className={clsx('flex-1 rounded-xl px-2.5 py-1.5 flex items-center gap-1.5', state.myDone ? 'bg-emerald-400/90 text-emerald-950' : 'bg-white/15')}>
            <span className="material-symbols-outlined text-[16px]">{state.myDone ? 'check_circle' : 'radio_button_unchecked'}</span>You {state.myDone ? 'logged' : 'not yet'}
          </span>
          <span className={clsx('flex-1 rounded-xl px-2.5 py-1.5 flex items-center gap-1.5 min-w-0', state.partnerDone ? 'bg-emerald-400/90 text-emerald-950' : 'bg-white/15')}>
            <span className="material-symbols-outlined text-[16px]">{state.partnerDone ? 'check_circle' : 'radio_button_unchecked'}</span>
            <span className="truncate">{p.name.split(' ')[0]} {state.partnerDone ? 'logged' : 'not yet'}</span>
          </span>
        </div>

        {frozen && (
          <div className="mt-3 rounded-xl bg-white/10 p-2.5 space-y-2">
            <p className="text-[12px] leading-snug text-white/90">A day was missed, so your streak is frozen. {state.frozenDaysLeft} day{state.frozenDaysLeft === 1 ? '' : 's'} left to save it.</p>
            {state.canRescue ? (
              <button type="button" disabled={busy !== null} onClick={() => run('rescue', rescueFriendStreak, 'Unfrozen! Log something today to keep it going.')} className="w-full py-2.5 rounded-xl bg-white text-sky-900 text-sm font-black active:scale-95 disabled:opacity-60">
                {busy === 'rescue' ? '…' : `Unfreeze for ${state.rescueCost} 🪙`} <span className="font-bold text-sky-700">({state.rescuesLeft} left)</span>
              </button>
            ) : (
              <p className="text-[11px] font-bold text-amber-200">This streak has used its 2 unfreezes.</p>
            )}
          </div>
        )}
        {!frozen && state.rescueKind === 'lost' && state.canRescue && (
          <div className="mt-3 rounded-xl bg-white/10 p-2.5 flex items-center gap-2">
            <p className="flex-1 text-[12px] leading-snug text-white/90">Bring back your {state.lostValue}-day streak together.</p>
            <button type="button" disabled={busy !== null} onClick={() => run('rescue', rescueFriendStreak, 'Restored!')} className="shrink-0 px-3 py-2 rounded-xl bg-white text-sky-900 text-xs font-black active:scale-95 disabled:opacity-60">
              {busy === 'rescue' ? '…' : `Restore · ${state.rescueCost} 🪙`}
            </button>
          </div>
        )}

        {state.myDone && !state.partnerDone && (
          <button type="button" disabled={busy !== null} onClick={() => run('nudge', async () => { const r = await nudgeFriend(); if (r.already) throw new Error('You already nudged them today.'); }, `Nudge sent to ${p.name.split(' ')[0]} 👏`)} className="mt-3 w-full py-2.5 rounded-xl bg-white/20 text-white text-sm font-black active:scale-95 disabled:opacity-60">
            {busy === 'nudge' ? '…' : `Nudge ${p.name.split(' ')[0]}`}
          </button>
        )}
      </div>
    );
  } else if (state.status === 'invited_out' && state.partner) {
    body = (
      <div className={frame} style={{ background: 'linear-gradient(135deg,#334155 0%,#475569 100%)' }}>
        <div className="flex items-center gap-3">
          <Avatar p={state.partner} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black leading-tight">Waiting for {state.partner.name}</p>
            <p className="text-[12px] text-white/80 leading-snug">They have an invite to start a streak with you.</p>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => run('end', endFriendStreak)} className="shrink-0 px-3 py-2 rounded-xl bg-white/15 text-xs font-black active:scale-95 disabled:opacity-60">Cancel</button>
        </div>
      </div>
    );
  } else if (incoming) {
    body = (
      <div className={frame} style={{ background: 'linear-gradient(135deg,#7c2d12 0%,#ea580c 100%)' }}>
        <p className="text-sm font-black leading-tight">🔥 {incoming.name} invited you to a streak</p>
        <p className="text-[12px] text-white/85 leading-snug mt-0.5">Log something every day, both of you, and watch the days add up.</p>
        <div className="flex gap-2 mt-3">
          <button type="button" disabled={busy !== null} onClick={() => run('accept', () => answerStreakInvite(incoming.pairId, true), 'Streak started! Log something today.')} className="flex-1 py-2.5 rounded-xl bg-white text-orange-900 text-sm font-black active:scale-95 disabled:opacity-60">{busy === 'accept' ? '…' : 'Accept'}</button>
          <button type="button" disabled={busy !== null} onClick={() => run('decline', () => answerStreakInvite(incoming.pairId, false))} className="flex-1 py-2.5 rounded-xl bg-white/15 text-white text-sm font-black active:scale-95 disabled:opacity-60">Not now</button>
        </div>
      </div>
    );
  } else {
    body = (
      <button type="button" onClick={openPicker} className="w-full rounded-2xl border-2 border-dashed border-orange-300 bg-orange-50 p-3.5 flex items-center gap-3 text-left active:scale-[0.99]">
        <span className="w-10 h-10 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center shrink-0"><span className="material-symbols-outlined">local_fire_department</span></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-black text-orange-900 leading-tight">{state.status === 'ended' ? 'Your friend streak ended. Start a new one' : 'Keep a streak with a friend'}</span>
          <span className="block text-[11px] text-orange-800/80 leading-snug">Invite someone you love. You both log every day, and the days add up together.</span>
        </span>
        <span className="material-symbols-outlined text-orange-500">chevron_right</span>
      </button>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        {body}
        {note && <p className="text-[11px] font-bold text-emerald-700 px-1">{note}</p>}
        {error && <p className="text-[11px] font-bold text-error px-1">{error}</p>}
      </div>

      {picking &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setPicking(false)} />
            <div className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border-subtle flex items-center justify-between">
                <div>
                  <h3 className="text-base font-black text-primary">Choose your streak partner</h3>
                  <p className="text-[11px] text-text-muted">They get an invite and the streak starts when they accept.</p>
                </div>
                <button type="button" onClick={() => setPicking(false)} className="p-2 rounded-full hover:bg-surface" aria-label="Close"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="overflow-y-auto p-3 space-y-2">
                {people === null && <p className="text-center text-sm text-text-muted py-8">Finding your people…</p>}
                {people && people.length === 0 && <p className="text-center text-sm text-text-muted py-8">Add a friend or join a group with family to start a streak together.</p>}
                {people?.map((p) => (
                  <div key={p.uid} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-2.5">
                    {p.photoURL ? <img src={p.photoURL} alt="" className="w-10 h-10 rounded-full object-cover" /> : <span className="w-10 h-10 rounded-full bg-primary/10 text-primary font-black flex items-center justify-center">{p.name.slice(0, 1).toUpperCase()}</span>}
                    <p className="flex-1 min-w-0 text-sm font-bold text-primary truncate">{p.name}</p>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={async () => {
                        await run('invite', () => inviteToStreak(p.uid), `Invite sent to ${p.name.split(' ')[0]} 🔥`);
                        setPicking(false);
                      }}
                      className="h-9 px-3 rounded-xl bg-orange-500 text-white text-xs font-black active:scale-95 disabled:opacity-60"
                    >
                      Invite
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
