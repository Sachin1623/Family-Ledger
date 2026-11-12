import React from 'react';
import { clsx } from 'clsx';
import { GroupKind, kindVars } from '../lib/groupKindStyle';

export type { GroupKind };

// What each kind of group is and how the app treats it, in words a person recognises. Each kind has its own colour, so the
// choice is understood before it is made and the group is recognisable afterwards.
const KINDS: Record<GroupKind, { icon: string; title: string; what: string; how: string; examples: string[] }> = {
  regular: {
    icon: 'home',
    title: 'Monthly group',
    what: 'Your month-to-month expenses.',
    how: 'See this month against last.',
    examples: ['Groceries', 'Wi-Fi', 'Electricity'],
  },
  event: {
    icon: 'flight_takeoff',
    title: 'One-time event',
    what: 'A trip, festival, party or home project.',
    how: 'Shows the total for the whole event.',
    examples: ['Goa trip', 'Diwali', 'Home renovation', 'Wedding'],
  },
  payments: {
    icon: 'currency_rupee',
    title: 'Payments',
    what: 'Money you pay to, or get from, one person.',
    how: 'Keeps receipts. It is an expense for the payer and income for the receiver.',
    examples: ['Home rent', 'Shop rent', 'Salary'],
  },
};

export default function GroupTypePicker({
  value,
  onPick,
  kinds = ['regular', 'event', 'payments'],
  look = 'cards',
}: {
  value: GroupKind;
  onPick: (kind: GroupKind) => void;
  kinds?: GroupKind[];
  // 'sheet' is the Create Group look: a compact row per type, in that type's own colour
  look?: 'cards' | 'sheet';
}) {
  if (look === 'sheet') {
    return (
      <div role="radiogroup" aria-label="Group type" className="space-y-3">
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
              style={kindVars(k)}
              className={clsx(
                'w-full text-left rounded-[20px] border-[1.5px] p-3.5 flex items-center gap-3.5 transition-all active:scale-[0.99]',
                selected ? 'border-[color:var(--acc)] bg-gradient-to-t from-[color:var(--acc-tint)] to-white shadow-md' : 'border-[#e4ebf0] bg-white',
              )}
            >
              <span className={clsx('w-[50px] h-[50px] rounded-2xl flex items-center justify-center shrink-0 transition-colors', selected ? 'bg-[color:var(--acc)] text-[color:var(--on-acc)]' : 'bg-[color:var(--acc-tint)] text-[color:var(--acc-dark)]')}>
                <span className="material-symbols-outlined text-[26px]">{info.icon}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-extrabold text-[#06222f]">{info.title}</span>
                <span className="block text-[12.5px] text-[#3f5565] leading-snug mt-0.5">{info.what}</span>
                <span className="block text-[11.5px] text-[#587080] leading-snug mt-1">{info.how}</span>
                <span className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[10.5px] font-bold text-[#587080]">e.g.</span>
                  {info.examples.map((e) => (
                    <span key={e} className="text-[10.5px] font-bold rounded-full bg-[color:var(--acc-tint)] text-[color:var(--acc-dark)] px-2 py-0.5">{e}</span>
                  ))}
                </span>
              </span>
              <span aria-hidden className={clsx('w-[22px] h-[22px] rounded-full border-2 flex items-center justify-center shrink-0', selected ? 'bg-[color:var(--acc)] border-[color:var(--acc)] text-[color:var(--on-acc)]' : 'border-[#cbd7df]')}>
                {selected && <span className="material-symbols-outlined text-[15px]">check</span>}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

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
            style={kindVars(k)}
            className={clsx(
              'w-full text-left rounded-2xl border-2 p-3.5 transition-all active:scale-[0.99] flex items-start gap-3',
              selected ? 'border-[color:var(--acc)] bg-[color:var(--acc-tint)] shadow-sm' : 'border-border-subtle bg-white hover:border-primary/40',
            )}
          >
            <span className={clsx('w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors', selected ? 'bg-[color:var(--acc)] text-[color:var(--on-acc)]' : 'bg-surface text-primary')}>
              <span className="material-symbols-outlined text-[24px]">{info.icon}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-black text-primary">{info.title}</span>
              <span className="block text-[12.5px] text-on-surface leading-snug mt-0.5">{info.what}</span>
              <span className="block text-[11.5px] text-text-muted leading-snug mt-1">{info.how}</span>
              <span className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[10.5px] font-bold text-[#587080]">e.g.</span>
                {info.examples.map((e) => (
                  <span key={e} className="text-[10.5px] font-bold rounded-full bg-surface text-text-muted px-2 py-0.5">{e}</span>
                ))}
              </span>
            </span>
            <span
              aria-hidden
              className={clsx('w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors', selected ? 'bg-[color:var(--acc)] border-[color:var(--acc)] text-[color:var(--on-acc)]' : 'border-border-subtle')}
            >
              {selected && <span className="material-symbols-outlined text-[16px] font-black">check</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
