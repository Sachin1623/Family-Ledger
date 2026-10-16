import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useLanguage } from '../context/LanguageContext';
import { getStoredAnalyticsConsent, setAnalyticsConsent, isAndroidApp, looksLikeEurope } from '../lib/firebase';
import { isIosApp } from '../lib/platform';
import { trackFunnel } from '../lib/funnel';

// A genuine opt-in choice (Accept / Decline), not a dismissible toast — GDPR/ePrivacy require an
// affirmative "yes" before analytics starts, not just a policy disclosure the user can ignore.
// Shown once, the first time this device has no stored answer either way; the answer (either
// direction) is remembered from then on, so this never nags a returning user again. Declining
// still lets the app work normally — see firebase.ts's setAnalyticsConsent, which simply never
// initializes the Analytics SDK when the answer is "denied".
export default function ConsentBanner() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [decided, setDecided] = useState(() => getStoredAnalyticsConsent() !== null);
  // The installed Android app (outside Europe) counts anonymous usage by default, so here this is a notice with a Turn off,
  // not a request. Everywhere else it stays a real opt-in.
  const asNotice = isAndroidApp() && !looksLikeEurope();
  if (isIosApp()) return null; // no analytics / cookie prompt inside the iOS app

  const choose = (consent: 'granted' | 'denied') => {
    setAnalyticsConsent(consent);
    trackFunnel(consent === 'granted' ? 'consent_accept' : 'consent_decline');
    setDecided(true);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[275] flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-events-none">
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
                {t(asNotice ? 'consent.noticeBody' : 'consent.body')}{' '}
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
                {t(asNotice ? 'consent.noticeOff' : 'consent.decline')}
              </button>
              <button
                onClick={() => choose('granted')}
                className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white bg-primary"
              >
                {t(asNotice ? 'consent.noticeOk' : 'consent.accept')}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
