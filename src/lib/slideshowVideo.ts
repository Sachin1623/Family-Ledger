// Turns several pictures into ONE short video that plays them one after another with a soft cross-fade. WhatsApp Status (Stories) takes just one
// item from a share, so a slideshow video is how a whole set goes up as a single Status. It is drawn on a canvas and recorded in the phone's own
// web view (MediaRecorder), so nothing is uploaded anywhere. MP4 is preferred (WhatsApp plays it everywhere); WebM is the fallback.

export interface SlideshowResult {
  blob: Blob;
  mimeType: string; // video/mp4 or video/webm
  extension: 'mp4' | 'webm';
}

const OUT_W = 720; // half the picture size keeps the file small (about 1 to 2 MB); both sides are even, as video needs
const OUT_H = 900;
const FPS = 30;
const SECONDS_EACH = 2.6;
const FADE_SECONDS = 0.45;

function pickMime(): { mime: string; ext: 'mp4' | 'webm' } | null {
  const MR = (window as any).MediaRecorder as typeof MediaRecorder | undefined;
  if (!MR) return null;
  const candidates: [string, 'mp4' | 'webm'][] = [
    ['video/mp4;codecs=avc1.42E01E', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mime, ext] of candidates) {
    try {
      if (MR.isTypeSupported(mime)) return { mime, ext };
    } catch {
      /* try the next */
    }
  }
  return null;
}

export function canMakeSlideshow(): boolean {
  return typeof document !== 'undefined' && !!pickMime() && typeof (HTMLCanvasElement.prototype as any).captureStream === 'function';
}

async function loadBitmap(blob: Blob): Promise<CanvasImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall back to an <img> below */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // the decoded image stays usable after the URL is released
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function makeSlideshowVideo(pictures: Blob[], onProgress?: (fraction: number) => void): Promise<SlideshowResult> {
  const picked = pickMime();
  if (!picked || pictures.length === 0) throw new Error('Video is not supported on this device.');
  const images = await Promise.all(pictures.map(loadBitmap));

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the video.');

  const stream = (canvas as any).captureStream(FPS) as MediaStream;
  const recorder = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 2_500_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const finished = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Recording failed.'));
  });

  const total = images.length * SECONDS_EACH;
  const draw = (img: CanvasImageSource, alpha: number) => {
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, 0, 0, OUT_W, OUT_H);
    ctx.globalAlpha = 1;
  };

  ctx.fillStyle = '#0b1f2c';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  recorder.start(250);
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const t = (performance.now() - started) / 1000;
      if (t >= total) {
        resolve();
        return;
      }
      const idx = Math.min(images.length - 1, Math.floor(t / SECONDS_EACH));
      const into = t - idx * SECONDS_EACH;
      ctx.fillStyle = '#0b1f2c';
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      draw(images[idx], 1);
      // the next picture fades in over the last moments of this one
      if (idx < images.length - 1 && into > SECONDS_EACH - FADE_SECONDS) draw(images[idx + 1], (into - (SECONDS_EACH - FADE_SECONDS)) / FADE_SECONDS);
      onProgress?.(Math.min(1, t / total));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  // hold the last picture for a beat so it is not cut off
  draw(images[images.length - 1], 1);
  await new Promise((r) => setTimeout(r, 300));
  recorder.stop();
  await finished;
  stream.getTracks().forEach((t) => t.stop());

  const mimeType = picked.ext === 'mp4' ? 'video/mp4' : 'video/webm';
  return { blob: new Blob(chunks, { type: mimeType }), mimeType, extension: picked.ext };
}
