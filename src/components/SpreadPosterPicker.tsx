import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { renderAllSpreadCards, SpreadPoster, SpreadVariantId } from '../lib/spreadCardImage';

// "Pick a poster to share": every time it opens it draws a fresh set of themed posters (each with
// 4–6 features, the logo and a Play Store QR code) and lets the person choose the one that fits who
// they're sending it to. Choosing hands the picture back to the caller, which does the sharing.
export default function SpreadPosterPicker({
  open,
  onClose,
  onShare,
}: {
  open: boolean;
  onClose: () => void;
  onShare: (blob: Blob, id: SpreadVariantId) => void | Promise<void>;
}) {
  const [posters, setPosters] = useState<SpreadPoster[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<SpreadVariantId | null>(null);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const created: string[] = [];
    setLoading(true);
    setError(null);
    setPosters([]);
    setUrls({});
    setSelected(null);
    renderAllSpreadCards()
      .then((set) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        set.forEach((p) => {
          const u = URL.createObjectURL(p.blob);
          created.push(u);
          map[p.id] = u;
        });
        setPosters(set);
        setUrls(map);
        setSelected(set[0]?.id ?? null);
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
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [open]);

  const handleShare = async () => {
    const poster = posters.find((p) => p.id === selected);
    if (!poster) return;
    setSharing(true);
    try {
      await onShare(poster.blob, poster.id);
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
                <h2 className="text-base font-black text-primary">Pick a poster to share</h2>
                <p className="text-[11px] text-text-muted">Fresh posters, made just now — tap the one you like.</p>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-surface rounded-full shrink-0" aria-label="Close">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loading && <p className="text-center text-sm text-text-muted py-10">Creating your posters…</p>}
              {error && <p className="text-center text-sm font-bold text-error py-10">{error}</p>}
              <div className="grid grid-cols-2 gap-3">
                {posters.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                    className={clsx(
                      'relative rounded-xl overflow-hidden border-2 text-left transition-all active:scale-[0.98]',
                      selected === p.id ? 'border-primary ring-4 ring-primary/20' : 'border-transparent',
                    )}
                  >
                    <img src={urls[p.id]} alt={`${p.label} poster`} className="w-full block" />
                    <span className="absolute left-1.5 top-1.5 bg-black/55 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                      {p.emoji} {p.label}
                    </span>
                    {selected === p.id && (
                      <span className="absolute right-1.5 top-1.5 bg-primary text-white rounded-full w-5 h-5 flex items-center justify-center">
                        <span className="material-symbols-outlined text-[14px]">check</span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-border-subtle shrink-0">
              <button
                onClick={handleShare}
                disabled={!selected || sharing}
                className="w-full py-3 bg-primary text-white font-bold rounded-2xl text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">ios_share</span>
                {sharing ? 'Opening share…' : 'Share this poster'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
