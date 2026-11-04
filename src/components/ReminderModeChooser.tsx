import React from 'react';
import { clsx } from 'clsx';
import type { PayerMode } from '../lib/paymentReminders';

const OPTIONS: { id: PayerMode; icon: string; name: string; hint: string }[] = [
  { id: 'notification', icon: 'notifications', name: 'Notification', hint: 'A normal alert' },
  { id: 'alarm', icon: 'alarm', name: 'Alarm', hint: 'Rings until you act' },
  { id: 'off', icon: 'notifications_off', name: 'Off for me', hint: 'No reminders for me' },
];

// How a reminder reaches someone: the same choice, looking the same, wherever it is offered. `cards` is the roomy version used when
// setting a reminder up; `compact` is the three-way switch on the Dashboard card. `off` is only for a person choosing for themselves.
export default function ReminderModeChooser({ value, onChange, allowOff = false, variant = 'compact', disabled }: {
  value: PayerMode;
  onChange: (mode: PayerMode) => void;
  allowOff?: boolean;
  variant?: 'cards' | 'compact';
  disabled?: boolean;
}) {
  const options = OPTIONS.filter((o) => allowOff || o.id !== 'off');
  if (variant === 'cards') {
    return (
      <div className={clsx('grid gap-2', allowOff ? 'grid-cols-3' : 'grid-cols-2')}>
        {options.map((o) => (
          <button key={o.id} type="button" disabled={disabled} onClick={() => onChange(o.id)}
            className={clsx('rounded-2xl border-[1.5px] p-3 text-left', value === o.id ? 'border-primary bg-primary/5' : 'border-border-subtle')}>
            <span className="material-symbols-outlined text-[22px] text-primary">{o.icon}</span>
            <span className="block text-sm font-extrabold text-primary">{o.name}</span>
            <span className="block text-xs text-text-muted">{o.hint}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div role="radiogroup" className={clsx('grid gap-1.5', allowOff ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} onClick={() => onChange(o.id)}
          className={clsx('flex items-center justify-center gap-1 rounded-xl border-[1.5px] py-2.5 text-xs font-black', value === o.id ? 'border-primary bg-primary/5 text-primary' : 'border-border-subtle text-text-muted')}>
          <span className="material-symbols-outlined text-[16px]">{o.icon}</span>{o.name}
        </button>
      ))}
    </div>
  );
}
