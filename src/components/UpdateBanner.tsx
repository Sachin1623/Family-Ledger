import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useLanguage } from '../context/LanguageContext';
import { useAppUpdateAvailable, hardReloadApp } from '../lib/appUpdate';

// Tells an already-open tab a new deploy has landed. The PWA service worker (`registerType:
// 'autoUpdate'`) already updates itself silently in the background — it just never tells anyone
// or reloads an open tab, so a long-lived session can keep running old JS indefinitely.
export default function UpdateBanner() {
  const { t } = useLanguage();
  const { available } = useAppUpdateAvailable();
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  const handleReload = async () => {
    setReloading(true);
    await hardReloadApp();
  };

  return (
    <div className="fixed bottom-20 left-0 right-0 z-[270] flex justify-center px-3 pointer-events-none">
      <AnimatePresence>
        {available && !dismissed && (
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 22, stiffness: 300 }}
            className="pointer-events-auto w-full max-w-sm bg-primary text-white rounded-2xl shadow-2xl p-3 flex items-center gap-3"
          >
            <span className="material-symbols-outlined shrink-0">system_update</span>
            <p className="flex-1 min-w-0 text-xs font-bold">{t('update.available')}</p>
            <button
              onClick={handleReload}
              disabled={reloading}
              className="px-3 py-1.5 bg-white text-primary rounded-lg text-[11px] font-bold shrink-0 disabled:opacity-60"
            >
              {reloading ? (
                <span className="material-symbols-outlined animate-spin text-[14px] align-middle">sync</span>
              ) : (
                t('update.reload')
              )}
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="text-white/70 shrink-0"
              aria-label="Dismiss"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
