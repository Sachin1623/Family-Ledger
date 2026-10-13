import { renderAllSpreadCards, SpreadPoster } from './spreadCardImage';

// The Spread the Word posters barely change, so they're drawn once in the background (when Profile
// opens) and kept in memory — tapping Share then opens the picker instantly. "Shuffle" redraws a
// fresh set (new taglines) on demand.
export interface SpreadPosterSet {
  posters: SpreadPoster[];
  urls: Record<string, string>;
}

let cache: SpreadPosterSet | null = null;
let inflight: Promise<SpreadPosterSet> | null = null;

export function peekSpreadPosters(): SpreadPosterSet | null {
  return cache;
}

export function loadSpreadPosters(force = false): Promise<SpreadPosterSet> {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && inflight) return inflight;
  const job = renderAllSpreadCards().then((posters) => {
    const urls: Record<string, string> = {};
    posters.forEach((p) => {
      urls[p.id] = URL.createObjectURL(p.blob);
    });
    if (cache) Object.values(cache.urls).forEach((u) => URL.revokeObjectURL(u));
    cache = { posters, urls };
    return cache;
  });
  inflight = job;
  job.finally(() => {
    if (inflight === job) inflight = null;
  });
  return job;
}
