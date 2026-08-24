import React from 'react';

// "1-click join" via WhatsApp, sitting next to each multiplayer game's "Copy code" button —
// shares the game's direct URL (not just the bare code), so tapping the WhatsApp link on the
// recipient's end takes them straight to this game's waiting room (App Links open the app
// directly if installed; falls back to the web build otherwise) with a "Join Game" button already
// showing, rather than making them retype a code by hand. Fires via `window.open()` on a button
// click, NOT an `<a href target="_blank">` — the Capacitor Android WebView silently swallows
// anchor-triggered external navigation, but `window.open()` is the pattern ManageGroup.tsx/shop.ts
// already use successfully for their own wa.me links.
export default function ShareGameButton({
  gameLabel,
  code,
  path,
  className,
}: {
  gameLabel: string;
  code: string;
  path: string;
  className?: string;
}) {
  const handleShare = () => {
    const link = `${window.location.origin}${path}`;
    const message = `Join my ${gameLabel} game on FamilyLedger! Code: ${code}\n${link}`;
    const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label="Share game via WhatsApp"
      className={className || 'px-4 py-2 bg-[#25D366] text-white rounded-xl text-xs font-bold flex items-center gap-1'}
    >
      <span className="material-symbols-outlined text-[16px]">chat</span>
      WhatsApp
    </button>
  );
}
