import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';

// Wraps a card so it can be picked up and dropped somewhere else (another group, back to the loose
// cards, onto the table to play/discard). While held, the real card goes invisible and a copy
// follows it through a portal on <body> at a very high z-index — so the card is always drawn ON TOP
// of the table (and never clipped by the scrolling hand area it started in).
export default function DraggableCard({
  enabled,
  draggedFlag,
  onDragState,
  onDrop,
  onTap,
  children,
}: {
  enabled: boolean;
  // Set true from the first movement until just after release, so the click a browser fires at the
  // end of a drag is never mistaken for a tap.
  draggedFlag: React.MutableRefObject<boolean>;
  onDragState: (dragging: boolean) => void;
  // Receives the dragged card's on-screen rectangle at the moment it was released.
  onDrop: (cardRect: DOMRect) => void;
  // A plain tap/click on the card (ignored for the click a browser fires right after a drag).
  onTap?: () => void;
  children: React.ReactNode;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<DOMRect | null>(null);
  // The wrapper can be narrower than the card it holds (cards overlap), so measure the card itself.
  const cardRect = () => (elRef.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect() ?? null;

  return (
    <>
      <motion.div
        ref={elRef}
        drag={enabled}
        dragSnapToOrigin
        dragElastic={0.15}
        dragMomentum={false}
        onDragStart={() => { draggedFlag.current = true; onDragState(true); setGhost(cardRect()); }}
        onDrag={() => setGhost(cardRect())}
        onDragEnd={() => {
          const rect = cardRect();
          setGhost(null);
          onDragState(false);
          setTimeout(() => { draggedFlag.current = false; }, 100);
          if (rect) onDrop(rect);
        }}
        onClick={onTap ? () => { if (!draggedFlag.current) onTap(); } : undefined}
        className={`relative touch-none ${ghost ? 'opacity-0' : ''}`}
      >
        {children}
      </motion.div>
      {ghost && createPortal(
        <div
          style={{ position: 'fixed', left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height, zIndex: 400 }}
          className="pointer-events-none scale-110 drop-shadow-2xl"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
