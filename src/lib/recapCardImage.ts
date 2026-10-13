// The weekly-recap share image: a 1080x1350 poster with the user's own numbers for the week. What it
// features depends on where that person was most engaged (see recapFeatures.ts) — at least six
// different features, most-used first. Drawn on the fly in the same brand style as the other pictures.
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, wrapLines, newPosterCanvas, canvasToPng, fontsReady,
  paintBackground, paintLogoBadge, paintInstallFooter,
} from './cardCanvas';
import { RecapView } from './recapFeatures';

export interface RecapCardInput {
  periodLabel: string;
  kudos: string;
  view: RecapView;
}

export async function renderRecapCard({ periodLabel, kudos, view }: RecapCardInput): Promise<Blob> {
  await fontsReady();
  const { canvas, ctx } = newPosterCanvas();
  paintBackground(ctx, '255, 196, 61', 20261014);
  paintLogoBadge(ctx);

  // ---- Title block ----
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFC93C';
  ctx.font = `800 26px ${FONT}`;
  (ctx as any).letterSpacing = '6px';
  ctx.fillText(`MY WEEK ON FAMILYLEDGER  ·  ${periodLabel.toUpperCase()}`, W / 2, 190);
  (ctx as any).letterSpacing = '0px';

  const gold = ctx.createLinearGradient(W / 2 - 320, 0, W / 2 + 320, 0);
  gold.addColorStop(0, '#FFE58A');
  gold.addColorStop(1, '#FFA629');
  ctx.save();
  ctx.shadowColor = 'rgba(255, 170, 40, 0.5)';
  ctx.shadowBlur = 28;
  ctx.fillStyle = gold;
  ctx.fillText(fitText(ctx, view.headline, W - 120, 84, '900', 48), W / 2, 282);
  ctx.restore();

  if (view.focus) {
    const label = `🔥 Most engaged: ${view.focus}`;
    ctx.font = `800 28px ${FONT}`;
    const pw = ctx.measureText(label).width + 56;
    roundRectPath(ctx, W / 2 - pw / 2, 304, pw, 52, 26);
    ctx.fillStyle = 'rgba(255, 201, 60, 0.2)';
    ctx.fill();
    ctx.fillStyle = '#FFE58A';
    ctx.fillText(label, W / 2, 340);
  }

  // ---- Kudos ----
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.font = `600 30px ${FONT}`;
  const kudosLines = wrapLines(ctx, kudos, W - 200, 2);
  kudosLines.forEach((l, i) => ctx.fillText(l, W / 2, 404 + i * 40));

  // ---- Feature tiles: 6 to 8, two per row, most-engaged first ----
  const feats = view.features.slice(0, 8);
  const rows = Math.ceil(feats.length / 2);
  const gap = 18;
  const areaTop = 404 + kudosLines.length * 40 + 8;
  const areaBottom = 1050;
  const tileH = Math.min(150, (areaBottom - areaTop - (rows - 1) * gap) / rows);
  const tileW = (W - 140 - gap) / 2;
  const k = tileH / 140; // scale fonts with the tile height

  feats.forEach((f, i) => {
    const x = 70 + (i % 2) * (tileW + gap);
    const y = areaTop + Math.floor(i / 2) * (tileH + gap);
    const cy = y + tileH / 2;
    const top = i === 0 && f.active; // the single most-engaged feature gets a gold frame

    ctx.save();
    roundRectPath(ctx, x, y, tileW, tileH, 30);
    ctx.fillStyle = top ? 'rgba(255, 201, 60, 0.18)' : 'rgba(255, 255, 255, 0.1)';
    ctx.fill();
    ctx.lineWidth = top ? 3 : 2;
    ctx.strokeStyle = top ? 'rgba(255, 201, 60, 0.8)' : 'rgba(255, 255, 255, 0.2)';
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x + 20 + 34 * k + 8, cy, 34 * k + 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `${Math.round(40 * k)}px ${EMOJI_FONT}`;
    ctx.fillText(f.emoji, x + 20 + 34 * k + 8, cy + 14 * k);

    const textX = x + 20 + 68 * k + 28;
    ctx.textAlign = 'left';
    if (f.active) {
      ctx.font = `900 ${Math.round(60 * k)}px ${FONT}`;
      ctx.fillStyle = '#FFE58A';
      ctx.fillText(`${f.value}`, textX, cy + 6 * k);
      const numW = ctx.measureText(`${f.value}`).width;
      const diff = f.value - f.prev;
      if (diff !== 0 && f.key !== 'goalsTracked' && f.key !== 'accounts') {
        ctx.font = `800 ${Math.round(26 * k)}px ${FONT}`;
        ctx.fillStyle = diff > 0 ? '#4ADE80' : '#FF8A8A';
        ctx.fillText(`${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}`, textX + numW + 14, cy + 4 * k);
      }
    } else {
      ctx.font = `800 ${Math.round(34 * k)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fillText('Try it', textX, cy + 4 * k);
    }
    ctx.font = `700 ${Math.round(23 * k)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText(fitText(ctx, f.label, tileW - (textX - x) - 20, Math.round(23 * k), '700', 16), textX, cy + 44 * k);
  });

  paintInstallFooter(ctx, 'Join me on FamilyLedger 👉');
  return canvasToPng(canvas);
}
