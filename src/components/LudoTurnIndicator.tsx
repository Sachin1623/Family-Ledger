import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

// The in-app half of /api/notify-ludo-turn's three-way notification split: when the app is open
// but the user isn't on that exact game's screen, the server writes `users/{uid}.ludoTurnIndicator`
// instead of sending a push — this renders that as a small tappable pill rather than nothing (no
// push arrives in this case) or an intrusive full-screen interruption.
export default function LudoTurnIndicator() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const indicator = profile?.ludoTurnIndicator as { gameId?: string; opponentNames?: string | null } | null | undefined;
  const gameId = indicator?.gameId;
  const alreadyThere = gameId && location.pathname === `/games/ludo/${gameId}`;
  const shouldShow = !!gameId && !alreadyThere;

  const handleTap = () => {
    if (!gameId || !user) return;
    setDoc(doc(db, 'users', user.uid), { ludoTurnIndicator: null }, { merge: true }).catch(() => {});
    navigate(`/games/ludo/${gameId}`);
  };

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.button
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          onClick={handleTap}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-2 pl-3 pr-4 py-2 bg-[#7C3AED] text-white rounded-full shadow-lg text-xs font-bold"
        >
          <span className="text-base leading-none">🎲</span>
          Your move in Ludo{indicator?.opponentNames ? ` vs ${indicator.opponentNames}` : ''}
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
