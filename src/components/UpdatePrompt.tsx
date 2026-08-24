import React from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { motion, AnimatePresence } from 'motion/react';

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.familyledger.app';

const DISMISS_STORAGE_KEY = 'fl_update_prompt_dismissal';
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function readDismissal(): { versionCode: number; dismissedAt: number } | null {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Checks the installed native app's versionCode against the latest one configured by admins
// (app_config/version) and, if behind, nags the user to update. "Not Now" is persisted to
// localStorage (not just component state) for 24h, scoped to the specific latestVersionCode
// that was dismissed — plain React state didn't survive Android killing/reloading the WebView
// on backgrounding, which made this reappear on nearly every reopen ("non-stop") even though it
// was only meant to show once per launch. Publishing an actual new latestVersionCode always
// breaks through the cooldown immediately, so real updates still get surfaced promptly.
// No-ops entirely on web, where there's no native build to be behind.
export default function UpdatePrompt() {
  const [sessionDismissed, setSessionDismissed] = React.useState(false);
  const [installedBuild, setInstalledBuild] = React.useState<number | null>(null);

  const [versionDoc] = useDocument(doc(db, 'app_config', 'version'));
  const config = versionDoc?.data() as
    | { latestVersionCode?: number; latestVersionName?: string; releaseNotes?: string }
    | undefined;

  React.useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    CapacitorApp.getInfo()
      .then((info) => setInstalledBuild(parseInt(info.build, 10)))
      .catch((err) => console.error('Failed to read installed app version:', err));
  }, []);

  const needsUpdate =
    Capacitor.isNativePlatform() &&
    installedBuild != null &&
    typeof config?.latestVersionCode === 'number' &&
    installedBuild < config.latestVersionCode;

  const persistedDismissal = readDismissal();
  const isCooledDown =
    !!persistedDismissal &&
    persistedDismissal.versionCode === config?.latestVersionCode &&
    Date.now() - persistedDismissal.dismissedAt < DISMISS_COOLDOWN_MS;

  const handleDismiss = () => {
    setSessionDismissed(true);
    if (typeof config?.latestVersionCode === 'number') {
      try {
        localStorage.setItem(
          DISMISS_STORAGE_KEY,
          JSON.stringify({ versionCode: config.latestVersionCode, dismissedAt: Date.now() }),
        );
      } catch (err) {
        console.error('Failed to persist update-prompt dismissal:', err);
      }
    }
  };

  if (!needsUpdate || sessionDismissed || isCooledDown) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4"
        >
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-primary text-3xl">system_update</span>
          </div>
          <div className="text-center space-y-1">
            <h3 className="text-lg font-bold text-primary">Update Available</h3>
            <p className="text-sm text-text-muted">
              {config?.latestVersionName ? `Version ${config.latestVersionName} is ready.` : 'A new version is ready.'}
            </p>
          </div>
          {config?.releaseNotes && (
            <div className="bg-surface rounded-2xl border border-border-subtle p-4 max-h-40 overflow-y-auto">
              <p className="text-xs text-on-surface whitespace-pre-wrap">{config.releaseNotes}</p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <button
              onClick={() => window.open(PLAY_STORE_URL, '_system')}
              className="w-full bg-primary text-white py-3.5 rounded-2xl font-bold active:scale-95 transition-all"
            >
              Update Now
            </button>
            <button
              onClick={handleDismiss}
              className="w-full py-3.5 rounded-2xl font-bold text-text-muted hover:bg-surface-container transition-all"
            >
              Not Now
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
