import { addDoc, collection, getDocs, writeBatch, doc } from 'firebase/firestore';
import { db, auth } from './firebase';

// An "Event" is a shopping list that comes back every year (Diwali, Holi, a birthday, a trip). Each year is its own list, so the spend and what was
// bought stay on record; the lists of one event share an `eventKey` (the name without the year), which is how they are found together again.
export const eventKeyOf = (name: string) =>
  name.toLowerCase().replace(/\b(19|20)\d{2}\b/g, '').replace(/[^a-z0-9ऀ-ॿ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';

// "Diwali 2026" -> "Diwali"
export const eventNameFromTitle = (title: string) => title.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || title.trim().slice(0, 60);

export type EventGroup = { key: string; name: string; icon?: string; category?: string; lists: any[]; latest: any; years: number };

// The lists that belong to events, gathered per event, newest list first.
export function groupEvents(lists: any[]): EventGroup[] {
  const map = new Map<string, any[]>();
  lists.filter((l) => l.isEvent && l.eventKey).forEach((l) => map.set(l.eventKey, [...(map.get(l.eventKey) || []), l]));
  return Array.from(map.entries())
    .map(([key, ls]) => {
      const sorted = ls.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      const latest = sorted[0];
      return { key, name: latest.eventName || latest.title, icon: latest.icon, category: latest.category, lists: sorted, latest, years: new Set(sorted.map((l) => l.eventYear || (l.createdAt || '').slice(0, 4))).size };
    })
    .sort((a, b) => (b.latest.createdAt || '').localeCompare(a.latest.createdAt || ''));
}

// This year's list for an event: every item of an earlier year, all unticked, ready to shop. Same group and friends as before.
export async function startEventYear(uid: string, source: any, eventName: string, items?: any[]): Promise<string> {
  const year = new Date().getFullYear();
  const itemDocs = items ?? (await getDocs(collection(db, 'shoppingLists', source.id, 'items'))).docs.map((d) => d.data());
  const sorted = [...itemDocs].filter((i) => i.text).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const title = `${eventName} ${year}`;
  const ref = await addDoc(collection(db, 'shoppingLists'), {
    userId: uid,
    title,
    description: title,
    category: source.category || 'misc',
    ...(source.icon ? { icon: source.icon } : {}),
    groupId: source.groupId || null,
    ...(Array.isArray(source.sharedWith) && source.sharedWith.length > 0 ? { sharedWith: source.sharedWith } : {}),
    scheduledAt: null,
    completed: false,
    itemCount: sorted.length,
    doneCount: 0,
    createdAt: new Date().toISOString(),
    isEvent: true,
    eventName,
    eventKey: eventKeyOf(eventName),
    eventYear: year,
  });
  for (let start = 0; start < sorted.length; start += 400) {
    const batch = writeBatch(db);
    const now = Date.now();
    sorted.slice(start, start + 400).forEach((it, i) => {
      batch.set(doc(collection(db, 'shoppingLists', ref.id, 'items')), {
        text: it.text,
        status: 'pending',
        addedBy: uid,
        createdAt: new Date(now + start + i).toISOString(),
        ...(it.notes ? { notes: it.notes } : {}),
        ...(it.qty != null ? { qty: it.qty } : {}),
        ...(it.unit ? { unit: it.unit } : {}),
        ...(it.store ? { store: it.store } : {}),
      });
    });
    await batch.commit();
  }
  return ref.id;
}

// ---- sending a copy of a list (the server builds the copy; see /api/shopping-share) ----
async function api(path: string, method: 'GET' | 'POST', body?: unknown) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('not signed in');
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || String(res.status));
  return data;
}

export type ShareSummary = { id: string; title: string; icon: string | null; category: string; eventName: string | null; fromName: string; fromMe: boolean; linkOn: boolean; itemCount: number; createdAt: string; items?: { text: string; qty?: number; unit?: string; store?: string; notes?: string }[] };

export const sendListCopy = (listId: string, opts: { toUids?: string[]; link?: boolean }): Promise<{ id: string; itemCount: number; sentTo: number }> => api('/api/shopping-share', 'POST', { listId, ...opts });
export const getShareInbox = (): Promise<{ shares: ShareSummary[] }> => api('/api/shopping-shares/inbox', 'GET');
export const getShare = (id: string): Promise<ShareSummary> => api(`/api/shopping-share/${encodeURIComponent(id)}`, 'GET');
export const saveShare = (id: string, asEvent: boolean): Promise<{ listId: string }> => api(`/api/shopping-share/${encodeURIComponent(id)}/save`, 'POST', { asEvent });
export const dismissShare = (id: string) => api(`/api/shopping-share/${encodeURIComponent(id)}/dismiss`, 'POST', {});
export const revokeShareLink = (id: string) => api(`/api/shopping-share/${encodeURIComponent(id)}/revoke`, 'POST', {});
export const shareLinkFor = (id: string) => `${window.location.origin.startsWith('http') && !/localhost|capacitor/.test(window.location.origin) ? window.location.origin : 'https://familyledger.thirteenapps.com'}/shopping-share/${id}`;
