import React, { useState } from 'react';
import { clsx } from 'clsx';
import { useLanguage } from '../context/LanguageContext';

// Basic calculator (+, -, ×, ÷, %) with standard operator precedence (× and ÷ resolved before
// + and -). Deliberately no parentheses/scientific functions — this is a quick everyday-math
// tool, not a scientific calculator. Leading negative numbers aren't supported (e.g. "-5+3"),
// matching the same "no leading sign" simplification used by AmountKeypad on Add Expense.
function evaluate(expr: string): number | null {
  const normalized = expr.replace(/×/g, '*').replace(/÷/g, '/');
  if (!normalized || /[*/+-]$/.test(normalized)) return null;
  const tokens = normalized.match(/\d+\.?\d*|[+\-*/]/g);
  if (!tokens || tokens.length === 0) return null;

  const pass1: (number | string)[] = [parseFloat(tokens[0])];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const num = parseFloat(tokens[i + 1]);
    if (op === '*' || op === '/') {
      const prev = pass1.pop() as number;
      pass1.push(op === '*' ? prev * num : prev / num);
    } else {
      pass1.push(op, num);
    }
  }

  let result = pass1[0] as number;
  for (let j = 1; j < pass1.length; j += 2) {
    const op = pass1[j];
    const num = pass1[j + 1] as number;
    result = op === '+' ? result + num : result - num;
  }
  return isNaN(result) || !isFinite(result) ? null : result;
}

const formatResult = (n: number) => {
  const rounded = Math.round(n * 1e8) / 1e8;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 8 });
};

const KEY_ROWS = [
  ['C', '⌫', '%', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '-'],
  ['1', '2', '3', '+'],
  ['0', '.', '='],
];

export default function Calculator() {
  const { t } = useLanguage();
  const [expression, setExpression] = useState('');
  const [justEvaluated, setJustEvaluated] = useState(false);

  const press = (key: string) => {
    if (key === 'C') {
      setExpression('');
      setJustEvaluated(false);
      return;
    }
    if (key === '⌫') {
      setExpression((e) => e.slice(0, -1));
      setJustEvaluated(false);
      return;
    }
    if (key === '=') {
      const result = evaluate(expression);
      if (result !== null) {
        setExpression(formatResult(result).replace(/,/g, ''));
        setJustEvaluated(true);
      }
      return;
    }
    if (key === '%') {
      const match = expression.match(/(\d+\.?\d*)$/);
      if (!match) return;
      const num = parseFloat(match[0]);
      setExpression(expression.slice(0, match.index) + String(num / 100));
      setJustEvaluated(false);
      return;
    }
    if (['+', '-', '×', '÷'].includes(key)) {
      if (!expression) return; // no leading operator
      setExpression((e) => (/[+\-×÷]$/.test(e) ? e.slice(0, -1) + key : e + key));
      setJustEvaluated(false);
      return;
    }
    if (key === '.') {
      const base = justEvaluated ? '' : expression;
      const lastSegment = base.split(/[+\-×÷]/).pop() || '';
      if (lastSegment.includes('.')) return;
      setExpression(base + (lastSegment ? '.' : '0.'));
      setJustEvaluated(false);
      return;
    }
    // digit
    setExpression((justEvaluated ? '' : expression) + key);
    setJustEvaluated(false);
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('tools.calculator')}</h1>
          <p className="text-sm text-text-muted mt-1">{t('calc.subtitle')}</p>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle p-6 shadow-sm" data-tour="calc-display">
          <div className="min-h-16 flex items-end justify-end">
            <span className="text-4xl font-black text-primary break-all text-right">
              {expression || '0'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2" data-tour="calc-keypad">
          {KEY_ROWS.flat().map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              className={clsx(
                'h-14 rounded-2xl font-bold text-xl flex items-center justify-center active:scale-95 transition-all',
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
      </main>
    </div>
  );
}
