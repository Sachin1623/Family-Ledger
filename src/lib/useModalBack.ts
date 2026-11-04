import { useEffect, useRef } from 'react';
import { pushModalBackHandler, popModalBackHandler } from './modalBackHandler';

// Makes the phone's Back (and the browser's) close a floating sheet instead of leaving the screen behind it. Each layer registers its
// own handler, so a sheet opened over another one unwinds one layer at a time. `enabled` lets a layer step aside while a smaller one
// (a "discard changes?" box) sits on top of it.
export function useModalBack(onBack: () => void, enabled = true) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    const handler = () => latest.current();
    pushModalBackHandler(handler);
    return () => popModalBackHandler(handler);
  }, [enabled]);
}

// the same, for a place that only has a render slot to put it in
export function BackClose({ onBack }: { onBack: () => void }) {
  useModalBack(onBack);
  return null;
}
