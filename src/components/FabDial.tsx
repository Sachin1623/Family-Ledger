import React, { useEffect, useSyncExternalStore } from 'react';

// The shortcuts that used to float all over the Home screen (quests, to-dos, shopping list, talk an expense) now live behind the main
// "Add Expense" button: one handle (or a long press on the button) fans them out above it, each with a label. Only the main button is on screen
// the rest of the time.
//
// This file is the shared state and the look of one fanned-out item. Each shortcut component (QuestFab, TodoFab, ShoppingFab, and the talk item in
// Navigation) registers itself here when it has something to show, gets its place in the stack, and draws itself with <DialItem>.
export type DialId = 'talk' | 'shopping' | 'todo' | 'quest';
const ORDER: DialId[] = ['talk', 'shopping', 'todo', 'quest']; // nearest the main button first

let open = false;
let present = new Set<DialId>();
let pending = new Set<DialId>(); // shortcuts with something waiting (a reward to collect, a to-do due, items to buy)
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const setDialOpen = (v: boolean) => { if (open !== v) { open = v; emit(); } };

// snapshot: a string, so useSyncExternalStore sees a stable value until something really changes
const snapshot = () => `${open ? 1 : 0}|${ORDER.filter((id) => present.has(id)).join(',')}|${ORDER.filter((id) => pending.has(id) && present.has(id)).join(',')}`;

export function useFabDial() {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [o, list, waiting] = snap.split('|');
  return { open: o === '1', count: list ? list.split(',').length : 0, pendingCount: waiting ? waiting.split(',').length : 0, setOpen: setDialOpen };
}

// registers this shortcut while it is showing, and says which place it takes in the stack (0 = nearest the main button)
export function useDialSlot(id: DialId, shown: boolean, waiting = false): number {
  useEffect(() => {
    if (!shown || !waiting) return;
    pending = new Set(pending).add(id);
    emit();
    return () => { const n = new Set(pending); n.delete(id); pending = n; emit(); };
  }, [id, shown, waiting]);
  useEffect(() => {
    if (!shown) return;
    present = new Set(present).add(id);
    emit();
    return () => { const n = new Set(present); n.delete(id); present = n; emit(); };
  }, [id, shown]);
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  const list = (snap.split('|')[1] || '').split(',').filter(Boolean) as DialId[];
  const idx = list.indexOf(id);
  return idx >= 0 ? idx : ORDER.indexOf(id);
}

export function DialItem({
  slot, label, onClick, ariaLabel, size = 52, buttonStyle, buttonClassName = 'rounded-full bg-white shadow-lg flex items-center justify-center', children,
}: {
  slot: number; label: string; onClick: () => void; ariaLabel: string; size?: number;
  buttonStyle?: React.CSSProperties; buttonClassName?: string; children: React.ReactNode;
}) {
  const { open: isOpen } = useFabDial();
  return (
    <div
      className="fixed right-4 z-[41] flex items-center gap-2.5"
      style={{
        bottom: `calc(4rem + env(safe-area-inset-bottom) + 12px + 48px + 14px + ${slot * 64}px)`,
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none',
        transform: isOpen ? 'translateY(0) scale(1)' : 'translateY(18px) scale(0.85)',
        transition: `opacity .18s ease ${isOpen ? slot * 35 : 0}ms, transform .22s cubic-bezier(.2,.9,.3,1.2) ${isOpen ? slot * 35 : 0}ms`,
        transformOrigin: 'right bottom',
      }}
      aria-hidden={!isOpen}
    >
      <button type="button" onClick={() => { setDialOpen(false); onClick(); }} className="rounded-xl bg-white px-3 py-1.5 text-sm font-bold text-[#06222f] shadow-lg active:scale-95 transition-transform" tabIndex={isOpen ? 0 : -1}>
        {label}
      </button>
      <button
        type="button"
        onClick={() => { setDialOpen(false); onClick(); }}
        aria-label={ariaLabel}
        tabIndex={isOpen ? 0 : -1}
        className={`relative shrink-0 active:scale-95 transition-transform ${buttonClassName}`}
        style={{ width: size, height: size, ...buttonStyle }}
      >
        {children}
      </button>
    </div>
  );
}
