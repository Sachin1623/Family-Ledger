// Goal-Based Savings Engine — types + pure math, shared by GoalsHub, GoalDetail, GoalWizard,
// GoalAllocationManager, and GoalReports.
//
// A goal's TOTAL (goalTotalMinor() below) is always the sum of two separately-tracked, separately-
// displayed buckets that never mix: currentAmountMinor (manual Cash Savings/goal-to-goal
// transfers) and accountAllocatedMinor (linked FinancialAccounts' own % allocations, see
// accounts.ts and accountAllocations.ts). Only the SECOND bucket ever actually funds a goal —
// bucket #1 exists purely as a place manually-moved money can sit (moved OUT of a goal via Return
// to Cash Savings, or between goals via Transfer to Other Goal(s)/Merge), never a funding source
// itself. This app deliberately does NOT try to reconcile the two into one authoritative number —
// forcing them into one figure either double-counts or silently drops money depending on how a
// user actually uses accounts alongside plain transfers. Nothing in Goals ever posts back into
// `expenses`/income — see accountAllocations.ts and GoalDetail.tsx's handleCompleteGoal for why
// that's a hard rule now.
//
// Goals are USER-level, not group-level. Net savings, aggregated across every group the user
// belongs to for the month, is computed and credited in FULL to Cash Savings every month (see
// GoalsHub.tsx's postMonthToCashSavings — a manual "Post This Month's Savings" button for the
// current month, plus an automatic client-side catch-up for any past month the user never
// posted, since the server has no working AES replica for this encrypted field and so can't do it
// as a cron job). Cash Savings is a pure holding pool from there: money leaves it only via
// Transfer to Other Goal(s)/Merge, Transfer to Account (into a real FinancialAccount balance,
// from which it can then be % allocated — see accountAllocations.ts), or an explicit Reset. A
// goal can optionally be SHARED (visible to a group's members and/or specific friends — same dual
// sharing model sharedReminders.ts already uses) so family can watch progress and add manual
// boosts to bucket #1, but a share never grants funding access — only the owner's own linked
// accounts fund a goal.
//
// Scope note (read before assuming full spec parity): this is a first production-usable version
// of a much larger original spec, and has been reworked more than once as real usage surfaced
// gaps. In particular:
//  - Month-end closure used to be entirely user-triggered with no fallback; it's now backed by
//    the client-side catch-up above, still idempotent via the same `userGoalMonths` guard doc.
//  - Goals used to be funded by a direct percentage split of monthly savings (`allocationPct`,
//    an Allocation Manager percentage splitter) — removed. GoalAllocationManager.tsx now shows/
//    edits every account→goal % allocation from one place instead.
//  - There is no Reconciliation feature — removed; it compared account balances against
//    calculated savings and posted an adjustment expense, both no longer applicable now that
//    accounts and monthly savings are two permanently separate, non-reconciled buckets by design.

import { encryptAmount, decryptAmount } from './fieldCrypto';
import { FinancialAccount, CompoundFrequency, ContributionFrequency, COMPOUND_PERIODS_PER_YEAR, nextContributionDate } from './accounts';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Goal {
  id: string;
  userId: string; // owner — whose aggregated net savings funds this goal
  name: string;
  targetAmountMinor: number; // integer minor units (e.g. paise) — all goal math stays integer
  // Bucket #1 of 2 (see goalTotalMinor() below): monthly savings posting + manual Return-to-
  // Cash-Savings/Transfer-to-Other-Goals moves — never funded directly (see cashHoldingGoalId's
  // own doc comment: Cash Savings now receives 100% of net savings, full stop; a goal only ever
  // gets money from linked accounts, see accountAllocatedMinor below). Never touched by anything
  // account-related.
  currentAmountMinor: number;
  status: GoalStatus;
  targetDate: string | null; // yyyy-mm-dd
  notes: string | null;
  icon: string; // emoji
  imageUrl: string | null; // optional cover photo — base64 data URI, same convention as ImageAttachments elsewhere (not a financial figure, so unlike the amount fields it is never encrypted)
  currency: string; // chosen at creation (defaults to the owner's most-used group's currency)
  // True only for the one auto-created per-user "Cash Savings" catch-all — see cashHoldingGoalId()
  // and GoalsHub.tsx's handlePostMonth. No target (always 0), never takes a percentage share,
  // never paused/archived/deleted through the normal UI — it exists purely so month-end savings
  // that isn't assigned to any percentage-goal has somewhere real to land instead of vanishing
  // into a number nobody can act on. The user moves money OUT of it into a real goal via the
  // existing Merge feature — no new transfer mechanism needed.
  isCashHolding?: boolean;
  // Bucket #2 of 2 (see goalTotalMinor() below): money allocated from linked FinancialAccounts'
  // own goalAllocations percentages. Moves ONLY when the user edits the source account's balance
  // or % allocation, transfers between their own accounts, or explicitly resets the allocation —
  // never via monthly posting, never via Pull/Return/Transfer (those only ever touch
  // currentAmountMinor, bucket #1). See src/lib/accountAllocations.ts's saveAccountAllocations(),
  // the ONLY place that ever writes this field.
  accountAllocatedMinor: number;
  // Sharing — same dual model as sharedReminders.ts: an optional group AND/OR specific friends.
  // Every shared viewer can always see progress; whether they can also post a boost is gated by
  // role below. Only the owner can ever withdraw, edit, pause, merge, allocate accounts, or
  // archive/delete, regardless of role.
  groupId: string | null;
  friendUids: string[];
  // 'view' = read-only, 'edit' = can also post a boost. One role for the WHOLE shared group (not
  // per-member — picking a role per group member would be its own UI this app doesn't have), and
  // a role per individual friend (they're each added one at a time already). Missing/null defaults
  // to 'edit' — every goal shared before this field existed already granted boost rights
  // unconditionally, and an absent value must keep meaning exactly that, not silently downgrade
  // pre-existing shares to view-only. New shares default to 'view' instead (see GoalWizard.tsx) —
  // the safer starting point going forward, even though old data defaults the other way.
  groupRole?: 'view' | 'edit' | null;
  friendRoles?: Record<string, 'view' | 'edit'>;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// 'reconciliation' is kept only so historical entries written before Reconciliation was removed
// still render correctly — nothing creates new ones anymore. Same for 'completed': Mark Completed
// now writes a zero-amount marker of this type, never a real posting.
export type GoalLedgerEntryType =
  | 'auto' | 'boost' | 'withdrawal' | 'merge_in' | 'merge_out' | 'reconciliation' | 'undo' | 'completed'
  | 'account_alloc' | 'account_dealloc' | 'reset';

export interface GoalLedgerEntry {
  id: string;
  type: GoalLedgerEntryType;
  amountMinor: number; // positive = inflow, negative = outflow (withdrawal / merge_out)
  monthKey: string | null; // set for 'auto' entries — which closed month this posted from
  note: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  relatedGoalId?: string; // merge_in/merge_out: the other side of the transfer
}

export const MAX_GOAL_AMOUNT_MINOR = 100_00_00_000_00; // ₹1,000,000,000.00 — a generous ceiling, not a real ceiling on wealth

// --- Field-level encryption boundary ---
// Firestore stores targetAmountMinor/currentAmountMinor/amountMinor as ciphertext (or, for
// documents written before this existed, plain numbers — decryptAmount() passes those through
// unchanged). Every screen that reads goals/ledger entries from Firestore must run raw docs
// through these before using them as a `Goal`/`GoalLedgerEntry` — everywhere ELSE in this file
// and in the screens, a Goal's amounts are already-decrypted plain numbers, exactly as before
// encryption existed. See src/lib/fieldCrypto.ts for the actual crypto.
export async function decryptGoalAmounts(raw: any): Promise<Goal> {
  const [targetAmountMinor, currentAmountMinor, accountAllocatedMinor] = await Promise.all([
    decryptAmount('goal', raw.id, raw.targetAmountMinor),
    decryptAmount('goal', raw.id, raw.currentAmountMinor),
    decryptAmount('goal', raw.id, raw.accountAllocatedMinor ?? 0),
  ]);
  return { ...raw, targetAmountMinor, currentAmountMinor, accountAllocatedMinor } as Goal;
}
export async function decryptGoalsList(raws: any[]): Promise<Goal[]> {
  return Promise.all(raws.map(decryptGoalAmounts));
}
export async function encryptGoalAmounts(goalId: string, targetAmountMinor: number, currentAmountMinor: number): Promise<{ targetAmountMinor: string; currentAmountMinor: string }> {
  const [target, current] = await Promise.all([
    encryptAmount('goal', goalId, targetAmountMinor),
    encryptAmount('goal', goalId, currentAmountMinor),
  ]);
  return { targetAmountMinor: target, currentAmountMinor: current };
}
// A ledger entry's amountMinor is encrypted under its PARENT goal's scope (goalId), never its
// own entry id — every viewer who can decrypt the goal can decrypt every entry in its history.
export async function decryptLedgerEntries(goalId: string, raws: any[]): Promise<GoalLedgerEntry[]> {
  return Promise.all(raws.map(async (raw) => ({ ...raw, amountMinor: await decryptAmount('goal', goalId, raw.amountMinor) } as GoalLedgerEntry)));
}
export async function encryptLedgerAmount(goalId: string, amountMinor: number): Promise<string> {
  return encryptAmount('goal', goalId, amountMinor);
}

// Every uid a shared goal is visible to, owner included — mirrors reminderRecipientUids() in
// sharedReminders.ts exactly.
export function goalViewerUids(goal: Goal, groupMemberUids: string[]): string[] {
  const set = new Set<string>([goal.userId, ...goal.friendUids]);
  if (goal.groupId) groupMemberUids.forEach((uid) => set.add(uid));
  return Array.from(set);
}

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

// Largest-remainder-method distribution: every goal gets floor(share) first, then the leftover
// minor units go one-at-a-time to the goal with the biggest fractional remainder, tie-broken by
// oldest goal id (createdAt ascending) — deterministic, so re-running this on the same inputs
// always produces the same split, and no minor unit is ever silently dropped or duplicated.
export function distributeByPercentage(
  totalMinor: number,
  shares: { id: string; pct: number; createdAt: string }[],
): Record<string, number> {
  const result: Record<string, number> = {};
  if (totalMinor <= 0 || shares.length === 0) return result;

  const withExact = shares.map((s) => {
    const exact = (totalMinor * s.pct) / 100;
    const base = Math.floor(exact);
    return { id: s.id, createdAt: s.createdAt, base, remainder: exact - base };
  });

  withExact.forEach((s) => { result[s.id] = s.base; });
  let distributed = withExact.reduce((sum, s) => sum + s.base, 0);
  let leftover = totalMinor - distributed;

  const byRemainder = [...withExact].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  for (let i = 0; i < byRemainder.length && leftover > 0; i++) {
    result[byRemainder[i].id] += 1;
    leftover -= 1;
  }

  return result;
}

// Deterministic per-user doc ID for the auto-created "Cash Savings" catch-all goal — lets
// GoalsHub's handlePostMonth/catch-up transaction read/create/credit it directly by ID, no query
// needed, exactly one per user, ever. Cash Savings receives the FULL net-savings figure every
// month (see GoalsHub.tsx's postMonthToCashSavings) — goals no longer take a percentage share of
// it directly; the only way a goal gets funded is a linked account's own % allocation (see
// accountAllocations.ts). Money moves out of Cash Savings only via Transfer to Other Goal(s),
// Transfer to Account, or an explicit Reset.
export function cashHoldingGoalId(uid: string): string {
  return `cashHolding_${uid}`;
}

// Trailing 3-month average of a goal's real FUNDING contributions, in minor units — covers both
// funding engines this app has ever had: 'auto' (the retired monthly-savings-percentage posting —
// kept so goals with old history still project correctly) and 'account_alloc'/'account_dealloc'
// (the current account-% allocation engine, see accountAllocations.ts). Windowed by `createdAt`
// (the last 3 calendar months from `today`), not `monthKey` — account-driven entries are always
// written with monthKey: null, since they aren't tied to a month-end close the way 'auto' is, so
// monthKey-based windowing would silently exclude every one of them. Deliberately excludes
// everything else (boost, merge_in/out, undo, reset, withdrawal, completed) — those are manual
// one-offs or peer-to-peer transfers between the user's OWN goals, not this goal's actual funding
// rate. This average, NOT the lifetime average, is what Projected Goal Met Date is built from, per
// spec — a goal that's picked up pace recently should show a nearer date than its full history
// implies.
const FUNDING_LEDGER_TYPES = new Set(['auto', 'account_alloc', 'account_dealloc']);
export function trailingThreeMonthAverage(ledger: GoalLedgerEntry[], today: Date = new Date()): number {
  const cutoff = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
  const relevant = ledger.filter((e) => FUNDING_LEDGER_TYPES.has(e.type) && e.createdAt && new Date(e.createdAt) >= cutoff);
  if (relevant.length === 0) return 0;
  const sum = relevant.reduce((s, e) => s + e.amountMinor, 0);
  return sum / 3;
}

// The single figure that means "how much has actually been saved toward this goal" — always the
// sum of both buckets, even though they're tracked and DISPLAYED separately everywhere (point 4).
export function goalTotalMinor(goal: Pick<Goal, 'currentAmountMinor' | 'accountAllocatedMinor'>): number {
  return goal.currentAmountMinor + goal.accountAllocatedMinor;
}

// null = "unavailable" (per spec: no positive contribution history yet, or already met).
export function projectedCompletionDate(goal: Goal, trailingAvgMinor: number, today: Date = new Date()): string | null {
  const remaining = goal.targetAmountMinor - goalTotalMinor(goal);
  if (remaining <= 0) return null;
  if (trailingAvgMinor <= 0) return null;
  const monthsNeeded = Math.ceil(remaining / trailingAvgMinor);
  const d = new Date(today.getFullYear(), today.getMonth() + monthsNeeded, today.getDate());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Forward-looking horizon projection ---
// projectedCompletionDate() above is backward-looking (a trailing 3-month average of what already
// happened) — it can't know about a SIP or interest rate that was just configured today with no
// history yet, and it blends interest + SIP + one-off manual moves into one noisy average. This
// simulates forward instead, from each linked account's OWN configured interest rate/compounding
// and recurring contribution — exactly the numbers GoalDetail's "Where this comes from" list and
// AccountsHub's own SIP badge already show, so the projection matches what the account screens
// say will happen.
export interface GoalFundingSource {
  // Optional — lets a caller correlate projectGoalHorizonBreakdown()'s per-source results back to
  // the account each entry came from. Unused by the date-only projection, so existing callers that
  // never set it (fundingSourcesForGoal below) are unaffected.
  id?: string;
  pct: number;
  currentBalanceMinor: number;
  interestRatePct: number | null;
  compoundFrequency: CompoundFrequency | null;
  contributionAmountMinor: number | null;
  contributionFrequency: ContributionFrequency | null;
  contributionNextDate: string | null; // yyyy-mm-dd
}

// Every account currently allocating to `goalId` that isn't frozen — same entries GoalDetail's own
// linked-accounts list already reads, carrying the extra interest/SIP fields the projection needs.
// Deliberately excludes any entry with `reservedAmountMinor` set: per accountAllocations.ts's
// reserve-on-target-met rule, a frozen entry never grows again regardless of what its account does
// next (its amount is already fully counted in the goal's current total), so it contributes
// nothing to a FUTURE projection. `accounts` should already be decrypted (decryptAccountsList()).
export function fundingSourcesForGoal(goalId: string, accounts: FinancialAccount[]): GoalFundingSource[] {
  const sources: GoalFundingSource[] = [];
  accounts.forEach((a) => {
    const entry = (a.goalAllocations || []).find((g) => g.goalId === goalId);
    if (!entry || entry.pct <= 0 || entry.reservedAmountMinor != null) return;
    sources.push({
      id: a.id,
      pct: entry.pct,
      currentBalanceMinor: a.currentBalanceMinor,
      interestRatePct: a.interestRatePct ?? null,
      compoundFrequency: a.compoundFrequency ?? null,
      contributionAmountMinor: a.contributionAmountMinor ?? null,
      contributionFrequency: a.contributionFrequency ?? null,
      contributionNextDate: a.contributionNextDate ?? null,
    });
  });
  return sources;
}

// Simulates every source's own balance forward, month by month, applying its interest (compounded
// at its own stated frequency, converted to a monthly-equivalent rate) and crediting any SIP
// contribution(s) that fall due within that month — walked forward with the exact same
// nextContributionDate() cursor AccountsHub's real SIP catch-up uses, so the simulated schedule
// matches what will actually happen. Only `pct`% of each month's growth counts toward the goal —
// the rest of that account's growth belongs to its own unallocated portion, or to other goals it
// also allocates to. Bounded to 50 years (genuinely unreachable with the given inputs, not a bug)
// — stops with a null date there, same as "no positive contribution rate" already does below.
//
// The single walk-forward engine everything else in this section derives from — one month-by-month
// simulation, not one per caller, so the goal-met date, each source's total growth by then, AND the
// full month-by-month schedule (GoalReports' contribution table) can never silently drift apart from
// each other. Every entry carries both that month's OWN incremental growth per source
// (`perSourceMinor`) and the running total per source since today (`perSourceCumulativeMinor`) —
// neither includes each source's own already-counted starting lump sum (today's pct% of its current
// balance); callers add that back in themselves, same as goalTotalMinor()'s own two-bucket split.
export interface GoalHorizonScheduleEntry {
  monthKey: string; // yyyy-mm — the month this entry covers
  perSourceMinor: number[]; // this month's own incremental growth, parallel-indexed to `sources`
  perSourceCumulativeMinor: number[]; // running total growth per source, through this month
  totalMinor: number;
  cumulativeMinor: number;
}
export interface GoalHorizonSchedule {
  date: string | null; // yyyy-mm-dd the goal is projected to be met, null if never within 50 years
  entries: GoalHorizonScheduleEntry[]; // one per simulated month, stopping at `date` (or empty)
}
export function projectGoalHorizonSchedule(remainingMinor: number, sources: GoalFundingSource[], today: Date = new Date()): GoalHorizonSchedule {
  const none: GoalHorizonSchedule = { date: null, entries: [] };
  if (remainingMinor <= 0) return none;
  if (sources.length === 0) return none;

  const state = sources.map((s) => {
    const n = COMPOUND_PERIODS_PER_YEAR[s.compoundFrequency || 'yearly'];
    const monthlyRate = s.interestRatePct ? Math.pow(1 + s.interestRatePct / 100 / n, n / 12) - 1 : 0;
    return {
      balance: s.currentBalanceMinor, pct: s.pct, monthlyRate,
      contributionAmountMinor: s.contributionAmountMinor, contributionFrequency: s.contributionFrequency, nextContribDate: s.contributionNextDate,
      cumulativeMinor: 0,
    };
  });
  // No source has either a rate or a live contribution schedule — nothing will ever change, so
  // there's genuinely no future date to project (same "no positive rate" null the trailing-avg
  // projection already returns).
  if (state.every((s) => s.monthlyRate <= 0 && !(s.contributionAmountMinor && s.contributionFrequency && s.nextContribDate))) return none;

  const entries: GoalHorizonScheduleEntry[] = [];
  let cumulativeMinor = 0;
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const MAX_MONTHS = 600; // 50 years
  for (let m = 0; m < MAX_MONTHS; m++) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate());
    // yyyy-mm-dd string, compared directly against nextContribDate the same way AccountsHub's own
    // REAL SIP catch-up does (`contributionNextDate <= today`, plain string comparison — no Date
    // object parsing, which this app avoids elsewhere too since `new Date('2026-09-30')` parses as
    // UTC midnight and can land on the wrong local day). Inclusive `<=`: a contribution due EXACTLY
    // on this month's boundary date must credit within this month, not slip to next month — the
    // previous `new Date(...) < monthEnd` comparison was strict, so a contribution due exactly one
    // month out from `today` (a very common case — most SIPs get set up "starting today") was
    // silently deferred a full period late, understating every month's projected growth by exactly
    // one contribution the whole way through.
    const monthEndStr = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;
    const perSourceMinor = state.map((s) => {
      const before = s.balance;
      if (s.monthlyRate > 0) s.balance *= 1 + s.monthlyRate;
      if (s.contributionAmountMinor && s.contributionFrequency) {
        while (s.nextContribDate && s.nextContribDate <= monthEndStr) {
          s.balance += s.contributionAmountMinor;
          s.nextContribDate = nextContributionDate(s.nextContribDate, s.contributionFrequency);
        }
      }
      const grownThisMonth = (s.balance - before) * s.pct / 100;
      s.cumulativeMinor += grownThisMonth;
      return grownThisMonth;
    });
    const totalThisMonth = perSourceMinor.reduce((sum, v) => sum + v, 0);
    cumulativeMinor += totalThisMonth;
    cursor = monthEnd;
    entries.push({
      monthKey: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      perSourceMinor: perSourceMinor.map((v) => Math.round(v)),
      perSourceCumulativeMinor: state.map((s) => Math.round(s.cumulativeMinor)),
      totalMinor: Math.round(totalThisMonth),
      cumulativeMinor: Math.round(cumulativeMinor),
    });
    if (cumulativeMinor >= remainingMinor) {
      return { date: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`, entries };
    }
  }
  return none; // never met within 50 years — no partial schedule either, same as the date-only null
}

// Every year an entries[] spans, each source's growth summed across its months and cumulative
// carried from that year's LAST month (entries are already chronological) — GoalReports' yearly
// table view over the same schedule projectGoalHorizonSchedule() above produces.
export interface GoalHorizonYearlyEntry {
  year: number;
  perSourceMinor: number[]; // this YEAR's own incremental growth per source
  perSourceCumulativeMinor: number[]; // running total per source through the end of this year
  totalMinor: number;
  cumulativeMinor: number;
}
export function aggregateScheduleByYear(entries: GoalHorizonScheduleEntry[], sourceCount: number): GoalHorizonYearlyEntry[] {
  const byYear = new Map<number, GoalHorizonYearlyEntry>();
  entries.forEach((e) => {
    const year = Number(e.monthKey.split('-')[0]);
    let y = byYear.get(year);
    if (!y) { y = { year, perSourceMinor: new Array(sourceCount).fill(0), perSourceCumulativeMinor: new Array(sourceCount).fill(0), totalMinor: 0, cumulativeMinor: 0 }; byYear.set(year, y); }
    e.perSourceMinor.forEach((v, i) => { y!.perSourceMinor[i] += v; });
    y.totalMinor += e.totalMinor;
    y.perSourceCumulativeMinor = e.perSourceCumulativeMinor;
    y.cumulativeMinor = e.cumulativeMinor;
  });
  return Array.from(byYear.values());
}

export interface GoalHorizonBreakdown {
  date: string | null;
  perSourceGrowthMinor: number[];
}
export function projectGoalHorizonBreakdown(remainingMinor: number, sources: GoalFundingSource[], today: Date = new Date()): GoalHorizonBreakdown {
  const schedule = projectGoalHorizonSchedule(remainingMinor, sources, today);
  if (schedule.entries.length === 0) return { date: null, perSourceGrowthMinor: sources.map(() => 0) };
  return { date: schedule.date, perSourceGrowthMinor: schedule.entries[schedule.entries.length - 1].perSourceCumulativeMinor };
}

export function projectGoalHorizonDate(remainingMinor: number, sources: GoalFundingSource[], today: Date = new Date()): string | null {
  return projectGoalHorizonBreakdown(remainingMinor, sources, today).date;
}

// The one function every screen (GoalDetail, GoalsHub, GoalReports) should call for "when will
// this goal be met" — prefers the forward SIP/interest/allocation simulation above whenever the
// goal has at least one non-frozen linked account (accurate immediately, even with zero ledger
// history yet), and falls back to the trailing-3-month-average projection — for a goal funded some
// other way (no linked accounts, or every one frozen/rate-and-SIP-free) — so that path keeps
// working exactly as before.
export function goalHorizonDate(goal: Goal, ledger: GoalLedgerEntry[], accounts: FinancialAccount[], today: Date = new Date()): string | null {
  if (goal.status === 'completed') return null;
  const remaining = goal.targetAmountMinor - goalTotalMinor(goal);
  const sources = fundingSourcesForGoal(goal.id, accounts);
  const forward = sources.length > 0 ? projectGoalHorizonDate(remaining, sources, today) : null;
  return forward || projectedCompletionDate(goal, trailingThreeMonthAverage(ledger, today), today);
}

// How many months later (positive) or earlier (zero/negative) a goal's PROJECTED completion sits
// versus the target date the user set for it — the same "behind schedule" figure GoalsHub's own
// goal-card badges already show, extracted here so Cash Savings' "goals behind schedule"
// recommendation (GoalDetail.tsx) uses the exact same definition instead of quietly drifting from
// what the goal's own card says. null when there's nothing to compare (no target date set, or no
// projection available yet).
export function monthsBehindTarget(targetDate: string | null, projected: string | null): number | null {
  if (!targetDate || !projected) return null;
  const [ty, tm] = targetDate.split('-').map(Number);
  const [py, pm] = projected.split('-').map(Number);
  return (py - ty) * 12 + (pm - tm);
}

export function goalProgressPct(goal: Goal): number {
  if (goal.targetAmountMinor <= 0) return 0;
  return Math.min(100, (goalTotalMinor(goal) / goal.targetAmountMinor) * 100);
}

// Validation — mirrors the spec's field rules exactly (trimmed+required+unique name, positive
// amount within the configured ceiling, target date today-or-later for new goals).
export function validateGoalName(name: string, existingActiveGoals: { id: string; name: string }[], excludeGoalId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Goal name is required.';
  if (trimmed.length > 60) return 'Goal name must be 60 characters or fewer.';
  const clash = existingActiveGoals.find((g) => g.id !== excludeGoalId && g.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (clash) return 'You already have an active goal with this name.';
  return null;
}

export function validateTargetAmount(amountMinor: number): string | null {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 'Enter a target amount greater than zero.';
  if (amountMinor > MAX_GOAL_AMOUNT_MINOR) return 'That target amount is too large.';
  return null;
}

export function validateTargetDate(dateStr: string | null, todayStr: string): string | null {
  if (!dateStr) return null; // optional field
  if (dateStr < todayStr) return 'Target date must be today or later.';
  return null;
}
