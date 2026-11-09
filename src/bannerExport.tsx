// Developer-only page used by scripts/generate-store-banner.mjs: draws the square "Now on iPhone" broadcast banner (1080x1080) with the poster toolkit.
import {
  FONT, W, fontsReady, paintBackground, paintLogoBadge, drawPlayBadge, drawAppStoreBadge, paintSocialPills, canvasToJpeg, setPosterPlatform,
} from './lib/cardCanvas';

const saveUrl = new URLSearchParams(location.search).get('save') || 'http://127.0.0.1:5189/save';

(async () => {
  setPosterPlatform('android');
  await fontsReady();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = 1080;
  const ctx = canvas.getContext('2d')!;
  paintBackground(ctx, '255, 176, 41', 20261109, 470);
  paintLogoBadge(ctx);
  ctx.textAlign = 'center';

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 112px ${FONT}`;
  ctx.fillText('Now on', W / 2, 330);
  const g = ctx.createLinearGradient(240, 0, 840, 0);
  g.addColorStop(0, '#FFE08A'); g.addColorStop(1, '#FFA629');
  ctx.save(); ctx.shadowColor = 'rgba(255,176,41,0.55)'; ctx.shadowBlur = 40;
  ctx.fillStyle = g;
  ctx.font = `900 150px ${FONT}`;
  ctx.fillText('iPhone too!', W / 2, 480);
  ctx.restore();

  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText('One app for the whole family.', W / 2, 565);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `500 32px ${FONT}`;
  ctx.fillText('Money, health, chats and games — together', W / 2, 615);

  // Big App Store badge (the news), Google Play beside it
  const bh = 110;
  const pw = bh * 3.7, aw = bh * 3.4, gap = 30;
  const startX = (W - (pw + gap + aw)) / 2;
  drawAppStoreBadge(ctx, startX + aw / 2, 680, bh);
  drawPlayBadge(ctx, startX + aw + gap + pw / 2, 680, bh);

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText('Free  ·  Search “FamilyLedger”', W / 2, 860);
  paintSocialPills(ctx, 110, 910, W - 220);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText('familyledger.thirteenapps.com', W / 2, 1040);

  const blob = await canvasToJpeg(canvas, 0.9);
  await fetch(`${saveUrl}?file=${encodeURIComponent('store-banner-square.jpg')}`, { method: 'POST', body: blob });
  await fetch(`${saveUrl}?done=1`, { method: 'POST', body: '1' });
})().catch((e) => fetch(`${saveUrl}?error=1`, { method: 'POST', body: String(e?.message || e) }).catch(() => {}));
