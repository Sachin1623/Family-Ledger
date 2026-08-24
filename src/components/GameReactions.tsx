import React, { useEffect, useRef, useState } from 'react';

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

export interface LastReaction {
  emoji: string;
  uid: string;
  displayName: string;
  at: string;
}

interface ReactionButtonProps {
  onSend: (emoji: string) => void;
  disabled?: boolean;
  className?: string;
}

// A single compact button — same size/shape as ChatButton/HelpButton, meant to sit inline right
// next to a game screen's title — that expands into the emoji picker on tap instead of
// permanently floating a whole pill of emoji over the board (which used to sit fixed above the
// bottom nav, always on screen, covering game controls on smaller screens). Sending is
// fire-and-forget (server just stamps `lastReaction` on the game doc) — no per-tap loading state,
// since a dropped reaction is inconsequential.
export function ReactionButton({ onSend, disabled, className }: ReactionButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={`p-2 shrink-0 ${className || ''}`}
        aria-label="Send a reaction"
      >
        <span className="text-[18px] leading-none block">😀</span>
      </button>
      {open && (
        <>
          {/* Invisible full-screen tap-catcher, below the picker itself — closes the picker on any
              outside tap without needing a document-level listener. */}
          <div className="fixed inset-0 z-[199]" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-[200] flex items-center gap-0.5 bg-white rounded-full shadow-lg border border-border-subtle px-1.5 py-1.5">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  onSend(emoji);
                  setOpen(false);
                }}
                className="text-xl w-9 h-9 flex items-center justify-center rounded-full active:scale-90 transition-transform"
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface FloatingReaction {
  id: number;
  emoji: string;
  displayName: string;
  left: number;
}

let reactionIdCounter = 0;

// Tracks a game doc's `lastReaction` field and turns each NEW value into a floating burst that
// self-removes after 3s. The reaction present on mount (an old one from before this player
// opened the screen) is deliberately swallowed — only changes seen while mounted should fire.
export function useReactionOverlay(lastReaction: LastReaction | null | undefined): FloatingReaction[] {
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const seenAtRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (seenAtRef.current === undefined) {
      seenAtRef.current = lastReaction?.at ?? null;
      return;
    }
    if (!lastReaction || lastReaction.at === seenAtRef.current) return;
    seenAtRef.current = lastReaction.at;

    const id = ++reactionIdCounter;
    setFloating((prev) => [
      ...prev,
      { id, emoji: lastReaction.emoji, displayName: lastReaction.displayName, left: 20 + Math.random() * 60 },
    ]);
    setTimeout(() => setFloating((prev) => prev.filter((f) => f.id !== id)), 3000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastReaction?.at, lastReaction?.emoji, lastReaction?.displayName]);

  return floating;
}

export function ReactionOverlay({ reactions }: { reactions: FloatingReaction[] }) {
  if (reactions.length === 0) return null;
  return (
    <div className="fixed inset-0 z-[190] pointer-events-none overflow-hidden">
      {reactions.map((r) => (
        <div key={r.id} className="reaction-float absolute bottom-24 flex flex-col items-center" style={{ left: `${r.left}%` }}>
          <span className="text-4xl drop-shadow-lg">{r.emoji}</span>
          <span className="text-[10px] font-bold text-white bg-black/50 px-2 py-0.5 rounded-full mt-1 whitespace-nowrap">
            {r.displayName}
          </span>
        </div>
      ))}
    </div>
  );
}
