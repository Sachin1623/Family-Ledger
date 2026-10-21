import { collection, deleteDoc, doc, getDoc, getDocs, increment, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { db, trackEvent } from './firebase';
import { fireWrite } from './offlineWrite';
import { claimPoints } from './pointsApi';
import { updateGlobalStats } from '../services/statsService';
import { notifyGroupActivity } from './notifyGroupActivity';
import { markExpenseAdded } from './recentlyAddedExpenses';
import { buildRoster } from './groupParticipants';
import { getCurrencySymbol, getCategoryNameOverride, getGroupCategories } from './constants';
import { todayLocalDateString } from './dateUtils';
import { parseSpokenExpense } from './voiceExpense';

// "Say it, and it is added": turns a spoken sentence straight into a saved expense — no form. The person gets a few seconds to undo
// (see VoiceQuickAdd.tsx); the group is only told about it, and points only claimed, once those seconds pass without an undo, so a
// misheard sentence never reaches the rest of the family.
//
// Defaults for everything the sentence does not say: the signed-in person paid, today's date, and — where the group splits
// expenses — split equally among everyone in the group (exactly what the Add Expense form starts with).

export const LAST_EXPENSE_GROUP_KEY = 'fl_last_expense_group';
export const QUICK_ADDED_EVENT = 'fl:quick-added';

export type QuickAddResult =
  | {
      ok: true;
      groupId: string;
      groupName: string;
      expenseId: string;
      amount: number;
      description: string;
      categoryName: string;
      categoryIcon: string;
      isIncome: boolean;
      currencySymbol: string;
      /** Tell the group, log the activity, claim points. Called once the undo window has passed. */
      finalize: () => void;
      /** Take the expense back out completely. */
      undo: () => Promise<void>;
    }
  | { ok: false; reason: 'no-amount' | 'no-group' | 'failed'; sentence: string };

async function pickGroup(uid: string, hint?: string): Promise<{ id: string; data: any } | null> {
  if (hint) {
    const snap = await getDoc(doc(db, 'groups', hint));
    return snap.exists() ? { id: snap.id, data: snap.data() } : null;
  }
  const mine = await getDocs(query(collection(db, 'members'), where('userId', '==', uid)));
  const ids = Array.from(new Set(mine.docs.map((d) => (d.data() as any).groupId as string)));
  const groups: { id: string; data: any }[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const snap = await getDoc(doc(db, 'groups', id)).catch(() => null);
      if (snap?.exists() && !(snap.data() as any).archived) groups.push({ id: snap.id, data: snap.data() });
    }),
  );
  if (groups.length === 1) return groups[0];
  let last = '';
  try { last = localStorage.getItem(LAST_EXPENSE_GROUP_KEY) || ''; } catch { /* ignore */ }
  return groups.find((g) => g.id === last) || null;
}

export async function quickAddFromSpeech(params: {
  sentence: string;
  user: { uid: string; displayName?: string | null };
  profile?: { displayName?: string } | null;
  groupId?: string;
}): Promise<QuickAddResult> {
  const { sentence, user, profile } = params;
  try {
    const group = await pickGroup(user.uid, params.groupId);
    if (!group) return { ok: false, reason: 'no-group', sentence };

    const incomeAllowed = !!group.data.incomeEnabled;
    const asIncome = incomeAllowed && parseSpokenExpense(sentence, getGroupCategories(group.data, 'income'), new Date()).isIncome;
    const kind = asIncome ? 'income' : 'expense';
    const cats = getGroupCategories(group.data, kind).map((c) => ({ id: c.id, name: getCategoryNameOverride(group.data, c.id) || c.name }));
    const parsed = parseSpokenExpense(sentence, cats, new Date());
    if (!parsed.amount || parsed.amount <= 0) return { ok: false, reason: 'no-amount', sentence };

    const category = parsed.categoryId || (kind === 'income' ? 'other_income' : 'misc');
    const picked = getGroupCategories(group.data, kind).find((c) => c.id === category);
    const categoryName = (picked && (getCategoryNameOverride(group.data, picked.id) || picked.name)) || category;
    const description = parsed.description || categoryName;
    const amount = parsed.amount;
    const isIncome = kind === 'income';
    const currencySymbol = getCurrencySymbol(group.data.currency);
    const actorName = profile?.displayName || user.displayName || 'Someone';

    const expenseRef = doc(collection(db, 'expenses'));
    const expenseDoc: any = {
      groupId: group.id,
      amount,
      description,
      category,
      date: parsed.date || todayLocalDateString(),
      paidBy: user.uid,
      paymentMethod: 'cash',
      addedBy: user.uid,
      type: kind,
      createdAt: new Date().toISOString(),
      favoritedBy: [],
      viaVoice: true,
    };
    if (!isIncome && group.data.splitEnabled) {
      const membersSnap = await getDocs(query(collection(db, 'members'), where('groupId', '==', group.id)));
      const roster = buildRoster(membersSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })), group.data);
      const ids = roster.map((m: any) => m.userId).filter(Boolean);
      const splitIds = ids.length > 0 ? ids : [user.uid];
      expenseDoc.splitInfo = { splitType: 'equally', splits: splitIds.map((uid: string) => ({ userId: uid, amount: amount / splitIds.length })) };
    }

    const groupRef = doc(db, 'groups', group.id);
    fireWrite(setDoc(expenseRef, expenseDoc), 'add expense by voice');
    fireWrite(
      updateDoc(groupRef, { totalSpending: increment(isIncome ? 0 : amount), totalIncome: increment(isIncome ? amount : 0) }),
      'update group total',
    );
    try { localStorage.setItem(LAST_EXPENSE_GROUP_KEY, group.id); } catch { /* ignore */ }
    markExpenseAdded(group.id, expenseRef.id);
    trackEvent(isIncome ? 'income_added' : 'expense_added', { category, value: amount, via: 'voice' });
    window.dispatchEvent(new CustomEvent(QUICK_ADDED_EVENT, { detail: { groupId: group.id, expenseId: expenseRef.id } }));

    let settled = false;
    const finalize = () => {
      if (settled) return;
      settled = true;
      const activityRef = doc(collection(db, 'activities'));
      fireWrite(
        setDoc(activityRef, {
          groupId: group.id,
          userId: user.uid,
          userName: actorName,
          userPhoto: '',
          type: isIncome ? 'add_income' : 'add_expense',
          description: `${actorName} ${isIncome ? 'added income' : 'added an expense'}: ${description}`,
          data: { amount, description, groupName: group.data.name, currencySymbol, currencyCode: group.data.currency },
          createdAt: new Date().toISOString(),
        }),
        'log expense activity',
      );
      if (!isIncome) {
        claimPoints('expense_logged', { expenseId: expenseRef.id });
        updateGlobalStats({ expenses: 1, amount }).catch((err) => console.error('updateGlobalStats failed:', err));
      }
      setDoc(doc(db, 'users', user.uid), { lastExpenseAddedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
      notifyGroupActivity({ groupId: group.id, action: isIncome ? 'income_added' : 'added', description, amount, actorName });
    };
    const undo = async () => {
      if (settled) return;
      settled = true;
      await deleteDoc(expenseRef);
      await updateDoc(groupRef, { totalSpending: increment(isIncome ? 0 : -amount), totalIncome: increment(isIncome ? -amount : 0) });
    };

    return {
      ok: true,
      groupId: group.id,
      groupName: group.data.name || '',
      expenseId: expenseRef.id,
      amount,
      description,
      categoryName,
      categoryIcon: picked?.icon || '🧾',
      isIncome,
      currencySymbol,
      finalize,
      undo,
    };
  } catch (err) {
    console.error('quick add by voice failed:', err);
    return { ok: false, reason: 'failed', sentence };
  }
}
