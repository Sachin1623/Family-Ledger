import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, setDoc, updateDoc, query, where, getDocs, runTransaction, writeBatch } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { currentLocalMonthKey } from '../lib/dateUtils';
import {
  Goal,
  GoalLedgerEntry,
  goalHorizonDate,
  goalProgressPct,
  goalTotalMinor,
  fromMinorUnits,
  decryptGoalsList,
  decryptLedgerEntries,
  cashHoldingGoalId,
} from '../lib/goals';
import { encryptAmount, decryptAmount } from '../lib/fieldCrypto';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';
import { clearGoalFromAllAccounts } from '../lib/accountAllocations';
import { useFxRates, fetchFxRates, convertBucketsToCurrency } from '../lib/fx';
import { computeNetSavingsBuckets } from '../lib/netSavings';
import AccountsHub from './AccountsHub';
import GoalAllocationManager from './GoalAllocationManager';

// Goals Dashboard — the home hub. Net savings is the user's own, AGGREGATED ACROSS EVERY GROUP
// THEY BELONG TO for the current month (not scoped to any single group — see the header comment
// in lib/goals.ts for the full reasoning and the double-counting caveat). "Post This Month's
// Savings" is this app's stand-in for the spec's automatic month-end closure (a deliberate user
// action rather than a cron job) — idempotent via the userGoalMonths/{uid}_{monthKey} guard doc.
export default function GoalsHub() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = useMemo(() => membershipsValue?.docs.map((d) => d.data().groupId) || [], [membershipsValue]);
  const cappedGroupIds = groupIds.slice(0, 30); // Firestore 'in' query cap, same as elsewhere in this app
  const [groupsValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', cappedGroupIds)) : null);
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
  // "Across all N of your groups" (and the net savings figure itself) must only count groups the
  // user is still actively part of — `groupIds`/`cappedGroupIds` above come straight from
  // membership docs, which stick around for an archived group (same as Dashboard's own
  // active-vs-archived split), so summing/counting off them inflated both the badge and the total
  // with groups that are no longer really "yours" day to day.
  const activeGroupIds = useMemo(() => groups.filter((g: any) => !g.archived).map((g: any) => g.id), [groups]);

  const [goalsTab, setGoalsTab] = useState<'goals' | 'accounts' | 'allocation'>('goals');
  const [showAccountsHelp, setShowAccountsHelp] = useState(false);

  // A default currency for new goals — the user's first/most-used group's currency, since there's
  // no single "the" currency once goals aggregate across groups that could each technically use a
  // different one. (Net savings itself no longer needs this as its OWN display currency — see
  // displayCurrency below, which prefers the user's own profile.currency setting.)
  const defaultCurrency = groups[0]?.currency;

  // Which currency each group is denominated in, for bucketing this month's expenses below —
  // built once per groups snapshot rather than re-searching `groups` per expense.
  const groupCurrencyByGroupId = useMemo(() => {
    const map: Record<string, string> = {};
    groups.forEach((g: any) => { map[g.id] = g.currency || 'INR'; });
    return map;
  }, [groups]);

  const [ownGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('userId', '==', user.uid)) : null);
  const [groupSharedGoalsValue] = useCollection(cappedGroupIds.length > 0 ? query(collection(db, 'goals'), where('groupId', 'in', cappedGroupIds)) : null);
  const [friendSharedGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('friendUids', 'array-contains', user.uid)) : null);

  const [ownGoals, setOwnGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = ownGoalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setOwnGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt goals:', err));
    return () => { cancelled = true; };
  }, [ownGoalsValue]);

  const [sharedWithMeGoals, setSharedWithMeGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const byId = new Map<string, any>();
    groupSharedGoalsValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    friendSharedGoalsValue?.docs.forEach((d) => { if (d.data().userId !== user?.uid) byId.set(d.id, { id: d.id, ...d.data() }); });
    decryptGoalsList(Array.from(byId.values())).then((decrypted) => { if (!cancelled) setSharedWithMeGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt shared goals:', err));
    return () => { cancelled = true; };
  }, [groupSharedGoalsValue, friendSharedGoalsValue, user?.uid]);

  // Cash Savings (isCashHolding) is pinned first when present — it's the catch-all for whatever
  // isn't assigned to a real goal, so it's the thing most worth seeing at a glance.
  const cashSavingsGoal = useMemo(() => ownGoals.find((g) => g.isCashHolding && g.status !== 'archived'), [ownGoals]);
  const visibleOwnGoals = useMemo(() => {
    const rest = ownGoals.filter((g) => g.status !== 'archived' && !g.isCashHolding);
    return cashSavingsGoal ? [cashSavingsGoal, ...rest] : rest;
  }, [ownGoals, cashSavingsGoal]);
  // Only real goals — Cash Savings is excluded from every place that lists "the user's goals" to
  // act on (it's the catch-all itself, never a fundable target).
  const activeGoals = ownGoals.filter((g) => g.status === 'active' && !g.isCashHolding);
  // Archived goals — same UX pattern as Dashboard's collapsed "Archived Groups" section: tucked
  // away, not gone, with a Resume action right there. Only ever a plain "Discontinue" now — "Mark
  // Completed" sets status: 'completed', not 'archived', so a completed goal stays fully visible
  // in the main list (badged) exactly like one that auto-completed by reaching its target.
  const archivedGoals = ownGoals.filter((g) => g.status === 'archived' && !g.isCashHolding);
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  const thisMonthKey = currentLocalMonthKey();
  const [thisMonthExpensesValue] = useCollection(
    activeGroupIds.length > 0 ? query(collection(db, 'expenses'), where('groupId', 'in', activeGroupIds)) : null,
  );

  // Net savings is bucketed by each contributing group's OWN currency (see netSavings.ts) rather
  // than blindly summed as one raw number — a user's groups aren't necessarily all one currency,
  // and adding e.g. ₹100 + A$50 as "150" and calling it either currency was a real bug (fixed here
  // alongside the same bug in Settlements.tsx and PersonalLoans.tsx). Two different totals come out
  // of the SAME buckets, converted against two different targets:
  //   - displayCurrency: what the "Net Savings This Month" figure on screen shows — the user's own
  //     chosen profile.currency if set, else the old first-group fallback. Pure display.
  //   - Cash Savings' OWN currency (fixed at whenever it was first created, never silently changed
  //     by a later profile-currency edit — see Profile.tsx's currency picker): what actually gets
  //     CREDITED when posting, so an existing real balance is never relabeled into a different
  //     currency by a display-preference change.
  // If Cash Savings doesn't exist yet, both targets are the same (displayCurrency doubles as its
  // bootstrap currency — see postMonthToCashSavings below), so this degrades to a single conversion.
  const displayCurrency = profile?.currency || defaultCurrency || 'INR';
  const cashSavingsCurrency = cashSavingsGoal?.currency || displayCurrency;
  const displayRates = useFxRates(displayCurrency);
  const creditRates = useFxRates(cashSavingsCurrency === displayCurrency ? null : cashSavingsCurrency);

  const netSavingsBuckets = useMemo(
    () => computeNetSavingsBuckets((thisMonthExpensesValue?.docs.map((d) => d.data() as any) || []), thisMonthKey, groupCurrencyByGroupId),
    [thisMonthExpensesValue, thisMonthKey, groupCurrencyByGroupId],
  );
  const displayConversion = useMemo(
    () => convertBucketsToCurrency(netSavingsBuckets, displayCurrency, displayRates),
    [netSavingsBuckets, displayCurrency, displayRates],
  );
  const creditConversion = useMemo(
    () => convertBucketsToCurrency(netSavingsBuckets, cashSavingsCurrency, cashSavingsCurrency === displayCurrency ? displayRates : creditRates),
    [netSavingsBuckets, cashSavingsCurrency, displayCurrency, displayRates, creditRates],
  );
  const netSavingsThisMonthMinor = Math.round(displayConversion.convertedMajor * 100);
  // What actually gets credited to Cash Savings on "Post This Month's Savings" — see
  // handlePostMonth below. Named distinctly from netSavingsThisMonthMinor since the two can
  // legitimately differ (different target currencies) even though they're built from the same
  // underlying buckets.
  const netSavingsCreditMinor = Math.round(creditConversion.convertedMajor * 100);

  const monthDocId = user ? `${user.uid}_${thisMonthKey}` : '';
  const [monthDocValue] = useDocument(user ? doc(db, 'userGoalMonths', monthDocId) : null);
  const alreadyPosted = monthDocValue?.exists();

  const [ledgersByGoal, setLedgersByGoal] = useState<Map<string, GoalLedgerEntry[]>>(new Map());
  useEffect(() => {
    if (visibleOwnGoals.length === 0) { setLedgersByGoal(new Map()); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        visibleOwnGoals.map(async (g) => {
          const snap = await getDocs(collection(db, 'goals', g.id, 'ledger'));
          const raw = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
          return [g.id, await decryptLedgerEntries(g.id, raw)] as const;
        }),
      );
      if (!cancelled) setLedgersByGoal(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [visibleOwnGoals.map((g) => g.id).join(',')]);

  // Every one of the owner's own accounts, decrypted — feeds goalHorizonDate() below with each
  // linked account's interest rate/compounding and SIP schedule, not just its balance.
  const [ownAccountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('userId', '==', user.uid)) : null);
  const [ownAccounts, setOwnAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = ownAccountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raw).then((decrypted) => { if (!cancelled) setOwnAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [ownAccountsValue]);

  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState<{ cashHoldingCreditMinor: number } | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  // Goals no longer fund from monthly savings at all (see lib/goals.ts's header comment) — this
  // now only ever does ONE thing: credit the full net-savings figure for `monthKey` into Cash
  // Savings, guarded by the same userGoalMonths/{uid}_{monthKey} idempotency doc as before.
  // Shared by the manual "Post This Month's Savings" button (current month) and the catch-up
  // effect below (any past month the user never got to) — this can't be a server cron because the
  // server has no working AES replica for Goal.currentAmountMinor (see accountAllocations.ts).
  const postMonthToCashSavings = async (monthKey: string, netSavingsMinor: number): Promise<boolean> => {
    if (!user) return false;
    const actorName = profile?.displayName || user.displayName || 'Someone';
    const cashHoldingId = cashHoldingGoalId(user.uid);
    const cashHoldingRef = doc(db, 'goals', cashHoldingId);
    const thisMonthDocId = `${user.uid}_${monthKey}`;

    if (netSavingsMinor > 0) {
      // Two-phase-write bootstrap (same reasoning as GoalWizard.tsx's own new-goal creation): the
      // crypto/key endpoint authorizes a 'goal' scope by reading goals/{id}, which doesn't exist
      // yet the very first time this runs for a user.
      const existingCashDoc = await getDoc(cashHoldingRef);
      if (!existingCashDoc.exists()) {
        const bootstrapIso = new Date().toISOString();
        await setDoc(cashHoldingRef, {
          userId: user.uid, name: t('goals.cashHoldingName'), targetAmountMinor: 0, currentAmountMinor: 0,
          accountAllocatedMinor: 0, status: 'active', targetDate: null, notes: null,
          icon: '🏦', imageUrl: null, currency: displayCurrency, groupId: null, friendUids: [],
          isCashHolding: true, createdBy: user.uid, createdByName: actorName,
          createdAt: bootstrapIso, updatedAt: bootstrapIso, completedAt: null,
        });
      }
    }

    let posted = false;
    await runTransaction(db, async (transaction) => {
      const monthRef = doc(db, 'userGoalMonths', thisMonthDocId);
      const [existing, cashHoldingSnap] = await Promise.all([
        transaction.get(monthRef),
        netSavingsMinor > 0 ? transaction.get(cashHoldingRef) : Promise.resolve(null),
      ]);
      if (existing.exists()) return; // idempotent no-op — already posted (or caught up) elsewhere
      const nowIso = new Date().toISOString();

      if (netSavingsMinor > 0 && cashHoldingSnap) {
        // Defensive, not just optimistic — see the original comment this carried over from: the
        // bootstrap setDoc() above only resolves once acknowledged, but don't trust that blindly.
        const cashExists = cashHoldingSnap.exists();
        const cashCurrent = cashExists ? await decryptAmount('goal', cashHoldingId, cashHoldingSnap.data()!.currentAmountMinor) : 0;
        const [encryptedCashCurrent, encryptedCashLedgerAmount] = await Promise.all([
          encryptAmount('goal', cashHoldingId, cashCurrent + netSavingsMinor),
          encryptAmount('goal', cashHoldingId, netSavingsMinor),
        ]);
        if (cashExists) {
          transaction.update(cashHoldingRef, { currentAmountMinor: encryptedCashCurrent, updatedAt: nowIso });
        } else {
          transaction.set(cashHoldingRef, {
            userId: user.uid, name: t('goals.cashHoldingName'), targetAmountMinor: 0,
            currentAmountMinor: encryptedCashCurrent, accountAllocatedMinor: 0, status: 'active',
            targetDate: null, notes: null, icon: '🏦', imageUrl: null, currency: displayCurrency,
            groupId: null, friendUids: [], isCashHolding: true, createdBy: user.uid, createdByName: actorName,
            createdAt: nowIso, updatedAt: nowIso, completedAt: null,
          });
        }
        transaction.set(doc(collection(db, 'goals', cashHoldingId, 'ledger')), {
          type: 'auto', amountMinor: encryptedCashLedgerAmount, monthKey,
          note: null, createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
        });
      }

      const [encryptedNet, encryptedAllocations] = await Promise.all([
        encryptAmount('user', user.uid, netSavingsMinor),
        netSavingsMinor > 0
          ? (async () => ({ [cashHoldingId]: await encryptAmount('goal', cashHoldingId, netSavingsMinor) }))()
          : Promise.resolve({}),
      ]);
      transaction.set(monthRef, {
        userId: user.uid, monthKey, closedAt: nowIso, closedBy: user.uid,
        netSavingsMinor: encryptedNet, allocations: encryptedAllocations,
        unallocatedMinor: await encryptAmount('user', user.uid, 0), // nothing is ever "unallocated" now — all of it goes to Cash Savings
      });
      posted = true;
    });
    return posted;
  };

  const handlePostMonth = async () => {
    if (!user || posting || alreadyPosted) return;
    // Gates on the CREDIT figure (Cash Savings' own currency), not the display one — they're
    // built from the same buckets and will almost always agree in sign, but the credit figure is
    // what's actually about to be posted.
    if (netSavingsCreditMinor <= 0) return;
    setPosting(true);
    setPostError(null);
    try {
      await postMonthToCashSavings(thisMonthKey, netSavingsCreditMinor);
      setPostResult({ cashHoldingCreditMinor: netSavingsCreditMinor });
    } catch (err: any) {
      console.error('Failed to post this month\'s savings:', err);
      // Every step here needs a real round trip to the server (the bootstrap write, the crypto
      // key fetch, the transaction itself) — none of it can complete offline or on a connection
      // too poor to hold a request open, so surface that distinctly from a genuine failure.
      const isConnectivity = err?.code === 'unavailable' || err?.code === 'deadline-exceeded' || err?.message?.includes('network');
      setPostError(isConnectivity ? t('goals.postFailedConnectivity') : t('goals.postFailed'));
    } finally {
      setPosting(false);
    }
  };

  // Catch-up: walks backward from last month (bounded to 24 months — a stale user re-opening the
  // app after 3+ years is a real edge case, not one worth an unbounded loop for) crediting Cash
  // Savings for any PAST month that was never posted, so "forgot to tap the button" never silently
  // loses that month's savings the way it used to. Runs once per mount; a month found already
  // posted (a real doc exists) stops the walk-back there and only announces months it actually
  // just posted itself, not a full re-scan every time.
  const [catchUpResult, setCatchUpResult] = useState<{ months: number; totalMinor: number } | null>(null);
  useEffect(() => {
    if (!user || activeGroupIds.length === 0) return;
    let cancelled = false;
    (async () => {
      let cursor = thisMonthKey;
      let caughtUpMinor = 0;
      let caughtUpMonths = 0;
      // Fetched once for the whole walk-back, not per month — cashSavingsCurrency doesn't change
      // month to month, and this is the same "convert into Cash Savings' own currency, never the
      // display one" rule handlePostMonth follows for the current month (see the comment above
      // netSavingsCreditMinor's definition).
      const catchUpRates = await fetchFxRates(cashSavingsCurrency);
      for (let i = 0; i < 24; i++) {
        const [cy, cm] = cursor.split('-').map(Number);
        const prevDate = new Date(cy, cm - 2, 1);
        cursor = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
        const guardSnap = await getDoc(doc(db, 'userGoalMonths', `${user.uid}_${cursor}`));
        if (guardSnap.exists()) break; // this month (and everything older) is already accounted for
        const expSnap = await getDocs(query(collection(db, 'expenses'), where('groupId', 'in', activeGroupIds)));
        const buckets = computeNetSavingsBuckets(expSnap.docs.map((d) => d.data() as any), cursor, groupCurrencyByGroupId);
        const { convertedMajor } = convertBucketsToCurrency(buckets, cashSavingsCurrency, catchUpRates);
        const netMinor = Math.round(convertedMajor * 100);
        const posted = await postMonthToCashSavings(cursor, netMinor);
        if (posted && netMinor > 0) { caughtUpMinor += netMinor; caughtUpMonths += 1; }
      }
      if (!cancelled && caughtUpMonths > 0) setCatchUpResult({ months: caughtUpMonths, totalMinor: caughtUpMinor });
    })().catch((err) => console.error('Cash Savings catch-up failed:', err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, activeGroupIds.join(',')]);

  // Undo — reverses exactly what handlePostMonth credited, driven off the closed month's own
  // `allocations` map (not in-memory state from the click that posted it), so this works even
  // after a refresh or in a later session, for as long as `alreadyPosted` stays true (i.e. any
  // time before the month rolls over — this screen only ever looks at THIS month's doc). Each
  // affected goal's balance is decremented and gets its own 'undo' ledger entry — the original
  // 'auto' entry is never touched or deleted (ledger stays a true, honest history of what
  // happened AND that it was reversed) — then the userGoalMonths guard doc is deleted, which is
  // what actually re-opens the month for posting again.
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const handleUndoPost = async () => {
    if (!user || !alreadyPosted || undoing) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const monthRef = doc(db, 'userGoalMonths', monthDocId);
      const monthSnap = await getDoc(monthRef);
      if (!monthSnap.exists()) { setShowUndoConfirm(false); return; } // already undone elsewhere
      const monthData = monthSnap.data() as any;
      const rawAllocations: Record<string, string | number> = monthData.allocations || {};
      const closedMonthPrefix = (monthData.closedAt || '').slice(0, 7);
      const goalIds = Object.keys(rawAllocations);

      await runTransaction(db, async (transaction) => {
        // Re-check the guard doc INSIDE the transaction so a concurrent double-tap (or a tab
        // that already undid this) is a safe no-op, not a double-reversal.
        const freshMonthSnap = await transaction.get(monthRef);
        if (!freshMonthSnap.exists()) return;
        const goalRefs = goalIds.map((id) => doc(db, 'goals', id));
        const goalSnaps = await Promise.all(goalRefs.map((ref) => transaction.get(ref)));

        const nowIso = new Date().toISOString();
        await Promise.all(goalSnaps.map(async (snap, i) => {
          if (!snap.exists()) return; // goal since deleted — nothing to reverse it on
          const goalId = goalIds[i];
          const contributedMinor = await decryptAmount('goal', goalId, rawAllocations[goalId]);
          if (!contributedMinor) return;
          const data = snap.data()!;
          const current = await decryptAmount('goal', goalId, data.currentAmountMinor);
          const reverted = Math.max(0, current - contributedMinor);
          // Only un-complete a goal if it's STILL completed and was completed in the same month
          // this posting closed — a reasonable, non-invasive signal that THIS posting is what
          // completed it, without needing to separately track "completed by which posting."
          const wasCompletedByThisPosting = data.status === 'completed' && typeof data.completedAt === 'string' && data.completedAt.slice(0, 7) === closedMonthPrefix;
          const [encryptedReverted, encryptedUndoAmount] = await Promise.all([
            encryptAmount('goal', goalId, reverted),
            encryptAmount('goal', goalId, -contributedMinor),
          ]);
          transaction.update(goalRefs[i], {
            currentAmountMinor: encryptedReverted,
            updatedAt: nowIso,
            ...(wasCompletedByThisPosting ? { status: 'active', completedAt: null } : {}),
          });
          const undoLedgerRef = doc(collection(db, 'goals', goalId, 'ledger'));
          transaction.set(undoLedgerRef, {
            type: 'undo',
            amountMinor: encryptedUndoAmount,
            monthKey: thisMonthKey,
            note: null,
            createdBy: user.uid,
            createdByName: actorName,
            createdAt: nowIso,
          });
        }));

        transaction.delete(monthRef);
      });

      setShowUndoConfirm(false);
      setPostResult(null);
    } catch (err) {
      console.error('Failed to undo this month\'s posting:', err);
      setUndoError(t('goals.undoFailed'));
    } finally {
      setUndoing(false);
    }
  };

  const renderGoalCard = (g: Goal, sharedBadge: boolean) => {
    const sym = getCurrencySymbol(g.currency || defaultCurrency);
    // No target, no progress bar, no projection — it's a running balance, not something being
    // worked toward. Tinted distinctly so it doesn't read as "just another goal" in the list.
    if (g.isCashHolding) {
      return (
        <button
          key={g.id}
          type="button"
          onClick={() => navigate(`/goals/${g.id}`)}
          className="w-full text-left bg-primary/5 rounded-2xl border border-primary/20 shadow-sm p-4 flex items-center gap-3"
        >
          <span className="text-2xl shrink-0">{g.icon || '🏦'}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-on-surface truncate">{g.name}</p>
            <p className="text-[10px] text-text-muted">{t('goals.cashHoldingSubtitle')}</p>
          </div>
          <span className="text-sm font-black text-primary shrink-0">
            {sym}{fromMinorUnits(g.currentAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </button>
      );
    }
    const pct = goalProgressPct(g);
    const projected = g.status === 'completed' ? null : goalHorizonDate(g, ledgersByGoal.get(g.id) || [], ownAccounts);
    return (
      <button
        key={g.id}
        type="button"
        onClick={() => navigate(`/goals/${g.id}`)}
        className="w-full text-left bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-2xl shrink-0">{g.icon || '🎯'}</span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-on-surface truncate flex items-center gap-1">
                {g.name}
                {sharedBadge && <span className="material-symbols-outlined text-[13px] text-text-muted" title={t('goals.sharedWithYou')}>group</span>}
              </p>
              <p className="text-[10px] text-text-muted">
                {g.status === 'completed' ? t('goals.statusCompleted') : g.status === 'paused' ? t('goals.statusPaused') : t('goals.statusActive')}
              </p>
            </div>
          </div>
          <span className="text-xs font-black text-primary shrink-0">{Math.round(pct)}%</span>
        </div>
        <div className="h-2.5 w-full bg-surface-container rounded-full overflow-hidden">
          <div className={clsx('h-full rounded-full', g.status === 'completed' ? 'bg-success' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-text-muted">
            {sym}{fromMinorUnits(goalTotalMinor(g)).toLocaleString(undefined, { maximumFractionDigits: 0 })} / {sym}{fromMinorUnits(g.targetAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <span className="text-text-muted font-bold">
            {g.status === 'completed' ? t('goals.metOn', { date: g.completedAt?.slice(0, 10) || '' }) : projected ? t('goals.projectedMet', { date: projected }) : t('goals.projectionUnavailable')}
          </span>
        </div>
        {g.accountAllocatedMinor > 0 && (
          <p className="text-[10px] text-text-muted flex items-center gap-2">
            <span className="flex items-center gap-0.5"><span className="material-symbols-outlined text-[11px]">account_balance</span>{sym}{fromMinorUnits(g.accountAllocatedMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span className="flex items-center gap-0.5"><span className="material-symbols-outlined text-[11px]">calendar_month</span>{sym}{fromMinorUnits(g.currentAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </p>
        )}
      </button>
    );
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-5 pb-24">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-primary">{t('goals.hubTitle')}</h1>
          <p className="text-xs text-text-muted">{t('goals.hubSubtitle')}</p>
        </div>
        {goalsTab === 'goals' && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button type="button" onClick={() => navigate('/goals/reports')} className="w-10 h-10 rounded-xl border border-border-subtle text-primary flex items-center justify-center hover:bg-surface-container">
              <span className="material-symbols-outlined text-[20px]">insights</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/goals/new')}
              className="bg-primary text-white px-4 py-2 rounded-xl font-bold flex items-center gap-1.5 shadow-md active:scale-95 transition-all text-sm"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              {t('goals.newGoal')}
            </button>
          </div>
        )}
      </div>

      <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
        {([
          { key: 'goals', label: t('goals.hubTitle') },
          { key: 'accounts', label: t('accounts.title') },
          { key: 'allocation', label: t('goals.manageAllocation') },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setGoalsTab(tab.key)}
            className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', goalsTab === tab.key ? 'bg-primary text-white' : 'text-text-muted')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {goalsTab === 'accounts' && (
        <>
          <button
            type="button" onClick={() => setShowAccountsHelp(true)}
            className="flex items-center gap-1.5 text-[11px] font-bold text-primary px-1"
          >
            <span className="material-symbols-outlined text-[15px]">help</span>
            {t('goals.accountsHelpTitle')}
          </button>
          <AccountsHub embedded />
        </>
      )}
      {goalsTab === 'allocation' && <GoalAllocationManager embedded />}

      {goalsTab === 'goals' && (
      <>
      {/* Net savings + post-month card */}
      <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.netSavingsThisMonth')}</p>
          <span className="text-[10px] font-bold text-text-muted">{thisMonthKey}</span>
        </div>
        <p className={clsx('text-2xl font-black', netSavingsThisMonthMinor >= 0 ? 'text-success' : 'text-error')}>
          {getCurrencySymbol(displayCurrency)}{fromMinorUnits(netSavingsThisMonthMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </p>
        <p className="text-[10px] text-text-muted">{t('goals.aggregatedAcrossGroups', { count: activeGroupIds.length })}</p>
        {displayConversion.unconvertedCurrencies.length > 0 && (
          <p className="text-[10px] text-warning font-bold">
            {t('goals.currenciesExcluded', { currencies: displayConversion.unconvertedCurrencies.join(', ') })}
          </p>
        )}

        {netSavingsThisMonthMinor <= 0 ? (
          <p className="text-xs text-text-muted">{t('goals.deficitMonthNote')}</p>
        ) : alreadyPosted ? (
          <div className="space-y-2">
            <p className="text-xs font-bold text-success flex items-center gap-1">
              <span className="material-symbols-outlined text-[15px]">check_circle</span>
              {t('goals.alreadyPostedThisMonth')}
            </p>
            <button type="button" onClick={() => setShowUndoConfirm(true)} className="w-full py-2 rounded-xl border border-border-subtle text-text-muted font-bold text-xs">
              {t('goals.undoPosting')}
            </button>
          </div>
        ) : (
          <>
            {/* Posting is always available once there's positive net savings, even with zero
                percentage-goals set up — everything just flows to Cash Savings in that case. */}
            {activeGoals.length === 0 && <p className="text-[11px] text-text-muted">{t('goals.noActiveGoalsGoesToCash')}</p>}
            <button type="button" onClick={handlePostMonth} disabled={posting} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {posting ? t('goals.posting') : t('goals.postThisMonth')}
            </button>
          </>
        )}
        {postError && <p className="text-xs text-error font-bold">{postError}</p>}
      </div>

      {postResult && (
        <div className="bg-success/10 border border-success/30 rounded-2xl p-4 space-y-2">
          <p className="text-sm font-bold text-success flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            {t('goals.postedToCashSavings', { amount: `${getCurrencySymbol(cashSavingsCurrency)}${fromMinorUnits(postResult.cashHoldingCreditMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}
          </p>
          <button type="button" onClick={() => setPostResult(null)} className="text-[11px] font-bold text-text-muted">{t('common.close')}</button>
        </div>
      )}

      {catchUpResult && (
        <div className="bg-primary/5 border border-primary/10 rounded-2xl p-4 space-y-2">
          <p className="text-sm font-bold text-primary flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[18px]">history</span>
            {t('goals.caughtUpMonths', {
              count: catchUpResult.months,
              amount: `${getCurrencySymbol(cashSavingsCurrency)}${fromMinorUnits(catchUpResult.totalMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
            })}
          </p>
          <button type="button" onClick={() => setCatchUpResult(null)} className="text-[11px] font-bold text-text-muted">{t('common.close')}</button>
        </div>
      )}

      {visibleOwnGoals.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-8 text-center space-y-3">
          <span className="text-4xl block">🎯</span>
          <p className="text-sm font-bold text-on-surface">{t('goals.emptyStateTitle')}</p>
          <p className="text-xs text-text-muted">{t('goals.emptyStateDesc')}</p>
          <button type="button" onClick={() => navigate('/goals/new')} className="mt-2 px-5 py-2.5 bg-primary text-white font-bold rounded-xl text-sm">
            {t('goals.createFirstGoal')}
          </button>
        </div>
      ) : (
        <div className="space-y-3">{visibleOwnGoals.map((g) => renderGoalCard(g, false))}</div>
      )}

      {sharedWithMeGoals.length > 0 && (
        <div className="space-y-2 pt-2">
          <h2 className="text-sm font-bold text-primary px-1 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px]">group</span>
            {t('goals.sharedWithMe')}
          </h2>
          <div className="space-y-3">{sharedWithMeGoals.map((g) => renderGoalCard(g, true))}</div>
        </div>
      )}

      {archivedGoals.length > 0 && (
        <div className="pt-2">
          <button type="button" onClick={() => setArchivedCollapsed((c) => !c)} className="w-full flex items-center justify-between mb-2">
            <h2 className="text-sm font-black text-text-muted uppercase tracking-wider flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">archive</span>
              {t('goals.archivedGoals')} ({archivedGoals.length})
            </h2>
            <span className={clsx('material-symbols-outlined text-text-muted transition-transform', archivedCollapsed && '-rotate-90')}>expand_more</span>
          </button>
          {!archivedCollapsed && (
            <div className="space-y-2">
              {archivedGoals.map((g) => <ArchivedGoalRow key={g.id} goal={g} />)}
            </div>
          )}
        </div>
      )}
      </>
      )}

      {/* --- "What is Accounts for?" explainer --- */}
      {showAccountsHelp && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowAccountsHelp(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-2xl">account_balance</span>
              <h3 className="text-base font-black text-primary">{t('goals.accountsHelpTitle')}</h3>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.accountsHelpWhatTitle')}</p>
              <p className="text-sm text-on-surface leading-relaxed">{t('goals.accountsHelpWhatBody')}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.accountsHelpBenefitTitle')}</p>
              <p className="text-sm text-on-surface leading-relaxed">{t('goals.accountsHelpBenefitBody')}</p>
            </div>
            <button onClick={() => setShowAccountsHelp(false)} className="w-full py-3 bg-primary text-white font-bold rounded-xl">
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {/* --- Undo This Month's Posting confirmation --- */}
      {showUndoConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => !undoing && setShowUndoConfirm(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 text-center max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-warning text-4xl">undo</span>
            <p className="text-sm text-on-surface">{t('goals.undoConfirmExplainer', { monthKey: thisMonthKey })}</p>
            {undoError && <p className="text-xs text-error font-bold">{undoError}</p>}
            <button onClick={handleUndoPost} disabled={undoing} className="w-full py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
              {undoing ? t('goals.undoing') : t('goals.confirmUndo')}
            </button>
            <button onClick={() => setShowUndoConfirm(false)} disabled={undoing} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Deliberately lighter than renderGoalCard's normal tiles — an archived goal is tucked away in a
// collapsed section most people rarely open, matching Dashboard's ArchivedGroupRow treatment for
// groups: icon, name, a one-line status, and a Resume action, not the full progress-bar card.
function ArchivedGoalRow({ goal }: { goal: Goal } & any) {
  const { t } = useLanguage();
  const [resuming, setResuming] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleResume = async () => {
    setResuming(true);
    try {
      await updateDoc(doc(db, 'goals', goal.id), { status: 'active', updatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('Failed to resume goal:', err);
      setResuming(false);
    }
  };
  // Safe to hard-delete here (unlike GoalDetail.tsx's own Discontinue flow, which always archives
  // a goal with any ledger history instead) because by the time a goal is Archived, both buckets
  // have already been swept/cleared — bucket #1 back to Cash Savings, bucket #2 freed on every
  // account that was allocating to it — by archiveGoalWithSweep(). The clearGoalFromAllAccounts
  // call below is purely defensive (in case any account still references this goalId), never
  // expected to find real money.
  const { user, profile } = useAuth();
  const handleDeletePermanently = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const actorName = profile?.displayName || user?.displayName || 'Someone';
      await clearGoalFromAllAccounts(goal.id, actorName);
      const ledgerSnap = await getDocs(collection(db, 'goals', goal.id, 'ledger'));
      const batch = writeBatch(db);
      ledgerSnap.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(doc(db, 'goals', goal.id));
      await batch.commit();
    } catch (err) {
      console.error('Failed to permanently delete goal:', err);
      setDeleteError(t('goals.saveFailed'));
      setDeleting(false);
    }
  };
  const sym = getCurrencySymbol(goal.currency);
  return (
    <div className="flex items-center gap-3 bg-white rounded-xl border border-border-subtle p-3 opacity-80">
      <span className="text-lg shrink-0">{goal.icon || '🎯'}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-on-surface truncate">{goal.name}</p>
        <p className="text-[10px] text-text-muted">
          {goal.completedAt ? t('goals.statusCompleted') : t('goals.statusArchived')}
          {goal.targetAmountMinor > 0 && ` · ${sym}${fromMinorUnits(goal.targetAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
        </p>
      </div>
      <button type="button" onClick={handleResume} disabled={resuming} className="text-[11px] font-bold text-primary shrink-0 disabled:opacity-50">
        {resuming ? t('goals.saving') : t('goals.resumeGoal')}
      </button>
      <button
        type="button" onClick={() => { setDeleteError(null); setShowDeleteConfirm(true); }}
        className="p-1 text-text-muted hover:text-error shrink-0" aria-label={t('goals.deletePermanently')}
      >
        <span className="material-symbols-outlined text-[16px] block">delete</span>
      </button>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 text-center" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-error text-4xl">warning</span>
            <p className="text-sm text-on-surface">{t('goals.confirmDeleteGoal', { name: goal.name })}</p>
            {deleteError && <p className="text-xs text-error font-bold">{deleteError}</p>}
            <button onClick={handleDeletePermanently} disabled={deleting} className="w-full py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
              {deleting ? t('goals.saving') : t('goals.deletePermanently')}
            </button>
            <button onClick={() => setShowDeleteConfirm(false)} disabled={deleting} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
