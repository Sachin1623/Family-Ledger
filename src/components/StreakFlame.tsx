import React, { useEffect, useRef, useState } from 'react';

// The streak flame and its weather. One flame that looks alive (three layers flickering on their own beat, a pulsing glow, embers rising),
// that turns to ice when a streak freezes (the colours melt from orange to ice blue, a ring of frost bursts out, snow starts to fall), and that
// thaws when it is unfrozen (the ice shatters outward and the fire flares back to life). Plain CSS and SVG, no libraries.

export type FlameState = 'lit' | 'risk' | 'frozen' | 'out' | 'none';
export type FlameBurst = 'freeze' | 'thaw' | null;

// Tells the card when the streak has just frozen or thawed (not on the first draw), so the one-off animation plays once.
export function useFreezeBurst(frozen: boolean, extraThaw = false): FlameBurst {
  const [burst, setBurst] = useState<FlameBurst>(null);
  const prev = useRef<boolean | null>(null);
  const prevExtra = useRef(extraThaw);
  useEffect(() => {
    let kind: FlameBurst = null;
    if (prev.current !== null && prev.current !== frozen) kind = frozen ? 'freeze' : 'thaw';
    else if (prevExtra.current && !extraThaw) kind = 'thaw'; // a broken streak was restored
    prev.current = frozen;
    prevExtra.current = extraThaw;
    if (!kind) return;
    setBurst(kind);
    const t = setTimeout(() => setBurst(null), 1700);
    return () => clearTimeout(t);
  }, [frozen, extraThaw]);
  return burst;
}

const EMBERS = [
  { left: '34%', delay: '0s', dur: '2.1s', size: 5 },
  { left: '52%', delay: '.5s', dur: '2.6s', size: 4 },
  { left: '66%', delay: '1.1s', dur: '2.3s', size: 6 },
  { left: '44%', delay: '1.5s', dur: '2.8s', size: 3 },
  { left: '58%', delay: '.2s', dur: '2.4s', size: 4 },
  { left: '28%', delay: '1.8s', dur: '2.2s', size: 3 },
];
const SHARDS = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2;
  return { dx: Math.round(Math.cos(a) * (46 + (i % 3) * 14)), dy: Math.round(Math.sin(a) * (46 + (i % 3) * 14)), rot: 40 + i * 37, size: 8 + (i % 3) * 3 };
});
const SPARKS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.3;
  return { dx: Math.round(Math.cos(a) * 58), dy: Math.round(Math.sin(a) * 58) - 10, delay: (i % 4) * 0.05 };
});

const CSS = `
.sf-wrap{position:relative;display:inline-block}
.sf-glow{position:absolute;left:50%;bottom:6%;width:150%;height:110%;transform:translateX(-50%);border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,rgba(255,160,40,.55),rgba(255,90,20,.22) 55%,rgba(255,90,20,0) 75%);animation:sfGlow 1.9s ease-in-out infinite}
.sf-frozen .sf-glow{background:radial-gradient(closest-side,rgba(125,211,252,.55),rgba(56,189,248,.22) 55%,rgba(56,189,248,0) 75%);animation:sfGlowIce 3s ease-in-out infinite}
.sf-out .sf-glow,.sf-none .sf-glow{display:none}
.sf-svg{position:relative;width:100%;height:100%;overflow:visible;filter:drop-shadow(0 0 10px rgba(255,140,30,.65))}
.sf-frozen .sf-svg{filter:drop-shadow(0 0 10px rgba(125,211,252,.85))}
.sf-out .sf-svg,.sf-none .sf-svg{filter:none}
.sf-svg path{transition:fill .9s ease}
.sf-o{fill:#FF6A13;transform-origin:50% 92%;animation:sfSway 2.6s ease-in-out infinite}
.sf-m{fill:#FFB020;transform-origin:50% 92%;animation:sfFlick 1.3s ease-in-out infinite}
.sf-i{fill:#FFF3C4;transform-origin:50% 92%;animation:sfFlick2 .85s ease-in-out infinite}
.sf-risk .sf-o{fill:#FF4D2E;animation-duration:1.1s}
.sf-risk .sf-svg{animation:sfPulse 1s ease-in-out infinite;transform-origin:50% 92%}
.sf-frozen .sf-o{fill:#38BDF8;animation:sfShiver 2.8s ease-in-out infinite}
.sf-frozen .sf-m{fill:#7DD3FC;animation:sfShiver 2.8s ease-in-out infinite .3s}
.sf-frozen .sf-i{fill:#E0F2FE;animation:none}
.sf-out .sf-o,.sf-none .sf-o{fill:#8498A8;animation:none}
.sf-out .sf-m,.sf-none .sf-m{fill:#9DB0BE;animation:none}
.sf-out .sf-i,.sf-none .sf-i{fill:#C5D2DC;animation:none}
.sf-ember{position:absolute;bottom:18%;border-radius:50%;background:#FFD27A;box-shadow:0 0 6px 2px rgba(255,170,50,.8);opacity:0;animation:sfRise linear infinite;pointer-events:none}
.sf-flake{position:absolute;color:#E0F2FE;text-shadow:0 0 6px rgba(125,211,252,.9);opacity:0;animation:sfSnow linear infinite;pointer-events:none;line-height:1}
.sf-frost{position:absolute;color:#E0F2FE;text-shadow:0 0 8px #7dd3fc;pointer-events:none;animation:sfTwinkle 2.4s ease-in-out infinite}
.sf-ring{position:absolute;left:50%;top:55%;width:40%;height:34%;border:3px solid #BAE6FD;border-radius:50%;transform:translate(-50%,-50%) scale(.3);opacity:0;animation:sfRing 1.1s ease-out forwards;pointer-events:none}
.sf-ring2{animation-delay:.18s;border-color:#7DD3FC}
.sf-shard{position:absolute;left:50%;top:52%;background:linear-gradient(135deg,#E0F2FE,#38BDF8);clip-path:polygon(50% 0,100% 100%,0 100%);opacity:0;animation:sfShard 1s cubic-bezier(.15,.8,.3,1) forwards;pointer-events:none}
.sf-spark{position:absolute;left:50%;top:50%;width:7px;height:7px;border-radius:50%;background:#FFD27A;box-shadow:0 0 8px 3px rgba(255,150,40,.9);opacity:0;animation:sfSpark .9s ease-out forwards;pointer-events:none}
.sf-flash{position:absolute;left:50%;top:55%;width:170%;height:170%;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;opacity:0;animation:sfFlash 1s ease-out forwards}
.sf-freezing .sf-svg{animation:sfFreezeIn 1.3s ease-out}
.sf-thawing .sf-svg{animation:sfIgnite 1.2s cubic-bezier(.2,1.5,.4,1)}
.sf-bigger .sf-svg{animation:sfIgnite .9s cubic-bezier(.2,1.5,.4,1)}
@keyframes sfSway{0%,100%{transform:rotate(-2deg) scale(1,1)}50%{transform:rotate(2.5deg) scale(1.03,1.05)}}
@keyframes sfFlick{0%,100%{transform:scale(1,1) skewX(0)}30%{transform:scale(.96,1.07) skewX(-3deg)}65%{transform:scale(1.04,.96) skewX(3deg)}}
@keyframes sfFlick2{0%,100%{transform:scale(1,1)}50%{transform:scale(.92,1.12)}}
@keyframes sfPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
@keyframes sfGlow{0%,100%{opacity:.75;transform:translateX(-50%) scale(.95)}50%{opacity:1;transform:translateX(-50%) scale(1.08)}}
@keyframes sfGlowIce{0%,100%{opacity:.6;transform:translateX(-50%) scale(.95)}50%{opacity:.95;transform:translateX(-50%) scale(1.05)}}
@keyframes sfRise{0%{opacity:0;transform:translate(0,0) scale(1)}15%{opacity:1}100%{opacity:0;transform:translate(var(--dr,6px),-95px) scale(.3)}}
@keyframes sfSnow{0%{opacity:0;transform:translateY(-8px) rotate(0)}15%{opacity:.95}100%{opacity:0;transform:translateY(100px) rotate(200deg)}}
@keyframes sfTwinkle{0%,100%{opacity:.35;transform:scale(.8) rotate(0)}50%{opacity:1;transform:scale(1.15) rotate(25deg)}}
@keyframes sfShiver{0%,100%{transform:translateX(0)}25%{transform:translateX(-1.6px)}75%{transform:translateX(1.6px)}}
@keyframes sfRing{0%{opacity:.95;transform:translate(-50%,-50%) scale(.3)}100%{opacity:0;transform:translate(-50%,-50%) scale(3.2)}}
@keyframes sfFreezeIn{0%{filter:drop-shadow(0 0 22px rgba(255,200,120,.95));transform:scale(1.18)}45%{filter:drop-shadow(0 0 26px rgba(186,230,253,1)) brightness(1.5);transform:scale(.9)}100%{transform:scale(1)}}
@keyframes sfShard{0%{opacity:1;transform:translate(-50%,-50%) translate(0,0) rotate(0) scale(.6)}100%{opacity:0;transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1.1)}}
@keyframes sfSpark{0%{opacity:1;transform:translate(-50%,-50%) translate(0,0) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) scale(.2)}}
@keyframes sfIgnite{0%{transform:scale(.25) translateY(14px);opacity:.3;filter:drop-shadow(0 0 4px rgba(255,255,255,1))}55%{transform:scale(1.35) translateY(-4px);opacity:1;filter:drop-shadow(0 0 28px rgba(255,190,60,1)) brightness(1.4)}100%{transform:scale(1);opacity:1}}
@keyframes sfFlash{0%{opacity:.95;transform:translate(-50%,-50%) scale(.2);background:radial-gradient(closest-side,#fff,rgba(255,220,150,.6) 45%,rgba(255,150,40,0) 70%)}100%{opacity:0;transform:translate(-50%,-50%) scale(1);background:radial-gradient(closest-side,#fff,rgba(255,220,150,.6) 45%,rgba(255,150,40,0) 70%)}}
@media (prefers-reduced-motion: reduce){.sf-wrap *,.sf-wrap{animation:none!important}.sf-ember,.sf-flake{display:none}}
`;

function Styles() {
  return <style>{CSS}</style>;
}

export default function StreakFlame({ state, size = 84, burst = null, ignite = 0 }: { state: FlameState; size?: number; burst?: FlameBurst; ignite?: number }) {
  const alive = state === 'lit' || state === 'risk';
  const frozen = state === 'frozen';
  const cls = ['sf-wrap', `sf-${state}`, burst === 'freeze' ? 'sf-freezing' : '', burst === 'thaw' ? 'sf-thawing' : '', ignite > 0 && !burst ? 'sf-bigger' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ width: size, height: size * 1.2 }} key={`flame-${ignite}`}>
      <Styles />
      <div className="sf-glow" />
      <svg viewBox="0 0 100 120" className="sf-svg" aria-hidden="true">
        <path className="sf-o" d="M50 2c5 21 28 33 28 64 0 27-15 50-28 50S22 93 22 66C22 43 37 39 39 20c7 6 9 13 11-18z" />
        <path className="sf-m" d="M50 38c3 15 17 23 17 44 0 17-8 30-17 30S33 99 33 82c0-15 11-19 17-44z" />
        <path className="sf-i" d="M50 70c2 9 9 13 9 23 0 8-4 15-9 15s-9-7-9-15c0-10 7-14 9-23z" />
      </svg>

      {alive && EMBERS.map((e, i) => (
        <span key={i} className="sf-ember" style={{ left: e.left, width: e.size, height: e.size, animationDelay: e.delay, animationDuration: e.dur, ['--dr' as any]: `${(i % 2 ? 1 : -1) * (4 + i * 2)}px` }} />
      ))}

      {frozen && (
        <>
          <span className="sf-frost" style={{ left: '4%', top: '18%', fontSize: size * 0.2 }}>❄</span>
          <span className="sf-frost" style={{ right: '2%', top: '36%', fontSize: size * 0.26, animationDelay: '.8s' }}>❄</span>
          <span className="sf-frost" style={{ left: '16%', bottom: '10%', fontSize: size * 0.16, animationDelay: '1.5s' }}>✦</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="sf-flake" style={{ left: `${10 + i * 19}%`, top: '-6%', fontSize: 9 + (i % 3) * 3, animationDuration: `${2.6 + (i % 3) * 0.7}s`, animationDelay: `${i * 0.55}s` }}>❄</span>
          ))}
        </>
      )}

      {burst === 'freeze' && (
        <>
          <span className="sf-ring" />
          <span className="sf-ring sf-ring2" />
          {SHARDS.slice(0, 6).map((s, i) => (
            <span key={i} className="sf-shard" style={{ width: s.size, height: s.size * 1.3, animationDelay: `${0.2 + i * 0.03}s`, ['--dx' as any]: `${s.dx * 0.7}px`, ['--dy' as any]: `${s.dy * 0.7}px`, ['--rot' as any]: `${s.rot}deg` }} />
          ))}
        </>
      )}

      {burst === 'thaw' && (
        <>
          <span className="sf-flash" />
          {SHARDS.map((s, i) => (
            <span key={i} className="sf-shard" style={{ width: s.size, height: s.size * 1.3, ['--dx' as any]: `${s.dx}px`, ['--dy' as any]: `${s.dy}px`, ['--rot' as any]: `${s.rot}deg` }} />
          ))}
          {SPARKS.map((s, i) => (
            <span key={`s${i}`} className="sf-spark" style={{ animationDelay: `${0.25 + s.delay}s`, ['--dx' as any]: `${s.dx}px`, ['--dy' as any]: `${s.dy}px` }} />
          ))}
        </>
      )}
    </div>
  );
}

// Snow drifting across a whole card while its streak is frozen. Put it inside a `relative overflow-hidden` card, behind the content.
export function Snowfield({ show }: { show: boolean }) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl transition-opacity duration-1000" style={{ opacity: show ? 1 : 0 }} aria-hidden="true">
      <Styles />
      {Array.from({ length: 14 }).map((_, i) => (
        <span key={i} className="sf-flake" style={{ left: `${(i * 37) % 100}%`, top: '-4%', fontSize: 8 + (i % 4) * 3, animationDuration: `${3.4 + (i % 5) * 0.8}s`, animationDelay: `${(i % 7) * 0.6}s`, animationName: 'sfSnow' }}>❄</span>
      ))}
    </div>
  );
}
