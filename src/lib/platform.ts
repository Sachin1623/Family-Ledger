import { Capacitor } from '@capacitor/core';

// True only inside the installed iPhone/iPad app. On iOS we never mention Google Play / Android in
// anything the app produces (shared pictures, share text, PDF reports) — App Store guideline 2.3.10
// asks iOS apps to stay focused on the iOS experience — and point at the website instead.
export function isIosApp(): boolean {
  return Capacitor.getPlatform() === 'ios';
}
