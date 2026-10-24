import type { BadgeOption, BadgeTier } from '../lib/cosmeticsApi';

// A badge drawn as a medal. Earned: a glossy metal rim in the badge's tier colour with the icon shining in the middle, and a slow sweep of light across it
// (legendary medals also glitter). Not yet earned: a dark, greyed medal with a ring that fills as the person gets closer, so a locked badge shows how near it is.

export const TIERS: Record<BadgeTier, { label: string; rim: string; face: string; glow: string }> = {
  bronze: { label: 'Bronze', rim: 'linear-gradient(145deg,#f0b476,#a85f1f 55%,#6e3a10)', face: 'radial-gradient(circle at 35% 30%,#fff1da,#e8bf8c)', glow: '#e59a52' },
  silver: { label: 'Silver', rim: 'linear-gradient(145deg,#f4f7fb,#9aa6b6 55%,#5f6b7b)', face: 'radial-gradient(circle at 35% 30%,#ffffff,#d5dce6)', glow: '#b8c4d4' },
  gold: { label: 'Gold', rim: 'linear-gradient(145deg,#fff0a6,#e0a800 55%,#9a6a00)', face: 'radial-gradient(circle at 35% 30%,#fffbe0,#ffe27a)', glow: '#ffc933' },
  legend: { label: 'Legendary', rim: 'conic-gradient(from 20deg,#7c3aed,#06b6d4,#34d399,#facc15,#f472b6,#7c3aed)', face: 'radial-gradient(circle at 35% 30%,#ffffff,#e9defb)', glow: '#a78bfa' },
};

const CSS = `
@keyframes bmSweep{0%{transform:translateX(-140%) skewX(-20deg)}55%,100%{transform:translateX(240%) skewX(-20deg)}}
@keyframes bmTwinkle{0%,100%{opacity:0;transform:scale(.4)}50%{opacity:1;transform:scale(1)}}
@keyframes bmPulse{0%,100%{box-shadow:0 0 0 0 var(--g)}50%{box-shadow:0 0 18px 4px var(--g)}}
.bm-sweep{animation:bmSweep 3.4s ease-in-out infinite}
.bm-star{animation:bmTwinkle 2.2s ease-in-out infinite}
.bm-glow{animation:bmPulse 2.8s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.bm-sweep,.bm-star,.bm-glow{animation:none!important}}
`;

export default function BadgeMedal({ badge, size = 76, showProgress = true }: { badge: Pick<BadgeOption, 'icon' | 'tier' | 'earned' | 'progress' | 'target'>; size?: number; showProgress?: boolean }) {
  const t = TIERS[badge.tier];
  const ring = 5;
  const inner = size - ring * 2;
  const pct = badge.target > 0 ? Math.min(1, badge.progress / badge.target) : 0;
  const R = size / 2 - 2;
  const C = 2 * Math.PI * R;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <style>{CSS}</style>
      {badge.earned ? (
        <div className="relative w-full h-full rounded-full bm-glow" style={{ ['--g' as any]: `${t.glow}66`, background: t.rim, padding: ring, boxShadow: `0 4px 10px ${t.glow}55, inset 0 1px 2px #ffffffaa` }}>
          <div className="relative w-full h-full rounded-full overflow-hidden flex items-center justify-center" style={{ background: t.face, boxShadow: 'inset 0 2px 5px #00000030' }}>
            <span style={{ fontSize: inner * 0.5, filter: 'drop-shadow(0 2px 2px #00000040)' }}>{badge.icon}</span>
            <span className="bm-sweep absolute inset-y-0 w-1/3 pointer-events-none" style={{ background: 'linear-gradient(90deg,transparent,#ffffffcc,transparent)' }} />
          </div>
          {badge.tier === 'legend' && (
            <>
              <span className="bm-star absolute -top-1 -right-0.5 text-[11px]" style={{ animationDelay: '0s' }}>✦</span>
              <span className="bm-star absolute top-1/2 -left-1.5 text-[9px]" style={{ animationDelay: '.8s' }}>✦</span>
              <span className="bm-star absolute -bottom-1 right-2 text-[10px]" style={{ animationDelay: '1.5s' }}>✦</span>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="w-full h-full rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(145deg,#cfd4dc,#8d96a3)', padding: ring }}>
            <div className="w-full h-full rounded-full flex items-center justify-center relative" style={{ background: 'radial-gradient(circle at 35% 30%,#4b5563,#1f2937)', boxShadow: 'inset 0 2px 6px #000000aa' }}>
              <span style={{ fontSize: inner * 0.46, filter: 'grayscale(1) brightness(.55)', opacity: 0.9 }}>{badge.icon}</span>
              <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-white text-[10px] leading-none flex items-center justify-center shadow ring-1 ring-slate-300" style={{ width: size * 0.28, height: size * 0.28 }}>🔒</span>
            </div>
          </div>
          {showProgress && badge.progress > 0 && (
            <svg className="absolute inset-0 -rotate-90 pointer-events-none" width={size} height={size} aria-hidden="true">
              <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke={t.glow} strokeWidth="3" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />
            </svg>
          )}
        </>
      )}
    </div>
  );
}
