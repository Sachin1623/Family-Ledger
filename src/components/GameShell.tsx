import React from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';

// The one look every game screen (waiting room and live table) is built on, so moving from one game to another feels
// like the same app: a full-screen navy backdrop, a slim header (back · title + subtitle · actions), an optional status
// strip for whose turn it is, and dark cards. A game keeps its own table art (felt, board) inside the body.

export const GAME_CARD = 'rounded-2xl bg-[#121a2e] border border-[#1f2a47]';
export const GAME_CARD_INNER = 'rounded-xl bg-[#0c1230] border border-[#1f2a47]';
export const GAME_LABEL = 'text-[10px] font-black tracking-[0.14em] text-amber-300';
export const GAME_BTN_PRIMARY = 'text-[#1a1300] bg-gradient-to-r from-amber-300 to-amber-200 shadow-[0_5px_0_#b88a1d] active:translate-y-0.5';
export const GAME_BTN_QUIET = 'bg-[#121a2e] border border-[#1f2a47] text-slate-100';

export function GameShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <div
        className="fixed inset-0 z-[150] flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white bg-[radial-gradient(ellipse_at_50%_0%,#1d2b57_0%,#0c1230_55%,#070a18_100%)]"
        style={{ ['--game-accent' as any]: '#f5c451' }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,0.14)_1px,transparent_1.5px)] [background-size:24px_24px]" />
        {children}
      </div>
    </div>
  );
}

export function GameHeader({
  title,
  subtitle,
  backTo,
  onBack,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  backTo?: string;
  onBack?: () => void;
  actions?: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="relative shrink-0 flex items-center gap-2 px-3 pt-2">
      <button onClick={onBack || (() => backTo && navigate(backTo))} className="w-8 h-8 rounded-full bg-white/12 flex items-center justify-center shrink-0" aria-label="Back">
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
      </button>
      <div className="leading-tight min-w-0">
        <h1 className="text-[15px] font-black truncate">{title}</h1>
        {subtitle && <span className="block text-[8px] font-bold tracking-[0.14em] text-white/60 uppercase truncate">{subtitle}</span>}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-0.5 shrink-0 [&_.text-primary]:!text-white [&_.text-text-muted]:!text-white">{actions}</div>
    </header>
  );
}

// Leave / quit icon, always the last action and always the same red.
export function GameLeaveButton({ onClick, label = 'Leave game' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="p-1.5 !text-red-300 shrink-0" aria-label={label}>
      <span className="material-symbols-outlined text-[22px] block">logout</span>
    </button>
  );
}

// "Your turn — draw" strip under the header, with the turn countdown.
export function GameStatusBar({
  text,
  mine,
  seconds,
  warn,
  right,
}: {
  text: string;
  mine?: boolean;
  seconds?: number | null;
  warn?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <div className={clsx('relative shrink-0 mx-3 mt-2 rounded-xl border px-3 py-1.5 flex items-center gap-2', mine ? 'bg-[#2a1d05] border-amber-300/60' : 'bg-[#121a2e] border-[#1f2a47]')}>
      <p className={clsx('flex-1 min-w-0 truncate text-[12px] font-extrabold', mine ? 'text-amber-300' : 'text-white/70')}>{text}</p>
      {right}
      {seconds != null && (
        <span className={clsx('text-[11px] font-black px-2 py-0.5 rounded-full shrink-0', warn ? 'bg-red-500/20 text-red-300 animate-pulse' : 'bg-white/10 text-white/70')}>{seconds}s</span>
      )}
    </div>
  );
}
