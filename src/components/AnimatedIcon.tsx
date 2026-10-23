import React, { useEffect, useRef, useState } from 'react';

// The FamilyLedger icon animation (public/brand/icon-anim-v1.mp4, about 100 KB): the family icon opens into the ledger and closes again. The
// video ships INSIDE the Android app (served from the app's own files, never over the network); on the web and iPhone it is downloaded once and
// then cached for a year.
//   mode 'interval': plays once, rests for `intervalMs`, plays again (the header icon)
//   mode 'loop'    : plays again and again (the loading screen)
// Before it plays, and when the person has asked their phone to reduce motion, the first picture of the video is shown instead.

const VIDEO = '/brand/icon-anim-v1.mp4';
const POSTER = '/brand/icon-poster-v1.webp';

export default function AnimatedIcon({
  size,
  mode = 'interval',
  intervalMs = 5000,
  className = '',
  radius = 'rounded-xl',
}: {
  size: number;
  mode?: 'interval' | 'loop';
  intervalMs?: number;
  className?: string;
  radius?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (reduced || mode !== 'interval') return;
    const v = ref.current;
    if (!v) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const play = () => {
      if (stopped) return;
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(play, 1000); // wait until the app is on screen again
        return;
      }
      v.currentTime = 0;
      v.play().then(() => setPlaying(true)).catch(() => schedule());
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(play, intervalMs);
    };
    const onEnded = () => {
      setPlaying(false);
      schedule();
    };
    v.addEventListener('ended', onEnded);
    timer = setTimeout(play, 1200); // the first play shortly after the screen appears
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      v.removeEventListener('ended', onEnded);
      v.pause();
    };
  }, [mode, intervalMs, reduced]);

  return (
    <span className={`relative inline-block overflow-hidden shrink-0 ${radius} ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <img src={POSTER} alt="" width={size} height={size} className="absolute inset-0 w-full h-full object-cover" draggable={false} />
      {!reduced && (
        <video
          ref={ref}
          src={VIDEO}
          poster={POSTER}
          muted
          playsInline
          preload="auto"
          loop={mode === 'loop'}
          autoPlay={mode === 'loop'}
          disablePictureInPicture
          className="absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-200"
          style={{ opacity: mode === 'loop' || playing ? 1 : 0 }}
        />
      )}
    </span>
  );
}
