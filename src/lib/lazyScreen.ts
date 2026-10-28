import { lazy, type ComponentType } from 'react';

// Route screens load on demand so a first-time visitor downloads only the login page, not the whole app.
// A deploy replaces the hashed chunk files, so a tab opened before it can ask for a chunk that no longer exists:
// reload once to pick up the new build (the flag stops a reload loop if the network is simply down).
const RELOAD_KEY = 'fl_chunk_reload_at';

export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((err) => {
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
