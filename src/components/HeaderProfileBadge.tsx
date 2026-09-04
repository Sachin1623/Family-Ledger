import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { setPointsHudTarget } from '../lib/pointsToastRef';

// Deliberately not Intl.NumberFormat's 'compact' notation — that follows the device's locale,
// which (depending on the browser) can silently swing between "1.6K"/"1.6M" and Indian-style
// "1.6L"/"1.6Cr" groupings. This app's own coin economy always reads in K/L regardless of device
// locale, same as the mockup's own callout — L (lakh, 100,000) rather than M, matching how the
// rest of the app already talks about money for its mostly-Indian user base.
function formatCompactCoins(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 100000).toFixed(1)}L`;
}

// Replaces the old separate profile-avatar button + HeaderPointsPill (coins/level) with one
// combined badge — a level "rank" chip overlapping the top-left of the avatar and a coin-count
// strip across its bottom, both baked into the circle itself rather than living as their own
// header elements. Still the flying-coins animation's landing target (setPointsHudTarget) and
// still pulses on a coins increase — both carried over unchanged from HeaderPointsPill.
export default function HeaderProfileBadge() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [pointsDoc] = useDocument(user ? doc(db, 'userPoints', user.uid) : null);
  const data = pointsDoc?.data() as any;
  const coins: number = data?.coins || 0;
  const level: number = data?.level || 1;

  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setPointsHudTarget(() => ref.current?.getBoundingClientRect() || null);
    return () => setPointsHudTarget(null);
  }, []);

  // Same "landing" pulse beat HeaderPointsPill had — fires whenever coins actually increases,
  // not on every render.
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

  if (!user) return null;

  const profileImage = (profile?.photoURL && profile.photoURL.length > 0) ? profile.photoURL
    : (user.photoURL && user.photoURL.length > 0) ? user.photoURL
    : null;
  const initial = profile?.displayName?.slice(0, 1) || user.displayName?.slice(0, 1);
  const compactCoins = formatCompactCoins(coins);

  return (
    <motion.button
      ref={ref}
      data-tour="header-profile"
      onClick={() => navigate('/profile')}
      animate={pulsing ? { scale: [1, 1.15, 1] } : { scale: 1 }}
      transition={{ duration: 0.5 }}
      className="relative w-11 h-11 shrink-0 active:scale-95 transition-transform"
      title="View Profile"
    >
      {/* Rank/level chip — bold solid circle overlapping the top-left corner, sized to actually
          read at a glance rather than a tiny sliver. `warning` (amber) is a plain color choice
          here, not its usual semantic "caution" meaning — this app's theme has no `accent` token. */}
      <span className="absolute -top-1.5 -left-1.5 z-10 w-5 h-5 rounded-full bg-warning shadow-md flex items-center justify-center">
        <span className="text-white text-[10px] font-black leading-none">{level}</span>
      </span>
      <span className="block w-full h-full rounded-full overflow-hidden border-[3px] border-border-subtle bg-primary/10 relative shadow-sm">
        {profileImage ? (
          <img src={profileImage} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="w-full h-full flex items-center justify-center text-primary font-bold text-sm">
            {initial || <span className="material-symbols-outlined text-[20px]">person</span>}
          </span>
        )}
        {/* Coin strip — sits across the bottom of the circle rather than as a separate pill. A
            small solid gradient dot stands in for a coin icon instead of an emoji, since emoji
            rendering (and thus legibility at this size) varies too much across devices/fonts. */}
        <span className="absolute bottom-0 left-0 right-0 h-4 bg-black/60 flex items-center justify-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-warning to-[#b45309] shrink-0" />
          <span className="text-[9px] font-black text-white leading-none">{compactCoins}</span>
        </span>
      </span>
    </motion.button>
  );
}
