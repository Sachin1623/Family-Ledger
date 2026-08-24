import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useLanguage } from '../context/LanguageContext';
import { getAnalyticsConsent, setAnalyticsConsent } from '../lib/firebase';

// A genuine opt-in choice (Accept / Decline), not a dismissible toast — GDPR/ePrivacy require an
// affirmative "yes" before analytics starts, not just a policy disclosure the user can ignore.
// Shown once, the first time this device has no stored answer either way; the answer (either
// direction) is remembered from then on, so this never nags a returning user again. Declining
// still lets the app work normally — see firebase.ts's setAnalyticsConsent, which simply never
// initializes the Analytics SDK when the answer is "denied".
export default function ConsentBanner() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [decided, setDecided] = useState(() => getAnalyticsConsent() !== null);

  const choose = (consent: 'granted' | 'denied') => {
    setAnalyticsConsent(consent);
    setDecided(true);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[275] flex justify-center px-3 pb-3 pointer-events-none">
      <AnimatePresence>
        {!decided && (
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ type: 'spring', damping: 24, stiffness: 300 }}
            className="pointer-events-auto w-full max-w-md bg-white rounded-2xl shadow-2xl border border-border-subtle p-4 space-y-3"
          >
            <div className="flex items-start gap-2.5">
              <span className="material-symbols-outlined text-primary shrink-0">cookie</span>
              <p className="text-xs text-on-surface leading-relaxed">
                {t('consent.body')}{' '}
                <button onClick={() => navigate('/privacy')} className="font-bold text-primary underline">
                  {t('consent.privacyLink')}
                </button>
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => choose('denied')}
                className="flex-1 py-2.5 rounded-xl text-xs font-bold text-text-muted border border-border-subtle"
              >
                {t('consent.decline')}
              </button>
              <button
                onClick={() => choose('granted')}
                className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white bg-primary"
              >
                {t('consent.accept')}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
