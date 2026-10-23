import React from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { ShareBrandBadge } from './ShareBrandBadge';

// Full-screen announcement modal, driven by a single `app_config/broadcast` doc an admin writes
// via AdminBroadcast.tsx. Whichever user is already in the app when it's sent sees this the
// instant the listener below fires — no push needed; anyone else gets the push notification and
// sees this the next time they open the app, since the same listener re-fires on mount.
//
// "Seen" (`users/{uid}.lastSeenBroadcastId`) is recorded ONLY when the user explicitly taps
// Close — not merely on display. An earlier version marked it seen the moment `shouldShow`
// became true, which could fire from the live Firestore listener while the app was still
// backgrounded (mobile WebViews don't reliably suspend snapshot listeners just because the app
// isn't foregrounded) — so by the time someone actually tapped the push notification to open
// the app, it had already been marked read and silently never appeared. Tying the write to the
// close button means it can only ever be marked seen after a human actually dismissed it.
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

export default function BroadcastBanner() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = React.useState(false);
  const [broadcastDoc] = useDocument(doc(db, 'app_config', 'broadcast'));
  const broadcast = broadcastDoc?.data() as { id?: string; title?: string; message?: string; images?: string[]; imageLinks?: string[] } | undefined;

  const shouldShow =
    !!broadcast?.id && !!profile && profile.lastSeenBroadcastId !== broadcast.id && !dismissed;

  const handleClose = () => {
    setDismissed(true);
    if (user && broadcast?.id) {
      // updateDoc, not setDoc(...,{merge:true}) — this banner is mounted globally and can be
      // dismissed within moments of a brand-new account's very first sign-in (it renders above
      // even ProfileSetupWizard, z-[280] vs z-[260], so a new user often sees and closes it before
      // anything else). A merge-write reaching Firestore before the account's own creation logic
      // (Login.tsx's createOrUpdateUserRecords / AuthContext.tsx's syncProfile) would CREATE the
      // user doc with only this one field, silently skipping `hasSeenOnboarding: false`/
      // `hasCompletedProfileSetup: false` forever — see those two files' matching comments for the
      // full reasoning. updateDoc can only touch an EXISTING doc, so on that exact race this just
      // fails harmlessly (caught below); the broadcast re-shows and marks itself seen normally on
      // the very next render once the real doc exists.
      updateDoc(doc(db, 'users', user.uid), { lastSeenBroadcastId: broadcast.id }).catch((err) =>
        console.error('Failed to record broadcast as seen:', err),
      );
    }
  };

  const openLink = (rawUrl: string) => {
    const url = rawUrl.replace(/[.,;:!?)]+$/, '');
    try {
      const u = new URL(url);
      if (u.hostname === OWN_HOST) {
        handleClose();
        navigate(`${u.pathname}${u.search}`);
        return;
      }
    } catch {
      /* not a valid address: just try to open it */
    }
    window.open(url, '_blank');
  };

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
  const messageUrls = ((broadcast?.message || '').match(URL_PATTERN) || []).map((u) => u.replace(/[.,;:!?)]+$/, ''));
  const instagramUrl = messageUrls.find((u) => u.includes('instagram.com'));
  const facebookUrl = messageUrls.find((u) => u.includes('facebook.com'));

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[280] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        >
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
              <h2 className="text-base font-black text-primary min-w-0 break-words">{broadcast?.title || 'FamilyLedger'}</h2>
            </div>

            <div className="overflow-y-auto flex-1 px-5 space-y-4">
              <p className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed">{renderMessage(broadcast?.message || '')}</p>
              {broadcast?.images && broadcast.images.length > 0 && (
                <div className="space-y-3">
                  {broadcast.images.map((src, idx) => {
                    const link = broadcast.imageLinks?.[idx];
                    const picture = <img src={src} alt="" className="w-full rounded-2xl border border-border-subtle object-cover" />;
                    // a picture with a link opens it when tapped
                    return link ? (
                      <button key={idx} type="button" onClick={() => openLink(link)} className="block w-full active:scale-[0.99] transition-transform">
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
                    <button type="button" onClick={() => openLink(instagramUrl)} className="py-3 rounded-2xl text-white font-black text-sm flex items-center justify-center gap-2 active:scale-95" style={{ background: 'linear-gradient(45deg,#FA7E1E,#D62976,#962FBF,#4F5BD5)' }}>
                      <span className="[&_svg]:fill-white [&_path]:!fill-white"><ShareBrandBadge platform="instagram" /></span>
                      Follow
                    </button>
                  )}
                  {facebookUrl && (
                    <button type="button" onClick={() => openLink(facebookUrl)} className="py-3 rounded-2xl bg-[#1877F2] text-white font-black text-sm flex items-center justify-center gap-2 active:scale-95">
                      <span className="[&_path]:!fill-white"><ShareBrandBadge platform="facebook" /></span>
                      Follow
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="p-5 pt-4 shrink-0">
              <button
                onClick={handleClose}
                className="w-full py-3.5 bg-primary text-white rounded-2xl font-bold active:scale-[0.98] transition-all"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
