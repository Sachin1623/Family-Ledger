import { Capacitor } from '@capacitor/core';
import { APP_STORE_URL, PLAY_STORE_URL, browserPlatform } from '../lib/installLinks';

// A slim bar at the very top of every page, shown whenever FamilyLedger is opened as a web page on a phone (never inside the installed app). It names
// the store for that phone, App Store on iPhone and Google Play on Android, and the Get button goes straight there. It sits above the header,
// outside the scrolling part of the page, so it stays in view on every screen.
export default function GetTheAppBar() {
  if (Capacitor.isNativePlatform()) return null;
  const platform = browserPlatform();
  if (platform === 'other') return null;
  const ios = platform === 'ios';
  return (
    <div className="shrink-0 flex items-center gap-3 bg-[#06222f] text-white px-3 py-2" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }} role="region" aria-label="Get the app">
      <img src="/logo.svg" alt="" className="w-9 h-9 rounded-xl bg-white/15 p-1.5 shrink-0" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-[13px] font-extrabold truncate">FamilyLedger is better in the app</p>
        <p className="text-[11px] text-[#9fc3d1] truncate">{ios ? 'Free on the App Store' : 'Free on Google Play'} · reminders and offline</p>
      </div>
      <a
        href={ios ? APP_STORE_URL : PLAY_STORE_URL}
        className="shrink-0 h-9 px-4 rounded-full bg-[#12b89a] text-[#06222f] text-[13px] font-extrabold flex items-center active:scale-95 transition-transform"
      >
        {ios ? 'Open App Store' : 'Get on Google Play'}
      </a>
    </div>
  );
}
