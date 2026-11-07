// Live Firestore data that outlives the screen showing it. The plain hooks (react-firebase-hooks) start empty and open new listeners
// every time a screen mounts, so coming back to Home showed "Loading…" cards. Here the last result of each listener is kept in
// memory and shown at once, and the listener keeps running for a short while after the screen is left, so a quick trip to another
// screen and back reloads nothing. Only data that actually changes re-renders.
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, doc, onSnapshot, query, queryEqual, where, DocumentReference, DocumentSnapshot, Query, QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';

type State = { value: any; loading: boolean; error: Error | undefined };
interface Entry {
  state: State;
  listeners: Set<() => void>;
  subs: number;
  unsub?: () => void;
  closeTimer?: ReturnType<typeof setTimeout>;
  dropTimer?: ReturnType<typeof setTimeout>;
}

// how long a listener stays open after its screen is left, and how long the last result is remembered after that
const LINGER_MS = 60_000;
const KEEP_MS = 10 * 60_000;

const entries = new Map<string, Entry>();
// the query each automatic key (q1, q2…) stands for, so an equal query built on a later render finds the same entry
const sources = new Map<string, Query>();
let sourceSeq = 0;
const NONE: State = { value: undefined, loading: false, error: undefined };

function entryFor(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { state: { value: undefined, loading: true, error: undefined }, listeners: new Set(), subs: 0 };
    entries.set(key, e);
  }
  return e;
}

function acquire(key: string, e: Entry, attach: () => () => void) {
  clearTimeout(e.closeTimer);
  clearTimeout(e.dropTimer);
  e.subs += 1;
  if (!e.unsub) e.unsub = attach();
  return () => {
    e.subs -= 1;
    if (e.subs > 0) return;
    e.closeTimer = setTimeout(() => {
      e.unsub?.();
      e.unsub = undefined;
      e.dropTimer = setTimeout(() => { if (entries.get(key) === e && e.subs === 0) { entries.delete(key); sources.delete(key); } }, KEEP_MS);
    }, LINGER_MS);
  };
}

function listen(e: Entry, source: any) {
  const set = (state: State) => { e.state = state; e.listeners.forEach((l) => l()); };
  return onSnapshot(
    source,
    (snap: any) => set({ value: snap, loading: false, error: undefined }),
    (error: Error) => set({ value: e.state.value, loading: false, error }),
  );
}

function useLive(key: string | null, build: () => any): State {
  const subscribe = useCallback((onChange: () => void) => {
    if (!key) return () => {};
    const e = entryFor(key);
    e.listeners.add(onChange);
    const release = acquire(key, e, () => listen(e, build()));
    return () => { e.listeners.delete(onChange); release(); };
    // build is a closure over the same inputs the key names, so only the key decides when to re-subscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const getSnapshot = useCallback(() => (key ? entryFor(key).state : NONE), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Same result shape as react-firebase-hooks: [value, loading, error]. `key` must name the query completely (collection, field, value).
export function useLiveCollection(key: string | null, build: () => Query): [QuerySnapshot | undefined, boolean, Error | undefined] {
  const s = useLive(key, build);
  return [s.value, s.loading, s.error];
}

export function useLiveDocument(path: string | null): [DocumentSnapshot | undefined, boolean, Error | undefined] {
  const s = useLive(path ? `doc:${path}` : null, () => doc(db, path as string));
  return [s.value, s.loading, s.error];
}

// One listener per group for the whole app. Home, Settlements, Analysis, Goals and Chat all need the same group's expenses, payments or members;
// asking for them through one query per group (instead of each screen running its own "all my groups" query) means each document is read once,
// and every screen shares it. `collectionName` is the collection holding a `groupId` field.
export type GroupDocs = { docs: QueryDocumentSnapshot[] };
export function useLiveGroupDocs(collectionName: string, groupIds: string[]): [GroupDocs | undefined, boolean, Error | undefined] {
  const ids = Array.from(new Set(groupIds)).sort();
  const keys = ids.map((id) => `${collectionName}:group:${id}`);
  const joined = keys.join('|');
  const subscribe = useCallback((onChange: () => void) => {
    const releases = ids.map((id, i) => {
      const e = entryFor(keys[i]);
      e.listeners.add(onChange);
      const release = acquire(keys[i], e, () => listen(e, query(collection(db, collectionName), where('groupId', '==', id))));
      return () => { e.listeners.delete(onChange); release(); };
    });
    return () => releases.forEach((r) => r());
    // the ids are exactly what `joined` names
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  // the combined result is rebuilt only when one of the per-group results actually changed, so it is stable between renders
  const last = useRef<{ joined: string; states: State[]; result: [GroupDocs | undefined, boolean, Error | undefined] } | null>(null);
  const getSnapshot = useCallback(() => {
    const states = keys.map((k) => entryFor(k).state);
    const prev = last.current;
    if (prev && prev.joined === joined && prev.states.length === states.length && prev.states.every((st, i) => st === states[i])) return prev.result;
    // a group that cannot be read (removed, no access) counts as empty instead of holding every screen back
    const pending = states.some((st) => st.value === undefined && st.loading);
    const error = states.find((st) => st.error && st.value === undefined)?.error;
    const result: [GroupDocs | undefined, boolean, Error | undefined] = ids.length === 0
      ? [undefined, false, undefined]
      : pending ? [undefined, true, undefined]
      : [{ docs: states.flatMap((st) => (st.value ? (st.value as QuerySnapshot).docs : [])) }, false, error];
    last.current = { joined, states, result };
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function keyForQuery(q: Query): string {
  for (const [k, src] of sources) if (queryEqual(src, q)) return k;
  const k = `q${++sourceSeq}`;
  sources.set(k, q);
  return k;
}

// Drop-in for react-firebase-hooks' useCollection: pass the query itself (or null). Equal queries share one listener and one remembered result.
export function useLiveQuery(q: Query | null): [QuerySnapshot | undefined, boolean, Error | undefined] {
  const key = q ? keyForQuery(q) : null;
  const s = useLive(key, () => q as Query);
  return [s.value, s.loading, s.error];
}

// Drop-in for useDocument: pass the document reference (or null).
export function useLiveRef(ref: DocumentReference | null): [DocumentSnapshot | undefined, boolean, Error | undefined] {
  const s = useLive(ref ? `doc:${ref.path}` : null, () => ref as DocumentReference);
  return [s.value, s.loading, s.error];
}

// useState whose last value survives leaving the screen: for lists a screen builds after loading (for example decrypted goals), so they are there at once on return.
const remembered = new Map<string, unknown>();
export function useRememberedState<T>(key: string | null, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => (key && remembered.has(key) ? (remembered.get(key) as T) : initial));
  const set = useCallback((v: T) => { if (key) remembered.set(key, v); setValue(v); }, [key]);
  return [value, set];
}

// Nothing may carry over from one account to the next on a shared phone.
let lastUid: string | null | undefined;
onAuthStateChanged(auth, (u) => {
  const uid = u?.uid ?? null;
  if (lastUid !== undefined && uid !== lastUid) {
    entries.forEach((e) => { clearTimeout(e.closeTimer); clearTimeout(e.dropTimer); e.unsub?.(); e.unsub = undefined; });
    entries.clear();
    sources.clear();
    remembered.clear();
  }
  lastUid = uid;
});
