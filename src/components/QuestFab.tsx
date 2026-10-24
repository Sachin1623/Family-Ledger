import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { Capacitor } from '@capacitor/core';
import { claimQuest, fetchCheerPeople, fetchQuestBoard, questEvent, sendCheer, type CheerPerson, type Quest, type QuestBoard } from '../lib/questsApi';
import Fireworks from './Fireworks';

// The floating quest icon and the quest board it opens. A ring around the icon fills as today's quests get done, a red dot counts rewards waiting
// to be collected, and the board is laid out like a game: progress bars that fill, rewards to collect, a daily sweep bonus, weekly and monthly goals
// and a journey of milestones that never runs out. Everything is checked and paid by the server (quests.ts); this is only the screen.

type Tab = 'start' | 'daily' | 'weekly' | 'journey';

const HIDE_PREFIXES = ['/settlements', '/games', '/admin', '/login', '/add-expense', '/profile', '/chat', '/join', '/groups/join', '/onboarding'];

function ring(fraction: number, size: number, stroke: number) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return { r, c, offset: c * (1 - Math.max(0, Math.min(1, fraction))) };
}

function ProgressBar({ value, target, claimable, claimed }: { value: number; target: number; claimable: boolean; claimed: boolean }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div className="h-3 rounded-full bg-slate-200/80 overflow-hidden relative">
      <motion.div
        className={clsx('h-full rounded-full', claimed ? 'bg-slate-400' : claimable ? 'bg-gradient-to-r from-emerald-400 to-lime-400' : 'bg-gradient-to-r from-sky-400 to-indigo-500')}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      />
      {claimable && <span className="absolute inset-0 rounded-full animate-pulse bg-white/25" />}
    </div>
  );
}

function RewardChips({ xp, coins, dim }: { xp: number; coins: number; dim?: boolean }) {
  return (
    <div className={clsx('flex items-center gap-1.5 shrink-0', dim && 'opacity-50')}>
      <span className="text-[11px] font-black rounded-full bg-indigo-50 text-indigo-700 px-2 py-0.5">⚡ {xp}</span>
      <span className="text-[11px] font-black rounded-full bg-amber-50 text-amber-700 px-2 py-0.5">🪙 {coins}</span>
    </div>
  );
}

function QuestCard({ q, onClaim, onGo, busy, sparkle }: React.Attributes & { q: Quest; onClaim: (q: Quest) => void; onGo: (q: Quest) => void; busy: boolean; sparkle?: boolean }) {
  return (
    <motion.div
      layout
      className={clsx(
        'rounded-2xl border p-3 flex flex-col gap-2 bg-white',
        q.claimable ? 'border-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.2)]' : q.claimed ? 'border-slate-200 bg-slate-50' : 'border-slate-200',
      )}
    >
      <div className="flex items-center gap-3">
        <span className={clsx('w-11 h-11 rounded-2xl flex items-center justify-center shrink-0', q.claimed ? 'bg-slate-200 text-slate-500' : q.claimable ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-50 text-indigo-600')}>
          <span className="material-symbols-outlined text-[26px]" style={{ fontVariationSettings: "'FILL' 1" }}>{q.claimed ? 'check_circle' : q.icon}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className={clsx('text-sm font-black leading-tight', q.claimed ? 'text-slate-500 line-through decoration-slate-300' : 'text-primary')}>{q.title}</p>
          <p className="text-[11px] text-text-muted leading-snug mt-0.5">{q.desc}</p>
        </div>
        <RewardChips xp={q.xp} coins={q.coins} dim={q.claimed} />
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <ProgressBar value={q.progress} target={q.target} claimable={q.claimable} claimed={q.claimed} />
        </div>
        <span className="text-[11px] font-black text-text-muted tabular-nums w-12 text-right">{q.progress}/{q.target}</span>
        {q.claimed ? (
          <span className="text-[11px] font-black text-slate-400 w-16 text-center">Done</span>
        ) : q.claimable ? (
          <motion.button
            type="button"
            disabled={busy}
            onClick={() => onClaim(q)}
            animate={{ scale: [1, 1.07, 1] }}
            transition={{ repeat: Infinity, duration: 1.2 }}
            className={clsx('w-16 h-8 rounded-xl bg-emerald-500 text-white text-xs font-black shadow-md disabled:opacity-60', sparkle && 'ring-2 ring-amber-300')}
          >
            {busy ? '…' : 'Claim'}
          </motion.button>
        ) : q.go ? (
          <button type="button" onClick={() => onGo(q)} className="w-16 h-8 rounded-xl bg-primary/10 text-primary text-xs font-black active:scale-95">Go</button>
        ) : (
          <span className="w-16" />
        )}
      </div>
    </motion.div>
  );
}

function BonusBar({ q, label, onClaim, busy }: { q: Quest; label: string; onClaim: (q: Quest) => void; busy: boolean }) {
  return (
    <div className={clsx('rounded-2xl p-3 text-white', q.claimed ? 'bg-slate-500' : 'bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600')}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wider text-white/80">Bonus</p>
          <p className="text-sm font-black leading-tight">{label}</p>
        </div>
        <RewardChips xp={q.xp} coins={q.coins} />
      </div>
      <div className="flex items-center gap-3 mt-2">
        <div className="flex-1 h-3 rounded-full bg-white/25 overflow-hidden">
          <motion.div className="h-full rounded-full bg-amber-300" initial={{ width: 0 }} animate={{ width: `${(q.progress / q.target) * 100}%` }} transition={{ duration: 0.8 }} />
        </div>
        <span className="text-[11px] font-black tabular-nums">{q.progress}/{q.target}</span>
        {q.claimable && (
          <motion.button type="button" disabled={busy} onClick={() => onClaim(q)} animate={{ scale: [1, 1.08, 1] }} transition={{ repeat: Infinity, duration: 1.1 }} className="h-8 px-3 rounded-xl bg-amber-300 text-indigo-900 text-xs font-black shadow disabled:opacity-60">
            Claim
          </motion.button>
        )}
        {q.claimed && <span className="text-[11px] font-black">✓</span>}
      </div>
    </div>
  );
}

export default function QuestFab() {
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [board, setBoard] = useState<QuestBoard | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('daily');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [people, setPeople] = useState<CheerPerson[] | null>(null);
  const [cheering, setCheering] = useState(false);
  const [cheerBusy, setCheerBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedAt = useRef(0);
  const tabChosen = useRef(false);

  const enabled = !!user && profile?.questsEnabled !== false;
  const hidden = HIDE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`)) || /^\/groups\/[^/]+\/manage$/.test(location.pathname);

  const refresh = useCallback(async () => {
    try {
      const b = await fetchQuestBoard();
      loadedAt.current = Date.now();
      setBoard(b);
      setError(null);
    } catch {
      setError('Could not load your quests. Check your connection and try again.');
    }
  }, []);

  // load when the icon appears, again when the person comes back to the app, after something that counts happened, and at most once a minute while moving around
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const onChanged = () => refresh();
    const onVisible = () => document.visibilityState === 'visible' && Date.now() - loadedAt.current > 30_000 && refresh();
    window.addEventListener('fl-quests-changed', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('fl-quests-changed', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);
  useEffect(() => {
    if (enabled && Date.now() - loadedAt.current > 60_000) refresh();
  }, [location.pathname, enabled, refresh]);

  // the first time the board opens, new people land on Getting started and everyone else on Today
  useEffect(() => {
    if (!open || !board || tabChosen.current) return;
    tabChosen.current = true;
    const claimedStart = board.onboarding.filter((q) => q.claimed).length;
    setTab(!board.onboardingFinished && claimedStart < 3 ? 'start' : 'daily');
  }, [open, board]);
  useEffect(() => {
    if (!open) tabChosen.current = false;
  }, [open]);

  const summary = board?.summary;
  const fraction = summary && summary.todayTotal > 0 ? summary.todayDone / summary.todayTotal : 0;
  const claimable = summary?.claimable ?? 0;

  const claim = async (q: Quest) => {
    if (busyKey) return;
    setBusyKey(q.key);
    setError(null);
    try {
      await claimQuest(q.key);
      if (q.id === 'd_all' || q.id === 'ob_done') setCelebrate(q.title);
      await refresh();
    } catch (e: any) {
      setError(e?.message || 'Could not claim that. Try again.');
    } finally {
      setBusyKey(null);
    }
  };

  const go = (q: Quest) => {
    if (q.go === 'cheer') {
      openCheer();
      return;
    }
    if (q.go && /^https?:\/\//.test(q.go)) {
      // an outside page (the Google Play rating): opened from this button, and counted so the quest can be collected
      window.open(q.go, '_blank');
      if (q.id === 'j_playreview') questEvent('play_review_tap');
      return;
    }
    if (q.go) {
      setOpen(false);
      navigate(q.go);
    }
  };

  const openCheer = async () => {
    setCheering(true);
    setPeople(null);
    try {
      setPeople(await fetchCheerPeople());
    } catch {
      setPeople([]);
    }
  };
  const cheer = async (p: CheerPerson) => {
    setCheerBusy(p.uid);
    try {
      await sendCheer(p.uid);
      setPeople((prev) => prev?.map((x) => (x.uid === p.uid ? { ...x, cheeredToday: true } : x)) ?? prev);
      await refresh();
    } catch (e: any) {
      setError(e?.message || 'Could not send the cheer.');
    } finally {
      setCheerBusy(null);
    }
  };

  const daysLeft = useMemo(() => {
    if (!board) return 0;
    const end = new Date(`${board.weeklyEnds}T00:00:00Z`).getTime();
    const today = new Date(`${board.day}T00:00:00Z`).getTime();
    return Math.max(0, Math.round((end - today) / 86400e3) + 1);
  }, [board]);

  if (!enabled || hidden) return null;

  const size = 60;
  const rg = ring(fraction, size, 5);
  const tabs: { id: Tab; label: string; badge: number }[] = [
    ...(board && !board.onboardingFinished ? [{ id: 'start' as Tab, label: 'Start', badge: board.onboarding.filter((q) => q.claimable).length }] : []),
    { id: 'daily', label: 'Today', badge: board ? [...board.daily, board.dailyBonus].filter((q) => q.claimable).length : 0 },
    { id: 'weekly', label: 'Weekly', badge: board ? [...board.weekly, ...board.monthly].filter((q) => q.claimable).length : 0 },
    { id: 'journey', label: 'Journey', badge: board ? board.journey.filter((q) => q.claimable).length : 0 },
  ];

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); refresh(); }}
        aria-label="Open quests"
        className="fixed left-4 z-40 active:scale-95 transition-transform"
        style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)', width: size, height: size }}
      >
        <svg width={size} height={size} className="absolute inset-0 -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={rg.r} fill="white" stroke="#e2e8f0" strokeWidth={5} />
          <circle cx={size / 2} cy={size / 2} r={rg.r} fill="none" stroke={fraction >= 1 ? '#10b981' : '#6366f1'} strokeWidth={5} strokeLinecap="round" strokeDasharray={rg.c} strokeDashoffset={rg.offset} style={{ transition: 'stroke-dashoffset .8s ease' }} />
        </svg>
        <span className={clsx('absolute inset-0 flex items-center justify-center', claimable > 0 && 'animate-bounce')}>
          <span className="material-symbols-outlined text-[28px] text-indigo-600" style={{ fontVariationSettings: "'FILL' 1" }}>emoji_events</span>
        </span>
        {claimable > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-white text-[11px] font-black flex items-center justify-center shadow ring-2 ring-white animate-pulse">{claimable}</span>
        ) : summary && summary.pending > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-indigo-600 text-white text-[11px] font-black flex items-center justify-center shadow ring-2 ring-white">{summary.pending > 99 ? '99+' : summary.pending}</span>
        ) : null}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div className="fixed inset-0 z-[260] flex items-end sm:items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
              <motion.div
                initial={{ y: 80 }}
                animate={{ y: 0 }}
                exit={{ y: 80 }}
                transition={{ type: 'spring', damping: 26, stiffness: 260 }}
                className="relative w-full sm:max-w-md bg-surface rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden"
              >
                <div className="px-4 pt-4 pb-3 text-white shrink-0" style={{ background: 'linear-gradient(135deg,#312e81 0%,#6d28d9 55%,#c026d3 100%)' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/70">Quest board</p>
                      <h2 className="text-xl font-black leading-tight">Level up your family finances</h2>
                    </div>
                    <button type="button" onClick={() => setOpen(false)} className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center" aria-label="Close">
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </div>
                  {summary && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[11px] font-black text-white/90 mb-1">
                        <span>Today's quests</span>
                        <span>{summary.todayDone}/{summary.todayTotal}{summary.claimable > 0 ? ` · ${summary.claimable} to collect` : ''}</span>
                      </div>
                      <div className="flex gap-1.5">
                        {Array.from({ length: summary.todayTotal }).map((_, i) => (
                          <div key={i} className="flex-1 h-3 rounded-full bg-white/20 overflow-hidden">
                            <motion.div className="h-full bg-amber-300 rounded-full" initial={{ width: 0 }} animate={{ width: i < summary.todayDone ? '100%' : '0%' }} transition={{ duration: 0.6, delay: i * 0.12 }} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-1 px-3 pt-3 shrink-0">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      className={clsx('flex-1 py-2 rounded-xl text-xs font-black relative transition-colors', tab === t.id ? 'bg-primary text-white' : 'bg-white text-text-muted border border-slate-200')}
                    >
                      {t.label}
                      {t.badge > 0 && <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center">{t.badge}</span>}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-2.5 pb-6">
                  {error && <p className="text-xs font-bold text-error bg-error/5 rounded-xl p-2.5">{error}</p>}
                  {!board && !error && <p className="text-center text-sm text-text-muted py-10">Loading your quests…</p>}

                  {board && tab === 'start' && (
                    <>
                      <p className="text-xs text-text-muted px-1">Eight quick steps to get the most out of FamilyLedger. Finish them all for the Guardian Starter bonus.</p>
                      {board.onboarding.map((q) => <QuestCard key={q.key} q={q} onClaim={claim} onGo={go} busy={busyKey === q.key} />)}
                      <BonusBar q={board.onboardingBonus} label="Guardian Starter" onClaim={claim} busy={busyKey === board.onboardingBonus.key} />
                    </>
                  )}

                  {board && tab === 'daily' && (
                    <>
                      {board.daily.map((q) => <QuestCard key={q.key} q={q} onClaim={claim} onGo={go} busy={busyKey === q.key} />)}
                      <BonusBar q={board.dailyBonus} label="Daily sweep: collect all three" onClaim={claim} busy={busyKey === board.dailyBonus.key} />
                      <p className="text-[11px] text-center text-text-muted pt-1">New quests every day. Come back tomorrow for more.</p>
                    </>
                  )}

                  {board && tab === 'weekly' && (
                    <>
                      <div className="flex items-center justify-between px-1">
                        <p className="text-xs font-black text-primary">This week</p>
                        <p className="text-[11px] font-bold text-text-muted">New quests Monday · {daysLeft} day{daysLeft === 1 ? '' : 's'} left</p>
                      </div>
                      {board.weekly.map((q) => <QuestCard key={q.key} q={q} onClaim={claim} onGo={go} busy={busyKey === q.key} />)}
                      <div className="px-1 pt-2">
                        <p className="text-xs font-black text-primary">This month</p>
                        <p className="text-[11px] text-text-muted">{board.monthTheme}</p>
                      </div>
                      {board.monthly.map((q) => <QuestCard key={q.key} q={q} onClaim={claim} onGo={go} busy={busyKey === q.key} />)}
                    </>
                  )}

                  {board && tab === 'journey' && (
                    <>
                      <p className="text-xs text-text-muted px-1">Milestones that keep growing with you. Each one you finish unlocks a bigger one.</p>
                      {board.journey.filter((q) => !(q.id === 'j_playreview' && Capacitor.getPlatform() === 'ios')).map((q) => <QuestCard key={q.key} q={q} onClaim={claim} onGo={go} busy={busyKey === q.key} />)}
                    </>
                  )}
                </div>

                {celebrate && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50" onClick={() => setCelebrate(null)}>
                    <Fireworks />
                    <div className="relative bg-white rounded-3xl p-6 text-center mx-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                      <p className="text-5xl">🏆</p>
                      <p className="text-lg font-black text-primary mt-2">{celebrate}</p>
                      <p className="text-sm text-text-muted mt-1">Bonus collected. You are on a roll!</p>
                      <button type="button" onClick={() => setCelebrate(null)} className="mt-4 w-full py-3 rounded-2xl bg-primary text-white font-black">Keep going</button>
                    </div>
                  </div>
                )}
              </motion.div>
            </motion.div>
          )}

          {open && cheering && (
            <motion.div key="cheer" className="fixed inset-0 z-[270] flex items-end sm:items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-black/60" onClick={() => setCheering(false)} />
              <div className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden">
                <div className="p-4 border-b border-border-subtle flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-black text-primary">Cheer a family member 👏</h3>
                    <p className="text-[11px] text-text-muted">They get a friendly notification.</p>
                  </div>
                  <button type="button" onClick={() => setCheering(false)} className="p-2 rounded-full hover:bg-surface" aria-label="Close"><span className="material-symbols-outlined">close</span></button>
                </div>
                <div className="overflow-y-auto p-3 space-y-2">
                  {people === null && <p className="text-center text-sm text-text-muted py-8">Finding your people…</p>}
                  {people && people.length === 0 && <p className="text-center text-sm text-text-muted py-8">Join or create a group with family to cheer them on.</p>}
                  {people?.map((p) => (
                    <div key={p.uid} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-2.5">
                      {p.photoURL ? <img src={p.photoURL} alt="" className="w-10 h-10 rounded-full object-cover" /> : <span className="w-10 h-10 rounded-full bg-primary/10 text-primary font-black flex items-center justify-center">{p.name.slice(0, 1).toUpperCase()}</span>}
                      <p className="flex-1 min-w-0 text-sm font-bold text-primary truncate">{p.name}</p>
                      <button type="button" disabled={p.cheeredToday || cheerBusy === p.uid} onClick={() => cheer(p)} className={clsx('h-9 px-3 rounded-xl text-xs font-black', p.cheeredToday ? 'bg-slate-100 text-slate-400' : 'bg-amber-400 text-indigo-950 active:scale-95')}>
                        {p.cheeredToday ? 'Cheered' : cheerBusy === p.uid ? '…' : 'Cheer 👏'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
