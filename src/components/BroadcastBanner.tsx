import React from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import BroadcastCard, { OWN_HOST } from './BroadcastCard';
import { targetOf, trackBroadcast, type BroadcastVia } from '../lib/broadcastTrack';

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
export default function BroadcastBanner() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = React.useState(false);
  const [broadcastDoc] = useDocument(doc(db, 'app_config', 'broadcast'));
  const broadcast = broadcastDoc?.data() as { id?: string; title?: string; message?: string; images?: string[]; imageLinks?: string[]; videoId?: string; videoShort?: boolean } | undefined;

  const shouldShow =
    !!broadcast?.id && !!profile && profile.lastSeenBroadcastId !== broadcast.id && !dismissed;

  // reported once per broadcast and phone: it was shown
  const viewedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (shouldShow && broadcast?.id && viewedRef.current !== broadcast.id) {
      viewedRef.current = broadcast.id;
      trackBroadcast(broadcast.id, 'view');
    }
  }, [shouldShow, broadcast?.id]);

  const handleClose = () => {
    if (broadcast?.id) trackBroadcast(broadcast.id, 'close');
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

  const openLink = (rawUrl: string, via: BroadcastVia = 'link') => {
    const url = rawUrl.replace(/[.,;:!?)]+$/, '');
    if (broadcast?.id) trackBroadcast(broadcast.id, 'click', { target: targetOf(url), via });
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

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[280] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <BroadcastCard broadcast={broadcast || {}} onClose={handleClose} openLink={openLink} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
