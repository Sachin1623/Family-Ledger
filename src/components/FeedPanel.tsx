import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import FeedList from './FeedList';
import { useLanguage } from '../context/LanguageContext';

// The Feed, as a slide-over from the left — available from Header on every screen instead of a
// full-page navigation. FeedList only mounts (and its Firestore listeners only attach) while the
// panel is actually open, since it's inside the `open &&` branch below.
export default function FeedPanel({
  open,
  onClose,
  initialGroupId,
}: {
  open: boolean;
  onClose: () => void;
  initialGroupId?: string;
}) {
  const { t } = useLanguage();
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[250]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'tween', duration: 0.25, ease: 'easeOut' }}
            // Capped below 100% width (even on mobile) so a strip of backdrop is always visible
            // and tappable to dismiss — at w-full, the panel covered the entire backdrop, leaving
            // no "tap outside" area at all and making the X button the only way to close it. The
            // sibling backdrop div (onClick={onClose}) spans the full screen behind this panel,
            // so that exposed strip — including where header buttons sit underneath it — already
            // closes the panel on tap, same as tapping the explicit X.
            className="absolute inset-y-0 left-0 w-[70%] max-w-[380px] bg-surface shadow-2xl flex flex-col"
          >
            <div className="px-4 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] border-b border-border-subtle flex items-center justify-between shrink-0 bg-white">
              <div>
                <h2 className="text-lg font-bold text-primary">{t('feed.title')}</h2>
                <p className="text-xs text-text-muted">{t('feed.subtitle')}</p>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-surface rounded-full text-text-muted shrink-0" aria-label={t('feed.closeFeed')}>
                <span className="material-symbols-outlined text-[22px]">close</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <FeedList onNavigateAway={onClose} initialGroupId={initialGroupId} />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
