import React, { useEffect, useRef, useState } from 'react';
import { pushModalBackHandler, popModalBackHandler } from '../lib/modalBackHandler';

// Full-size image viewer — shared by every "attached photo" thumbnail in the app (Add Expense,
// To-Do, Recurring Expenses, Scheduled reminders' ImageAttachments picker, the To-Do list row,
// ExpenseQuickView) so expanding a photo always looks and behaves the same.
// Deliberately its own top-level overlay (not nested inside whatever button rendered the
// thumbnail) so it can never be an ancestor of a delete/remove button — nothing inside it can
// accidentally trigger an unrelated click handler from the thumbnail that opened it.
//
// Registers with modalBackHandler so a hardware/gesture back press (or a browser back) closes
// just the photo and lands back on the page underneath, instead of falling through to that
// page's own back navigation and leaving twice in one press — baked in here once so every screen
// above gets it for free rather than each needing its own pushModalBackHandler/popModalBackHandler.
//
// Zoom: pinch with two fingers, double-tap (or double-click) to toggle 1x/2.5x, mouse wheel on
// desktop, and the +/- buttons. When zoomed, one finger drags the image. A tap on the dark
// backdrop closes it only while NOT zoomed in, so a pan that ends off the image never dismisses it.
const MIN = 1;
const MAX = 5;

type Pt = { x: number; y: number };

export default function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState<Pt>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Live values for the pointer handlers (state would be stale inside them).
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ dist: number; scale: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const moved = useRef(false);

  useEffect(() => {
    pushModalBackHandler(onClose);
    return () => popModalBackHandler(onClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (s: number, x: number, y: number) => {
    const ns = Math.min(MAX, Math.max(MIN, s));
    // Back at 1x the image re-centres; otherwise let it pan freely (bounded loosely by size).
    const lim = 600 * ns;
    const nx = ns === 1 ? 0 : Math.max(-lim, Math.min(lim, x));
    const ny = ns === 1 ? 0 : Math.max(-lim, Math.min(lim, y));
    view.current = { scale: ns, x: nx, y: ny };
    setScale(ns);
    setPos({ x: nx, y: ny });
  };

  const zoomBy = (f: number) => apply(view.current.scale * f, view.current.x, view.current.y);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = Array.from<Pt>(pointers.current.values());
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: view.current.scale, moved: true };
    }
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size >= 2 && gesture.current) {
      const [a, b] = Array.from<Pt>(pointers.current.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      moved.current = true;
      apply(gesture.current.scale * (d / gesture.current.dist), view.current.x, view.current.y);
    } else if (view.current.scale > 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) moved.current = true;
      apply(view.current.scale, view.current.x + dx, view.current.y + dy);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const onImageClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (moved.current) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      if (view.current.scale > 1) apply(1, 0, 0);
      else apply(2.5, 0, 0);
    } else {
      lastTap.current = now;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };

  const zoomed = scale > 1;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 overflow-hidden"
      onClick={() => {
        if (!zoomed && !moved.current) onClose();
      }}
      onWheel={onWheel}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 z-10 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
        aria-label="Close"
      >
        <span className="material-symbols-outlined">close</span>
      </button>

      <img
        src={src}
        alt=""
        draggable={false}
        className="max-w-full max-h-full rounded-xl select-none"
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
          transition: dragging ? 'none' : 'transform 0.18s ease-out',
          touchAction: 'none',
          cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onImageClick}
      />

      <div
        className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 text-white"
        style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="Zoom out" disabled={scale <= MIN} onClick={() => zoomBy(1 / 1.5)} className="w-9 h-9 rounded-full hover:bg-white/15 disabled:opacity-30 flex items-center justify-center">
          <span className="material-symbols-outlined">remove</span>
        </button>
        <button type="button" aria-label="Reset zoom" onClick={() => apply(1, 0, 0)} className="min-w-[3.25rem] text-xs font-bold tabular-nums">
          {Math.round(scale * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" disabled={scale >= MAX} onClick={() => zoomBy(1.5)} className="w-9 h-9 rounded-full hover:bg-white/15 disabled:opacity-30 flex items-center justify-center">
          <span className="material-symbols-outlined">add</span>
        </button>
      </div>
    </div>
  );
}
