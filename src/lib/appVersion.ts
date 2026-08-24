import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

// Reads the actually-installed native build's version at runtime instead of a literal string
// baked into a screen (About.tsx and Profile.tsx both had one — "v2.4.1" — that had drifted
// years out of sync with every real release this app has ever shipped, all "1.2.1"). This is
// always accurate by construction: there's nothing to remember to bump on the next release.
// Returns null on web, where there's no native binary to report a version for.
export async function getAppVersion(): Promise<{ versionName: string; build: string } | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const info = await CapacitorApp.getInfo();
    return { versionName: info.version, build: info.build };
  } catch (err) {
    console.error('Failed to read app version:', err);
    return null;
  }
}
