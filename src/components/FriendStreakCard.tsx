import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import {
  answerStreakInvite, endFriendStreak, fetchFriendStreaks, fetchStreakCandidates, inviteToStreak, nudgeFriend, rescueFriendStreak,
  type ActiveFriendStreak, type FriendPerson, type FriendStreaks,
} from '../lib/streakApi';
import StreakFlame, { Snowfield, useFreezeBurst } from './StreakFlame';

// Streaks shared with friends, under the streak flame on the home page. Each one is started by an invitation the friend accepts, and a person can keep
// several going at once (one per friend). A streak grows on a day when BOTH of you logged something. A missed day freezes it for up to 3 days;
// either of you can pay coins to unfreeze it (2 times per streak).

const AVATAR_TONES = ['#6b5fa0', '#c08a5a', '#3f8f7a', '#b4577a', '#4f7fb8', '#a8893a'];

// A photo that cannot load (expired or blocked link) falls back to the person's initial on a coloured circle, never the browser's broken-image icon.
function Avatar({ p, size = 40, ring }: { p: { name: string; photoURL: string | null }; size?: number; ring?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [p.photoURL]);
  if (p.photoURL && !failed) {
    return <img src={p.photoURL} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={clsx('rounded-full object-cover bg-white', ring && 'ring-2 ring-white/80')} style={{ width: size, height: size }} />;
  }
  const tone = AVATAR_TONES[(p.name.charCodeAt(0) || 0) % AVATAR_TONES.length];
  return (
    <span className={clsx('rounded-full text-white font-black flex items-center justify-center shrink-0', ring && 'ring-2 ring-white/80')} style={{ width: size, height: size, background: tone, fontSize: size * 0.42 }}>
      {p.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const FRAME = 'relative overflow-hidden rounded-2xl p-4 text-white shadow-sm';

// One running streak with one friend.
function ActiveStreakCard({ s, me, onChanged }: React.Attributes & { s: ActiveFriendStreak; me: { name: string; photoURL: string | null; flame?: string }; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const frozen = s.state === 'frozen';
  const burst = useFreezeBurst(frozen, s.rescueKind === 'lost');
  const first = s.partner.name.split(' ')[0];

  const run = async (name: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (success) setNote(success);
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className={FRAME} style={{ background: 'linear-gradient(135deg,#3a1208 0%,#9a3412 55%,#ea580c 100%)' }}>
        <div className="absolute inset-0 pointer-events-none transition-opacity duration-1000" style={{ opacity: frozen ? 1 : 0, background: 'linear-gradient(135deg,#0c4a6e 0%,#0369a1 60%,#38bdf8 140%)' }} />
        <Snowfield show={frozen} />
        <div className="relative flex items-center gap-3">
          {/* each person with their own flame right under their photo, in the style they picked */}
          <div className="shrink-0 flex items-end gap-3">
            {[{ p: me, label: 'You' }, { p: s.partner, label: first }].map(({ p, label }, i) => (
              <div key={i} className="flex flex-col items-center">
                <Avatar p={p} size={30} ring />
                <div className="-mt-0.5"><StreakFlame state={frozen ? 'frozen' : s.current > 0 ? 'lit' : 'out'} size={34} burst={burst} flame={p.flame} /></div>
                <span className="text-[10px] font-black text-white/85 leading-none max-w-[56px] truncate">{label}</span>
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-white/70">Friend streak</p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black leading-none tabular-nums">{s.current}</span>
              <span className="text-xs font-black uppercase tracking-wide text-amber-200">{frozen ? 'frozen ❄' : 'days together'}</span>
            </div>
            <p className="text-[12px] text-white/85 leading-snug mt-0.5 truncate">with {s.partner.name}{s.longest > s.current ? ` · best ${s.longest}` : ''}</p>
          </div>
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMenu((m) => !m)} className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center" aria-label="More">
              <span className="material-symbols-outlined text-[20px]">more_vert</span>
            </button>
            {menu && (
              <div className="absolute right-0 top-9 z-10 w-44 rounded-xl bg-white text-primary shadow-xl py-1">
                <button type="button" className="w-full text-left px-3 py-2 text-xs font-bold text-error" onClick={() => { setMenu(false); run('end', () => endFriendStreak(s.pairId)); }}>End this streak</button>
              </div>
            )}
          </div>
        </div>

        <div className="relative flex gap-2 mt-3 text-[11px] font-black">
          <span className={clsx('flex-1 rounded-xl px-2.5 py-1.5 flex items-center gap-1.5', s.myDone ? 'bg-emerald-400/90 text-emerald-950' : 'bg-white/15')}>
            <span className="material-symbols-outlined text-[16px]">{s.myDone ? 'check_circle' : 'radio_button_unchecked'}</span>You {s.myDone ? 'logged' : 'not yet'}
          </span>
          <span className={clsx('flex-1 rounded-xl px-2.5 py-1.5 flex items-center gap-1.5 min-w-0', s.partnerDone ? 'bg-emerald-400/90 text-emerald-950' : 'bg-white/15')}>
            <span className="material-symbols-outlined text-[16px]">{s.partnerDone ? 'check_circle' : 'radio_button_unchecked'}</span>
            <span className="truncate">{first} {s.partnerDone ? 'logged' : 'not yet'}</span>
          </span>
        </div>

        {frozen && (
          <div className="relative mt-3 rounded-xl bg-white/10 p-2.5 space-y-2">
            <p className="text-[12px] leading-snug text-white/90">A day was missed, so your streak is frozen. {s.frozenDaysLeft} day{s.frozenDaysLeft === 1 ? '' : 's'} left to save it.</p>
            {s.canRescue ? (
              <button type="button" disabled={busy !== null} onClick={() => run('rescue', () => rescueFriendStreak(s.pairId), 'Unfrozen! Log something today to keep it going.')} className="w-full py-2.5 rounded-xl bg-white text-sky-900 text-sm font-black active:scale-95 disabled:opacity-60">
                {busy === 'rescue' ? '…' : `Unfreeze for ${s.rescueCost} 🪙`} <span className="font-bold text-sky-700">({s.rescuesLeft} left)</span>
              </button>
            ) : (
              <p className="text-[11px] font-bold text-amber-200">This streak has used its 2 unfreezes.</p>
            )}
          </div>
        )}
        {!frozen && s.rescueKind === 'lost' && s.canRescue && (
          <div className="relative mt-3 rounded-xl bg-white/10 p-2.5 flex items-center gap-2">
            <p className="flex-1 text-[12px] leading-snug text-white/90">Bring back your {s.lostValue}-day streak together.</p>
            <button type="button" disabled={busy !== null} onClick={() => run('rescue', () => rescueFriendStreak(s.pairId), 'Restored!')} className="shrink-0 px-3 py-2 rounded-xl bg-white text-sky-900 text-xs font-black active:scale-95 disabled:opacity-60">
              {busy === 'rescue' ? '…' : `Restore · ${s.rescueCost} 🪙`}
            </button>
          </div>
        )}

        {s.myDone && !s.partnerDone && (
          <button type="button" disabled={busy !== null} onClick={() => run('nudge', async () => { const r = await nudgeFriend(s.pairId); if (r.already) throw new Error('You already nudged them today.'); }, `Nudge sent to ${first} 👏`)} className="relative mt-3 w-full py-2.5 rounded-xl bg-white/20 text-white text-sm font-black active:scale-95 disabled:opacity-60">
            {busy === 'nudge' ? '…' : `Nudge ${first}`}
          </button>
        )}
      </div>
      {note && <p className="text-[11px] font-bold text-emerald-700 px-1">{note}</p>}
      {error && <p className="text-[11px] font-bold text-error px-1">{error}</p>}
    </div>
  );
}

export default function FriendStreakCard() {
  const { user, profile } = useAuth();
  const [data, setData] = useState<FriendStreaks | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null); // the streak or invite whose details are open
  const [people, setPeople] = useState<(FriendPerson & { taken: boolean })[] | null>(null);
  const loadedAt = useRef(0);

  // reload when my own streak changes (I just logged), so my tick appears at once
  const [mySnap] = useDocument(user ? doc(db, 'userPoints', user.uid, 'meta', 'expenseStreak') : null);
  const myLast = (mySnap?.data() as { lastDateStr?: string } | undefined)?.lastDateStr;

  const refresh = useCallback(async () => {
    try {
      setData(await fetchFriendStreaks());
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

  if (!user || !data) return null;

  const me = { name: profile?.displayName || user.displayName || 'You', photoURL: profile?.photoURL || user.photoURL || null, flame: data.me?.flame };

  // Five slots in one row: running streaks first, then invites for me, then invites I sent, then empty "+" slots.
  type Slot =
    | { kind: 'active'; s: ActiveFriendStreak }
    | { kind: 'incoming'; inv: FriendStreaks['incoming'][number] }
    | { kind: 'outgoing'; o: FriendStreaks['outgoing'][number] }
    | { kind: 'empty' };
  const items: Slot[] = [
    ...data.streaks.map((s) => ({ kind: 'active' as const, s })),
    ...data.incoming.map((inv) => ({ kind: 'incoming' as const, inv })),
    ...data.outgoing.map((o) => ({ kind: 'outgoing' as const, o })),
  ];
  const slots: Slot[] = [...items.slice(0, data.max), ...Array.from({ length: Math.max(0, data.max - items.length) }, () => ({ kind: 'empty' as const }))];
  const hiddenInvites = Math.max(0, items.length - data.max);

  const first = (n: string) => n.split(' ')[0];
  const tile = 'relative rounded-2xl px-1 py-1.5 flex flex-col items-center justify-center gap-0.5 min-w-0 h-[84px] flex-1 basis-0 active:scale-95 transition-transform';
  // a running streak is the tile with most to show, so it gets a wider slot than a waiting invite or an empty one
  const wide = 'flex-[1.5]';

  const selected = sheet ? slots.find((x) => (x.kind === 'active' && x.s.pairId === sheet) || (x.kind === 'incoming' && x.inv.pairId === sheet) || (x.kind === 'outgoing' && x.o.pairId === sheet)) : null;
  const filled = items.length;

  return (
    <>
      <div className="rounded-2xl bg-white border border-slate-200 px-3 py-2.5 shadow-sm">
        <div className="flex items-center justify-between px-0.5 mb-1.5">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-orange-700">Friend streaks</p>
          <p className="text-[11px] font-black text-text-muted tabular-nums">{Math.min(filled, data.max)}/{data.max}</p>
        </div>
        <div className="flex gap-2">
          {slots.map((slot, i) => {
            if (slot.kind === 'active') {
              const { s } = slot;
              const frozen = s.state === 'frozen';
              return (
                <button key={s.pairId} type="button" onClick={() => setSheet(s.pairId)} className={clsx(tile, wide, 'text-white shadow-sm')} style={{ background: frozen ? 'linear-gradient(160deg,#0c4a6e 0%,#0284c7 100%)' : 'linear-gradient(160deg,#3a1208 0%,#9a3412 60%,#ea580c 100%)' }} aria-label={`Streak with ${s.partner.name}: ${s.current} days`}>
                  {/* you on the left, your friend on the right: each photo has its own flame right under it (in the style that person picked) and a green tick once they have logged today */}
                  <span className="flex items-end justify-center gap-1 leading-none">
                    {[{ p: me, done: s.myDone, flame: data.me?.flame }, { p: s.partner, done: s.partnerDone, flame: s.partner.flame }].map((x, i) => (
                      <span key={i} className="flex flex-col items-center">
                        <span className="relative">
                          <Avatar p={x.p} size={24} ring />
                          {x.done && <span className="absolute -right-1 -bottom-0.5 w-3 h-3 rounded-full bg-emerald-400 text-emerald-950 flex items-center justify-center text-[8px] font-black ring-1 ring-black/30">✓</span>}
                        </span>
                        <span className="w-[16px] h-[19px] overflow-visible mt-0.5"><StreakFlame state={frozen ? 'frozen' : s.current > 0 ? 'lit' : 'out'} size={16} flame={x.flame} /></span>
                      </span>
                    ))}
                  </span>
                  <span className="flex items-baseline justify-center gap-1 leading-none w-full min-w-0">
                    <span className="text-sm font-black tabular-nums">{s.current}</span>
                    <span className="text-[10px] font-bold truncate">{first(s.partner.name)}{s.partner.badges && s.partner.badges.length > 0 ? ` ${s.partner.badges.join('')}` : ''}</span>
                  </span>
                </button>
              );
            }
            if (slot.kind === 'incoming') {
              return (
                <button key={slot.inv.pairId} type="button" onClick={() => setSheet(slot.inv.pairId)} className={clsx(tile, 'bg-orange-50 border-2 border-orange-400 animate-pulse')} aria-label={`${slot.inv.name} invited you to a streak`}>
                  <span className="w-7 h-7 rounded-full bg-orange-500 text-white font-black flex items-center justify-center text-sm">{slot.inv.name.slice(0, 1).toUpperCase()}</span>
                  <span className="text-[10px] font-bold truncate w-full text-center leading-none text-orange-900">{first(slot.inv.name)}</span>
                  <span className="text-[10px] font-black text-orange-700 leading-tight text-center">Invited you</span>
                </button>
              );
            }
            if (slot.kind === 'outgoing') {
              return (
                <button key={slot.o.pairId} type="button" onClick={() => setSheet(slot.o.pairId)} className={clsx(tile, 'bg-slate-100 border border-slate-300')} aria-label={`Waiting for ${slot.o.partner.name}`}>
                  <span className="relative opacity-70 grayscale">
                    <Avatar p={{ name: slot.o.partner.name, photoURL: slot.o.partner.photoURL }} size={30} />
                    <span className="absolute -right-1.5 -bottom-1 w-4 h-4 rounded-full bg-white text-[10px] leading-none flex items-center justify-center shadow ring-1 ring-slate-300 grayscale-0">⏳</span>
                  </span>
                  <span className="text-[10px] font-bold truncate w-full text-center leading-none text-slate-700 mt-0.5">{first(slot.o.partner.name)}</span>
                </button>
              );
            }
            return (
              <button key={`empty${i}`} type="button" onClick={openPicker} className={clsx(tile, 'border-2 border-dashed border-orange-300 bg-orange-50/60 text-orange-500')} aria-label="Invite a friend to a streak">
                <span className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center"><span className="material-symbols-outlined text-[20px]">add</span></span>
                <span className="text-[10px] font-black leading-tight text-center text-orange-700">Invite</span>
              </button>
            );
          })}
        </div>
        {hiddenInvites > 0 && <p className="text-[10px] font-bold text-text-muted mt-2 px-0.5">{hiddenInvites} more invite{hiddenInvites === 1 ? '' : 's'} waiting. End a streak to free a slot.</p>}
        {note && <p className="text-[11px] font-bold text-emerald-700 mt-2 px-0.5">{note}</p>}
        {error && <p className="text-[11px] font-bold text-error mt-2 px-0.5">{error}</p>}
      </div>

      {selected && selected.kind !== 'empty' &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setSheet(null)} />
            <div className="relative w-full sm:max-w-sm max-h-[88vh] overflow-y-auto p-3 pb-6">
              <button type="button" onClick={() => setSheet(null)} className="absolute right-4 top-4 z-20 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center" aria-label="Close"><span className="material-symbols-outlined text-[20px]">close</span></button>
              {selected.kind === 'active' && <ActiveStreakCard s={selected.s} me={me} onChanged={refresh} />}
              {selected.kind === 'incoming' && (
                <div className={FRAME} style={{ background: 'linear-gradient(135deg,#7c2d12 0%,#ea580c 100%)' }}>
                  <p className="text-base font-black leading-tight pr-8">🔥 {selected.inv.name} invited you to a streak</p>
                  <p className="text-[12px] text-white/85 leading-snug mt-1">Log something every day, both of you, and watch the days add up.</p>
                  <div className="flex gap-2 mt-4">
                    <button type="button" disabled={busy !== null} onClick={async () => { await run('accept', () => answerStreakInvite(selected.inv.pairId, true), 'Streak started! Log something today.'); setSheet(null); }} className="flex-1 py-2.5 rounded-xl bg-white text-orange-900 text-sm font-black active:scale-95 disabled:opacity-60">{busy === 'accept' ? '…' : 'Accept'}</button>
                    <button type="button" disabled={busy !== null} onClick={async () => { await run('decline', () => answerStreakInvite(selected.inv.pairId, false)); setSheet(null); }} className="flex-1 py-2.5 rounded-xl bg-white/15 text-white text-sm font-black active:scale-95 disabled:opacity-60">Not now</button>
                  </div>
                </div>
              )}
              {selected.kind === 'outgoing' && (
                <div className={FRAME} style={{ background: 'linear-gradient(135deg,#334155 0%,#475569 100%)' }}>
                  <div className="flex items-center gap-3 pr-8">
                    <Avatar p={selected.o.partner} size={44} />
                    <div className="min-w-0">
                      <p className="text-base font-black leading-tight truncate">Waiting for {selected.o.partner.name}</p>
                      <p className="text-[12px] text-white/80 leading-snug">Your streak invite is waiting for them to accept.</p>
                    </div>
                  </div>
                  <button type="button" disabled={busy !== null} onClick={async () => { await run('cancel', () => endFriendStreak(selected.o.pairId)); setSheet(null); }} className="mt-4 w-full py-2.5 rounded-xl bg-white/15 text-white text-sm font-black active:scale-95 disabled:opacity-60">{busy === 'cancel' ? '…' : 'Cancel the invite'}</button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {picking &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setPicking(false)} />
            <div className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border-subtle flex items-center justify-between">
                <div>
                  <h3 className="text-base font-black text-primary">Choose your streak partner</h3>
                  <p className="text-[11px] text-text-muted">They get an invite and the streak starts when they accept. You can invite more than one friend.</p>
                </div>
                <button type="button" onClick={() => setPicking(false)} className="p-2 rounded-full hover:bg-surface" aria-label="Close"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="overflow-y-auto p-3 space-y-2">
                {people === null && <p className="text-center text-sm text-text-muted py-8">Finding your people…</p>}
                {people && people.length === 0 && <p className="text-center text-sm text-text-muted py-8">Add a friend or join a group with family to start a streak together.</p>}
                {people?.map((p) => (
                  <div key={p.uid} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-2.5">
                    <Avatar p={p} size={40} />
                    <p className="flex-1 min-w-0 text-sm font-bold text-primary truncate">{p.name}</p>
                    <button
                      type="button"
                      disabled={busy !== null || p.taken}
                      onClick={async () => {
                        await run('invite', () => inviteToStreak(p.uid), `Invite sent to ${p.name.split(' ')[0]} 🔥`);
                        setPicking(false);
                      }}
                      className={clsx('h-9 px-3 rounded-xl text-xs font-black active:scale-95 disabled:opacity-60', p.taken ? 'bg-slate-100 text-slate-400' : 'bg-orange-500 text-white')}
                    >
                      {p.taken ? 'Already' : 'Invite'}
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
