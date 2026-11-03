import { doc, setDoc, getDocs, collection, deleteField } from 'firebase/firestore';
import { db } from './firebase';

// What a person has bought before, kept on their own user record (`users/{uid}.shoppingHistory`, a map keyed by the
// item's normalised name) so the shopping list screens can suggest items without reading every old list. Each entry
// remembers how often and when the item was bought and the last quantity and unit used, which is also what the
// suggested quantity is based on.
export interface HistoryEntry {
  name: string;
  count: number;
  firstAt: string;
  lastAt: string;
  qty?: number | null;
  unit?: string | null;
  store?: string | null;
}
export type ShoppingHistory = Record<string, HistoryEntry>;

export interface Suggestion {
  key: string;
  name: string;
  qty: number | null;
  unit: string | null;
  store: string | null;
  due: boolean;
}

const MAX_ENTRIES = 300;
const BACKFILL_LISTS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export const normalizeItemName = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
// a Firestore map key must not be empty or contain these characters
export const historyKey = (text: string) => normalizeItemName(text).replace(/[.\/\[\]*`~]/g, '_').slice(0, 100);

// Called when an item is ticked as bought. Ticking it twice within ten minutes (an undo and redo) counts once.
export function recordPurchase(uid: string, history: ShoppingHistory, item: { text: string; qty?: number | null; unit?: string | null; store?: string | null }, at: string = new Date().toISOString()) {
  const key = historyKey(item.text);
  if (!key) return;
  const prev = history[key];
  if (prev && Math.abs(new Date(at).getTime() - new Date(prev.lastAt).getTime()) < 10 * 60 * 1000) return;
  const entry: HistoryEntry = {
    name: item.text.trim().slice(0, 100),
    count: (prev?.count || 0) + 1,
    firstAt: prev?.firstAt || at,
    lastAt: at,
    qty: item.qty ?? prev?.qty ?? null,
    unit: item.unit ?? prev?.unit ?? null,
    store: item.store ?? prev?.store ?? null,
  };
  const patch: Record<string, unknown> = { [key]: entry };
  // keep the map from growing without end: drop the least recently bought
  const keys = Object.keys(history);
  if (!prev && keys.length >= MAX_ENTRIES) {
    const oldest = keys.sort((a, b) => (history[a].lastAt || '').localeCompare(history[b].lastAt || ''))[0];
    patch[oldest] = deleteField();
  }
  setDoc(doc(db, 'users', uid), { shoppingHistory: patch }, { merge: true }).catch((err) => console.error('shopping history update failed:', err));
}

// Items to offer as one-tap suggestions: what is probably due again first (judged from how often it is bought), then
// the most often bought, then the most recent. Anything already in the list is left out.
export function suggestFromHistory(history: ShoppingHistory | undefined, exclude: Set<string>, limit = 10): Suggestion[] {
  const now = Date.now();
  return Object.entries(history || {})
    .filter(([key, e]) => e && e.name && !exclude.has(key))
    .map(([key, e]) => {
      const last = new Date(e.lastAt).getTime();
      const first = new Date(e.firstAt).getTime();
      const intervalDays = e.count > 1 ? Math.max(1, (last - first) / (e.count - 1) / DAY_MS) : null;
      const dueRatio = intervalDays ? (now - last) / DAY_MS / intervalDays : 0;
      return { key, e, last, dueRatio, due: dueRatio >= 0.8 };
    })
    .sort((a, b) => Number(b.due) - Number(a.due) || (a.due && b.due ? b.dueRatio - a.dueRatio : 0) || b.e.count - a.e.count || b.last - a.last)
    .slice(0, limit)
    .map(({ key, e, due }) => ({ key, name: e.name, qty: e.qty ?? null, unit: e.unit ?? null, store: e.store ?? null, due }));
}

// One-time start: build the history from the items already ticked as bought in the person's most recent lists.
export async function backfillHistory(uid: string, lists: any[]) {
  const history: ShoppingHistory = {};
  const recent = lists.slice(0, BACKFILL_LISTS);
  for (const list of recent) {
    const at = list.completedAt || list.createdAt || new Date().toISOString();
    let snap;
    try {
      snap = await getDocs(collection(db, 'shoppingLists', list.id, 'items'));
    } catch {
      continue;
    }
    snap.docs.forEach((d) => {
      const it: any = d.data();
      if (!(it.status === 'bought' || (!it.status && it.checked)) || !it.text) return;
      const key = historyKey(it.text);
      if (!key) return;
      const prev = history[key];
      history[key] = {
        name: String(it.text).trim().slice(0, 100),
        count: (prev?.count || 0) + 1,
        firstAt: prev && prev.firstAt < at ? prev.firstAt : at,
        lastAt: prev && prev.lastAt > at ? prev.lastAt : at,
        qty: it.qty ?? prev?.qty ?? null,
        unit: it.unit ?? prev?.unit ?? null,
        store: it.store ?? prev?.store ?? null,
      };
    });
  }
  await setDoc(doc(db, 'users', uid), { shoppingHistory: history, shoppingHistoryBackfilled: true }, { merge: true });
}
