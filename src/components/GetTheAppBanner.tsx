import { Capacitor } from '@capacitor/core';
import { APP_STORE_URL, PLAY_STORE_URL, browserPlatform } from '../lib/installLinks';

// Shown on the invite pages (join a group, add a friend) only when the link was opened in a phone's browser, which means the app is not installed
// (or the phone has not linked the address to it yet). It sends Android to Google Play and iPhone to the App Store, and says what to do after:
// the invite itself cannot follow the install, so the person taps the same link once more and it opens in the app.
export default function GetTheAppBanner() {
  if (Capacitor.isNativePlatform()) return null;
  const platform = browserPlatform();
  if (platform === 'other') return null;
  return (
    <a
      href={platform === 'ios' ? APP_STORE_URL : PLAY_STORE_URL}
      className="flex items-center gap-3 bg-primary text-white rounded-2xl p-4 shadow-lg active:scale-[0.98] transition-all"
    >
      <img src="/logo.svg" alt="" className="w-10 h-10 rounded-xl bg-white/15 p-1.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold leading-tight">Get the FamilyLedger app</p>
        <p className="text-[11px] text-white/75 leading-snug mt-0.5">
          {platform === 'ios' ? 'On the App Store.' : 'On Google Play.'} After installing, tap this invite link again to open it in the app.
        </p>
      </div>
      <span className="material-symbols-outlined text-[20px] shrink-0">open_in_new</span>
    </a>
  );
}
