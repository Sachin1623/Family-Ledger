// Shared calculator engine, extracted from the old full-page Calculator.tsx so the floating
// widget (FloatingCalculator.tsx) and any future consumer share one implementation. Basic
// calculator (+, -, ×, ÷, %) with standard operator precedence (× and ÷ resolved before + and -).
// Deliberately no parentheses/scientific functions — this is a quick everyday-math tool, not a
// scientific calculator. Leading negative numbers aren't supported (e.g. "-5+3"), matching the
// same "no leading sign" simplification used by AmountKeypad on Add Expense.
export function evaluateExpression(expr: string): number | null {
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

export const formatCalcResult = (n: number) => {
  const rounded = Math.round(n * 1e8) / 1e8;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 8 });
};

export const CALC_KEY_ROWS = [
  ['C', '⌫', '%', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '-'],
  ['1', '2', '3', '+'],
  ['0', '.', '='],
];

// Pure reducer over one key press — same logic Calculator.tsx used to own inline, now shared.
export function pressCalcKey(expression: string, justEvaluated: boolean, key: string): { expression: string; justEvaluated: boolean } {
  if (key === 'C') return { expression: '', justEvaluated: false };
  if (key === '⌫') return { expression: expression.slice(0, -1), justEvaluated: false };
  if (key === '=') {
    const result = evaluateExpression(expression);
    if (result !== null) return { expression: formatCalcResult(result).replace(/,/g, ''), justEvaluated: true };
    return { expression, justEvaluated };
  }
  if (key === '%') {
    const match = expression.match(/(\d+\.?\d*)$/);
    if (!match) return { expression, justEvaluated };
    const num = parseFloat(match[0]);
    return { expression: expression.slice(0, match.index) + String(num / 100), justEvaluated: false };
  }
  if (['+', '-', '×', '÷'].includes(key)) {
    if (!expression) return { expression, justEvaluated }; // no leading operator
    return { expression: /[+\-×÷]$/.test(expression) ? expression.slice(0, -1) + key : expression + key, justEvaluated: false };
  }
  if (key === '.') {
    const base = justEvaluated ? '' : expression;
    const lastSegment = base.split(/[+\-×÷]/).pop() || '';
    if (lastSegment.includes('.')) return { expression, justEvaluated };
    return { expression: base + (lastSegment ? '.' : '0.'), justEvaluated: false };
  }
  // digit
  return { expression: (justEvaluated ? '' : expression) + key, justEvaluated: false };
}
