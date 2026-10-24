import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { clsx } from 'clsx';
import { formatAmountCompact } from '../lib/constants';
import { useAuth } from '../context/AuthContext';

// "Pay back" sheet, opened from a Settle button on the Settlements page: choose how much to pay now (the full amount, half, or any amount) and see at once
// what will still be owed. Continuing opens Add Expense with the person and the chosen amount filled in. Nothing is recorded until it is saved there.
export interface SettleTarget {
  owerId: string;
  owerName: string;
  owerPhoto: string;
  receiverId: string;
  receiverName: string;
  receiverPhoto: string;
  amount: number;
  groupId: string;
  groupName: string;
}

export default function SettleSheet({ settlement, currencySymbol, onClose }: { settlement: SettleTarget; currencySymbol: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const owed = Math.round(settlement.amount * 100) / 100;
  const [mode, setMode] = useState<'full' | 'half' | 'custom'>('full');
  const [custom, setCustom] = useState('');
  const amount = useMemo(() => {
    if (mode === 'full') return owed;
    if (mode === 'half') return Math.round((owed / 2) * 100) / 100;
    const n = parseFloat(custom);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }, [mode, custom, owed]);
  const valid = amount > 0 && amount <= owed + 0.001;
  const remaining = Math.max(0, Math.round((owed - amount) * 100) / 100);
  const fmt = (n: number) => `${currencySymbol}${formatAmountCompact(n, undefined, profile?.numberSystem)}`;
  const firstName = settlement.receiverName.split(' ')[0];

  const next = () => {
    if (!valid) return;
    const params = new URLSearchParams({
      groupId: settlement.groupId,
      amount: amount.toFixed(2),
      settleWith: settlement.receiverId,
      description: `Settlement to ${firstName}`,
      category: 'misc',
    });
    navigate(`/add-expense?${params.toString()}`);
  };

  const Avatar = ({ photo, name }: { photo: string; name: string }) => (
    <div className="w-12 h-12 rounded-full overflow-hidden bg-primary/10 border-2 border-white shadow flex items-center justify-center text-sm font-black text-primary">
      {photo ? <img src={photo} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : name.slice(0, 1).toUpperCase()}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <motion.div initial={{ y: 80 }} animate={{ y: 0 }} transition={{ type: 'spring', damping: 26, stiffness: 260 }} className="relative w-full max-w-md bg-white rounded-t-3xl px-5 pt-3 pb-6 shadow-2xl">
        <div className="w-11 h-1.5 rounded-full bg-slate-300 mx-auto mb-4" />
        <div className="flex items-center justify-center gap-3">
          <Avatar photo={settlement.owerPhoto} name="You" />
          <span className="material-symbols-outlined text-text-muted">arrow_forward</span>
          <Avatar photo={settlement.receiverPhoto} name={settlement.receiverName} />
        </div>
        <p className="text-center text-base font-black text-primary mt-3">Pay {firstName}</p>
        <p className="text-center text-xs text-text-muted">You owe {fmt(owed)} · {settlement.groupName}</p>

        <div className="mt-3 flex items-center justify-center gap-1">
          <span className="text-3xl font-black text-primary">{currencySymbol}</span>
          {mode === 'custom' ? (
            <input
              autoFocus
              inputMode="decimal"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              className="w-40 text-5xl font-black text-primary text-center bg-transparent outline-none border-b-2 border-primary/30"
            />
          ) : (
            <span className="text-5xl font-black text-primary">{formatAmountCompact(amount, undefined, profile?.numberSystem)}</span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4">
          {([
            ['full', `Full ${fmt(owed)}`],
            ['half', `Half ${fmt(Math.round((owed / 2) * 100) / 100)}`],
            ['custom', 'Custom'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={clsx('py-3 rounded-2xl border-2 text-[13px] font-black active:scale-95 transition-all', mode === id ? 'border-primary bg-primary/5 text-primary' : 'border-border-subtle text-on-surface')}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={clsx('mt-3 rounded-xl px-3 py-2.5 text-center text-xs font-black border', !valid && mode === 'custom' && custom ? 'bg-red-50 border-red-200 text-red-700' : remaining > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-green-50 border-green-200 text-green-700')}>
          {!valid && mode === 'custom' && custom
            ? `Enter an amount up to ${fmt(owed)}`
            : remaining > 0
              ? `${fmt(remaining)} will still be owed to ${firstName}`
              : `This settles everything with ${firstName}`}
        </div>

        <button
          type="button"
          disabled={!valid}
          onClick={next}
          className="w-full mt-4 py-3.5 rounded-2xl bg-primary text-white font-black text-[15px] disabled:opacity-50 active:scale-[0.98] transition-all"
        >
          Continue{valid ? ` · ${fmt(amount)}` : ''}
        </button>
        <p className="text-center text-[11px] text-text-muted mt-2">You will check the details before it is saved.</p>
      </motion.div>
    </div>,
    document.body,
  );
}
