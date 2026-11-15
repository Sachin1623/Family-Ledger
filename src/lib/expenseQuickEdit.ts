import { collection, doc, getDoc, getDocs, query, runTransaction, updateDoc, where } from 'firebase/firestore';
import { db } from './firebase';
import { updateGlobalStats } from '../services/statsService';
import { notifyGroupActivity } from './notifyGroupActivity';
import { getCurrencySymbol } from './constants';

// One-field changes made straight from the expense pop-up (amount, category, group, delete), without opening the full edit window.
// Each mirrors what the edit window's Save / Delete does for that one change: group totals, the activity log, the global stats and the
// notification. Anything these cannot do safely (an amount change on a custom-amount split or a multi-payer expense) throws NeedsEditor
// so the caller can offer the full edit window instead.

export interface Actor { uid: string; name: string; photo: string }
export class NeedsEditor extends Error {}

const totalsField = (type: string | undefined): 'totalIncome' | 'totalSpending' => (type === 'income' ? 'totalIncome' : 'totalSpending');
const now = () => new Date().toISOString();

export async function changeCategory(exp: any, category: string, actor: Actor) {
  await updateDoc(doc(db, 'expenses', exp.id), { category, updatedAt: now() });
  notifyGroupActivity({ groupId: exp.groupId, action: 'updated', description: exp.description, amount: exp.amount, actorName: actor.name });
}

export async function changeAmount(exp: any, newAmount: number, actor: Actor) {
  if (!newAmount || newAmount <= 0) throw new Error('Enter an amount above zero.');
  if (exp.splitInfo?.splitType === 'amount') throw new NeedsEditor('This expense has custom split amounts, so they need to be adjusted too.');
  if (Array.isArray(exp.payers) && exp.payers.length > 0) throw new NeedsEditor('This expense has several payers, so their amounts need to be adjusted too.');
  await runTransaction(db, async (tx) => {
    const groupRef = doc(db, 'groups', exp.groupId);
    const groupDoc = await tx.get(groupRef);
    if (!groupDoc.exists()) throw new Error('Group not found');
    const update: any = { amount: newAmount, updatedAt: now() };
    if (exp.splitInfo) {
      let splits = [...exp.splitInfo.splits];
      if (exp.splitInfo.splitType === 'equally') {
        const share = newAmount / (splits.length || 1);
        splits = splits.map((s: any) => ({ ...s, amount: share }));
      } else if (exp.splitInfo.splitType === 'percentage') {
        splits = splits.map((s: any) => ({ ...s, amount: (newAmount * (s.percentage || 0)) / 100 }));
      }
      update.splitInfo = { ...exp.splitInfo, splits };
    }
    tx.update(doc(db, 'expenses', exp.id), update);
    const field = totalsField(exp.type);
    tx.update(groupRef, { [field]: (groupDoc.data()[field] || 0) + (newAmount - exp.amount) });
    tx.set(doc(collection(db, 'activities')), {
      groupId: exp.groupId, userId: actor.uid, userName: actor.name, userPhoto: actor.photo, type: 'edit_expense',
      description: `${actor.name} updated expense: ${exp.description}`,
      data: { oldAmount: exp.amount, newAmount, description: exp.description, currencySymbol: getCurrencySymbol(groupDoc.data()?.currency), currencyCode: groupDoc.data()?.currency },
      createdAt: now(),
    });
  });
  if (exp.type !== 'income') await updateGlobalStats({ amount: newAmount - exp.amount });
  notifyGroupActivity({ groupId: exp.groupId, action: 'updated', description: exp.description, amount: newAmount, actorName: actor.name });
}

// The groups this person can move an expense into: every group they belong to except Payments groups, which hold payments, not expenses.
export async function loadMoveTargets(uid: string, currentGroupId: string): Promise<any[]> {
  const memberships = await getDocs(query(collection(db, 'members'), where('userId', '==', uid)));
  const ids = Array.from(new Set(memberships.docs.map((d) => d.data().groupId as string))).filter((id) => id && id !== currentGroupId);
  const docs = await Promise.all(ids.map((id) => getDoc(doc(db, 'groups', id))));
  return docs.filter((d) => d.exists()).map((d) => ({ id: d.id, ...d.data() }));
}

export async function moveToGroup(exp: any, target: any, newCategory: string, actor: Actor) {
  if (exp.splitInfo) throw new Error('This expense is shared between members, so it stays in its group.');
  if (exp.paidBy) {
    const payerIn = await getDoc(doc(db, 'members', `${exp.paidBy}_${target.id}`));
    if (!payerIn.exists()) throw new Error(`The person who paid is not in ${target.name}, so this expense cannot move there.`);
  }
  await runTransaction(db, async (tx) => {
    const oldRef = doc(db, 'groups', exp.groupId);
    const newRef = doc(db, 'groups', target.id);
    const [oldDoc, newDoc] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);
    if (!oldDoc.exists() || !newDoc.exists()) throw new Error('Group not found');
    const field = totalsField(exp.type);
    tx.update(oldRef, { [field]: Math.max(0, (oldDoc.data()[field] || 0) - exp.amount) });
    tx.update(newRef, { [field]: (newDoc.data()[field] || 0) + exp.amount });
    tx.update(doc(db, 'expenses', exp.id), { groupId: target.id, category: newCategory, updatedAt: now() });
    tx.set(doc(collection(db, 'activities')), {
      groupId: target.id, userId: actor.uid, userName: actor.name, userPhoto: actor.photo, type: 'add_expense',
      description: `${actor.name} moved expense "${exp.description}" into this group`,
      data: { amount: exp.amount, description: exp.description, currencySymbol: getCurrencySymbol(newDoc.data().currency), currencyCode: newDoc.data().currency },
      createdAt: now(),
    });
  });
  notifyGroupActivity({ groupId: target.id, action: 'updated', description: exp.description, amount: exp.amount, actorName: actor.name });
}

export async function deleteExpense(exp: any, actor: Actor) {
  await runTransaction(db, async (tx) => {
    const groupRef = doc(db, 'groups', exp.groupId);
    const groupDoc = await tx.get(groupRef);
    if (!groupDoc.exists()) throw new Error('Group not found');
    const field = totalsField(exp.type);
    tx.delete(doc(db, 'expenses', exp.id));
    tx.update(groupRef, { [field]: Math.max(0, (groupDoc.data()[field] || 0) - exp.amount) });
    tx.set(doc(collection(db, 'activities')), {
      groupId: exp.groupId, userId: actor.uid, userName: actor.name, userPhoto: actor.photo, type: 'delete_expense',
      description: `${actor.name} deleted expense: ${exp.description}`,
      data: { amount: exp.amount, description: exp.description, currencySymbol: getCurrencySymbol(groupDoc.data()?.currency), currencyCode: groupDoc.data()?.currency },
      createdAt: now(),
    });
  });
  if (exp.type !== 'income') await updateGlobalStats({ expenses: -1, amount: -exp.amount });
  notifyGroupActivity({ groupId: exp.groupId, action: 'deleted', description: exp.description, amount: exp.amount, actorName: actor.name });
}
