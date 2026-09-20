import React from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'motion/react';
import { buildShareMessages, shareAppPlain, ShareTarget } from '../lib/spreadTheWord';
import { logGrowthEvent } from '../lib/growthEvents';
import { ShareBrandBadge } from './ShareBrandBadge';

// Global "Spread the Word" popup, driven by a single `app_config/spreadWordPrompt` doc an admin
// writes via AdminBroadcast.tsx's "Send Now" button — same mechanism as BroadcastBanner.tsx/
// `app_config/broadcast`: whoever's already in the app sees this the instant the listener below
// fires, no push needed; anyone else gets the push (`spread_word_broadcast`, see
// pushNotifications.ts) and sees this the next time they open the app, since the listener
// re-fires on mount. Mounted at the app root (see App.tsx), so it can show over ANY screen, not
// just Profile — the admin's whole point is a single tap reaching everyone right where they are.
//
// Text-only sharing (via shareAppPlain) — deliberately skips Profile.tsx's image-banner capture
// (shareViaOsSheetWithBanner), which needs an off-screen <ShareBanner> mounted; doing that
// globally on every screen would be real weight for a feature only Profile.tsx's own card needs.
//
// "Seen" (`users/{uid}.lastSeenSpreadWordPromptId`) follows BroadcastBanner's same reasoning:
// recorded only on an explicit dismiss/share action, never merely on display, so a background
// snapshot-listener firing can't silently mark it read before a human ever saw it.
export default function SpreadWordPrompt() {
  const { user, profile } = useAuth();
  const [dismissed, setDismissed] = React.useState(false);
  const [promptDoc] = useDocument(doc(db, 'app_config', 'spreadWordPrompt'));
  const prompt = promptDoc?.data() as { id?: string; createdAt?: string } | undefined;

  const shouldShow =
    !!prompt?.id && !!profile && profile.lastSeenSpreadWordPromptId !== prompt.id && !dismissed;

  const markSeen = () => {
    setDismissed(true);
    if (user && prompt?.id) {
      updateDoc(doc(db, 'users', user.uid), { lastSeenSpreadWordPromptId: prompt.id }).catch((err) =>
        console.error('Failed to record spread-word prompt as seen:', err),
      );
    }
  };

  const handleShare = (target: ShareTarget) => {
    shareAppPlain(target, user?.uid);
    markSeen();
  };

  const handleLinkOnly = () => {
    const { message } = buildShareMessages();
    navigator.clipboard?.writeText(message).catch(() => {});
    logGrowthEvent('share_link_only', user?.uid);
    markSeen();
  };

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[278] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 p-5 pb-3 shrink-0">
              <span className="text-2xl leading-none">❤️</span>
              <div className="min-w-0">
                <h2 className="text-base font-black text-primary">Spread the Word</h2>
                <p className="text-xs text-text-muted">Know someone who'd love FamilyLedger?</p>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 px-5 space-y-4">
              <p className="text-sm text-on-surface leading-relaxed">
                Share it with family or friends who split expenses, track budgets, or save toward
                goals — a quick share goes a long way.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleShare('whatsapp')}
                  className="bg-[#25D366]/10 text-[#128C4A] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#25D366]/20 active:scale-[0.98] transition-all border border-[#25D366]/20"
                >
                  <ShareBrandBadge platform="whatsapp" />
                  WhatsApp
                </button>
                <button
                  onClick={() => handleShare('facebook')}
                  className="bg-[#1877F2]/10 text-[#1877F2] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#1877F2]/20 active:scale-[0.98] transition-all border border-[#1877F2]/20"
                >
                  <ShareBrandBadge platform="facebook" />
                  Facebook
                </button>
                <button
                  onClick={() => handleShare('twitter')}
                  className="bg-[#0F1419]/10 text-[#0F1419] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#0F1419]/20 active:scale-[0.98] transition-all border border-[#0F1419]/20"
                >
                  <ShareBrandBadge platform="x" />
                  X
                </button>
                <button
                  onClick={() => handleShare('linkedin')}
                  className="bg-[#0A66C2]/10 text-[#0A66C2] py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-[#0A66C2]/20 active:scale-[0.98] transition-all border border-[#0A66C2]/20"
                >
                  <ShareBrandBadge platform="linkedin" />
                  LinkedIn
                </button>
              </div>
              <button
                onClick={handleLinkOnly}
                className="w-full text-center text-[11px] font-bold text-primary underline underline-offset-2"
              >
                Just copy the message & link
              </button>
            </div>

            <div className="p-5 pt-4 shrink-0">
              <button
                onClick={markSeen}
                className="w-full py-3.5 border-2 border-border-subtle text-text-muted rounded-2xl font-bold active:scale-[0.98] transition-all"
              >
                Maybe Later
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
