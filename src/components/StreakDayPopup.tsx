import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Fireworks from './Fireworks';
import StreakFlame from './StreakFlame';

// Shown once a day, the first time the home page is opened after the day's streak has continued: the flame lights and the count rolls from X to X+1.
// The whole animation runs about 3.5 seconds, then the popup closes by itself (a tap closes it sooner).
//   0.0s  the card fades in with a dim flame and the old number
//   0.7s  the flame ignites
//   1.2s  the old number rolls up and out, the new one drops in with a bounce, the fireworks go off
//   2.2s  the line underneath fades in
//   4.2s  closes by itself

const AUTO_CLOSE_MS = 4200;

export default function StreakDayPopup({ from, to, flame, onClose }: { from: number; to: number; flame?: string; onClose: () => void }) {
  const [lit, setLit] = useState(0);
  const [boom, setBoom] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // the timers must not restart when the parent re-renders
  const milestone = [7, 14, 30, 60, 100, 365].includes(to);

  useEffect(() => {
    const ignite = setTimeout(() => setLit(1), 700);
    const fireworks = setTimeout(() => setBoom(true), 1300);
    const close = setTimeout(() => closeRef.current(), AUTO_CLOSE_MS);
    return () => { clearTimeout(ignite); clearTimeout(fireworks); clearTimeout(close); };
  }, []);

  const line = milestone
    ? to >= 30 ? "A whole month of looking after your family's money. That is real responsibility." : 'A full week or more. You earned a streak freeze.'
    : 'Streak continued. See you tomorrow!';

  return createPortal(
    <div className="fixed inset-0 z-[320] bg-black/70 flex items-center justify-center p-6 sdp-fade" onClick={onClose} role="dialog" aria-label={`Streak continued: ${to} days`}>
      <style>{`
        @keyframes sdpFade{from{opacity:0}to{opacity:1}}
        .sdp-fade{animation:sdpFade .4s ease-out}
        @keyframes sdpOut{0%{transform:translateY(0);opacity:1}100%{transform:translateY(-110%);opacity:0}}
        @keyframes sdpIn{0%{transform:translateY(110%) scale(.6);opacity:0}60%{transform:translateY(-8%) scale(1.25);opacity:1}100%{transform:translateY(0) scale(1);opacity:1}}
        @keyframes sdpGlow{0%,100%{text-shadow:0 0 14px rgba(255,150,40,.6)}50%{text-shadow:0 0 28px rgba(255,190,70,1)}}
        @keyframes sdpLine{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        .sdp-old{animation:sdpOut .45s ease-in 1.2s both}
        .sdp-new{animation:sdpIn .65s cubic-bezier(.2,1.4,.4,1) 1.35s both, sdpGlow 1.4s ease-in-out 2s infinite}
        .sdp-line{animation:sdpLine .5s ease-out 2.2s both}
        @media (prefers-reduced-motion: reduce){.sdp-fade,.sdp-old,.sdp-new,.sdp-line{animation:none!important}.sdp-old{display:none}}
      `}</style>
      <div className="relative w-full max-w-xs rounded-3xl p-6 text-center text-white overflow-hidden" style={{ background: 'linear-gradient(160deg,#3a1208,#7c2d12 60%,#9a3412)' }} onClick={(e) => e.stopPropagation()}>
        {boom && <Fireworks />}
        <div className="mx-auto w-24 h-[115px]"><StreakFlame state={lit ? 'lit' : 'out'} size={96} ignite={lit} flame={flame} /></div>
        <div className="relative mx-auto h-[60px] w-40 overflow-hidden">
          <span className="sdp-old absolute inset-0 flex items-center justify-center text-5xl font-black tabular-nums">{from}</span>
          <span className="sdp-new absolute inset-0 flex items-center justify-center text-5xl font-black tabular-nums">{to}</span>
        </div>
        <p className="text-lg font-black text-amber-300 uppercase tracking-wide">day streak</p>
        <p className="sdp-line text-sm text-white/85 mt-2 leading-snug">{line}</p>
      </div>
    </div>,
    document.body,
  );
}
