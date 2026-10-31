import React from 'react';
import { clsx } from 'clsx';

export type GroupKind = 'regular' | 'event' | 'payments';

// What each kind of group is, in words a person recognises: shown as tall cards so the choice is understood before it is made.
const KINDS: Record<GroupKind, { icon: string; title: string; what: string; how: string; examples: string[] }> = {
  regular: {
    icon: 'home',
    title: 'Regular / Monthly',
    what: 'Everyday shared spending, such as home, family or flatmates.',
    how: 'Budgets and totals start fresh every month. Costs can be split.',
    examples: ['Household', 'Flatmates', 'Family'],
  },
  event: {
    icon: 'flight_takeoff',
    title: 'One-off Event',
    what: 'A single trip or occasion with a start and an end.',
    how: 'Costs are shared, then settled up when it is over.',
    examples: ['Goa trip', 'Wedding', 'Birthday'],
  },
  payments: {
    icon: 'currency_rupee',
    title: 'Payments',
    what: 'Money one person pays another, such as rent, maintenance, salary or EMI.',
    how: 'Keeps a record with receipts. Nothing is split and nobody owes anybody.',
    examples: ['Rent', 'Maid salary', 'Tuition fees'],
  },
};

export default function GroupTypePicker({
  value,
  onPick,
  kinds = ['regular', 'event', 'payments'],
}: {
  value: GroupKind;
  onPick: (kind: GroupKind) => void;
  kinds?: GroupKind[];
}) {
  return (
    <div role="radiogroup" aria-label="Group type" className="space-y-2.5">
      {kinds.map((k) => {
        const info = KINDS[k];
        const selected = value === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onPick(k)}
            className={clsx(
              'w-full text-left rounded-2xl border-2 p-3.5 transition-all active:scale-[0.99] flex items-start gap-3',
              selected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border-subtle bg-white hover:border-primary/40',
            )}
          >
            <span className={clsx('w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors', selected ? 'bg-primary text-white' : 'bg-surface text-primary')}>
              <span className="material-symbols-outlined text-[24px]">{info.icon}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-black text-primary">{info.title}</span>
              <span className="block text-[12.5px] text-on-surface leading-snug mt-0.5">{info.what}</span>
              <span className="block text-[11.5px] text-text-muted leading-snug mt-1">{info.how}</span>
              <span className="flex flex-wrap gap-1.5 mt-2">
                {info.examples.map((e) => (
                  <span key={e} className="text-[10.5px] font-bold rounded-full bg-surface text-text-muted px-2 py-0.5">{e}</span>
                ))}
              </span>
            </span>
            <span
              aria-hidden
              className={clsx('w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors', selected ? 'bg-primary border-primary text-white' : 'border-border-subtle')}
            >
              {selected && <span className="material-symbols-outlined text-[16px] font-black">check</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
