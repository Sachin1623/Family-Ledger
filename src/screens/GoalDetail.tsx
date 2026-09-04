import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, runTransaction } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import {
  Goal,
  GoalLedgerEntry,
  toMinorUnits,
  fromMinorUnits,
  goalProgressPct,
  goalTotalMinor,
  goalHorizonDate,
  decryptGoalAmounts,
  decryptGoalsList,
  decryptLedgerEntries,
  distributeByPercentage,
  cashHoldingGoalId,
} from '../lib/goals';
import { encryptAmount, decryptAmount } from '../lib/fieldCrypto';
import { clearGoalFromAllAccounts, applyAccountChange, notifyGoalsMet } from '../lib/accountAllocations';
import { FinancialAccount, decryptAccountsList } from '../lib/accounts';
import ImageAttachments from '../components/ImageAttachments';

type Modal = null | 'boost' | 'transfer' | 'transferAccount' | 'merge' | 'delete' | 'complete' | 'reset' | 'resetCash';

const LEDGER_LABELS: Record<string, string> = {
  auto: 'goals.ledgerAuto',
  boost: 'goals.ledgerBoost',
  withdrawal: 'goals.ledgerWithdrawal',
  merge_in: 'goals.ledgerMergeIn',
  merge_out: 'goals.ledgerMergeOut',
  reconciliation: 'goals.ledgerReconciliation',
  undo: 'goals.ledgerUndo',
  completed: 'goals.ledgerCompleted',
  account_alloc: 'goals.ledgerAccountAlloc',
  account_dealloc: 'goals.ledgerAccountDealloc',
  reset: 'goals.ledgerReset',
};

const LEDGER_ICONS: Record<string, string> = {
  auto: 'savings',
  boost: 'add_circle',
  withdrawal: 'remove_circle',
  undo: 'undo',
  merge_in: 'call_merge',
  merge_out: 'call_split',
  reconciliation: 'sync_alt',
  completed: 'check_circle',
  account_alloc: 'account_balance',
  account_dealloc: 'account_balance',
  reset: 'restart_alt',
};

export default function GoalDetail() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { goalId } = useParams<{ goalId: string }>();

  const [goalDoc] = useDocument(goalId ? doc(db, 'goals', goalId) : null);
  const [goal, setGoal] = useState<Goal | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!goalDoc?.exists()) { setGoal(null); return; }
    decryptGoalAmounts({ id: goalDoc.id, ...(goalDoc.data() as any) })
      .then((decrypted) => { if (!cancelled) setGoal(decrypted); })
      .catch((err) => console.error('Failed to decrypt goal:', err));
    return () => { cancelled = true; };
  }, [goalDoc]);
  const isOwner = !!user && !!goal && goal.userId === user.uid;
  const currencySymbol = getCurrencySymbol(goal?.currency);

  const [ledgerValue] = useCollection(goal ? collection(db, 'goals', goal.id, 'ledger') : null);
  const [ledger, setLedger] = useState<GoalLedgerEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!goal) { setLedger([]); return; }
    const raw = ledgerValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptLedgerEntries(goal.id, raw)
      .then((decrypted) => {
        if (cancelled) return;
        setLedger([...decrypted].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
      })
      .catch((err) => console.error('Failed to decrypt ledger:', err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerValue, goal?.id]);

  // Merge/Transfer destinations: only the OWNER'S other goals — moving a balance between one
  // person's own goals, never across owners (a shared viewer never sees these actions at all).
  const [otherGoalsValue] = useCollection(goal && isOwner ? query(collection(db, 'goals'), where('userId', '==', goal.userId)) : null);
  const [otherActiveGoals, setOtherActiveGoals] = useState<Goal[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = (otherGoalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []).filter((g: any) => g.id !== goalId && g.status === 'active');
    decryptGoalsList(raw).then((decrypted) => { if (!cancelled) setOtherActiveGoals(decrypted); })
      .catch((err) => console.error('Failed to decrypt other goals:', err));
    return () => { cancelled = true; };
  }, [otherGoalsValue, goalId]);

  // Just the ID — a regular goal no longer needs Cash Savings' live balance for anything (Pull
  // was removed; funding only ever comes from accounts now), only its ID, to tell whether a
  // merge_in ledger entry came from there (see fromCashSavingsMinor below).
  const cashHoldingIdForOwner = goal && isOwner && !goal.isCashHolding ? cashHoldingGoalId(goal.userId) : null;

  // Which accounts currently allocate to this goal, and how much of each — see lib/accounts.ts's
  // allocatedGoalIds (kept in sync with goalAllocations purely to make this query possible).
  const [linkedAccountsValue] = useCollection(
    goal && isOwner && !goal.isCashHolding ? query(collection(db, 'financialAccounts'), where('allocatedGoalIds', 'array-contains', goal.id)) : null,
  );
  // Full decrypted accounts (not just the display-ready summary below) — goalHorizonDate needs
  // each linked account's interest rate/compounding and SIP schedule, not just its current % share.
  const [linkedFullAccounts, setLinkedFullAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!goal) { setLinkedFullAccounts([]); return; }
    const raws = linkedAccountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raws).then((decrypted) => { if (!cancelled) setLinkedFullAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt linked accounts:', err));
    return () => { cancelled = true; };
  }, [linkedAccountsValue, goal?.id]);
  const linkedAccounts = useMemo(
    () =>
      goal
        ? linkedFullAccounts.map((a) => {
            const entry = (a.goalAllocations || []).find((g) => g.goalId === goal.id);
            const pct = entry?.pct || 0;
            const contributedMinor = entry?.reservedAmountMinor != null ? entry.reservedAmountMinor : Math.round((a.currentBalanceMinor * pct) / 100);
            return { id: a.id, name: a.name, currency: a.currency, pct, contributedMinor, reserved: entry?.reservedAmountMinor != null };
          })
        : [],
    [linkedFullAccounts, goal?.id],
  );

  // Every one of the owner's accounts, for the "Transfer to Account" destination picker on Cash
  // Savings' own page — see handleTransferToAccount below.
  const [accountsForTransferValue] = useCollection(
    goal && isOwner && goal.isCashHolding ? query(collection(db, 'financialAccounts'), where('userId', '==', goal.userId)) : null,
  );
  const [accountsForTransfer, setAccountsForTransfer] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raws = accountsForTransferValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raws).then((decrypted) => { if (!cancelled) setAccountsForTransfer(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [accountsForTransferValue]);

  // Bucket #1's own sub-breakdown, purely for display — derived live from this goal's own
  // ledger rather than a separate stored field. 'auto' + 'undo' nets out any undone posting;
  // 'merge_in' only counts here when it actually came FROM Cash Savings (a merge_in from another
  // regular goal is a peer-to-peer transfer, not "monthly income," so it's excluded).
  const monthlyPostingMinor = useMemo(
    () => ledger.filter((e) => e.type === 'auto' || e.type === 'undo').reduce((s, e) => s + e.amountMinor, 0),
    [ledger],
  );
  const fromCashSavingsMinor = useMemo(
    () => ledger.filter((e) => e.type === 'merge_in' && cashHoldingIdForOwner && e.relatedGoalId === cashHoldingIdForOwner).reduce((s, e) => s + e.amountMinor, 0),
    [ledger, cashHoldingIdForOwner],
  );

  const projected = goal && goal.status !== 'completed' ? goalHorizonDate(goal, ledger, linkedFullAccounts) : null;

  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [transferAccountId, setTransferAccountId] = useState('');
  const [transferProofImages, setTransferProofImages] = useState<string[]>([]);

  const openModal = (m: Modal) => {
    setModal(m);
    setAmountInput('');
    setNoteInput('');
    setFormError(null);
    setTransferProofImages([]);
    if (m === 'transferAccount') setTransferAccountId(accountsForTransfer[0]?.id || '');
  };

  // Return to Cash Savings (viewing a regular goal — funding only ever flows the other way now,
  // via a linked account's % allocation, never from Cash Savings into a goal) — the only place
  // money is ever allowed to move OUT of a regular goal's bucket #1 back to Cash Savings.
  // Cash Savings itself no longer funds a goal directly at all (see goals.ts's header comment) —
  // its own page instead offers Transfer to Account (handleTransferToAccount below) and Reset.
  const transferAmountMinor = toMinorUnits(parseFloat(amountInput || '0'));
  const handleCashTransfer = async () => {
    if (!user || !goal || !isOwner || goal.isCashHolding) return;
    const cashHoldingId = cashHoldingGoalId(goal.userId);
    const sourceId = goal.id;
    const destId = cashHoldingId;
    if (!Number.isFinite(transferAmountMinor) || transferAmountMinor <= 0) { setFormError(t('goals.enterValidAmount')); return; }
    setBusy(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();

      // Two-phase-write bootstrap for the case where Cash Savings doesn't exist yet (e.g. a
      // brand-new user's very first Return to Cash Savings) — same reasoning as everywhere else
      // this pattern shows up: the crypto/key endpoint authorizes a 'goal' scope by reading the
      // doc, which needs to exist first.
      const existingCashDoc = await getDoc(doc(db, 'goals', cashHoldingId));
      if (!existingCashDoc.exists()) {
        const bootstrapIso = new Date().toISOString();
        await setDoc(doc(db, 'goals', cashHoldingId), {
          userId: goal.userId, name: t('goals.cashHoldingName'), targetAmountMinor: 0, currentAmountMinor: 0, accountAllocatedMinor: 0,
          status: 'active', targetDate: null, notes: null, icon: '🏦', imageUrl: null,
          currency: goal.currency, groupId: null, friendUids: [], isCashHolding: true,
          createdBy: user.uid, createdByName: actorName, createdAt: bootstrapIso, updatedAt: bootstrapIso, completedAt: null,
        });
      }

      await runTransaction(db, async (transaction) => {
        const sourceRef = doc(db, 'goals', sourceId);
        const destRef = doc(db, 'goals', destId);
        const [sourceSnap, destSnap] = await Promise.all([transaction.get(sourceRef), transaction.get(destRef)]);
        if (!sourceSnap.exists() || !destSnap.exists()) throw new Error('Account not found');
        const sourceCurrent = await decryptAmount('goal', sourceId, sourceSnap.data()!.currentAmountMinor);
        if (transferAmountMinor > sourceCurrent) throw new Error('insufficient-balance');
        const destCurrent = await decryptAmount('goal', destId, destSnap.data()!.currentAmountMinor);
        const [encSourceNew, encDestNew, encSourceLedger, encDestLedger] = await Promise.all([
          encryptAmount('goal', sourceId, sourceCurrent - transferAmountMinor),
          encryptAmount('goal', destId, destCurrent + transferAmountMinor),
          encryptAmount('goal', sourceId, -transferAmountMinor),
          encryptAmount('goal', destId, transferAmountMinor),
        ]);
        transaction.update(sourceRef, { currentAmountMinor: encSourceNew, updatedAt: nowIso });
        transaction.update(destRef, { currentAmountMinor: encDestNew, updatedAt: nowIso });
        const sourceLedgerRef = doc(collection(db, 'goals', sourceId, 'ledger'));
        transaction.set(sourceLedgerRef, {
          type: 'merge_out', amountMinor: encSourceLedger, monthKey: null, note: t('goals.mergedIntoNote', { names: t('goals.cashHoldingName') }),
          createdBy: user.uid, createdByName: actorName, createdAt: nowIso, relatedGoalId: destId,
        });
        const destLedgerRef = doc(collection(db, 'goals', destId, 'ledger'));
        transaction.set(destLedgerRef, {
          type: 'merge_in', amountMinor: encDestLedger, monthKey: null, note: t('goals.mergedFromNote', { name: goal.name }),
          createdBy: user.uid, createdByName: actorName, createdAt: nowIso, relatedGoalId: sourceId,
        });
      });
      setModal(null);
    } catch (err) {
      console.error('Failed to transfer:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleBoost = async () => {
    if (!user || !goal) return;
    const amountMinor = toMinorUnits(parseFloat(amountInput || '0'));
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setFormError(t('goals.enterValidAmount')); return; }
    setBusy(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      await runTransaction(db, async (transaction) => {
        const goalRef = doc(db, 'goals', goal.id);
        const snap = await transaction.get(goalRef);
        if (!snap.exists()) return;
        const [current, target] = await Promise.all([
          decryptAmount('goal', goal.id, snap.data().currentAmountMinor),
          decryptAmount('goal', goal.id, snap.data().targetAmountMinor),
        ]);
        // A shared (non-owner) viewer's Firestore write is restricted to ONLY
        // currentAmountMinor + updatedAt (see firestore.rules) — auto-completing the goal is left
        // to the owner's own next write, rather than trying to also flip status/completedAt here.
        const willComplete = isOwner && current + amountMinor >= target;
        const [encryptedCurrent, encryptedLedgerAmount] = await Promise.all([
          encryptAmount('goal', goal.id, current + amountMinor),
          encryptAmount('goal', goal.id, amountMinor),
        ]);
        transaction.update(goalRef, {
          currentAmountMinor: encryptedCurrent,
          updatedAt: nowIso,
          ...(willComplete ? { status: 'completed', completedAt: nowIso } : {}),
        });
        const ledgerRef = doc(collection(db, 'goals', goal.id, 'ledger'));
        transaction.set(ledgerRef, {
          type: 'boost', amountMinor: encryptedLedgerAmount, monthKey: null, note: noteInput.trim() || null,
          createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
        });
      });
      setModal(null);
    } catch (err) {
      console.error('Failed to post boost:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Withdraw (an untracked "money just left") was removed as an action — every way money leaves a
  // goal now goes somewhere trackable: Return to Cash Savings, Transfer to Other Goal(s), or
  // Goal Completed (posted as a real expense). Old 'withdrawal' ledger entries from before this
  // change still render fine in Contribution History (LEDGER_LABELS/LEDGER_ICONS keep the type),
  // this just stops creating new ones.

  // --- Merge & Redistribution (folded into Goal Detail per the spec's own leanest-MVP note) ---
  const [mergeShares, setMergeShares] = useState<Record<string, number>>({});
  const mergeTotal: number = Object.keys(mergeShares).reduce((s: number, key: string) => s + (mergeShares[key] || 0), 0);

  const handleMerge = async () => {
    if (!user || !goal) return;
    const selected = Object.entries(mergeShares).filter(([, pct]: [string, number]) => pct > 0);
    if (selected.length === 0) { setFormError(t('goals.selectMergeDestination')); return; }
    if (mergeTotal !== 100) { setFormError(t('goals.mergeMustTotal100')); return; }
    setBusy(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      const requestId = `merge_${goal.id}_${Date.now()}`;
      await runTransaction(db, async (transaction) => {
        const sourceRef = doc(db, 'goals', goal.id);
        const sourceSnap = await transaction.get(sourceRef);
        if (!sourceSnap.exists()) return;
        const balance = await decryptAmount('goal', goal.id, sourceSnap.data().currentAmountMinor);
        if (balance <= 0) {
          transaction.update(sourceRef, { status: 'archived', updatedAt: nowIso });
          return;
        }
        const shares = selected.map(([id, pct]: [string, number]) => ({ id, pct, createdAt: nowIso }));
        const split = distributeByPercentage(balance, shares);

        for (const [destId, amountMinor] of Object.entries(split)) {
          if (amountMinor <= 0) continue;
          const destRef = doc(db, 'goals', destId);
          const destSnap = await transaction.get(destRef);
          if (!destSnap.exists()) continue;
          const destCurrent = await decryptAmount('goal', destId, destSnap.data().currentAmountMinor);
          const [encryptedDestCurrent, encryptedDestLedgerAmount] = await Promise.all([
            encryptAmount('goal', destId, destCurrent + amountMinor),
            encryptAmount('goal', destId, amountMinor),
          ]);
          transaction.update(destRef, { currentAmountMinor: encryptedDestCurrent, updatedAt: nowIso });
          const destLedgerRef = doc(collection(db, 'goals', destId, 'ledger'));
          transaction.set(destLedgerRef, {
            type: 'merge_in', amountMinor: encryptedDestLedgerAmount, monthKey: null, note: t('goals.mergedFromNote', { name: goal.name }),
            createdBy: user.uid, createdByName: actorName, createdAt: nowIso, relatedGoalId: goal.id,
          });
        }

        const [encryptedZero, encryptedSourceLedgerAmount] = await Promise.all([
          encryptAmount('goal', goal.id, 0),
          encryptAmount('goal', goal.id, -balance),
        ]);
        transaction.update(sourceRef, { currentAmountMinor: encryptedZero, status: 'archived', updatedAt: nowIso });
        const sourceLedgerRef = doc(collection(db, 'goals', goal.id, 'ledger'));
        transaction.set(sourceLedgerRef, {
          type: 'merge_out', amountMinor: encryptedSourceLedgerAmount, monthKey: null,
          note: `${requestId} · ${t('goals.mergedIntoNote', { names: selected.map(([id]) => otherActiveGoals.find((g) => g.id === id)?.name || id).join(', ') })}`,
          createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
        });
      });
      setModal(null);
      setMergeShares({});
    } catch (err) {
      console.error('Failed to merge goal:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePause = async () => {
    if (!goal) return;
    try {
      await updateDoc(doc(db, 'goals', goal.id), {
        status: goal.status === 'paused' ? 'active' : 'paused',
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to toggle pause:', err);
    }
  };

  // Shared by both Discontinue paths below — a pure status flip, same as Mark Completed. Neither
  // bucket is touched: no sweep to Cash Savings, no account deallocation. The goal just closes
  // exactly as it stands; if the user wants the money out first, that's Return to Cash Savings /
  // Transfer to Other Goal(s) / Reset Allocation, done explicitly before discontinuing.
  const archiveGoal = async (g: Goal) => {
    const nowIso = new Date().toISOString();
    await updateDoc(doc(db, 'goals', g.id), { status: 'archived', updatedAt: nowIso });
  };

  const handleArchive = async () => {
    if (!goal || !user) return;
    setBusy(true);
    try {
      await archiveGoal(goal);
      navigate('/goals');
    } catch (err) {
      console.error('Failed to archive goal:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!goal || !user) return;
    setBusy(true);
    try {
      // Spec: goals with real ledger history must be archived, never hard-deleted — only a goal
      // with zero posted activity is actually eligible for a real delete. (A goal with zero ledger
      // entries can never have a nonzero balance either — every path that credits one also writes
      // a ledger entry — so there's nothing to sweep on this branch.)
      const ledgerSnap = await getDocs(collection(db, 'goals', goal.id, 'ledger'));
      if (ledgerSnap.size > 0) {
        await archiveGoal(goal);
      } else {
        const { deleteDoc } = await import('firebase/firestore');
        await deleteDoc(doc(db, 'goals', goal.id));
      }
      navigate('/goals');
    } catch (err) {
      console.error('Failed to delete goal:', err);
    } finally {
      setBusy(false);
    }
  };

  // "Mark Completed" — a pure status flip, nothing else. Goals can never post to expenses/income
  // (see accountAllocations.ts's own header comment for why), so unlike its old design this does
  // NOT touch either balance bucket — both stay exactly as they are, still fully visible, exactly
  // like a goal that naturally reached its target (same status/completedAt this app already sets
  // automatically elsewhere). If the user wants the money out first, that's a separate, explicit
  // choice: Return to Cash Savings / Transfer to Other Goal(s) for bucket #1, or editing the
  // source account (or Reset Allocation) for bucket #2. Marking Completed just means "I'm done
  // tracking this," not "I spent it."
  const handleCompleteGoal = async () => {
    if (!user || !goal || !isOwner || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      const encryptedZero = await encryptAmount('goal', goal.id, 0);
      await runTransaction(db, async (transaction) => {
        const goalRef = doc(db, 'goals', goal.id);
        const snap = await transaction.get(goalRef);
        if (!snap.exists()) return;
        transaction.update(goalRef, { status: 'completed', completedAt: nowIso, updatedAt: nowIso });
        const ledgerRef = doc(collection(db, 'goals', goal.id, 'ledger'));
        transaction.set(ledgerRef, {
          type: 'completed', amountMinor: encryptedZero, monthKey: null,
          note: t('goals.completedLedgerNote'), createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
        });
      });
      setModal(null);
      navigate('/goals');
    } catch (err) {
      console.error('Failed to complete goal:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // "Reset Allocation" (bucket #2 only) — frees this goal's % back on every account currently
  // allocating to it, zeroing accountAllocatedMinor as a result. Bucket #1 already has its own
  // reset-equivalent (Return to Cash Savings), so this only ever touches the account bucket.
  const handleResetAllocation = async () => {
    if (!user || !goal || !isOwner || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      await clearGoalFromAllAccounts(goal.id, actorName);
      setModal(null);
    } catch (err) {
      console.error('Failed to reset allocation:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Transfer to Account — the ONLY sanctioned way money leaves Cash Savings toward a goal now: a
  // plain balance transfer into a real FinancialAccount (confirmed design — not combined with
  // picking goal allocations in the same step; that's a separate, deliberate edit afterward, same
  // as any other account balance increase). Decrements Cash Savings directly (not through
  // applyAccountChange, which only ever concerns itself with FinancialAccounts) and credits the
  // account through applyAccountChange so its existing allocations correctly see the larger
  // balance — same mechanism as AccountsHub's own Transfer Funds.
  const handleTransferToAccount = async () => {
    if (!user || !goal || !isOwner || !goal.isCashHolding || busy) return;
    const account = accountsForTransfer.find((a) => a.id === transferAccountId);
    if (!account) { setFormError(t('goals.selectMergeDestination')); return; }
    if (!Number.isFinite(transferAmountMinor) || transferAmountMinor <= 0) { setFormError(t('goals.enterValidAmount')); return; }
    if (transferAmountMinor > goal.currentAmountMinor) { setFormError(t('goals.enterValidAmount')); return; }
    setBusy(true);
    setFormError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      await runTransaction(db, async (transaction) => {
        const goalRef = doc(db, 'goals', goal.id);
        const snap = await transaction.get(goalRef);
        if (!snap.exists()) return;
        const current = await decryptAmount('goal', goal.id, snap.data()!.currentAmountMinor);
        if (transferAmountMinor > current) throw new Error('insufficient-balance');
        const encNew = await encryptAmount('goal', goal.id, current - transferAmountMinor);
        transaction.update(goalRef, { currentAmountMinor: encNew, updatedAt: nowIso });
        const encLedger = await encryptAmount('goal', goal.id, -transferAmountMinor);
        transaction.set(doc(collection(db, 'goals', goal.id, 'ledger')), {
          type: 'withdrawal', amountMinor: encLedger, monthKey: null,
          note: t('goals.transferredToAccountNote', { name: account.name }),
          createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
        });
      });
      const { justCompletedGoals } = await applyAccountChange(
        account.id, account.currentBalanceMinor + transferAmountMinor, account.goalAllocations || [], actorName,
        { name: account.name, type: account.type, currency: account.currency, balanceAsOf: nowIso.slice(0, 10), interestRatePct: account.interestRatePct ?? null, compoundFrequency: account.compoundFrequency ?? null },
        { note: t('goals.transferredFromCashSavingsNote'), images: transferProofImages },
      );
      notifyGoalsMet(justCompletedGoals);
      setModal(null);
    } catch (err) {
      console.error('Failed to transfer to account:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Reset Cash Savings — available any time, not just when discontinuing something. Zeroes the
  // running balance and logs it, same as any other goal's ledger. The money isn't moved anywhere
  // (no posting, nothing to accept it) — it simply stops being tracked, exactly like Mark
  // Completed and the now-sweep-free Discontinue don't move money either.
  const handleResetCashSavings = async () => {
    if (!user || !goal || !isOwner || !goal.isCashHolding || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      await runTransaction(db, async (transaction) => {
        const goalRef = doc(db, 'goals', goal.id);
        const snap = await transaction.get(goalRef);
        if (!snap.exists()) return;
        const current = await decryptAmount('goal', goal.id, snap.data()!.currentAmountMinor);
        if (current === 0) return;
        const encZero = await encryptAmount('goal', goal.id, 0);
        transaction.update(goalRef, { currentAmountMinor: encZero, updatedAt: nowIso });
        const encLedger = await encryptAmount('goal', goal.id, -current);
        const ledgerRef = doc(collection(db, 'goals', goal.id, 'ledger'));
        transaction.set(ledgerRef, {
          type: 'reset', amountMinor: encLedger, monthKey: null, note: t('goals.cashSavingsResetNote'),
          createdBy: user.uid, createdByName: actorName, createdAt: nowIso,
        });
      });
      setModal(null);
    } catch (err) {
      console.error('Failed to reset Cash Savings:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!goal) {
    return <div className="p-8 text-center text-text-muted">{t('goals.loading')}</div>;
  }

  const pct = goalProgressPct(goal);
  const totalMinor = goalTotalMinor(goal);
  // completedAt is set either by auto-hitting 100% or by the explicit "Mark Completed" action —
  // both are a pure status flip with the balance left exactly as-is, so both read identically as
  // "done" here. Independent of the raw status value so this never confuses a completed goal with
  // a genuinely-discontinued (archived, never completed) one.
  const displayAsCompleted = !!goal.completedAt;

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32">
      <div className="flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-text-muted hover:bg-surface rounded-full">
          <span className="material-symbols-outlined text-[20px] block rtl:-scale-x-100">arrow_back</span>
        </button>
        {goal.isCashHolding ? (
          <span className="text-[10px] font-bold text-primary uppercase tracking-wider bg-primary/10 px-2.5 py-1 rounded-full">
            {t('goals.cashHoldingBadge')}
          </span>
        ) : isOwner ? (
          <button onClick={() => navigate(`/goals/${goal.id}/edit`)} className="p-2 text-primary hover:bg-primary/10 rounded-full">
            <span className="material-symbols-outlined text-[20px] block">edit</span>
          </button>
        ) : (
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider bg-surface-container px-2.5 py-1 rounded-full flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">visibility</span>
            {t('goals.viewingSharedGoal')}
          </span>
        )}
      </div>

      <div className="bg-white rounded-3xl border border-border-subtle shadow-sm overflow-hidden text-center">
        {goal.imageUrl && <img src={goal.imageUrl} alt="" className="w-full h-40 object-cover" />}
        <div className="p-6 space-y-4">
        <span className="text-6xl block">{goal.icon || '🎯'}</span>
        <div>
          <h1 className="text-xl font-black text-primary">{goal.name}</h1>
          {goal.notes && <p className="text-xs text-text-muted mt-1">{goal.notes}</p>}
        </div>
        {goal.isCashHolding ? (
          // No target, no progress bar, no projection — it's a running balance, not something
          // being worked toward. See goals.ts's Goal.isCashHolding for the full reasoning.
          <div className="space-y-1.5">
            <p className="text-3xl font-black text-primary">
              {currencySymbol}{fromMinorUnits(goal.currentAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-text-muted">{t('goals.cashHoldingDetailNote')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-1.5">
              <span className={clsx(
                'text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full',
                displayAsCompleted ? 'bg-success/10 text-success'
                  : goal.status === 'paused' ? 'bg-warning/10 text-warning'
                  : goal.status === 'archived' ? 'bg-surface-container text-text-muted'
                  : 'bg-primary/10 text-primary',
              )}>
                {displayAsCompleted ? t('goals.statusCompleted') : t(`goals.status${goal.status.charAt(0).toUpperCase()}${goal.status.slice(1)}`)}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-end">
                <span className={clsx('text-xs font-black', displayAsCompleted ? 'text-success' : 'text-primary')}>{Math.round(pct)}%</span>
              </div>
              <div className="h-3 w-full bg-surface-container rounded-full overflow-hidden">
                <div className={clsx('h-full rounded-full', displayAsCompleted ? 'bg-success' : 'bg-primary')} style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-2xl font-black text-primary">
                {currencySymbol}{fromMinorUnits(totalMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                <span className="text-sm text-text-muted font-bold"> / {currencySymbol}{fromMinorUnits(goal.targetAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </p>
              {/* Two separately-tracked buckets, always shown together — see goals.ts's
                  goalTotalMinor() doc comment for why these are never merged into one number. */}
              <div className="flex items-center justify-center gap-3 text-[11px] text-text-muted">
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-[13px]">account_balance</span>
                  {t('goals.fromAccounts', { amount: `${currencySymbol}${fromMinorUnits(goal.accountAllocatedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}
                </span>
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-[13px]">calendar_month</span>
                  {t('goals.fromMonthlySavings', { amount: `${currencySymbol}${fromMinorUnits(goal.currentAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}
                </span>
              </div>
              <p className="text-xs text-text-muted">
                {displayAsCompleted
                  ? t('goals.metOn', { date: goal.completedAt?.slice(0, 10) || '' })
                  : projected ? t('goals.projectedMet', { date: projected }) : t('goals.projectionUnavailable')}
              </p>
            </div>
          </>
        )}
        </div>
      </div>

      {isOwner && !goal.isCashHolding && (linkedAccounts.length > 0 || monthlyPostingMinor !== 0 || fromCashSavingsMinor !== 0) && (
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2.5">
          <h2 className="text-xs font-bold text-primary">{t('goals.whereThisComesFrom')}</h2>
          {linkedAccounts.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.fromAccountsLabel')}</p>
              {linkedAccounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => navigate(`/goals/accounts?open=${a.id}`)}
                  className="w-full bg-surface hover:bg-primary/5 rounded-xl px-3 py-2 transition-colors text-left space-y-0.5"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[14px] text-primary shrink-0">account_balance</span>
                    <span className="flex-1 min-w-0 text-xs font-bold text-on-surface truncate">{a.name}</span>
                    {a.reserved && (
                      <span className="text-[9px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0" title={t('goals.reservedNote')}>
                        {t('goals.reserved')}
                      </span>
                    )}
                    <span className="material-symbols-outlined text-[14px] text-text-muted shrink-0">chevron_right</span>
                  </div>
                  <p className="text-[11px] text-text-muted font-bold pl-[20px]">
                    {a.pct}% · {getCurrencySymbol(a.currency)}{fromMinorUnits(a.contributedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </p>
                </button>
              ))}
            </div>
          )}
          {(monthlyPostingMinor !== 0 || fromCashSavingsMinor !== 0) && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.fromMonthlySavingsLabel')}</p>
              {monthlyPostingMinor !== 0 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-on-surface flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px] text-primary">calendar_month</span>
                    {t('goals.fromMonthlyPosting')}
                  </span>
                  <span className="text-text-muted font-bold shrink-0">{currencySymbol}{fromMinorUnits(monthlyPostingMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              )}
              {fromCashSavingsMinor !== 0 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-on-surface flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px] text-primary">savings</span>
                    {t('goals.fromCashSavingsPulls')}
                  </span>
                  <span className="text-text-muted font-bold shrink-0">{currencySymbol}{fromMinorUnits(fromCashSavingsMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isOwner && goal.isCashHolding && goal.status !== 'archived' && (
        // Cash Savings: no "Add Funds" (arbitrary manual boost) and no direct transfer into a
        // goal any more — funding a goal only ever happens via a linked account's own %
        // allocation now (see goals.ts's header comment). The only ways money leaves here are
        // into a real account (from which it can then be allocated) or an explicit Reset.
        <button onClick={() => openModal('transferAccount')} disabled={accountsForTransfer.length === 0 || goal.currentAmountMinor <= 0} className="w-full py-3 bg-primary text-white font-bold rounded-xl text-sm flex items-center justify-center gap-1.5 disabled:opacity-40">
          <span className="material-symbols-outlined text-[18px]">account_balance</span>
          {t('goals.transferToAccount')}
        </button>
      )}

      {isOwner && goal.isCashHolding && goal.currentAmountMinor > 0 && (
        <button onClick={() => openModal('resetCash')} className="w-full py-2.5 rounded-xl border border-error/20 text-error font-bold text-xs">
          {t('goals.resetCashSavings')}
        </button>
      )}

      {goal.status !== 'archived' && !displayAsCompleted && !goal.isCashHolding && (
        isOwner ? (
          <button onClick={() => openModal('transfer')} disabled={goal.currentAmountMinor <= 0} className="w-full py-3 bg-white border border-border-subtle text-on-surface font-bold rounded-xl text-sm flex items-center justify-center gap-1.5 disabled:opacity-40">
            <span className="material-symbols-outlined text-[18px]">savings</span>
            {t('goals.returnToCashSavings')}
          </button>
        ) : (
          <button onClick={() => openModal('boost')} className="w-full py-3 bg-primary text-white font-bold rounded-xl text-sm flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-[18px]">add_circle</span>
            {t('goals.boostFunds')}
          </button>
        )
      )}
      {isOwner && !goal.isCashHolding && goal.status !== 'archived' && !displayAsCompleted && (
        <p className="text-[10px] text-text-muted text-center -mt-1">{t('goals.transferScopeNote')}</p>
      )}

      {isOwner && !goal.isCashHolding && goal.status !== 'archived' && (
        <button onClick={() => openModal('complete')} className="w-full py-3 bg-success text-white font-bold rounded-xl text-sm flex items-center justify-center gap-1.5">
          <span className="material-symbols-outlined text-[18px]">check_circle</span>
          {t('goals.markCompleted')}
        </button>
      )}

      {isOwner && !goal.isCashHolding && goal.status !== 'archived' && otherActiveGoals.length > 0 && (
        <button onClick={() => openModal('merge')} disabled={goal.currentAmountMinor <= 0} className="w-full py-2.5 rounded-xl border border-border-subtle text-text-muted font-bold text-xs disabled:opacity-40">
          {t('goals.transferToOtherGoals')}
        </button>
      )}

      {isOwner && !goal.isCashHolding && goal.status !== 'archived' && goal.accountAllocatedMinor > 0 && (
        <button onClick={() => openModal('reset')} className="w-full py-2.5 rounded-xl border border-error/20 text-error font-bold text-xs">
          {t('goals.resetAllocation')}
        </button>
      )}

      {isOwner && !goal.isCashHolding && goal.status !== 'archived' && (
        <div className="flex gap-2">
          {goal.status !== 'completed' && (
            <button onClick={handleTogglePause} className="flex-1 py-2.5 rounded-xl border border-border-subtle text-text-muted font-bold text-xs">
              {goal.status === 'paused' ? t('goals.resumeGoal') : t('goals.pauseGoal')}
            </button>
          )}
          <button onClick={() => openModal('delete')} className="flex-1 py-2.5 rounded-xl border border-error/20 text-error font-bold text-xs">
            {t('goals.archiveOrDelete')}
          </button>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-primary px-1">{t('goals.contributionHistory')}</h2>
        {ledger.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-6">{t('goals.noContributionsYet')}</p>
        ) : (
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm divide-y divide-border-subtle">
            {ledger.map((entry) => (
              <div key={entry.id} className="p-3 flex items-center gap-3">
                <span className={clsx('material-symbols-outlined text-[18px] shrink-0', entry.amountMinor >= 0 ? 'text-success' : 'text-error')}>
                  {LEDGER_ICONS[entry.type] || 'receipt_long'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-on-surface">{t(LEDGER_LABELS[entry.type] || entry.type)}{entry.monthKey ? ` · ${entry.monthKey}` : ''}</p>
                  {entry.note && <p className="text-[10px] text-text-muted truncate">{entry.note}</p>}
                  <p className="text-[10px] text-text-muted">{(entry.createdAt || '').slice(0, 10)} · {entry.createdByName}</p>
                </div>
                <span className={clsx('text-sm font-bold shrink-0', entry.amountMinor >= 0 ? 'text-success' : 'text-error')}>
                  {entry.amountMinor >= 0 ? '+' : ''}{currencySymbol}{fromMinorUnits(entry.amountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- Boost modal --- */}
      {modal === 'boost' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('goals.boostFunds')}</h3>
            <input
              type="text" inputMode="decimal" autoFocus value={amountInput} onChange={(e) => setAmountInput(e.target.value)}
              placeholder="e.g. 5000" className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            <input
              type="text" value={noteInput} onChange={(e) => setNoteInput(e.target.value)}
              placeholder={t('goals.noteOptional')} className="w-full h-11 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleBoost} disabled={busy} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.confirmBoost')}
            </button>
          </div>
        </div>
      )}

      {/* --- Transfer modal: Pull from Cash Savings (regular goal) / Transfer to Other Goal (Cash Savings) --- */}
      {modal === 'transfer' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('goals.returnToCashSavings')}</h3>
            <p className="text-xs text-text-muted">{t('goals.availableInThisGoal', { amount: `${currencySymbol}${fromMinorUnits(goal.currentAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}</p>
            <input
              type="text" inputMode="decimal" autoFocus value={amountInput} onChange={(e) => setAmountInput(e.target.value)}
              placeholder="e.g. 5000" className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleCashTransfer} disabled={busy} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.confirmTransfer')}
            </button>
          </div>
        </div>
      )}

      {/* --- Transfer to Account (Cash Savings only) --- */}
      {modal === 'transferAccount' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('goals.transferToAccount')}</h3>
            <p className="text-xs text-text-muted">{t('goals.availableInCashSavings', { amount: `${currencySymbol}${fromMinorUnits(goal.currentAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}</p>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.transferDestination')}</label>
              <select value={transferAccountId} onChange={(e) => setTransferAccountId(e.target.value)} className="w-full h-12 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none">
                {accountsForTransfer.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({getCurrencySymbol(a.currency)}{fromMinorUnits(a.currentBalanceMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })})</option>
                ))}
              </select>
            </div>
            <input
              type="text" inputMode="decimal" value={amountInput} onChange={(e) => setAmountInput(e.target.value)}
              placeholder="e.g. 5000" className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            <ImageAttachments images={transferProofImages} onChange={setTransferProofImages} label={t('accounts.attachProof')} maxImages={2} />
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleTransferToAccount} disabled={busy} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.confirmTransfer')}
            </button>
          </div>
        </div>
      )}

      {/* --- Merge & Redistribution modal --- */}
      {modal === 'merge' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('goals.transferToOtherGoals')}</h3>
            <p className="text-xs text-text-muted">{t('goals.mergeExplainer', { name: goal.name, amount: `${currencySymbol}${fromMinorUnits(goal.currentAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}</p>
            <div className="space-y-2">
              {otherActiveGoals.map((g) => (
                <div key={g.id} className="flex items-center gap-2 bg-surface rounded-xl p-2.5">
                  <span className="text-lg shrink-0">{g.icon || '🎯'}</span>
                  <span className="flex-1 text-xs font-bold text-on-surface truncate">{g.name}</span>
                  <input
                    type="text" inputMode="numeric" value={mergeShares[g.id] || 0}
                    onChange={(e) => setMergeShares({ ...mergeShares, [g.id]: Math.max(0, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, '')) || 0)) })}
                    className="w-14 h-9 text-center bg-white border border-border-subtle rounded-lg font-black text-primary text-sm outline-none"
                  />
                  <span className="text-xs font-bold text-text-muted">%</span>
                </div>
              ))}
            </div>
            <p className={clsx('text-xs font-bold text-center', mergeTotal === 100 ? 'text-success' : 'text-text-muted')}>{mergeTotal}% {t('goals.allocated')}</p>
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleMerge} disabled={busy} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.confirmMerge')}
            </button>
          </div>
        </div>
      )}

      {/* --- Archive / Delete confirm --- */}
      {modal === 'delete' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 text-center max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-error text-4xl">warning</span>
            <p className="text-sm text-on-surface">
              {ledger.length > 0 ? t('goals.confirmArchiveHasHistory', { name: goal.name }) : t('goals.confirmDeleteNoHistory', { name: goal.name })}
            </p>
            <button onClick={ledger.length > 0 ? handleArchive : handleDelete} disabled={busy} className="w-full py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : ledger.length > 0 ? t('goals.archiveGoal') : t('goals.deleteGoal')}
            </button>
            <button onClick={() => setModal(null)} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}

      {/* --- Mark Completed: pure status flip, no money moves --- */}
      {modal === 'complete' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('goals.markCompleted')}</h3>
            <p className="text-xs text-text-muted">{t('goals.completeExplainer')}</p>
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleCompleteGoal} disabled={busy} className="w-full py-3 bg-success text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.confirmComplete')}
            </button>
            <button onClick={() => setModal(null)} disabled={busy} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}

      {/* --- Reset Allocation (bucket #2 only) --- */}
      {modal === 'reset' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 text-center max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-error text-4xl">restart_alt</span>
            <h3 className="text-base font-black text-primary">{t('goals.resetAllocation')}</h3>
            <p className="text-xs text-text-muted">
              {t('goals.resetAllocationExplainer', { amount: `${currencySymbol}${fromMinorUnits(goal.accountAllocatedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}
            </p>
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleResetAllocation} disabled={busy} className="w-full py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.resetAllocation')}
            </button>
            <button onClick={() => setModal(null)} disabled={busy} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}

      {/* --- Reset Cash Savings --- */}
      {modal === 'resetCash' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 text-center max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-error text-4xl">restart_alt</span>
            <h3 className="text-base font-black text-primary">{t('goals.resetCashSavings')}</h3>
            <p className="text-xs text-text-muted">
              {t('goals.resetCashSavingsExplainer', { amount: `${currencySymbol}${fromMinorUnits(goal.currentAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}
            </p>
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <button onClick={handleResetCashSavings} disabled={busy} className="w-full py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
              {busy ? t('goals.saving') : t('goals.resetCashSavings')}
            </button>
            <button onClick={() => setModal(null)} disabled={busy} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
