import { renderSpreadCard, SPREAD_EDITIONS, SpreadPoster, SPREAD_VARIANTS } from './spreadCardImage';
import { isIosApp } from './platform';

// The Spread the Word posters are the same for everyone, so they are drawn ONCE, ahead of time (scripts/generate-spread-posters.mjs), saved
// on the server as ordinary pictures under /spread-posters/, and simply downloaded here: nothing is drawn on the phone and there is no
// wait. A new edition is shown every week (SPREAD_EDITIONS of them, repeating after that); "Shuffle" steps to another edition. If the
// pictures cannot be fetched (offline, or not generated yet) the same edition is drawn on the phone instead.
export interface SpreadPosterSet {
  posters: SpreadPoster[];
  urls: Record<string, string>;
  edition: number;
}

// Bump when the posters are regenerated, so phones fetch the new files instead of an old cached copy.
export const SPREAD_POSTER_VERSION = 1;

// The same edition for everyone in the same week (Monday to Sunday, Indian time).
export function currentSpreadEdition(now = Date.now()): number {
  const IST = 5.5 * 60 * 60 * 1000;
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const MONDAY_OFFSET = 4 * 24 * 60 * 60 * 1000; // the Unix epoch was a Thursday
  return Math.floor((now + IST - MONDAY_OFFSET) / WEEK) % SPREAD_EDITIONS;
}

let cache: SpreadPosterSet | null = null;
let inflight: Promise<SpreadPosterSet> | null = null;
let shown = 0; // how many shuffles away from this week's edition

export function peekSpreadPosters(): SpreadPosterSet | null {
  return cache;
}

// The picture is a JPEG on the server (a quarter of the size); the share sheet and Instagram/Facebook get a PNG, as before.
export async function ensurePng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('png conversion failed'))), 'image/png'));
}

async function fetchPremade(edition: number): Promise<SpreadPoster[]> {
  const platform = isIosApp() ? 'ios' : 'android';
  return Promise.all(
    SPREAD_VARIANTS.map(async (v) => {
      const res = await fetch(`/spread-posters/${platform}-${v.id}-${edition}-v${SPREAD_POSTER_VERSION}.jpg`);
      if (!res.ok || !(res.headers.get('content-type') || '').includes('image')) throw new Error(`poster ${v.id} unavailable`);
      return { id: v.id, label: v.label, emoji: v.emoji, blob: await res.blob() } as SpreadPoster;
    }),
  );
}

export function loadSpreadPosters(force = false): Promise<SpreadPosterSet> {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && inflight) return inflight;
  if (force) shown = (shown + 1) % SPREAD_EDITIONS;
  const edition = (currentSpreadEdition() + shown) % SPREAD_EDITIONS;
  const job = fetchPremade(edition)
    .catch(async (err) => {
      console.warn('Pre-made posters unavailable, drawing them on this device:', err);
      const posters: SpreadPoster[] = [];
      for (const v of SPREAD_VARIANTS) posters.push({ id: v.id, label: v.label, emoji: v.emoji, blob: await renderSpreadCard(v.id, 20261019, edition) });
      return posters;
    })
    .then((posters) => {
      const urls: Record<string, string> = {};
      posters.forEach((p) => {
        urls[p.id] = URL.createObjectURL(p.blob);
      });
      if (cache) Object.values(cache.urls).forEach((u) => URL.revokeObjectURL(u));
      cache = { posters, urls, edition };
      return cache;
    });
  inflight = job;
  job.finally(() => {
    if (inflight === job) inflight = null;
  });
  return job;
}
