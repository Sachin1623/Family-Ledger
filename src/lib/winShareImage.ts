// Draws the "I won!" brag card shared from a game's win screen — a 1080x1350 (4:5) PNG, the ratio
// Instagram/Facebook feeds and WhatsApp all show without cropping. Each card carries artwork from the
// game itself (see gameArt.ts), the winner and standings, and a scannable Play Store QR code.
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, seeded, newPosterCanvas, canvasToPng, fontsReady,
  paintBackground, paintLogoBadge, paintInstallFooter, installLinksText,
} from './cardCanvas';
import { drawGameArt, artForGame, GameArtKind } from './gameArt';

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
}

export async function renderWinCard(opts: WinCardOptions): Promise<Blob> {
  await fontsReady();
  const { canvas, ctx } = newPosterCanvas();

  paintBackground(ctx, '255, 196, 61', 20261013, 300);

  // Light rays fanning out from the trophy
  ctx.save();
  ctx.translate(W / 2, 290);
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
    ctx.translate(rnd() * W, rnd() * 700);
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

  // ---- The game's own artwork either side of the trophy ----
  drawGameArt(ctx, opts.art ?? artForGame(opts.gameName));

  // ---- Trophy ----
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `230px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('🏆', W / 2, 352);

  // ---- VICTORY ----
  const gold = ctx.createLinearGradient(0, 390, 0, 490);
  gold.addColorStop(0, '#FFE58A');
  gold.addColorStop(0.5, '#FFC93C');
  gold.addColorStop(1, '#F0961E');
  ctx.save();
  ctx.shadowColor = 'rgba(255, 170, 40, 0.55)';
  ctx.shadowBlur = 36;
  ctx.fillStyle = gold;
  ctx.font = `900 124px ${FONT}`;
  (ctx as any).letterSpacing = '8px';
  ctx.fillText('VICTORY!', W / 2, 482);
  ctx.restore();
  (ctx as any).letterSpacing = '0px';

  // ---- Who won what ----
  ctx.fillStyle = '#FFFFFF';
  const winnerText = fitText(ctx, opts.winnerLabel, W - 160, 60, '800');
  ctx.fillText(winnerText, W / 2, 556);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = `600 36px ${FONT}`;
  ctx.fillText(`conquered ${opts.gameName}`, W / 2, 604);

  // ---- Standings panel ----
  const rows = opts.standings.slice(0, 4);
  const rowH = rows.length <= 2 ? 112 : rows.length === 3 ? 96 : 80;
  const panelX = 90;
  const panelW = W - 180;
  const panelY = 640;
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
  rows.forEach((row, i) => {
    const cy = panelY + 16 + i * rowH + rowH / 2; // row centre line
    if (row.isWinner) {
      roundRectPath(ctx, panelX + 14, cy - 36, panelW - 28, 72, 24);
      const hl = ctx.createLinearGradient(panelX, 0, panelX + panelW, 0);
      hl.addColorStop(0, 'rgba(255, 201, 60, 0.38)');
      hl.addColorStop(1, 'rgba(255, 201, 60, 0.12)');
      ctx.fillStyle = hl;
      ctx.fill();
    }
    ctx.textAlign = 'left';
    ctx.font = `42px ${EMOJI_FONT}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(medals[i] ?? '🎖️', panelX + 34, cy + 15);

    ctx.fillStyle = row.isWinner ? '#FFE58A' : '#FFFFFF';
    const rowName = fitText(ctx, row.name, row.score !== undefined ? 360 : 560, 36, row.isWinner ? '800' : '600');
    ctx.fillText(rowName, panelX + 110, cy + 13);

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
      ctx.font = `800 38px ${FONT}`;
      ctx.fillText(`${row.score}`, panelX + panelW - 100, cy + 13);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText(unit, panelX + panelW - 38, cy + 13);
    } else if (row.label) {
      ctx.textAlign = 'right';
      ctx.fillStyle = row.isWinner ? '#FFE58A' : 'rgba(255, 255, 255, 0.8)';
      ctx.font = `700 30px ${FONT}`;
      ctx.fillText(fitText(ctx, row.label, 300, 30, '700', 22), panelX + panelW - 38, cy + 11);
    }
  });
  ctx.textAlign = 'center';

  if (opts.detail) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(fitText(ctx, opts.detail, W - 140, 30, '600', 22), W / 2, panelY + panelH + 46);
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
