import React, { useState } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db, trackEvent } from '../lib/firebase';
import { collection, query, where, doc, setDoc, updateDoc, increment, getDoc, arrayRemove } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { motion, AnimatePresence } from 'motion/react';
import { clsx } from 'clsx';
import { updateGlobalStats } from '../services/statsService';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { fireWrite } from '../lib/offlineWrite';
import { claimPoints } from '../lib/pointsApi';
import AmountKeypad from '../components/AmountKeypad';
import ImageAttachments from '../components/ImageAttachments';
import FrequencyPicker from '../components/FrequencyPicker';
import { FrequencyConfig, nextOccurrenceAfter, sanitizeFrequencyConfig } from '../lib/frequency';
import { todayLocalDateString, currentLocalMonthKey } from '../lib/dateUtils';
import { getParentPath } from '../lib/navigationParents';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { markExpenseAdded } from '../lib/recentlyAddedExpenses';
import AddFamilyMemberPrompt from '../components/AddFamilyMemberPrompt';

import { getCurrencySymbol, EXPENSE_CATEGORIES, INCOME_CATEGORIES, getCategoryClassification } from '../lib/constants';
import { useLanguage } from '../context/LanguageContext';

const CATEGORIES = EXPENSE_CATEGORIES;

export default function AddExpense() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const handleClose = () => navigate(getParentPath(location.pathname));

  // Pre-fills from a poke, expense-reminder notification tap, or a group tile's own "Add
  // Expense" icon (see pushNotifications.ts / Dashboard.tsx) — all link here as
  // /add-expense?groupId=...&category=...&amount=.... A groupId arriving this way locks the
  // group (no picker shown) since the caller already made that choice; everything else given
  // is filled in, the rest left for the user to complete.
  const [groupId, setGroupId] = useState(() => searchParams.get('groupId') || '');
  const [groupLocked, setGroupLocked] = useState(() => !!searchParams.get('groupId'));
  const [amount, setAmount] = useState(() => searchParams.get('amount') || '');
  const [description, setDescription] = useState(() => searchParams.get('description') || '');
  const [entryType, setEntryType] = useState<'expense' | 'income'>('expense');
  const [category, setCategory] = useState(() => searchParams.get('category') || 'food');
  const paymentMethod = 'cash';
  const [date, setDate] = useState(todayLocalDateString());
  const [loading, setLoading] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [showSuccess, setShowSuccess] = useState(false);
  // Invite-flow spec's second trigger: same one-tap invite prompt as CreateGroup.tsx's
  // ?justCreated=1, fired instead on a user's genuinely first-ever LOGGED expense (detected below
  // via profile.lastExpenseAddedAt being unset going into this save — already-active users never
  // trigger it again, since that field is long since set for them).
  const [invitePromptGroupId, setInvitePromptGroupId] = useState<string | null>(null);
  const [closeAfterInvitePrompt, setCloseAfterInvitePrompt] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);

  const [paidBy, setPaidBy] = useState('');
  const [splitMembers, setSplitMembers] = useState<string[]>([]);
  const [splitType, setSplitType] = useState<'equally' | 'percentage' | 'amount'>('equally');
  const [memberSplits, setMemberSplits] = useState<Record<string, number>>({});
  const [images, setImages] = useState<string[]>([]);

  // Optional "also make this recurring" — creates a normal recurringExpenses rule (same schema
  // RecurringExpenses.tsx writes) alongside the one-time entry being saved right now, so a user
  // doesn't have to separately visit Recurring Expenses to set up next month's rent right after
  // paying this month's. Expense-only (recurringExpenses has no income variant) — the toggle is
  // hidden entirely for entryType 'income'. Defaults dayOfMonth to today's date, since the rule
  // is most often meant to repeat "this same day, going forward."
  const [makeRecurring, setMakeRecurring] = useState(false);
  const [recurFreqConfig, setRecurFreqConfig] = useState<FrequencyConfig>(() => ({ frequency: 'monthly', dayOfMonth: new Date().getDate() }));
  const [isFavorite, setIsFavorite] = useState(false);

  // A "Scheduled" expense reminder (ExpenseReminders.tsx) can carry preset photos, but those are
  // base64 data URIs — too large for a push payload or URL query string — so only the reminder's
  // own doc id arrives via ?reminderId=..., and this fetches it once to pull presetImages in.
  const reminderId = searchParams.get('reminderId');
  React.useEffect(() => {
    if (!reminderId) return;
    getDoc(doc(db, 'expenseReminders', reminderId))
      .then((snap) => {
        const presetImages = snap.data()?.presetImages;
        if (Array.isArray(presetImages) && presetImages.length > 0) setImages(presetImages);
      })
      .catch((err) => console.error('Failed to load reminder preset photo:', err));
  }, [reminderId]);

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null
  );

  const memberships = membershipsValue?.docs.map(doc => doc.data()) || [];
  const groupIds = memberships.map((m: any) => m.groupId);

  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null
  );

  const groups = groupsValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[];
  // Archived groups stay fully usable if one is already selected (a deep link, or a favorite that
  // happened to get archived later) — only the picker's own option list hides them, so you can't
  // newly pick one to log an expense against.
  const selectableGroups = groups.filter((g: any) => !g.archived);

  React.useEffect(() => {
    if (groups.length === 1 && !groupId) {
      setGroupId(groups[0].id);
    }
  }, [groups, groupId]);

  const [groupMembersValue] = useCollection(
    groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null
  );
  const groupMembers = groupMembersValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[];

  // A "settle up" deep link from Settlements.tsx's who-owes-who view or a payment-reminder tap
  // (see server.ts's /api/settlement-reminder and pushNotifications.ts/FeedList.tsx's
  // `settlement_reminder` routing) — arrives as ?settleWith=<uid>&amount=<debt>&groupId=<id>.
  // Rather than the usual "split equally among everyone," the whole amount goes to just that one
  // person: paidBy defaults to the signer-in (the person paying back, matching the default below),
  // and the single split target IS the person being paid, for exactly the debt amount — recording
  // this expense nets their balance back toward zero, the same shape a real settlement takes.
  const settleWith = searchParams.get('settleWith');
  React.useEffect(() => {
    if (user && !paidBy) {
      setPaidBy(user.uid);
    }
    if (groupMembers.length > 0 && splitMembers.length === 0) {
      if (settleWith) {
        setSplitType('amount');
        setSplitMembers([settleWith]);
        setMemberSplits({ [settleWith]: parseFloat(amount) || 0 });
      } else {
        setSplitMembers(groupMembers.map(m => m.userId));
      }
    }
  }, [user, paidBy, groupMembers, splitMembers, settleWith, amount]);


  const selectedGroup = groups.find(g => g.id === groupId);
  // Blank (not a "$" default) until a group is actually selected, since there's no currency
  // to show yet — getCurrencySymbol()'s own "$" fallback is meant for contexts that always
  // have a group, which isn't true here before the user's picked one.
  const currencySymbol = groupId ? getCurrencySymbol(selectedGroup?.currency) : '';
  const evaluatedAmount = evaluateAmountSum(amount);
  const activeCategories = entryType === 'income' ? INCOME_CATEGORIES : CATEGORIES;

  // Income isn't split, and its categories are a different list — switching type resets the
  // category to the new list's first option (skipped on initial mount, so a category arriving
  // via ?category=... from a poke/reminder link isn't immediately clobbered), and switching to
  // a group without income tracking enabled falls back to 'expense' so the form never gets
  // stuck in an unreachable state.
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setCategory(activeCategories[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryType]);
  React.useEffect(() => {
    if (!selectedGroup?.incomeEnabled) setEntryType('expense');
  }, [selectedGroup?.incomeEnabled]);

  // Shows the group's remaining monthly budget as the amount is typed, so members see the
  // impact of what they're about to add before submitting.
  const monthKey = currentLocalMonthKey();
  const [budgetValue] = useDocument(groupId ? doc(db, 'groupBudgets', `${groupId}_${monthKey}`) : null);
  const budget = budgetValue?.data();
  const [groupExpensesForBudgetValue] = useCollection(
    groupId ? query(collection(db, 'expenses'), where('groupId', '==', groupId)) : null
  );
  // Budget tracks spending only — income entries are excluded outright rather than netted
  // against spend (matching the same fix in Dashboard.tsx/ManageGroup.tsx's budget bars), so
  // logging income this month can't make the live remaining-budget preview look more under
  // control than it actually is.
  const monthSpendSoFar = React.useMemo(() => {
    return (groupExpensesForBudgetValue?.docs || [])
      .map((d) => d.data())
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey) && e.type !== 'income')
      .reduce((sum, e: any) => sum + (e.amount || 0), 0);
  }, [groupExpensesForBudgetValue, monthKey]);
  // Same idea, scoped to whichever category is currently selected — only meaningful if that
  // category actually has a % of the budget set aside for it (ManageGroup's Split by Category);
  // otherwise there's no per-category cap to preview against.
  const categoryBudgetPct = (budget?.categoryAllocations as Record<string, number> | undefined)?.[category] || 0;
  const categorySpendSoFar = React.useMemo(() => {
    return (groupExpensesForBudgetValue?.docs || [])
      .map((d) => d.data())
      .filter((e: any) => typeof e.date === 'string' && e.date.startsWith(monthKey) && e.type !== 'income' && e.category === category)
      .reduce((sum, e: any) => sum + (e.amount || 0), 0);
  }, [groupExpensesForBudgetValue, monthKey, category]);

  // Browse-and-reuse favorites — shared across every group the user belongs to (any member's
  // favorite, `favoritedBy` non-empty, regardless of WHICH member(s) starred it or who originally
  // added the underlying expense), so this needs to work even before a group is picked here — a
  // per-selected-group query (like the budget one above) would show nothing until then. Firestore
  // caps `in` at 30 values; not chunked further here, matching how this app's other "across all my
  // groups" queries (e.g. GroupExpenses.tsx's "all groups" view) already handle that same cap.
  const [favoritesValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'expenses'), where('groupId', 'in', groupIds.slice(0, 30))) : null,
  );
  const favorites = React.useMemo(() => {
    const favs = (favoritesValue?.docs || [])
      .map((d) => ({ id: d.id, ...d.data() } as any))
      .filter((exp) => (exp.favoritedBy || []).length > 0)
      // Once a group is picked, narrow to just that group's favorites — browsing across every
      // group is only useful before you've committed to one.
      .filter((exp) => !groupId || exp.groupId === groupId);
    return favs.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0, 20);
  }, [favoritesValue, groupId]);
  const [showFavorites, setShowFavorites] = useState(false);

  const handlePickFavorite = (fav: any) => {
    setDescription(fav.description || '');
    setAmount(fav.amount != null ? String(fav.amount) : '');
    // A favorited income entry needs the type switched too, or its category id (drawn from
    // INCOME_CATEGORIES) won't match anything in the expense category grid this leaves active.
    setEntryType(fav.type === 'income' ? 'income' : 'expense');
    if (fav.category) setCategory(fav.category);
    // Respects the same lock a deep-linked groupId already imposes elsewhere in this form — a
    // favorite from a different group shouldn't silently reassign where a poke/reminder link was
    // explicitly pointed.
    if (!groupLocked && fav.groupId) setGroupId(fav.groupId);
    setShowFavorites(false);
  };

  // "Delete" here means removing MY OWN vote from this shared favorite (same as the star toggle
  // everywhere else in the app) — if other members still have it starred, it correctly stays
  // visible to them; it only fully disappears once nobody has it favorited any more.
  const handleRemoveFavorite = async (fav: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    try {
      await updateDoc(doc(db, 'expenses', fav.id), { favoritedBy: arrayRemove(user.uid) });
    } catch (err) {
      console.error('Failed to remove favorite:', err);
    }
  };

  // Description autocomplete — reuses the SAME query already loaded for the budget-remaining
  // calculation above (all of this group's expenses), so this costs nothing extra to add.
  const historicDescriptions = React.useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    (groupExpensesForBudgetValue?.docs || []).forEach((d) => {
      const desc = (d.data() as any).description;
      if (!desc || seen.has(desc.toLowerCase())) return;
      seen.add(desc.toLowerCase());
      list.push(desc);
    });
    return list;
  }, [groupExpensesForBudgetValue]);
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const descriptionSuggestions = React.useMemo(() => {
    const typed = description.trim().toLowerCase();
    if (!typed) return [];
    return historicDescriptions
      .filter((d) => d.toLowerCase().includes(typed) && d.toLowerCase() !== typed)
      .slice(0, 5);
  }, [description, historicDescriptions]);

  // `keepOpen` (Save & Add More) resets the form and stays on this screen for another entry;
  // otherwise (plain Save) it closes back to wherever this screen was opened from right after —
  // either way, markExpenseAdded() below hands the just-saved id off to Dashboard.tsx so the
  // group tile can highlight it (and auto-expand to show it) the moment the user actually gets
  // back there, whether that's this same save or after several more "Save & Add More" rounds.
  const handleSave = async (keepOpen: boolean) => {
    if (loading || !user) return;
    const nextErrors: Record<string, string> = {};
    if (!amount || !evaluatedAmount || evaluatedAmount <= 0) nextErrors.amount = t('addExpense.errorAmount');
    if (!groupId) nextErrors.group = t('addExpense.errorGroup');
    if (!description.trim()) nextErrors.description = t('addExpense.errorDescription');
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const isIncome = entryType === 'income';
    const isFirstExpenseEver = !isIncome && !profile?.lastExpenseAddedAt && !profile?.hasSeenFirstExpenseInvitePrompt;

    if (!isIncome && selectedGroup?.splitEnabled) {
      if (splitMembers.length === 0) {
        alert('Please select at least one member to split with');
        return;
      }
      if (splitType === 'percentage') {
        if (splitMembers.some((uid) => (memberSplits[uid] || 0) < 0)) {
          alert('Split percentages cannot be negative.');
          return;
        }
        const totalPct = splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0);
        if (Math.abs(totalPct - 100) > 0.001) {
          alert(`Total percentage must be exactly 100%. Current: ${totalPct}%`);
          return;
        }
      } else if (splitType === 'amount') {
        if (splitMembers.some((uid) => (memberSplits[uid] || 0) < 0)) {
          alert('Split amounts cannot be negative.');
          return;
        }
        const totalAmt = splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0);
        const parsedAmount = evaluatedAmount;
        if (Math.abs(totalAmt - parsedAmount) > 0.01) {
          alert(`Total split amount must equal the expense amount (${currencySymbol}${parsedAmount.toFixed(2)}). Current split total: ${currencySymbol}${totalAmt.toFixed(2)}`);
          return;
        }
      }
    }

    setLoading(true);
    try {
      // No transaction: transaction.get() requires a live server round trip and simply cannot
      // run at all while offline. Firestore write promises (setDoc/updateDoc) also don't resolve
      // until the server acks them — even though the write is already durably queued locally —
      // so they're fired via fireWrite() instead of awaited, letting this screen reset its
      // loading state and show success immediately rather than hanging until back online. The
      // group total uses increment() instead of a computed absolute value specifically so it
      // doesn't need to read the current total first — increments apply correctly server-side
      // regardless of what order multiple offline-queued expenses from different devices
      // eventually arrive in, which a read-then-write transaction can't offer offline anyway.
      const groupRef = doc(db, 'groups', groupId);
      const expenseRef = doc(collection(db, 'expenses'));
      const activityRef = doc(collection(db, 'activities'));

      const expenseDoc: any = {
        groupId,
        amount: evaluatedAmount,
        description,
        category,
        date,
        paidBy: paidBy || user.uid,
        paymentMethod,
        addedBy: user.uid,
        type: entryType,
        createdAt: new Date().toISOString(),
        favoritedBy: isFavorite ? [user.uid] : [],
        ...(images.length > 0 ? { images } : {}),
      };

      if (!isIncome && selectedGroup?.splitEnabled) {
        let splits: any[] = [];
        const totalAmount = evaluatedAmount;

        if (splitType === 'equally') {
          const share = totalAmount / splitMembers.length;
          splits = splitMembers.map(uid => ({ userId: uid, amount: share }));
        } else if (splitType === 'amount') {
          splits = splitMembers.map(uid => ({ userId: uid, amount: memberSplits[uid] || 0 }));
        } else if (splitType === 'percentage') {
          splits = splitMembers.map(uid => ({
            userId: uid,
            percentage: memberSplits[uid] || 0,
            amount: (totalAmount * (memberSplits[uid] || 0)) / 100
          }));
        }

        expenseDoc.splitInfo = {
          splitType,
          splits
        };
      }

      fireWrite(
        setDoc(expenseRef, expenseDoc).then(() => {
          if (entryType === 'expense') claimPoints('expense_logged', { expenseId: expenseRef.id });
        }),
        'add expense',
      );
      trackEvent(isIncome ? 'income_added' : 'expense_added', { category, value: evaluatedAmount });
      // expenseRef.id is already known client-side (doc() generates it locally before the write
      // even lands) — no need to wait on fireWrite's promise for this hand-off.
      markExpenseAdded(groupId, expenseRef.id);

      // Income is tracked on a separate `totalIncome` field rather than folded (signed) into
      // `totalSpending` — that field is read/written in many places across this app (Dashboard,
      // ManageGroup, GroupExpenses' edit/delete/move flows, GroupAnalysisSummary), and giving it a
      // new "can go negative, means net inflow" meaning everywhere would be a much larger and
      // riskier change than keeping it as a plain expense total and having the few screens that
      // need "spend net of income" (per the chosen income scope) subtract totalIncome at display/
      // calc time instead.
      fireWrite(updateDoc(groupRef, {
        totalSpending: increment(isIncome ? 0 : evaluatedAmount),
        totalIncome: increment(isIncome ? evaluatedAmount : 0),
      }), 'update group total');

      fireWrite(setDoc(activityRef, {
        groupId,
        userId: user.uid,
        userName: profile?.displayName || user.displayName || 'Someone',
        userPhoto: profile?.photoURL || user.photoURL || '',
        type: isIncome ? 'add_income' : 'add_expense',
        description: `${user.displayName || 'Someone'} ${isIncome ? 'added income' : 'added an expense'}: ${description}`,
        data: {
          amount: evaluatedAmount,
          description,
          groupName: selectedGroup?.name,
          currencySymbol,
          currencyCode: selectedGroup?.currency
        },
        createdAt: new Date().toISOString()
      }), 'log expense activity');

      // Update global stats — income isn't spend, so it doesn't count toward the platform-wide
      // "expenses logged" / "value tracked" figures (see About.tsx's Platform Scale stats).
      if (!isIncome) {
        updateGlobalStats({ expenses: 1, amount: evaluatedAmount }).catch((err) => console.error('updateGlobalStats failed:', err));
      }

      // Used by the "haven't logged a spend in 2 days" reminder job.
      setDoc(doc(db, 'users', user.uid), { lastExpenseAddedAt: new Date().toISOString() }, { merge: true }).catch(
        (err) => console.error('lastExpenseAddedAt update failed:', err),
      );
      notifyGroupActivity({
        groupId,
        action: isIncome ? 'income_added' : 'added',
        description,
        amount: evaluatedAmount,
        actorName: profile?.displayName || user.displayName || 'Someone',
      });

      // "Also make this recurring" — the rule's first run is the next occurrence STRICTLY AFTER
      // today (nextOccurrenceAfter, not firstOccurrenceOnOrAfter), since today's instance is the
      // one-time entry already written above; using firstOccurrenceOnOrAfter here could land back
      // on today and double-charge this same expense on the very next cron run.
      if (makeRecurring) {
        const recurringRef = doc(collection(db, 'recurringExpenses'));
        const nextRunDate = nextOccurrenceAfter(recurFreqConfig, new Date()).toISOString();
        const recurringDoc: any = {
          userId: user.uid,
          groupId,
          type: entryType,
          category,
          description,
          amount: evaluatedAmount,
          ...sanitizeFrequencyConfig(recurFreqConfig),
          nextRunDate,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          active: true,
          createdAt: new Date().toISOString(),
          ...(images.length > 0 ? { images } : {}),
        };
        if (!isIncome && selectedGroup?.splitEnabled) {
          recurringDoc.splitType = splitType;
          recurringDoc.splitMembers = splitMembers;
          recurringDoc.memberSplits = memberSplits;
        }
        fireWrite(setDoc(recurringRef, recurringDoc), 'add recurring expense rule');
        notifyGroupActivity({
          groupId,
          action: 'recurring_created',
          description: description || CATEGORIES.find((c) => c.id === category)?.name,
          amount: evaluatedAmount,
          actorName: profile?.displayName || user.displayName || 'Someone',
        });
      }

      setShowSuccess(true);
      setAmount('');
      setDescription('');
      setImages([]);
      setMakeRecurring(false);
      setIsFavorite(false);
      setFormErrors({});

      setTimeout(() => setShowSuccess(false), 3000);

      if (isFirstExpenseEver) {
        setInvitePromptGroupId(groupId);
        setCloseAfterInvitePrompt(!keepOpen);
      } else if (!keepOpen) {
        handleClose();
      }
    } catch (error) {
      console.error('Error saving expense:', error);
      alert('Failed to save expense');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[85] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative w-full sm:max-w-lg sm:max-h-[85vh] h-[92vh] sm:h-auto bg-surface text-on-surface rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] bg-success text-white px-6 py-3 rounded-2xl font-bold shadow-2xl flex items-center gap-2 whitespace-nowrap"
          >
            <span className="material-symbols-outlined">check_circle</span>
            {entryType === 'income' ? t('addExpense.incomeAddedSuccess') : t('addExpense.expenseAddedSuccess')}
          </motion.div>
        )}
      </AnimatePresence>

      <header className="px-4 py-2 border-b border-border-subtle bg-white flex justify-between items-center shrink-0">
        <button
          type="button"
          onClick={() => setIsFavorite((v) => !v)}
          className={clsx('w-9 h-9 flex items-center justify-center rounded-full transition-colors', isFavorite ? 'text-warning' : 'text-text-muted/40 hover:text-text-muted')}
          aria-label={isFavorite ? t('addExpense.removeFavorite') : t('addExpense.markFavorite')}
          title={isFavorite ? t('addExpense.removeFavorite') : t('addExpense.markFavorite')}
        >
          <span className="material-symbols-outlined text-[20px] block" style={{ fontVariationSettings: `'FILL' ${isFavorite ? 1 : 0}` }}>
            star
          </span>
        </button>
        <h1 className="text-lg font-bold text-primary">{t('addExpense.addExpenseIncome')}</h1>
        <button onClick={handleClose} className="p-1.5 hover:bg-surface rounded-full text-text-muted" aria-label={t('common.close')}>
          <span className="material-symbols-outlined text-[22px]">close</span>
        </button>
      </header>

      <div
        className={clsx("flex-1 overflow-y-auto px-4 py-6", showKeypad && "pb-64")}
        onFocusCapture={(e) => {
          // Any other field getting focus (Description, category, split inputs, ...) should
          // bring up its own native keyboard — and since that's a real text field, this closes
          // the custom AmountKeypad so the two don't end up stacked on screen at once.
          if (!(e.target as HTMLElement).closest('[data-amount-field]')) setShowKeypad(false);
        }}
      >
        <main className="max-w-md mx-auto w-full space-y-5 pb-20">
          {selectedGroup?.incomeEnabled && (
            <div className="flex gap-1.5" data-tour="expense-type-toggle">
              <button
                type="button"
                onClick={() => setEntryType('expense')}
                className={clsx(
                  'flex-1 h-12 rounded-xl border transition-all flex items-center justify-center gap-2',
                  entryType === 'expense' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                )}
              >
                <span className="material-symbols-outlined text-[18px]">remove_circle</span>
                <span className="text-xs font-bold uppercase tracking-wide">{t('addExpense.expense')}</span>
              </button>
              <button
                type="button"
                onClick={() => setEntryType('income')}
                className={clsx(
                  'flex-1 h-12 rounded-xl border transition-all flex items-center justify-center gap-2',
                  entryType === 'income' ? 'bg-success text-white border-success' : 'bg-white text-text-muted border-border-subtle'
                )}
              >
                <span className="material-symbols-outlined text-[18px]">add_circle</span>
                <span className="text-xs font-bold uppercase tracking-wide">{t('addExpense.income')}</span>
              </button>
            </div>
          )}

          <section className="bg-white p-3 rounded-2xl border border-border-subtle shadow-sm" data-tour="expense-amount">
          <div className="flex items-start justify-between gap-2 mb-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('addExpense.amount')} <span className="text-error">*</span></label>
            {groupId && budget && (() => {
              const signedEntryAmount = entryType === 'income' ? 0 : (evaluatedAmount || 0);
              const projectedRemaining = budget.amount - monthSpendSoFar - signedEntryAmount;
              const isOver = projectedRemaining < 0;
              // Category line only shows once that category actually has a % of the budget set
              // aside for it — otherwise there's nothing to project against.
              // Rounded to the nearest rupee before comparing — categoryBudgetPct is stored to 4
              // decimal places (see ManageGroup.tsx's handleSaveCategoryBudget) precisely so an
              // exact amount entry like ₹68,000 round-trips back to ₹68,000, but the raw
              // reconstruction (budget × pct ÷ 100) can still land a fraction of a rupee off
              // (e.g. ₹67,999.95) — comparing that unrounded showed "₹0.05 over" against a
              // category that was actually exactly on budget.
              const categoryBudgetAmount = Math.round((budget.amount * categoryBudgetPct) / 100);
              const categoryProjectedRemaining = categoryBudgetAmount - categorySpendSoFar - signedEntryAmount;
              const isCategoryOver = categoryProjectedRemaining < 0;
              return (
                <span className="text-right shrink-0">
                  <span className={clsx('block text-[10px] font-bold', isOver ? 'text-error' : 'text-success')}>
                    {isOver ? t('addExpense.overBudgetBy') : t('addExpense.remainingBudget')} {currencySymbol}{Math.abs(projectedRemaining).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                  {entryType === 'expense' && categoryBudgetPct > 0 && (
                    <span className={clsx('block text-[10px] font-bold', isCategoryOver ? 'text-error' : 'text-primary')}>
                      {t('addExpense.categoryBudgetLine', {
                        category: t(`category.${category}`),
                        label: isCategoryOver ? t('addExpense.overBudgetBy') : t('addExpense.remainingBudget'),
                        amount: `${currencySymbol}${Math.abs(categoryProjectedRemaining).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                      })}
                    </span>
                  )}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center justify-center gap-2">
            <div className="flex items-center justify-center gap-1" data-amount-field="true">
              {groupId && <span className="text-xl font-bold text-primary">{currencySymbol}</span>}
              <input
                type="text"
                inputMode="none"
                readOnly
                value={amount}
                onFocus={(e) => {
                  // `readOnly` + `inputMode="none"` normally keep the native keyboard from
                  // opening for this field, but some Android WebView/keyboard combos still leave
                  // a *previous* field's keyboard open when focus moves here instead of hiding
                  // it. Immediately blurring right after focus forces no element to be focused
                  // at all, which reliably tells Android to dismiss it — the custom AmountKeypad
                  // below stays open independently via `showKeypad` state, not DOM focus.
                  e.currentTarget.blur();
                  setShowKeypad(true);
                }}
                onClick={() => setShowKeypad(true)}
                placeholder={t('addExpense.amountPlaceholder')}
                className="text-xl font-bold text-primary bg-transparent border-none focus:ring-0 p-0 w-32 text-center placeholder:opacity-20 placeholder:text-sm cursor-pointer"
              />
            </div>
            {hasAmountSumOperator(amount) && evaluatedAmount !== null && (
              <span className="text-xs font-bold text-success bg-success/10 px-2 py-1 rounded-lg whitespace-nowrap">
                = {currencySymbol}{evaluatedAmount.toFixed(2)}
              </span>
            )}
          </div>
          {formErrors.amount && <p className="text-xs text-error font-bold text-center mt-1">{formErrors.amount}</p>}
        </section>

        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {groupLocked && selectedGroup ? (
              <div className="flex items-center justify-between bg-white px-3 h-11 rounded-xl border border-border-subtle">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="material-symbols-outlined text-primary text-[18px] shrink-0">{selectedGroup.icon || 'home'}</span>
                  <span className="text-sm font-bold text-primary truncate">{selectedGroup.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setGroupLocked(false)}
                  className="text-[11px] font-bold text-primary underline shrink-0"
                >
                  {t('addExpense.change')}
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('addExpense.group')} <span className="text-error">*</span></label>
                <select
                  value={groupId}
                  onChange={(e) => { setGroupId(e.target.value); if (formErrors.group) setFormErrors((prev) => ({ ...prev, group: '' })); }}
                  className={clsx('w-full h-11 bg-white px-3 rounded-xl border outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-primary', formErrors.group ? 'border-error' : 'border-border-subtle')}
                >
                  <option value="">{t('addExpense.selectGroup')}</option>
                  {selectableGroups.map((group: any) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
                {formErrors.group && <p className="text-xs text-error font-bold px-1 mt-1">{formErrors.group}</p>}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <ImageAttachments images={images} onChange={setImages} label={t('addExpense.addReceiptPhoto')} />
          </div>
        </div>

        {favorites.length > 0 && (
          <section className="bg-white rounded-2xl border border-border-subtle overflow-hidden">
            <button
              type="button"
              onClick={() => setShowFavorites((v) => !v)}
              className="w-full flex items-center justify-between px-3 h-11"
            >
              <span className="flex items-center gap-1.5 text-sm font-bold text-on-surface">
                <span className="material-symbols-outlined text-[18px] text-warning" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                {t('addExpense.useAFavorite', { count: favorites.length })}
              </span>
              <span className="material-symbols-outlined text-text-muted text-[18px]">{showFavorites ? 'expand_less' : 'expand_more'}</span>
            </button>
            {showFavorites && (
              <div className="flex gap-2 overflow-x-auto p-3 pt-0 no-scrollbar">
                {favorites.map((fav) => {
                  const favCat = (fav.type === 'income' ? INCOME_CATEGORIES : CATEGORIES).find((c) => c.id === fav.category);
                  const favGroup = groups.find((g) => g.id === fav.groupId);
                  // The "x" only ever removes MY OWN vote (see handleRemoveFavorite's own doc
                  // comment) — showing it unconditionally on a favorite someone ELSE in the group
                  // starred meant tapping it silently did nothing (their uid was never in
                  // favoritedBy to remove), which read as "I can't remove this favorite" with no
                  // visible reason why, especially confusing when it was the only one left.
                  const isMyFavorite = !!user && (fav.favoritedBy || []).includes(user.uid);
                  return (
                    <div
                      key={fav.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handlePickFavorite(fav)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handlePickFavorite(fav); }}
                      className="relative shrink-0 w-32 text-left bg-surface p-2.5 rounded-xl border border-border-subtle hover:border-primary/40 active:scale-[0.97] transition-all cursor-pointer"
                    >
                      {isMyFavorite ? (
                        <button
                          type="button"
                          onClick={(e) => handleRemoveFavorite(fav, e)}
                          className="absolute top-1 right-1 p-0.5 rounded-full text-text-muted/50 hover:text-error hover:bg-error/10"
                          aria-label={t('addExpense.removeFavorite')}
                          title={t('addExpense.removeFavorite')}
                        >
                          <span className="material-symbols-outlined text-[14px] block">close</span>
                        </button>
                      ) : (
                        <span
                          className="absolute top-1 right-1 material-symbols-outlined text-[14px] text-warning/60"
                          style={{ fontVariationSettings: "'FILL' 1" }}
                          title={t('addExpense.favoritedByOther')}
                        >
                          star
                        </span>
                      )}
                      <span className="text-lg block">{favCat?.icon || '🧾'}</span>
                      <span className="block text-xs font-bold text-on-surface truncate mt-1 pr-3">{fav.description || t('addExpense.untitled')}</span>
                      <span className={clsx('block text-[11px] font-bold', fav.type === 'income' ? 'text-success' : 'text-primary')}>
                        {fav.type === 'income' ? '+' : ''}{getCurrencySymbol(favGroup?.currency)}{Number(fav.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                      {favGroup && (
                        <span className="block text-[9px] text-text-muted font-bold uppercase tracking-wider truncate mt-0.5">{favGroup.name}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1 relative">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('addExpense.description')} <span className="text-error">*</span></label>
            <input
              value={description}
              onChange={(e) => { setDescription(e.target.value); if (formErrors.description) setFormErrors((prev) => ({ ...prev, description: '' })); }}
              onFocus={() => setDescriptionFocused(true)}
              onBlur={() => setDescriptionFocused(false)}
              type="text"
              placeholder={t('addExpense.descriptionPlaceholder')}
              className={clsx('w-full h-10 bg-white px-3 rounded-lg border focus:ring-2 focus:ring-primary/20 outline-none transition-all placeholder:text-text-muted/40 text-sm font-medium', formErrors.description ? 'border-error' : 'border-border-subtle')}
            />
            {formErrors.description && <p className="text-xs text-error font-bold px-1 mt-1">{formErrors.description}</p>}
            {descriptionFocused && descriptionSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-border-subtle shadow-lg z-20 overflow-hidden">
                {descriptionSuggestions.map((d) => (
                  <button
                    key={d}
                    type="button"
                    // Fires before the input's onBlur (mousedown precedes blur), so the click
                    // still lands here instead of the dropdown vanishing out from under it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setDescription(d)}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-on-surface hover:bg-surface truncate"
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('addExpense.date')}</label>
            <input 
              value={date}
              onChange={(e) => setDate(e.target.value)}
              type="date" 
              className="w-full h-10 bg-white px-3 rounded-lg border border-border-subtle focus:ring-2 focus:ring-primary/20 outline-none transition-all text-sm font-medium"
            />
          </div>
        </div>

        <section className="space-y-1.5" data-tour="expense-category">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[10px] font-bold text-primary uppercase tracking-widest opacity-60">{t('addExpense.category')}</h2>
            {/* Informational only — set by the group's owner/admin in Manage Group, every member
                just sees the current classification here so they know how their spend will be
                counted in the group's Essential/Optional filter and chart. */}
            {entryType !== 'income' && category && (
              <span className={clsx(
                'text-[9px] font-bold px-2 py-0.5 rounded-full',
                getCategoryClassification(selectedGroup, category) === 'essential'
                  ? 'bg-success/10 text-success'
                  : 'bg-warning/10 text-warning',
              )}>
                {getCategoryClassification(selectedGroup, category) === 'essential' ? t('common.essential') : t('common.optional')}
              </span>
            )}
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {activeCategories.map(cat => {
              const catLabel = t(`${entryType === 'income' ? 'income' : 'category'}.${cat.id}`);
              return (
                <button
                  key={cat.id}
                  onClick={() => setCategory(cat.id)}
                  className={clsx(
                    "flex flex-col items-center justify-center p-1 rounded-lg border transition-all active:scale-95 gap-0.5 min-h-[51px]",
                    category === cat.id
                      ? "bg-primary text-white border-primary shadow-inner"
                      : "bg-white border-border-subtle hover:bg-surface-container"
                  )}
                >
                  <span className="text-[15px] leading-none">
                    {cat.icon}
                  </span>
                  <span className="text-[9px] font-bold text-center leading-tight truncate w-full px-0.5">
                    {catLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="bg-white p-3 rounded-2xl border border-border-subtle space-y-3">
            <button
              type="button"
              onClick={() => setMakeRecurring((v) => !v)}
              className="w-full flex items-center gap-2.5"
            >
              <span className={clsx(
                'w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all',
                makeRecurring ? 'bg-primary text-white' : 'bg-surface text-text-muted',
              )}>
                <span className="material-symbols-outlined text-[18px]">event_repeat</span>
              </span>
              <span className="flex-1 text-left">
                <span className="block text-sm font-bold text-on-surface">{t('addExpense.makeRecurring')}</span>
                <span className="block text-[11px] text-text-muted">{t('addExpense.makeRecurringDesc')}</span>
              </span>
              <span className={clsx(
                'w-10 h-6 rounded-full p-0.5 transition-all shrink-0',
                makeRecurring ? 'bg-primary' : 'bg-surface-container',
              )}>
                <span className={clsx(
                  'block w-5 h-5 rounded-full bg-white shadow-sm transition-transform',
                  makeRecurring && 'translate-x-4',
                )} />
              </span>
            </button>
            {makeRecurring && (
              <div className="border-t border-border-subtle pt-3">
                <FrequencyPicker config={recurFreqConfig} onChange={setRecurFreqConfig} />
              </div>
            )}
          </section>

        {entryType === 'expense' && selectedGroup?.splitEnabled && groupMembers.length > 0 && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="space-y-4 border-t border-border-subtle pt-4 mt-2 overflow-hidden"
          >
            <section className="space-y-2">
              <h2 className="px-1 text-[11px] font-bold text-primary uppercase tracking-widest">{t('addExpense.whoPaid')}</h2>
              <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar px-1">
                {groupMembers.map(member => (
                  <button
                    key={member.userId}
                    type="button"
                    onClick={() => setPaidBy(member.userId)}
                    className={clsx(
                      "flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm shrink-0",
                      paidBy === member.userId 
                        ? "bg-primary text-white border-primary" 
                        : "bg-white text-on-surface border-border-subtle hover:bg-surface-container"
                    )}
                  >
                    <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10">
                      {member.photoURL ? (
                        <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="material-symbols-outlined text-[12px] flex items-center justify-center h-full">person</span>
                      )}
                    </div>
                    {member.userId === user?.uid ? t('common.me') : member.displayName}
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-[11px] font-bold text-primary uppercase tracking-widest">{t('addExpense.sharedWith')}</h2>
                <button 
                  onClick={() => {
                    if (splitMembers.length === groupMembers.length) {
                      setSplitMembers([]);
                    } else {
                      setSplitMembers(groupMembers.map(m => m.userId));
                    }
                  }}
                  className="text-[10px] font-bold text-primary hover:underline"
                >
                  {splitMembers.length === groupMembers.length ? t('addExpense.deselectAll') : t('addExpense.selectAll')}
                </button>
              </div>
              <div className="flex flex-wrap gap-2 px-1">
                {groupMembers.map(member => (
                  <button
                    key={member.userId}
                    type="button"
                    onClick={() => {
                      if (splitMembers.includes(member.userId)) {
                        setSplitMembers(splitMembers.filter(id => id !== member.userId));
                      } else {
                        setSplitMembers([...splitMembers, member.userId]);
                      }
                    }}
                    className={clsx(
                      "flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm",
                      splitMembers.includes(member.userId) 
                        ? "bg-secondary text-on-secondary border-secondary" 
                        : "bg-white text-on-surface border-border-subtle hover:bg-surface-container"
                    )}
                  >
                    <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10">
                      {member.photoURL ? (
                        <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="material-symbols-outlined text-[12px] flex items-center justify-center h-full">person</span>
                      )}
                    </div>
                    {member.userId === user?.uid ? t('common.me') : member.displayName}
                    {splitMembers.includes(member.userId) && (
                      <span className="material-symbols-outlined text-[14px]">check</span>
                    )}
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="px-1 text-[11px] font-bold text-primary uppercase tracking-widest">{t('addExpense.splitMethod')}</h2>
              <div className="grid grid-cols-3 gap-2 px-1">
                {[
                  { id: 'equally', label: t('addExpense.equally'), icon: 'balance' },
                  { id: 'percentage', label: t('addExpense.percent'), icon: 'percent' },
                  { id: 'amount', label: t('common.amount'), icon: 'payments' },
                ].map(method => (
                  <button
                    key={method.id}
                    type="button"
                    onClick={() => setSplitType(method.id as any)}
                    className={clsx(
                      "flex flex-col items-center justify-center p-2 rounded-xl border transition-all active:scale-95 gap-1",
                      splitType === method.id 
                        ? "bg-primary text-white border-primary shadow-inner" 
                        : "bg-white border-border-subtle hover:bg-surface-container"
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">{method.icon}</span>
                    <span className="text-[10px] font-bold">{method.label}</span>
                  </button>
                ))}
              </div>
            </section>

            {splitType !== 'equally' && splitMembers.length > 0 && (
              <section className="space-y-2 bg-surface p-3 rounded-2xl border border-border-subtle">
                <h3 className="text-[10px] font-bold text-primary uppercase tracking-widest pl-1">
                  {splitType === 'amount' ? t('addExpense.enterAmounts') : t('addExpense.enterPercentages')}
                </h3>
                <div className="space-y-2">
                  {splitMembers.map(uid => {
                    const member = groupMembers.find(m => m.userId === uid);
                    return (
                      <div key={uid} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-border-subtle">
                        <div className="w-8 h-8 rounded-full overflow-hidden bg-primary/10">
                          {member?.photoURL ? (
                            <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <span className="material-symbols-outlined text-sm flex items-center justify-center h-full">person</span>
                          )}
                        </div>
                        <span className="text-xs font-bold text-on-surface flex-1 truncate">
                          {uid === user?.uid ? t('common.me') : member?.displayName}
                        </span>
                        <div className="flex items-center gap-1">
                          {splitType === 'amount' && <span className="text-[10px] font-bold text-primary">{currencySymbol}</span>}
                          <input 
                            type="number"
                            value={memberSplits[uid] || ''}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              if (splitType === 'percentage') {
                                const testSplits = { ...memberSplits, [uid]: val };
                                const testTotal = splitMembers.reduce((sum, memberId) => sum + (testSplits[memberId] || 0), 0);
                                if (testTotal > 100) {
                                  const otherTotal = splitMembers.reduce((sum, memberId) => sum + (memberId === uid ? 0 : memberSplits[memberId] || 0), 0);
                                  const maxAllowed = Math.max(0, 100 - otherTotal);
                                  setMemberSplits({ ...memberSplits, [uid]: maxAllowed });
                                  return;
                                }
                              }
                              setMemberSplits({ ...memberSplits, [uid]: val });
                            }}
                            placeholder="0"
                            className="w-16 h-8 bg-surface rounded-lg border border-border-subtle text-right px-2 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                          />
                          {splitType === 'percentage' && <span className="text-[10px] font-bold text-primary">%</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {splitType === 'percentage' && (
                  <div className={clsx(
                    "text-[10px] font-bold text-center mt-2",
                    splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0) === 100 ? "text-success" : "text-error"
                  )}>
                    {t('addExpense.totalPercent', { pct: splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0) })}
                  </div>
                )}
                {splitType === 'amount' && (
                  <div className={clsx(
                    "text-[10px] font-bold text-center mt-2",
                    Math.abs(splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0) - parseFloat(amount || '0')) < 0.01 ? "text-success" : "text-error"
                  )}>
                    {t('addExpense.totalAmount', {
                      spent: `${currencySymbol}${splitMembers.reduce((sum, uid) => sum + (memberSplits[uid] || 0), 0).toFixed(2)}`,
                      total: `${currencySymbol}${parseFloat(amount || '0').toFixed(2)}`,
                    })}
                  </div>
                )}
              </section>
            )}
          </motion.div>
        )}

      </main>
      </div>

      {/* Floats within this modal card (not the viewport) — absolute, not fixed, since the card
          itself is the "add expense section" the buttons should stay pinned to, and on wider
          screens the card is centered and narrower than the viewport. Shifts up above the
          AmountKeypad when it's open so the two never overlap, mirroring the scroll container's
          own pb-64 reserved for the same reason. Two buttons: "Save & Add More" resets the form
          and stays here for another entry; plain "Save" closes back to wherever this screen was
          opened from. Either way, markExpenseAdded() inside handleSave hands the id(s) off to
          Dashboard.tsx so the group tile highlights (and auto-expands to show) whatever was just
          added, the moment the user actually gets back there. */}
      <div className={clsx(
        'absolute left-4 right-4 z-[95] flex items-center justify-end gap-2',
        showKeypad ? 'bottom-64' : 'bottom-4',
      )}>
        <button
          onClick={() => handleSave(true)}
          disabled={loading}
          className="flex items-center gap-1.5 pl-4 pr-4 h-12 bg-white border-2 border-primary text-primary rounded-full font-bold text-sm shadow-lg active:scale-95 transition-all disabled:opacity-50 shrink-0"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          {t('addExpense.saveAddMore')}
        </button>
        <button
          onClick={() => handleSave(false)}
          disabled={loading}
          data-tour="expense-save"
          className="flex items-center gap-1.5 pl-4 pr-5 h-12 bg-primary text-white rounded-full font-bold text-sm shadow-lg active:scale-95 transition-all disabled:opacity-50 shrink-0"
        >
          <span className="material-symbols-outlined text-[20px]">{loading ? 'progress_activity' : 'check'}</span>
          {loading ? t('addExpense.saving') : t('common.save')}
        </button>
      </div>

      {showKeypad && (
        <AmountKeypad
          value={amount}
          onChange={(v) => { setAmount(v); if (formErrors.amount) setFormErrors((prev) => ({ ...prev, amount: '' })); }}
          onDone={() => setShowKeypad(false)}
        />
      )}
      </div>

      {invitePromptGroupId && (
        <AddFamilyMemberPrompt
          trigger="first_expense"
          groupId={invitePromptGroupId}
          groupName={selectedGroup?.name}
          onDismiss={() => {
            setInvitePromptGroupId(null);
            if (closeAfterInvitePrompt) handleClose();
          }}
        />
      )}
    </div>
  );
}
