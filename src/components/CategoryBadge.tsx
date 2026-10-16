import React from 'react';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../lib/constants';

// The one category icon used across the app: a crisp line icon in the category's own colour on a soft circle. The same
// look on every phone (the old plain emoji changed with each phone's emoji font) and one colour per category that lists
// and charts can reuse. A category a group has given its OWN emoji (or a custom category) keeps that emoji, shown on a
// neutral circle, so nothing anyone customised is lost.
export const CATEGORY_STYLE: Record<string, { symbol: string; color: string; bg: string }> = {
  // expenses
  housing: { symbol: 'home', color: '#5457e6', bg: '#e4e5fd' },
  food: { symbol: 'restaurant', color: '#ea6a0c', bg: '#ffe9d6' },
  groceries: { symbol: 'shopping_basket', color: '#1ea44f', bg: '#dcf5e5' },
  travel: { symbol: 'directions_car', color: '#0a86c0', bg: '#d9effb' },
  bills: { symbol: 'receipt_long', color: '#c29a07', bg: '#fbf2cc' },
  personal: { symbol: 'spa', color: '#d32f84', bg: '#fbe0ee' },
  health: { symbol: 'medical_services', color: '#dc3a3a', bg: '#fddede' },
  education: { symbol: 'school', color: '#7b4bdb', bg: '#ebe3fb' },
  kids: { symbol: 'child_care', color: '#0f9a8d', bg: '#d7f3ef' },
  ent: { symbol: 'theaters', color: '#e0334f', bg: '#ffdfe5' },
  finance: { symbol: 'account_balance', color: '#0b7f86', bg: '#d6efee' },
  shopping: { symbol: 'checkroom', color: '#2f6fe0', bg: '#dde8fd' },
  household: { symbol: 'cleaning_services', color: '#9a6a1c', bg: '#f1e6d3' },
  gifts: { symbol: 'redeem', color: '#c332d1', bg: '#f8dffb' },
  misc: { symbol: 'more_horiz', color: '#58677a', bg: '#e3e8ee' },
  // income
  salary: { symbol: 'work', color: '#1ea44f', bg: '#dcf5e5' },
  house_rent: { symbol: 'home_work', color: '#5457e6', bg: '#e4e5fd' },
  sale: { symbol: 'sell', color: '#ea6a0c', bg: '#ffe9d6' },
  reimbursement: { symbol: 'currency_exchange', color: '#0a86c0', bg: '#d9effb' },
  gift: { symbol: 'redeem', color: '#c332d1', bg: '#f8dffb' },
  interest: { symbol: 'trending_up', color: '#0b7f86', bg: '#d6efee' },
  refund: { symbol: 'undo', color: '#7b4bdb', bg: '#ebe3fb' },
  other_income: { symbol: 'payments', color: '#58677a', bg: '#e3e8ee' },
};

const DEFAULT_EMOJI: Record<string, string> = {};
[...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].forEach((c) => {
  DEFAULT_EMOJI[c.id] = c.icon;
});

export default function CategoryBadge({
  id,
  icon,
  size = 40,
  className = '',
}: {
  id?: string;
  /** The emoji currently set for this category (a group may have changed it). */
  icon?: string;
  size?: number;
  className?: string;
}) {
  const style = id ? CATEGORY_STYLE[id] : undefined;
  const isDefaultIcon = !icon || (id && DEFAULT_EMOJI[id] === icon);
  const box = { width: size, height: size };

  if (style && isDefaultIcon) {
    return (
      <span className={`inline-flex items-center justify-center rounded-full shrink-0 ${className}`} style={{ ...box, background: style.bg }}>
        <span
          className="material-symbols-outlined leading-none"
          style={{ color: style.color, fontSize: Math.round(size * 0.55), fontVariationSettings: "'FILL' 1, 'wght' 500" }}
        >
          {style.symbol}
        </span>
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center justify-center rounded-full shrink-0 bg-[#e3e8ee] ${className}`} style={{ ...box, fontSize: Math.round(size * 0.5) }}>
      {icon || '🧾'}
    </span>
  );
}
