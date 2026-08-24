import React from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'motion/react';

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
  const [dismissed, setDismissed] = React.useState(false);
  const [broadcastDoc] = useDocument(doc(db, 'app_config', 'broadcast'));
  const broadcast = broadcastDoc?.data() as { id?: string; title?: string; message?: string; images?: string[] } | undefined;

  const shouldShow =
    !!broadcast?.id && !!profile && profile.lastSeenBroadcastId !== broadcast.id && !dismissed;

  const handleClose = () => {
    setDismissed(true);
    if (user && broadcast?.id) {
      setDoc(doc(db, 'users', user.uid), { lastSeenBroadcastId: broadcast.id }, { merge: true }).catch((err) =>
        console.error('Failed to record broadcast as seen:', err),
      );
    }
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
              <p className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed">{broadcast?.message}</p>
              {broadcast?.images && broadcast.images.length > 0 && (
                <div className="space-y-3">
                  {broadcast.images.map((src, idx) => (
                    <img key={idx} src={src} alt="" className="w-full rounded-2xl border border-border-subtle object-cover" />
                  ))}
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
