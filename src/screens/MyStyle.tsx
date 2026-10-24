import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import StreakFlame from '../components/StreakFlame';
import { buyFlame, equipStyle, fetchCosmetics, type CosmeticsState } from '../lib/cosmeticsApi';

// "My style": pick the flame style your streak uses and the badges shown next to your name. Flame styles are bought with coins (one earned by a milestone);
// badges are earned. The server decides what is yours (see cosmetics.ts), so this screen only shows it and sends your choices.
export default function MyStyle() {
  const navigate = useNavigate();
  const [data, setData] = useState<CosmeticsState | null>(null);
  const [tab, setTab] = useState<'flames' | 'badges'>('flames');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchCosmetics());
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

  if (!data) {
    return <div className="p-6 text-center text-sm text-text-muted">{error || 'Loading your style…'}</div>;
  }

  const shown = data.equipped.badges;
  const toggleBadge = (id: string) => {
    const next = shown.includes(id) ? shown.filter((b) => b !== id) : [...shown, id].slice(-data.maxBadges);
    run('badge', () => equipStyle({ badges: next }));
  };
  const earnedCount = data.badges.filter((b) => b.earned).length;

  return (
    <div className="p-4 md:p-8 max-w-xl mx-auto space-y-4 pb-24">
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
        <div className="space-y-2">
          <p className="text-[11px] text-text-muted px-1">Earn badges by using the app. Tap an earned badge to show it next to your name (up to {data.maxBadges}).</p>
          {data.badges.map((b) => {
            const on = shown.includes(b.id);
            return (
              <button
                key={b.id}
                type="button"
                disabled={!b.earned || busy !== null}
                onClick={() => toggleBadge(b.id)}
                className={clsx('w-full flex items-center gap-3 rounded-2xl border-2 p-3 text-left bg-white transition-all', on ? 'border-orange-500 bg-orange-50' : 'border-border-subtle', !b.earned && 'opacity-60')}
              >
                <span className={clsx('text-3xl w-10 text-center', !b.earned && 'grayscale')}>{b.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-black text-primary">{b.name}</span>
                  <span className="block text-[11px] text-text-muted">{b.earned ? (on ? 'Shown next to your name' : 'Earned · tap to show') : `🔒 ${b.hint}`}</span>
                </span>
                {on && <span className="material-symbols-outlined text-orange-500">check_circle</span>}
              </button>
            );
          })}
        </div>
      )}

      {note && <p className="text-xs font-bold text-success px-1">{note}</p>}
      {error && <p className="text-xs font-bold text-error px-1">{error}</p>}
    </div>
  );
}
