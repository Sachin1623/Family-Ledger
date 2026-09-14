import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import AccountsExplainerModal from './AccountsExplainerModal';

// The weekly "still haven't set up any accounts or goals?" nudge — server.ts's
// /api/cron/send-account-goal-nudge writes a plain `accountGoalNudge` field on the user's own
// `users/{uid}` doc (alongside sending a push), and this reads it off the SAME live profile stream
// every screen already gets for free via AuthContext (no new Firestore listener needed) — exactly
// the pattern GameTurnIndicator.tsx uses for "server writes, app-already-open shows it live." That
// is what makes this show up identically whether the push notification was tapped (which just
// lands on Dashboard, routeNotificationTap's 'account_goal_nudge' branch) or the app was already
// open when the cron ran — same field, same popup, either way. Mounted unconditionally in App.tsx.
export default function AccountGoalNudgePrompt() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [showExplainer, setShowExplainer] = useState(false);

  const nudge = profile?.accountGoalNudge as { message: string; createdAt: string } | null | undefined;

  const dismiss = () => {
    if (!user) return;
    setDoc(doc(db, 'users', user.uid), { accountGoalNudge: null }, { merge: true }).catch((err) =>
      console.error('Failed to dismiss account/goal nudge:', err),
    );
  };

  if (!nudge) return null;

  if (showExplainer) {
    return (
      <AccountsExplainerModal
        onClose={() => {
          setShowExplainer(false);
          dismiss();
          navigate('/goals/accounts?openAdd=1&guide=1&onboarding=1');
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[295] flex items-center justify-center p-6" onClick={dismiss}>
      <div className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl space-y-5" onClick={(e) => e.stopPropagation()}>
        <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-3xl">💰</div>
        <div className="text-center space-y-2">
          <h3 className="text-xl font-bold text-primary">Track your real savings too?</h3>
          <p className="text-sm text-text-secondary leading-relaxed">{nudge.message}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowExplainer(true)}
          className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm"
        >
          <span className="material-symbols-outlined text-[20px]">account_balance</span>
          Set it up now
        </button>
        <button type="button" onClick={dismiss} className="w-full text-center text-xs font-bold text-text-muted hover:text-primary">
          Not now
        </button>
      </div>
    </div>
  );
}
