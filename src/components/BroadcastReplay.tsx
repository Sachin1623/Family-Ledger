import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../lib/firebase';
import BroadcastCard, { OWN_HOST, type BroadcastContent } from './BroadcastCard';
import { targetOf, trackBroadcast, type BroadcastVia } from '../lib/broadcastTrack';

// "Watch again": the last 10 broadcasts (newest first), one at a time, with Previous / Next to step
// through them. Opened from the header's play button (Home) or the menu entry. It never touches
// `lastSeenBroadcastId`, so it can't make the automatic popup reappear or disappear.
type Item = BroadcastContent & { id: string; sentAt?: string };

async function authedGet(path: string): Promise<any> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('not signed in');
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function niceDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function BroadcastReplay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [idx, setIdx] = React.useState(0);
  // full copies (with pictures) fetched per broadcast the first time it is shown
  const [full, setFull] = React.useState<Record<string, Item>>({});

  // the list is loaded fresh every time the window opens (a new broadcast may have been sent since)
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null); setFailed(false); setIdx(0); setFull({});
    authedGet('/api/broadcasts/recent')
      .then((r) => { if (!cancelled) setItems(r.broadcasts || []); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open]);

  const current = items && items[idx];
  const currentId = current?.id;
  React.useEffect(() => {
    if (!open || !currentId) return;
    trackBroadcast(currentId, 'replay');
    if (full[currentId]) return;
    let cancelled = false;
    authedGet(`/api/broadcasts/${encodeURIComponent(currentId)}`)
      .then((r) => { if (!cancelled) setFull((f) => ({ ...f, [currentId]: r })); })
      .catch(() => { /* the list copy (text and video) is still shown */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentId]);

  const openLink = (rawUrl: string, via: BroadcastVia = 'link') => {
    const url = rawUrl.replace(/[.,;:!?)]+$/, '');
    if (currentId) trackBroadcast(currentId, 'click', { target: targetOf(url), via });
    try {
      const u = new URL(url);
      if (u.hostname === OWN_HOST) {
        onClose();
        navigate(`${u.pathname}${u.search}`);
        return;
      }
    } catch {
      /* not a valid address: just try to open it */
    }
    window.open(url, '_blank');
  };

  const total = items?.length || 0;
  const shown: Item | null = current ? { ...current, ...(full[current.id] || {}) } : null;

  const navButton = (label: string, icon: string, disabled: boolean, onClick: () => void, iconFirst: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex-1 py-2.5 rounded-2xl border border-border-subtle text-primary font-bold text-sm flex items-center justify-center gap-1 disabled:opacity-35 active:scale-95 transition-all"
    >
      {iconFirst && <span className="material-symbols-outlined text-[20px]">{icon}</span>}
      {label}
      {!iconFirst && <span className="material-symbols-outlined text-[20px]">{icon}</span>}
    </button>
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          // below the automatic popup (z-[280]) but above the bottom bar and every sheet
          className="fixed inset-0 z-[270] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div className="w-full max-w-md flex justify-center" onClick={(e) => e.stopPropagation()}>
            {shown ? (
              <BroadcastCard
                broadcast={shown}
                onClose={onClose}
                openLink={openLink}
                navigation={total > 1 && (
                  <div className="flex items-center gap-2">
                    {navButton('Previous', 'chevron_left', idx === 0, () => setIdx((i) => Math.max(0, i - 1)), true)}
                    <div className="shrink-0 text-center leading-tight min-w-[64px]">
                      <div className="text-xs font-black text-primary">{idx + 1} of {total}</div>
                      <div className="text-[10px] text-text-muted">{niceDate(shown.sentAt)}</div>
                    </div>
                    {navButton('Next', 'chevron_right', idx >= total - 1, () => setIdx((i) => Math.min(total - 1, i + 1)), false)}
                  </div>
                )}
              />
            ) : (
              <div className="bg-white rounded-3xl shadow-2xl w-full p-6 text-center space-y-3">
                {failed ? (
                  <>
                    <p className="text-sm text-on-surface">Couldn't load the updates. Check your connection and try again.</p>
                    <button onClick={onClose} className="w-full py-3 bg-primary text-white rounded-2xl font-bold">Close</button>
                  </>
                ) : items && items.length === 0 ? (
                  <>
                    <p className="text-sm text-on-surface">There are no updates to watch yet.</p>
                    <button onClick={onClose} className="w-full py-3 bg-primary text-white rounded-2xl font-bold">Close</button>
                  </>
                ) : (
                  <p className="text-sm text-text-muted py-4">Loading…</p>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
