// Draws the "I won!" brag card shared from a game's win screen — a 1080x1350 (4:5) PNG, the ratio
// Instagram/Facebook feeds and WhatsApp all show without cropping. Each card carries artwork from the
// game itself (see gameArt.ts), the winner and standings, and a scannable Play Store QR code. Games
// whose result looks good on show (rummy hands, the Ludo board) can pass a `hero` picture (winHero.ts).
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, seeded, newPosterCanvas, canvasToPng, fontsReady,
  paintBackground, paintLogoBadge, paintInstallFooter, installLinksText,
} from './cardCanvas';
import { drawGameArt, artForGame, GameArtKind } from './gameArt';
import { drawWinHero, WinHero } from './winHero';

export type { WinHero, HeroGroup } from './winHero';

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
  art?: GameArtKind;         // defaults from the game name
  hero?: WinHero;            // a big picture of the result (winning hand / Ludo board)
  winnerPhotoURL?: string;   // the winner's profile picture, drawn big in a gold ring (initial letter if it can't be loaded)
}

// The game's name, big and bold in gold — the card is shared on its own, so what was played has to read at a glance.
function drawGameName(ctx: CanvasRenderingContext2D, name: string, y: number, size: number) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(255, 170, 40, 0.7)';
  ctx.shadowBlur = 22;
  ctx.fillStyle = '#FFD24D';
  ctx.font = `900 ${size}px ${FONT}`;
  (ctx as any).letterSpacing = '6px';
  ctx.fillText(fitText(ctx, name.toUpperCase(), W - 140, size, '900', 28), W / 2, y);
  (ctx as any).letterSpacing = '0px';
  ctx.restore();
}

// Loads a profile picture for the canvas. Resolves null on any failure (blocked, offline, no CORS) so the card
// still renders — with the winner's initial in its place.
function loadPhoto(url?: string): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 4000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

// The two things people look at first on a shared win: WHO (profile picture in a gold ring) and HOW MUCH (the
// winner's score as a big gold badge). Left and right of the trophy, so they read before anything else.
function drawWinnerBadges(ctx: CanvasRenderingContext2D, opts: WinCardOptions, photo: HTMLImageElement | null, cy: number) {
  // avatar
  const ax = 190;
  const r = 84;
  ctx.save();
  ctx.shadowColor = 'rgba(255, 190, 60, 0.85)';
  ctx.shadowBlur = 34;
  ctx.beginPath();
  ctx.arc(ax, cy, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = '#FFC93C';
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (photo) {
    const side = Math.min(photo.naturalWidth || photo.width, photo.naturalHeight || photo.height);
    ctx.drawImage(photo, ((photo.naturalWidth || photo.width) - side) / 2, ((photo.naturalHeight || photo.height) - side) / 2, side, side, ax - r, cy - r, r * 2, r * 2);
  } else {
    const g = ctx.createLinearGradient(ax - r, cy - r, ax + r, cy + r);
    g.addColorStop(0, '#6F86B3');
    g.addColorStop(1, '#2E3F6B');
    ctx.fillStyle = g;
    ctx.fillRect(ax - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.font = `900 92px ${FONT}`;
    ctx.fillText((opts.winnerLabel.trim()[0] || '?').toUpperCase(), ax, cy + 32);
  }
  ctx.restore();

  // score badge
  const win = opts.standings.find((x) => x.isWinner) ?? opts.standings[0];
  if (!win) return;
  const bx = W - 190;
  let big = '';
  let unit = '';
  if (win.score !== undefined) {
    big = win.score.toLocaleString('en-US');
    unit = (opts.scoreUnit ?? 'pts').toUpperCase();
  } else if (win.label) {
    const m = win.label.match(/^([\d][\d,.]*)\s*(.*)$/);
    if (m) {
      big = m[1];
      unit = (m[2] || '').toUpperCase();
    } else {
      big = win.label;
    }
  }
  if (!big) return;
  const bw = 250;
  const bh = unit ? 152 : 112;
  ctx.save();
  ctx.shadowColor = 'rgba(255, 190, 60, 0.7)';
  ctx.shadowBlur = 28;
  roundRectPath(ctx, bx - bw / 2, cy - bh / 2, bw, bh, 34);
  const bg = ctx.createLinearGradient(0, cy - bh / 2, 0, cy + bh / 2);
  bg.addColorStop(0, '#FFE08A');
  bg.addColorStop(1, '#F5A623');
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#3A2300';
  const numSize = big.length > 7 ? 44 : big.length > 5 ? 62 : 80;
  ctx.font = `900 ${numSize}px ${FONT}`;
  ctx.fillText(fitText(ctx, big, bw - 28, numSize, '900', 28), bx, unit ? cy + 8 : cy + numSize * 0.35);
  if (unit) {
    ctx.font = `800 28px ${FONT}`;
    ctx.fillStyle = 'rgba(58, 35, 0, 0.8)';
    (ctx as any).letterSpacing = '4px';
    ctx.fillText(fitText(ctx, unit, bw - 28, 28, '800', 18), bx, cy + 52);
    (ctx as any).letterSpacing = '0px';
  }
}

export async function renderWinCard(opts: WinCardOptions): Promise<Blob> {
  await fontsReady();
  const photo = await loadPhoto(opts.winnerPhotoURL);
  const { canvas, ctx } = newPosterCanvas();
  const hero = opts.hero;

  paintBackground(ctx, '255, 196, 61', 20261013, hero ? 260 : 300);

  // Light rays fanning out from the trophy
  ctx.save();
  ctx.translate(W / 2, hero ? 230 : 290);
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
  for (let i = 0; i < 80; i++) {
    ctx.save();
    ctx.translate(rnd() * W, rnd() * (hero ? 480 : 700));
    ctx.rotate(rnd() * Math.PI);
    ctx.globalAlpha = 0.35 + rnd() * 0.55;
    ctx.fillStyle = confettiColors[Math.floor(rnd() * confettiColors.length)];
    const w = 8 + rnd() * 14;
    const h = 5 + rnd() * 9;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  paintLogoBadge(ctx);
  ctx.textAlign = 'center';

  const gold = (y0: number, y1: number) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#FFE58A');
    g.addColorStop(0.5, '#FFC93C');
    g.addColorStop(1, '#F0961E');
    return g;
  };

  // Standings panel — shared by both layouts.
  const drawStandings = (rows: typeof opts.standings, panelY: number, rowH: number) => {
    const panelX = 90;
    const panelW = W - 180;
    const panelH = rows.length * rowH + 32;
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
    const k = Math.min(1, rowH / 80);
    rows.forEach((row, i) => {
      const cy = panelY + 16 + i * rowH + rowH / 2;
      if (row.isWinner) {
        roundRectPath(ctx, panelX + 14, cy - rowH * 0.45, panelW - 28, rowH * 0.9, 24);
        const hl = ctx.createLinearGradient(panelX, 0, panelX + panelW, 0);
        hl.addColorStop(0, 'rgba(255, 201, 60, 0.38)');
        hl.addColorStop(1, 'rgba(255, 201, 60, 0.12)');
        ctx.fillStyle = hl;
        ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.font = `${Math.round(42 * k)}px ${EMOJI_FONT}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(medals[i] ?? '🎖️', panelX + 34, cy + 15 * k);

      ctx.fillStyle = row.isWinner ? '#FFE58A' : '#FFFFFF';
      const rowName = fitText(ctx, row.name, row.score !== undefined ? 360 : 560, Math.round(36 * k), row.isWinner ? '800' : '600', 22);
      ctx.fillText(rowName, panelX + 110, cy + 13 * k);

      if (row.score !== undefined) {
        const barX = panelX + 500;
        const barW = 170;
        roundRectPath(ctx, barX, cy - 8, barW, 14, 7);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.fill();
        roundRectPath(ctx, barX, cy - 8, Math.max(14, (barW * Math.max(0, row.score)) / maxScore), 14, 7);
        ctx.fillStyle = row.isWinner ? '#FFC93C' : 'rgba(255, 255, 255, 0.55)';
        ctx.fill();
        ctx.textAlign = 'right';
        ctx.fillStyle = row.isWinner ? '#FFE58A' : '#FFFFFF';
        ctx.font = `800 ${Math.round(38 * k)}px ${FONT}`;
        ctx.fillText(`${row.score}`, panelX + panelW - 100, cy + 13 * k);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.font = `600 24px ${FONT}`;
        ctx.fillText(unit, panelX + panelW - 38, cy + 13 * k);
      } else if (row.label) {
        ctx.textAlign = 'right';
        ctx.fillStyle = row.isWinner ? '#FFE58A' : 'rgba(255, 255, 255, 0.8)';
        ctx.font = `700 ${Math.round(30 * k)}px ${FONT}`;
        ctx.fillText(fitText(ctx, row.label, 300, Math.round(30 * k), '700', 20), panelX + panelW - 38, cy + 11 * k);
      }
    });
    ctx.textAlign = 'center';
    return panelY + panelH;
  };

  if (hero) {
    // ---- Hero layout: trophy + VICTORY, the winner, a big picture of the result, compact standings ----
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `120px ${EMOJI_FONT}`;
    ctx.fillText('🏆', W / 2, 252);
    drawWinnerBadges(ctx, opts, photo, 196);

    ctx.save();
    ctx.shadowColor = 'rgba(255, 170, 40, 0.55)';
    ctx.shadowBlur = 36;
    ctx.fillStyle = gold(280, 370);
    ctx.font = `900 104px ${FONT}`;
    (ctx as any).letterSpacing = '8px';
    ctx.fillText('VICTORY!', W / 2, 362);
    ctx.restore();
    (ctx as any).letterSpacing = '0px';

    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fitText(ctx, opts.winnerLabel, W - 160, 54, '800'), W / 2, 428);
    drawGameName(ctx, opts.gameName, 484, 52);
    if (opts.detail) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(fitText(ctx, opts.detail, W - 140, 26, '600', 20), W / 2, 520);
    }

    drawWinHero(ctx, { x: 60, y: 536, w: W - 120, h: 304 }, hero);

    const rows = opts.standings.slice(0, 3);
    drawStandings(rows, 856, rows.length <= 2 ? 78 : 62);
  } else {
    // ---- Classic layout: the game's own artwork either side of the trophy ----
    drawWinnerBadges(ctx, opts, photo, 300);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `230px ${EMOJI_FONT}`;
    ctx.fillText('🏆', W / 2, 352);

    ctx.save();
    ctx.shadowColor = 'rgba(255, 170, 40, 0.55)';
    ctx.shadowBlur = 36;
    ctx.fillStyle = gold(390, 490);
    ctx.font = `900 124px ${FONT}`;
    (ctx as any).letterSpacing = '8px';
    ctx.fillText('VICTORY!', W / 2, 482);
    ctx.restore();
    (ctx as any).letterSpacing = '0px';

    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fitText(ctx, opts.winnerLabel, W - 160, 60, '800'), W / 2, 556);
    drawGameName(ctx, opts.gameName, 618, 62);

    const rows = opts.standings.slice(0, 4);
    const rowH = rows.length <= 2 ? 112 : rows.length === 3 ? 96 : 80;
    const bottom = drawStandings(rows, 650, rowH);
    if (opts.detail) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
      ctx.font = `600 30px ${FONT}`;
      ctx.fillText(fitText(ctx, opts.detail, W - 140, 30, '600', 22), W / 2, bottom + 46);
    }
  }

  paintInstallFooter(ctx, 'Beat me! 😎');
  return canvasToPng(canvas);
}

// Everything a game's win screen needs for its "Share my win" button: the card plus the ready-made
// post text, with the Play Store and web links (an image itself can't be tapped).
export function buildWinShare(opts: WinCardOptions & { scoreLine?: string }): { card: WinCardOptions; caption: string } {
  const { scoreLine, ...card } = opts;
  return {
    card,
    caption:
      `🏆 I just won ${opts.gameName} on FamilyLedger${scoreLine ? ` — ${scoreLine}` : ''}! Think you can beat me? 😎\n\n` +
      installLinksText(),
  };
}
