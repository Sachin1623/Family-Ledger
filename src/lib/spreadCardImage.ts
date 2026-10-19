// The "Spread the Word" posters — a set of themed 1080x1350 images (everything, money, health,
// family, games), each leading with a different reason to install and carrying 4 to 6 features.
// A fresh set is drawn every time the user taps Share, so they can pick the one that fits who
// they're sending it to. Same brand look as the win cards; every poster has a Play Store QR code.
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, wrapLines, seeded, newPosterCanvas, canvasToPng, canvasToJpeg, fontsReady,
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


// ---- Weekly editions ----------------------------------------------------------------------------------------------------------------
// A new set of posters every week. Each edition changes the wording (one line from the bank below), which feature tiles lead and which
// are shown, a "This week" spotlight and a slight shift of the glow colour, so the pictures people share are never the same two weeks
// running. Editions are drawn ahead of time (scripts/generate-spread-posters.mjs) and the app shows the one for the current week.
export const SPREAD_EDITIONS = 12;

const WEEKLY_TAGLINES: Record<SpreadVariantId, string[]> = {
  all: [
    'Money, health, chats and games — together', 'Everything your household needs in one place', 'The family app that actually gets used',
    'Bills, doses, chats and game night — sorted', 'One shared home for the whole family', 'Less juggling, more together time',
    'Your family’s day, in one app', 'From groceries to game night', 'Simple tools for a busy household',
    'Everyone on the same page, finally', 'Free, private and made for families', 'Plan it, split it, share it — together',
  ],
  money: [
    'Shared money for families, flatmates and friends', 'No more chasing who owes who', 'Know where every rupee went',
    'Rent, groceries, trips — all split fairly', 'Budgets that the whole house can see', 'Set it once, bills log themselves',
    'Save together, reach goals faster', 'Settle up in one tap', 'Trips, dinners, flat bills — sorted',
    'See the month at a glance', 'Fair splits without the awkward chat', 'Track it together, stress less',
  ],
  health: [
    'Records and reminders everyone can rely on', 'Care for the people you love, together', 'Never miss a dose again',
    'Every reading, in one trusted place', 'Baby’s vaccine dates, remembered for you', 'Share with family, stay in control',
    'Healthy habits, tracked with ease', 'Reports your doctor will appreciate', 'Peace of mind for the whole family',
    'Reminders that actually ring', 'BP and sugar, trends at a glance', 'Looking after each other, made simpler',
  ],
  family: [
    'One shared space for the whole household', 'Less nagging, more getting things done', 'Shopping lists everyone can tick off',
    'Chores, plans and reminders — shared', 'Your household’s group chat and to-dos', 'Run the home together, calmly',
    'Everyone knows what’s next', 'Plans that don’t get lost in chats', 'Small tasks, big difference at home',
    'Together is easier', 'The household hub for busy families', 'Share the load, share the list',
  ],
  games: [
    'Play with family anywhere — no real-money wagering', 'Classic games, new memories', 'Game night, wherever you are',
    'Rummy, Ludo, Chess — with the people you love', 'Challenge cousins across cities', 'Quick rounds, long-lasting fun',
    'Bring the family table to your phone', 'Laugh, compete, repeat', 'Free games, zero wagering',
    'Beat the bots or beat your brother', 'Word races and card classics', 'Pull up a chair — it’s game time',
  ],
};

// Turns the glow colour a little for each edition, so the pictures look different at a glance.
function shiftGlow(glow: string, edition: number): string {
  const [r, g, b] = glow.split(',').map((n) => Number(n.trim()));
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r / 255) h = ((g / 255 - b / 255) / d) % 6;
    else if (max === g / 255) h = (b / 255 - r / 255) / d + 2;
    else h = (r / 255 - g / 255) / d + 4;
  }
  h = ((h * 60 + (edition % 4) * 14) % 360 + 360) % 360;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r1, g1, b1].map((n) => Math.round((n + m) * 255)).join(', ');
}

export interface SpreadPoster {
  id: SpreadVariantId;
  label: string;
  emoji: string;
  blob: Blob;
}

export async function renderSpreadCard(id: SpreadVariantId, seed = Date.now(), edition?: number, asJpeg = false): Promise<Blob> {
  const base = SPREAD_VARIANTS.find((x) => x.id === id) || SPREAD_VARIANTS[0];
  // An edition (a particular week) rotates which tiles lead, picks that week's wording and shifts the glow colour.
  const weekly = edition !== undefined;
  const rotate = weekly ? edition % base.tiles.length : 0;
  const v: SpreadVariant = weekly
    ? { ...base, glow: shiftGlow(base.glow, edition), tiles: [...base.tiles.slice(rotate), ...base.tiles.slice(0, rotate)] }
    : base;
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
  const tagline = weekly ? WEEKLY_TAGLINES[v.id][edition % WEEKLY_TAGLINES[v.id].length] : v.taglines[Math.floor(rnd() * v.taglines.length)];
  ctx.fillText(fitText(ctx, tagline, W - 140, 32, '600', 22), W / 2, 442);

  // The weekly spotlight: the feature leading this week's poster.
  if (weekly) {
    const spot = `✨ This week: ${v.tiles[0].title}`;
    ctx.font = `800 24px ${FONT}`;
    const pw = Math.min(W - 200, ctx.measureText(spot).width + 56);
    roundRectPath(ctx, W / 2 - pw / 2, 466, pw, 44, 22);
    ctx.fillStyle = `rgba(${v.glow}, 0.28)`;
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fitText(ctx, spot, pw - 28, 24, '800', 16), W / 2, 497);
  }

  // ---- Feature tiles (4–6), two per row; an odd last tile is centred ----
  const tiles = v.tiles.slice(0, 6);
  const rows = Math.ceil(tiles.length / 2);
  const gap = 22;
  const areaTop = weekly ? 538 : 490;
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
  return asJpeg ? canvasToJpeg(canvas) : canvasToPng(canvas);
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
