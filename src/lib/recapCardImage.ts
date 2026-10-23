// The weekly-recap share image: a 1080x1350 poster with the user's own numbers for the week. What it
// features depends on where that person was most engaged (see recapFeatures.ts) — at least six
// different features, most-used first. Drawn on the fly in the same brand style as the other pictures.
import {
  W, FONT, EMOJI_FONT, roundRectPath, fitText, wrapLines, newPosterCanvas, canvasToPng, fontsReady,
  paintBackground, paintLogoBadge, paintInstallFooter,
} from './cardCanvas';
import { RecapView } from './recapFeatures';
import { guardianLevel } from './recapThoughts';

export interface RecapPraiseInput {
  activeDays?: number;
  topPercent: number | null;
  streakDays: number;
  loggedDays30: number;
  healthDays30: number;
  weeksActive8: number;
}

export type RecapVariant = 'welldone' | 'achievement' | 'numbers' | 'habits' | 'care';

export interface RecapHabitInput { done: boolean; emoji: string; title: string; text: string }
export interface RecapThoughtInput { emoji: string; text: string; source: string }

export interface RecapCardInput {
  periodLabel: string;
  kudos: string;
  view: RecapView;
  praise?: RecapPraiseInput | null;
  variant?: RecapVariant;
  habits?: RecapHabitInput[];
  thought?: RecapThoughtInput | null;
  care?: { medicineDoses: number; bpReadings: number; glucoseReadings: number; vaccinesGiven: number };
}

export async function renderRecapCard(input: RecapCardInput): Promise<Blob> {
  if (input.variant === 'welldone') return renderWellDoneCard(input);
  if (input.variant === 'habits') return renderHabitsCard(input);
  if (input.variant === 'care') return renderCareCard(input);
  return renderTilesCard(input);
}

function gold(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(W / 2 - 320, 0, W / 2 + 320, 0);
  g.addColorStop(0, '#FFE58A');
  g.addColorStop(1, '#FFA629');
  return g;
}

function paintTitle(ctx: CanvasRenderingContext2D, small: string, headline: string) {
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFC93C';
  ctx.font = `800 26px ${FONT}`;
  (ctx as any).letterSpacing = '6px';
  ctx.fillText(small.toUpperCase(), W / 2, 190);
  (ctx as any).letterSpacing = '0px';
  ctx.save();
  ctx.shadowColor = 'rgba(255, 170, 40, 0.5)';
  ctx.shadowBlur = 28;
  ctx.fillStyle = gold(ctx);
  ctx.fillText(fitText(ctx, headline, W - 120, 84, '900', 44), W / 2, 282);
  ctx.restore();
}

// "Well done": the praise card from the recap screen as a picture: who they are being (top X%, streak, Guardian rank), in warm words.
async function renderWellDoneCard({ periodLabel, praise }: RecapCardInput): Promise<Blob> {
  await fontsReady();
  const { canvas, ctx } = newPosterCanvas();
  paintBackground(ctx, '74, 222, 128', 20261017);
  paintLogoBadge(ctx);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#4ADE80';
  ctx.font = `900 30px ${FONT}`;
  (ctx as any).letterSpacing = '8px';
  ctx.fillText('WELL DONE', W / 2, 200);
  (ctx as any).letterSpacing = '0px';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText(periodLabel.toUpperCase(), W / 2, 238);

  const top = praise?.topPercent != null;
  const headline = top ? `I'm in the top ${praise!.topPercent}%` : (praise?.streakDays ?? 0) >= 2 ? `${praise!.streakDays} days in a row` : "I'm taking charge";
  const sub = top ? 'of FamilyLedger members for keeping a close eye on my family\u2019s money' : 'of my family\u2019s money, and that is how good habits start';
  ctx.save();
  ctx.shadowColor = 'rgba(255, 170, 40, 0.55)';
  ctx.shadowBlur = 30;
  ctx.fillStyle = gold(ctx);
  ctx.fillText(fitText(ctx, headline, W - 120, 108, '900', 54), W / 2, 350);
  ctx.restore();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.font = `700 32px ${FONT}`;
  wrapLines(ctx, sub, W - 180, 2).forEach((l, i) => ctx.fillText(l, W / 2, 410 + i * 42));

  // the warm message
  roundRectPath(ctx, 70, 520, W - 140, 190, 34);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 30px ${FONT}`;
  wrapLines(ctx, 'Looking after a family\u2019s finances takes patience and care. I believe in planning, I stay aware of every rupee, and that quiet consistency is what builds peace of mind.', W - 170, 4).forEach((l, i) => ctx.fillText(l, W / 2, 575 + i * 40));

  // badges, two by two
  const badges: { emoji: string; value: string; label: string }[] = [];
  if ((praise?.activeDays ?? 0) > 0) badges.push({ emoji: '\uD83D\uDEE1\uFE0F', value: String(praise!.activeDays), label: `Guardian Days \u00B7 ${guardianLevel(praise!.activeDays!).title}` });
  if ((praise?.streakDays ?? 0) > 0) badges.push({ emoji: '\uD83D\uDD25', value: String(praise!.streakDays), label: 'days in a row watching my spending' });
  if ((praise?.loggedDays30 ?? 0) > 0) badges.push({ emoji: '\uD83D\uDCC5', value: `${praise!.loggedDays30}/30`, label: 'days I logged this month' });
  if ((praise?.healthDays30 ?? 0) > 0) badges.push({ emoji: '\u2764\uFE0F', value: String(praise!.healthDays30), label: 'days caring for my family\u2019s health' });
  else if ((praise?.weeksActive8 ?? 0) > 0) badges.push({ emoji: '\u2705', value: `${praise!.weeksActive8}/8`, label: 'recent weeks on top of it' });
  const gap = 18;
  const bw = (W - 140 - gap) / 2;
  badges.slice(0, 4).forEach((b, i) => {
    const bx = 70 + (i % 2) * (bw + gap);
    const by = 736 + Math.floor(i / 2) * (140 + gap);
    roundRectPath(ctx, bx, by, bw, 140, 30);
    ctx.fillStyle = 'rgba(255, 201, 60, 0.13)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255, 201, 60, 0.55)';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = `46px ${EMOJI_FONT}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(b.emoji, bx + 24, by + 84);
    ctx.font = `900 58px ${FONT}`;
    ctx.fillStyle = '#FFE58A';
    ctx.fillText(b.value, bx + 98, by + 70);
    ctx.font = `700 22px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(fitText(ctx, b.label, bw - 114, 22, '700', 13), bx + 98, by + 108);
  });
  ctx.textAlign = 'center';
  paintInstallFooter(ctx, 'Join me on FamilyLedger 👉', { playBadge: true });
  return canvasToPng(canvas);
}

// "Steady family habits": the three habits ticked from what this person did, and the week's thought with its source.
async function renderHabitsCard({ periodLabel, habits = [], thought }: RecapCardInput): Promise<Blob> {
  await fontsReady();
  const { canvas, ctx } = newPosterCanvas();
  paintBackground(ctx, '74, 222, 128', 20261015);
  paintLogoBadge(ctx);
  paintTitle(ctx, `Steady family habits  ·  ${periodLabel}`, 'Building financial peace of mind');
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `600 29px ${FONT}`;
  ctx.fillText('Planning, awareness and small daily habits', W / 2, 340);

  let y = 392;
  habits.slice(0, 3).forEach((h) => {
    roundRectPath(ctx, 70, y, W - 140, 126, 32);
    ctx.fillStyle = h.done ? 'rgba(74, 222, 128, 0.16)' : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = h.done ? 'rgba(74, 222, 128, 0.7)' : 'rgba(255, 255, 255, 0.22)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(70 + 20 + 40, y + 63, 40, 0, Math.PI * 2);
    ctx.fillStyle = h.done ? '#22C55E' : 'rgba(255, 255, 255, 0.12)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    if (h.done) {
      ctx.font = `900 46px ${FONT}`;
      ctx.fillText('✓', 70 + 60, y + 79);
    } else {
      ctx.font = `38px ${EMOJI_FONT}`;
      ctx.fillText(h.emoji, 70 + 60, y + 76);
    }
    const tx = 70 + 20 + 80 + 26;
    ctx.textAlign = 'left';
    ctx.font = `900 34px ${FONT}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fitText(ctx, h.title, W - 70 - tx - 30, 34, '900', 22), tx, y + 50);
    ctx.font = `600 23px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    wrapLines(ctx, h.text, W - 70 - tx - 30, 2).forEach((l, i) => ctx.fillText(l, tx, y + 84 + i * 30));
    y += 126 + 12;
  });

  if (thought) {
    const top = y + 4;
    const hgt = 1050 - top;
    roundRectPath(ctx, 70, top, W - 140, hgt, 34);
    ctx.fillStyle = 'rgba(255, 201, 60, 0.14)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 201, 60, 0.7)';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#FFC93C';
    ctx.font = `800 22px ${FONT}`;
    (ctx as any).letterSpacing = '3px';
    ctx.fillText(`${thought.emoji}  A THOUGHT FOR THE WEEK`, 70 + 30, top + 44);
    (ctx as any).letterSpacing = '0px';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 26px ${FONT}`;
    const lines = wrapLines(ctx, thought.text, W - 140 - 60, 4);
    lines.forEach((l, i) => ctx.fillText(l, 70 + 30, top + 90 + i * 34));
    ctx.fillStyle = 'rgba(255, 229, 138, 0.9)';
    ctx.font = `700 21px ${FONT}`;
    ctx.fillText(fitText(ctx, thought.source, W - 140 - 60, 21, '700', 14), 70 + 30, top + hgt - 20);
  }
  paintInstallFooter(ctx, 'Join me on FamilyLedger 👉', { playBadge: true });
  return canvasToPng(canvas);
}

// "Caring for my family": the health and care numbers for the week, with the consistency badges.
async function renderCareCard({ periodLabel, praise, care }: RecapCardInput): Promise<Blob> {
  await fontsReady();
  const { canvas, ctx } = newPosterCanvas();
  paintBackground(ctx, '255, 120, 140', 20261016);
  paintLogoBadge(ctx);
  paintTitle(ctx, `Caring for my family  ·  ${periodLabel}`, 'Looking after the ones I love');
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `600 29px ${FONT}`;
  ctx.fillText('Health is part of a family\u2019s financial wellbeing too', W / 2, 340);

  const tiles = [
    { emoji: '💊', value: care?.medicineDoses ?? 0, label: 'Medicine doses taken' },
    { emoji: '❤️', value: care?.bpReadings ?? 0, label: 'BP readings logged' },
    { emoji: '🩸', value: care?.glucoseReadings ?? 0, label: 'Glucose readings logged' },
    { emoji: '💉', value: care?.vaccinesGiven ?? 0, label: 'Vaccines recorded' },
  ];
  const gap = 20;
  const tw = (W - 140 - gap) / 2;
  tiles.forEach((t, i) => {
    const x = 70 + (i % 2) * (tw + gap);
    const y = 396 + Math.floor(i / 2) * (200 + gap);
    roundRectPath(ctx, x, y, tw, 200, 34);
    ctx.fillStyle = t.value > 0 ? 'rgba(255, 138, 160, 0.16)' : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = t.value > 0 ? 'rgba(255, 138, 160, 0.7)' : 'rgba(255, 255, 255, 0.2)';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = `52px ${EMOJI_FONT}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(t.emoji, x + 28, y + 80);
    ctx.font = `900 84px ${FONT}`;
    ctx.fillStyle = t.value > 0 ? '#FFE0E6' : 'rgba(255, 255, 255, 0.5)';
    ctx.fillText(String(t.value), x + 28 + 78, y + 84);
    ctx.font = `700 25px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(fitText(ctx, t.label, tw - 56, 25, '700', 16), x + 28, y + 156);
  });

  const badges: { emoji: string; value: string; label: string }[] = [];
  if (praise && (praise.activeDays ?? 0) > 0) badges.push({ emoji: '🛡️', value: String(praise.activeDays), label: `Guardian Days · ${guardianLevel(praise.activeDays!).title}` });
  if (praise && praise.healthDays30 > 0) badges.push({ emoji: '❤️', value: String(praise.healthDays30), label: 'days caring for health this month' });
  if (praise && praise.streakDays > 0) badges.push({ emoji: '🔥', value: String(praise.streakDays), label: 'days in a row watching my spending' });
  badges.slice(0, 2).forEach((b, i, arr) => {
    const bw = (W - 140 - 20 * (arr.length - 1)) / arr.length;
    const bx = 70 + i * (bw + 20);
    const by = 396 + 2 * (200 + gap) + 4;
    roundRectPath(ctx, bx, by, bw, 110, 28);
    ctx.fillStyle = 'rgba(255, 201, 60, 0.14)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 201, 60, 0.5)';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = `36px ${EMOJI_FONT}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(b.emoji, bx + 20, by + 68);
    ctx.font = `900 44px ${FONT}`;
    ctx.fillStyle = '#FFE58A';
    ctx.fillText(b.value, bx + 78, by + 56);
    ctx.font = `700 19px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(fitText(ctx, b.label, bw - 90, 19, '700', 12), bx + 78, by + 88);
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText('Small, steady care adds up for the whole family 💚', W / 2, 1010);
  paintInstallFooter(ctx, 'Join me on FamilyLedger 👉', { playBadge: true });
  return canvasToPng(canvas);
}

// "Achievement" (with the appreciation strip) and "My week in numbers" (the classic tile picture, no ranking).
async function renderTilesCard({ periodLabel, kudos, view, praise, variant }: RecapCardInput): Promise<Blob> {
  if (variant === 'numbers') praise = null;
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
    if ((praise.activeDays ?? 0) > 0) badges.push({ emoji: '\uD83D\uDEE1\uFE0F', value: String(praise.activeDays), label: `Guardian Days \u00B7 ${guardianLevel(praise.activeDays!).title}` });
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
