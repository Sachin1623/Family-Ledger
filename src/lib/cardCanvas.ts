// Shared drawing toolkit for every shareable picture the app generates (win cards, Spread the Word
// posters, the weekly recap): fonts, text fitting, the FamilyLedger logo, the common background and
// the install footer with a scannable Play Store QR code. Pure canvas — no remote images, so it
// renders the same everywhere and never trips CORS-tainted-canvas errors.
import QRCode from 'qrcode';
import { isIosApp } from './platform';
export { isIosApp };

export const W = 1080;
export const H = 1350;
export const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
export const WEB_URL = 'https://familyledger.thirteenapps.com';

// The text that accompanies every shared picture. An image itself can't be tapped, so the real,
// clickable links live here (and the QR code on the image carries the Play Store link too).
// On the iPhone app we never mention Google Play / Android (App Store guideline 2.3.10 asks iOS apps
// to stay focused on the iOS experience), so everything points at the website instead.
export function installLinksText(): string {
  if (isIosApp()) return `🌐 Try FamilyLedger free: ${WEB_URL}`;
  return `📲 Install FamilyLedger free on Android: ${PLAY_STORE_URL}\n🌐 Or use it on the web: ${WEB_URL}`;
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
// Leaves ctx.font at the fitted size, so callers just fillText the returned string.
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number, weight: string, minSize = 24): string {
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

export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s.,;:!?-]+$/, '')}…`;
    return kept;
  }
  return lines;
}

// Small deterministic PRNG so decorative scatter is stable for a given seed.
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The FamilyLedger logo (same artwork as public/logo.svg), drawn in its own 400x120 coordinate space.
export function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
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

export function newPosterCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available on this device.');
  return { canvas, ctx };
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png');
  });
}

export async function fontsReady() {
  try {
    await (document as any).fonts?.ready;
  } catch {
    /* system fonts are fine */
  }
}

// Navy gradient ground with a soft coloured glow behind the headline and scattered light dots.
export function paintBackground(ctx: CanvasRenderingContext2D, glowRgb: string, seed: number, glowY = 330) {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#06263D');
  bg.addColorStop(0.55, '#0A3B5C');
  bg.addColorStop(1, '#04192A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, glowY, 30, W / 2, glowY, 640);
  glow.addColorStop(0, `rgba(${glowRgb}, 0.34)`);
  glow.addColorStop(0.6, `rgba(${glowRgb}, 0.08)`);
  glow.addColorStop(1, `rgba(${glowRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const rnd = seeded(seed);
  for (let i = 0; i < 46; i++) {
    ctx.globalAlpha = 0.08 + rnd() * 0.2;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 2 + rnd() * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// The logo on a white badge at the top centre — the wordmark is dark navy, so it needs a light ground.
export function paintLogoBadge(ctx: CanvasRenderingContext2D) {
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
}

// A QR code for `text`, drawn module-by-module (sync, no data URLs) inside a white rounded plate.
export function drawQr(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  const qr = (QRCode as any).create(text, { errorCorrectionLevel: 'M' });
  const count: number = qr.modules.size;
  const pad = 14;
  roundRectPath(ctx, x, y, size, size, 22);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  const cell = (size - pad * 2) / count;
  ctx.fillStyle = '#0B2540';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.modules.get(r, c)) {
        // overdraw by a hair so adjacent modules never show seams at fractional cell sizes
        ctx.fillRect(x + pad + c * cell, y + pad + r * cell, cell + 0.6, cell + 0.6);
      }
    }
  }
}

// Bottom band shared by every picture: a Play Store QR (scan to install), the Play Store / website
// text, and a green call-to-action pill.
export function paintInstallFooter(ctx: CanvasRenderingContext2D, ctaText: string) {
  const qrSize = 210;
  const qrX = W - 70 - qrSize;
  const qrY = H - 40 - qrSize - 28;
  const ios = isIosApp();
  drawQr(ctx, ios ? WEB_URL : PLAY_STORE_URL, qrX, qrY, qrSize);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText('SCAN TO INSTALL', qrX + qrSize / 2, qrY + qrSize + 28);

  const leftX = 70;
  const leftW = qrX - 40 - leftX;
  const pillH = 84;
  const pillY = qrY + 6;
  roundRectPath(ctx, leftX, pillY, leftW, pillH, 42);
  const cta = ctx.createLinearGradient(leftX, 0, leftX + leftW, 0);
  cta.addColorStop(0, '#22C55E');
  cta.addColorStop(1, '#14B8A6');
  ctx.fillStyle = cta;
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, ctaText, leftW - 50, 34, '800', 24), leftX + leftW / 2, pillY + 55);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(fitText(ctx, ios ? 'Free for the whole family' : 'Get it free on Google Play', leftW, 34, '800', 24), leftX + leftW / 2, pillY + pillH + 52);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.fillText(fitText(ctx, 'familyledger.thirteenapps.com', leftW, 28, '600', 20), leftX + leftW / 2, pillY + pillH + 92);
}
