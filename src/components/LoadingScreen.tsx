import React from 'react';

// The app-wide loading state (auth resolving, route guards) — replaces a bare "Loading..." text
// with something that actually reads as FamilyLedger: the same rounded-square ledger mark and
// green→blue gradient as the real logo (public/logo.svg's icon portion, reused inline here so it
// can be recolored/animated independently of the static asset), a slowly rotating gradient "comet
// tail" ring around it (a common modern indeterminate-spinner style — thin, tapering arc rather
// than a plain solid ring), and the icon itself gently breathing via a pulse.
export default function LoadingScreen({ fullScreen = true, className = '' }: { fullScreen?: boolean; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-5 ${fullScreen ? 'h-screen' : 'py-20'} ${className}`}>
      <div className="relative w-20 h-20">
        <div
          className="absolute inset-0 rounded-full animate-spin"
          style={{
            background: 'conic-gradient(from 0deg, #4ADE80, #3B82F6, transparent 65%)',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
            animationDuration: '1.1s',
          }}
        />
        <div className="absolute inset-[10px] rounded-2xl shadow-lg overflow-hidden animate-pulse">
          <svg viewBox="0 0 80 100" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <rect width="80" height="100" rx="12" fill="url(#ledger_grad_loading)" />
            <path d="M60 30C60 26.6863 62.6863 24 66 24H80V76H66C62.6863 76 60 73.3137 60 70V30Z" fill="#1E3A8A" />
            <circle cx="25" cy="30" r="8" fill="white" fillOpacity="0.9" />
            <path d="M15 40C15 38.8954 15.8954 38 17 38H33C34.1046 38 35 38.8954 35 40V65H15V40Z" fill="white" fillOpacity="0.9" />
            <circle cx="45" cy="35" r="7" fill="white" fillOpacity="0.8" />
            <path d="M38 42C38 40.8954 38.8954 40 40 40H50C51.1046 40 52 40.8954 52 42V65H38V42Z" fill="white" fillOpacity="0.8" />
            <circle cx="35" cy="60" r="5" fill="white" />
            <path d="M30 65C30 64.4477 30.4477 64 31 64H39C39.5523 64 40 64.4477 40 65V75H30V65Z" fill="white" />
            <circle cx="55" cy="62" r="5" fill="white" />
            <path d="M50 67C50 66.4477 50.4477 66 51 66H59C59.5523 66 60 66.4477 60 67V75H50V67Z" fill="white" />
            <defs>
              <linearGradient id="ledger_grad_loading" x1="0" y1="0" x2="80" y2="100" gradientUnits="userSpaceOnUse">
                <stop stopColor="#4ADE80" />
                <stop offset="1" stopColor="#3B82F6" />
              </linearGradient>
            </defs>
          </svg>
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
