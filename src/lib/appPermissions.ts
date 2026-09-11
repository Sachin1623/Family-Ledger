import { registerPlugin } from '@capacitor/core';

// Bridges the native AppPermissions plugin (android/.../AppPermissionsPlugin.java,
// ios/App/App/AppPermissionsPlugin.swift) — reports current grant status for the handful of
// permissions this app actually asks for, and opens the right OS settings screen to fix each one.
// There's no single Capacitor-core plugin covering all of these together: notifications,
// contacts, and microphone are ordinary runtime permissions; exact-alarm scheduling and the
// battery-optimization exemption are Android-only special toggles with their own dedicated
// Settings screens (no equivalent concept on iOS, so those two keys are simply absent from the
// result there — see AppPermissionsReminder.tsx, which treats a missing key as "nothing to fix").
export interface PermissionStatus {
  notifications: boolean;
  contacts: boolean;
  microphone: boolean;
  exactAlarm?: boolean; // Android only
  batteryOptimization?: boolean; // Android only
}

export type PermissionKey = keyof PermissionStatus;

interface AppPermissionsPluginApi {
  checkAll(): Promise<PermissionStatus>;
  openAppSettings(): Promise<void>;
  openExactAlarmSettings(): Promise<void>;
  openBatteryOptimizationSettings(): Promise<void>;
}

const AppPermissions = registerPlugin<AppPermissionsPluginApi>('AppPermissions');

const SETTINGS_OPENER: Record<PermissionKey, () => Promise<void>> = {
  notifications: () => AppPermissions.openAppSettings(),
  contacts: () => AppPermissions.openAppSettings(),
  microphone: () => AppPermissions.openAppSettings(),
  exactAlarm: () => AppPermissions.openExactAlarmSettings(),
  batteryOptimization: () => AppPermissions.openBatteryOptimizationSettings(),
};

// Callers must guard with Capacitor.isNativePlatform() themselves — there's no web
// implementation registered for this plugin (nothing to check on desktop/browser), so calling
// this on web throws; returning null here instead of letting that propagate keeps every caller
// from needing its own try/catch.
export async function checkAppPermissions(): Promise<PermissionStatus | null> {
  try {
    return await AppPermissions.checkAll();
  } catch (err) {
    console.error('checkAppPermissions failed:', err);
    return null;
  }
}

export async function openPermissionSettings(key: PermissionKey): Promise<void> {
  try {
    await SETTINGS_OPENER[key]();
  } catch (err) {
    console.error(`openPermissionSettings(${key}) failed:`, err);
  }
}
