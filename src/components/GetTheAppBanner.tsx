import { Capacitor } from '@capacitor/core';
import StoreBadges from './StoreBadges';

// On the invite pages (join a group, add a friend): shown only when the link opened as a web page, which means the app is not installed. Someone who has the
// app never sees this page, because the link opens the app itself. After installing, the person taps the same link again and it opens in the app.
export default function GetTheAppBanner() {
  if (Capacitor.isNativePlatform()) return null;
  return (
    <div className="rounded-2xl bg-surface border border-border-subtle p-4 text-center space-y-3">
      <div>
        <p className="text-sm font-extrabold text-primary">Better in the FamilyLedger app</p>
        <p className="text-xs text-text-muted mt-0.5">Install it, then tap this invite link again to open it in the app.</p>
      </div>
      <StoreBadges height={44} />
    </div>
  );
}
