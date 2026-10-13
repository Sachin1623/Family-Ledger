// Draws the "I won!" brag card shared from a game's win screen — a 1080x1350 (4:5) PNG, the ratio
// Instagram/Facebook feeds and WhatsApp all show without cropping. Pure canvas (no html2canvas, no
// remote images) so it renders identically everywhere and never trips CORS-tainted-canvas errors.

export interface WinCardStanding {
  name: string;
  // Higher-is-better numeric score — drawn as a bar plus the number. Leave it out for games without
  // one (or where lower is better) and give `label` instead, which is simply shown on the right.
  score?: number;
  label?: string;
  isWinner: boolean;
}

export interface WinCardOptions {
  gameName: string;          // e.g. "Spade Pledge"
  winnerLabel: string;       // e.g. "Sachin" or "Sachin & Priya"
  standings: WinCardStanding[]; // best first
  scoreUnit?: string;        // "pts"
  detail?: string;           // e.g. "Won in 22 hands · first to 300"
}

const W = 1080;
const H = 1350;
const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Shrinks the font until `text` fits `maxWidth`, then truncates with an ellipsis as a last resort.
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number, weight: string, minSize = 24): string {
  let size = startSize;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  let out = text;
  while (ctx.measureText(out).width > maxWidth && out.length > 1) out = out.slice(0, -1);
  return out === text ? text : `${out.trimEnd()}…`;
}

// The FamilyLedger logo (same artwork as public/logo.svg: the green→blue ledger icon with the
// family silhouettes, plus the "Family / Ledger" wordmark), drawn straight onto the canvas in the
// logo's own 400x120 coordinate space so it stays crisp at any size and needs no image loading.
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  const icon = ctx.createLinearGradient(10, 10, 90, 110);
  icon.addColorStop(0, '#4ADE80');
  icon.addColorStop(1, '#3B82F6');
  roundRectPath(ctx, 10, 10, 80, 100, 12);
  ctx.fillStyle = icon;
  ctx.fill();
  ctx.fillStyle = '#1E3A8A';
  ctx.fill(new Path2D('M70 40C70 36.6863 72.6863 34 76 34H90V86H76C72.6863 86 70 83.3137 70 80V40Z'));

  const white = (a: number) => `rgba(255,255,255,${a})`;
  ctx.fillStyle = white(0.9);
  ctx.beginPath(); ctx.arc(35, 40, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fill(new Path2D('M25 50C25 48.8954 25.8954 48 27 48H43C44.1046 48 45 48.8954 45 50V75H25V50Z'));
  ctx.fillStyle = white(0.8);
  ctx.beginPath(); ctx.arc(55, 45, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fill(new Path2D('M48 52C48 50.8954 48.8954 50 50 50H60C61.1046 50 62 50.8954 62 52V75H48V52Z'));
  ctx.fillStyle = white(1);
  ctx.beginPath(); ctx.arc(45, 70, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fill(new Path2D('M40 75C40 74.4477 40.4477 74 41 74H49C49.5523 74 50 74.4477 50 75V85H40V75Z'));
  ctx.beginPath(); ctx.arc(65, 72, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fill(new Path2D('M60 77C60 76.4477 60.4477 76 61 76H69C69.5523 76 70 76.4477 70 77V85H60V77Z'));

  ctx.textAlign = 'left';
  (ctx as any).letterSpacing = '-1px';
  ctx.font = `900 44px ${FONT}`;
  ctx.fillStyle = '#0F172A';
  ctx.fillText('Family', 110, 55);
  const word = ctx.createLinearGradient(110, 70, 110, 110);
  word.addColorStop(0, '#0284C7');
  word.addColorStop(1, '#3B82F6');
  ctx.fillStyle = word;
  ctx.fillText('Ledger', 110, 95);
  (ctx as any).letterSpacing = '0px';
  ctx.restore();
}

// Small deterministic PRNG so the confetti is the same every render of the same card.
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export async function renderWinCard(opts: WinCardOptions): Promise<Blob> {
  try {
    await (document as any).fonts?.ready;
  } catch {
    /* fonts API unavailable — system fallback is fine */
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available on this device.');

  // ---- Background: deep navy with a warm spotlight behind the trophy ----
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#06263D');
  bg.addColorStop(0.55, '#0A3B5C');
  bg.addColorStop(1, '#04192A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, 300, 40, W / 2, 300, 600);
  glow.addColorStop(0, 'rgba(255, 196, 61, 0.45)');
  glow.addColorStop(0.5, 'rgba(255, 150, 40, 0.12)');
  glow.addColorStop(1, 'rgba(255, 150, 40, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Light rays fanning out from the trophy
  ctx.save();
  ctx.translate(W / 2, 300);
  for (let i = 0; i < 14; i++) {
    ctx.rotate((Math.PI * 2) / 14);
    const ray = ctx.createLinearGradient(0, 0, 0, -760);
    ray.addColorStop(0, 'rgba(255, 214, 102, 0.16)');
    ray.addColorStop(1, 'rgba(255, 214, 102, 0)');
    ctx.fillStyle = ray;
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.lineTo(26, 0);
    ctx.lineTo(70, -760);
    ctx.lineTo(-70, -760);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Confetti
  const rnd = seeded(20261013);
  const confettiColors = ['#FFC93C', '#2EE6A6', '#FF6B8B', '#6FB7FF', '#FFFFFF'];
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W;
    const y = rnd() * 760;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * Math.PI);
    ctx.globalAlpha = 0.35 + rnd() * 0.55;
    ctx.fillStyle = confettiColors[Math.floor(rnd() * confettiColors.length)];
    const w = 8 + rnd() * 14;
    const h = 5 + rnd() * 9;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // Giant card-suit watermarks in the lower corners
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 520px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('♠', -70, H + 40);
  ctx.textAlign = 'right';
  ctx.fillText('♥', W + 70, H + 40);
  ctx.restore();

  ctx.textAlign = 'center';

  // ---- Header ----
  // Logo on a white badge — the wordmark is dark navy, so it needs a light ground to stay legible.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, W / 2 - 190, 26, 380, 112, 56);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();
  drawLogo(ctx, W / 2 - 150, 38, 0.75);
  ctx.textAlign = 'center';

  // ---- Trophy ----
  ctx.font = `250px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.fillText('🏆', W / 2, 385);

  // ---- VICTORY ----
  const gold = ctx.createLinearGradient(0, 430, 0, 540);
  gold.addColorStop(0, '#FFE58A');
  gold.addColorStop(0.5, '#FFC93C');
  gold.addColorStop(1, '#F0961E');
  ctx.save();
  ctx.shadowColor = 'rgba(255, 170, 40, 0.55)';
  ctx.shadowBlur = 36;
  ctx.fillStyle = gold;
  ctx.font = `900 140px ${FONT}`;
  (ctx as any).letterSpacing = '10px';
  ctx.fillText('VICTORY!', W / 2, 545);
  ctx.restore();
  (ctx as any).letterSpacing = '0px';

  // ---- Who won what ----
  ctx.fillStyle = '#FFFFFF';
  const winnerText = fitText(ctx, opts.winnerLabel, W - 160, 64, '800'); // also leaves ctx.font at the fitted size
  ctx.fillText(winnerText, W / 2, 625);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = `600 38px ${FONT}`;
  ctx.fillText(`conquered ${opts.gameName}`, W / 2, 676);

  // ---- Standings panel ----
  const rows = opts.standings.slice(0, 4);
  const rowH = rows.length <= 2 ? 124 : rows.length === 3 ? 104 : 88; // fewer rows → roomier rows, so the card never looks half empty
  const panelX = 90;
  const panelW = W - 180;
  const panelY = 725;
  const panelH = rows.length * rowH + 40;
  ctx.save();
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 36);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.stroke();
  ctx.restore();

  const maxScore = Math.max(1, ...rows.map((r) => r.score ?? 0));
  const medals = ['🥇', '🥈', '🥉', '🎖️'];
  const unit = opts.scoreUnit ?? 'pts';
  rows.forEach((row, i) => {
    const y = panelY + 20 + i * rowH + (rowH - 88) / 2;
    if (row.isWinner) {
      roundRectPath(ctx, panelX + 14, y + 4, panelW - 28, 80, 26);
      const hl = ctx.createLinearGradient(panelX, 0, panelX + panelW, 0);
      hl.addColorStop(0, 'rgba(255, 201, 60, 0.38)');
      hl.addColorStop(1, 'rgba(255, 201, 60, 0.12)');
      ctx.fillStyle = hl;
      ctx.fill();
    }
    ctx.textAlign = 'left';
    ctx.font = `44px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(medals[i] ?? '🎖️', panelX + 34, y + 58);

    ctx.fillStyle = row.isWinner ? '#FFE58A' : '#FFFFFF';
    const rowName = fitText(ctx, row.name, row.score !== undefined ? 360 : 560, 38, row.isWinner ? '800' : '600');
    ctx.fillText(rowName, panelX + 110, y + 56);

    if (row.score !== undefined) {
      // score bar
      const barX = panelX + 500;
      const barW = 170;
      roundRectPath(ctx, barX, y + 34, barW, 14, 7);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fill();
      roundRectPath(ctx, barX, y + 34, Math.max(14, (barW * Math.max(0, row.score)) / maxScore), 14, 7);
      ctx.fillStyle = row.isWinner ? '#FFC93C' : 'rgba(255, 255, 255, 0.55)';
      ctx.fill();

      ctx.textAlign = 'right';
      ctx.fillStyle = row.isWinner ? '#FFE58A' : '#FFFFFF';
      ctx.font = `800 40px ${FONT}`;
      ctx.fillText(`${row.score}`, panelX + panelW - 100, y + 56);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText(unit, panelX + panelW - 38, y + 56);
    } else if (row.label) {
      ctx.textAlign = 'right';
      ctx.fillStyle = row.isWinner ? '#FFE58A' : 'rgba(255, 255, 255, 0.8)';
      ctx.font = `700 32px ${FONT}`;
      ctx.fillText(fitText(ctx, row.label, 300, 32, '700', 22), panelX + panelW - 38, y + 54);
    }
  });
  ctx.textAlign = 'center';

  if (opts.detail) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = `600 32px ${FONT}`;
    ctx.fillText(opts.detail, W / 2, panelY + panelH + 56);
  }

  // ---- Footer / call to action ----
  const ctaY = H - 150;
  roundRectPath(ctx, W / 2 - 330, ctaY, 660, 84, 42);
  const cta = ctx.createLinearGradient(W / 2 - 330, 0, W / 2 + 330, 0);
  cta.addColorStop(0, '#22C55E');
  cta.addColorStop(1, '#14B8A6');
  ctx.fillStyle = cta;
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 36px ${FONT}`;
  ctx.fillText('Think you can beat me? 😎', W / 2, ctaY + 54);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = `600 28px ${FONT}`;
  ctx.fillText('Get it free on Google Play · familyledger.thirteenapps.com', W / 2, H - 38);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png');
  });
}

// Everything a game's win screen needs for its "Share my win" button: the card plus the ready-made
// post text (with the install links, since an image itself can't be tapped).
export function buildWinShare(opts: WinCardOptions & { scoreLine?: string }): { card: WinCardOptions; caption: string } {
  const { scoreLine, ...card } = opts;
  return {
    card,
    caption:
      `🏆 I just won ${opts.gameName} on FamilyLedger${scoreLine ? ` — ${scoreLine}` : ''}! Think you can beat me? 😎

` +
      `📲 Install FamilyLedger free on Android: https://play.google.com/store/apps/details?id=com.familyledger.app
` +
      `🌐 Or use it on the web: https://familyledger.thirteenapps.com`,
  };
}
