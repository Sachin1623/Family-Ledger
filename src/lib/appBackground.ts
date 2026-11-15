// App-wide page background: a colour tint plus an optional faint pattern. Only the page behind the cards changes (cards stay white),
// so text stays readable everywhere. The choice lives on the user's profile (users/{uid}.appBackground) and is cached on the phone,
// so it is applied before the first paint instead of flashing the default.

export type CardStyle = 'tint' | 'glass' | 'white';
export interface BgChoice { tint: string; pattern: string; cards: CardStyle }
export const DEFAULT_BG: BgChoice = { tint: 'default', pattern: 'none', cards: 'tint' };

export const CARD_STYLES: { id: CardStyle; name: string; hint: string }[] = [
  { id: 'tint', name: 'Soft tint', hint: 'Cards pick up the colour' },
  { id: 'glass', name: 'Glass', hint: 'The pattern shows faintly through' },
  { id: 'white', name: 'White', hint: 'Cards stay white' },
];

export const TINTS: { id: string; name: string; color: string }[] = [
  { id: 'default', name: 'Classic', color: '#F6F8FA' },
  { id: 'mint', name: 'Mint', color: '#E6F6F1' },
  { id: 'sky', name: 'Sky', color: '#E6F1FB' },
  { id: 'sand', name: 'Sand', color: '#F7F0E3' },
  { id: 'lavender', name: 'Lavender', color: '#EFEAFA' },
  { id: 'rose', name: 'Rose', color: '#FBEAEE' },
  { id: 'peach', name: 'Peach', color: '#FDEEE3' },
  { id: 'slate', name: 'Slate', color: '#E6EAF0' },
];

const INK = 'rgba(0,48,68,';
const svg = (s: string) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;

export const PATTERNS: { id: string; name: string; image: string; size: string }[] = [
  { id: 'none', name: 'Plain', image: 'none', size: 'auto' },
  { id: 'dots', name: 'Dots', image: `radial-gradient(${INK}0.13) 1.3px, transparent 1.6px)`, size: '18px 18px' },
  { id: 'grid', name: 'Grid', image: `linear-gradient(${INK}0.06) 1px, transparent 1px), linear-gradient(90deg, ${INK}0.06) 1px, transparent 1px)`, size: '26px 26px' },
  { id: 'lines', name: 'Lines', image: `repeating-linear-gradient(135deg, ${INK}0.06) 0 1px, transparent 1px 15px)`, size: 'auto' },
  { id: 'waves', name: 'Waves', image: svg(`<svg xmlns='http://www.w3.org/2000/svg' width='80' height='24'><path d='M0 12 Q20 0 40 12 T80 12' fill='none' stroke='rgba(0,48,68,0.08)' stroke-width='1.4'/></svg>`), size: '80px 24px' },
  { id: 'glow', name: 'Glow', image: 'radial-gradient(circle at 15% 0%, rgba(255,255,255,0.95), transparent 55%), radial-gradient(circle at 100% 100%, rgba(18,184,154,0.14), transparent 50%)', size: '100% 100%' },
  { id: 'blobs', name: 'Blobs', image: 'radial-gradient(circle at 90% 8%, rgba(59,130,246,0.13), transparent 28%), radial-gradient(circle at 8% 55%, rgba(18,184,154,0.13), transparent 30%), radial-gradient(circle at 85% 92%, rgba(245,158,11,0.12), transparent 30%)', size: '100% 100%' },
  { id: 'paper', name: 'Paper', image: svg(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0.19  0 0 0 0 0.27  0 0 0 0.09 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`), size: '160px 160px' },
];

const KEY = 'fl_app_bg';

export function normalizeBg(v: any): BgChoice {
  const tint = TINTS.some((t) => t.id === v?.tint) ? v.tint : 'default';
  const pattern = PATTERNS.some((p) => p.id === v?.pattern) ? v.pattern : 'none';
  const cards: CardStyle = v?.cards === 'glass' || v?.cards === 'white' ? v.cards : 'tint';
  return { tint, pattern, cards };
}

const hexToRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// mix(a, b, k) = k of a + (1-k) of b, returned as a hex colour
const mix = (a: string, b: [number, number, number], k: number) => {
  const [r, g, bl] = hexToRgb(a);
  const m = (x: number, y: number) => Math.round(x * k + y * (1 - k)).toString(16).padStart(2, '0');
  return `#${m(r, b[0])}${m(g, b[1])}${m(bl, b[2])}`;
};

export function applyBackground(choice: BgChoice, remember = true) {
  const c = normalizeBg(choice);
  const root = document.documentElement;
  const tint = TINTS.find((t) => t.id === c.tint)!;
  const pat = PATTERNS.find((p) => p.id === c.pattern)!;
  const vars = ['--fl-bg-color', '--fl-bg-image', '--fl-bg-size', '--fl-card', '--fl-card-glass', '--color-surface', '--color-border-subtle'];
  if (c.tint === 'default' && c.pattern === 'none') {
    root.removeAttribute('data-fl-bg');
    root.removeAttribute('data-fl-cards');
    vars.forEach((v) => root.style.removeProperty(v));
  } else {
    root.setAttribute('data-fl-bg', '1');
    root.style.setProperty('--fl-bg-color', tint.color);
    root.style.setProperty('--fl-bg-image', pat.image);
    root.style.setProperty('--fl-bg-size', pat.size);
    // chips and fields inside cards, and the card outlines, follow the chosen colour too
    root.style.setProperty('--color-surface', tint.color);
    root.style.setProperty('--color-border-subtle', mix(tint.color, [120, 140, 155], 0.78));
    if (c.cards === 'white') {
      root.removeAttribute('data-fl-cards');
      root.style.removeProperty('--fl-card');
      root.style.removeProperty('--fl-card-glass');
    } else {
      root.setAttribute('data-fl-cards', c.cards);
      // about a third of the colour mixed into white; sheets and pop-ups always use this solid colour
      root.style.setProperty('--fl-card', mix(tint.color, [255, 255, 255], 0.38));
      // glass: mostly white but see-through, so the pattern shows. Only used on the page itself, never on pop-ups.
      root.style.setProperty('--fl-card-glass', 'rgba(255,255,255,0.68)');
    }
  }
  if (remember) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private mode: fine */ } }
}

export function applyCachedBackground() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) applyBackground(JSON.parse(raw), false);
  } catch { /* ignore */ }
}
