import React, { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useLanguage } from '../context/LanguageContext';
import { setOpenCalculatorFn } from '../lib/calculatorRef';
import { CALC_KEY_ROWS, pressCalcKey } from '../lib/calculatorLogic';

// A persistent floating calculator — mounted once at the app-shell level in App.tsx (same level
// as Header, above <Routes>), so it never unmounts on navigation: opening it, doing math, and
// switching screens (or collapsing it to a bubble) never resets its expression or loses it behind
// a route change, unlike the old full-page /calculator screen. Anchored bottom-LEFT specifically
// to avoid Navigation.tsx's Add Expense FAB, which already owns the bottom-right corner at the
// same vertical offset.
const ANCHOR_STYLE: React.CSSProperties = { bottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' };

export default function FloatingCalculator() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expression, setExpression] = useState('');
  const [justEvaluated, setJustEvaluated] = useState(false);

  useEffect(() => {
    setOpenCalculatorFn(() => {
      setOpen(true);
      setCollapsed(false);
    });
    return () => setOpenCalculatorFn(null);
  }, []);

  if (!open) return null;

  const press = (key: string) => {
    const next = pressCalcKey(expression, justEvaluated, key);
    setExpression(next.expression);
    setJustEvaluated(next.justEvaluated);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        style={ANCHOR_STYLE}
        className="fixed left-4 z-[70] w-12 h-12 rounded-full bg-primary text-white shadow-lg flex items-center justify-center active:scale-95 transition-all"
        title={t('tools.calculator')}
      >
        <span className="material-symbols-outlined text-[22px]">calculate</span>
      </button>
    );
  }

  return (
    <div style={ANCHOR_STYLE} className="fixed left-4 z-[70] w-64 bg-white rounded-2xl border border-border-subtle shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-primary/5 border-b border-border-subtle">
        <span className="text-xs font-bold text-primary flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[16px]">calculate</span>
          {t('tools.calculator')}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="w-6 h-6 flex items-center justify-center text-text-muted hover:text-primary rounded-full hover:bg-white transition-colors"
            title={t('common.minimize')}
          >
            <span className="material-symbols-outlined text-[16px]">remove</span>
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-6 h-6 flex items-center justify-center text-text-muted hover:text-error rounded-full hover:bg-white transition-colors"
            title={t('common.close')}
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      </div>

      <div className="p-2.5 space-y-2">
        <div className="bg-surface rounded-xl px-3 py-2.5 min-h-11 flex items-end justify-end">
          <span className="text-xl font-black text-primary break-all text-right">{expression || '0'}</span>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {CALC_KEY_ROWS.flat().map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              className={clsx(
                'h-9 rounded-lg font-bold text-sm flex items-center justify-center active:scale-95 transition-all',
                key === '0' && 'col-span-2',
                key === '=' && 'bg-primary text-white',
                key === 'C' && 'bg-error/10 text-error',
                key === '⌫' && 'bg-surface-container text-text-muted border border-border-subtle',
                ['+', '-', '×', '÷', '%'].includes(key) && 'bg-primary/10 text-primary',
                /^[0-9.]$/.test(key) && 'bg-white border border-border-subtle text-on-surface',
              )}
            >
              {key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
