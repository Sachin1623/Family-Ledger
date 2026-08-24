// Personal Loans: shared model/helpers for PersonalLoans.tsx and LoanContactDetail.tsx.
//
// A contact's `balance` is a single signed net figure, not a stack of separate per-transaction
// loans — positive means the contact owes the owner, negative means the owner owes the contact.
// Every ledger "line" (ENTRY_TYPES below) has a fixed effect on that number; installment plans
// and reminders are set against this one running total on purpose, since real family/friend
// lending is rarely one clean loan — it's usually several amounts given/taken/repaid over time
// that only make sense to track as a relationship, not isolated transactions.
export type LoanEntryType = 'given' | 'taken' | 'repayment_by_them' | 'repayment_by_me' | 'note';

export const ENTRY_TYPES: { id: LoanEntryType; label: string; labelKey: string; icon: string; sign: 1 | -1 | 0 }[] = [
  { id: 'given', label: 'I gave them money', labelKey: 'loans.entryGiven', icon: 'call_made', sign: 1 },
  { id: 'taken', label: 'I took money from them', labelKey: 'loans.entryTaken', icon: 'call_received', sign: -1 },
  { id: 'repayment_by_them', label: 'They repaid me', labelKey: 'loans.entryRepaymentByThem', icon: 'undo', sign: -1 },
  { id: 'repayment_by_me', label: 'I repaid them', labelKey: 'loans.entryRepaymentByMe', icon: 'redo', sign: 1 },
  { id: 'note', label: 'Just a note', labelKey: 'loans.entryNote', icon: 'sticky_note_2', sign: 0 },
];

export function entryEffect(type: LoanEntryType, amount: number): number {
  const meta = ENTRY_TYPES.find((t) => t.id === type);
  return (meta?.sign || 0) * amount;
}

export function balanceLabel(balance: number): 'owes_you' | 'you_owe' | 'settled' {
  if (balance > 0.005) return 'owes_you';
  if (balance < -0.005) return 'you_owe';
  return 'settled';
}

// Builds a friendly WhatsApp share message + wa.me link. If the contact has a phone number on
// file, the link opens a chat with them directly; otherwise it's a generic share link the user
// picks a recipient for themselves (same graceful-degradation pattern as Profile.tsx's "Spread
// the Word" share buttons).
export function buildWhatsAppReminder(params: {
  contactName: string;
  phone?: string;
  balance: number;
  currencySymbol: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): string {
  const { contactName, phone, balance, currencySymbol, t } = params;
  const label = balanceLabel(balance);
  const amountStr = `${currencySymbol}${Math.abs(balance).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  let message: string;
  if (label === 'owes_you') {
    message = t('loans.waOwesYou', { name: contactName, amount: amountStr });
  } else if (label === 'you_owe') {
    message = t('loans.waYouOwe', { name: contactName, amount: amountStr });
  } else {
    message = t('loans.waSettled', { name: contactName });
  }

  const encoded = encodeURIComponent(message);
  const digits = (phone || '').replace(/[^\d]/g, '');
  return digits ? `https://wa.me/${digits}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}
