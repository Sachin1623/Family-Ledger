import React, { useEffect } from 'react';
import { pushModalBackHandler, popModalBackHandler } from '../lib/modalBackHandler';

// Full-size, tap-to-dismiss image viewer — shared by every "attached photo" thumbnail in the
// app (Add Expense, To-Do, Recurring Expenses, Scheduled reminders' ImageAttachments picker,
// the To-Do list row, ExpenseQuickView) so expanding a photo always looks and behaves the same.
// Deliberately its own top-level overlay (not nested inside whatever button rendered the
// thumbnail) so it can never be an ancestor of a delete/remove button — nothing inside it can
// accidentally trigger an unrelated click handler from the thumbnail that opened it.
//
// Registers with modalBackHandler so a hardware/gesture back press (or a browser back) closes
// just the photo and lands back on the page underneath, instead of falling through to that
// page's own back navigation and leaving twice in one press — baked in here once so every screen
// above gets it for free rather than each needing its own pushModalBackHandler/popModalBackHandler.
export default function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    pushModalBackHandler(onClose);
    return () => popModalBackHandler(onClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
        aria-label="Close"
      >
        <span className="material-symbols-outlined">close</span>
      </button>
      <img src={src} alt="" className="max-w-full max-h-full rounded-xl" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
