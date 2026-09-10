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
// Every allocation entry always tracks pct% of the account's LIVE balance, full stop — nothing
// here ever freezes/reserves an amount, and a goal is free to sit at or past its target
// indefinitely without anything about its funding changing. This used to auto-freeze an account's
// share the moment a goal's total crossed target ("reserve-on-target-met") and silently
// auto-complete the goal — removed by explicit request: it's confusing for a % to quietly stop
// tracking the account's real balance, and now that GoalDetail's "Mark Completed" actually spends
// the money for real (see spendGoalFromAllAccounts) and Discontinue actually releases it (see
// clearGoalFromAllAccounts), there's no need for a THIRD, silent, automatic way for an allocation
// to stop moving — finalizing a goal is always an explicit action now. A `reservedAmountMinor` on
// an entry can still exist as leftover data from before this change; it's honored one last time
// (falling back to it as the entry's prior amount) but is never re-created and gets dropped the
// next time this account is saved at all, unfreezing it for good.
//
// `justCompletedGoals` no longer means "frozen and auto-completed" — it fires once, the moment a
// goal's total crosses its target for the first time, purely to trigger the existing "you reached
// your goal" push notification (notifyGoalsMet) — nothing about the goal or its allocations
// actually changes because of it.
import { collection, doc, getDoc, getDocs, orderBy, query, runTransaction, updateDoc, where } from 'firebase/firestore';
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
  // Sharing — same dual model as goals.ts's Goal. A shared EDITOR (not just a viewer) can save
  // these through this same form, but firestore.rules restricts them to a fixed field allow-list
  // that deliberately excludes these four — a shared editor's save always omits them (see
  // AccountsHub's handleSaveAccount), so only the owner's own save ever actually changes who an
  // account is shared with.
  groupId?: string | null;
  friendUids?: string[];
  groupRole?: 'view' | 'edit' | null;
  friendRoles?: Record<string, 'view' | 'edit'>;
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
  // sourceGoalId: set by a transfer FROM a goal's own pool (Cash Savings → account) so
  // undoLatestAccountChange() can re-credit that goal when this entry is later undone. Null for a
  // plain balance edit / direct %-only change (nothing to give back).
  log?: { note?: string; images?: string[]; sourceGoalId?: string },
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
    // Final allocations actually saved on the account — always exactly what the caller passed in
    // `newAllocations` for goals that still exist; nothing here ever rewrites a pct on its own.
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
      // A leftover reservedAmountMinor from before this file stopped ever freezing anything is
      // honored ONE more time as the entry's prior amount (so its own delta below is computed
      // correctly), then never carried forward — finalAllocations below only ever stores
      // {goalId, goalName, pct}, so it's gone for good as soon as this account is touched at all.
      const beforeAmountMinor = (oldEntry?.reservedAmountMinor != null) ? oldEntry.reservedAmountMinor : roundedShare(oldBalance, beforePct);
      const afterAmountMinor = roundedShare(newBalanceMinor, afterPct);
      const delta = afterAmountMinor - beforeAmountMinor;

      if (newEntry) finalAllocations.push({ goalId, goalName: newEntry.goalName, pct: afterPct });

      allocationChanges.push({
        goalId, goalName: newEntry?.goalName || oldEntry?.goalName || '',
        beforePct, afterPct, beforeAmountMinor, afterAmountMinor,
      });
      if (delta === 0) continue;

      const goalData = goalSnap.data() as any;
      const goalCurrentBucket2 = await decryptAmount('goal', goalId, goalData.accountAllocatedMinor ?? 0);

      // Notify — never freeze, never auto-complete (see this file's header comment) — the moment
      // this goal's total crosses its target for the first time, so the user knows to consider
      // Mark Completed themselves. Fires only on the actual crossing (was below, now at/above),
      // never again on a later save while it stays there or after it's genuinely completed.
      if (goalData.status !== 'completed') {
        const targetAmountMinor = await decryptAmount('goal', goalId, goalData.targetAmountMinor ?? 0);
        if (targetAmountMinor > 0) {
          const goalBucket1 = await decryptAmount('goal', goalId, goalData.currentAmountMinor ?? 0);
          const beforeTotal = goalBucket1 + goalCurrentBucket2;
          const afterTotal = beforeTotal + delta;
          if (beforeTotal < targetAmountMinor && afterTotal >= targetAmountMinor) {
            justCompletedGoals.push({ goalId, name: goalData.name || '', amountMinor: targetAmountMinor });
          }
        }
      }

      const goalNext = Math.max(0, goalCurrentBucket2 + delta);
      const encGoalNext = await encryptAmount('goal', goalId, goalNext);
      tx.update(goalRefs[i], { accountAllocatedMinor: encGoalNext, updatedAt: nowIso });
      const encLedgerAmount = await encryptAmount('goal', goalId, goalNext - goalCurrentBucket2);
      tx.set(doc(collection(db, 'goals', goalId, 'ledger')), {
        type: (goalNext >= goalCurrentBucket2 ? 'account_alloc' : 'account_dealloc'),
        amountMinor: encLedgerAmount, monthKey: null,
        note: `${accData.name || 'Account'} — ${afterPct}% allocated`,
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
        note: log?.note || null, images: log?.images || [], sourceGoalId: log?.sourceGoalId || null,
        createdBy: uid, createdByName: actorName, createdAt: nowIso,
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
// `ownerId` used to be omitted — the query filtered on `allocatedGoalIds` alone. Firestore
// evaluates a security rule against a query's POTENTIAL result set, not its actual one: since
// `financialAccounts`' own read rule now also grants access via a shared group/friend role (see
// firestore.rules' isAccountViewer(), added for account sharing) and neither of those branches is
// provable from an `allocatedGoalIds` filter alone, a query with no `userId` filter got rejected
// outright — "Missing or insufficient permissions" — even though it would have returned zero
// documents anyway. A goal's account allocations only ever come from ITS OWNER'S OWN accounts to
// begin with, so this filter is also just correct, not merely a rules workaround.
export async function clearGoalFromAllAccounts(goalId: string, actorName: string, ownerId: string): Promise<void> {
  const snap = await getDocs(query(
    collection(db, 'financialAccounts'),
    where('userId', '==', ownerId),
    where('allocatedGoalIds', 'array-contains', goalId),
  ));
  for (const d of snap.docs) {
    const raw = d.data() as any;
    const balance = await decryptAmount('account', d.id, raw.currentBalanceMinor);
    const nextAllocations: AccountAllocationInput[] = (raw.goalAllocations || []).filter((a: AccountAllocationInput) => a.goalId !== goalId);
    await applyAccountChange(d.id, balance, nextAllocations, actorName);
  }
}

// Explicitly Marking a goal Completed (GoalDetail.tsx's handleCompleteGoal) means the user has
// actually spent that money — unlike Archive/Discontinue (clearGoalFromAllAccounts above), which
// only ever RELEASES a % back to the account, unspent. For every account allocating to this goal:
// its contributed share (the frozen reservedAmountMinor if this goal already hit target and froze,
// otherwise pct% of the live balance) is DEDUCTED from the account's own balance — a real
// withdrawal, logged in that account's own History same as any other balance change — and this
// goal's own entry is removed. Every OTHER goal still allocating to that SAME account keeps its
// own % on a smaller balance now, which would otherwise silently shrink its dollar contribution —
// so each of those (except ones already reserve-frozen, which are untouched by any balance change
// by design) gets its % recomputed against the NEW balance to land on the SAME amount it already
// had, not a proportionally smaller one.
export async function spendGoalFromAllAccounts(goalId: string, actorName: string, ownerId: string): Promise<void> {
  const snap = await getDocs(query(
    collection(db, 'financialAccounts'),
    where('userId', '==', ownerId),
    where('allocatedGoalIds', 'array-contains', goalId),
  ));
  for (const d of snap.docs) {
    const raw = d.data() as any;
    const oldBalance = await decryptAmount('account', d.id, raw.currentBalanceMinor);
    const allocations: AccountAllocationInput[] = raw.goalAllocations || [];
    const thisEntry = allocations.find((a) => a.goalId === goalId);
    if (!thisEntry) continue;
    const spentMinor = thisEntry.reservedAmountMinor != null ? thisEntry.reservedAmountMinor : roundedShare(oldBalance, thisEntry.pct);
    const newBalance = Math.max(0, oldBalance - spentMinor);
    const nextAllocations: AccountAllocationInput[] = allocations
      .filter((a) => a.goalId !== goalId)
      .map((a) => {
        if (a.reservedAmountMinor != null) return a; // frozen — never moves with the balance, leave as-is
        const contributedBefore = roundedShare(oldBalance, a.pct);
        const newPct = newBalance > 0 ? Math.max(0, Math.min(100, Math.round((contributedBefore / newBalance) * 100))) : 0;
        return { goalId: a.goalId, goalName: a.goalName, pct: newPct };
      });
    await applyAccountChange(d.id, newBalance, nextAllocations, actorName, undefined, {
      note: `${thisEntry.goalName} — marked completed, ${fromMinorUnits(spentMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })} spent from this account`,
    });
  }
}

// Un-freezes every account's reservedAmountMinor for this goal — the counterpart to the reserve-
// on-target-met freeze itself (see this file's own header comment): the freeze exists because the
// goal hit ITS target, but a goal's target isn't actually immutable — raising it later (GoalWizard)
// past the goal's current total means it's genuinely no longer "met," and the frozen slice(s) that
// used to be believed that should go back to tracking the account's live balance/% again, exactly
// like every other unreserved entry. Deliberately NOT routed through applyAccountChange(): that
// function can only ever clear a reservation via an EXPLICIT pct change (its own designed
// behavior — an unchanged pct always re-honors an existing freeze, by design, so callers can't
// accidentally unfreeze something by re-saving the same %), which isn't what's happening here —
// the % itself isn't changing, only the freeze flag is being lifted. This intentionally never
// touches accountAllocatedMinor (the goal's own bucket #2 total) — an unfrozen entry keeps
// contributing exactly what it already was contributing at the moment of unfreezing; it only
// starts moving with the account's balance again from here forward.
export async function unfreezeGoalReservations(goalId: string, ownerId: string): Promise<void> {
  const snap = await getDocs(query(
    collection(db, 'financialAccounts'),
    where('userId', '==', ownerId),
    where('allocatedGoalIds', 'array-contains', goalId),
  ));
  const nowIso = new Date().toISOString();
  for (const d of snap.docs) {
    const raw = d.data() as any;
    const allocations: AccountAllocationInput[] = raw.goalAllocations || [];
    const entry = allocations.find((a) => a.goalId === goalId);
    if (!entry || entry.reservedAmountMinor == null) continue;
    const nextAllocations = allocations.map((a) =>
      a.goalId === goalId ? { goalId: a.goalId, goalName: a.goalName, pct: a.pct } : a,
    );
    await updateDoc(doc(db, 'financialAccounts', d.id), { goalAllocations: nextAllocations, updatedAt: nowIso });
  }
}

// Drops an account's balance/allocations to zero — used immediately before deleting it, so every
// goal it contributed to is credited back down first (logged), instead of the deletion silently
// leaving stale money behind on those goals. applyAccountChange() is a safe no-op if the account
// doc is already gone.
export async function deallocateAccountBeforeDelete(accountId: string, actorName: string): Promise<void> {
  await applyAccountChange(accountId, 0, [], actorName);
}

// Reverses the SINGLE most recent entry in an account's History: restores its balance and every
// goal-allocation % to exactly what they were just before that entry, via a fresh
// applyAccountChange (so the undo is itself a logged, auditable entry — not a silent rewind).
// If that entry was a transfer FROM a goal's own pool (log.sourceGoalId set — Cash Savings →
// account), the credited amount is put back into that goal too, with an 'undo' ledger line.
// Deliberately only ever the LATEST entry: reverting an older one would need a "restore to a
// past state" that clobbers every change made after it. Refuses ('stale') if the account's live
// balance no longer matches that entry's "after" value — something else has touched it since.
export async function undoLatestAccountChange(accountId: string, actorName: string): Promise<void> {
  const accSnap = await getDoc(doc(db, 'financialAccounts', accountId));
  if (!accSnap.exists()) throw new Error('account-missing');
  const accData = accSnap.data() as any;
  const liveBalance = await decryptAmount('account', accountId, accData.currentBalanceMinor);

  const logSnap = await getDocs(query(
    collection(db, 'financialAccounts', accountId, 'log'),
    orderBy('createdAt', 'desc'),
  ));
  if (logSnap.empty) throw new Error('no-history');
  const entry = logSnap.docs[0].data() as any;

  const balanceBefore = await decryptAmount('account', accountId, entry.balanceBeforeMinor);
  const balanceAfter = await decryptAmount('account', accountId, entry.balanceAfterMinor);
  if (liveBalance !== balanceAfter) throw new Error('stale');

  // allocationChanges carries EVERY goal the account touched at that entry (not just the ones
  // whose % changed), each with its beforePct — so this is the complete allocation set as it
  // stood right before the entry. If an entry somehow has none recorded (older/edge data), leave
  // the account's current allocations untouched and only reverse the balance.
  const allocChanges = (entry.allocationChanges || []) as any[];
  const beforeAllocations: AccountAllocationInput[] = allocChanges.length > 0
    ? allocChanges
        .map((c) => ({ goalId: c.goalId as string, goalName: (c.goalName as string) || '', pct: (c.beforePct as number) || 0 }))
        .filter((c) => c.pct > 0)
    : (accData.goalAllocations || []).map((a: any) => ({ goalId: a.goalId, goalName: a.goalName, pct: a.pct }));

  const undoNote = entry.note ? `Undo — ${entry.note}` : 'Undo of previous change';
  await applyAccountChange(accountId, balanceBefore, beforeAllocations, actorName, undefined, { note: undoNote });

  const sourceGoalId: string | null = entry.sourceGoalId || null;
  const creditedDelta = balanceAfter - balanceBefore; // > 0 when a transfer IN is being undone
  if (sourceGoalId && creditedDelta > 0) {
    const nowIso = new Date().toISOString();
    await runTransaction(db, async (tx) => {
      const gRef = doc(db, 'goals', sourceGoalId);
      const gSnap = await tx.get(gRef);
      if (!gSnap.exists()) return; // source goal gone — the account side is still correctly reversed
      const current = await decryptAmount('goal', sourceGoalId, gSnap.data()!.currentAmountMinor ?? 0);
      const encNext = await encryptAmount('goal', sourceGoalId, current + creditedDelta);
      tx.update(gRef, { currentAmountMinor: encNext, updatedAt: nowIso });
      const encLedger = await encryptAmount('goal', sourceGoalId, creditedDelta);
      tx.set(doc(collection(db, 'goals', sourceGoalId, 'ledger')), {
        type: 'undo', amountMinor: encLedger, monthKey: null,
        note: `Undo — transfer to ${accData.name || 'account'}`,
        createdBy: auth.currentUser?.uid || '', createdByName: actorName, createdAt: nowIso,
      });
    });
  }
}

// Shared core for "move money from Cash Savings into a real account" — the exact two-step shape
// GoalDetail's own single-destination "Transfer to Account" already uses (a transaction
// decrementing Cash Savings' own bucket #1 + a 'withdrawal' ledger entry, then applyAccountChange()
// crediting the destination account so its EXISTING allocations correctly see the larger balance),
// pulled out here so it can be called from two different timings: immediately (GoalDetail's
// Recommended Transfers card, "Now") or later, the moment a linked to-do gets marked done
// (ToDoList.tsx) — neither caller needs to already have the account loaded in React state, this
// reads and decrypts it itself. Never touches any allocation's own pct — same "cash-relocation and
// %-to-goal edits stay separate" principle as the rest of this file.
export async function executeCashToAccountTransfer(
  fromGoalId: string, toAccountId: string, amountMinor: number, actorName: string, note?: string,
): Promise<{ justCompletedGoals: JustCompletedGoal[] }> {
  const nowIso = new Date().toISOString();
  const uid = auth.currentUser?.uid || '';

  // Checked before touching Cash Savings at all — an account deleted between a "Later" to-do being
  // created and it being completed shouldn't leave Cash Savings silently debited with nowhere for
  // the credit to land.
  const accRef = doc(db, 'financialAccounts', toAccountId);
  const accSnap = await getDoc(accRef);
  if (!accSnap.exists()) throw new Error('destination-account-missing');
  const raw = accSnap.data() as any;

  await runTransaction(db, async (tx) => {
    const goalRef = doc(db, 'goals', fromGoalId);
    const snap = await tx.get(goalRef);
    if (!snap.exists()) throw new Error('cash-savings-missing');
    const current = await decryptAmount('goal', fromGoalId, snap.data()!.currentAmountMinor);
    // No escrow — a proposed-but-not-yet-executed transfer never reserves anything, so the balance
    // actually available at completion time can be lower than when it was proposed. Caller surfaces
    // this and leaves whatever triggered it (a to-do, the Recommended Transfers card) unresolved.
    if (amountMinor > current) throw new Error('insufficient-balance');
    const encNew = await encryptAmount('goal', fromGoalId, current - amountMinor);
    tx.update(goalRef, { currentAmountMinor: encNew, updatedAt: nowIso });
    const encLedger = await encryptAmount('goal', fromGoalId, -amountMinor);
    tx.set(doc(collection(db, 'goals', fromGoalId, 'ledger')), {
      type: 'withdrawal', amountMinor: encLedger, monthKey: null, note: note || null,
      createdBy: uid, createdByName: actorName, createdAt: nowIso,
    });
  });

  const oldBalance = await decryptAmount('account', toAccountId, raw.currentBalanceMinor);
  return applyAccountChange(
    toAccountId, oldBalance + amountMinor, raw.goalAllocations || [], actorName,
    {
      name: raw.name, type: raw.type, currency: raw.currency, balanceAsOf: nowIso.slice(0, 10),
      interestRatePct: raw.interestRatePct ?? null, compoundFrequency: raw.compoundFrequency ?? null,
    },
    { note: note || undefined, sourceGoalId: fromGoalId },
  );
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
