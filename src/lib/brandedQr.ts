// A QR code with the FamilyLedger icon in the middle, returned as a PNG data URL.
// The code is built at the highest error-correction level (H, up to 30% can be hidden), and the icon badge covers only ~5% of the area,
// so phone cameras still read it. If the icon cannot be loaded the plain QR is returned, never an error.
export async function makeBrandedQr(text: string, size = 720): Promise<string> {
  const QRCode = (await import('qrcode')).default;
  const qr = (QRCode as any).create(text, { errorCorrectionLevel: 'H' });
  const count: number = qr.modules.size;
  const data: Uint8Array = qr.modules.data;
  const quiet = 2;
  const cell = Math.floor(size / (count + quiet * 2));
  const px = cell * (count + quiet * 2);

  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return QRCode.toDataURL(text, { margin: 1, width: 480, errorCorrectionLevel: 'H', color: { dark: '#06222f', light: '#ffffff' } });

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#06222f';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (data[r * count + c]) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }

  try {
    // public/logo.svg is the icon plus the wordmark in a 400x120 box; the icon is the left 100x120.
    const img = new Image();
    img.src = '/logo.svg';
    await img.decode();
    const badge = Math.round(px * 0.23);
    const bx = Math.round((px - badge) / 2);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    (ctx as any).roundRect(bx, bx, badge, badge, badge * 0.22);
    ctx.fill();
    const pad = badge * 0.12;
    const h = badge - pad * 2;
    const w = h * (100 / 120);
    ctx.drawImage(img, 0, 0, 100, 120, bx + (badge - w) / 2, bx + pad, w, h);
  } catch {
    // keep the plain code
  }
  return canvas.toDataURL('image/png');
}
