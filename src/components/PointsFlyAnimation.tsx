import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { setPointsFlyListener } from '../lib/pointsToastRef';

interface Burst {
  id: number;
  particles: { key: string; emoji: string; dx: number; dy: number; delay: number }[];
  originX: number;
  originY: number;
}

let burstIdCounter = 0;

// Globally mounted (see App.tsx) — listens for every points award via pointsToastRef.ts and
// spawns a small shower of coin/star particles flying from a fixed near-top origin (roughly where
// the toast notification lands) toward HeaderPointsPill's live screen position, so an award reads
// as "this flew into your total" rather than just a number changing silently.
export default function PointsFlyAnimation() {
  const [bursts, setBursts] = useState<Burst[]>([]);

  useEffect(() => {
    setPointsFlyListener((xp, coins, targetRect) => {
      if (!targetRect) return; // pill isn't mounted/registered yet — skip the flight, toast still shows
      const originX = window.innerWidth / 2;
      const originY = 90;
      const targetX = targetRect.left + targetRect.width / 2;
      const targetY = targetRect.top + targetRect.height / 2;

      const coinCount = Math.min(5, Math.max(1, Math.round(coins / 5)));
      const particles = Array.from({ length: coinCount }, (_, i) => ({
        key: `c${i}`,
        emoji: '🪙',
        dx: (targetX - originX) + (Math.random() * 24 - 12),
        dy: (targetY - originY) + (Math.random() * 24 - 12),
        delay: i * 0.07,
      }));
      if (xp > 0) {
        particles.push({ key: 'xp', emoji: '✨', dx: targetX - originX, dy: targetY - originY, delay: 0 });
      }

      const id = ++burstIdCounter;
      setBursts((prev) => [...prev, { id, particles, originX, originY }]);
      setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 1200);
    });
    return () => setPointsFlyListener(null);
  }, []);

  if (bursts.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[275] pointer-events-none overflow-hidden">
      <AnimatePresence>
        {bursts.map((burst) =>
          burst.particles.map((p) => (
            <motion.span
              key={`${burst.id}-${p.key}`}
              initial={{ x: burst.originX, y: burst.originY, opacity: 1, scale: 1 }}
              animate={{ x: burst.originX + p.dx, y: burst.originY + p.dy, opacity: 0, scale: 0.4 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, delay: p.delay, ease: 'easeIn' }}
              className="absolute text-xl -translate-x-1/2 -translate-y-1/2"
            >
              {p.emoji}
            </motion.span>
          )),
        )}
      </AnimatePresence>
    </div>
  );
}
