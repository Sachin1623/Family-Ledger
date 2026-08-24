import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';

const GAME_EMOJI: Record<string, string> = {
  rummy: '🃏',
  sweep: '🧹',
  sequence: '🔴',
  business: '🏙️',
  chess: '♟️',
};

// The generic counterpart to LudoTurnIndicator.tsx, covering every OTHER multiplayer game
// (Rummy, Sweep, Sequence, Business, Chess) via server.ts's shared `notifyGameTurn` /
// `users/{uid}.gameTurnIndicator` — see gameTurnPresence.ts for the presence half. Ludo stays on
// its own bespoke fields/component untouched; this is purely additive, mounted alongside it in
// App.tsx. Positioned a row below Ludo's pill (`top-16` vs `top-3`) so the rare case of both
// being active at once stacks instead of overlapping.
export default function GameTurnIndicator() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const indicator = profile?.gameTurnIndicator as
    | { gameType: string; gameId: string; gameLabel: string; route: string; opponentNames: string | null }
    | null
    | undefined;
  const alreadyThere = indicator && location.pathname === indicator.route;
  const shouldShow = !!indicator && !alreadyThere;

  const handleTap = () => {
    if (!indicator || !user) return;
    setDoc(doc(db, 'users', user.uid), { gameTurnIndicator: null }, { merge: true }).catch(() => {});
    navigate(indicator.route);
  };

  return (
    <AnimatePresence>
      {shouldShow && indicator && (
        <motion.button
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          onClick={handleTap}
          className="fixed top-16 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-2 pl-3 pr-4 py-2 bg-primary text-white rounded-full shadow-lg text-xs font-bold"
        >
          <span className="text-base leading-none">{GAME_EMOJI[indicator.gameType] || '🎮'}</span>
          Your move in {indicator.gameLabel}
          {indicator.opponentNames ? ` vs ${indicator.opponentNames}` : ''}
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
