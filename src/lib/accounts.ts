// Financial Accounts — bank/investment/broker accounts the user tracks a running balance for
// (HDFC, ICICI-Self, ICICI-Wife, Zerodha, Groww, Coin, etc). Balances are updated ONLY by the
// user manually editing an account (AccountsHub) or transferring between two of their own
// accounts — nothing else in the app (expenses, income, recurring transfers) ever mutates one.
//
// An account can allocate percentages of its balance across several goals at once
// (goalAllocations) — see src/lib/accountAllocations.ts's saveAccountAllocations(), the single
// place that ever recomputes a goal's accountAllocatedMinor from this. Whatever isn't allocated
// stays this account's own unallocated portion, shown on the account itself — it is NEVER pooled
// into Cash Savings or anywhere else; Cash Savings is fed exclusively by monthly savings posting
// (see goals.ts / GoalsHub.tsx's handlePostMonth), entirely separate from Accounts.
//
// Field-level encryption boundary: Firestore stores currentBalanceMinor as ciphertext (or a plain
// number, for documents written before this existed — decryptAmount() passes those through).
// Every screen reading accounts from Firestore must run raw docs through decryptAccountsList()
// before treating them as a `FinancialAccount` — everywhere else in this file, balances are
// already plain numbers, exactly as before encryption existed. See src/lib/fieldCrypto.ts.

import { encryptAmount, decryptAmount, encryptText, decryptText } from './fieldCrypto';

export interface FinancialAccount {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  currency: string;
  currentBalanceMinor: number; // latest known balance — changes ONLY on an explicit user edit or a Transfer Funds action
  balanceAsOf: string; // yyyy-mm-dd — the date currentBalanceMinor was true as of; user-editable, not just a write timestamp
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  // Which goal(s) this account's balance is allocated to, and by how much (0-100 each, summing to
  // at most 100 — client-enforced, not a Firestore rules invariant, same tradeoff already used for
  // GoalDetail's Merge-to-other-goals % total). goalName is denormalized (goal names are plaintext,
  // never encrypted) purely so the UI can render without an extra goal read per row.
  goalAllocations?: { goalId: string; goalName: string; pct: number; reservedAmountMinor?: number }[];
  // Flat mirror of goalAllocations' ids, kept in sync on every save — exists ONLY so Firestore can
  // query "which of my accounts allocate to goal X" via array-contains (Reset Allocation on
  // GoalDetail, and cleanup when a goal is permanently deleted). Never read for anything else.
  allocatedGoalIds?: string[];
  // interestRatePct + compoundFrequency alone are still just informational record-keeping (what
  // rate applies, for the user's own reference) — this app never silently starts moving money on
  // an account that only has those two set. Auto-crediting only turns on once `interestNextDate`
  // is ALSO set: same mount-time catch-up mechanism as the SIP contribution above (see
  // AccountsHub.tsx), crediting compound interest for every `compoundFrequency` period elapsed
  // since interestNextDate, then advancing it past today. Requiring the explicit next-date is what
  // keeps this from retroactively "discovering" years of un-applied interest on every account that
  // already had a rate saved before this existed — those accounts keep behaving exactly as before
  // (informational only) until the user re-saves and picks a next-credit date.
  interestRatePct?: number | null; // annual %, e.g. 6.5 — null/unset = not tracked
  compoundFrequency?: CompoundFrequency | null;
  interestNextDate?: string | null; // yyyy-mm-dd — next date interest is due to compound; null = auto-credit off
  // Encrypted the same way as currentBalanceMinor (via fieldCrypto's text variant, not the numeric
  // one — an account number isn't itself an amount) — the app-level type below is always the
  // decrypted plain string once run through decryptAccount()/decryptAccountsList().
  accountNumber?: string | null;
  // Who the account is payable-on-death to, and their split. A single nominee needs no split (pct
  // is display-only informational there, defaults to 100); AccountsHub only shows/requires the pct
  // input once a second nominee is added. Names are plaintext, same tradeoff as goalName above —
  // not the sensitive part of this record, the account number and balance are.
  nominees?: { name: string; pct: number }[];
  // Recurring auto-contribution ("SIP") — when set, AccountsHub's own mount-time catch-up
  // (applySipCatchUp in AccountsHub.tsx) credits currentBalanceMinor by contributionAmountMinor
  // for every `contributionFrequency` period that has elapsed since contributionNextDate, then
  // advances contributionNextDate past today — client-triggered, same reason GoalsHub's Cash
  // Savings catch-up is client-triggered: the server has no working decrypt path for account
  // balances (see fieldCrypto.ts's header comment), so nothing server-side can ever compute the
  // new balance itself. contributionAmountMinor is ciphertext (encrypted the same 'account' scope
  // as currentBalanceMinor) once decrypted by decryptAccount().
  contributionAmountMinor?: number | null;
  contributionFrequency?: ContributionFrequency | null;
  contributionNextDate?: string | null; // yyyy-mm-dd — next date a contribution is due
}

export type AccountType = 'bank' | 'mutual_fund' | 'broker' | 'real_estate' | 'cash' | 'other';

export const ACCOUNT_TYPES: { id: AccountType; label: string; icon: string }[] = [
  { id: 'bank', label: 'Bank', icon: '🏦' },
  { id: 'mutual_fund', label: 'Mutual Fund', icon: '📊' },
  { id: 'broker', label: 'Broker / Demat', icon: '📈' },
  { id: 'real_estate', label: 'Real Estate', icon: '🏠' },
  { id: 'cash', label: 'Cash', icon: '💵' },
  { id: 'other', label: 'Other', icon: '💰' },
];

export type CompoundFrequency = 'daily' | 'weekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'half_yearly' | 'yearly';

export const COMPOUND_FREQUENCIES: { id: CompoundFrequency; label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'bimonthly', label: 'Every 2 Months' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'half_yearly', label: 'Half-Yearly' },
  { id: 'yearly', label: 'Yearly' },
];

// How many times a year a CompoundFrequency actually compounds — the per-period interest rate
// applied by AccountsHub's interest catch-up is interestRatePct / 100 / this, same convention
// goalHorizonDate()'s forward simulation in goals.ts already uses.
export const COMPOUND_PERIODS_PER_YEAR: Record<CompoundFrequency, number> = {
  daily: 365, weekly: 52, monthly: 12, bimonthly: 6, quarterly: 4, half_yearly: 2, yearly: 1,
};

// Advances a yyyy-mm-dd date string by one compounding period — same local-time date arithmetic
// as nextContributionDate() below, for the same reason (new Date('2026-09-30') parses as UTC
// midnight, landing on the wrong local calendar day in negative-UTC-offset zones).
export function nextInterestDate(dateStr: string, freq: CompoundFrequency): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d);
  if (freq === 'daily') next.setDate(next.getDate() + 1);
  else if (freq === 'weekly') next.setDate(next.getDate() + 7);
  else if (freq === 'monthly') next.setMonth(next.getMonth() + 1);
  else if (freq === 'bimonthly') next.setMonth(next.getMonth() + 2);
  else if (freq === 'quarterly') next.setMonth(next.getMonth() + 3);
  else if (freq === 'half_yearly') next.setMonth(next.getMonth() + 6);
  else next.setFullYear(next.getFullYear() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

// A "SIP" (Systematic Investment Plan) — the term Indian investors already use for exactly this:
// a fixed amount contributed on a fixed cadence. Deliberately a smaller set than
// CompoundFrequency's (interest compounding has finer real-world cadences; a recurring
// contribution the user is actually setting up is realistically one of these four).
export type ContributionFrequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const CONTRIBUTION_FREQUENCIES: { id: ContributionFrequency; label: string }[] = [
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'yearly', label: 'Yearly' },
];

// Advances a yyyy-mm-dd date string by one contribution period. Local-time date arithmetic (via
// the Date constructor's y/m/d overload, not `new Date(str)`) for the same reason
// medicineEndDateStr()/computeNextTrigger() already parse dates this way elsewhere in this app —
// `new Date('2026-09-30')` parses as UTC midnight, which lands on the wrong local calendar day in
// negative-UTC-offset zones.
export function nextContributionDate(dateStr: string, freq: ContributionFrequency): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d);
  if (freq === 'weekly') next.setDate(next.getDate() + 7);
  else if (freq === 'monthly') next.setMonth(next.getMonth() + 1);
  else if (freq === 'quarterly') next.setMonth(next.getMonth() + 3);
  else next.setFullYear(next.getFullYear() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

// This account's own unallocated amount/percent — the portion of its balance not claimed by any
// goalAllocations entry. Always derived live, never stored (point 10 of the rework spec).
export function accountUnallocatedMinor(a: Pick<FinancialAccount, 'currentBalanceMinor' | 'goalAllocations'>): number {
  const allocatedPct = (a.goalAllocations || []).reduce((s, g) => s + g.pct, 0);
  return Math.round(a.currentBalanceMinor * (100 - allocatedPct) / 100);
}
export function accountAllocatedPctTotal(a: Pick<FinancialAccount, 'goalAllocations'>): number {
  return (a.goalAllocations || []).reduce((s, g) => s + g.pct, 0);
}

export async function decryptAccount(raw: any): Promise<FinancialAccount> {
  const [currentBalanceMinor, accountNumber, contributionAmountMinor] = await Promise.all([
    decryptAmount('account', raw.id, raw.currentBalanceMinor),
    raw.accountNumber != null ? decryptText('account', raw.id, raw.accountNumber) : Promise.resolve(raw.accountNumber ?? null),
    raw.contributionAmountMinor != null ? decryptAmount('account', raw.id, raw.contributionAmountMinor) : Promise.resolve(raw.contributionAmountMinor ?? null),
  ]);
  return { ...raw, currentBalanceMinor, accountNumber, contributionAmountMinor } as FinancialAccount;
}
export async function decryptAccountsList(raws: any[]): Promise<FinancialAccount[]> {
  return Promise.all(raws.map(decryptAccount));
}
export async function encryptAccountBalance(accountId: string, balanceMinor: number): Promise<string> {
  return encryptAmount('account', accountId, balanceMinor);
}
export async function encryptAccountNumber(accountId: string, accountNumber: string): Promise<string> {
  return encryptText('account', accountId, accountNumber);
}
