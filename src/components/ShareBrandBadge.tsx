import React from 'react';
import { siFacebook, siInstagram, siWhatsapp, siLinkedin, siX } from 'simple-icons';

// The real brand logos (from the open Simple Icons set) for the "Spread the Word" and share buttons
// (Profile.tsx's card and SpreadWordPrompt.tsx's popup), each in its own brand colour.
const ICONS = {
  whatsapp: siWhatsapp,
  facebook: siFacebook,
  instagram: siInstagram,
  x: siX,
  linkedin: siLinkedin,
} as const;

export function ShareBrandBadge({ platform }: { platform: 'whatsapp' | 'facebook' | 'instagram' | 'x' | 'linkedin' }) {
  const icon = ICONS[platform];
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" role="img" aria-label={icon.title}>
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}
