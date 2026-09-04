// The ONE mechanism that ever moves money into/out of a Goal's accountAllocatedMinor bucket (see
// goals.ts's Goal.accountAllocatedMinor doc comment). Every account save, transfer, delete, and
// the Reset Allocation / Archive cleanup actions all funnel through applyAccountChange() below —
// no other code path is allowed to touch accountAllocatedMinor, which is what lets this stay a
// clean diff against the account's OWN previous doc state rather than needing a separate
// baseline/drift-tracking field (the account doc IS the baseline, always, by construction).
//
// Never touches Cash Savings, never touches `expenses`/income, never needs a bootstrap-if-missing
// step (a goal being allocated to always already exists — picked from the user's own goals list).
//
// Reserve-on-target-met: if crediting a goal's accountAllocatedMinor would take its TOTAL
// (currentAmountMinor + accountAllocatedMinor) to or past its target, the credit is clamped so the
// goal lands exactly at target, that clamped amount is FROZEN on this one (account, goal) pairing
// via `reservedAmountMinor` — future balance changes on the account never move it again — and the
// goal auto-completes. The entry's `pct` is rewritten to whatever % of the CURRENT balance the
// frozen amount now represents, purely so the account's own %-sum / unallocated-% math (and the
// Add/Edit form's 100% cap) stay internally consistent even though the amount itself no longer
// tracks that pct going forward — this is what frees the rest of the account for other goals. An
// explicit edit to that entry's own pct (the user actually changing it, not a balance-driven
// recompute) always clears the reservation and recomputes fresh, re-capping if it's still at/past
// target.
import { collection, doc, getDocs, query, runTransaction, where } from 'firebase/firestore';
import { db, auth } from './firebase';
import { encryptAmount, decryptAmount } from './fieldCrypto';
import { fromMinorUnits } from './goals';

export interface AccountAllocationInput { goalId: string; goalName: string; pct: number; reservedAmountMinor?: number }

// Only the fields AccountsHub's Add/Edit form owns — omit to leave everything except
// balance/allocations untouched (Transfer, delete-prep, Reset, and Archive cleanup all do this).
// accountNumber and contributionAmountMinor are ciphertext here — applyAccountChange() below
// writes `fields` straight through without touching it, so the CALLER must already have run them
// through fieldCrypto's encryptText/encryptAmount before building this object (see AccountsHub's
// handleSaveAccount and applySipCatchUp).
export interface AccountEditableFields {
  name: string; type: string; currency: string; balanceAsOf: string;
  interestRatePct: number | null; compoundFrequency: string | null;
  accountNumber?: string | null;
  nominees?: { name: string; pct: number }[];
  contributionAmountMinor?: string | null;
  contributionFrequency?: string | null;
  contributionNextDate?: string | null;
  interestNextDate?: string | null;
}

export interface JustCompletedGoal { goalId: string; name: string; amountMinor: number }

function roundedShare(balanceMinor: number, pct: number): number {
  return Math.round((balanceMinor * pct) / 100);
}

export async function applyAccountChange(
  accountId: string,
  newBalanceMinor: number,
  newAllocations: AccountAllocationInput[],
  actorName: string,
  fields?: AccountEditableFields,
  log?: { note?: string; images?: string[] },
): Promise<{ justCompletedGoals: JustCompletedGoal[] }> {
  const nowIso = new Date().toISOString();
  const justCompletedGoals: JustCompletedGoal[] = [];
  await runTransaction(db, async (tx) => {
    justCompletedGoals.length = 0; // transactions can retry — never accumulate across attempts
    const accRef = doc(db, 'financialAccounts', accountId);
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists()) return;
    const accData = accSnap.data() as any;
    const uid = accData.userId as string;
    const oldBalance = await decryptAmount('account', accountId, accData.currentBalanceMinor);
    const oldAllocations: AccountAllocationInput[] = accData.goalAllocations || [];

    const oldByGoal = new Map(oldAllocations.map((a) => [a.goalId, a]));
    const newByGoal = new Map(newAllocations.map((a) => [a.goalId, a]));
    const unionIds = Array.from(new Set([...oldByGoal.keys(), ...newByGoal.keys()]));

    const goalRefs = unionIds.map((id) => doc(db, 'goals', id));
    const goalSnaps = await Promise.all(goalRefs.map((ref) => tx.get(ref)));

    const allocationChanges: { goalId: string; goalName: string; beforePct: number; afterPct: number; beforeAmountMinor: number; afterAmountMinor: number }[] = [];
    // Final allocations actually saved on the account — may differ from `newAllocations` when an
    // entry gets capped/reserved this pass (its pct gets rewritten to match).
    const finalAllocations: AccountAllocationInput[] = [];

    for (let i = 0; i < unionIds.length; i++) {
      const goalId = unionIds[i];
      const goalSnap = goalSnaps[i];
      const oldEntry = oldByGoal.get(goalId);
      const newEntry = newByGoal.get(goalId);
      if (!goalSnap.exists()) {
        if (newEntry) finalAllocations.push(newEntry); // goal gone but caller still listed it — leave as-is, harmless
        continue; // nothing safe to credit
      }
      const beforePct = oldEntry?.pct || 0;
      const afterPct = newEntry?.pct || 0;
      const explicitPctChange = afterPct !== beforePct;
      const beforeAmountMinor = (oldEntry?.reservedAmountMinor != null) ? oldEntry.reservedAmountMinor : roundedShare(oldBalance, beforePct);
      let afterAmountMinor = (oldEntry?.reservedAmountMinor != null && !explicitPctChange)
        ? oldEntry.reservedAmountMinor // still frozen — balance moved, pct didn't, honor the freeze
        : roundedShare(newBalanceMinor, afterPct); // fresh computation — explicit edit, or nothing to freeze yet
      let reservedAmountMinor: number | undefined = (oldEntry?.reservedAmountMinor != null && !explicitPctChange) ? oldEntry.reservedAmountMinor : undefined;

      const goalData = goalSnap.data() as any;
      const goalCurrentBucket2 = await decryptAmount('goal', goalId, goalData.accountAllocatedMinor ?? 0);
      const goalBucket1 = await decryptAmount('goal', goalId, goalData.currentAmountMinor ?? 0);
      const targetAmountMinor = await decryptAmount('goal', goalId, goalData.targetAmountMinor ?? 0);
      let delta = afterAmountMinor - beforeAmountMinor;

      // Reserve-on-target-met: only ever caps a FRESH computation (an entry already frozen from a
      // prior pass just keeps its existing reservedAmountMinor, computed above).
      const alreadyCompleted = goalData.status === 'completed';
      if (reservedAmountMinor === undefined && !alreadyCompleted && targetAmountMinor > 0) {
        const prospectiveTotal = goalBucket1 + goalCurrentBucket2 + delta;
        if (prospectiveTotal >= targetAmountMinor) {
          const maxDelta = targetAmountMinor - goalBucket1 - goalCurrentBucket2;
          delta = maxDelta;
          afterAmountMinor = beforeAmountMinor + delta;
          reservedAmountMinor = afterAmountMinor;
          justCompletedGoals.push({ goalId, name: goalData.name || '', amountMinor: targetAmountMinor });
        }
      }

      const effectivePct = reservedAmountMinor !== undefined
        ? (newBalanceMinor > 0 ? Math.min(100, Math.round((reservedAmountMinor / newBalanceMinor) * 100)) : afterPct)
        : afterPct;
      if (newEntry || reservedAmountMinor !== undefined) {
        finalAllocations.push({
          goalId, goalName: newEntry?.goalName || oldEntry?.goalName || '', pct: effectivePct,
          ...(reservedAmountMinor !== undefined ? { reservedAmountMinor } : {}),
        });
      }

      allocationChanges.push({
        goalId, goalName: newEntry?.goalName || oldEntry?.goalName || '',
        beforePct, afterPct: effectivePct, beforeAmountMinor, afterAmountMinor,
      });
      if (delta === 0) continue;

      const goalNext = Math.max(0, goalCurrentBucket2 + delta);
      const encGoalNext = await encryptAmount('goal', goalId, goalNext);
      const goalUpdate: Record<string, any> = { accountAllocatedMinor: encGoalNext, updatedAt: nowIso };
      if (justCompletedGoals.some((g) => g.goalId === goalId)) {
        goalUpdate.status = 'completed';
        goalUpdate.completedAt = nowIso;
      }
      tx.update(goalRefs[i], goalUpdate);
      const encLedgerAmount = await encryptAmount('goal', goalId, goalNext - goalCurrentBucket2);
      tx.set(doc(collection(db, 'goals', goalId, 'ledger')), {
        type: (goalNext >= goalCurrentBucket2 ? 'account_alloc' : 'account_dealloc'),
        amountMinor: encLedgerAmount, monthKey: null,
        note: reservedAmountMinor !== undefined ? `${accData.name || 'Account'} — reserved, goal met` : `${accData.name || 'Account'} — ${effectivePct}% allocated`,
        createdBy: uid, createdByName: actorName, createdAt: nowIso,
      });
    }

    const encNewBalance = await encryptAmount('account', accountId, newBalanceMinor);
    tx.update(accRef, {
      currentBalanceMinor: encNewBalance,
      goalAllocations: finalAllocations,
      allocatedGoalIds: finalAllocations.map((a) => a.goalId),
      updatedAt: nowIso,
      ...(fields || {}),
    });

    if (newBalanceMinor !== oldBalance || allocationChanges.some((c) => c.beforePct !== c.afterPct) || log) {
      const [encBefore, encAfter] = await Promise.all([
        encryptAmount('account', accountId, oldBalance),
        encryptAmount('account', accountId, newBalanceMinor),
      ]);
      const encChanges = await Promise.all(allocationChanges.map(async (c) => ({
        goalId: c.goalId, goalName: c.goalName, beforePct: c.beforePct, afterPct: c.afterPct,
        beforeAmountMinor: await encryptAmount('account', accountId, c.beforeAmountMinor),
        afterAmountMinor: await encryptAmount('account', accountId, c.afterAmountMinor),
      })));
      tx.set(doc(collection(db, 'financialAccounts', accountId, 'log')), {
        balanceBeforeMinor: encBefore, balanceAfterMinor: encAfter, allocationChanges: encChanges,
        note: log?.note || null, images: log?.images || [], createdBy: uid, createdByName: actorName, createdAt: nowIso,
      });
    }
  });
  return { justCompletedGoals };
}

// Removes goalId from every account that currently allocates to it, crediting/debiting each
// account's own accountAllocatedMinor share back through the exact same mechanism above (so it's
// logged identically to any other allocation change). Used by GoalDetail's Reset Allocation, by
// archiveGoal (defensive — archiving itself no longer moves money, see GoalDetail.tsx), and
// defensively by GoalsHub's permanent-delete (in case any account still references an
// already-archived goal).
export async function clearGoalFromAllAccounts(goalId: string, actorName: string): Promise<void> {
  const snap = await getDocs(query(collection(db, 'financialAccounts'), where('allocatedGoalIds', 'array-contains', goalId)));
  for (const d of snap.docs) {
    const raw = d.data() as any;
    const balance = await decryptAmount('account', d.id, raw.currentBalanceMinor);
    const nextAllocations: AccountAllocationInput[] = (raw.goalAllocations || []).filter((a: AccountAllocationInput) => a.goalId !== goalId);
    await applyAccountChange(d.id, balance, nextAllocations, actorName);
  }
}

// Drops an account's balance/allocations to zero — used immediately before deleting it, so every
// goal it contributed to is credited back down first (logged), instead of the deletion silently
// leaving stale money behind on those goals. applyAccountChange() is a safe no-op if the account
// doc is already gone.
export async function deallocateAccountBeforeDelete(accountId: string, actorName: string): Promise<void> {
  await applyAccountChange(accountId, 0, [], actorName);
}

// Fire-and-forget push notification for every goal a call to applyAccountChange() just completed
// — call this with its result's justCompletedGoals right after the call resolves, from any site
// where a balance/allocation change could plausibly push a goal over target (never blocks or
// throws into the caller, same "best effort" treatment as notifyGroupActivity.ts). No-op for an
// empty list, so it's always safe to call unconditionally.
export function notifyGoalsMet(goals: JustCompletedGoal[]) {
  if (goals.length === 0) return;
  goals.forEach((g) => {
    auth.currentUser
      ?.getIdToken()
      .then((idToken) =>
        fetch('/api/notify-goal-met', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ goalId: g.goalId, goalName: g.name, amount: fromMinorUnits(g.amountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 }) }),
        }),
      )
      .catch((err) => console.error('notify-goal-met failed:', err));
  });
}
