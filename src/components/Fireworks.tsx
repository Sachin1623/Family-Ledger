import React, { useMemo } from 'react';
import { motion } from 'motion/react';

const FIREWORK_COLORS = ['#FFD166', '#EF476F', '#06D6A0', '#118AB2', '#FF9F1C', '#B892FF'];

// A handful of independent particle bursts (not one big single burst) so it reads as genuine
// fireworks rather than one starburst — each origin point pops on its own stagger, purely CSS/
// motion-driven (no canvas, no new dependency), and plays once then leaves the DOM inert. Shared
// across every game's win celebration (Rummy, Ludo, Business, Sweep, Sequence, Chess) rather than
// reimplemented per screen. Absolutely positioned to fill its nearest `relative` ancestor — drop
// it inside a small win-banner card, not the whole page, so it never blocks anything underneath.
export default function Fireworks() {
  const bursts = useMemo(
    () =>
      Array.from({ length: 5 }, (_, i) => ({
        id: i,
        left: 15 + Math.random() * 70,
        top: 10 + Math.random() * 35,
        delay: i * 0.35,
        particles: Array.from({ length: 10 }, (_, j) => ({
          angle: (j / 10) * Math.PI * 2 + Math.random() * 0.3,
          distance: 36 + Math.random() * 24,
          color: FIREWORK_COLORS[(i + j) % FIREWORK_COLORS.length],
        })),
      })),
    [],
  );
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {bursts.map((b) => (
        <div key={b.id} className="absolute" style={{ left: `${b.left}%`, top: `${b.top}%` }}>
          {b.particles.map((p, i) => (
            <motion.span
              key={i}
              className="absolute w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: p.color }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{
                x: Math.cos(p.angle) * p.distance,
                y: Math.sin(p.angle) * p.distance + 14, // slight gravity drift
                opacity: 0,
                scale: 0.4,
              }}
              transition={{ duration: 1.1, delay: b.delay, ease: 'easeOut' }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
