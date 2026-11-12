import { APP_STORE_URL, PLAY_STORE_URL } from '../lib/installLinks';

// The two official store badges (Apple's "Download on the App Store" and Google's "Get it on Google Play"), side by side. Both are always shown on the web
// page: someone who opened an invite in a browser does not have the app, and we do not guess which phone they use.
export default function StoreBadges({ height = 40, className = '' }: { height?: number; className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2.5 ${className}`}>
      <a href={APP_STORE_URL} aria-label="Download on the App Store" className="shrink-0 active:scale-95 transition-transform">
        <img src="/store/app-store-badge.svg" alt="Download on the App Store" style={{ height }} className="block w-auto" draggable={false} />
      </a>
      <a href={PLAY_STORE_URL} aria-label="Get it on Google Play" className="shrink-0 active:scale-95 transition-transform">
        <img src="/store/google-play-badge.png" alt="Get it on Google Play" style={{ height }} className="block w-auto" draggable={false} />
      </a>
    </div>
  );
}
