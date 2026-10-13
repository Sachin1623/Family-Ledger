// The "Spread the Word" posters — a set of themed 1080x1350 images (everything, money, health,
// family, games), each leading with a different reason to install and carrying 4 to 6 features.
// A fresh set is drawn every time the user taps Share, so they can pick the one that fits who
// they're sending it to. Same brand look as the win cards; every poster has a Play Store QR code.
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, wrapLines, seeded, newPosterCanvas, canvasToPng, fontsReady,
  paintBackground, paintLogoBadge, paintInstallFooter,
} from './cardCanvas';

export type SpreadVariantId = 'all' | 'money' | 'health' | 'family' | 'games';

interface SpreadTile {
  emoji: string;
  title: string;
  sub: string;
}

export interface SpreadVariant {
  id: SpreadVariantId;
  label: string;
  emoji: string;
  headline: [string, string]; // second line gets the accent gradient
  taglines: string[];         // one is picked at random each time a poster is drawn
  accent: [string, string];   // gradient start / end
  glow: string;               // "r, g, b" for the background glow
  tiles: SpreadTile[];        // 4 to 6
}

export const SPREAD_VARIANTS: SpreadVariant[] = [
  {
    id: 'all',
    label: 'Everything',
    emoji: '✨',
    headline: ['One app for', 'the whole family.'],
    taglines: ['Money, health, chats and games — together', 'Everything your household needs in one place'],
    accent: ['#FFE08A', '#FFA629'],
    glow: '255, 176, 41',
    tiles: [
      { emoji: '💸', title: 'Split bills', sub: 'Equally, by % or exact' },
      { emoji: '📊', title: 'Budgets & goals', sub: 'Track spending, hit targets' },
      { emoji: '🩺', title: 'Health records', sub: 'BP, sugar, medicines, vaccines' },
      { emoji: '⏰', title: 'Smart reminders', sub: 'Bills, doses and to-dos' },
      { emoji: '💬', title: 'Group chat', sub: 'Everyone on the same page' },
      { emoji: '🎮', title: 'Family games', sub: 'Rummy, Ludo, Chess & more' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    emoji: '💰',
    headline: ['Split bills.', 'Stay sane.'],
    taglines: ['Shared money for families, flatmates and friends', 'No more chasing who owes who'],
    accent: ['#6EF2B4', '#22C5A0'],
    glow: '46, 230, 166',
    tiles: [
      { emoji: '💸', title: 'Split expenses', sub: 'Equally, by % or exact amounts' },
      { emoji: '📊', title: 'Real budgets', sub: 'By category — splitting is optional' },
      { emoji: '🔄', title: 'Recurring bills', sub: 'Rent and wifi log themselves' },
      { emoji: '🎯', title: 'Savings goals', sub: 'Link real accounts, hit targets' },
      { emoji: '🤝', title: 'Personal loans', sub: 'Keep IOUs with a clear trail' },
      { emoji: '🔔', title: 'Expense reminders', sub: "Never forget to log a spend" },
    ],
  },
  {
    id: 'health',
    label: 'Health',
    emoji: '🩺',
    headline: ["Your family's", 'health, sorted.'],
    taglines: ['Records and reminders everyone can rely on', 'Care for the people you love, together'],
    accent: ['#FF9FB4', '#FF5C7C'],
    glow: '255, 92, 124',
    tiles: [
      { emoji: '❤️', title: 'BP & glucose', sub: 'Log readings with colour-coded trends' },
      { emoji: '💊', title: 'Medicine reminders', sub: 'Alarm-style, never miss a dose' },
      { emoji: '💉', title: 'Baby vaccinations', sub: 'Schedule and due-date reminders' },
      { emoji: '👨‍👩‍👧', title: 'Caregiver sharing', sub: 'Let family keep an eye, safely' },
      { emoji: '📄', title: 'Doctor-ready reports', sub: 'Share clean PDF summaries' },
    ],
  },
  {
    id: 'family',
    label: 'Family',
    emoji: '🏠',
    headline: ['Run the home', 'together.'],
    taglines: ['One shared space for the whole household', 'Less nagging, more getting things done'],
    accent: ['#8FC7FF', '#5B8CFF'],
    glow: '91, 140, 255',
    tiles: [
      { emoji: '💬', title: 'Group chat', sub: 'No separate thread for money talk' },
      { emoji: '🛒', title: 'Shopping lists', sub: 'Shared, tick off as you go' },
      { emoji: '✅', title: 'To-dos & habits', sub: 'Plan, repeat and track together' },
      { emoji: '⏰', title: 'Shared reminders', sub: 'Everyone gets the nudge' },
      { emoji: '👥', title: 'Family groups', sub: 'One ledger everyone can see' },
      { emoji: '📰', title: 'Activity feed', sub: "See what everyone's up to" },
    ],
  },
  {
    id: 'games',
    label: 'Games',
    emoji: '🎮',
    headline: ['Game night,', 'sorted.'],
    taglines: ['Play with family anywhere — no real-money wagering', 'Classic games, new memories'],
    accent: ['#FFE08A', '#FFA629'],
    glow: '255, 176, 41',
    tiles: [
      { emoji: '🃏', title: 'Rummy', sub: '13-card and 27-hand variants' },
      { emoji: '♠️', title: 'Spade Pledge', sub: 'Bid, play, outsmart the table' },
      { emoji: '🎴', title: 'Sweep & Sequence', sub: 'Team card-game classics' },
      { emoji: '🎲', title: 'Ludo', sub: 'Race your tokens home' },
      { emoji: '🏠', title: 'Business', sub: 'Buy, trade and bankrupt friends' },
      { emoji: '♟️', title: 'Chess & Words', sub: 'Quick duels and word races' },
    ],
  },
];

export interface SpreadPoster {
  id: SpreadVariantId;
  label: string;
  emoji: string;
  blob: Blob;
}

export async function renderSpreadCard(id: SpreadVariantId, seed = Date.now()): Promise<Blob> {
  const v = SPREAD_VARIANTS.find((x) => x.id === id) || SPREAD_VARIANTS[0];
  await fontsReady();
  const { canvas, ctx } = newPosterCanvas();
  const rnd = seeded(seed + v.id.charCodeAt(0) * 131);
  paintBackground(ctx, v.glow, Math.floor(rnd() * 1e9));
  paintLogoBadge(ctx);

  // Big faded emoji watermark behind the tiles
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.font = `520px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(v.emoji, W / 2 + 170, 960);
  ctx.restore();

  // ---- Headline ----
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(fitText(ctx, v.headline[0], W - 120, 100, '900', 56), W / 2, 280);
  const accent = ctx.createLinearGradient(W / 2 - 300, 0, W / 2 + 300, 0);
  accent.addColorStop(0, v.accent[0]);
  accent.addColorStop(1, v.accent[1]);
  ctx.save();
  ctx.shadowColor = `rgba(${v.glow}, 0.5)`;
  ctx.shadowBlur = 30;
  ctx.fillStyle = accent;
  ctx.fillText(fitText(ctx, v.headline[1], W - 120, 100, '900', 56), W / 2, 386);
  ctx.restore();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  const tagline = v.taglines[Math.floor(rnd() * v.taglines.length)];
  ctx.fillText(fitText(ctx, tagline, W - 140, 32, '600', 22), W / 2, 442);

  // ---- Feature tiles (4–6), two per row; an odd last tile is centred ----
  const tiles = v.tiles.slice(0, 6);
  const rows = Math.ceil(tiles.length / 2);
  const gap = 22;
  const areaTop = 490;
  const areaBottom = 1040;
  const tileH = Math.min(220, (areaBottom - areaTop - (rows - 1) * gap) / rows);
  const tileW = (W - 140 - gap) / 2;
  tiles.forEach((tile, i) => {
    const row = Math.floor(i / 2);
    const isLoneLast = i === tiles.length - 1 && tiles.length % 2 === 1;
    const x = isLoneLast ? (W - tileW) / 2 : 70 + (i % 2) * (tileW + gap);
    const y = areaTop + row * (tileH + gap);
    const cy = y + tileH / 2;

    ctx.save();
    roundRectPath(ctx, x, y, tileW, tileH, 32);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x + 62, cy, 40, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${v.glow}, 0.22)`;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `46px ${EMOJI_FONT}`;
    ctx.fillText(tile.emoji, x + 62, cy + 16);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fitText(ctx, tile.title, tileW - 130, 34, '800', 22), x + 120, cy - 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.font = `600 23px ${FONT}`;
    wrapLines(ctx, tile.sub, tileW - 140, 2).forEach((l, li) => ctx.fillText(l, x + 120, cy + 24 + li * 28));
  });

  paintInstallFooter(ctx, 'Try it free 👉');
  return canvasToPng(canvas);
}

// Draws the whole set afresh — called every time the user taps Share.
export async function renderAllSpreadCards(): Promise<SpreadPoster[]> {
  const seed = Date.now();
  const posters: SpreadPoster[] = [];
  for (const v of SPREAD_VARIANTS) {
    posters.push({ id: v.id, label: v.label, emoji: v.emoji, blob: await renderSpreadCard(v.id, seed) });
  }
  return posters;
}
