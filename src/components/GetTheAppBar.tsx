import { Capacitor } from '@capacitor/core';
import StoreBadges from './StoreBadges';

// A slim bar at the very top of every page when FamilyLedger is opened as a web page (never inside the installed app): the two official store badges.
// It sits above the header, outside the scrolling part of the page, so it stays in view on every screen.
export default function GetTheAppBar() {
  if (Capacitor.isNativePlatform()) return null;
  return (
    <div className="shrink-0 flex items-center justify-between gap-3 bg-[#06222f] text-white px-3 py-1.5" style={{ paddingTop: 'max(0.375rem, env(safe-area-inset-top))' }} role="region" aria-label="Get the app">
      <p className="hidden sm:block text-[13px] font-extrabold">Get the FamilyLedger app</p>
      <StoreBadges height={34} className="w-full sm:w-auto" />
    </div>
  );
}
