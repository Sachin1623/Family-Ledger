import React, { useEffect, useState } from 'react';
import { ShareBrandBadge } from './ShareBrandBadge';
import type { ShareTarget } from '../lib/spreadTheWord';

// The one share block used everywhere the app asks someone to spread the word (the Profile card, the Weekly Recap...):
// a primary "Share" button for the phone's own share sheet, a brand button for each app, an optional note, and a
// "just copy the message & link" link. Each screen supplies what actually gets shared.
export default function ShareAppButtons({
  onShare,
  onLinkOnly,
  primaryLabel,
  primaryIcon = 'share',
  linkOnlyLabel = 'Just copy the message & link',
  note,
  oneByOne,
}: {
  onShare: (target: ShareTarget) => void;
  onLinkOnly: () => void;
  primaryLabel: string;
  primaryIcon?: string;
  linkOnlyLabel?: string;
  note?: string | null;
  // WhatsApp Status (Stories) takes only ONE picture from a share, however many are sent. When several pictures are chosen this adds a
  // "send them one at a time" helper: each tap opens WhatsApp with the next picture. `send` shares picture number `index` (0-based).
  oneByOne?: { count: number; send: (index: number) => Promise<boolean> };
}) {
  const [next, setNext] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => setNext(0), [oneByOne?.count]);
  const stepsLeft = oneByOne ? oneByOne.count - next : 0;
  return (
    <div className="space-y-3">
      <button
        onClick={() => onShare('native')}
        className="w-full bg-primary text-white py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm"
      >
        <span className="material-symbols-outlined text-[18px]">{primaryIcon}</span>
        <span>{primaryLabel}</span>
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onShare('whatsapp')}
          className="bg-[#25D366]/10 text-[#128C4A] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#25D366]/20 active:scale-[0.98] transition-all border border-[#25D366]/20"
        >
          <ShareBrandBadge platform="whatsapp" />
          WhatsApp
        </button>
        <button
          onClick={() => onShare('facebook')}
          className="bg-[#1877F2]/10 text-[#1877F2] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#1877F2]/20 active:scale-[0.98] transition-all border border-[#1877F2]/20"
        >
          <ShareBrandBadge platform="facebook" />
          Facebook
        </button>
        <button
          onClick={() => onShare('instagram')}
          className="bg-[#D62976]/10 text-[#B01E5E] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#D62976]/20 active:scale-[0.98] transition-all border border-[#D62976]/20"
        >
          <ShareBrandBadge platform="instagram" />
          Instagram
        </button>
        <button
          onClick={() => onShare('twitter')}
          className="bg-[#0F1419]/10 text-[#0F1419] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#0F1419]/20 active:scale-[0.98] transition-all border border-[#0F1419]/20"
        >
          <ShareBrandBadge platform="x" />
          X
        </button>
        <button
          onClick={() => onShare('linkedin')}
          className="col-span-2 bg-[#0A66C2]/10 text-[#0A66C2] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#0A66C2]/20 active:scale-[0.98] transition-all border border-[#0A66C2]/20"
        >
          <ShareBrandBadge platform="linkedin" />
          LinkedIn
        </button>
      </div>
      {oneByOne && oneByOne.count > 1 && (
        <div className="rounded-xl border border-[#25D366]/40 bg-[#25D366]/5 p-3 space-y-2">
          <p className="text-[11px] text-text-muted leading-snug">
            <span className="font-black text-[#128C4A]">Posting to WhatsApp Status?</span> Status takes one picture at a time. Send them one by one, then come back here for the next.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (stepsLeft <= 0) { setNext(0); return; }
                if (await oneByOne.send(next)) setNext((n) => n + 1);
              } finally {
                setBusy(false);
              }
            }}
            className="w-full bg-[#25D366] text-white py-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60"
          >
            <ShareBrandBadge platform="whatsapp" />
            {stepsLeft > 0 ? `Send picture ${next + 1} of ${oneByOne.count} to WhatsApp` : 'All sent. Tap to start again'}
          </button>
        </div>
      )}
      {note && <p className="text-[11px] font-bold text-primary bg-primary/5 rounded-lg px-2.5 py-1.5">{note}</p>}
      <button onClick={onLinkOnly} className="w-full text-center text-[11px] font-bold text-primary underline underline-offset-2">
        {linkOnlyLabel}
      </button>
    </div>
  );
}
