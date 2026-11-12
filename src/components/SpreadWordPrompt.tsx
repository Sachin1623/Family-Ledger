import React from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { motion, AnimatePresence } from 'motion/react';
import SpreadTheWordShare from './SpreadTheWordShare';

// Global "Spread the Word" popup. It is a gentle reminder on a fixed rhythm, not tied to signing in: it first appears 14 days after the person's
// first login, then at most once every 14 days.
//
// When it was last shown is kept on the person's own user doc (`spreadWordShownAt`), so every phone agrees. People who joined before this rule
// existed have nothing saved, so their clock starts quietly the first time they open the app after it goes live (they are not greeted by it that
// day). The saved moment is read fresh before showing, because right after sign-in the profile can be half-loaded.
//
// (The admin's "Send Now" for Spread the Word still sends its push; the popup itself follows the 14-day rhythm instead of appearing at once.)
const EVERY_MS = 14 * 24 * 60 * 60 * 1000;
const RULE_STARTED_AT = Date.parse('2026-11-12T00:00:00Z');

export default function SpreadWordPrompt() {
  const { user, profile } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [visible, setVisible] = React.useState(() => document.visibilityState === 'visible');
  const checkedUid = React.useRef<string | null>(null);

  React.useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  React.useEffect(() => {
    if (!user || !profile || !visible || open || checkedUid.current === user.uid) return;
    checkedUid.current = user.uid;
    const uid = user.uid;
    const created = user.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : NaN;
    const stamp = () => updateDoc(doc(db, 'users', uid), { spreadWordShownAt: new Date().toISOString() }).catch((err) => console.error('Could not save the Spread the Word time:', err));
    getDoc(doc(db, 'users', uid)).then((snap) => {
      if (!snap.exists()) { checkedUid.current = null; return; }
      const savedAt = snap.data()?.spreadWordShownAt ? Date.parse(snap.data()!.spreadWordShownAt) : NaN;
      // the clock: when it was last shown; for a person who joined after this rule, their first login
      const since = Number.isFinite(savedAt) ? savedAt : (Number.isFinite(created) && created >= RULE_STARTED_AT ? created : NaN);
      if (!Number.isFinite(since)) { void stamp(); return; } // joined before this rule and nothing saved: start the clock quietly now
      if (Date.now() - since >= EVERY_MS) { setOpen(true); void stamp(); }
    }).catch(() => { checkedUid.current = null; });
  }, [user, profile, visible, open]);

  const close = () => setOpen(false);

  return (
    <AnimatePresence>
      {open && (
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
              <SpreadTheWordShare onShared={close} />
            </div>

            <div className="p-5 pt-4 shrink-0">
              <button
                onClick={close}
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
