import { useCallback, useEffect, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent, type TouchEvent } from 'react';

// The floating icons on the home page (quests, to-dos, shopping) rest tucked against the left edge with only a sliver showing, so they stop covering the
// cards. They share one state: tap (or swipe right on) any of them and all slide out; tap an icon while out to use it; swipe left, or leave them alone for
// a few seconds, and they tuck away again.
const PEEK = 18;
const AUTO_TUCK_MS = 5000;
const LEFT_GUTTER = 16; // the icons sit 1rem from the edge

let docked = true;
const listeners = new Set<() => void>();
const setDocked = (v: boolean) => { if (docked !== v) { docked = v; listeners.forEach((l) => l()); } };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getDocked = () => docked;

export function useEdgeDock(width: number) {
  const isDocked = useSyncExternalStore(subscribe, getDocked, getDocked);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  // tuck away again after a few quiet seconds
  useEffect(() => {
    if (isDocked) return;
    const t = setTimeout(() => setDocked(true), AUTO_TUCK_MS);
    return () => clearTimeout(t);
  }, [isDocked]);

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (swiped.current) { swiped.current = false; e.preventDefault(); e.stopPropagation(); return; }
    if (docked) { e.preventDefault(); e.stopPropagation(); setDocked(false); }
  }, []);
  const onTouchStart = useCallback((e: TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; swiped.current = false; }, []);
  const onTouchEnd = useCallback((e: TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) < 24 || Math.abs(dx) < Math.abs(dy)) return;
    swiped.current = true;
    setDocked(dx < 0);
  }, []);

  return {
    docked: isDocked,
    style: {
      transform: isDocked ? `translateX(${-(LEFT_GUTTER + width - PEEK)}px)` : 'translateX(0)',
      transition: 'transform .25s ease',
    } as CSSProperties,
    handlers: { onClickCapture, onTouchStart, onTouchEnd },
  };
}
