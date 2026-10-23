import React from 'react';
import AnimatedIcon from './AnimatedIcon';

// The app-wide loading state (auth resolving, route guards) — replaces a bare "Loading..." text
// with something that actually reads as FamilyLedger: the same rounded-square ledger mark and
// green→blue gradient as the real logo (public/logo.svg's icon portion, reused inline here so it
// can be recolored/animated independently of the static asset), a slowly rotating gradient "comet
// tail" ring around it (a common modern indeterminate-spinner style — thin, tapering arc rather
// than a plain solid ring), and the icon itself gently breathing via a pulse.
export default function LoadingScreen({ fullScreen = true, className = '' }: { fullScreen?: boolean; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-5 ${fullScreen ? 'h-screen' : 'py-20'} ${className}`}>
      <style>{`@keyframes lsBar{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}@media (prefers-reduced-motion: reduce){.ls-bar{animation:none!important;transform:none!important;width:100%!important}}`}</style>
      <div className="flex flex-col items-center gap-4">
        <AnimatedIcon size={132} mode="loop" radius="rounded-[28px]" className="shadow-xl ring-1 ring-black/5" />
        {/* the horizontal bar: a bright block gliding along a track while the app gets ready */}
        <div className="relative w-44 h-1.5 rounded-full bg-slate-200 overflow-hidden">
          <div className="ls-bar absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-[#4ADE80] to-[#3B82F6]" style={{ animation: 'lsBar 1.3s ease-in-out infinite' }} />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-text-muted uppercase tracking-[0.25em]">Loading</span>
        <span className="flex gap-0.5 pb-0.5">
          <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
        </span>
      </div>
    </div>
  );
}
