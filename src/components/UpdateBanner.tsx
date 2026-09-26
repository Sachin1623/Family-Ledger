import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useLanguage } from '../context/LanguageContext';
import { useAppUpdateAvailable, hardReloadApp } from '../lib/appUpdate';

// Tells an already-open tab a new deploy has landed. The PWA service worker (`registerType:
// 'autoUpdate'`) already updates itself silently in the background — it just never tells anyone
// or reloads an open tab, so a long-lived session can keep running old JS indefinitely. A modal
// (rather than a dismissible bottom bar) so a real user actually sees it and knows what changed,
// instead of it blending into the corner of the screen and going unnoticed.
export default function UpdateBanner() {
  const { t } = useLanguage();
  const { available, changelog } = useAppUpdateAvailable();
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  const handleReload = async () => {
    setReloading(true);
    await hardReloadApp();
  };

  return (
    <AnimatePresence>
      {available && !dismissed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[270] flex items-center justify-center bg-black/50 px-4"
        >
          <motion.div
            initial={{ y: 24, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', damping: 22, stiffness: 300 }}
            className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-start gap-3">
              <span className="shrink-0 w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <span className="material-symbols-outlined">system_update</span>
              </span>
              <div className="min-w-0">
                <p className="font-black text-primary text-sm">{t('update.title')}</p>
                <p className="text-xs text-text-muted mt-0.5">{changelog || t('update.available')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDismissed(true)}
                className="flex-1 py-2.5 border border-border-subtle text-text-muted font-bold rounded-xl text-sm"
              >
                {t('update.later')}
              </button>
              <button
                onClick={handleReload}
                disabled={reloading}
                className="flex-1 py-2.5 bg-primary text-white font-bold rounded-xl text-sm disabled:opacity-60"
              >
                {reloading ? (
                  <span className="material-symbols-outlined animate-spin text-[18px] align-middle">sync</span>
                ) : (
                  t('update.reload')
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
