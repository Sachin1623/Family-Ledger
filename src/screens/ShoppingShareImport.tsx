import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { dismissShare, getShare, saveShare, type ShareSummary } from '../lib/shoppingEvents';
import { itemIcon, listIconGuess } from '../lib/shoppingIcons';

// A list a friend sent (or a link opened): shows exactly what is inside, and "Save to my lists" makes a separate copy that is the person's own.
export default function ShoppingShareImport() {
  const { shareId } = useParams();
  const navigate = useNavigate();
  const [share, setShare] = useState<ShareSummary | null>(null);
  const [error, setError] = useState('');
  const [asEvent, setAsEvent] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getShare(shareId!).then((s) => { if (!cancelled) { setShare(s); setAsEvent(!!s.eventName); } }).catch((e) => { if (!cancelled) setError(e?.message === 'not signed in' ? 'Sign in to see this list.' : 'This list is no longer shared, or the link is not right.'); });
    return () => { cancelled = true; };
  }, [shareId]);

  const save = async () => {
    if (!share) return;
    setSaving(true);
    try {
      const { listId } = await saveShare(share.id, asEvent);
      navigate(`/shopping-lists/${listId}`, { replace: true });
    } catch {
      setError('Could not save the list. Try again.');
      setSaving(false);
    }
  };
  const notNow = async () => {
    if (share && !share.fromMe) await dismissShare(share.id).catch(() => {});
    navigate('/shopping-lists', { replace: true });
  };

  if (error && !share) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center text-text-muted">
        <p>{error}</p>
        <button type="button" onClick={() => navigate('/shopping-lists')} className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-black">Go to my shopping lists</button>
      </div>
    );
  }
  if (!share) return <div className="min-h-screen flex items-center justify-center text-text-muted">Loading…</div>;

  const icon = share.icon || listIconGuess(share.title) || '🛒';
  const items = share.items || [];
  return (
    <div className="flex flex-col min-h-screen bg-[#f2f6fa]">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        <div className="rounded-3xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(140deg,#0b3b57,#0f7a8f 55%,#22c1a5)' }}>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/80">{share.fromMe ? 'A copy you sent' : `${share.fromName} sent you a list`}</p>
          <div className="flex items-center gap-3 mt-1">
            <span className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-[24px] shrink-0">{icon}</span>
            <div className="min-w-0">
              <h1 className="text-lg font-black leading-tight break-words">{share.title}</h1>
              <p className="text-[12px] text-white/85">{share.itemCount} item{share.itemCount === 1 ? '' : 's'}</p>
            </div>
          </div>
          <p className="text-[11px] text-white/85 mt-3">Saving makes your own copy. You can change it freely, and nothing you do changes {share.fromMe ? 'the original' : `${share.fromName}'s list`}.</p>
          <label className="mt-3 flex items-center gap-2 text-xs font-black bg-white/15 rounded-xl px-3 py-2">
            <input type="checkbox" checked={asEvent} onChange={(e) => setAsEvent(e.target.checked)} className="w-4 h-4 accent-amber-400" />
            Keep it as a yearly Event, so I can start it again next year
          </label>
          <button type="button" onClick={save} disabled={saving} className="mt-3 w-full rounded-2xl bg-white text-[#0b3b57] py-3 text-sm font-black active:scale-[0.98] disabled:opacity-60">{saving ? 'Saving…' : 'Save to my lists'}</button>
          <button type="button" onClick={notNow} className="mt-1 w-full py-2 text-xs font-bold text-white/85 underline underline-offset-2">Not now</button>
          {error && <p className="text-xs font-black bg-rose-600/80 rounded-lg px-2 py-1 mt-2">{error}</p>}
        </div>

        <section className="space-y-2">
          <h2 className="px-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">What is in it</h2>
          {items.map((it, i) => (
            <div key={i} className="bg-white rounded-2xl px-3 py-2.5 flex items-center gap-2.5 shadow-[0_2px_8px_rgba(30,58,95,0.09)]">
              <span className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-[19px] shrink-0">{itemIcon(it.text)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black text-primary truncate">
                  {it.text}
                  {(it.qty != null || it.unit) && <span className="ml-1.5 text-[11px] font-black text-[#0f7a8f] bg-teal-50 rounded-md px-1.5 py-px">{[it.qty != null ? it.qty : '', it.unit || ''].filter((v) => v !== '').join(' ')}</span>}
                </p>
                {(it.store || it.notes) && <p className="text-[10.5px] text-text-muted truncate">{it.store ? `🏪 ${it.store}` : ''}{it.store && it.notes ? ' · ' : ''}{it.notes ? `📝 ${it.notes}` : ''}</p>}
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
