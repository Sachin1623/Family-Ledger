import { collection, deleteField, doc, getDocs, query, setDoc, where, writeBatch } from 'firebase/firestore';
import { db } from './firebase';

// the key a store's category and spend are saved under on a list (`storeTotals`)
export const storeFieldKey = (store: string) => (store || '_none').replace(/[.\/\[\]*`~]/g, '_').slice(0, 60);

// Renames one of the person's stores everywhere it is still live: their list of stores, the items they have set to repeat, what they
// remember about each item they have bought, and every list that is not finished yet (its items and the spend saved for the store).
// Finished lists keep the name they were shopped under.
export async function renameStore(uid: string, profile: any, oldName: string, newName: string): Promise<void> {
  const next = newName.trim().slice(0, 40);
  if (!next || next === oldName) return;

  // 1. the person's own record: the store list, repeating items and history
  const stores: string[] = profile?.shoppingStores || [];
  const patch: Record<string, unknown> = {
    shoppingStores: Array.from(new Set([...stores.map((s) => (s === oldName ? next : s)), ...(stores.includes(oldName) ? [] : [next])])),
  };
  const recurring: Record<string, unknown> = {};
  Object.entries((profile?.shoppingRecurring || {}) as Record<string, any>).forEach(([k, e]) => { if (e?.store === oldName) recurring[k] = { store: next }; });
  if (Object.keys(recurring).length) patch.shoppingRecurring = recurring;
  const history: Record<string, unknown> = {};
  Object.entries((profile?.shoppingHistory || {}) as Record<string, any>).forEach(([k, e]) => { if (e?.store === oldName) history[k] = { store: next }; });
  if (Object.keys(history).length) patch.shoppingHistory = history;
  await setDoc(doc(db, 'users', uid), patch, { merge: true });

  // 2. lists that are not finished: the items in this store, and the category and spend saved for it
  const lists = await getDocs(query(collection(db, 'shoppingLists'), where('userId', '==', uid), where('completed', '==', false)));
  const oldKey = storeFieldKey(oldName);
  const newKey = storeFieldKey(next);
  for (const listDoc of lists.docs) {
    const batch = writeBatch(db);
    let writes = 0;
    const itemsSnap = await getDocs(query(collection(db, 'shoppingLists', listDoc.id, 'items'), where('store', '==', oldName)));
    itemsSnap.docs.forEach((it) => { batch.update(it.ref, { store: next }); writes++; });
    const totals = (listDoc.data().storeTotals || {}) as Record<string, any>;
    if (totals[oldKey] && oldKey !== newKey) {
      batch.set(listDoc.ref, { storeTotals: { [newKey]: { ...totals[oldKey], store: next }, [oldKey]: deleteField() } }, { merge: true });
      writes++;
    }
    if (writes > 0) await batch.commit();
  }
}
