// Little pieces of "the game itself" — playing-card fans, dice and tokens, a chess board, property
// tiles, letter tiles — drawn on either side of the trophy on a win card, so each game's brag
// picture actually looks like that game (and not just a generic trophy).
import { FONT, roundRectPath } from './cardCanvas';

export type GameArtKind = 'spade' | 'rummy' | 'sweep' | 'sequence' | 'ludo' | 'chess' | 'business' | 'scramble';

export function artForGame(gameName: string): GameArtKind {
  const n = gameName.toLowerCase();
  if (n.includes('spade')) return 'spade';
  if (n.includes('rummy')) return 'rummy';
  if (n.includes('sweep')) return 'sweep';
  if (n.includes('sequence')) return 'sequence';
  if (n.includes('ludo')) return 'ludo';
  if (n.includes('chess')) return 'chess';
  if (n.includes('business')) return 'business';
  if (n.includes('scramble') || n.includes('word')) return 'scramble';
  return 'spade';
}

const SUIT_COLOR: Record<string, string> = { '♠': '#0F172A', '♣': '#0F172A', '♥': '#DC2626', '♦': '#DC2626' };

function playingCard(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number, rank: string, suit: string, w = 150, h = 210) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, -w / 2, -h / 2, w, h, 16);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.18)';
  ctx.stroke();
  const color = SUIT_COLOR[suit] || '#0F172A';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.font = `800 40px ${FONT}`;
  ctx.fillText(rank, -w / 2 + 14, -h / 2 + 46);
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText(suit, -w / 2 + 14, -h / 2 + 82);
  ctx.textAlign = 'center';
  ctx.font = `700 92px ${FONT}`;
  ctx.fillText(suit, 4, 32);
  ctx.restore();
}

function fan(ctx: CanvasRenderingContext2D, cx: number, cy: number, cards: Array<[string, string]>, spread: number, mirror = false) {
  const n = cards.length;
  cards.forEach(([rank, suit], i) => {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5; // -0.5 .. 0.5
    const rot = t * spread * (mirror ? -1 : 1);
    playingCard(ctx, cx + t * 150, cy + Math.abs(t) * 34, rot, rank, suit);
  });
}

function die(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number, value: number, size = 130) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, -size / 2, -size / 2, size, size, 24);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const p = size * 0.26;
  const spots: Record<number, Array<[number, number]>> = {
    1: [[0, 0]], 2: [[-p, -p], [p, p]], 3: [[-p, -p], [0, 0], [p, p]],
    4: [[-p, -p], [p, -p], [-p, p], [p, p]], 5: [[-p, -p], [p, -p], [0, 0], [-p, p], [p, p]],
    6: [[-p, -p], [p, -p], [-p, 0], [p, 0], [-p, p], [p, p]],
  };
  ctx.fillStyle = '#0F172A';
  (spots[value] || spots[5]).forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.arc(dx, dy, size * 0.075, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function token(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string, r = 34) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.25, color);
  g.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.stroke();
  ctx.restore();
}

function chip(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string, r = 30) {
  token(ctx, cx, cy, color, r);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.stroke();
  ctx.restore();
}

function letterTile(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number, letter: string, points: number, size = 118) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, -size / 2, -size / 2, size, size, 20);
  const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  g.addColorStop(0, '#FFE9A8');
  g.addColorStop(1, '#F6C453');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#5B3A06';
  ctx.textAlign = 'center';
  ctx.font = `900 72px ${FONT}`;
  ctx.fillText(letter, 0, 26);
  ctx.textAlign = 'right';
  ctx.font = `800 24px ${FONT}`;
  ctx.fillText(String(points), size / 2 - 10, size / 2 - 12);
  ctx.restore();
}

function chessBoard(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number, cells = 4, cell = 58) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const size = cells * cell;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, -size / 2 - 8, -size / 2 - 8, size + 16, size + 16, 14);
  ctx.fillStyle = '#5B3A1E';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#F0D9B5' : '#B58863';
      ctx.fillRect(-size / 2 + c * cell, -size / 2 + r * cell, cell, cell);
    }
  }
  ctx.restore();
}

function glyph(ctx: CanvasRenderingContext2D, ch: string, cx: number, cy: number, size: number, fill: string, stroke?: string) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `${size}px "Segoe UI Symbol", "Noto Sans Symbols 2", "DejaVu Sans", ${FONT}`;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  if (stroke) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = stroke;
    ctx.strokeText(ch, cx, cy);
  }
  ctx.fillStyle = fill;
  ctx.fillText(ch, cx, cy);
  ctx.restore();
}

function propertyTile(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number, color: string, name: string, price: string) {
  const w = 130;
  const h = 170;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  roundRectPath(ctx, -w / 2, -h / 2, w, h, 12);
  ctx.fillStyle = '#FDF6E3';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = color;
  ctx.fillRect(-w / 2, -h / 2, w, 46);
  ctx.fillStyle = '#1F2937';
  ctx.textAlign = 'center';
  ctx.font = `800 22px ${FONT}`;
  ctx.fillText(name, 0, 18);
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText(price, 0, 62);
  ctx.restore();
}

function noteStack(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  for (let i = 2; i >= 0; i--) {
    ctx.save();
    ctx.translate(0, -i * 16);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    roundRectPath(ctx, -92, -50, 184, 100, 10);
    const g = ctx.createLinearGradient(-92, 0, 92, 0);
    g.addColorStop(0, '#7BD389');
    g.addColorStop(1, '#3FA660');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#F0FFF4';
  ctx.textAlign = 'center';
  ctx.font = `900 56px ${FONT}`;
  ctx.fillText('₹', 0, -32);
  ctx.restore();
}

// Draws the game's artwork on the left and right of the trophy (x≈40–330 and 750–1040, y≈170–440).
export function drawGameArt(ctx: CanvasRenderingContext2D, kind: GameArtKind) {
  const L = { x: 185, y: 250 };
  const R = { x: 895, y: 250 };
  ctx.save();
  switch (kind) {
    case 'spade':
      fan(ctx, L.x, L.y, [['A', '♠'], ['K', '♠'], ['Q', '♠']], 0.5);
      fan(ctx, R.x, R.y, [['J', '♠'], ['10', '♠'], ['9', '♠']], 0.5, true);
      break;
    case 'rummy':
      fan(ctx, L.x, L.y, [['5', '♥'], ['6', '♥'], ['7', '♥']], 0.5);
      fan(ctx, R.x, R.y, [['9', '♣'], ['9', '♦'], ['9', '♠']], 0.5, true);
      break;
    case 'sweep':
      fan(ctx, L.x, L.y, [['10', '♦'], ['A', '♥']], 0.45);
      fan(ctx, R.x, R.y, [['J', '♠'], ['5', '♦'], ['7', '♣']], 0.5, true);
      break;
    case 'sequence':
      playingCard(ctx, L.x - 20, L.y, -0.18, 'K', '♥');
      playingCard(ctx, R.x + 20, R.y, 0.18, 'Q', '♠');
      [0, 1, 2].forEach((i) => chip(ctx, L.x + 40 + i * 46, L.y + 70 - i * 46, '#2F80ED', 26));
      [0, 1, 2].forEach((i) => chip(ctx, R.x - 90 + i * 46, R.y + 70 - i * 46, '#27AE60', 26));
      break;
    case 'ludo':
      die(ctx, L.x - 20, L.y - 20, -0.22, 5);
      token(ctx, L.x + 72, L.y + 62, '#EF4444', 28);
      token(ctx, L.x + 12, L.y + 84, '#22C55E', 28);
      die(ctx, R.x + 20, R.y - 10, 0.25, 6);
      token(ctx, R.x - 72, R.y + 62, '#FACC15', 28);
      token(ctx, R.x - 12, R.y + 84, '#3B82F6', 28);
      break;
    case 'chess':
      chessBoard(ctx, L.x, L.y + 10, -0.16);
      glyph(ctx, '♞', L.x + 6, L.y + 50, 130, '#FFFFFF', '#1F2937');
      glyph(ctx, '♚', R.x, R.y + 66, 200, '#FFD66B', '#7A4B00');
      break;
    case 'business':
      propertyTile(ctx, L.x - 62, L.y + 6, -0.2, '#E11D48', 'PARK ST', '₹200');
      propertyTile(ctx, L.x + 72, L.y + 14, 0.1, '#2563EB', 'MG ROAD', '₹350');
      noteStack(ctx, R.x, R.y + 30, 0.12);
      ctx.font = `110px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('🏠', R.x + 70, R.y - 50);
      break;
    case 'scramble':
      letterTile(ctx, L.x - 50, L.y + 10, -0.2, 'W', 4);
      letterTile(ctx, L.x + 70, L.y + 30, 0.12, 'O', 1);
      letterTile(ctx, R.x - 70, R.y + 30, -0.12, 'R', 1);
      letterTile(ctx, R.x + 50, R.y + 10, 0.2, 'D', 2);
      break;
  }
  ctx.restore();
}
