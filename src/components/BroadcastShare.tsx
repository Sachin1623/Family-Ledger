import React, { useState } from 'react';
import { buildShareMessages, type ShareTarget } from '../lib/spreadTheWord';
import { shareOrDownloadFile, shareText } from '../lib/fileShare';
import ShareAppButtons from './ShareAppButtons';
import type { BroadcastContent } from './BroadcastCard';

// "Share this update": the same share block as Spread the Word (the phone's share sheet, WhatsApp, Facebook, Instagram, X, LinkedIn), but what goes
// out is this broadcast: its title and message, then the app link. Closed until asked for, so the card stays short.
export default function BroadcastShare({ broadcast }: { broadcast: BroadcastContent }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const { shareUrl, webShareUrl } = buildShareMessages();
  const title = broadcast.title || 'FamilyLedger';
  const body = (broadcast.message || '').trim();
  // the video, when the broadcast has one, goes out as its own link
  const videoId = broadcast.videoId && /^[A-Za-z0-9_-]{11}$/.test(broadcast.videoId) ? broadcast.videoId : null;
  const videoUrl = videoId ? (broadcast.videoShort ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`) : null;
  const long = `*${title}*\n\n${body}${videoUrl ? `\n\n▶️ Watch: ${videoUrl}` : ''}\n\n👉 FamilyLedger: ${shareUrl}`;
  const short = `${title}: ${body}`.slice(0, 160).trimEnd() + `${(title + body).length > 150 ? '…' : ''}${videoUrl ? `\n▶️ ${videoUrl}` : ''}\n${shareUrl}`;
  // Facebook and LinkedIn share a page address, not text: the video page when there is one, so the post shows the video
  const pageUrl = videoUrl || webShareUrl;

  const firstImage = broadcast.images?.[0];
  const imageBlob = async (): Promise<Blob | null> => {
    if (!firstImage) return null;
    try { return await (await fetch(firstImage)).blob(); } catch { return null; }
  };

  const onShare = async (target: ShareTarget) => {
    setNote(null);
    if (target === 'native') {
      const blob = await imageBlob();
      if (blob) { await shareOrDownloadFile(blob, 'familyledger-update.jpg', blob.type || 'image/jpeg', long); return; }
      const r = await shareText(title, long);
      if (r === 'copied') setNote('Message copied. Paste it wherever you like.');
      return;
    }
    if (target === 'whatsapp') { window.open(`https://wa.me/?text=${encodeURIComponent(long)}`, '_blank'); return; }
    if (target === 'facebook') { window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}&quote=${encodeURIComponent(`${title}: ${body}`.slice(0, 300))}`, '_blank'); return; }
    if (target === 'twitter') { window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(short)}`, '_blank'); return; }
    if (target === 'linkedin') { window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`, '_blank'); return; }
    // Instagram has no share link: the text is copied to paste into a post
    navigator.clipboard?.writeText(long).catch(() => {});
    setNote('Caption copied. Open Instagram and paste it into your post.');
  };

  const onCopy = () => {
    navigator.clipboard?.writeText(long).then(() => setNote('Message and link copied.')).catch(() => setNote('Could not copy on this phone.'));
  };

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-center gap-1.5 text-xs font-black text-primary py-1 active:opacity-60">
        <span className="material-symbols-outlined text-[18px]">{open ? 'expand_less' : 'share'}</span>
        {open ? 'Hide sharing' : 'Share this update'}
      </button>
      {open && (
        <div className="pt-2">
          <ShareAppButtons onShare={onShare} onLinkOnly={onCopy} primaryLabel="Share" note={note} linkOnlyLabel="Just copy the message & link" />
        </div>
      )}
    </div>
  );
}
