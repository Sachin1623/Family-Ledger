import React from 'react';
import { clsx } from 'clsx';

// Custom on-screen keypad for expense-amount entry — digits, a decimal point, and +/- only
// (matches evaluateAmountSum's "20+30-5" sum support in AddExpense.tsx, deliberately no
// */÷). Used instead of the native keyboard so the field never shows a full QWERTY layout.
interface AmountKeypadProps {
  value: string;
  onChange: (next: string) => void;
  onDone: () => void;
}

const ROWS = [
  ['7', '8', '9', '⌫'],
  ['4', '5', '6', '-'],
  ['1', '2', '3', '+'],
  ['C', '0', '.', 'Done'],
];

export default function AmountKeypad({ value, onChange, onDone }: AmountKeypadProps) {
  const press = (key: string) => {
    if (key === 'Done') {
      onDone();
      return;
    }
    if (key === 'C') {
      onChange('');
      return;
    }
    if (key === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '+' || key === '-') {
      if (!value) return; // no leading sign — +/- only chains sums between numbers
      if (/[+-]$/.test(value)) {
        onChange(value.slice(0, -1) + key); // swap trailing operator instead of stacking
        return;
      }
      onChange(value + key);
      return;
    }
    if (key === '.') {
      const lastSegment = value.split(/[+-]/).pop() || '';
      if (lastSegment.includes('.')) return; // one decimal point per number
      onChange(value + key);
      return;
    }
    onChange(value + key);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[90] bg-white border-t border-border-subtle shadow-[0_-4px_16px_rgba(0,0,0,0.08)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="grid grid-cols-4 gap-2 max-w-md mx-auto">
        {ROWS.flat().map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            className={clsx(
              'h-12 rounded-xl font-bold text-lg flex items-center justify-center active:scale-95 transition-all',
              key === 'Done' && 'bg-primary text-white text-sm',
              key === 'C' && 'bg-error/10 text-error text-sm',
              key === '⌫' && 'bg-surface text-text-muted',
              (key === '+' || key === '-') && 'bg-primary/10 text-primary',
              /^[0-9.]$/.test(key) && 'bg-surface text-on-surface',
            )}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
