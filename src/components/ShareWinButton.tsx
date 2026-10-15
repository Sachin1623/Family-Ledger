import React, { useState } from 'react';
import { renderWinCard, WinCardOptions } from '../lib/winShareImage';
import { shareOrDownloadFile } from '../lib/fileShare';
import { useAuth } from '../context/AuthContext';

// One-tap "boast about this win": draws the brag card on the fly, then hands it to the phone's own
// share sheet (WhatsApp / Instagram / Facebook / anything installed) together with a ready-made
// caption. Falls back to a plain image download where there is no share sheet (desktop browsers).
export default function ShareWinButton({
  card,
  caption,
  className,
}: {
  card: WinCardOptions;
  caption: string;
  className?: string;
}) {
  const { user, profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleShare = async () => {
    setBusy(true);
    setError(null);
    try {
      // The person tapping Share is the winner — their own profile picture goes big on the card.
      const blob = await renderWinCard({ ...card, winnerPhotoURL: card.winnerPhotoURL ?? (profile?.photoURL || user?.photoURL || undefined) });
      const slug = card.gameName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await shareOrDownloadFile(blob, `familyledger-${slug}-win.png`, 'image/png', caption);
    } catch (err: any) {
      console.error('Share win failed:', err);
      setError(err?.message || 'Could not create the image.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <button
        onClick={handleShare}
        disabled={busy}
        className="w-full py-2.5 bg-gradient-to-r from-amber-400 to-orange-500 text-white font-black rounded-2xl text-sm shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-[18px]">ios_share</span>
        {busy ? 'Creating your post…' : 'Share my win'}
      </button>
      {error && <p className="text-xs font-bold text-error mt-1 text-center">{error}</p>}
    </div>
  );
}
