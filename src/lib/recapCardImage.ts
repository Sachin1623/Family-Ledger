// The weekly-recap share image: a 1080x1350 poster with the user's own numbers for the week. What it
// features depends on where that person was most engaged (see recapFeatures.ts) — at least six
// different features, most-used first. Drawn on the fly in the same brand style as the other pictures.
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, wrapLines, newPosterCanvas, canvasToPng, fontsReady,
  paintBackground, paintLogoBadge, paintInstallFooter,
} from './cardCanvas';
import { RecapView } from './recapFeatures';

export interface RecapPraiseInput {
  topPercent: number | null;
  streakDays: number;
  loggedDays30: number;
  healthDays30: number;
  weeksActive8: number;
}

export interface RecapCardInput {
  periodLabel: string;
  kudos: string;
  view: RecapView;
  praise?: RecapPraiseInput | null;
}

export async function renderRecapCard({ periodLabel, kudos, view, praise }: RecapCardInput): Promise<Blob> {
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

  // ---- Kudos (or, when we have the person's consistency numbers, a short appreciation line with a ribbon and badges) ----
  const hasPraise = !!praise && (praise.topPercent != null || praise.streakDays > 0 || praise.loggedDays30 > 0);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.font = `600 30px ${FONT}`;
  const kudosLines = hasPraise
    ? [fitText(ctx, 'Taking responsibility for my family\u2019s money, one day at a time \uD83D\uDC9A', W - 140, 30, '600', 22)]
    : wrapLines(ctx, kudos, W - 200, 2);
  kudosLines.forEach((l, i) => ctx.fillText(l, W / 2, 404 + i * 40));

  let stripBottom = 404 + kudosLines.length * 40 + 8;
  if (hasPraise && praise) {
    if (praise.topPercent != null) {
      const ribbon = `\uD83C\uDFC6  TOP ${praise.topPercent}% of FamilyLedger members`;
      ctx.save();
      roundRectPath(ctx, 70, stripBottom + 12, W - 140, 76, 38);
      const rg = ctx.createLinearGradient(70, 0, W - 70, 0);
      rg.addColorStop(0, '#FFE58A');
      rg.addColorStop(1, '#FFA629');
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#3A2600';
      ctx.textAlign = 'center';
      ctx.font = `900 38px ${FONT}`;
      ctx.fillText(fitText(ctx, ribbon, W - 200, 38, '900', 26), W / 2, stripBottom + 12 + 52);
      stripBottom += 100;
    }
    const badges: { emoji: string; value: string; label: string }[] = [];
    if (praise.streakDays > 0) badges.push({ emoji: '\uD83D\uDD25', value: String(praise.streakDays), label: praise.streakDays === 1 ? 'day watching spending' : 'days in a row' });
    if (praise.loggedDays30 > 0) badges.push({ emoji: '\uD83D\uDCC5', value: `${praise.loggedDays30}/30`, label: 'days logged this month' });
    if (praise.healthDays30 > 0) badges.push({ emoji: '\u2764\uFE0F', value: String(praise.healthDays30), label: 'days caring for health' });
    else if (praise.weeksActive8 > 0) badges.push({ emoji: '\u2705', value: `${praise.weeksActive8}/8`, label: 'weeks on top of it' });
    const shown = badges.slice(0, 3);
    if (shown.length > 0) {
      const bg = 16;
      const bw = (W - 140 - bg * (shown.length - 1)) / shown.length;
      shown.forEach((b, i) => {
        const bx = 70 + i * (bw + bg);
        const by = stripBottom + 14;
        roundRectPath(ctx, bx, by, bw, 104, 26);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255, 201, 60, 0.45)';
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.font = `34px ${EMOJI_FONT}`;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(b.emoji, bx + 18, by + 62);
        ctx.font = `900 40px ${FONT}`;
        ctx.fillStyle = '#FFE58A';
        ctx.fillText(b.value, bx + 72, by + 52);
        ctx.font = `700 19px ${FONT}`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
        ctx.fillText(fitText(ctx, b.label, bw - 80, 19, '700', 13), bx + 72, by + 82);
      });
      stripBottom += 14 + 104 + 10;
    }
    ctx.textAlign = 'center';
  }

  // ---- Feature tiles: 6 to 8, two per row, most-engaged first (6 when the appreciation strip above takes room) ----
  const feats = view.features.slice(0, hasPraise ? 6 : 8);
  const rows = Math.ceil(feats.length / 2);
  const gap = 18;
  const areaTop = stripBottom;
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

  paintInstallFooter(ctx, 'Join me on FamilyLedger 👉', { playBadge: true });
  return canvasToPng(canvas);
}
