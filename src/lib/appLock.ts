// App-lock settings storage. Deliberately device-local (localStorage), not synced through
// Firestore — a lock code/method is meaningful per-device, not per-account, and this keeps the
// feature working fully offline with no server round-trip. The PIN itself is never stored in
// plain text, only a SHA-256 hash of it.
const STORAGE_KEY = 'fl_app_lock';

export type AppLockMethod = 'biometric' | 'pin';

interface AppLockSettings {
  enabled: boolean;
  method: AppLockMethod | null;
  pinHash: string | null;
}

const DEFAULT_SETTINGS: AppLockSettings = { enabled: false, method: null, pinHash: null };

function readSettings(): AppLockSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: AppLockSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function getAppLockSettings(): AppLockSettings {
  return readSettings();
}

export async function enablePinLock(pin: string): Promise<void> {
  writeSettings({ enabled: true, method: 'pin', pinHash: await hashPin(pin) });
}

export function enableBiometricLock(): void {
  writeSettings({ enabled: true, method: 'biometric', pinHash: null });
}

export function disableAppLock(): void {
  writeSettings(DEFAULT_SETTINGS);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const settings = readSettings();
  if (!settings.pinHash) return false;
  return (await hashPin(pin)) === settings.pinHash;
}
