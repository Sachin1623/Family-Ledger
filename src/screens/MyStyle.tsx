import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import StreakFlame from '../components/StreakFlame';
import BadgeMedal, { TIERS } from '../components/BadgeMedal';
import Fireworks from '../components/Fireworks';
import { buyFlame, equipStyle, fetchCosmetics, type BadgeOption, type CosmeticsState } from '../lib/cosmeticsApi';

// "My style": pick the flame style your streak uses and the badges shown next to your name. Flame styles are bought with coins (one earned by a milestone);
// badges are earned. The server decides what is yours (see cosmetics.ts), so this screen only shows it and sends your choices.
export default function MyStyle() {
  const navigate = useNavigate();
  const [data, setData] = useState<CosmeticsState | null>(null);
  const [tab, setTab] = useState<'flames' | 'badges'>('flames');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [openBadge, setOpenBadge] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const d = await fetchCosmetics();
      setData(d);
      if (d.newlyEarned?.length) setCelebrate(d.newlyEarned);
    } catch (e: any) {
      setError(e?.message || 'Could not load your style.');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (success) setNote(success);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  // the badge closest to being earned: the reason to come back tomorrow
  const nextUp = useMemo(() => {
    const open = (data?.badges || []).filter((b) => !b.earned && b.progress > 0);
    return open.sort((a, b) => b.progress / b.target - a.progress / a.target)[0] || (data?.badges || []).find((b) => !b.earned) || null;
  }, [data]);

  if (!data) {
    return <div className="p-6 text-center text-sm text-text-muted">{error || 'Loading your style…'}</div>;
  }

  const shown = data.equipped.badges;
  const toggleBadge = (id: string) => {
    const next = shown.includes(id) ? shown.filter((b) => b !== id) : [...shown, id].slice(-data.maxBadges);
    run('badge', () => equipStyle({ badges: next }));
  };
  const earnedCount = data.badges.filter((b) => b.earned).length;
  const sheetBadge: BadgeOption | undefined = openBadge ? data.badges.find((b) => b.id === openBadge) : undefined;
  const celebrateBadge: BadgeOption | undefined = celebrate.length ? data.badges.find((b) => b.id === celebrate[0]) : undefined;

  return (
    <div className="p-4 md:p-8 max-w-xl mx-auto space-y-4" style={{ paddingBottom: 'calc(9rem + env(safe-area-inset-bottom))' }}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-surface" aria-label="Back">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <h1 className="text-lg font-black text-primary flex-1">My style</h1>
        <span className="text-sm font-black text-warning bg-warning/10 rounded-full px-3 py-1">🪙 {data.coins}</span>
      </div>

      {/* what friends see */}
      <div className="rounded-2xl p-4 text-white flex items-center gap-4" style={{ background: 'linear-gradient(135deg,#3a1208 0%,#7c2d12 55%,#9a3412 100%)' }}>
        <div className="shrink-0" style={{ width: 60 }}><StreakFlame state="lit" size={58} flame={data.equipped.flame} /></div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/70">How friends see you</p>
          <p className="text-xl font-black truncate">You {shown.map((id) => data.badges.find((b) => b.id === id)?.icon).filter(Boolean).join(' ')}</p>
          <p className="text-[11px] text-white/75">Shows on your streak and on friend streak tiles</p>
        </div>
      </div>

      <div className="flex bg-surface-container/60 rounded-xl p-0.5">
        {([['flames', 'Flames'], ['badges', `Badges ${earnedCount}/${data.badges.length}`]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={clsx('flex-1 py-2 rounded-[10px] text-xs font-black transition-all', tab === id ? 'bg-white text-primary shadow-sm' : 'text-text-muted')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'flames' && (
        <div className="grid grid-cols-2 gap-2.5">
          {data.flames.map((f) => {
            const equipped = data.equipped.flame === f.id;
            return (
              <div key={f.id} className={clsx('rounded-2xl border-2 bg-white p-3 text-center', equipped ? 'border-orange-500 bg-orange-50' : 'border-border-subtle')}>
                <div className="mx-auto flex justify-center" style={{ height: 50 }}><StreakFlame state="lit" size={40} flame={f.id} /></div>
                <p className="text-sm font-black text-primary mt-1">{f.name}</p>
                {f.unlocked ? (
                  equipped ? (
                    <p className="text-[11px] font-black text-success mt-1.5">Equipped</p>
                  ) : (
                    <button type="button" disabled={busy !== null} onClick={() => run('equip', () => equipStyle({ flame: f.id }))} className="mt-1.5 w-full py-1.5 rounded-xl bg-primary/10 text-primary text-xs font-black active:scale-95 disabled:opacity-60">
                      Use this
                    </button>
                  )
                ) : f.earnedOnly ? (
                  <p className="text-[11px] font-bold text-text-muted mt-1.5">🔒 {f.hint}</p>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null || data.coins < f.price}
                    onClick={() => run('buy', () => buyFlame(f.id), `${f.name} is yours and equipped.`)}
                    className="mt-1.5 w-full py-1.5 rounded-xl bg-orange-500 text-white text-xs font-black active:scale-95 disabled:opacity-50"
                  >
                    {busy === 'buy' ? '…' : `Buy · 🪙 ${f.price}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'badges' && (
        <div className="space-y-4">
          {/* collection summary */}
          <div className="rounded-2xl border border-border-subtle bg-white p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-black text-primary">Your collection</p>
              <p className="text-sm font-black text-primary tabular-nums">{earnedCount}/{data.badges.length}</p>
            </div>
            <div className="mt-2 h-2 rounded-full bg-surface overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-amber-300 transition-all duration-700" style={{ width: `${(earnedCount / data.badges.length) * 100}%` }} /></div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {(['bronze', 'silver', 'gold', 'legend'] as const).map((tier) => (
                <span key={tier} className="text-[11px] font-bold text-text-muted">
                  <span className="inline-block w-2.5 h-2.5 rounded-full mr-1 align-middle" style={{ background: TIERS[tier].glow }} />
                  {TIERS[tier].label} {data.badges.filter((b) => b.tier === tier && b.earned).length}/{data.badges.filter((b) => b.tier === tier).length}
                </span>
              ))}
            </div>
          </div>

          {/* the closest one: the reason to come back tomorrow */}
          {nextUp && (
            <button type="button" onClick={() => setOpenBadge(nextUp.id)} className="w-full text-left rounded-2xl p-3.5 text-white flex items-center gap-3.5 active:scale-[0.99] transition-transform" style={{ background: 'linear-gradient(135deg,#1e1b4b,#4c1d95 60%,#7c3aed)' }}>
              <BadgeMedal badge={nextUp} size={64} />
              <span className="flex-1 min-w-0">
                <span className="block text-[10px] font-black uppercase tracking-[0.16em] text-violet-200">Next up</span>
                <span className="block text-base font-black truncate">{nextUp.name}</span>
                <span className="block text-[12px] text-violet-100">{nextUp.hint} · {nextUp.target - nextUp.progress} to go</span>
                <span className="block mt-1.5 h-1.5 rounded-full bg-white/20 overflow-hidden"><span className="block h-full rounded-full bg-gradient-to-r from-amber-300 to-yellow-100" style={{ width: `${Math.max(4, (nextUp.progress / nextUp.target) * 100)}%` }} /></span>
              </span>
            </button>
          )}

          {/* the shelf: rarest first, so the legendary ones are always in sight */}
          {(['legend', 'gold', 'silver', 'bronze'] as const).map((tier) => {
            const list = data.badges.filter((b) => b.tier === tier);
            if (list.length === 0) return null;
            return (
              <div key={tier}>
                <p className="text-[11px] font-black uppercase tracking-[0.16em] mb-2 px-1" style={{ color: tier === 'legend' ? '#7c3aed' : tier === 'gold' ? '#b07c00' : tier === 'silver' ? '#5f6b7b' : '#8a4b14' }}>{TIERS[tier].label}</p>
                <div className="grid grid-cols-3 gap-2.5">
                  {list.map((b) => {
                    const on = shown.includes(b.id);
                    return (
                      <button key={b.id} type="button" onClick={() => setOpenBadge(b.id)} className={clsx('relative flex flex-col items-center gap-1.5 rounded-2xl border-2 bg-white px-1.5 py-3 active:scale-95 transition-transform', on ? 'border-orange-500 bg-orange-50' : 'border-border-subtle')}>
                        <BadgeMedal badge={b} size={68} />
                        <span className="text-[11px] font-black text-primary text-center leading-tight line-clamp-2">{b.earned ? b.name : '???'}</span>
                        <span className="text-[10px] font-bold text-text-muted tabular-nums">{b.earned ? (on ? 'Shown' : 'Earned') : `${b.progress}/${b.target}`}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {note && <p className="text-xs font-bold text-success px-1">{note}</p>}
      {error && <p className="text-xs font-bold text-error px-1">{error}</p>}

      {sheetBadge &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setOpenBadge(null)} />
            <div className="relative w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl p-6 text-center shadow-2xl" style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
              <div className="flex justify-center"><BadgeMedal badge={sheetBadge} size={120} /></div>
              <p className="text-[11px] font-black uppercase tracking-[0.16em] mt-3" style={{ color: TIERS[sheetBadge.tier].glow }}>{TIERS[sheetBadge.tier].label}</p>
              <p className="text-xl font-black text-primary">{sheetBadge.earned ? sheetBadge.name : 'Locked badge'}</p>
              <p className="text-sm text-text-muted mt-1">{sheetBadge.hint}</p>
              {!sheetBadge.earned && (
                <div className="mt-3">
                  <div className="h-2 rounded-full bg-surface overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-amber-300" style={{ width: `${Math.max(3, (sheetBadge.progress / sheetBadge.target) * 100)}%` }} /></div>
                  <p className="text-xs font-bold text-text-muted mt-1.5">{sheetBadge.progress} of {sheetBadge.target} · {sheetBadge.target - sheetBadge.progress} to go</p>
                </div>
              )}
              {sheetBadge.earned && (
                <button type="button" disabled={busy !== null} onClick={() => { toggleBadge(sheetBadge.id); setOpenBadge(null); }} className="mt-4 w-full py-3 rounded-2xl bg-orange-500 text-white font-black active:scale-95 disabled:opacity-60">
                  {shown.includes(sheetBadge.id) ? 'Hide from my name' : 'Show next to my name'}
                </button>
              )}
              <button type="button" onClick={() => setOpenBadge(null)} className="mt-2 w-full py-2.5 rounded-2xl bg-surface text-text-muted text-sm font-black active:scale-95">Close</button>
            </div>
          </div>,
          document.body,
        )}

      {celebrateBadge &&
        createPortal(
          <div className="fixed inset-0 z-[320] bg-black/70 flex items-center justify-center p-6" onClick={() => setCelebrate((c) => c.slice(1))}>
            <div className="relative w-full max-w-xs rounded-3xl p-6 text-center text-white overflow-hidden" style={{ background: 'linear-gradient(160deg,#1e1b4b,#4c1d95)' }} onClick={(e) => e.stopPropagation()}>
              <Fireworks />
              <p className="text-[11px] font-black uppercase tracking-[0.2em] text-violet-200">New badge unlocked</p>
              <div className="flex justify-center mt-4"><BadgeMedal badge={celebrateBadge} size={130} /></div>
              <p className="text-2xl font-black mt-3">{celebrateBadge.name}</p>
              <p className="text-sm text-violet-100 mt-1">{celebrateBadge.hint}</p>
              <button type="button" onClick={() => { if (!shown.includes(celebrateBadge.id)) toggleBadge(celebrateBadge.id); setCelebrate((c) => c.slice(1)); }} className="mt-5 w-full py-3 rounded-2xl bg-amber-400 text-orange-950 font-black active:scale-95">Show it next to my name</button>
              <button type="button" onClick={() => setCelebrate((c) => c.slice(1))} className="mt-2 w-full py-2 rounded-2xl bg-white/10 text-white/90 text-sm font-bold active:scale-95">Not now</button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
