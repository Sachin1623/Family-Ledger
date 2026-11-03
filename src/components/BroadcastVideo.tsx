import React from 'react';
import { createPortal } from 'react-dom';
import { pushModalBackHandler, popModalBackHandler } from '../lib/modalBackHandler';

const YT = 'https://www.youtube-nocookie.com';

// The YouTube player inside a broadcast message. YouTube's own full-screen button often does nothing inside the Android app's web view,
// so the "Full screen" button here opens the player over the whole screen itself and carries on from where it was (the player tells us
// its position once we say we are listening). The phone's Back button closes it. A wide video held upright on a phone would barely get
// bigger, so it is turned on its side to fill the screen (a Short stays upright).
export default function BroadcastVideo({ videoId, short, onOpenYouTube }: {
  videoId: string;
  short: boolean;
  onOpenYouTube: () => void;
}) {
  const [full, setFull] = React.useState(false);
  const [startAt, setStartAt] = React.useState(0);
  const timeRef = React.useRef(0);
  const [portrait, setPortrait] = React.useState(() => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches);
  React.useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)');
    const onChange = () => setPortrait(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  const turned = !short && portrait;

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT) return;
      let data: any = e.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
      const t = data?.info?.currentTime;
      if (data?.event === 'infoDelivery' && typeof t === 'number') timeRef.current = t;
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const close = React.useCallback(() => { setStartAt(timeRef.current); setFull(false); }, []);
  React.useEffect(() => {
    if (!full) return;
    pushModalBackHandler(close);
    return () => popModalBackHandler(close);
  }, [full, close]);

  const origin = typeof window !== 'undefined' && /^https?:/.test(window.location.origin) ? `&origin=${encodeURIComponent(window.location.origin)}` : '';
  const src = (autoplay: boolean) =>
    `${YT}/embed/${videoId}?rel=0&playsinline=1&modestbranding=1&enablejsapi=1${origin}&start=${Math.floor(startAt)}${autoplay ? '&autoplay=1' : ''}`;
  // say "I am listening" once the player has loaded, so it starts reporting its position
  const listen = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    try { e.currentTarget.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT); } catch { /* the player just will not report its position */ }
  };
  const allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen';

  return (
    <div className="space-y-2">
      <div className={short ? 'mx-auto w-[62%] aspect-[9/16] max-h-[52vh]' : 'w-full aspect-video'}>
        {full ? (
          <div className="w-full h-full rounded-2xl bg-black flex items-center justify-center text-white/70 text-xs font-bold">Playing full screen</div>
        ) : (
          <iframe
            key={`inline-${startAt}`}
            src={src(false)}
            title="Video"
            className="w-full h-full rounded-2xl border border-border-subtle bg-black"
            allow={allow}
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={listen}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => { setStartAt(timeRef.current); setFull(true); }}
          className="flex items-center gap-1 rounded-full bg-primary text-white pl-2.5 pr-3.5 py-1.5 text-xs font-black active:scale-95"
        >
          <span className="material-symbols-outlined text-[18px]">fullscreen</span>Full screen
        </button>
        <button type="button" onClick={onOpenYouTube} className="text-xs font-black text-primary underline underline-offset-2">
          Open on YouTube
        </button>
      </div>

      {full && createPortal(
        <div className="fixed inset-0 z-[400] bg-black overflow-hidden">
          {turned ? (
            <div className="absolute" style={{ top: '50%', left: '50%', width: '100dvh', height: '100dvw', transform: 'translate(-50%, -50%) rotate(90deg)' }}>
              <iframe
                key="full-turned"
                src={src(true)}
                title="Video, full screen"
                className="w-full h-full bg-black"
                allow={allow}
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={listen}
              />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center p-2" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 3.25rem)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
              <iframe
                key="full"
                src={src(true)}
                title="Video, full screen"
                className={short ? 'h-full max-w-full aspect-[9/16] rounded-xl bg-black' : 'w-full max-h-full aspect-video rounded-xl bg-black'}
                allow={allow}
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={listen}
              />
            </div>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close full screen"
            className="absolute right-1 z-10 w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center active:scale-95"
            style={{ top: "calc(env(safe-area-inset-top) + 0.25rem)" }}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
