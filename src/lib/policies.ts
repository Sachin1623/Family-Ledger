// Policy Vault — types + pure math/validation, shared by PolicyVault.tsx, PolicyWizard.tsx, and
// PolicyDetail.tsx. A policy is a USER-owned record (health/life/vehicle/etc. insurance, LIC, term
// plans...) with a renewal date and a list of covered members, sharable view/edit with a group
// and/or specific friends — the exact same dual sharing model FinancialAccount already uses (see
// accounts.ts:80-83's own doc comment), including its view-by-default choice: there's no legacy
// data to stay compatible with here either, and a policy number/coverage detail is just as
// sensitive as a real account balance.
//
// Document/photo attachments (ID card photos, scanned pages) are deliberately NOT part of this —
// left out at the user's own request, to decide separately later. Adding an `images: string[]`
// field afterward (reusing ImageAttachments.tsx, or something bigger) needs no migration; this
// schema already has room for it.

import { encryptAmount, decryptAmount } from './fieldCrypto';

export type PolicyType = 'health' | 'life' | 'term' | 'vehicle' | 'home' | 'travel' | 'other';

export const POLICY_TYPES: { id: PolicyType; icon: string; label: string }[] = [
  { id: 'health', icon: '🏥', label: 'Health Insurance' },
  { id: 'life', icon: '💼', label: 'Life Insurance (LIC etc.)' },
  { id: 'term', icon: '🛡️', label: 'Term Plan' },
  { id: 'vehicle', icon: '🚗', label: 'Vehicle Insurance' },
  { id: 'home', icon: '🏠', label: 'Home Insurance' },
  { id: 'travel', icon: '✈️', label: 'Travel Insurance' },
  { id: 'other', icon: '📋', label: 'Other' },
];

export type PremiumFrequency = 'monthly' | 'quarterly' | 'halfyearly' | 'yearly' | 'oneTime';

export const PREMIUM_FREQUENCIES: { id: PremiumFrequency; label: string }[] = [
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'halfyearly', label: 'Half-Yearly' },
  { id: 'yearly', label: 'Yearly' },
  { id: 'oneTime', label: 'One-Time' },
];

export type PolicyStatus = 'active' | 'lapsed' | 'archived';

export interface Policy {
  id: string;
  userId: string; // owner
  type: PolicyType;
  name: string; // e.g. "Family Floater — Star Health"
  provider: string; // insurer/company name
  policyNumber: string;
  // Free-text names, not linked FamilyLedger accounts — matches how a real policy lists insureds
  // (very often a minor or a parent with no account of their own at all).
  membersCovered: string[];
  sumInsuredMinor: number | null; // encrypted, integer minor units — 'policy' scope, see fieldCrypto.ts
  premiumAmountMinor: number | null; // encrypted
  premiumFrequency: PremiumFrequency | null;
  currency: string;
  startDate: string | null; // yyyy-mm-dd
  renewalDate: string | null; // yyyy-mm-dd — drives the reminder below
  reminderDaysBefore: number; // how far ahead of renewalDate to nudge, default 30
  // Dedupe guard for the renewal-reminder cron — set to the renewalDate a reminder was actually
  // sent for. Comparing against renewalDate itself (not just a boolean) means changing the date
  // automatically re-arms the reminder, no separate "reset" step needed.
  lastRenewalReminderSentFor: string | null;
  notes: string | null;
  status: PolicyStatus;
  // Sharing — identical shape/semantics to FinancialAccount. Missing groupRole/friendRoles entry
  // defaults to 'view' (see accounts.ts's own doc comment on why that's the safer default here).
  groupId: string | null;
  groupRole: 'view' | 'edit' | null;
  friendUids: string[];
  friendRoles: Record<string, 'view' | 'edit'>;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_POLICY_AMOUNT_MINOR = 100_00_00_000_00; // ₹1,000,000,000.00 — same generous ceiling as goals.ts

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

// --- Field-level encryption boundary — same shape as goals.ts's decryptGoalAmounts/
// encryptGoalAmounts, see that file's own header comment for the full rationale. ---
export async function decryptPolicyAmounts(raw: any): Promise<Policy> {
  const [sumInsuredMinor, premiumAmountMinor] = await Promise.all([
    raw.sumInsuredMinor == null ? Promise.resolve(null) : decryptAmount('policy', raw.id, raw.sumInsuredMinor),
    raw.premiumAmountMinor == null ? Promise.resolve(null) : decryptAmount('policy', raw.id, raw.premiumAmountMinor),
  ]);
  return { ...raw, sumInsuredMinor, premiumAmountMinor } as Policy;
}
export async function decryptPoliciesList(raws: any[]): Promise<Policy[]> {
  return Promise.all(raws.map(decryptPolicyAmounts));
}
export async function encryptPolicyAmounts(
  policyId: string,
  sumInsuredMinor: number | null,
  premiumAmountMinor: number | null,
): Promise<{ sumInsuredMinor: string | null; premiumAmountMinor: string | null }> {
  const [sum, premium] = await Promise.all([
    sumInsuredMinor == null ? Promise.resolve(null) : encryptAmount('policy', policyId, sumInsuredMinor),
    premiumAmountMinor == null ? Promise.resolve(null) : encryptAmount('policy', policyId, premiumAmountMinor),
  ]);
  return { sumInsuredMinor: sum, premiumAmountMinor: premium };
}

// --- Validation ---
export function validatePolicyName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Policy name is required.';
  if (trimmed.length > 80) return 'Policy name must be 80 characters or fewer.';
  return null;
}

export function validateAmountMinor(amountMinor: number | null): string | null {
  if (amountMinor == null) return null; // optional field
  if (!Number.isFinite(amountMinor) || amountMinor < 0) return 'Enter a valid amount.';
  if (amountMinor > MAX_POLICY_AMOUNT_MINOR) return 'That amount is too large.';
  return null;
}

export function validateRenewalDate(dateStr: string | null): string | null {
  if (!dateStr) return null; // optional field
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'Enter a valid date.';
  return null;
}

// Whether a policy's renewal is due within its own reminder window (or already overdue) — used by
// PolicyVault.tsx's list to visually flag a card, and PolicyDetail.tsx's header. `todayStr` is
// injected (not read internally) so both this and its caller stay pure/testable against the same
// "now."
export function isRenewalDueSoon(policy: Policy, todayStr: string): boolean {
  if (!policy.renewalDate) return false;
  const renewal = new Date(`${policy.renewalDate}T00:00:00`).getTime();
  const today = new Date(`${todayStr}T00:00:00`).getTime();
  const warnFrom = renewal - policy.reminderDaysBefore * 24 * 60 * 60 * 1000;
  return today >= warnFrom;
}
export function isRenewalOverdue(policy: Policy, todayStr: string): boolean {
  if (!policy.renewalDate) return false;
  return policy.renewalDate < todayStr;
}
