import { lazy, type ComponentType } from 'react';

// Route screens load on demand so a first-time visitor downloads only the login page, not the whole app.
// A deploy replaces the hashed chunk files, so a tab opened before it can ask for a chunk that no longer exists:
// reload once to pick up the new build (the flag stops a reload loop if the network is simply down).
// A weak or dropping connection fails the same way, and then a reload does not help either, so the import is retried a couple of times first.
const RELOAD_KEY = 'fl_chunk_reload_at';
const RETRY_DELAYS_MS = [800, 2000];

async function loadWithRetry<T>(load: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await load();
    } catch (err) {
      if (i >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    }
  }
}

export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    loadWithRetry(load).catch((err) => {
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
        if (Date.now() - last > 30_000) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
          window.location.reload();
          return new Promise<{ default: T }>(() => {});
        }
      } catch { /* storage blocked: fall through to the error */ }
      throw err;
    }),
  );
}
