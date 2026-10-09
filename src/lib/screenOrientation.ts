import { Capacitor } from '@capacitor/core';

// Best-effort landscape lock for games that play better sideways. On the installed apps this uses
// the native @capacitor/screen-orientation plugin (a build made before that plugin existed simply
// has nothing to call, so it quietly stays as it was); in a normal browser the Screen Orientation
// API only allows locking in fullscreen, so there it quietly does nothing too.
export async function lockLandscape(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { ScreenOrientation } = await import('@capacitor/screen-orientation');
      await ScreenOrientation.lock({ orientation: 'landscape' });
    } else if (typeof screen !== 'undefined' && (screen.orientation as any)?.lock) {
      await (screen.orientation as any).lock('landscape');
    }
  } catch {
    // Not supported here — the layout still adapts to whichever way the phone is held.
  }
}

export async function unlockOrientation(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { ScreenOrientation } = await import('@capacitor/screen-orientation');
      await ScreenOrientation.unlock();
    } else if (typeof screen !== 'undefined' && screen.orientation?.unlock) {
      screen.orientation.unlock();
    }
  } catch {
    // Nothing was locked.
  }
}
