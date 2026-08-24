import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { setPointsHudTarget } from '../lib/pointsToastRef';

// Small always-visible coins/level pill in the header — doubles as the landing target
// PointsFlyAnimation.tsx's flying coins animate toward (registered via setPointsHudTarget), and
// as the one place a viewer can always see their own total without visiting My Progress.
export default function HeaderPointsPill() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [pointsDoc] = useDocument(user ? doc(db, 'userPoints', user.uid) : null);
  const data = pointsDoc?.data() as any;
  const coins: number = data?.coins || 0;
  const level: number = data?.level || 1;

  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setPointsHudTarget(() => ref.current?.getBoundingClientRect() || null);
    return () => setPointsHudTarget(null);
  }, []);

  // A brief scale pulse whenever coins actually increases — the "landing" beat the flying
  // animation's particles arrive on, not just a static number update.
  const [pulsing, setPulsing] = useState(false);
  const prevCoinsRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevCoinsRef.current !== null && coins > prevCoinsRef.current) {
      setPulsing(true);
      const timer = setTimeout(() => setPulsing(false), 500);
      return () => clearTimeout(timer);
    }
    prevCoinsRef.current = coins;
  }, [coins]);

  // Rendered even before a user's first-ever award (userPoints/{uid} doesn't exist yet) — showing
  // 0 coins / Lv1 rather than hiding the pill entirely, both because "start earning" is a more
  // honest empty state than nothing, and because the very first award's flying animation needs
  // this pill already mounted and registered as a target to fly toward.
  if (!user) return null;

  // Stacked (coins above level) rather than one wide row — narrower footprint in an already
  // crowded header, and the two numbers read as two distinct stats instead of one run-on line.
  return (
    <motion.button
      ref={ref}
      onClick={() => navigate('/progress')}
      animate={pulsing ? { scale: [1, 1.18, 1] } : { scale: 1 }}
      transition={{ duration: 0.5 }}
      className="h-10 w-12 px-1 rounded-xl bg-primary/5 hover:bg-primary/10 flex flex-col items-center justify-center gap-0.5 text-primary transition-colors shrink-0"
      title="My Progress"
    >
      <span className="flex items-center gap-0.5 leading-none">
        <span className="text-[11px] leading-none">🪙</span>
        <span className="text-[11px] font-black leading-none">{coins}</span>
      </span>
      <span className="text-[9px] font-bold text-text-muted leading-none">Lv{level}</span>
    </motion.button>
  );
}
