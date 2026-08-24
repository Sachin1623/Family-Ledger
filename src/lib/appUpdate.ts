import { useEffect, useState } from 'react';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from './firebase';

// Shared by UpdateBanner.tsx (the floating nudge) and FeedList.tsx (a synthetic "recent update"
// entry) so both agree on the exact same signal, rather than each polling/comparing separately.
// See server.ts's startup write to `app_config/webBuild` and its `/api/build-info` endpoint —
// this compares the Cloud Run revision THIS tab's JS was served from against the latest deployed
// one, live, with no polling.
export function useAppUpdateAvailable() {
  const [buildDoc] = useDocument(doc(db, 'app_config', 'webBuild'));
  const [myRevision, setMyRevision] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/build-info')
      .then((r) => r.json())
      .then((data) => setMyRevision(data?.revision || null))
      .catch(() => {});
  }, []);

  const latestRevision = buildDoc?.data()?.revision as string | undefined;
  // 'local' is what /api/build-info reports outside Cloud Run (no K_REVISION) — never treat that
  // as stale, or every local dev session would flag an update forever.
  const available = !!(latestRevision && myRevision && latestRevision !== myRevision && myRevision !== 'local');

  return { available };
}

// Clears the service worker's precached app-shell/asset cache and reloads — deliberately NOT
// localStorage/IndexedDB, which is where Firestore's own offline persistence queues any
// not-yet-synced writes (e.g. an expense added while briefly offline). Wiping those would
// silently destroy real user data instead of just fetching fresh code.
export async function hardReloadApp(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.error('hardReloadApp cleanup failed:', err);
  }
  window.location.reload();
}
