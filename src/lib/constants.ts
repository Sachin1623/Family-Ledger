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

export type NumberSystem = 'south_asian' | 'international';
export const NUMBER_SYSTEMS: { id: NumberSystem; label: string; example: string }[] = [
  { id: 'south_asian', label: 'South Asian (K, L, Cr)', example: '₹12.5L' },
  { id: 'international', label: 'International (K, M, B)', example: '$1.25M' },
];

// Large amounts (crore-plus budgets, big one-off totals, etc.) render as long strings in
// fixed-width stat cards (e.g. ManageGroup's Budget/Spent/Remaining grid) and visually overflow
// into neighboring cells since there's no whitespace for the text to wrap on. Above the threshold,
// abbreviate via Intl's `compact` notation instead. `numberSystem` (a user preference — see
// Profile.tsx/ProfileSetupWizard.tsx) picks the grouping explicitly (South Asian gets L/Cr units,
// International gets K/M/B); when not supplied (an older call site, or the preference was never
// set), falls back to the old currency-based guess so nothing regresses. Either way, the value
// always fits without needing to shrink the font or truncate a real number down to something
// misleading.
const COMPACT_AMOUNT_THRESHOLD = 100000; // 1 lakh
export const formatAmountCompact = (amount: number, currencyCode?: string, numberSystem?: NumberSystem) => {
  if (Math.abs(amount) < COMPACT_AMOUNT_THRESHOLD) return amount.toLocaleString();
  const locale = numberSystem
    ? (numberSystem === 'south_asian' ? 'en-IN' : 'en-US')
    : (currencyCode === 'INR' ? 'en-IN' : 'en-US');
  return amount.toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 2 });
};

// A curated (not exhaustive-ISO) list, covering the countries a real user base is likely to pick
// from — same "good enough for a profile field, not a formal registry" bar as getApproxCountry()
// in lib/geo.ts.
export const COUNTRIES: string[] = [
  'India', 'United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand',
  'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman',
  'Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Philippines', 'Vietnam',
  'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Bhutan', 'Maldives',
  'China', 'Japan', 'South Korea', 'Hong Kong', 'Taiwan',
  'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Belgium', 'Switzerland',
  'Austria', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Ireland', 'Portugal',
  'Poland', 'Czech Republic', 'Greece', 'Romania', 'Hungary', 'Ukraine', 'Russia',
  'South Africa', 'Nigeria', 'Kenya', 'Egypt', 'Morocco', 'Ghana',
  'Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru',
  'Israel', 'Turkey', 'Jordan', 'Lebanon',
  'Other',
];

// `icon` values are native emoji (not Material Symbols ligature names) — every render site that
// displays one must NOT wrap it in a `material-symbols-outlined` class, since that font expects a
// ligature name like "home", not a raw Unicode character; emoji render through the system's own
// color emoji font regardless of surrounding classes.
export const EXPENSE_CATEGORIES = [
  { id: 'housing', name: 'Housing', icon: '🏠' },
  { id: 'food', name: 'Dine out/Order', icon: '🍔' },
  { id: 'groceries', name: 'Groceries', icon: '🛒' },
  { id: 'travel', name: 'Transportation', icon: '🚗' },
  { id: 'bills', name: 'Bill/Utilities', icon: '🧾' },
  { id: 'personal', name: 'Personal', icon: '🧑' },
  { id: 'health', name: 'Health', icon: '💊' },
  { id: 'education', name: 'Education', icon: '🎓' },
  { id: 'kids', name: 'Kids', icon: '🧒' },
  { id: 'ent', name: 'Fun', icon: '🎬' },
  { id: 'finance', name: 'Finance', icon: '💳' },
  { id: 'shopping', name: 'Apparel', icon: '👕' },
  { id: 'household', name: 'Household', icon: '🧹' },
  { id: 'gifts', name: 'Gifts', icon: '🎁' },
  { id: 'misc', name: 'Other', icon: '✨' }
];

export type CategoryClassification = 'essential' | 'optional';

// Sensible starting point so the Essential/Optional filter and donut chart are useful the moment
// a group exists, before any admin has actually visited the new "Spend Categories" setting in
// ManageGroup.tsx — every group can override any of these for itself (see
// groups/{groupId}.categoryClassification), this is only the fallback for a category a group has
// never explicitly classified.
export const DEFAULT_CATEGORY_CLASSIFICATION: Record<string, CategoryClassification> = {
  housing: 'essential',
  food: 'optional',
  groceries: 'essential',
  travel: 'essential',
  bills: 'essential',
  personal: 'essential',
  health: 'essential',
  education: 'essential',
  kids: 'essential',
  ent: 'optional',
  finance: 'essential',
  shopping: 'optional',
  household: 'essential',
  gifts: 'optional',
  misc: 'optional',
};

// A group's own overrides (set by its owner/admin) take priority over the app-wide default above;
// an entirely unrecognized category id (shouldn't normally happen) falls back to 'optional' rather
// than throwing, so a stale/removed category id never breaks the filter or chart.
export function getCategoryClassification(
  group: { categoryClassification?: Record<string, CategoryClassification> } | undefined,
  categoryId: string | undefined,
): CategoryClassification {
  if (!categoryId) return 'optional';
  return group?.categoryClassification?.[categoryId] || DEFAULT_CATEGORY_CLASSIFICATION[categoryId] || 'optional';
}

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

export type CategoryType = 'expense' | 'income';

export interface CustomCategory {
  id: string;
  name: string;
  icon: string;
  type: CategoryType;
}

export interface CategoryLike {
  id: string;
  name: string;
  icon: string;
}

export interface GroupCategorySettings {
  customCategories?: CustomCategory[];
  hiddenCategories?: string[];
  categoryNameOverrides?: Record<string, string>;
}

let customCategoryCounter = 0;
export function makeCustomCategoryId(): string {
  customCategoryCounter += 1;
  return `custom_${Date.now().toString(36)}${customCategoryCounter}${Math.random().toString(36).slice(2, 6)}`;
}

// A group's EFFECTIVE category list for pickers (Add Expense, filters, breakdowns): every built-in
// AND custom category the group hasn't hidden. hiddenCategories applies uniformly to both kinds —
// there is deliberately no delete for a category still in use (see the Manage Categories panel in
// ManageGroup.tsx): hiding is the only way to retire one, so an id already stamped on existing
// expenses never goes stale. Order matters for the picker grid — built-ins first (familiar, stable
// positions), customs appended after.
export function getGroupCategories(group: GroupCategorySettings | undefined, type: CategoryType): CategoryLike[] {
  const base = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const hidden = new Set(group?.hiddenCategories || []);
  const visibleBase = base.filter((c) => !hidden.has(c.id));
  const custom = (group?.customCategories || []).filter((c) => c.type === type && !hidden.has(c.id));
  return [...visibleBase, ...custom];
}

// The FULL category list for management UI (ManageGroup's Spend/Income Categories panel) — every
// built-in and custom category regardless of hidden state, so an admin can toggle a hidden one back
// on. Pickers/breakdowns should use getGroupCategories above instead, which already excludes hidden.
export function getAllGroupCategories(group: GroupCategorySettings | undefined, type: CategoryType): CategoryLike[] {
  const base = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const custom = (group?.customCategories || []).filter((c) => c.type === type);
  return [...base, ...custom];
}

// A group can rename ANY category (built-in or custom) for itself via categoryNameOverrides —
// custom categories could instead just have their `name` field edited in place, but routing every
// rename through the same override map keeps "does this group call category X something else"
// a single lookup regardless of which kind of category it is. Returns null when there's no
// override, so callers fall back to the built-in's own i18n-translated name.
export function getCategoryNameOverride(group: GroupCategorySettings | undefined, categoryId: string | undefined): string | null {
  if (!categoryId) return null;
  const override = group?.categoryNameOverrides?.[categoryId];
  if (override) return override;
  const custom = group?.customCategories?.find((c) => c.id === categoryId);
  return custom ? custom.name : null;
}

// Icon for a category id that might be custom — built-in icons come from EXPENSE_CATEGORIES/
// INCOME_CATEGORIES as always; a stale/unknown id (e.g. a custom category since deleted) falls back
// to a neutral placeholder rather than rendering nothing.
export function getCategoryIcon(group: GroupCategorySettings | undefined, categoryId: string | undefined, type: CategoryType): string {
  if (!categoryId) return '❓';
  const custom = group?.customCategories?.find((c) => c.id === categoryId);
  if (custom) return custom.icon;
  const base = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return base.find((c) => c.id === categoryId)?.icon || '❓';
}

export const PAYMENT_METHODS = [
  { id: 'upi', name: 'UPI', icon: '📱' },
  { id: 'card', name: 'Card', icon: '💳' },
  { id: 'cash', name: 'Cash', icon: '💵' },
  { id: 'bank', name: 'Bank', icon: '🏦' }
];
