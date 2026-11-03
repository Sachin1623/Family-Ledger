import React, { useRef } from 'react';
import { clsx } from 'clsx';

// A store button: tap to pick it, hold it for half a second to rename the store.
export default function StoreChip({ name, selected, onSelect, onLongPress, className }: {
  key?: React.Key; // lets a list of chips be keyed
  name: string;
  selected: boolean;
  onSelect: () => void;
  onLongPress: () => void;
  className?: string;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = () => {
    fired.current = false;
    timer.current = setTimeout(() => { fired.current = true; onLongPress(); }, 500);
  };
  const stop = () => { if (timer.current) clearTimeout(timer.current); };
  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => { if (fired.current) { fired.current = false; return; } onSelect(); }}
      className={clsx('select-none', className)}
      style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      aria-pressed={selected}
      title="Tap to choose, hold to rename"
    >
      🏪 {name}
    </button>
  );
}
