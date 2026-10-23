import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// Turns several pictures into ONE short MP4 video that plays them one after another, 5 seconds each, with a slow zoom on every picture and a soft
// cross-fade between them. WhatsApp Status (Stories) takes just one item from a share, so a slideshow video is how a whole set goes up as a single
// Status. Every frame is drawn on a canvas and encoded with the phone's own video encoder (WebCodecs), then packed into an MP4 in memory: nothing is
// uploaded anywhere, and the timing is exact because each frame carries its own timestamp (it does not depend on how fast the phone draws).

export interface SlideshowResult {
  blob: Blob;
  mimeType: 'video/mp4';
  extension: 'mp4';
}

const OUT_W = 720; // half the picture size keeps the file small; both sides are even, as video needs
const OUT_H = 900;
const FPS = 24;
const SECONDS_EACH = 5;
const FADE_SECONDS = 1;
const ZOOM = 0.06; // each picture slowly grows by this much while it shows

export function canMakeSlideshow(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).VideoEncoder === 'function' && typeof (window as any).VideoFrame === 'function';
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
    setTimeout(() => URL.revokeObjectURL(url), 0); // the decoded image stays usable after the URL is released
  }
}

const ease = (x: number) => x * x * (3 - 2 * x); // smoothstep: the fade starts and ends gently

export async function makeSlideshowVideo(pictures: Blob[], onProgress?: (fraction: number) => void): Promise<SlideshowResult> {
  if (!canMakeSlideshow() || pictures.length === 0) throw new Error('Video is not supported on this device.');
  const VideoEncoderCtor = (window as any).VideoEncoder;
  const VideoFrameCtor = (window as any).VideoFrame;

  // Baseline H.264, level 3.1: plays everywhere (WhatsApp, every phone gallery).
  const config = { codec: 'avc1.42001f', width: OUT_W, height: OUT_H, bitrate: 2_500_000, framerate: FPS };
  const support = await VideoEncoderCtor.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new Error('This phone cannot make an MP4 video.');

  const images = await Promise.all(pictures.map(loadBitmap));
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the video.');

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: OUT_W, height: OUT_H }, fastStart: 'in-memory' });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoderCtor({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: Error) => {
      encodeError = e;
    },
  });
  encoder.configure(config);

  // One picture drawn centred and slightly zoomed, at the given opacity.
  const draw = (img: CanvasImageSource, alpha: number, zoom: number) => {
    ctx.globalAlpha = alpha;
    const w = OUT_W * zoom;
    const h = OUT_H * zoom;
    ctx.drawImage(img, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h);
    ctx.globalAlpha = 1;
  };

  const n = images.length;
  const totalFrames = Math.round(n * SECONDS_EACH * FPS);
  for (let f = 0; f < totalFrames; f++) {
    if (encodeError) throw encodeError;
    const t = f / FPS;
    const idx = Math.min(n - 1, Math.floor(t / SECONDS_EACH));
    const into = t - idx * SECONDS_EACH; // seconds into this picture's slot
    ctx.fillStyle = '#0b1f2c';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    draw(images[idx], 1, 1 + ZOOM * (into / SECONDS_EACH));
    // In the last second of a slot the next picture fades in over it, already slightly zoomed out so it settles into place.
    if (idx < n - 1 && into > SECONDS_EACH - FADE_SECONDS) {
      const k = ease((into - (SECONDS_EACH - FADE_SECONDS)) / FADE_SECONDS);
      draw(images[idx + 1], k, 1 + ZOOM * (k - 1) * 0.5);
    }
    const frame = new VideoFrameCtor(canvas, { timestamp: Math.round((f * 1_000_000) / FPS), duration: Math.round(1_000_000 / FPS) });
    encoder.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
    frame.close();
    // keep the encoder's queue short and let the screen breathe so the progress shows
    if (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 0));
    if (f % 12 === 0) {
      onProgress?.(f / totalFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' }), mimeType: 'video/mp4', extension: 'mp4' };
}
