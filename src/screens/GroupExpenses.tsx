import React, { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, orderBy, doc, setDoc, updateDoc, deleteDoc, deleteField, runTransaction, arrayUnion, arrayRemove } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'motion/react';
import { getCurrencySymbol, EXPENSE_CATEGORIES, INCOME_CATEGORIES, PAYMENT_METHODS, getCategoryClassification, CategoryClassification } from '../lib/constants';
import { updateGlobalStats } from '../services/statsService';
import Comments from '../components/Comments';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { parseLocalDate, currentLocalMonthKey } from '../lib/dateUtils';
import ImageAttachments from '../components/ImageAttachments';
import ExpenseQuickView from '../components/ExpenseQuickView';
import FrequencyPicker from '../components/FrequencyPicker';
import { FrequencyConfig, nextOccurrenceAfter, sanitizeFrequencyConfig } from '../lib/frequency';
import { evaluateAmountSum, hasAmountSumOperator } from '../lib/amountMath';
import { useLanguage } from '../context/LanguageContext';

const CATEGORIES = EXPENSE_CATEGORIES;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PAYMENT_METHODS_LIST = PAYMENT_METHODS;

// Income entries are tallied on a separate `totalIncome` group field rather than folded
// (signed) into `totalSpending` — see AddExpense.tsx's handleSave for why. Every place that
// adjusts a group's running total needs to know which field a given entry's `type` belongs to.
const totalsField = (type: string | undefined): 'totalIncome' | 'totalSpending' => (type === 'income' ? 'totalIncome' : 'totalSpending');

export default function GroupExpenses() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { t } = useLanguage();
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedGroupIdFilter, setSelectedGroupIdFilter] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'all' | 'expense' | 'income'>('all');
  const [selectedClassification, setSelectedClassification] = useState<'all' | CategoryClassification>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Multi-select quick filters, same pattern as GroupAnalysisSummary.tsx's — empty means "no
  // month/year restriction", not "match nothing".
  const [selectedMonths, setSelectedMonths] = useState<number[]>([]);
  const [selectedYears, setSelectedYears] = useState<number[]>([]);
  const toggleMonth = (m: number) => setSelectedMonths((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  const toggleYear = (y: number) => setSelectedYears((prev) => (prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y]));

  // Tapping a row opens this read-only view first (via the shared ExpenseQuickView, same
  // component the Dashboard uses) — its own "Edit or Delete in Group Expenses" button navigates
  // back to this exact route with `state.openExpenseId` set, which the effect below already
  // handles (opens the edit modal below and closes this one), so no changes to that shared
  // component were needed to wire this up.
  const [viewingExpense, setViewingExpense] = useState<any>(null);

  // Edit Modal State
  const [editingExpense, setEditingExpense] = useState<any>(null);
  // Raw text of the amount field while editing — lets it hold an in-progress expression like
  // "100+" that evaluateAmountSum can't resolve yet, separate from editingExpense.amount (which
  // only ever updates to the last successfully evaluated number, since everything else in this
  // modal — split previews, validation totals — reads that as a live plain number).
  const [amountInput, setAmountInput] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  // Where to send the user once they're done with the edit modal (save, delete, or just close) —
  // set when they arrived here via ExpenseQuickView's "Edit or Delete" button from somewhere OTHER
  // than this page itself (e.g. a Dashboard group tile's "Latest spend" row), so finishing the
  // edit takes them back there instead of stranding them on this page, which they never meant to
  // navigate to in the first place. `null` (the default, e.g. arriving via this page's own row
  // click → quick view → edit) means "just close the modal, stay here" — today's undisturbed
  // behavior.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  // "Also make this recurring" from the edit modal — same idea as AddExpense.tsx's toggle, kept
  // as separate state (not mixed into `editingExpense`) so it can never accidentally end up
  // written onto the expense doc itself; handleUpdateExpense only ever pulls named fields into
  // updateData, but keeping this fully separate removes any chance of that mistake.
  const [editMakeRecurring, setEditMakeRecurring] = useState(false);
  const [editRecurFreqConfig, setEditRecurFreqConfig] = useState<FrequencyConfig>(() => ({ frequency: 'monthly', dayOfMonth: new Date().getDate() }));
  // Resets whenever a DIFFERENT expense is opened (or the modal closes) rather than at every
  // individual close-button/backdrop-click site — there are several of those, and a stray leftover
  // "make recurring" toggle silently carrying over into the next expense you open would be a real,
  // easy-to-miss bug.
  useEffect(() => {
    setEditMakeRecurring(false);
    setEditRecurFreqConfig({ frequency: 'monthly', dayOfMonth: new Date().getDate() });
  }, [editingExpense?.id]);

  // Every way the edit modal can finish (save, delete, or just close/cancel) funnels through
  // here, so `returnTo` is honored no matter which one the user takes.
  const closeEditModal = () => {
    setEditingExpense(null);
    if (returnTo) {
      const dest = returnTo;
      setReturnTo(null);
      navigate(dest);
    }
  };

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null
  );
  const userGroupIds = useMemo(() => membershipsValue?.docs.map(doc => doc.data().groupId) || [], [membershipsValue]);

  const [groupsValue] = useCollection(
    userGroupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', userGroupIds)) : null
  );
  const allGroups = useMemo(() => groupsValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[], [groupsValue]);

  const [groupValue] = useDocument(groupId && groupId !== 'all' ? doc(db, 'groups', groupId) : null);
  const groupData = groupValue?.data();

  const [membersValue] = useCollection(
    groupId === 'all' 
      ? (userGroupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', userGroupIds)) : null)
      : (groupId ? query(collection(db, 'members'), where('groupId', '==', groupId)) : null)
  );
  const members = useMemo(() => {
    const rawMembers = membersValue?.docs.map(doc => doc.data()) || [];
    const unique = new Map();
    rawMembers.forEach(m => {
      if (!unique.has(m.userId)) unique.set(m.userId, m);
    });
    return Array.from(unique.values());
  }, [membersValue]);

  const [expensesValue] = useCollection(
    groupId === 'all'
      ? (userGroupIds.length > 0 
          ? query(
              collection(db, 'expenses'), 
              where('groupId', 'in', selectedGroupIdFilter ? [selectedGroupIdFilter] : userGroupIds)
            ) 
          : null)
      : (groupId ? query(collection(db, 'expenses'), where('groupId', '==', groupId)) : null)
  );
  
  const allExpenses = useMemo(() => {
    let exps = expensesValue?.docs.map(doc => ({ id: doc.id, ...doc.data() })) || [] as any[];
    // Filter to only include expenses from groups that actually exist and the user is a member of
    const activeGroupIds = allGroups.map(g => g.id);
    if (groupId === 'all') {
      exps = exps.filter(exp => activeGroupIds.includes(exp.groupId));
    }
    // Sorted by when it was actually ENTERED (createdAt), not the transaction date the user
    // picked (date) — the two can differ a lot (e.g. backdating a purchase from last week), and
    // the list should reflect "what did people just add" rather than reshuffling itself around
    // whatever dates people happened to choose.
    return exps.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [expensesValue, groupId, allGroups]);

  // Live remaining-budget preview while editing — same idea as AddExpense.tsx's, but this
  // expense's OWN current amount must be excluded from monthSpendSoFar/categorySpendSoFar first
  // (it's already counted in the group's historical totals), or the preview would double-subtract
  // it once for "what's already spent" and again for "what this edit is about to change it to".
  const editMonthKey = currentLocalMonthKey();
  const [editBudgetValue] = useDocument(editingExpense ? doc(db, 'groupBudgets', `${editingExpense.groupId}_${editMonthKey}`) : null);
  const editBudget = editBudgetValue?.data();
  const editMonthSpendSoFar = useMemo(() => {
    if (!editingExpense) return 0;
    return allExpenses
      .filter((e: any) => e.id !== editingExpense.id && e.groupId === editingExpense.groupId && typeof e.date === 'string' && e.date.startsWith(editMonthKey) && e.type !== 'income')
      .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }, [allExpenses, editingExpense, editMonthKey]);
  const editCategoryBudgetPct = editingExpense ? ((editBudget?.categoryAllocations as Record<string, number> | undefined)?.[editingExpense.category] || 0) : 0;
  const editCategorySpendSoFar = useMemo(() => {
    if (!editingExpense) return 0;
    return allExpenses
      .filter((e: any) => e.id !== editingExpense.id && e.groupId === editingExpense.groupId && typeof e.date === 'string' && e.date.startsWith(editMonthKey) && e.type !== 'income' && e.category === editingExpense.category)
      .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }, [allExpenses, editingExpense, editMonthKey]);

  // Deep-link support: arriving from a "latest spend" line on the Dashboard (via router state)
  // or an expense-comment notification/Feed tap (via `?expenseId=`, since a plain URL string —
  // needed for push notification payloads and the Feed — can't carry router state) opens that
  // specific expense's detail modal directly, instead of just landing on the list. Reacts to
  // `searchParams`/`location.state` themselves, not a mount-only effect — if this screen (or the
  // "all expenses" variant of it) is already mounted when the notification is tapped, React
  // Router reuses the instance instead of remounting it, so a mount-only effect would never see
  // the new param.
  useEffect(() => {
    const stateExpenseId = (location.state as any)?.openExpenseId;
    const stateReturnTo = (location.state as any)?.returnTo;
    const queryExpenseId = searchParams.get('expenseId');
    const openExpenseId = stateExpenseId || queryExpenseId;
    if (!openExpenseId || allExpenses.length === 0) return;
    const target = allExpenses.find((exp: any) => exp.id === openExpenseId);
    if (target) {
      setEditingExpense(target);
      setAmountInput(String(target.amount));
      setViewingExpense(null);
      if (stateReturnTo) setReturnTo(stateReturnTo);
      if (stateExpenseId) navigate(location.pathname, { replace: true, state: {} });
      if (queryExpenseId) {
        const next = new URLSearchParams(searchParams);
        next.delete('expenseId');
        setSearchParams(next, { replace: true });
      }
    }
  }, [location.state, searchParams, allExpenses, navigate, location.pathname, setSearchParams]);

  // Carries over every filter that was active on GroupAnalysisSummary.tsx when the user tapped a
  // "view transactions" link there (see its buildExpensesLink) — so switching screens doesn't
  // silently drop back to an unfiltered list. Reacts to `searchParams` itself, not mount-only, for
  // the same reason as the expenseId effect above. Left in the URL afterward (not scrubbed) since
  // this is real filter state, not a one-time action — a bookmarked/shared link stays filtered.
  useEffect(() => {
    const type = searchParams.get('type');
    const classification = searchParams.get('classification');
    const category = searchParams.get('category');
    const memberId = searchParams.get('memberId');
    const monthsParam = searchParams.get('months');
    const yearsParam = searchParams.get('years');
    if (type === 'expense' || type === 'income') setSelectedType(type);
    if (classification === 'essential' || classification === 'optional') setSelectedClassification(classification);
    if (category) setSelectedCategory(category);
    if (memberId) setSelectedMemberId(memberId);
    if (monthsParam) setSelectedMonths(monthsParam.split(',').map(Number).filter((n) => !Number.isNaN(n)));
    if (yearsParam) setSelectedYears(yearsParam.split(',').map(Number).filter((n) => !Number.isNaN(n)));
  }, [searchParams]);

  const currencySymbol = useMemo(() => {
    return getCurrencySymbol(groupData?.currency);
  }, [groupData?.currency]);

  // Every year actually present in this scope's data, for the quick year-filter row — always
  // includes the current year even with zero history yet, so a brand-new group isn't left with
  // nothing to tap. Same pattern as GroupAnalysisSummary.tsx's availableYears.
  const availableYears = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    allExpenses.forEach((exp: any) => { if (exp.date) years.add(parseLocalDate(exp.date).getFullYear()); });
    return Array.from(years).sort((a, b) => b - a);
  }, [allExpenses]);

  const filteredExpenses = useMemo(() => {
    return allExpenses.filter(exp => {
      const payer = members.find(m => m.userId === exp.paidBy);
      const payerName = (payer?.displayName || '').toLowerCase();
      const category = (exp.type === 'income' ? INCOME_CATEGORIES : CATEGORIES).find(c => c.id === exp.category);
      const categoryName = (category?.name || '').toLowerCase();

      const matchesSearch = !searchTerm ||
        (exp.description || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        payerName.includes(searchTerm.toLowerCase()) ||
        categoryName.includes(searchTerm.toLowerCase());

      const matchesMember = !selectedMemberId || exp.paidBy === selectedMemberId;
      const matchesCategory = !selectedCategory || exp.category === selectedCategory;
      const matchesType = selectedType === 'all' || (selectedType === 'income' ? exp.type === 'income' : exp.type !== 'income');
      const matchesDate = (!startDate || (exp.date && exp.date >= startDate)) && (!endDate || (exp.date && exp.date <= endDate));
      const matchesMonth = selectedMonths.length === 0 || (exp.date && selectedMonths.includes(parseLocalDate(exp.date).getMonth()));
      const matchesYear = selectedYears.length === 0 || (exp.date && selectedYears.includes(parseLocalDate(exp.date).getFullYear()));
      // Only meaningful for expenses (income has no Essential/Optional concept) — an income row
      // always passes this check regardless of the selected classification filter. Classification
      // is looked up against the expense's OWN group, since this screen can span every group the
      // user belongs to and each group can override the app-wide default independently.
      const expGroup = allGroups.find((g: any) => g.id === exp.groupId);
      const matchesClassification =
        selectedClassification === 'all' ||
        exp.type === 'income' ||
        getCategoryClassification(expGroup, exp.category) === selectedClassification;
      return matchesSearch && matchesMember && matchesCategory && matchesType && matchesDate && matchesMonth && matchesYear && matchesClassification;
    });
  }, [allExpenses, searchTerm, selectedMemberId, selectedCategory, selectedType, startDate, endDate, selectedMonths, selectedYears, selectedClassification, allGroups, members]);

  // Two-line summary above the table — always both totals (not just whichever `selectedType` is
  // active), computed from the SAME filtered set the table itself shows, so it reflects every
  // filter (search, member, category, type, date range, month/year pills) uniformly.
  const filteredTotals = useMemo(() => {
    return filteredExpenses.reduce(
      (acc, exp: any) => {
        if (exp.type === 'income') {
          acc.income += exp.amount || 0;
        } else {
          acc.expense += exp.amount || 0;
          const expGroup = allGroups.find((g: any) => g.id === exp.groupId);
          if (getCategoryClassification(expGroup, exp.category) === 'essential') acc.essential += exp.amount || 0;
          else acc.optional += exp.amount || 0;
        }
        return acc;
      },
      { expense: 0, income: 0, essential: 0, optional: 0 },
    );
  }, [filteredExpenses, allGroups]);

  const editingGroupMembers = useMemo(() => {
    if (!editingExpense || !membersValue) return [];
    return membersValue.docs
      .map(doc => doc.data())
      .filter((m: any) => m.groupId === editingExpense.groupId);
  }, [editingExpense, membersValue]);

  const handleUpdateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingExpense || !user) return;
    // The amount field accepts sum expressions like "100+50" (see AddExpense.tsx) — evaluate
    // once here so every write below (all of which used to read `Number(editingExpense.amount)`,
    // which would come out NaN for an unevaluated expression) uses the resolved number.
    const finalAmount = evaluateAmountSum(String(editingExpense.amount));
    if (!finalAmount || finalAmount <= 0) {
      alert(t('common.enterValidAmount'));
      return;
    }

    // Unlike AddExpense.tsx, this edit path previously wrote whatever was in editingExpense's
    // custom-split fields straight into the transaction below with no check at all — not even
    // that the splits summed to the (possibly just-edited) total, let alone that no one's share
    // went negative. That's how a save like "200" + "-100" for a 100 expense could go through:
    // the sum matched, but a negative share makes no real-world sense as anyone's split.
    if (editingExpense.splitInfo && editingExpense.type !== 'income') {
      const { splitType, splits } = editingExpense.splitInfo as { splitType: string; splits: any[] };
      if (splitType === 'amount') {
        if (splits.some((s) => (s.amount || 0) < 0)) {
          alert('Split amounts cannot be negative.');
          return;
        }
        const totalSplit = splits.reduce((sum, s) => sum + (s.amount || 0), 0);
        if (Math.abs(totalSplit - finalAmount) > 0.01) {
          alert(`Total split amount must equal the expense amount (${finalAmount.toFixed(2)}). Current split total: ${totalSplit.toFixed(2)}`);
          return;
        }
      } else if (splitType === 'percentage') {
        if (splits.some((s) => (s.percentage || 0) < 0)) {
          alert('Split percentages cannot be negative.');
          return;
        }
        const totalPct = splits.reduce((sum, s) => sum + (s.percentage || 0), 0);
        if (Math.abs(totalPct - 100) > 0.001) {
          alert(`Total percentage must be exactly 100%. Current: ${totalPct}%`);
          return;
        }
      }
    }

    setEditLoading(true);

    try {
      const originalExpense = allExpenses.find(ex => ex.id === editingExpense.id);
      if (!originalExpense) throw new Error("Original expense not found");

      const hasGroupChanged = editingExpense.groupId !== originalExpense.groupId;

      await runTransaction(db, async (transaction) => {
        if (hasGroupChanged) {
          const oldGroupRef = doc(db, 'groups', originalExpense.groupId);
          const newGroupRef = doc(db, 'groups', editingExpense.groupId);
          const [oldGroupDoc, newGroupDoc] = await Promise.all([
            transaction.get(oldGroupRef),
            transaction.get(newGroupRef)
          ]);

          if (!oldGroupDoc.exists() || !newGroupDoc.exists()) throw new Error("Group not found");

          // 1. Update old group total (subtract original amount from whichever field its type
          // belongs to)
          const oldField = totalsField(originalExpense.type);
          const oldFieldTotal = oldGroupDoc.data()[oldField] || 0;
          transaction.update(oldGroupRef, {
            [oldField]: Math.max(0, oldFieldTotal - originalExpense.amount)
          });

          // 2. Update new group total (add new amount to whichever field its — possibly
          // changed via the edit modal's type toggle — type belongs to)
          const newField = totalsField(editingExpense.type);
          const newFieldTotal = (newGroupDoc.data()[newField] || 0) + finalAmount;
          transaction.update(newGroupRef, {
            [newField]: newFieldTotal
          });

          // 3. Update expense document
          const updateData: any = {
            groupId: editingExpense.groupId,
            description: editingExpense.description,
            amount: finalAmount,
            category: editingExpense.category,
            date: editingExpense.date,
            paidBy: editingExpense.paidBy,
            type: editingExpense.type || 'expense',
            updatedAt: new Date().toISOString(),
            images: editingExpense.images?.length ? editingExpense.images : deleteField(),
            favoritedBy: editingExpense.favoritedBy || [],
          };

          if (editingExpense.splitInfo) {
            let splits = [...editingExpense.splitInfo.splits];
            const splitType = editingExpense.splitInfo.splitType;
            const totalAmount = finalAmount;

            if (splitType === 'equally') {
              const share = totalAmount / (splits.length || 1);
              splits = splits.map((s: any) => ({ ...s, amount: share }));
            } else if (splitType === 'percentage') {
              splits = splits.map((s: any) => ({
                ...s,
                amount: (totalAmount * (s.percentage || 0)) / 100
              }));
            }
            // For 'amount', they are already set in the UI

            updateData.splitInfo = {
              ...editingExpense.splitInfo,
              splits
            };
          } else if (originalExpense.splitInfo) {
            // Was an expense with a split, now converted to income (or split otherwise
            // cleared) — explicitly remove the stale splitInfo rather than leaving it behind,
            // since updateDoc only touches keys it's given.
            updateData.splitInfo = deleteField();
          }

          transaction.update(doc(db, 'expenses', editingExpense.id), updateData);

          // 4. Log activities
          const activityRefNew = doc(collection(db, 'activities'));
          transaction.set(activityRefNew, {
            groupId: editingExpense.groupId,
            userId: user.uid,
            userName: user.displayName || 'Someone',
            userPhoto: user.photoURL || '',
            type: 'add_expense',
            description: `${user.displayName || 'Someone'} moved expense "${editingExpense.description}" into this group`,
            data: {
              amount: finalAmount,
              description: editingExpense.description,
              currencySymbol: getCurrencySymbol(newGroupDoc.data().currency),
              currencyCode: newGroupDoc.data().currency
            },
            createdAt: new Date().toISOString()
          });
        } else {
          const targetGroupId = editingExpense.groupId;
          const groupRef = doc(db, 'groups', targetGroupId);
          const groupDoc = await transaction.get(groupRef);
          if (!groupDoc.exists()) throw new Error("Group not found");

          // 1. Update Expense
          const updateData: any = {
            description: editingExpense.description,
            amount: finalAmount,
            category: editingExpense.category,
            date: editingExpense.date,
            paidBy: editingExpense.paidBy,
            type: editingExpense.type || 'expense',
            updatedAt: new Date().toISOString(),
            images: editingExpense.images?.length ? editingExpense.images : deleteField(),
            favoritedBy: editingExpense.favoritedBy || [],
          };

          if (editingExpense.splitInfo) {
            let splits = [...editingExpense.splitInfo.splits];
            const splitType = editingExpense.splitInfo.splitType;
            const totalAmount = finalAmount;

            if (splitType === 'equally') {
              const share = totalAmount / (splits.length || 1);
              splits = splits.map((s: any) => ({ ...s, amount: share }));
            } else if (splitType === 'percentage') {
              splits = splits.map((s: any) => ({
                ...s,
                amount: (totalAmount * (s.percentage || 0)) / 100
              }));
            }

            updateData.splitInfo = {
              ...editingExpense.splitInfo,
              splits
            };
          } else if (originalExpense.splitInfo) {
            updateData.splitInfo = deleteField();
          }

          transaction.update(doc(db, 'expenses', editingExpense.id), updateData);

          // 2. Update Group Total(s) — if the type changed (expense <-> income), reverse the
          // old field by the old amount and add the new amount to the new field; otherwise it's
          // just a diff on the one field both old and new belong to.
          const oldField = totalsField(originalExpense.type);
          const newField = totalsField(editingExpense.type);
          if (oldField === newField) {
            const diff = finalAmount - originalExpense.amount;
            transaction.update(groupRef, { [oldField]: (groupDoc.data()[oldField] || 0) + diff });
          } else {
            transaction.update(groupRef, {
              [oldField]: Math.max(0, (groupDoc.data()[oldField] || 0) - originalExpense.amount),
              [newField]: (groupDoc.data()[newField] || 0) + finalAmount
            });
          }

          // 3. Log Activity
          const activityRef = doc(collection(db, 'activities'));
          transaction.set(activityRef, {
            groupId: targetGroupId,
            userId: user.uid,
            userName: user.displayName || 'Someone',
            userPhoto: user.photoURL || '',
            type: 'edit_expense',
            description: `${user.displayName || 'Someone'} updated expense: ${editingExpense.description}`,
            data: {
              oldAmount: originalExpense.amount,
              newAmount: finalAmount,
              description: editingExpense.description,
              currencySymbol: getCurrencySymbol(groupDoc.data()?.currency),
              currencyCode: groupDoc.data()?.currency
            },
            createdAt: new Date().toISOString()
          });
        }
      });

      // Update global amount diff — income entries never counted toward this stat (see
      // AddExpense.tsx's handleSave), so only the expense-attributable portion of the change
      // (which can shrink to/from zero if the type itself changed) is applied here.
      const oldGlobalAmount = originalExpense.type === 'income' ? 0 : (originalExpense.amount || 0);
      const newGlobalAmount = editingExpense.type === 'income' ? 0 : finalAmount;
      const diff = newGlobalAmount - oldGlobalAmount;
      if (diff !== 0) {
        await updateGlobalStats({ amount: diff });
      }

      notifyGroupActivity({
        groupId: editingExpense.groupId,
        action: 'updated',
        description: editingExpense.description,
        amount: finalAmount,
        actorName: user.displayName || 'Someone',
      });

      // "Also make this recurring" — same as AddExpense.tsx: a brand new recurringExpenses rule
      // alongside the (already-existing) one-time entry just saved above, first firing on the next
      // occurrence strictly after today so it doesn't double up with the entry being edited here.
      if (editMakeRecurring) {
        const editedGroup = allGroups.find((g: any) => g.id === editingExpense.groupId);
        const recurringRef = doc(collection(db, 'recurringExpenses'));
        const nextRunDate = nextOccurrenceAfter(editRecurFreqConfig, new Date()).toISOString();
        const recurringDoc: any = {
          userId: user.uid,
          groupId: editingExpense.groupId,
          type: editingExpense.type === 'income' ? 'income' : 'expense',
          category: editingExpense.category,
          description: editingExpense.description,
          amount: finalAmount,
          ...sanitizeFrequencyConfig(editRecurFreqConfig),
          nextRunDate,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          active: true,
          createdAt: new Date().toISOString(),
          ...(editingExpense.images?.length ? { images: editingExpense.images } : {}),
        };
        if (editingExpense.type !== 'income' && editedGroup?.splitEnabled && editingExpense.splitInfo) {
          recurringDoc.splitType = editingExpense.splitInfo.splitType;
          recurringDoc.splitMembers = editingExpense.splitInfo.splits.map((s: any) => s.userId);
          recurringDoc.memberSplits = Object.fromEntries(
            editingExpense.splitInfo.splits.map((s: any) => [s.userId, editingExpense.splitInfo.splitType === 'percentage' ? s.percentage : s.amount]),
          );
        }
        await setDoc(recurringRef, recurringDoc);
        notifyGroupActivity({
          groupId: editingExpense.groupId,
          action: 'recurring_created',
          description: editingExpense.description || CATEGORIES.find((c) => c.id === editingExpense.category)?.name,
          amount: finalAmount,
          actorName: user.displayName || 'Someone',
        });
      }

      closeEditModal();
    } catch (err) {
      console.error('Update error:', err);
      alert('Failed to update expense');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeleteExpense = async () => {
    if (!editingExpense || !user || !window.confirm('Delete this expense?')) return;
    setEditLoading(true);
    const targetGroupId = editingExpense.groupId;
    if (!targetGroupId) {
       alert('Target group not found for this expense');
       setEditLoading(false);
       return;
    }

    try {
      await runTransaction(db, async (transaction) => {
        const groupRef = doc(db, 'groups', targetGroupId);
        const groupDoc = await transaction.get(groupRef);
        if (!groupDoc.exists()) throw new Error("Group not found");

        const field = totalsField(editingExpense.type);
        const newTotal = (groupDoc.data()[field] || 0) - editingExpense.amount;

        // 1. Delete Expense
        transaction.delete(doc(db, 'expenses', editingExpense.id));

        // 2. Update Group Total
        transaction.update(groupRef, { [field]: Math.max(0, newTotal) });

        // 3. Log Activity
        const activityRef = doc(collection(db, 'activities'));
        transaction.set(activityRef, {
          groupId: targetGroupId,
          userId: user.uid,
          userName: user.displayName || 'Someone',
          userPhoto: user.photoURL || '',
          type: 'delete_expense',
          description: `${user.displayName || 'Someone'} deleted expense: ${editingExpense.description}`,
          data: { 
            amount: editingExpense.amount, 
            description: editingExpense.description,
            currencySymbol,
            currencyCode: groupDoc.data()?.currency
          },
          createdAt: new Date().toISOString()
        });
      });

      // Update global stats for deletion — income was never counted in, so it's never
      // subtracted out either.
      if (editingExpense.type !== 'income') {
        await updateGlobalStats({
          expenses: -1,
          amount: -editingExpense.amount
        });
      }

      notifyGroupActivity({
        groupId: targetGroupId,
        action: 'deleted',
        description: editingExpense.description,
        amount: editingExpense.amount,
        actorName: user.displayName || 'Someone',
      });

      closeEditModal();
    } catch (err) {
      console.error('Delete error:', err);
      alert('Failed to delete expense');
    } finally {
      setEditLoading(false);
    }
  };


  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 max-w-4xl mx-auto w-full space-y-4 pb-24 overflow-x-hidden">
        <div className="mb-2 flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20 shadow-inner overflow-hidden shrink-0">
            {groupData?.photoURL ? (
              <img src={groupData.photoURL} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="material-symbols-outlined text-primary text-2xl">{groupData?.icon || 'groups'}</span>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5 min-w-0">
              <h1 className="text-xl font-bold text-primary leading-tight">{t('groupExpenses.title')}</h1>
              {groupData?.splitEnabled && (
                <span className="material-symbols-outlined text-[18px] text-primary shrink-0" title="Split Enabled">call_split</span>
              )}
            </div>
            <p className="text-xs text-text-muted font-medium truncate max-w-[200px] sm:max-w-none">{t('groupExpenses.viewingTransactionsFor', { scope: groupId === 'all' ? t('groupExpenses.allGroups') : (groupData?.name || '') })}</p>
          </div>
        </div>
        {/* Search */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-text-muted text-lg">search</span>
          <input 
            type="text"
            placeholder={t('groupExpenses.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-white border border-border-subtle rounded-xl py-3 pl-11 pr-4 outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium text-sm text-primary shadow-sm"
          />
        </div>

        {/* Compact Filters Card */}
        <section className="bg-white p-4 rounded-xl border border-border-subtle shadow-sm space-y-4">
          <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1 w-fit">
            {(['all', 'expense', 'income'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSelectedType(opt)}
                className={clsx(
                  'px-3 py-1.5 rounded-md text-xs font-bold transition-all',
                  selectedType === opt ? 'bg-white text-primary shadow-sm' : 'text-text-muted',
                )}
              >
                {opt === 'all' ? t('groupExpenses.all') : opt === 'income' ? t('common.income') : t('common.expense')}
              </button>
            ))}
          </div>

          {/* Quick month/year filters — multi-select pills, horizontally scrollable, same
              pattern as GroupAnalysisSummary.tsx's. Applies to the table and the totals below it. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
              {MONTH_LABELS.map((label, idx) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleMonth(idx)}
                  className={clsx(
                    'shrink-0 px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition-all',
                    selectedMonths.includes(idx)
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface-container/30 text-text-muted border-border-subtle hover:bg-surface-container',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
              {availableYears.map((year) => (
                <button
                  key={year}
                  type="button"
                  onClick={() => toggleYear(year)}
                  className={clsx(
                    'shrink-0 px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition-all',
                    selectedYears.includes(year)
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface-container/30 text-text-muted border-border-subtle hover:bg-surface-container',
                  )}
                >
                  {year}
                </button>
              ))}
            </div>
          </div>

          {/* Essential/Optional — see lib/constants.ts's getCategoryClassification. */}
          <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1 w-fit">
            {(['all', 'essential', 'optional'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSelectedClassification(opt)}
                className={clsx(
                  'px-3 py-1.5 rounded-md text-xs font-bold transition-all',
                  selectedClassification === opt ? 'bg-white text-primary shadow-sm' : 'text-text-muted',
                )}
              >
                {opt === 'all' ? t('groupExpenses.all') : opt === 'essential' ? t('common.essential') : t('common.optional')}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {groupId === 'all' && (
              <div className="col-span-2 space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('addExpense.group')}</label>
                <div className="relative">
                  <select
                    value={selectedGroupIdFilter || ''}
                    onChange={(e) => setSelectedGroupIdFilter(e.target.value || null)}
                    className="w-full bg-surface-container border border-border-subtle rounded-lg pl-3 pr-8 py-2 text-xs font-bold text-primary appearance-none focus:ring-0 outline-none"
                  >
                    <option value="">{t('groupExpenses.allGroups')}</option>
                    {allGroups.map((g: any) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-lg pointer-events-none">expand_more</span>
                </div>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('common.member')}</label>
              <div className="relative">
                <select
                  value={selectedMemberId || ''}
                  onChange={(e) => setSelectedMemberId(e.target.value || null)}
                  className="w-full bg-surface-container border border-border-subtle rounded-lg pl-3 pr-8 py-2 text-xs font-bold text-primary appearance-none focus:ring-0 outline-none"
                >
                  <option value="">{t('groupExpenses.allMembers')}</option>
                  {members.map((m: any) => (
                    <option key={m.userId} value={m.userId}>{m.displayName}</option>
                  ))}
                </select>
                <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-lg pointer-events-none">expand_more</span>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('addExpense.category')}</label>
              <div className="relative">
                <select
                  value={selectedCategory || ''}
                  onChange={(e) => setSelectedCategory(e.target.value || null)}
                  className="w-full bg-surface-container border border-border-subtle rounded-lg pl-3 pr-8 py-2 text-xs font-bold text-primary appearance-none focus:ring-0 outline-none"
                >
                  <option value="">{t('groupExpenses.all')}</option>
                  {CATEGORIES.map((cat) => (
                    <option key={cat.id} value={cat.id}>{t(`category.${cat.id}`)}</option>
                  ))}
                </select>
                <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-lg pointer-events-none">expand_more</span>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('groupExpenses.dateRange')}</label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  const value = e.target.value;
                  setStartDate(value);
                  // matchesDate treats a blank end date as "no upper bound" (>= start only), so
                  // picking just a start date used to silently become an open-ended "from here
                  // on" filter instead of "this one day" — confusing since nothing in the UI
                  // signals that distinction. Defaulting end to match start makes a single date
                  // pick mean exactly that day; the user can still widen it afterward by editing
                  // end date manually. Also nudges end forward if it would otherwise sit before
                  // the new start, avoiding an inverted (always-empty) range.
                  if (value && (!endDate || endDate < value)) setEndDate(value);
                }}
                className="flex-1 min-w-0 bg-surface-container border border-border-subtle rounded-lg px-2 py-2 text-xs font-bold text-primary outline-none"
              />
              <span className="text-[10px] font-bold text-text-muted uppercase flex-none">{t('common.to')}</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 min-w-0 bg-surface-container border border-border-subtle rounded-lg px-2 py-2 text-xs font-bold text-primary outline-none"
              />
            </div>
          </div>
        </section>

        {/* Transactions list */}
        <section className="bg-white rounded-xl border border-border-subtle shadow-sm overflow-hidden">
          {/* Two-line summary — always both totals regardless of the All/Expense/Income toggle,
              computed from filteredExpenses so it reflects every active filter (search, member,
              category, type, date range, month/year pills) exactly like the rows below it. */}
          <div className="px-4 py-3 border-b border-border-subtle bg-surface-container-low/50 space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-bold text-text-muted uppercase tracking-wider shrink-0">{t('common.expense')} {t('common.total')}</span>
              <span className="font-black text-primary shrink-0">{currencySymbol}{filteredTotals.expense.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            {/* Essential/Optional breakdown as a two-color bar (same idiom as Analysis Summary's
                Member Contributions bars) instead of inline text — text-based %/amount labels
                squeezed between the total label and amount used to overlap or truncate on
                narrow screens. %s render below the bar, never on top of other text. */}
            {filteredTotals.expense > 0 && (
              <div className="space-y-1 pt-0.5">
                <div className="h-2 w-full bg-surface-container rounded-full overflow-hidden flex shadow-inner">
                  {filteredTotals.essential > 0 && (
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${(filteredTotals.essential / filteredTotals.expense) * 100}%` }}
                      className="h-full bg-success"
                    />
                  )}
                  {filteredTotals.optional > 0 && (
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${(filteredTotals.optional / filteredTotals.expense) * 100}%` }}
                      className="h-full bg-warning"
                    />
                  )}
                </div>
                <div className="flex items-center justify-between text-[10px] font-bold">
                  <span className="text-success">{t('common.essential')} {Math.round((filteredTotals.essential / filteredTotals.expense) * 100)}%</span>
                  <span className="text-warning">{t('common.optional')} {Math.round((filteredTotals.optional / filteredTotals.expense) * 100)}%</span>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-text-muted uppercase tracking-wider">{t('common.income')} {t('common.total')}</span>
              <span className="font-black text-[#0F7A38]">{currencySymbol}{filteredTotals.income.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
          </div>

          <div className="grid grid-cols-12 bg-surface-container-low px-4 py-3 border-b border-border-subtle text-[10px] font-bold text-text-muted uppercase tracking-wider">
            <div className="col-span-4">{t('groupExpenses.dateMember')}</div>
            <div className="col-span-5 px-2">{t('groupExpenses.descriptionCat')}</div>
            <div className="col-span-3 text-right">{t('common.amount')}</div>
          </div>

          <div className="divide-y divide-border-subtle">
            {filteredExpenses.length > 0 ? (
              filteredExpenses.map((expense: any) => {
                const payer = members.find(m => m.userId === expense.paidBy);
                const isIncomeRow = expense.type === 'income';
                const category = (isIncomeRow ? INCOME_CATEGORIES : CATEGORIES).find(c => c.id === expense.category);
                const group = allGroups.find(g => g.id === expense.groupId);

                const myFavorite = !!user && (expense.favoritedBy || []).includes(user.uid);
                const handleToggleFavorite = async (e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (!user) return;
                  try {
                    await updateDoc(doc(db, 'expenses', expense.id), {
                      favoritedBy: myFavorite ? arrayRemove(user.uid) : arrayUnion(user.uid),
                    });
                  } catch (err) {
                    console.error('Failed to toggle favorite:', err);
                  }
                };

                return (
                  <motion.div
                    layout
                    key={expense.id}
                    onClick={() => setViewingExpense(expense)}
                    className={clsx(
                      "grid grid-cols-12 px-4 py-3.5 items-center hover:bg-surface-container-low transition-colors cursor-pointer group relative",
                      isIncomeRow && "bg-success/10"
                    )}
                  >
                    <div className="col-span-4 space-y-1">
                      <div className="text-[10px] font-bold text-text-muted uppercase whitespace-nowrap">
                        {parseLocalDate(expense.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </div>
                      <div className="space-y-1">
                        <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider block">{t('addExpense.paidBy')}</span>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="w-5 h-5 rounded-full overflow-hidden bg-primary/10 border border-border-subtle flex-none font-bold text-[8px] flex items-center justify-center text-primary">
                            {payer?.photoURL ? (
                              <img src={payer.photoURL} alt="" className="w-full h-full object-cover" />
                            ) : payer?.displayName?.slice(0, 1) || 'U'}
                          </div>
                          <span className="text-[11px] font-bold text-primary truncate">{payer?.userId === user?.uid ? t('common.me') : (payer?.displayName?.split(' ')[0] || t('common.unknown'))}</span>
                        </div>
                      </div>
                    </div>
                    <div className="col-span-5 px-2 min-w-0">
                      <div className="text-xs font-bold text-primary truncate flex items-center gap-1">
                        <button
                          type="button"
                          onClick={handleToggleFavorite}
                          className="shrink-0 p-0.5 -m-0.5 rounded-full"
                          title={myFavorite ? 'Remove from favorites' : 'Mark as favorite'}
                        >
                          <span
                            className={clsx("material-symbols-outlined text-[14px] block", myFavorite ? "text-warning" : "text-text-muted/30")}
                            style={{ fontVariationSettings: `'FILL' ${myFavorite ? 1 : 0}` }}
                          >
                            star
                          </span>
                        </button>
                        <span className="truncate">{expense.description}</span>
                      </div>
                      <div className="flex flex-col gap-1 mt-1">
                        <div className="flex items-center gap-1 text-text-muted">
                          <span className="text-[10px]">{category?.icon || '🧾'}</span>
                          <span className="text-[9px] font-bold uppercase tracking-wider">{category?.name || 'Uncategorized'}</span>
                          {expense.images?.length > 0 && (
                            <span className="material-symbols-outlined text-[11px] text-text-muted/70" title="Has a photo">photo_camera</span>
                          )}
                        </div>
                        
                        {expense.splitInfo && expense.splitInfo.splits && (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[8px] font-bold text-text-muted uppercase tracking-tight">{t('addExpense.sharedWith')}</span>
                            <div className="flex flex-wrap gap-1">
                              {expense.splitInfo.splits.map((s: any) => {
                                const splitMember = members.find(m => m.userId === s.userId);
                                return (
                                  <div key={s.userId} className="flex items-center gap-0.5 bg-surface px-1.5 py-0.5 rounded-full border border-border-subtle shrink-0">
                                    <div className="w-2.5 h-2.5 rounded-full overflow-hidden bg-primary/10 flex-none scale-75">
                                      {splitMember?.photoURL ? (
                                        <img src={splitMember.photoURL} alt="" className="w-full h-full object-cover" />
                                      ) : (
                                        <span className="text-[6px] flex items-center justify-center h-full font-bold">{splitMember?.displayName?.slice(0, 1) || '?'}</span>
                                      )}
                                    </div>
                                    <span className="text-[8px] font-bold text-primary/80">
                                      {s.userId === user?.uid ? t('common.me') : (splitMember?.displayName?.split(' ')[0] || t('common.unknown'))}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {groupId === 'all' && group && (
                          <div className="flex items-center gap-1 text-primary/40 pt-0.5">
                            <span className="material-symbols-outlined text-[10px]">groups</span>
                            <span className="text-[8px] font-bold uppercase tracking-wider">{group.name}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="col-span-3 text-right">
                      <div className={clsx("text-sm font-bold", isIncomeRow ? "text-[#0F7A38]" : "text-primary")}>
                        {isIncomeRow && '+'}{getCurrencySymbol(group?.currency)}{expense.amount.toFixed(2)}
                      </div>
                      <button className="text-[10px] font-bold text-primary border border-primary/20 px-1.5 py-0.5 rounded uppercase mt-1 opacity-0 group-hover:opacity-100 transition-opacity">{t('common.edit')}</button>
                    </div>
                  </motion.div>
                );
              })
            ) : (
              <div className="px-6 py-10 text-center text-text-muted text-sm italic">{t('group.noTransactionsFound')}</div>
            )}
          </div>

          {/* Pagination Mock */}
          <div className="px-6 py-4 flex flex-col items-center gap-4 border-t border-border-subtle bg-surface-container-low">
            <p className="text-xs text-text-muted font-bold uppercase tracking-widest">
              {t('groupExpenses.showing')} <span className="text-primary">{Math.min(1, filteredExpenses.length)}-{filteredExpenses.length}</span> {t('common.of')} {filteredExpenses.length}
            </p>
            <div className="flex gap-2 w-full">
               <button className="flex-1 py-3 px-4 rounded-xl border border-border-subtle bg-white text-sm font-bold text-text-muted flex items-center justify-center gap-2 hover:bg-surface transition-colors active:scale-95 shadow-sm">
                 <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                 {t('common.prev')}
               </button>
               <button className="flex-1 py-3 px-4 rounded-xl border border-border-subtle bg-white text-sm font-bold text-primary flex items-center justify-center gap-2 hover:bg-surface transition-colors active:scale-95 shadow-sm">
                 {t('common.next')}
                 <span className="material-symbols-outlined text-[18px]">chevron_right</span>
               </button>
            </div>
          </div>
        </section>
      </main>

      {viewingExpense && (() => {
        const viewGroup = allGroups.find((g) => g.id === viewingExpense.groupId);
        const payer = members.find((m) => m.userId === viewingExpense.paidBy);
        return (
          <ExpenseQuickView
            expense={viewingExpense}
            groupId={viewingExpense.groupId}
            currencySymbol={getCurrencySymbol(viewGroup?.currency)}
            payerName={payer?.userId === user?.uid ? t('common.me') : (payer?.displayName || t('common.unknown'))}
            payerPhoto={payer?.photoURL}
            members={members}
            onClose={() => setViewingExpense(null)}
          />
        );
      })()}

      {/* Floating Action Button */}
      <AnimatePresence>
        {editingExpense && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeEditModal}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
            >
              <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-white shrink-0">
                <div className="flex items-center gap-1">
                  <h2 className="text-xl font-bold text-primary">{t('groupExpenses.expenseDetails')}</h2>
                  {(() => {
                    // `favoritedBy` is who has PERSONALLY starred this expense — any group member
                    // can edit/star ANY expense in a shared group, so this can't be a plain
                    // boolean (that would make my star toggle silently reflect someone ELSE's
                    // favorite status too, or overwrite theirs when I toggle mine).
                    const myFavorite = !!user && (editingExpense.favoritedBy || []).includes(user.uid);
                    return (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!user) return;
                          const current: string[] = editingExpense.favoritedBy || [];
                          const next = myFavorite ? current.filter((uid: string) => uid !== user.uid) : [...current, user.uid];
                          // Optimistic + immediate: fires its own isolated Firestore write right away
                          // (only the `favoritedBy` field changes) instead of waiting for "Save
                          // Changes", so this works for ANY group member — not just this expense's
                          // original adder or a group admin, who are the only ones allowed to edit
                          // the expense's other fields (see firestore.rules).
                          setEditingExpense({ ...editingExpense, favoritedBy: next });
                          try {
                            await updateDoc(doc(db, 'expenses', editingExpense.id), {
                              favoritedBy: myFavorite ? arrayRemove(user.uid) : arrayUnion(user.uid),
                            });
                          } catch (err) {
                            console.error('Failed to toggle favorite:', err);
                            setEditingExpense({ ...editingExpense, favoritedBy: current });
                          }
                        }}
                        className={clsx('p-1.5 rounded-full transition-colors shrink-0', myFavorite ? 'text-warning' : 'text-text-muted/40 hover:text-text-muted')}
                        aria-label={myFavorite ? 'Remove from favorites' : 'Mark as favorite'}
                        title={myFavorite ? 'Remove from favorites' : 'Mark as favorite'}
                      >
                        <span className="material-symbols-outlined text-[20px] block" style={{ fontVariationSettings: `'FILL' ${myFavorite ? 1 : 0}` }}>
                          star
                        </span>
                      </button>
                    );
                  })()}
                </div>
                <button onClick={closeEditModal} className="p-2 hover:bg-surface rounded-full">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 pt-4">
                <form id="edit-expense-form" onSubmit={handleUpdateExpense} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-text-muted px-1 uppercase">{t('addExpense.description')} <span className="text-error">*</span></label>
                  <input 
                    type="text" 
                    value={editingExpense.description}
                    onChange={e => setEditingExpense({...editingExpense, description: e.target.value})}
                    className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle font-medium outline-none"
                  />
                </div>

                <div className="flex items-start gap-2 relative z-[20]">
                  <div className="flex-1 min-w-0 space-y-1">
                    <label className="text-[10px] font-bold text-text-muted px-1 uppercase">{t('addExpense.group')} <span className="text-error">*</span></label>
                    <div className="relative">
                      {editingExpense.splitInfo ? (
                        <div className="w-full h-12 bg-surface-container px-4 rounded-xl border border-border-subtle flex items-center font-bold text-primary opacity-70">
                          {allGroups.find(g => g.id === editingExpense.groupId)?.name || groupData?.name || 'Unknown Group'}
                        </div>
                      ) : (
                        <>
                          <select
                            value={editingExpense.groupId}
                            onChange={e => setEditingExpense({...editingExpense, groupId: e.target.value})}
                            className="w-full h-12 bg-surface pl-3 pr-8 rounded-xl border border-border-subtle font-bold text-primary appearance-none outline-none cursor-pointer"
                          >
                            {allGroups.map((g: any) => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                          <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-lg pointer-events-none">expand_more</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <ImageAttachments
                      images={editingExpense.images || []}
                      onChange={(images) => setEditingExpense({ ...editingExpense, images })}
                      label={t('addExpense.addReceiptPhoto')}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-text-muted px-1 uppercase">{t('addExpense.date')}</label>
                  <input
                    type="date"
                    value={editingExpense.date}
                    onChange={e => setEditingExpense({...editingExpense, date: e.target.value})}
                    className="w-full h-12 bg-surface px-4 rounded-xl border border-border-subtle font-medium outline-none"
                  />
                </div>

                {allGroups.find(g => g.id === editingExpense.groupId)?.incomeEnabled && (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditingExpense({ ...editingExpense, type: 'expense', category: EXPENSE_CATEGORIES[0].id })}
                      className={clsx(
                        'flex-1 h-12 rounded-xl border transition-all flex items-center justify-center gap-2',
                        (editingExpense.type || 'expense') === 'expense' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'
                      )}
                    >
                      <span className="material-symbols-outlined text-[18px]">remove_circle</span>
                      <span className="text-xs font-bold uppercase tracking-wide">{t('addExpense.expense')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingExpense({ ...editingExpense, type: 'income', category: INCOME_CATEGORIES[0].id, splitInfo: undefined })}
                      className={clsx(
                        'flex-1 h-12 rounded-xl border transition-all flex items-center justify-center gap-2',
                        editingExpense.type === 'income' ? 'bg-success text-white border-success' : 'bg-white text-text-muted border-border-subtle'
                      )}
                    >
                      <span className="material-symbols-outlined text-[18px]">add_circle</span>
                      <span className="text-xs font-bold uppercase tracking-wide">{t('addExpense.income')}</span>
                    </button>
                  </div>
                )}

                <div className="space-y-1 relative z-[10]">
                  <div className="flex items-start justify-between gap-2 px-1">
                    <label className="text-[10px] font-bold text-text-muted uppercase">{t('addExpense.amountWithCurrency', { currency: allGroups.find(g => g.id === editingExpense.groupId)?.currency || groupData?.currency || 'USD' })} <span className="text-error">*</span></label>
                    {editBudget && (() => {
                      const editCurrencySymbol = getCurrencySymbol(allGroups.find(g => g.id === editingExpense.groupId)?.currency || groupData?.currency);
                      const signedEntryAmount = editingExpense.type === 'income' ? 0 : (editingExpense.amount || 0);
                      const projectedRemaining = editBudget.amount - editMonthSpendSoFar - signedEntryAmount;
                      const isOver = projectedRemaining < 0;
                      // Rounded to the nearest rupee before comparing — see the matching comment
                      // in AddExpense.tsx for why the raw (unrounded) reconstruction from a stored
                      // 4-decimal % can land a fraction of a rupee off an exact amount entry.
                      const categoryBudgetAmount = Math.round((editBudget.amount * editCategoryBudgetPct) / 100);
                      const categoryProjectedRemaining = categoryBudgetAmount - editCategorySpendSoFar - signedEntryAmount;
                      const isCategoryOver = categoryProjectedRemaining < 0;
                      return (
                        <span className="text-right shrink-0">
                          <span className={clsx('block text-[10px] font-bold', isOver ? 'text-error' : 'text-success')}>
                            {isOver ? t('addExpense.overBudgetBy') : t('addExpense.remainingBudget')} {editCurrencySymbol}{Math.abs(projectedRemaining).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                          {editingExpense.type !== 'income' && editCategoryBudgetPct > 0 && (
                            <span className={clsx('block text-[10px] font-bold', isCategoryOver ? 'text-error' : 'text-primary')}>
                              {t('addExpense.categoryBudgetLine', {
                                category: t(`category.${editingExpense.category}`),
                                label: isCategoryOver ? t('addExpense.overBudgetBy') : t('addExpense.remainingBudget'),
                                amount: `${editCurrencySymbol}${Math.abs(categoryProjectedRemaining).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                              })}
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="relative flex items-center gap-2">
                    <div className="relative flex-1">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-primary">
                        {getCurrencySymbol(allGroups.find(g => g.id === editingExpense.groupId)?.currency || groupData?.currency)}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder={t('addExpense.amountPlaceholder')}
                        value={amountInput}
                        onChange={(e) => {
                          const next = e.target.value;
                          setAmountInput(next);
                          const evaluated = evaluateAmountSum(next);
                          if (evaluated !== null) setEditingExpense({ ...editingExpense, amount: evaluated });
                        }}
                        className="w-full h-12 bg-surface pl-10 pr-4 rounded-xl border border-border-subtle font-bold text-primary outline-none"
                      />
                    </div>
                    {hasAmountSumOperator(amountInput) && evaluateAmountSum(amountInput) !== null && (
                      <span className="text-xs font-bold text-success bg-success/10 px-2 py-1 rounded-lg whitespace-nowrap shrink-0">
                        = {getCurrencySymbol(allGroups.find(g => g.id === editingExpense.groupId)?.currency || groupData?.currency)}{evaluateAmountSum(amountInput)!.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>

                {editingExpense.splitInfo && (
                  <div className="space-y-4 border-t border-border-subtle pt-4 mt-2">
                    <section className="space-y-2">
                      <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('addExpense.whoPaid')}</label>
                      <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar px-1">
                        {editingGroupMembers.map(member => (
                          <button
                            key={member.userId}
                            type="button"
                            onClick={() => setEditingExpense({...editingExpense, paidBy: member.userId})}
                            className={clsx(
                              "flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm shrink-0",
                              editingExpense.paidBy === member.userId 
                                ? "bg-primary text-white border-primary" 
                                : "bg-white text-on-surface border-border-subtle hover:bg-surface-container"
                            )}
                          >
                            <div className="w-4 h-4 rounded-full overflow-hidden bg-primary/10">
                              {member.photoURL ? (
                                <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <span className="material-symbols-outlined text-[10px] flex items-center justify-center h-full">person</span>
                              )}
                            </div>
                            {member.userId === user?.uid ? t('common.me') : member.displayName}
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="space-y-2">
                      <div className="flex items-center justify-between px-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('addExpense.sharedWith')}</label>
                        <button 
                          type="button"
                          onClick={() => {
                            const currentSplits = editingExpense.splitInfo.splits || [];
                            if (currentSplits.length === editingGroupMembers.length) {
                              setEditingExpense({
                                ...editingExpense,
                                splitInfo: { ...editingExpense.splitInfo, splits: [] }
                              });
                            } else {
                              setEditingExpense({
                                ...editingExpense,
                                splitInfo: { 
                                  ...editingExpense.splitInfo, 
                                  splits: editingGroupMembers.map(m => ({ userId: m.userId, amount: 0 })) 
                                }
                              });
                            }
                          }}
                          className="text-[9px] font-bold text-primary hover:underline"
                        >
                          {editingExpense.splitInfo.splits.length === editingGroupMembers.length ? t('addExpense.deselectAll') : t('addExpense.selectAll')}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2 px-1">
                        {editingGroupMembers.map(member => {
                          const isSelected = editingExpense.splitInfo.splits.some((s: any) => s.userId === member.userId);
                          return (
                            <button
                              key={member.userId}
                              type="button"
                              onClick={() => {
                                const currentSplits = editingExpense.splitInfo.splits || [];
                                if (isSelected) {
                                  setEditingExpense({
                                    ...editingExpense,
                                    splitInfo: {
                                      ...editingExpense.splitInfo,
                                      splits: currentSplits.filter((s: any) => s.userId !== member.userId)
                                    }
                                  });
                                } else {
                                  setEditingExpense({
                                    ...editingExpense,
                                    splitInfo: {
                                      ...editingExpense.splitInfo,
                                      splits: [...currentSplits, { userId: member.userId, amount: 0 }]
                                    }
                                  });
                                }
                              }}
                              className={clsx(
                                "flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm",
                                isSelected 
                                  ? "bg-primary text-white border-primary" 
                                  : "bg-white text-on-surface border-border-subtle hover:bg-surface-container"
                              )}
                            >
                              <div className="w-4 h-4 rounded-full overflow-hidden bg-primary/10">
                                {member.photoURL ? (
                                  <img src={member.photoURL} alt="" className="w-full h-full object-cover" />
                                ) : (
                                  <span className="material-symbols-outlined text-[10px] flex items-center justify-center h-full">person</span>
                                )}
                              </div>
                              {member.userId === user?.uid ? t('common.me') : member.displayName}
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section className="space-y-2">
                      <label className="px-1 text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('groupExpenses.method')}</label>
                      <div className="grid grid-cols-3 gap-2 px-1">
                        {[
                          { id: 'equally', label: t('addExpense.equally'), icon: 'balance' },
                          { id: 'percentage', label: t('addExpense.percent'), icon: 'percent' },
                          { id: 'amount', label: t('common.amount'), icon: 'payments' },
                        ].map(method => (
                          <button
                            key={method.id}
                            type="button"
                            onClick={() => setEditingExpense({
                              ...editingExpense,
                              splitInfo: { ...editingExpense.splitInfo, splitType: method.id }
                            })}
                            className={clsx(
                              "flex flex-col items-center justify-center p-2 rounded-xl border transition-all active:scale-95 gap-1",
                              editingExpense.splitInfo.splitType === method.id 
                                ? "bg-primary text-white border-primary shadow-inner" 
                                : "bg-white border-border-subtle hover:bg-surface-container"
                            )}
                          >
                            <span className="material-symbols-outlined text-[16px]">{method.icon}</span>
                            <span className="text-[10px] font-bold">{method.label}</span>
                          </button>
                        ))}
                      </div>
                    </section>

                    {editingExpense.splitInfo.splitType !== 'equally' && editingExpense.splitInfo.splits.length > 0 && (
                      <div className="space-y-2 bg-surface p-3 rounded-2xl border border-border-subtle">
                         {editingExpense.splitInfo.splits.map((s: any) => {
                            const member = editingGroupMembers.find(m => m.userId === s.userId);
                            return (
                              <div key={s.userId} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-border-subtle">
                                <span className="text-xs font-bold text-on-surface flex-1 truncate">
                                  {s.userId === user?.uid ? t('common.me') : member?.displayName}
                                </span>
                                <div className="flex items-center gap-1">
                                  {editingExpense.splitInfo.splitType === 'amount' && <span className="text-[10px] font-bold text-primary">{getCurrencySymbol(allGroups.find(g => g.id === editingExpense.groupId)?.currency)}</span>}
                                  <input 
                                    type="number"
                                    value={editingExpense.splitInfo.splitType === 'amount' ? (s.amount || '') : (s.percentage || '')}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value) || 0;
                                      const newSplits = editingExpense.splitInfo.splits.map((split: any) => 
                                        split.userId === s.userId 
                                          ? (editingExpense.splitInfo.splitType === 'amount' ? { ...split, amount: val } : { ...split, percentage: val })
                                          : split
                                      );
                                      setEditingExpense({
                                        ...editingExpense,
                                        splitInfo: { ...editingExpense.splitInfo, splits: newSplits }
                                      });
                                    }}
                                    placeholder="0"
                                    className="w-16 h-8 bg-surface rounded-lg border border-border-subtle text-right px-2 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                  />
                                  {editingExpense.splitInfo.splitType === 'percentage' && <span className="text-[10px] font-bold text-primary">%</span>}
                                </div>
                              </div>
                            );
                         })}
                         
                        {editingExpense.splitInfo.splitType === 'percentage' && (
                          <div className={clsx(
                            "text-[9px] font-bold text-center mt-1",
                            Math.abs(editingExpense.splitInfo.splits.reduce((a: any, b: any) => a + (b.percentage || 0), 0) - 100) < 0.01 ? "text-success" : "text-error"
                          )}>
                            {t('addExpense.totalPercent', { pct: editingExpense.splitInfo.splits.reduce((a: any, b: any) => a + (b.percentage || 0), 0).toFixed(1) })}
                          </div>
                        )}
                        {editingExpense.splitInfo.splitType === 'amount' && (
                          <div className={clsx(
                            "text-[9px] font-bold text-center mt-1",
                            Math.abs(editingExpense.splitInfo.splits.reduce((a: any, b: any) => a + (b.amount || 0), 0) - Number(editingExpense.amount)) < 0.01 ? "text-success" : "text-error"
                          )}>
                            {t('addExpense.totalAmount', {
                              spent: `${getCurrencySymbol(allGroups.find(g => g.id === editingExpense.groupId)?.currency)}${editingExpense.splitInfo.splits.reduce((a: any, b: any) => a + (b.amount || 0), 0).toFixed(2)}`,
                              total: `${getCurrencySymbol(allGroups.find(g => g.id === editingExpense.groupId)?.currency)}${Number(editingExpense.amount).toFixed(2)}`,
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                 <div className="space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <label className="text-[10px] font-bold text-text-muted uppercase">{t('addExpense.category')}</label>
                    {editingExpense.type !== 'income' && editingExpense.category && (
                      <span className={clsx(
                        'text-[9px] font-bold px-2 py-0.5 rounded-full',
                        getCategoryClassification(allGroups.find(g => g.id === editingExpense.groupId), editingExpense.category) === 'essential'
                          ? 'bg-success/10 text-success'
                          : 'bg-warning/10 text-warning',
                      )}>
                        {getCategoryClassification(allGroups.find(g => g.id === editingExpense.groupId), editingExpense.category) === 'essential' ? t('common.essential') : t('common.optional')}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {(editingExpense.type === 'income' ? INCOME_CATEGORIES : CATEGORIES).map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setEditingExpense({...editingExpense, category: c.id})}
                        className={clsx(
                          "p-1.5 border rounded-xl flex flex-col items-center gap-0.5 transition-all min-h-[51px]",
                          editingExpense.category === c.id ? "bg-primary border-primary text-white shadow-inner" : "bg-white border-border-subtle"
                        )}
                      >
                        <span className="text-[15px] leading-none">{c.icon}</span>
                        <span className="text-[9px] font-bold uppercase truncate w-full px-0.5 text-center leading-tight">
                          {t(`${editingExpense.type === 'income' ? 'income' : 'category'}.${c.id}`)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                  <div className="bg-surface p-3 rounded-2xl border border-border-subtle space-y-3">
                    <button
                      type="button"
                      onClick={() => setEditMakeRecurring((v) => !v)}
                      className="w-full flex items-center gap-2.5"
                    >
                      <span className={clsx(
                        'w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all',
                        editMakeRecurring ? 'bg-primary text-white' : 'bg-white text-text-muted',
                      )}>
                        <span className="material-symbols-outlined text-[18px]">event_repeat</span>
                      </span>
                      <span className="flex-1 text-left">
                        <span className="block text-sm font-bold text-on-surface">{t('addExpense.makeRecurring')}</span>
                        <span className="block text-[11px] text-text-muted">{t('groupExpenses.setUpRule')}</span>
                      </span>
                      <span className={clsx(
                        'w-10 h-6 rounded-full p-0.5 transition-all shrink-0',
                        editMakeRecurring ? 'bg-primary' : 'bg-surface-container',
                      )}>
                        <span className={clsx(
                          'block w-5 h-5 rounded-full bg-white shadow-sm transition-transform',
                          editMakeRecurring && 'translate-x-4',
                        )} />
                      </span>
                    </button>
                    {editMakeRecurring && (
                      <div className="border-t border-border-subtle pt-3">
                        <FrequencyPicker config={editRecurFreqConfig} onChange={setEditRecurFreqConfig} />
                      </div>
                    )}
                  </div>

                </form>

                <Comments
                  pathSegments={['expenses', editingExpense.id, 'comments']}
                  onPosted={(text) => notifyGroupActivity({
                    groupId: editingExpense.groupId,
                    action: 'commented',
                    description: text,
                    contextLabel: editingExpense.description,
                    actorName: user?.displayName || 'Someone',
                    expenseId: editingExpense.id,
                  })}
                />
              </div>

              <div className="p-6 border-t border-border-subtle bg-white shrink-0">
                <div className="flex gap-3">
                  <button 
                    type="button"
                    onClick={handleDeleteExpense}
                    disabled={editLoading}
                    className="flex-1 h-12 border-2 border-error/30 text-error font-bold rounded-xl active:scale-95 transition-all text-sm hover:bg-error/5"
                  >
                    {t('common.delete')}
                  </button>
                  <button
                    form="edit-expense-form"
                    type="submit"
                    disabled={editLoading}
                    className="flex-[2] h-12 bg-primary text-white font-bold rounded-xl shadow-lg shadow-primary/20 active:scale-95 transition-all text-sm flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[18px]">{editLoading ? 'progress_activity' : 'check'}</span>
                    {editLoading ? t('addExpense.saving') : t('common.save')}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
