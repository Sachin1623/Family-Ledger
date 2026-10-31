// Payments groups have their own categories (Rent, Maintenance, Salary, EMI...). The general expense categories (Groceries, Dine
// out and so on) are never used there. A group starts with the defaults below and an admin can rename, hide or add to them on the
// Payment categories screen; once edited, the group's own list (group.paymentCategories) is the one that counts.

export type PaymentCategory = {
  id: string;
  name: string;
  icon: string;      // a Material symbol name for the built-in ones, an emoji for ones people add
  hidden?: boolean;
  custom?: boolean;
};

export const DEFAULT_PAYMENT_CATEGORIES: PaymentCategory[] = [
  { id: 'rent', name: 'Rent', icon: 'home' },
  { id: 'maintenance', name: 'Maintenance', icon: 'build' },
  { id: 'salary', name: 'Salary', icon: 'badge' },
  { id: 'emi', name: 'EMI', icon: 'account_balance' },
  { id: 'fees', name: 'Fees', icon: 'school' },
  { id: 'other', name: 'Other', icon: 'payments' },
];

export const allPaymentCategories = (group: any): PaymentCategory[] =>
  Array.isArray(group?.paymentCategories) && group.paymentCategories.length > 0 ? group.paymentCategories : DEFAULT_PAYMENT_CATEGORIES;

export const visiblePaymentCategories = (group: any): PaymentCategory[] => allPaymentCategories(group).filter((c) => !c.hidden);

// the icon for a payment's label, matched by name against the group's categories
export const paymentCategoryIcon = (group: any, label?: string): string =>
  allPaymentCategories(group).find((c) => c.name.toLowerCase() === (label || '').toLowerCase())?.icon || 'payments';

export const isMaterialIcon = (icon: string) => /^[a-z_]+$/.test(icon);

export const makePaymentCategoryId = () => `pc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
