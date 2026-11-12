// Where to get the app on each phone, and the line added to invite messages so someone who does not have the app yet knows where to find it.
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
export const APP_STORE_URL = 'https://apps.apple.com/in/app/familyledger-family-finance/id6804777430';

export type BrowserPlatform = 'ios' | 'android' | 'other';
export function browserPlatform(): BrowserPlatform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  // iPhone, iPod, iPad, and iPadOS (which calls itself a Mac but has a touch screen)
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  return 'other';
}

// Added to the end of an invite message sent by WhatsApp, SMS or the share sheet.
export function installHelpText(): string {
  return `\n\nDon't have the app yet?\nAndroid: ${PLAY_STORE_URL}\niPhone: ${APP_STORE_URL}\nInstall it, then tap the link above again.`;
}
