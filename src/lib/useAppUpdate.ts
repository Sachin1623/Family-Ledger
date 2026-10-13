import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { AppUpdate, AppUpdateAvailability } from '@capawesome/capacitor-app-update';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from './firebase';

// One place that answers "is a newer version of the app available, and how do I get it?":
//  1. The store itself — Google Play's in-app update API on Android (and the App Store lookup on iOS,
//     once the plugin is synced into that build). This is the real source of truth: it knows the
//     moment a new release is live on the store, with no admin action needed.
//  2. The admin-set `app_config/version` doc (App Version in the admin area) — kept as a fallback for
//     installs that don't have the store plugin yet, and for sideloaded/test installs where Play
//     can't answer.
// Used by the Profile page's version chip and by the app-wide UpdatePrompt dialog.

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
const STORE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

type PlatformVersionConfig = { latestVersionCode?: number; latestVersionName?: string; releaseNotes?: string };

interface StoreInfo {
  available: boolean;
  versionName?: string;
  versionCode?: number;
  immediateAllowed: boolean;
  flexibleAllowed: boolean;
  priority: number;
  checkedAt: number;
}

let storeInfo: StoreInfo | null = null;
let storeCheck: Promise<void> | null = null;

function storePluginAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AppUpdate');
}

async function checkStore(force = false): Promise<void> {
  if (!storePluginAvailable()) return;
  if (!force && storeInfo && Date.now() - storeInfo.checkedAt < STORE_CHECK_TTL_MS) return;
  if (storeCheck) return storeCheck;
  storeCheck = (async () => {
    try {
      const info = await AppUpdate.getAppUpdateInfo();
      storeInfo = {
        available: info.updateAvailability === AppUpdateAvailability.UPDATE_AVAILABLE || info.updateAvailability === AppUpdateAvailability.UPDATE_IN_PROGRESS,
        versionName: info.availableVersionName,
        versionCode: info.availableVersionCode ? parseInt(info.availableVersionCode, 10) : undefined,
        immediateAllowed: !!info.immediateUpdateAllowed,
        flexibleAllowed: !!info.flexibleUpdateAllowed,
        priority: info.updatePriority ?? 0,
        checkedAt: Date.now(),
      };
    } catch (err) {
      // Not installed from the store (a test APK) or the store couldn't be reached — not an error
      // worth surfacing; the admin-config fallback below still applies.
      console.warn('Store update check unavailable:', err);
      storeInfo = { available: false, immediateAllowed: false, flexibleAllowed: false, priority: 0, checkedAt: Date.now() };
    }
  })().finally(() => {
    storeCheck = null;
  });
  return storeCheck;
}

export interface AppUpdateState {
  installed: { versionName: string; build: string } | null;
  updateAvailable: boolean;
  latestVersionName?: string;
  latestVersionCode?: number;
  releaseNotes?: string;
  startUpdate: () => Promise<void>;
}

export function useAppUpdate(): AppUpdateState {
  const [installed, setInstalled] = useState<{ versionName: string; build: string } | null>(null);
  const [, bump] = useState(0);
  const platform = Capacitor.getPlatform();

  const [versionDoc] = useDocument(doc(db, 'app_config', 'version'));
  const raw = versionDoc?.data() as
    | { android?: PlatformVersionConfig; ios?: PlatformVersionConfig | null; latestVersionCode?: number; latestVersionName?: string; releaseNotes?: string }
    | undefined;
  // Pre-iOS docs stored one flat set of fields (always meant for Android) — treat that shape as
  // Android's config until an admin re-saves through the per-platform form.
  const adminConfig: PlatformVersionConfig | undefined =
    platform === 'android'
      ? raw?.android ?? (raw ? { latestVersionCode: raw.latestVersionCode, latestVersionName: raw.latestVersionName, releaseNotes: raw.releaseNotes } : undefined)
      : platform === 'ios'
        ? raw?.ios ?? undefined
        : undefined;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    CapacitorApp.getInfo()
      .then((info) => setInstalled({ versionName: info.version, build: info.build }))
      .catch((err) => console.error('Failed to read installed app version:', err));
  }, []);

  // Check the store now and every time the app comes back to the foreground (throttled by the TTL).
  useEffect(() => {
    if (!storePluginAvailable()) return;
    let cancelled = false;
    const run = (force = false) => checkStore(force).then(() => !cancelled && bump((n) => n + 1));
    run();
    const handle = CapacitorApp.addListener('resume', () => run());
    return () => {
      cancelled = true;
      handle.then((h) => h.remove()).catch(() => undefined);
    };
  }, []);

  const installedBuild = installed ? parseInt(installed.build, 10) : null;
  const adminBehind =
    installedBuild != null && typeof adminConfig?.latestVersionCode === 'number' && installedBuild < adminConfig.latestVersionCode;
  const storeBehind = !!storeInfo?.available;
  const updateAvailable = Capacitor.isNativePlatform() && (storeBehind || adminBehind);

  const startUpdate = useCallback(async () => {
    // Real store path: Google Play's standard in-app update screen (immediate when allowed, otherwise
    // a background download that installs on restart) or the App Store listing on iOS.
    if (storePluginAvailable()) {
      try {
        if (platform === 'android' && storeInfo?.available) {
          if (storeInfo.immediateAllowed) {
            await AppUpdate.performImmediateUpdate();
            return;
          }
          if (storeInfo.flexibleAllowed) {
            const handle = await AppUpdate.addListener('onFlexibleUpdateStateChange', async (state) => {
              // 11 = DOWNLOADED (Play Core InstallStatus) — hand over to the standard "restart to install" step.
              if ((state as any).installStatus === 11) {
                await handle.remove();
                await AppUpdate.completeFlexibleUpdate();
              }
            });
            await AppUpdate.startFlexibleUpdate();
            return;
          }
        }
        await AppUpdate.openAppStore();
        return;
      } catch (err) {
        console.error('In-app update failed, opening the store instead:', err);
      }
    }
    if (platform === 'android') window.open(PLAY_STORE_URL, '_system');
  }, [platform]);

  return {
    installed,
    updateAvailable,
    latestVersionName: storeInfo?.available ? storeInfo.versionName : adminConfig?.latestVersionName,
    latestVersionCode: storeInfo?.available ? storeInfo.versionCode : adminConfig?.latestVersionCode,
    releaseNotes: adminConfig?.releaseNotes,
    startUpdate,
  };
}
