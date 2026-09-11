import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { Capacitor } from '@capacitor/core';
import { InAppReview } from '@capacitor-community/in-app-review';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';

// Every 50 XP earned (see userPoints/{uid}.xp, awarded via claimPoints across the app), nudge the
// user to either rate the app or tell us what's wrong — native-only, since there's no app store
// listing to rate from the web build. "Stops if already rated" is interpreted the only way that's
// actually verifiable: neither Google Play's In-App Review API nor Apple's SKStoreReviewController
// ever reports back whether the user actually submitted anything (by design, to prevent gaming the
// prompt) — so once we've triggered that native flow once (the "Loving it!" path), we treat the
// user as rated and never ask again. Choosing "Share Feedback" instead does NOT set that flag, so
// the next 50-point milestone still offers the rating ask again.
export default function FeedbackRatingPrompt() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [userDoc] = useDocument(user ? doc(db, 'users', user.uid) : null);
  const [pointsDoc] = useDocument(user ? doc(db, 'userPoints', user.uid) : null);

  const xp: number = pointsDoc?.data()?.xp || 0;
  const hasRequestedAppReview: boolean = userDoc?.data()?.hasRequestedAppReview || false;
  const feedbackPromptedAtXp: number = userDoc?.data()?.feedbackPromptedAtXp || 0;

  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  // Guards against re-showing the instant `feedbackPromptedAtXp` catches up via its own write —
  // there's a round trip before the Firestore listener above reflects it.
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  useEffect(() => {
    if (!user || !Capacitor.isNativePlatform() || hasRequestedAppReview || dismissedThisSession) return;
    if (xp <= 0) return;
    const currentMilestone = Math.floor(xp / 50);
    const lastMilestone = Math.floor(feedbackPromptedAtXp / 50);
    if (currentMilestone > lastMilestone) setVisible(true);
  }, [user, xp, feedbackPromptedAtXp, hasRequestedAppReview, dismissedThisSession]);

  if (!visible || !user) return null;

  const recordShown = (extra?: Record<string, any>) =>
    updateDoc(doc(db, 'users', user.uid), { feedbackPromptedAtXp: xp, ...extra }).catch((err) =>
      console.error('Failed to record feedback prompt state:', err),
    );

  const handleLovingIt = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await InAppReview.requestReview().catch((err) => console.warn('requestReview unavailable:', err));
      await recordShown({ hasRequestedAppReview: true });
    } finally {
      setBusy(false);
      setDismissedThisSession(true);
      setVisible(false);
    }
  };

  const handleShareFeedback = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await recordShown();
    } finally {
      setBusy(false);
      setDismissedThisSession(true);
      setVisible(false);
      navigate('/feedback');
    }
  };

  const handleMaybeLater = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await recordShown();
    } finally {
      setBusy(false);
      setDismissedThisSession(true);
      setVisible(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-6 space-y-4 text-center">
        <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
          <span className="material-symbols-outlined text-[28px] text-primary">celebration</span>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-black text-primary">{t('feedbackPrompt.title')}</h2>
          <p className="text-sm text-text-muted">{t('feedbackPrompt.body', { xp: String(xp) })}</p>
        </div>
        <div className="space-y-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={handleLovingIt}
            className="w-full py-3 rounded-xl bg-primary text-white font-bold text-sm active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {t('feedbackPrompt.lovingIt')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleShareFeedback}
            className="w-full py-3 rounded-xl bg-surface border border-border-subtle text-on-surface font-bold text-sm active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {t('feedbackPrompt.shareFeedback')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleMaybeLater}
            className="w-full py-2 text-text-muted font-bold text-xs disabled:opacity-50"
          >
            {t('feedbackPrompt.maybeLater')}
          </button>
        </div>
      </div>
    </div>
  );
}
