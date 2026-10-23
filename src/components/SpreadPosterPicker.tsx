import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import type { SpreadPoster, SpreadVariantId } from '../lib/spreadCardImage';
import { loadSpreadPosters, peekSpreadPosters, ensurePng } from '../lib/spreadPosterCache';

// "Pick a poster to share": every time it opens it draws a fresh set of themed posters (each with
// 4–6 features, the logo and a Play Store QR code) and lets the person choose the one that fits who
// they're sending it to. Like the weekly recap, every poster starts selected; tap one to leave it out. Sharing hands the chosen
// pictures back to the caller, which does the sharing.
export default function SpreadPosterPicker({
  open,
  onClose,
  onShare,
}: {
  open: boolean;
  onClose: () => void;
  onShare: (items: { blob: Blob; id: SpreadVariantId }[]) => void | Promise<void>;
}) {
  const [posters, setPosters] = useState<SpreadPoster[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<SpreadVariantId[]>([]);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The posters are drawn in the background when Profile opens (see spreadPosterCache.ts), so this
  // usually shows them instantly; it only draws on the spot if that hasn't finished yet.
  const apply = (set: { posters: SpreadPoster[]; urls: Record<string, string> }) => {
    setPosters(set.posters);
    setUrls(set.urls);
    setSelected(set.posters.map((p) => p.id)); // every poster starts selected
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    const ready = peekSpreadPosters();
    if (ready) {
      apply(ready);
      return;
    }
    setLoading(true);
    loadSpreadPosters()
      .then((set) => {
        if (!cancelled) apply(set);
      })
      .catch((err) => {
        console.error('Poster generation failed:', err);
        if (!cancelled) setError('Could not create the posters on this device. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Redraws a fresh set (new taglines) on request.
  const shuffle = async () => {
    setLoading(true);
    setError(null);
    try {
      apply(await loadSpreadPosters(true));
    } catch (err) {
      console.error('Poster shuffle failed:', err);
      setError('Could not create new posters. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleShare = async () => {
    const chosen = posters.filter((p) => selected.includes(p.id));
    if (chosen.length === 0) return;
    setSharing(true);
    try {
      await onShare(await Promise.all(chosen.map(async (p) => ({ blob: await ensurePng(p.blob), id: p.id }))));
    } finally {
      setSharing(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" onClick={onClose}>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden"
          >
            <div className="p-4 border-b border-border-subtle flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-base font-black text-primary">Pick posters to share</h2>
                <p className="text-[11px] text-text-muted">{selected.length === 0 ? 'None selected' : `${selected.length} selected`}. All are ready: tap one to leave it out, or shuffle for more.</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={shuffle} disabled={loading} className="p-2 hover:bg-surface rounded-full disabled:opacity-40" aria-label="Shuffle posters">
                  <span className="material-symbols-outlined">shuffle</span>
                </button>
                <button onClick={onClose} className="p-2 hover:bg-surface rounded-full" aria-label="Close">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loading && <p className="text-center text-sm text-text-muted py-10">Creating your posters…</p>}
              {error && <p className="text-center text-sm font-bold text-error py-10">{error}</p>}
              <div className="grid grid-cols-2 gap-3">
                {posters.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelected((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                    className={clsx(
                      'relative rounded-xl overflow-hidden border-2 text-left transition-all active:scale-[0.98]',
                      selected.includes(p.id) ? 'border-primary ring-4 ring-primary/20' : 'border-transparent',
                    )}
                  >
                    <img src={urls[p.id]} alt={`${p.label} poster`} className="w-full block" />
                    <span className="absolute left-1.5 top-1.5 bg-black/55 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                      {p.emoji} {p.label}
                    </span>
                    <span className={clsx('absolute right-1.5 top-1.5 rounded-full w-6 h-6 flex items-center justify-center shadow', selected.includes(p.id) ? 'bg-primary text-white' : 'bg-white/90 text-text-muted border border-border-subtle')}>
                      <span className="material-symbols-outlined text-[16px]">{selected.includes(p.id) ? 'check' : 'add'}</span>
                    </span>
                    {selected.includes(p.id) && <span className="absolute bottom-0 inset-x-0 bg-primary text-white text-[10px] font-black py-0.5 text-center">Selected to share</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-border-subtle shrink-0">
              <button
                onClick={handleShare}
                disabled={selected.length === 0 || sharing}
                className="w-full py-3 bg-primary text-white font-bold rounded-2xl text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">ios_share</span>
                {sharing ? 'Opening share…' : selected.length > 1 ? `Share ${selected.length} posters` : 'Share this poster'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
