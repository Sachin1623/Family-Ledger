import React from 'react';
import { clsx } from 'clsx';

// Small brand-colored badges for "Spread the Word" share buttons (Profile.tsx's card and
// SpreadWordPrompt.tsx's popup), standing in for each platform's logo — Material Symbols (used
// everywhere else in this app) has no brand icons, and this app has no licensed brand-asset kit
// to pull exact vector logos from, so these are simplified color+mark badges (brand color + the
// platform's recognizable letter/glyph) rather than pixel-perfect reproductions.
export function ShareBrandBadge({ platform }: { platform: 'whatsapp' | 'facebook' | 'x' | 'linkedin' }) {
  const base = 'w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0 text-white leading-none';
  switch (platform) {
    case 'whatsapp':
      return (
        <span className={clsx(base, 'bg-[#25D366]')}>
          <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: "'FILL' 1" }}>call</span>
        </span>
      );
    case 'facebook':
      return <span className={clsx(base, 'bg-[#1877F2] font-black text-[12px] italic')}>f</span>;
    case 'x':
      return <span className={clsx(base, 'bg-black font-black text-[10px]')}>X</span>;
    case 'linkedin':
      return <span className={clsx(base, 'bg-[#0A66C2] font-black text-[8px]')}>in</span>;
  }
}
