import React, { useEffect, useRef, type ReactNode } from 'react';

// A row that slides left to show Edit, Move and Delete behind it.
// Smoothness: while the finger is down the row is moved straight through a GPU transform on the element (no React re-render per move), then released with a short
// spring. Scrolling up and down is never blocked (touch-action: pan-y): the row only takes over once the finger has clearly gone sideways.
// Only one row is open at a time (a window event closes the others).
const BTN = 68;
const WIDTH = BTN * 3;
const OPEN_EVENT = 'fl-swipe-open';

export default function SwipeRow({ id, children, className, onTap, onEdit, onMove, onDelete }: {
  id: string;
  children: ReactNode;
  className?: string;
  onTap: () => void;
  onEdit: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const fg = useRef<HTMLDivElement>(null);
  const acts = useRef<HTMLDivElement>(null);
  const st = useRef({ x: 0, startX: 0, startY: 0, base: 0, dragging: false, locked: false, moved: false, open: false, pid: -1 });

  const paint = (x: number, animate: boolean) => {
    st.current.x = x;
    if (fg.current) {
      fg.current.style.transition = animate ? 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
      fg.current.style.transform = `translate3d(${x}px,0,0)`;
    }
    if (acts.current) {
      acts.current.style.transition = animate ? 'opacity 200ms ease' : 'none';
      acts.current.style.opacity = String(Math.min(1, Math.abs(x) / 70));
      acts.current.style.visibility = x === 0 && animate ? 'hidden' : 'visible';
    }
  };
  const settle = (open: boolean) => {
    st.current.open = open;
    paint(open ? -WIDTH : 0, true);
    if (open) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
  };

  useEffect(() => {
    const onOther = (e: Event) => { if ((e as CustomEvent).detail !== id && st.current.open) settle(false); };
    window.addEventListener(OPEN_EVENT, onOther);
    if (acts.current) acts.current.style.visibility = 'hidden';
    return () => window.removeEventListener(OPEN_EVENT, onOther);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const down = (e: React.PointerEvent) => {
    const s = st.current;
    s.startX = e.clientX; s.startY = e.clientY; s.base = s.x; s.dragging = true; s.locked = false; s.moved = false; s.pid = e.pointerId;
  };
  const move = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.dragging) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.locked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { s.dragging = false; return; } // an up/down scroll: leave it alone
      s.locked = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (acts.current) acts.current.style.visibility = 'visible';
    }
    s.moved = true;
    let x = s.base + dx;
    if (x > 0) x = x * 0.2;                                        // a little give when pulled the wrong way
    if (x < -WIDTH) x = -WIDTH - (-WIDTH - x) * 0.25;              // and a little past the end
    paint(x, false);
  };
  const up = () => {
    const s = st.current;
    if (!s.dragging) return;
    s.dragging = false;
    if (!s.locked) return;
    settle(s.x < -WIDTH * 0.45 || (s.open && s.x < -WIDTH * 0.8));
  };

  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const s = st.current;
    if (s.moved) { s.moved = false; return; }
    if (s.open) { settle(false); return; }
    onTap();
  };
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); settle(false); fn(); };

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div ref={acts} className="absolute right-0 top-0 bottom-0 flex" style={{ width: WIDTH }}>
        <button type="button" onClick={act(onEdit)} className="flex-1 flex flex-col items-center justify-center gap-0.5 bg-[#3d85c6] text-white text-[10.5px] font-extrabold active:brightness-90">
          <span className="material-symbols-outlined text-[20px]">edit</span>Edit
        </button>
        <button type="button" onClick={act(onMove)} className="flex-1 flex flex-col items-center justify-center gap-0.5 bg-[#f0a04b] text-white text-[10.5px] font-extrabold active:brightness-90">
          <span className="material-symbols-outlined text-[20px]">drive_file_move</span>Move
        </button>
        <button type="button" onClick={act(onDelete)} className="flex-1 flex flex-col items-center justify-center gap-0.5 bg-[#e04b4b] text-white text-[10.5px] font-extrabold active:brightness-90">
          <span className="material-symbols-outlined text-[20px]">delete</span>Delete
        </button>
      </div>
      <div
        ref={fg}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClick={click}
        className={className}
        style={{ touchAction: 'pan-y', willChange: 'transform', position: 'relative' }}
      >
        {children}
      </div>
    </div>
  );
}
