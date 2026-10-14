import React from 'react';
import { clsx } from 'clsx';

// What Add Expense needs to know about the receipt it was opened from (see ReceiptShare.tsx).
export interface ReceiptInfo {
  appLabel: string; // "PhonePe" | "Paytm" | "Google Pay" | ""
  notes: string[]; // things the user should double-check
  alternatives: string[]; // when the amount could be read two ways (e.g. 90 or 790)
  remembered: boolean; // description + category came from this user's earlier choice for the same payee
  duplicateAt: string | null; // ISO time the same receipt (transaction id) was added before
  hasPicture: boolean;
}

// A compact strip at the top of Add Expense when it was opened from a shared payment receipt: where the details
// came from, anything unclear, and one-tap choices when the amount is ambiguous. Nothing here blocks saving.
export default function ReceiptBanner({ info, amount, onPickAmount }: { info: ReceiptInfo; amount: string; onPickAmount: (a: string) => void }) {
  const notes = info.notes.filter((n) => !/tap the right one/i.test(n)); // the chips below say the same thing
  return (
    <div className="mb-4 rounded-2xl border border-primary/15 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[20px] text-primary">receipt_long</span>
        <p className="text-xs font-black text-primary flex-1">
          Filled in from your {info.appLabel ? `${info.appLabel} ` : ''}receipt{info.hasPicture ? ' · picture attached below' : ''}
        </p>
        {info.remembered && <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-[10px] font-black">✓ Remembered</span>}
      </div>

      {info.duplicateAt && (
        <p className="text-xs font-bold text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          ⚠️ You already added this receipt on {new Date(info.duplicateAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. Save again only if it's a different expense.
        </p>
      )}

      {info.alternatives.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-text-muted">The amount could be:</span>
          {info.alternatives.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => onPickAmount(a)}
              className={clsx('px-3 py-1 rounded-full text-xs font-black border', amount === a ? 'bg-primary text-white border-primary' : 'bg-white text-primary border-border-subtle')}
            >
              ₹{a}
            </button>
          ))}
        </div>
      )}

      {notes.map((n) => (
        <p key={n} className="text-[11px] font-bold text-amber-900">⚠️ {n}</p>
      ))}
    </div>
  );
}
