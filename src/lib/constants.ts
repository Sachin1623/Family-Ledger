export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  CAD: 'C$',
  AUD: 'A$',
  AED: 'AED',
  SAR: '﷼',
  JPY: '¥',
  CNY: '¥'
};

export const getCurrencySymbol = (currencyCode?: string) => {
  return CURRENCY_SYMBOLS[currencyCode || ''] || currencyCode || '$';
};

// Large amounts (crore-plus budgets, big one-off totals, etc.) render as long strings in
// fixed-width stat cards (e.g. ManageGroup's Budget/Spent/Remaining grid) and visually overflow
// into neighboring cells since there's no whitespace for the text to wrap on. Above the threshold,
// abbreviate via Intl's `compact` notation instead — Indian-grouped currencies get L/Cr units,
// everything else gets K/M/B — so the value always fits without needing to shrink the font or
// truncate a real number down to something misleading.
const COMPACT_AMOUNT_THRESHOLD = 100000; // 1 lakh
export const formatAmountCompact = (amount: number, currencyCode?: string) => {
  if (Math.abs(amount) < COMPACT_AMOUNT_THRESHOLD) return amount.toLocaleString();
  const locale = currencyCode === 'INR' ? 'en-IN' : 'en-US';
  return amount.toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 2 });
};

// `icon` values are native emoji (not Material Symbols ligature names) — every render site that
// displays one must NOT wrap it in a `material-symbols-outlined` class, since that font expects a
// ligature name like "home", not a raw Unicode character; emoji render through the system's own
// color emoji font regardless of surrounding classes.
export const EXPENSE_CATEGORIES = [
  { id: 'housing', name: 'Housing', icon: '🏠' },
  { id: 'food', name: 'Food: Eating Out or Delivery', icon: '🍔' },
  { id: 'groceries', name: 'Groceries', icon: '🛒' },
  { id: 'travel', name: 'Transportation', icon: '🚗' },
  { id: 'bills', name: 'Bills & Utilities', icon: '🧾' },
  { id: 'personal', name: 'Personal & Family Care', icon: '🧑' },
  { id: 'health', name: 'Health', icon: '💊' },
  { id: 'education', name: 'Education', icon: '🎓' },
  { id: 'kids', name: 'Kids', icon: '🧒' },
  { id: 'ent', name: 'Entertainment & Leisure', icon: '🎬' },
  { id: 'finance', name: 'Finance & Investments', icon: '💳' },
  { id: 'shopping', name: 'Apparel', icon: '👕' },
  { id: 'household', name: 'Household', icon: '🧹' },
  { id: 'gifts', name: 'Gifts', icon: '🎁' },
  { id: 'misc', name: 'Miscellaneous', icon: '✨' }
];

export const INCOME_CATEGORIES = [
  { id: 'salary', name: 'Salary', icon: '💼' },
  { id: 'house_rent', name: 'House Rent', icon: '🏠' },
  { id: 'sale', name: 'Sale', icon: '🏷️' },
  { id: 'reimbursement', name: 'Reimbursement', icon: '🔄' },
  { id: 'gift', name: 'Gift', icon: '🎁' },
  { id: 'interest', name: 'Interest & Investments', icon: '📈' },
  { id: 'refund', name: 'Refund', icon: '↩️' },
  { id: 'other_income', name: 'Other Income', icon: '💵' },
];

export const PAYMENT_METHODS = [
  { id: 'upi', name: 'UPI', icon: '📱' },
  { id: 'card', name: 'Card', icon: '💳' },
  { id: 'cash', name: 'Cash', icon: '💵' },
  { id: 'bank', name: 'Bank', icon: '🏦' }
];
