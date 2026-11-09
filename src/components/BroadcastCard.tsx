import React from 'react';
import { motion } from 'motion/react';
import { ShareBrandBadge } from './ShareBrandBadge';
import BroadcastVideo from './BroadcastVideo';
import BroadcastReactions from './BroadcastReactions';
import BroadcastShare from './BroadcastShare';
import type { BroadcastVia } from '../lib/broadcastTrack';

// The broadcast window itself (title, message, video, pictures, follow buttons, Close). Shared by
// BroadcastBanner (the automatic popup) and BroadcastReplay (watch again), so both look identical.
export type BroadcastContent = {
  id?: string;
  title?: string;
  message?: string;
  images?: string[];
  imageLinks?: string[];
  videoId?: string | null;
  videoShort?: boolean;
};

// Web addresses in a broadcast message become tappable. A link to this app's own address opens that page inside the app (for example
// /feedback); any other link opens outside it. (Always from a button with window.open: a bare link tag does nothing in the Android app.)
const URL_PATTERN = /(https?:\/\/[^\s]+)/g;
const OWN_HOST = 'familyledger.thirteenapps.com';

function friendlyLabel(url: string): string {
  if (url.includes('instagram.com')) return 'Instagram: @family.ledger';
  if (url.includes('facebook.com')) return 'Facebook: Family Ledger';
  if (url.includes('play.google.com')) return 'Rate us on Google Play';
  if (url.includes(OWN_HOST) && url.includes('/feedback')) return 'Send us your feedback';
  return url.replace(/^https?:\/\/(www\.)?/, '');
}

export default function BroadcastCard({ broadcast, onClose, openLink, closeLabel = 'Close', navigation, test = false, reactAfterClose = false }: {
  broadcast: BroadcastContent;
  onClose: () => void;
  openLink: (url: string, via?: BroadcastVia) => void;
  closeLabel?: string;
  /** Previous / Next row, shown above the Close button (the watch-again window uses it). */
  navigation?: React.ReactNode;
  /** A test send: marked as such, and reactions are not counted. */
  test?: boolean;
  /** The popup: pressing Close first asks how the person feels about this update, and the card closes once they have reacted (or skipped). */
  reactAfterClose?: boolean;
}) {
  const [step, setStep] = React.useState<'read' | 'react'>('read');
  const askFirst = reactAfterClose && !!broadcast.id;
  const handleCloseButton = () => (askFirst ? setStep('react') : onClose());
  // The message with its links turned into tappable text.
  const renderMessage = (text: string) =>
    text.split(URL_PATTERN).map((part, i) => {
      if (!/^https?:\/\//.test(part)) return <React.Fragment key={i}>{part}</React.Fragment>;
      const url = part.replace(/[.,;:!?)]+$/, '');
      const trailing = part.slice(url.length);
      return (
        <React.Fragment key={i}>
          <button type="button" onClick={() => openLink(url)} className="text-primary font-bold underline underline-offset-2 text-left break-all">
            {friendlyLabel(url)}
          </button>
          {trailing}
        </React.Fragment>
      );
    });

  // Big Follow buttons when the message links to our pages.
  const messageUrls = ((broadcast.message || '').match(URL_PATTERN) || []).map((u) => u.replace(/[.,;:!?)]+$/, ''));
  const instagramUrl = messageUrls.find((u) => u.includes('instagram.com'));
  const facebookUrl = messageUrls.find((u) => u.includes('facebook.com'));

  // Step two of the popup: the same title, quoted, so it is plain that the reaction is to this message.
  if (askFirst && step === 'react') {
    const gist = (broadcast.message || '').replace(URL_PATTERN, '').replace(/\s+/g, ' ').trim();
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="p-5 space-y-4">
          <div className="text-center space-y-1">
            <p className="text-[11px] font-black uppercase tracking-wider text-text-muted">You just read this update</p>
            <h2 className="text-lg font-black text-primary break-words">{broadcast.title || 'FamilyLedger'}</h2>
            {gist && <p className="text-xs text-text-muted line-clamp-2 break-words">{gist}</p>}
          </div>
          <p className="text-center text-base font-black text-on-surface">How do you feel about this update?</p>
          <BroadcastReactions broadcastId={broadcast.id!} preview={test} large onPicked={onClose} />
          <button type="button" onClick={onClose} className="w-full py-2 text-sm font-bold text-text-muted underline underline-offset-2 active:opacity-60">Skip</button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 20 }}
      className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
    >
      <div className="flex items-center gap-3 p-5 pb-3 shrink-0">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
          <span className="material-symbols-outlined">campaign</span>
        </div>
        <h2 className="text-base font-black text-primary min-w-0 break-words">{broadcast.title || 'FamilyLedger'}</h2>
        {test && <span className="shrink-0 ml-auto rounded-full bg-amber-100 text-amber-800 text-[10px] font-black uppercase tracking-wider px-2 py-1">Test</span>}
      </div>

      <div className="overflow-y-auto flex-1 px-5 space-y-4">
        <p className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed">{renderMessage(broadcast.message || '')}</p>
        {/* a YouTube video plays right here, with its own full-screen view */}
        {broadcast.videoId && /^[A-Za-z0-9_-]{11}$/.test(broadcast.videoId) && (
          <React.Fragment key={broadcast.videoId}>
            <BroadcastVideo
              videoId={broadcast.videoId}
              short={!!broadcast.videoShort}
              onOpenYouTube={() => openLink(`https://www.youtube.com/watch?v=${broadcast.videoId}`, 'button')}
            />
          </React.Fragment>
        )}
        {broadcast.images && broadcast.images.length > 0 && (
          <div className="space-y-3">
            {broadcast.images.map((src, idx) => {
              const link = broadcast.imageLinks?.[idx];
              const picture = <img src={src} alt="" className="w-full rounded-2xl border border-border-subtle object-cover" />;
              // a picture with a link opens it when tapped
              return link ? (
                <button key={idx} type="button" onClick={() => openLink(link, 'image')} className="block w-full active:scale-[0.99] transition-transform">
                  {picture}
                </button>
              ) : (
                <React.Fragment key={idx}>{picture}</React.Fragment>
              );
            })}
          </div>
        )}
        {(instagramUrl || facebookUrl) && (
          <div className="grid grid-cols-2 gap-2 pb-1">
            {instagramUrl && (
              <button type="button" onClick={() => openLink(instagramUrl, 'button')} className="py-3 rounded-2xl text-white font-black text-sm flex items-center justify-center gap-2 active:scale-95" style={{ background: 'linear-gradient(45deg,#FA7E1E,#D62976,#962FBF,#4F5BD5)' }}>
                <span className="[&_svg]:fill-white [&_path]:!fill-white"><ShareBrandBadge platform="instagram" /></span>
                Follow
              </button>
            )}
            {facebookUrl && (
              <button type="button" onClick={() => openLink(facebookUrl, 'button')} className="py-3 rounded-2xl bg-[#1877F2] text-white font-black text-sm flex items-center justify-center gap-2 active:scale-95">
                <span className="[&_path]:!fill-white"><ShareBrandBadge platform="facebook" /></span>
                Follow
              </button>
            )}
          </div>
        )}
      </div>

      <div className="p-5 pt-4 shrink-0 space-y-3">
        {broadcast.id && !askFirst && <BroadcastReactions broadcastId={broadcast.id} preview={test} />}
        <BroadcastShare broadcast={broadcast} />
        {navigation}
        <button
          onClick={handleCloseButton}
          className="w-full py-3.5 bg-primary text-white rounded-2xl font-bold active:scale-[0.98] transition-all"
        >
          {closeLabel}
        </button>
      </div>
    </motion.div>
  );
}

export { OWN_HOST };
