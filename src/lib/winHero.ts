// The "hero" picture on a win card for games where the result itself looks good on show: the winning
// rummy hand laid out in its groups, or the Ludo board with the winner's tokens home.
import { FONT, EMOJI_FONT, roundRectPath, fitText } from './cardCanvas';
import { parseCard, SUIT_SYMBOL, SUIT_RED } from './rummy';

export interface HeroGroup {
  cards: string[];
  label: string; // e.g. "Pure sequence", "Set"
}

export type WinHero =
  | { kind: 'hand'; groups: HeroGroup[]; wildRanks?: string[]; caption?: string }
  | { kind: 'ludo'; winnerColor: string; caption?: string };

interface Area { x: number; y: number; w: number; h: number }

// A small card face: rank + suit in the corner, a big suit mark when there's room.
function miniCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, cardId: string, opts: { wild?: boolean; joker?: boolean } = {}) {
  const h = Math.round(w * 1.4);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  roundRectPath(ctx, x, y, w, h, Math.max(5, w * 0.1));
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
  ctx.stroke();
  ctx.textAlign = 'left';
  if (opts.joker) {
    ctx.font = `${Math.round(w * 0.6)}px ${EMOJI_FONT}`;
    ctx.fillStyle = '#B45309';
    ctx.fillText('🃏', x + w * 0.16, y + h * 0.62);
  } else {
    const { rank, suit } = parseCard(cardId);
    const color = SUIT_RED[suit] ? '#DC2626' : '#0F172A';
    const fs = Math.round(w * 0.3);
    ctx.fillStyle = color;
    ctx.font = `800 ${fs}px ${FONT}`;
    ctx.fillText(rank, x + w * 0.09, y + fs * 1.05);
    ctx.fillText(SUIT_SYMBOL[suit], x + w * 0.09, y + fs * 2.05);
    if (w >= 54) {
      ctx.font = `700 ${Math.round(w * 0.5)}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.globalAlpha = 0.9;
      ctx.fillText(SUIT_SYMBOL[suit], x + w - w * 0.08, y + h - w * 0.1);
      ctx.globalAlpha = 1;
    }
  }
  if (opts.wild) {
    ctx.beginPath();
    ctx.arc(x + w - w * 0.16, y + w * 0.16, w * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = '#F59E0B';
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.round(w * 0.17)}px ${FONT}`;
    ctx.fillText('★', x + w - w * 0.16, y + w * 0.16 + w * 0.06);
  }
  ctx.restore();
}

// Lays the groups out in 1–3 rows, as large as the area allows, each group a run of overlapping cards
// with a green bar and its name underneath.
function drawHandHero(ctx: CanvasRenderingContext2D, a: Area, hero: Extract<WinHero, { kind: 'hand' }>) {
  const groups = hero.groups.filter((g) => g.cards.length > 0);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  const GAP = 22;
  const LABEL_H = 30;
  const ratio = 0.8; // card pitch / card width

  const pack = (rows: number): HeroGroup[][] => {
    const target = Math.ceil(total / rows);
    const out: HeroGroup[][] = [[]];
    let count = 0;
    for (const g of groups) {
      if (count > 0 && count + g.cards.length > target && out.length < rows) { out.push([]); count = 0; }
      out[out.length - 1].push(g);
      count += g.cards.length;
    }
    return out;
  };

  let best: { rows: HeroGroup[][]; cardW: number } | null = null;
  for (let r = 1; r <= 3; r++) {
    const rows = pack(r);
    let cardW = 112;
    rows.forEach((row) => {
      const cards = row.reduce((n, g) => n + g.cards.length, 0);
      // row width = (cards - groups) * pitch + groups * cardW(last card of each group) + gaps
      const per = (cards - row.length) * ratio + row.length; // in card-widths
      cardW = Math.min(cardW, (a.w - (row.length - 1) * GAP) / per);
    });
    const rowH = (a.h - 6) / rows.length;
    cardW = Math.min(cardW, (rowH - LABEL_H - 8) / 1.4);
    if (!best || cardW > best.cardW) best = { rows, cardW };
  }
  const { rows, cardW } = best!;
  const cardH = cardW * 1.4;
  const rowH = a.h / rows.length;
  rows.forEach((row, ri) => {
    const cards = row.reduce((n, g) => n + g.cards.length, 0);
    const widthOf = (g: HeroGroup) => (g.cards.length - 1) * cardW * ratio + cardW;
    const rowW = row.reduce((n, g) => n + widthOf(g), 0) + (row.length - 1) * GAP;
    let x = a.x + (a.w - rowW) / 2;
    const y = a.y + ri * rowH + (rowH - (cardH + LABEL_H)) / 2;
    void cards;
    row.forEach((g) => {
      g.cards.forEach((c, i) => {
        // A printed joker isn't a normal rank+suit id (e.g. "JK1"), so anything that doesn't parse as one is the joker.
        const joker = !/^(10|[2-9AJQK])[SHDC]$/.test(c);
        miniCard(ctx, x + i * cardW * ratio, y, cardW, c, { wild: !joker && !!hero.wildRanks?.includes(parseCard(c).rank), joker });
      });
      const gw = widthOf(g);
      roundRectPath(ctx, x, y + cardH + 8, gw, 5, 2.5);
      ctx.fillStyle = '#22C55E';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = `700 17px ${FONT}`;
      ctx.fillText(fitText(ctx, g.label.toUpperCase(), gw + GAP - 4, 17, '700', 11), x + gw / 2, y + cardH + 30);
      x += gw + GAP;
    });
  });
}

// ---- Ludo ----
const LUDO_COLORS = { blue: '#2563EB', yellow: '#EAB308', green: '#16A34A', red: '#DC2626' };

function pawn(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(0, size * 0.42, size * 0.42, size * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-size * 0.36, size * 0.4);
  ctx.quadraticCurveTo(-size * 0.3, -size * 0.02, 0, -size * 0.06);
  ctx.quadraticCurveTo(size * 0.3, -size * 0.02, size * 0.36, size * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -size * 0.22, size * 0.27, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.arc(-size * 0.09, -size * 0.31, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawLudoHero(ctx: CanvasRenderingContext2D, a: Area, hero: Extract<WinHero, { kind: 'ludo' }>) {
  const size = Math.min(a.h - 10, 320);
  const cs = size / 15;
  const ox = a.x + a.w / 2 - size / 2 - 150;
  const oy = a.y + (a.h - size) / 2;
  const win = hero.winnerColor;

  ctx.save();
  roundRectPath(ctx, ox - 8, oy - 8, size + 16, size + 16, 18);
  const wood = ctx.createLinearGradient(ox, oy, ox + size, oy + size);
  wood.addColorStop(0, '#8A5A2B');
  wood.addColorStop(1, '#5B3A1A');
  ctx.fillStyle = wood;
  ctx.fill();
  roundRectPath(ctx, ox, oy, size, size, 10);
  ctx.clip();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(ox, oy, size, size);

  const yards: Array<[number, number, string]> = [[0, 0, LUDO_COLORS.blue], [0, 9, LUDO_COLORS.yellow], [9, 0, LUDO_COLORS.red], [9, 9, LUDO_COLORS.green]];
  yards.forEach(([r, c, col]) => {
    ctx.fillStyle = col;
    ctx.fillRect(ox + c * cs, oy + r * cs, 6 * cs, 6 * cs);
    ctx.fillStyle = 'rgba(255,255,255,0.93)';
    roundRectPath(ctx, ox + (c + 1) * cs, oy + (r + 1) * cs, 4 * cs, 4 * cs, cs * 1.1);
    ctx.fill();
    [[2, 2], [2, 4], [4, 2], [4, 4]].forEach(([dr, dc]) => {
      ctx.beginPath();
      ctx.arc(ox + (c + dc) * cs, oy + (r + dr) * cs, cs * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.05)';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    });
  });
  // arms + home columns
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const arm = (c >= 6 && c <= 8) || (r >= 6 && r <= 8);
      const yard = (r < 6 || r > 8) && (c < 6 || c > 8);
      if (!arm || yard || (r >= 6 && r <= 8 && c >= 6 && c <= 8)) continue;
      let f = '#FFFFFF';
      if (c === 7 && r >= 1 && r <= 5) f = '#FBEFB8';
      if (c === 7 && r >= 9 && r <= 13) f = '#F9C3C3';
      if (r === 7 && c >= 1 && c <= 5) f = '#C7D7FB';
      if (r === 7 && c >= 9 && c <= 13) f = '#BFE8CC';
      ctx.fillStyle = f;
      ctx.fillRect(ox + c * cs, oy + r * cs, cs, cs);
      ctx.strokeStyle = '#D6DCE6';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(ox + c * cs, oy + r * cs, cs, cs);
    }
  }
  // centre wedges
  const cx = ox + 6 * cs, cy = oy + 6 * cs, s3 = 3 * cs;
  const tri = (pts: number[][], col: string) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach((p) => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); };
  tri([[cx, cy], [cx + s3, cy], [cx + s3 / 2, cy + s3 / 2]], LUDO_COLORS.yellow);
  tri([[cx + s3, cy], [cx + s3, cy + s3], [cx + s3 / 2, cy + s3 / 2]], LUDO_COLORS.green);
  tri([[cx, cy + s3], [cx + s3, cy + s3], [cx + s3 / 2, cy + s3 / 2]], LUDO_COLORS.red);
  tri([[cx, cy], [cx, cy + s3], [cx + s3 / 2, cy + s3 / 2]], LUDO_COLORS.blue);
  // the winner's glowing home stretch + all four tokens home
  ctx.restore();
  ctx.save();
  const centre = [ox + size / 2, oy + size / 2];
  const glow = ctx.createRadialGradient(centre[0], centre[1], 5, centre[0], centre[1], cs * 4);
  glow.addColorStop(0, 'rgba(255, 214, 102, 0.85)');
  glow.addColorStop(1, 'rgba(255, 214, 102, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(centre[0] - cs * 4, centre[1] - cs * 4, cs * 8, cs * 8);
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy]) => pawn(ctx, centre[0] + dx * cs * 0.95, centre[1] + dy * cs * 0.8 + cs * 0.3, cs * 2.3, win));
  ctx.restore();

  // right: a big die and the tally
  const rx = ox + size + 70;
  const dieS = 130;
  const dy = a.y + a.h / 2 - dieS / 2 - 20;
  ctx.save();
  ctx.translate(rx + dieS / 2, dy + dieS / 2);
  ctx.rotate(-0.12);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, -dieS / 2, -dieS / 2, dieS, dieS, 26);
  const dg = ctx.createLinearGradient(0, -dieS / 2, 0, dieS / 2);
  dg.addColorStop(0, '#FFFFFF');
  dg.addColorStop(1, '#D8DEE8');
  ctx.fillStyle = dg;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = win;
  [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]].forEach(([px, py]) => {
    ctx.beginPath();
    ctx.arc(px * dieS * 0.22, py * dieS * 0.27, dieS * 0.08, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 56px ${FONT}`;
  ctx.fillText('4 / 4', rx - 4, dy + dieS + 70);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText('TOKENS HOME', rx - 2, dy + dieS + 102);
}

export function drawWinHero(ctx: CanvasRenderingContext2D, area: Area, hero: WinHero) {
  // panel
  ctx.save();
  roundRectPath(ctx, area.x, area.y, area.w, area.h, 34);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.stroke();
  ctx.restore();

  const caption = hero.caption ?? (hero.kind === 'hand' ? 'THE WINNING HAND' : 'ALL FOUR HOME');
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 229, 138, 0.95)';
  ctx.font = `800 22px ${FONT}`;
  (ctx as any).letterSpacing = '5px';
  ctx.fillText(caption, area.x + area.w / 2, area.y + 38);
  (ctx as any).letterSpacing = '0px';

  const inner: Area = { x: area.x + 24, y: area.y + 56, w: area.w - 48, h: area.h - 72 };
  if (hero.kind === 'hand') drawHandHero(ctx, inner, hero);
  else drawLudoHero(ctx, inner, hero);
}
