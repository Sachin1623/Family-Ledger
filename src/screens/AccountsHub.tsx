import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { collection, doc, query, setDoc, updateDoc, deleteDoc, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { getCurrencySymbol } from '../lib/constants';
import { todayLocalDateString } from '../lib/dateUtils';
import { toMinorUnits, fromMinorUnits } from '../lib/goals';
import { decryptAmount, encryptAmount, encryptText } from '../lib/fieldCrypto';
import {
  FinancialAccount, AccountType, ACCOUNT_TYPES, CompoundFrequency, COMPOUND_FREQUENCIES, COMPOUND_PERIODS_PER_YEAR, nextInterestDate,
  ContributionFrequency, CONTRIBUTION_FREQUENCIES, nextContributionDate,
  decryptAccountsList, accountUnallocatedMinor, accountAllocatedPctTotal,
} from '../lib/accounts';
import { applyAccountChange, deallocateAccountBeforeDelete, notifyGoalsMet, AccountAllocationInput } from '../lib/accountAllocations';
import { shareText } from '../lib/fileShare';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';

// Accounts — HDFC, ICICI-Self, ICICI-Wife, Zerodha, Groww, Coin, whatever the user actually holds
// money in. Balances change ONLY through an explicit edit here or a Transfer Funds between two of
// the user's own accounts — nothing else in the app (expenses, income, recurring anything) ever
// touches one. There is deliberately no archive/hide action: it used to exist, but hiding an
// account with no way to unhide it from the UI is a data-loss trap, not a feature — every account
// the user creates stays visible and editable for as long as it exists, UNTIL the user explicitly
// deletes it. Balances are encrypted at rest (see lib/fieldCrypto.ts) — decrypted once here into
// plain numbers right after the live Firestore snapshot arrives, same as every other screen.
//
// An account can allocate percentages of its balance across several goals at once
// (FinancialAccount.goalAllocations) — whatever isn't allocated is this account's own unallocated
// portion, shown right on its tile, NEVER pooled anywhere else. Every balance/link change here (or
// via Transfer Funds, or an accepted Scheduled Transfer in RecurringApprovals.tsx) recomputes
// every affected goal's accountAllocatedMinor in the same step, through the single mechanism in
// src/lib/accountAllocations.ts's applyAccountChange() — see its own header comment for why that's
// the only place this ever happens. Every save also writes one entry to this account's own
// financialAccounts/{id}/log subcollection — the "History" button below shows it.
export default function AccountsHub() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [accountsValue] = useCollection(user ? query(collection(db, 'financialAccounts'), where('userId', '==', user.uid)) : null);
  const [allAccounts, setAllAccounts] = useState<FinancialAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    const raw = accountsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
    decryptAccountsList(raw).then((decrypted) => { if (!cancelled) setAllAccounts(decrypted); })
      .catch((err) => console.error('Failed to decrypt accounts:', err));
    return () => { cancelled = true; };
  }, [accountsValue]);
  const activeAccounts = allAccounts; // no archiving — every account the user creates stays visible
  const defaultCurrency = allAccounts[0]?.currency || 'INR';
  const totalMinor = activeAccounts.reduce((s, a) => s + a.currentBalanceMinor, 0);
  // Same split every account tile already shows for itself (accountUnallocatedMinor), summed
  // across every account — same "no cross-currency conversion" simplification totalMinor above
  // already accepts (this screen has never converted currencies; see defaultCurrency's own
  // comment). Allocated = whatever isn't unallocated, so the two always add back up to the total.
  const totalUnallocatedMinor = activeAccounts.reduce((s, a) => s + accountUnallocatedMinor(a), 0);
  const totalAllocatedMinor = totalMinor - totalUnallocatedMinor;

  // --- SIP contribution + interest compounding catch-up ---
  // Same reason GoalsHub's Cash Savings catch-up runs client-side on mount rather than as a server
  // cron: the server has no working decrypt path for an account's balance (see fieldCrypto.ts's
  // header comment) or the SIP/interest fields sitting alongside it, so nothing server-side can
  // compute the new balance itself. Walks every account with a due SIP contribution and/or due
  // interest compounding, folds ALL elapsed periods of BOTH into ONE balance credit + one
  // applyAccountChange() call per account (never two separate calls racing each other on the same
  // doc), advancing whichever of contributionNextDate/interestNextDate applied past today. Bounded
  // to 60 periods each so a years-forgotten account doesn't hang — through the exact same
  // applyAccountChange() every other balance change goes through, so it's logged in History like
  // anything else. Interest only auto-applies once `interestNextDate` is explicitly set (see
  // FinancialAccount.interestNextDate's doc comment in accounts.ts) — a rate saved before this
  // existed stays purely informational until the user re-saves and picks a next-credit date.
  const [autoApplyResults, setAutoApplyResults] = useState<{ name: string; kind: 'sip' | 'interest'; occurrences: number; amountMinor: number; currency: string }[]>([]);
  const [autoApplyRan, setAutoApplyRan] = useState(false);
  useEffect(() => {
    if (!user || autoApplyRan || allAccounts.length === 0) return;
    const today = todayLocalDateString();
    const due = allAccounts.filter(
      (a) =>
        (a.contributionFrequency && a.contributionNextDate && a.contributionAmountMinor != null && a.contributionNextDate <= today) ||
        (a.interestRatePct && a.compoundFrequency && a.interestNextDate && a.interestNextDate <= today),
    );
    if (due.length === 0) { setAutoApplyRan(true); return; }
    setAutoApplyRan(true);
    const actorName = profile?.displayName || user.displayName || 'Someone';
    (async () => {
      const results: { name: string; kind: 'sip' | 'interest'; occurrences: number; amountMinor: number; currency: string }[] = [];
      for (const a of due) {
        let balance = a.currentBalanceMinor;
        const notes: string[] = [];
        let nextContribDate = a.contributionNextDate;
        if (a.contributionFrequency && a.contributionNextDate && a.contributionAmountMinor != null) {
          let occurrences = 0;
          let addedMinor = 0;
          let cursor = a.contributionNextDate;
          while (cursor <= today && occurrences < 60) {
            addedMinor += a.contributionAmountMinor;
            occurrences += 1;
            cursor = nextContributionDate(cursor, a.contributionFrequency);
          }
          if (occurrences > 0) {
            balance += addedMinor;
            nextContribDate = cursor;
            notes.push(`SIP: ${occurrences} contribution(s), +${getCurrencySymbol(a.currency)}${fromMinorUnits(addedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
            results.push({ name: a.name, kind: 'sip', occurrences, amountMinor: addedMinor, currency: a.currency });
          }
        }
        let nextInterestDateVal = a.interestNextDate;
        if (a.interestRatePct && a.compoundFrequency && a.interestNextDate) {
          const periodRate = a.interestRatePct / 100 / COMPOUND_PERIODS_PER_YEAR[a.compoundFrequency];
          let occurrences = 0;
          let cursor = a.interestNextDate;
          const before = balance;
          while (cursor <= today && occurrences < 60) {
            balance = Math.round(balance * (1 + periodRate));
            occurrences += 1;
            cursor = nextInterestDate(cursor, a.compoundFrequency);
          }
          if (occurrences > 0) {
            nextInterestDateVal = cursor;
            const grown = balance - before;
            notes.push(`Interest: ${occurrences} period(s), +${getCurrencySymbol(a.currency)}${fromMinorUnits(grown).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
            results.push({ name: a.name, kind: 'interest', occurrences, amountMinor: grown, currency: a.currency });
          }
        }
        if (notes.length === 0) continue;
        try {
          await applyAccountChange(a.id, balance, a.goalAllocations || [], actorName, {
            name: a.name, type: a.type, currency: a.currency, balanceAsOf: today,
            interestRatePct: a.interestRatePct ?? null, compoundFrequency: a.compoundFrequency ?? null,
            contributionNextDate: nextContribDate ?? null,
            interestNextDate: nextInterestDateVal ?? null,
          }, { note: notes.join(' · ') });
        } catch (err) {
          console.error(`Auto-apply catch-up failed for account ${a.id}:`, err);
        }
      }
      if (results.length > 0) setAutoApplyResults(results);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, allAccounts.length, autoApplyRan]);

  // Goals an account can allocate to — the user's own active real goals, never Cash Savings
  // itself (Accounts no longer interact with Cash Savings at all) and never someone else's shared
  // goal. Amount fields aren't decrypted here since only id/name/icon are needed for the picker.
  const [linkableGoalsValue] = useCollection(user ? query(collection(db, 'goals'), where('userId', '==', user.uid), where('status', '==', 'active')) : null);
  const linkableGoals = (linkableGoalsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []).filter((g: any) => !g.isCashHolding);

  // --- Add/edit account form ---
  const [showInfo, setShowInfo] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<FinancialAccount | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('bank');
  const [currency, setCurrency] = useState('INR');
  const [balanceInput, setBalanceInput] = useState('');
  const [balanceAsOf, setBalanceAsOf] = useState(todayLocalDateString());
  const [allocPcts, setAllocPcts] = useState<Record<string, number>>({}); // goalId -> pct, only nonzero entries are saved
  const [interestRateInput, setInterestRateInput] = useState('');
  const [compoundFrequency, setCompoundFrequency] = useState<CompoundFrequency | ''>('');
  const [interestNextDateInput, setInterestNextDateInput] = useState('');
  const [accountNumberInput, setAccountNumberInput] = useState('');
  const [nominees, setNominees] = useState<{ name: string; pct: number }[]>([]);
  const [contributionAmountInput, setContributionAmountInput] = useState('');
  const [contributionFrequency, setContributionFrequency] = useState<ContributionFrequency | ''>('');
  const [contributionNextDateInput, setContributionNextDateInput] = useState('');
  // Collapsed by default — most accounts either don't allocate to any goal or already have their
  // split set from a previous save, so showing every goal's % input up front just adds scroll for
  // no reason most of the time. Same "expanded opt-in" pattern used elsewhere in this app.
  const [allocSectionExpanded, setAllocSectionExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const allocTotal: number = Object.keys(allocPcts).reduce((s: number, k: string) => s + (allocPcts[k] || 0), 0);
  const nomineeTotal: number = nominees.reduce((s, n) => s + (n.pct || 0), 0);

  const openAdd = () => {
    setEditingAccount(null);
    setName('');
    setType('bank');
    setCurrency(defaultCurrency);
    setBalanceInput('');
    setBalanceAsOf(todayLocalDateString());
    setAllocPcts({});
    setInterestRateInput('');
    setCompoundFrequency('');
    setInterestNextDateInput('');
    setAccountNumberInput('');
    setNominees([]);
    setContributionAmountInput('');
    setContributionFrequency('');
    setContributionNextDateInput('');
    setAllocSectionExpanded(false);
    setFormError(null);
    setShowForm(true);
  };
  const openEdit = (a: FinancialAccount) => {
    setEditingAccount(a);
    setName(a.name);
    setType(a.type);
    setCurrency(a.currency);
    setBalanceInput(String(fromMinorUnits(a.currentBalanceMinor)));
    setBalanceAsOf(a.balanceAsOf || a.updatedAt?.slice(0, 10) || todayLocalDateString());
    setAllocPcts(Object.fromEntries((a.goalAllocations || []).map((g) => [g.goalId, g.pct])));
    setInterestRateInput(a.interestRatePct != null ? String(a.interestRatePct) : '');
    setCompoundFrequency(a.compoundFrequency || '');
    setInterestNextDateInput(a.interestNextDate || '');
    setAccountNumberInput(a.accountNumber || '');
    setNominees(a.nominees || []);
    setContributionAmountInput(a.contributionAmountMinor != null ? String(fromMinorUnits(a.contributionAmountMinor)) : '');
    setContributionFrequency(a.contributionFrequency || '');
    setContributionNextDateInput(a.contributionNextDate || '');
    setAllocSectionExpanded(false);
    setFormError(null);
    setShowForm(true);
  };

  // --- View Account (read-only) ---
  // Opening an account — via the deep link below, or tapping its row in the list — lands here
  // first, not straight into the editable form: a read-only summary with an explicit Edit action,
  // so a quick "what's in this account" glance never risks an accidental field change.
  const [viewAccount, setViewAccount] = useState<FinancialAccount | null>(null);
  const [viewRevealNumber, setViewRevealNumber] = useState(false);
  const openView = (a: FinancialAccount) => { setViewAccount(a); setViewRevealNumber(false); };

  // Deep-link from GoalDetail's "Where this comes from" list (?open=<accountId>) — opens that
  // account's read-only view directly once it's loaded. Deliberately depends on the param's
  // actual VALUE, not a mount-only `[]` effect: this route's pathname never changes across repeat
  // visits (only the query string does), so React Router reuses the same component instance — a
  // mount-only effect would silently miss every visit after the first (see
  // feedback_mount_only_query_param_effects). `openedParamRef` guards against re-opening the view
  // every time `allAccounts` itself updates (e.g. right after saving) for the same param value.
  const openAccountParam = searchParams.get('open');
  const openedParamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openAccountParam || openAccountParam === openedParamRef.current) return;
    const match = allAccounts.find((a) => a.id === openAccountParam);
    if (!match) return; // accounts still loading — try again once allAccounts updates
    openedParamRef.current = openAccountParam;
    openView(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAccountParam, allAccounts]);

  const handleSaveAccount = async () => {
    if (!user || saving) return;
    const trimmed = name.trim();
    if (!trimmed) { setFormError(t('accounts.nameRequired')); return; }
    const clash = allAccounts.find((a) => a.id !== editingAccount?.id && a.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (clash) { setFormError(t('accounts.nameTaken')); return; }
    const balanceMinor = toMinorUnits(parseFloat(balanceInput || '0'));
    if (!Number.isFinite(balanceMinor)) { setFormError(t('accounts.enterValidBalance')); return; }
    if (allocTotal > 100) { setFormError(t('accounts.allocationOver100')); return; }
    let interestRatePct: number | null = null;
    if (interestRateInput.trim() !== '') {
      interestRatePct = parseFloat(interestRateInput);
      if (!Number.isFinite(interestRatePct) || interestRatePct < 0) { setFormError(t('accounts.enterValidInterestRate')); return; }
    }
    // Auto-crediting interest needs both a compounding frequency AND a next-credit date — a rate
    // with no frequency has nothing to compound on, and a frequency with no date has nothing to
    // start the schedule from. Entering just a rate (no frequency picked) stays purely
    // informational, exactly as before — same as leaving contributionNextDate unset for SIP.
    if (interestRatePct != null && interestRatePct > 0 && compoundFrequency && !interestNextDateInput) {
      setFormError(t('accounts.chooseInterestDate'));
      return;
    }
    // Nominees: a single nominee needs no split — always saved as 100% regardless of whatever
    // value the (hidden) pct field happens to hold. Two or more must add up to exactly 100, or
    // "40% to each of two people" silently leaves 20% of the account unaccounted for.
    const cleanedNominees = nominees.map((n) => ({ name: n.name.trim(), pct: n.pct })).filter((n) => n.name.length > 0);
    if (cleanedNominees.some((n) => !n.name)) { setFormError(t('accounts.nomineeNameRequired')); return; }
    if (cleanedNominees.length === 1) cleanedNominees[0] = { ...cleanedNominees[0], pct: 100 };
    if (cleanedNominees.length > 1 && cleanedNominees.reduce((s, n) => s + (n.pct || 0), 0) !== 100) {
      setFormError(t('accounts.nomineeAllocationNot100'));
      return;
    }
    // Contribution / SIP: amount + frequency + next date are all-or-nothing — a frequency with no
    // amount (or vice versa) has nothing sensible to apply.
    let contributionAmountMinorPlain: number | null = null;
    if (contributionFrequency) {
      contributionAmountMinorPlain = toMinorUnits(parseFloat(contributionAmountInput || '0'));
      if (!Number.isFinite(contributionAmountMinorPlain) || contributionAmountMinorPlain <= 0) { setFormError(t('accounts.enterValidContributionAmount')); return; }
      if (!contributionNextDateInput) { setFormError(t('accounts.chooseContributionDate')); return; }
    }
    setSaving(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const nowIso = new Date().toISOString();
      const asOf = balanceAsOf || todayLocalDateString();
      const newAllocations: AccountAllocationInput[] = Object.keys(allocPcts)
        .filter((goalId) => (allocPcts[goalId] || 0) > 0)
        .map((goalId) => ({ goalId, goalName: linkableGoals.find((g: any) => g.id === goalId)?.name || goalId, pct: allocPcts[goalId] }));
      let accountId: string;
      if (editingAccount) {
        accountId = editingAccount.id;
      } else {
        // Two-phase write: the crypto/key endpoint authorizes an 'account' scope by reading
        // financialAccounts/{id} and checking its userId — which doesn't exist yet for a
        // brand-new account. Create the doc first with harmless plaintext-zero placeholders
        // (establishing ownership, satisfying isValidAccount), then applyAccountChange below
        // does the real balance/allocation write.
        const ref = doc(collection(db, 'financialAccounts'));
        await setDoc(ref, {
          userId: user.uid, name: trimmed, type, currency, currentBalanceMinor: 0, balanceAsOf: asOf,
          goalAllocations: [], allocatedGoalIds: [], interestRatePct, compoundFrequency: compoundFrequency || null,
          archived: false, createdAt: nowIso, updatedAt: nowIso,
        });
        accountId = ref.id;
      }
      // accountNumber/contributionAmountMinor are ciphertext by the time they reach `fields` —
      // applyAccountChange writes AccountEditableFields straight through, it doesn't encrypt
      // anything in there itself (only the balance arg it's given directly). Encrypted here, now
      // that accountId is known either way.
      const [encAccountNumber, encContributionAmount] = await Promise.all([
        accountNumberInput.trim() ? encryptText('account', accountId, accountNumberInput.trim()) : Promise.resolve(null),
        contributionAmountMinorPlain != null ? encryptAmount('account', accountId, contributionAmountMinorPlain) : Promise.resolve(null),
      ]);
      const fields = {
        name: trimmed, type, currency, balanceAsOf: asOf, interestRatePct, compoundFrequency: compoundFrequency || null,
        accountNumber: encAccountNumber, nominees: cleanedNominees,
        contributionAmountMinor: encContributionAmount,
        contributionFrequency: contributionFrequency || null,
        contributionNextDate: contributionFrequency ? contributionNextDateInput : null,
        interestNextDate: interestRatePct != null && interestRatePct > 0 && compoundFrequency ? interestNextDateInput : null,
      };
      const { justCompletedGoals } = await applyAccountChange(accountId, balanceMinor, newAllocations, actorName, fields);
      notifyGoalsMet(justCompletedGoals);
      setShowForm(false);
    } catch (err) {
      console.error('Failed to save account:', err);
      setFormError(t('goals.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // --- Delete account ---
  const [deletingAccount, setDeletingAccount] = useState<FinancialAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteAccount = async () => {
    if (!deletingAccount || !user || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      // Credits back down any goal this account was allocating to BEFORE the doc is gone, so
      // deleting an account never leaves stale money sitting on a goal with nothing to explain it.
      await deallocateAccountBeforeDelete(deletingAccount.id, actorName);
      await deleteDoc(doc(db, 'financialAccounts', deletingAccount.id));
      setDeletingAccount(null);
    } catch (err) {
      console.error('Failed to delete account:', err);
      setDeleteError(t('goals.saveFailed'));
    } finally {
      setDeleting(false);
    }
  };

  // --- Transfer funds between two of the user's own accounts ---
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmountInput, setTransferAmountInput] = useState('');
  const [transferDate, setTransferDate] = useState(todayLocalDateString());
  const [transferProofImages, setTransferProofImages] = useState<string[]>([]);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const openTransfer = () => {
    const from = activeAccounts[0]?.id || '';
    setTransferFrom(from);
    setTransferTo(activeAccounts.find((a) => a.id !== from)?.id || '');
    setTransferAmountInput('');
    setTransferDate(todayLocalDateString());
    setTransferProofImages([]);
    setTransferError(null);
    setShowTransfer(true);
  };

  const handleTransfer = async () => {
    if (!user || transferring) return;
    if (!transferFrom || !transferTo || transferFrom === transferTo) { setTransferError(t('accounts.chooseTwoDifferentAccounts')); return; }
    const amountMinor = toMinorUnits(parseFloat(transferAmountInput || '0'));
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setTransferError(t('accounts.enterValidBalance')); return; }
    const fromAcc = activeAccounts.find((a) => a.id === transferFrom);
    const toAcc = activeAccounts.find((a) => a.id === transferTo);
    if (!fromAcc || !toAcc) { setTransferError(t('accounts.enterValidBalance')); return; }
    setTransferring(true);
    setTransferError(null);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const asOf = transferDate || todayLocalDateString();
      // Each leg recomputes that account's own goal allocations against its new balance in the
      // same step — same mechanism as any other balance edit (point 3 of the rework). Both legs
      // get the same proof photo(s), visible later in either account's own History.
      const [fromResult, toResult] = await Promise.all([
        applyAccountChange(transferFrom, fromAcc.currentBalanceMinor - amountMinor, fromAcc.goalAllocations || [], actorName, {
          name: fromAcc.name, type: fromAcc.type, currency: fromAcc.currency, balanceAsOf: asOf,
          interestRatePct: fromAcc.interestRatePct ?? null, compoundFrequency: fromAcc.compoundFrequency ?? null,
        }, { images: transferProofImages }),
        applyAccountChange(transferTo, toAcc.currentBalanceMinor + amountMinor, toAcc.goalAllocations || [], actorName, {
          name: toAcc.name, type: toAcc.type, currency: toAcc.currency, balanceAsOf: asOf,
          interestRatePct: toAcc.interestRatePct ?? null, compoundFrequency: toAcc.compoundFrequency ?? null,
        }, { images: transferProofImages }),
      ]);
      notifyGoalsMet([...fromResult.justCompletedGoals, ...toResult.justCompletedGoals]);
      setShowTransfer(false);
    } catch (err) {
      console.error('Failed to transfer funds:', err);
      setTransferError(t('goals.saveFailed'));
    } finally {
      setTransferring(false);
    }
  };

  // --- Account history modal ---
  const [historyAccount, setHistoryAccount] = useState<FinancialAccount | null>(null);
  const [historyLightbox, setHistoryLightbox] = useState<string | null>(null);
  const [logValue] = useCollection(historyAccount ? collection(db, 'financialAccounts', historyAccount.id, 'log') : null);
  const [logEntries, setLogEntries] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!historyAccount) { setLogEntries([]); return; }
    const raw = (logValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [])
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    Promise.all(raw.map(async (e) => ({
      ...e,
      balanceBeforeMinor: await decryptAmount('account', historyAccount.id, e.balanceBeforeMinor),
      balanceAfterMinor: await decryptAmount('account', historyAccount.id, e.balanceAfterMinor),
      allocationChanges: await Promise.all((e.allocationChanges || []).map(async (c: any) => ({
        ...c,
        beforeAmountMinor: await decryptAmount('account', historyAccount.id, c.beforeAmountMinor),
        afterAmountMinor: await decryptAmount('account', historyAccount.id, c.afterAmountMinor),
      }))),
    }))).then((decrypted) => { if (!cancelled) setLogEntries(decrypted); })
      .catch((err) => console.error('Failed to decrypt account history:', err));
    return () => { cancelled = true; };
  }, [logValue, historyAccount]);

  // --- Reveal/mask account number on the tile ---
  // Already-decrypted in memory (decryptAccountsList runs on every load, same as balance) — this
  // is purely a display toggle, not a re-fetch, so there's no extra network round-trip per reveal.
  const [revealedAccountIds, setRevealedAccountIds] = useState<Set<string>>(new Set());
  const toggleRevealAccountNumber = (id: string) =>
    setRevealedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const maskAccountNumber = (num: string) => (num.length <= 4 ? num : `••••${num.slice(-4)}`);

  // --- Share account details ---
  const [shareAccount, setShareAccount] = useState<FinancialAccount | null>(null);
  const [shareIncludeNumber, setShareIncludeNumber] = useState(false);
  const [shareIncludeBalance, setShareIncludeBalance] = useState(true);
  const [shareResult, setShareResult] = useState<string | null>(null);

  const openShare = (a: FinancialAccount) => {
    setShareAccount(a);
    setShareIncludeNumber(false); // default OFF — a full account number is the most sensitive
    // field on this screen, sharing it should be a deliberate opt-in, not a pre-ticked default
    setShareIncludeBalance(true);
    setShareResult(null);
  };
  const shareText_ = (a: FinancialAccount) => {
    const lines = [`${a.name} (${t(`accounts.type.${a.type}`)})`];
    if (a.accountNumber) {
      lines.push(`${t('accounts.accountNumber')}: ${shareIncludeNumber ? a.accountNumber : maskAccountNumber(a.accountNumber)}`);
    }
    if (shareIncludeBalance) {
      lines.push(`${t('accounts.balance')}: ${getCurrencySymbol(a.currency)}${fromMinorUnits(a.currentBalanceMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })} (${t('accounts.asOf', { date: new Date(a.balanceAsOf || a.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })})`);
    }
    if ((a.nominees || []).length > 0) {
      lines.push(`${t('accounts.nominees')}: ${a.nominees!.map((n) => (a.nominees!.length > 1 ? `${n.name} (${n.pct}%)` : n.name)).join(', ')}`);
    }
    return lines.join('\n');
  };
  const handleShare = async () => {
    if (!shareAccount) return;
    const outcome = await shareText(shareAccount.name, shareText_(shareAccount));
    if (outcome === 'copied') setShareResult(t('accounts.copiedToClipboard'));
    else if (outcome === 'shared') setShareAccount(null);
  };

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto space-y-5 pb-32">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-primary">{t('accounts.title')}</h1>
        <button onClick={() => navigate(-1)} className="p-2 text-text-muted hover:bg-surface rounded-full">
          <span className="material-symbols-outlined text-[20px] block">close</span>
        </button>
      </div>

      <button type="button" onClick={() => setShowInfo(true)} className="w-full flex items-center gap-1.5 text-[11px] font-bold text-primary px-1">
        <span className="material-symbols-outlined text-[15px]">info</span>
        <span className="underline">{t('accounts.whyWeAsk')}</span>
      </button>

      {autoApplyResults.length > 0 && (
        <div className="bg-success/10 border border-success/30 rounded-xl p-3 space-y-1">
          <p className="text-xs font-black text-success flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px]">autorenew</span>
            {t('accounts.autoApplyCatchUpTitle')}
          </p>
          {autoApplyResults.map((r, i) => (
            <p key={`${r.name}-${r.kind}-${i}`} className="text-[11px] text-on-surface">
              {t(r.kind === 'sip' ? 'accounts.sipCatchUpLine' : 'accounts.interestCatchUpLine', { name: r.name, count: r.occurrences, amount: `${getCurrencySymbol(r.currency)}${fromMinorUnits(r.amountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}` })}
            </p>
          ))}
          <button type="button" onClick={() => setAutoApplyResults([])} className="text-[10px] font-bold text-success underline">{t('common.dismiss')}</button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-5 space-y-2">
        <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('accounts.totalAcrossAccounts')}</p>
        <p className="text-2xl font-black text-primary">{getCurrencySymbol(defaultCurrency)}{fromMinorUnits(totalMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        {activeAccounts.length > 0 && (
          <div className="flex gap-4 pt-1 border-t border-border-subtle">
            <div className="flex-1 pt-2">
              <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px] text-primary">link</span>
                {t('accounts.allocatedToGoals')}
              </p>
              <p className="text-sm font-black text-primary">{getCurrencySymbol(defaultCurrency)}{fromMinorUnits(totalAllocatedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="flex-1 pt-2 border-l border-border-subtle pl-4">
              <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{t('accounts.unallocated')}</p>
              <p className="text-sm font-black text-text-muted">{getCurrencySymbol(defaultCurrency)}{fromMinorUnits(totalUnallocatedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
          </div>
        )}
      </div>

      <button type="button" onClick={openAdd} className="w-full py-2.5 rounded-xl border border-primary/20 bg-primary/5 text-primary text-xs font-bold flex items-center justify-center gap-1.5">
        <span className="material-symbols-outlined text-[16px]">add</span>
        {t('accounts.addAccount')}
      </button>
      {activeAccounts.length > 1 && (
        <button type="button" onClick={openTransfer} className="w-full py-2.5 rounded-xl border border-primary/20 bg-primary/5 text-primary text-xs font-bold flex items-center justify-center gap-1.5">
          <span className="material-symbols-outlined text-[16px]">swap_horiz</span>
          {t('accounts.transferFunds')}
        </button>
      )}

      {activeAccounts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-8 text-center space-y-2">
          <span className="text-3xl block">🏦</span>
          <p className="text-sm font-bold text-on-surface">{t('accounts.emptyTitle')}</p>
          <p className="text-xs text-text-muted">{t('accounts.emptyDesc')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {activeAccounts.map((a) => {
            const meta = ACCOUNT_TYPES.find((tp) => tp.id === a.type);
            const unallocatedMinor = accountUnallocatedMinor(a);
            const allocatedPct = accountAllocatedPctTotal(a);
            return (
              <div key={a.id} className="bg-white rounded-xl border border-border-subtle shadow-sm p-3 space-y-2">
                <div role="button" tabIndex={0} onClick={() => openView(a)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openView(a); }} className="w-full flex items-center gap-3 text-left cursor-pointer">
                  <span className="text-xl shrink-0">{meta?.icon || '💰'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{a.name}</p>
                    <p className="text-[10px] text-text-muted truncate">
                      {t(`accounts.type.${a.type}`)}
                      {' · '}
                      {t('accounts.asOf', { date: new Date(a.balanceAsOf || a.updatedAt || a.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}
                    </p>
                    {a.interestRatePct != null && (
                      <p className="text-[10px] text-text-muted truncate">
                        {a.compoundFrequency
                          ? t('accounts.interestRateDisplay', { rate: a.interestRatePct, frequency: t(`accounts.compound.${a.compoundFrequency}`) })
                          : t('accounts.interestRateDisplayNoCompound', { rate: a.interestRatePct })}
                        {a.interestNextDate && ` · ${t('accounts.interestNextDateShort', { date: new Date(a.interestNextDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}`}
                      </p>
                    )}
                    {a.accountNumber && (
                      <button type="button" onClick={(e) => { e.stopPropagation(); toggleRevealAccountNumber(a.id); }} className="text-[10px] text-text-muted flex items-center gap-1 max-w-full">
                        <span className="material-symbols-outlined text-[11px] shrink-0">{revealedAccountIds.has(a.id) ? 'visibility_off' : 'visibility'}</span>
                        <span className="truncate">{revealedAccountIds.has(a.id) ? a.accountNumber : maskAccountNumber(a.accountNumber)}</span>
                      </button>
                    )}
                  </div>
                  <span className="text-sm font-bold text-primary shrink-0">{getCurrencySymbol(a.currency)}{fromMinorUnits(a.currentBalanceMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                {a.contributionFrequency && a.contributionAmountMinor != null && (
                  <div className="pl-9">
                    <p className="text-[10px] font-bold text-primary flex items-center gap-1">
                      <span className="material-symbols-outlined text-[11px]">autorenew</span>
                      {t('accounts.sipBadge', {
                        amount: `${getCurrencySymbol(a.currency)}${fromMinorUnits(a.contributionAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                        frequency: t(`accounts.contributionFrequency.${a.contributionFrequency}`),
                        date: a.contributionNextDate ? new Date(a.contributionNextDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—',
                      })}
                    </p>
                  </div>
                )}
                {(a.nominees || []).length > 0 && (
                  <div className="pl-9">
                    <p className="text-[10px] text-text-muted">
                      {t('accounts.nominees')}: {a.nominees!.map((n) => (a.nominees!.length > 1 ? `${n.name} (${n.pct}%)` : n.name)).join(', ')}
                    </p>
                  </div>
                )}
                {(a.goalAllocations || []).length > 0 && (
                  <div className="pl-9 space-y-0.5">
                    {(a.goalAllocations || []).map((g) => (
                      <p key={g.goalId} className="text-[10px] text-primary font-bold flex items-center gap-0.5">
                        <span className="material-symbols-outlined text-[11px]">link</span>
                        {g.pct}% → {g.goalName}
                      </p>
                    ))}
                  </div>
                )}
                <div className="pl-9">
                  <p className="text-[10px] text-text-muted">
                    {t('accounts.unallocatedAmount', { amount: `${getCurrencySymbol(a.currency)}${fromMinorUnits(unallocatedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, pct: 100 - allocatedPct })}
                  </p>
                </div>
                <div className="flex items-center justify-end gap-1 pt-1 border-t border-border-subtle">
                  <button onClick={() => openShare(a)} className="p-1.5 text-text-muted hover:bg-surface rounded-full" aria-label={t('accounts.shareDetails')}>
                    <span className="material-symbols-outlined text-[16px] block">share</span>
                  </button>
                  <button onClick={() => setHistoryAccount(a)} className="p-1.5 text-text-muted hover:bg-surface rounded-full" aria-label={t('accounts.history')}>
                    <span className="material-symbols-outlined text-[16px] block">history</span>
                  </button>
                  <button onClick={() => openEdit(a)} className="p-1.5 text-text-muted hover:bg-surface rounded-full" aria-label={t('common.edit')}>
                    <span className="material-symbols-outlined text-[16px] block">edit</span>
                  </button>
                  <button onClick={() => { setDeletingAccount(a); setDeleteError(null); }} className="p-1.5 text-text-muted hover:bg-error/10 hover:text-error rounded-full" aria-label={t('common.delete')}>
                    <span className="material-symbols-outlined text-[16px] block">delete</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* --- View account (read-only) --- */}
      {viewAccount && (() => {
        const meta = ACCOUNT_TYPES.find((tp) => tp.id === viewAccount.type);
        const unallocatedMinor = accountUnallocatedMinor(viewAccount);
        const allocatedPct = accountAllocatedPctTotal(viewAccount);
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setViewAccount(null)}>
            <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-black text-primary flex items-center gap-2">
                  <span className="text-xl">{meta?.icon || '💰'}</span> {viewAccount.name}
                </h3>
                <button onClick={() => setViewAccount(null)} className="p-1 text-text-muted hover:bg-surface rounded-full">
                  <span className="material-symbols-outlined text-[18px] block">close</span>
                </button>
              </div>

              <div className="bg-surface rounded-xl p-3 space-y-1">
                <p className="text-2xl font-black text-primary">{getCurrencySymbol(viewAccount.currency)}{fromMinorUnits(viewAccount.currentBalanceMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                <p className="text-[11px] text-text-muted">
                  {t(`accounts.type.${viewAccount.type}`)} · {t('accounts.asOf', { date: new Date(viewAccount.balanceAsOf || viewAccount.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}
                </p>
              </div>

              {viewAccount.accountNumber && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">{t('accounts.accountNumber')}</span>
                  <button type="button" onClick={() => setViewRevealNumber((v) => !v)} className="font-bold text-on-surface flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px]">{viewRevealNumber ? 'visibility_off' : 'visibility'}</span>
                    {viewRevealNumber ? viewAccount.accountNumber : maskAccountNumber(viewAccount.accountNumber)}
                  </button>
                </div>
              )}

              {viewAccount.interestRatePct != null && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">{t('accounts.interestRateOptional')}</span>
                  <span className="font-bold text-on-surface text-right">
                    {viewAccount.compoundFrequency
                      ? t('accounts.interestRateDisplay', { rate: viewAccount.interestRatePct, frequency: t(`accounts.compound.${viewAccount.compoundFrequency}`) })
                      : t('accounts.interestRateDisplayNoCompound', { rate: viewAccount.interestRatePct })}
                    {viewAccount.interestNextDate && ` · ${t('accounts.interestNextDateShort', { date: new Date(viewAccount.interestNextDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}`}
                  </span>
                </div>
              )}

              {viewAccount.contributionFrequency && viewAccount.contributionAmountMinor != null && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">{t('accounts.contributionOptional')}</span>
                  <span className="font-bold text-primary text-right">
                    {t('accounts.sipBadge', {
                      amount: `${getCurrencySymbol(viewAccount.currency)}${fromMinorUnits(viewAccount.contributionAmountMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                      frequency: t(`accounts.contributionFrequency.${viewAccount.contributionFrequency}`),
                      date: viewAccount.contributionNextDate ? new Date(viewAccount.contributionNextDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—',
                    })}
                  </span>
                </div>
              )}

              {(viewAccount.nominees || []).length > 0 && (
                <div className="text-xs">
                  <span className="text-text-muted">{t('accounts.nominees')}: </span>
                  <span className="font-bold text-on-surface">{viewAccount.nominees!.map((n) => (viewAccount.nominees!.length > 1 ? `${n.name} (${n.pct}%)` : n.name)).join(', ')}</span>
                </div>
              )}

              {(viewAccount.goalAllocations || []).length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('accounts.allocateToGoals')}</p>
                  {(viewAccount.goalAllocations || []).map((g) => (
                    <p key={g.goalId} className="text-xs text-primary font-bold flex items-center justify-between">
                      <span className="flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">link</span>{g.goalName}</span>
                      <span>{g.pct}%</span>
                    </p>
                  ))}
                  <p className="text-[11px] text-text-muted">
                    {t('accounts.unallocatedAmount', { amount: `${getCurrencySymbol(viewAccount.currency)}${fromMinorUnits(unallocatedMinor).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, pct: 100 - allocatedPct })}
                  </p>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { const a = viewAccount; setViewAccount(null); openEdit(a); }}
                  className="flex-1 py-2.5 bg-primary text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">edit</span>
                  {t('common.edit')}
                </button>
                <button type="button" onClick={() => setHistoryAccount(viewAccount)} className="flex-1 py-2.5 border border-border-subtle text-text-muted text-xs font-bold rounded-xl flex items-center justify-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">history</span>
                  {t('accounts.history')}
                </button>
                <button type="button" onClick={() => openShare(viewAccount)} className="p-2.5 border border-border-subtle text-text-muted rounded-xl" aria-label={t('accounts.shareDetails')}>
                  <span className="material-symbols-outlined text-[16px] block">share</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- Add/Edit account modal --- */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{editingAccount ? t('accounts.editAccount') : t('accounts.addAccount')}</h3>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('accounts.namePlaceholder')} autoFocus
              className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex flex-wrap gap-1.5">
              {ACCOUNT_TYPES.map((tp) => (
                <button
                  key={tp.id} type="button" onClick={() => setType(tp.id)}
                  className={clsx('px-3 py-2 rounded-xl text-xs font-bold border flex items-center gap-1', type === tp.id ? 'border-primary bg-primary/10 text-primary' : 'border-border-subtle text-text-muted')}
                >
                  <span>{tp.icon}</span>{t(`accounts.type.${tp.id}`)}
                </button>
              ))}
            </div>
            <input
              type="text" value={accountNumberInput} onChange={(e) => setAccountNumberInput(e.target.value)} placeholder={t('accounts.accountNumberPlaceholder')}
              className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{getCurrencySymbol(currency)}</span>
                <input
                  type="text" inputMode="decimal" value={balanceInput} onChange={(e) => setBalanceInput(e.target.value)}
                  placeholder={editingAccount ? t('accounts.balancePlaceholder') : t('accounts.startingBalancePlaceholder')}
                  className="w-full h-12 bg-surface pl-8 pr-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-24 h-12 bg-surface px-2 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none">
                {Array.from(new Set([currency, 'INR', 'USD', 'EUR', 'GBP'])).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {!editingAccount && <p className="text-[11px] text-text-muted">{t('accounts.startingBalanceNote')}</p>}

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.nomineesOptional')}</label>
              <div className="space-y-2">
                {nominees.map((nom, idx) => (
                  <div key={idx} className="flex items-center gap-2 bg-surface rounded-xl p-2.5">
                    <input
                      type="text" value={nom.name} placeholder={t('accounts.nomineeNamePlaceholder')}
                      onChange={(e) => setNominees(nominees.map((n, i) => (i === idx ? { ...n, name: e.target.value } : n)))}
                      className="flex-1 h-9 bg-white border border-border-subtle rounded-lg px-2.5 text-xs font-bold text-on-surface outline-none min-w-0"
                    />
                    {nominees.length > 1 && (
                      <>
                        <input
                          type="text" inputMode="numeric" value={nom.pct || 0}
                          onChange={(e) => setNominees(nominees.map((n, i) => (i === idx ? { ...n, pct: Math.max(0, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, '')) || 0)) } : n)))}
                          className="w-12 h-9 text-center bg-white border border-border-subtle rounded-lg font-black text-primary text-xs outline-none shrink-0"
                        />
                        <span className="text-[10px] font-bold text-text-muted shrink-0">%</span>
                      </>
                    )}
                    <button type="button" onClick={() => setNominees(nominees.filter((_, i) => i !== idx))} className="p-1 text-text-muted hover:text-error shrink-0">
                      <span className="material-symbols-outlined text-[16px] block">close</span>
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button" onClick={() => setNominees([...nominees, { name: '', pct: 0 }])}
                className="w-full py-2 rounded-lg text-xs font-bold text-primary border border-dashed border-primary/30 hover:bg-primary/5 transition-colors"
              >
                + {t('accounts.addNominee')}
              </button>
              {nominees.length > 1 && (
                <p className={clsx('text-[11px] font-bold text-center', nomineeTotal !== 100 ? 'text-error' : 'text-text-muted')}>
                  {t('accounts.nomineeAllocationTotal', { pct: nomineeTotal })}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.balanceAsOf')}</label>
              <input
                type="date" value={balanceAsOf} max={todayLocalDateString()} onChange={(e) => setBalanceAsOf(e.target.value)}
                className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.interestRateOptional')}</label>
              <div className="relative">
                <input
                  type="text" inputMode="decimal" value={interestRateInput} onChange={(e) => setInterestRateInput(e.target.value)}
                  placeholder="e.g. 6.5" className="w-full h-12 bg-surface pr-8 pl-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">%</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.compoundFrequencyLabel')}</label>
              <select
                value={compoundFrequency}
                onChange={(e) => {
                  const freq = e.target.value as CompoundFrequency | '';
                  setCompoundFrequency(freq);
                  if (freq && !interestNextDateInput) setInterestNextDateInput(todayLocalDateString());
                }}
                className="w-full h-12 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none"
              >
                <option value="">{t('accounts.compoundFrequencyNone')}</option>
                {COMPOUND_FREQUENCIES.map((f) => <option key={f.id} value={f.id}>{t(`accounts.compound.${f.id}`)}</option>)}
              </select>
              {compoundFrequency && (
                <div className="space-y-1 pt-1">
                  <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.interestNextDate')}</label>
                  <input
                    type="date" value={interestNextDateInput} onChange={(e) => setInterestNextDateInput(e.target.value)}
                    className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <p className="text-[11px] text-text-muted px-1">{t('accounts.interestNextDateHint')}</p>
                </div>
              )}
              <p className="text-[11px] text-text-muted px-1">{compoundFrequency ? t('accounts.interestAutoApplyNote') : t('accounts.interestRateNote')}</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.contributionOptional')}</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">{getCurrencySymbol(currency)}</span>
                  <input
                    type="text" inputMode="decimal" value={contributionAmountInput} onChange={(e) => setContributionAmountInput(e.target.value)}
                    placeholder={t('accounts.contributionAmountPlaceholder')}
                    className="w-full h-12 bg-surface pl-8 pr-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <select
                  value={contributionFrequency}
                  onChange={(e) => {
                    const freq = e.target.value as ContributionFrequency | '';
                    setContributionFrequency(freq);
                    if (freq && !contributionNextDateInput) setContributionNextDateInput(todayLocalDateString());
                  }}
                  className="w-32 h-12 bg-surface px-2 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none"
                >
                  <option value="">{t('accounts.contributionFrequencyNone')}</option>
                  {CONTRIBUTION_FREQUENCIES.map((f) => <option key={f.id} value={f.id}>{t(`accounts.contributionFrequency.${f.id}`)}</option>)}
                </select>
              </div>
              {contributionFrequency && (
                <input
                  type="date" value={contributionNextDateInput} onChange={(e) => setContributionNextDateInput(e.target.value)}
                  className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              )}
              <p className="text-[11px] text-text-muted px-1">{t('accounts.contributionNote')}</p>
            </div>
            {linkableGoals.length > 0 && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => setAllocSectionExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-1"
                >
                  <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('accounts.allocateToGoals')}</span>
                  <span className="flex items-center gap-1 text-[10px] font-bold text-primary">
                    {allocTotal > 0 && `${allocTotal}%`}
                    <span className={clsx('material-symbols-outlined text-[16px] transition-transform', allocSectionExpanded && 'rotate-180')}>expand_more</span>
                  </span>
                </button>
                {allocSectionExpanded && (
                  <>
                    <div className="space-y-2">
                      {linkableGoals.map((g: any) => (
                        <div key={g.id} className="flex items-center gap-2 bg-surface rounded-xl p-2.5">
                          <span className="text-lg shrink-0">{g.icon || '🎯'}</span>
                          <span className="flex-1 text-xs font-bold text-on-surface truncate">{g.name}</span>
                          <input
                            type="text" inputMode="numeric" value={allocPcts[g.id] || 0}
                            onChange={(e) => setAllocPcts({ ...allocPcts, [g.id]: Math.max(0, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, '')) || 0)) })}
                            className="w-14 h-9 text-center bg-white border border-border-subtle rounded-lg font-black text-primary text-sm outline-none"
                          />
                          <span className="text-xs font-bold text-text-muted">%</span>
                        </div>
                      ))}
                    </div>
                    <p className={clsx('text-[11px] font-bold text-center', allocTotal > 100 ? 'text-error' : 'text-text-muted')}>
                      {t('accounts.allocationTotal', { pct: allocTotal })}
                    </p>
                    <p className="text-[11px] text-text-muted px-1">{t('accounts.allocationNote')}</p>
                  </>
                )}
              </div>
            )}
            {formError && <p className="text-xs text-error font-bold">{formError}</p>}
            <div className="flex gap-2">
              <button onClick={() => setShowForm(false)} disabled={saving} className="flex-1 py-3 border border-border-subtle text-text-muted font-bold rounded-xl disabled:opacity-50">
                {t('common.cancel')}
              </button>
              <button onClick={handleSaveAccount} disabled={saving} className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
                {saving ? t('goals.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- Transfer funds modal --- */}
      {showTransfer && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setShowTransfer(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('accounts.transferFunds')}</h3>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.fromAccount')}</label>
              <select
                value={transferFrom}
                onChange={(e) => {
                  const val = e.target.value;
                  setTransferFrom(val);
                  if (val === transferTo) setTransferTo(activeAccounts.find((a) => a.id !== val)?.id || '');
                }}
                className="w-full h-12 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none"
              >
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({getCurrencySymbol(a.currency)}{fromMinorUnits(a.currentBalanceMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })})</option>
                ))}
              </select>
            </div>

            <div className="flex justify-center">
              <span className="material-symbols-outlined text-text-muted">arrow_downward</span>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.toAccount')}</label>
              <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="w-full h-12 bg-surface px-3 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none">
                {activeAccounts.filter((a) => a.id !== transferFrom).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({getCurrencySymbol(a.currency)}{fromMinorUnits(a.currentBalanceMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })})</option>
                ))}
              </select>
            </div>

            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-text-muted">
                {getCurrencySymbol(activeAccounts.find((a) => a.id === transferFrom)?.currency)}
              </span>
              <input
                type="text" inputMode="decimal" value={transferAmountInput} onChange={(e) => setTransferAmountInput(e.target.value)}
                placeholder={t('accounts.amountToTransfer')}
                className="w-full h-12 bg-surface pl-8 pr-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('accounts.transferDate')}</label>
              <input
                type="date" value={transferDate} max={todayLocalDateString()} onChange={(e) => setTransferDate(e.target.value)}
                className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <ImageAttachments images={transferProofImages} onChange={setTransferProofImages} label={t('accounts.attachProof')} maxImages={2} />

            {transferError && <p className="text-xs text-error font-bold">{transferError}</p>}
            <button onClick={handleTransfer} disabled={transferring} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {transferring ? t('goals.saving') : t('accounts.transferFunds')}
            </button>
          </div>
        </div>
      )}

      {/* --- Share account details --- */}
      {shareAccount && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setShareAccount(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-black text-primary">{t('accounts.shareDetailsFor', { name: shareAccount.name })}</h3>

            <div className="space-y-2">
              {shareAccount.accountNumber && (
                <label className="flex items-center gap-2 text-xs font-bold text-on-surface">
                  <input type="checkbox" checked={shareIncludeNumber} onChange={(e) => setShareIncludeNumber(e.target.checked)} className="w-4 h-4" />
                  {t('accounts.shareIncludeFullNumber')}
                </label>
              )}
              <label className="flex items-center gap-2 text-xs font-bold text-on-surface">
                <input type="checkbox" checked={shareIncludeBalance} onChange={(e) => setShareIncludeBalance(e.target.checked)} className="w-4 h-4" />
                {t('accounts.shareIncludeBalance')}
              </label>
            </div>

            <pre className="w-full bg-surface rounded-xl p-3 text-xs text-on-surface whitespace-pre-wrap font-sans">{shareText_(shareAccount)}</pre>

            {shareResult && <p className="text-xs text-success font-bold">{shareResult}</p>}
            <button onClick={handleShare} className="w-full py-3 bg-primary text-white font-bold rounded-xl flex items-center justify-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">share</span>
              {t('accounts.shareDetails')}
            </button>
            <button onClick={() => setShareAccount(null)} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}

      {/* --- "Why are we asking for this?" explainer --- */}
      {showInfo && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setShowInfo(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-2xl">info</span>
              <h3 className="text-base font-black text-primary">{t('accounts.whyWeAsk')}</h3>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('accounts.whyTitle')}</p>
              <p className="text-sm text-on-surface leading-relaxed">{t('accounts.whyBody')}</p>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('accounts.howUsedTitle')}</p>
              <ul className="text-sm text-on-surface leading-relaxed list-disc pl-4 space-y-1">
                <li>{t('accounts.howUsed1')}</li>
                <li>{t('accounts.howUsed2')}</li>
                <li>{t('accounts.howUsed3')}</li>
              </ul>
            </div>

            <div className="bg-success/10 border border-success/30 rounded-xl p-3 space-y-1">
              <p className="text-xs font-black text-success flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">lock</span>
                {t('accounts.privacyTitle')}
              </p>
              <p className="text-xs text-on-surface leading-relaxed">{t('accounts.privacyBody')}</p>
            </div>

            <button onClick={() => setShowInfo(false)} className="w-full py-3 bg-primary text-white font-bold rounded-xl">
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {/* --- Account history --- */}
      {historyAccount && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setHistoryAccount(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-primary">{t('accounts.historyFor', { name: historyAccount.name })}</h3>
              <button onClick={() => setHistoryAccount(null)} className="p-1 text-text-muted hover:bg-surface rounded-full">
                <span className="material-symbols-outlined text-[18px] block">close</span>
              </button>
            </div>
            {logEntries.length === 0 ? (
              <p className="text-xs text-text-muted text-center py-6">{t('accounts.noHistoryYet')}</p>
            ) : (
              <div className="space-y-2">
                {logEntries.map((e) => (
                  <div key={e.id} className="bg-surface rounded-xl p-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-text-muted">{(e.createdAt || '').slice(0, 16).replace('T', ' ')} · {e.createdByName}</span>
                      <span className="text-xs font-bold text-primary">
                        {getCurrencySymbol(historyAccount.currency)}{fromMinorUnits(e.balanceBeforeMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        {' → '}
                        {getCurrencySymbol(historyAccount.currency)}{fromMinorUnits(e.balanceAfterMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    {e.allocationChanges.filter((c: any) => c.beforePct !== c.afterPct).map((c: any, i: number) => (
                      <p key={i} className="text-[10px] text-text-muted">
                        {c.goalName}: {c.beforePct}% ({getCurrencySymbol(historyAccount.currency)}{fromMinorUnits(c.beforeAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })})
                        {' → '}
                        {c.afterPct}% ({getCurrencySymbol(historyAccount.currency)}{fromMinorUnits(c.afterAmountMinor).toLocaleString(undefined, { maximumFractionDigits: 0 })})
                      </p>
                    ))}
                    {e.images?.length > 0 && (
                      <div className="flex gap-1.5 pt-1">
                        {e.images.map((src: string, i: number) => (
                          <button key={i} type="button" onClick={() => setHistoryLightbox(src)} className="w-12 h-12 rounded-lg overflow-hidden border border-border-subtle shrink-0">
                            <img src={src} alt="" className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setHistoryAccount(null)} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
      {historyLightbox && <ImageLightbox src={historyLightbox} onClose={() => setHistoryLightbox(null)} />}

      {/* --- Delete account confirmation --- */}
      {deletingAccount && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !deleting && setDeletingAccount(null)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 text-center max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-error text-4xl">warning</span>
            <p className="text-sm text-on-surface">{t('accounts.confirmDelete', { name: deletingAccount.name })}</p>
            {deleteError && <p className="text-xs text-error font-bold">{deleteError}</p>}
            <button onClick={handleDeleteAccount} disabled={deleting} className="w-full py-3 bg-error text-white font-bold rounded-xl disabled:opacity-50">
              {deleting ? t('goals.saving') : t('accounts.deleteAccount')}
            </button>
            <button onClick={() => setDeletingAccount(null)} disabled={deleting} className="w-full py-2 text-xs font-bold text-text-muted">{t('common.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
