import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, documentId, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { db } from './firebase';

// One place that says who a person is. A person's name and picture live on their profile (users/{uid}), and that is
// the only truth: names saved on activities, comments and member rows are copies taken at some past moment, and they
// drift (the Google sign-in name versus the name set on the Profile page). Screens that show another person should ask
// here, and fall back to the saved copy only until the profile has loaded.

export type Identity = { name: string; photo: string };

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, Identity & { at: number }>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// what a person's profile says, without a fallback: '' when it is not loaded yet or has no name
export function cachedIdentity(uid: string | undefined | null): Identity | null {
  if (!uid) return null;
  const hit = cache.get(uid);
  return hit && (hit.name || hit.photo) ? { name: hit.name, photo: hit.photo } : null;
}

// call after the signed-in user changes their own name or picture, so every screen picks it up at once
export function setOwnIdentity(uid: string, name: string, photo: string) {
  cache.set(uid, { name, photo, at: Date.now() });
  notify();
}

async function load(uids: string[]) {
  const now = Date.now();
  const want = uids.filter((u) => u && !inflight.has(u) && !((cache.get(u)?.at || 0) > now - TTL_MS));
  if (want.length === 0) return;
  want.forEach((u) => inflight.add(u));
  try {
    for (let i = 0; i < want.length; i += 30) {
      const chunk = want.slice(i, i + 30);
      const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)));
      const found = new Set<string>();
      snap.forEach((d) => {
        const data: any = d.data();
        found.add(d.id);
        cache.set(d.id, { name: data.displayName || '', photo: data.photoURL || '', at: Date.now() });
      });
      // a profile that does not exist (or cannot be read) is remembered as empty so it is not asked for again every render
      chunk.forEach((u) => { if (!found.has(u)) cache.set(u, { name: '', photo: '', at: Date.now() }); });
    }
  } catch (err) {
    console.error('Could not load profiles:', err);
  } finally {
    want.forEach((u) => inflight.delete(u));
    notify();
  }
}

// Returns a resolver: resolve(uid, savedName, savedPhoto) gives the profile's name and picture, or the saved copies when the
// profile has none. The resolver changes when new profiles arrive, so memos that use it recompute.
export function useIdentities(uids: Array<string | undefined | null>) {
  const [version, setVersion] = useState(0);
  const key = Array.from(new Set(uids.filter(Boolean) as string[])).sort().join(',');
  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (key) load(key.split(','));
  }, [key]);
  return useCallback(
    (uid: string | undefined | null, savedName?: string, savedPhoto?: string): Identity => {
      const hit = uid ? cache.get(uid) : undefined;
      return { name: hit?.name || savedName || '', photo: hit?.photo || savedPhoto || '' };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
}

// Same, for one person
export function useIdentity(uid: string | undefined | null, savedName?: string, savedPhoto?: string): Identity {
  const resolve = useIdentities([uid]);
  return useMemo(() => resolve(uid, savedName, savedPhoto), [resolve, uid, savedName, savedPhoto]);
}

// The name to put on something the signed-in user does, for code that only has the sign-in user: the profile's name first
export function ownDisplayName(user: { uid: string; displayName?: string | null } | null | undefined, fallback = 'Someone'): string {
  return (user && cachedIdentity(user.uid)?.name) || user?.displayName || fallback;
}
export function ownPhoto(user: { uid: string; photoURL?: string | null } | null | undefined): string {
  return (user && cachedIdentity(user.uid)?.photo) || user?.photoURL || '';
}

// Group-member rows keep a copy of name and picture, taken when the person joined or last edited their profile; if the
// profile was changed any other way the copies drift, and every screen that reads a member row shows the old one. Run once per change.
export async function syncMemberIdentity(uid: string, name: string, photo: string) {
  if (!uid || !name) return;
  const sig = `${name}|${photo.length}|${photo.slice(-24)}`;
  const storeKey = `fl_member_identity_${uid}`;
  try {
    if (localStorage.getItem(storeKey) === sig) return;
  } catch { /* storage blocked: just check every time */ }
  try {
    const snap = await getDocs(query(collection(db, 'members'), where('userId', '==', uid)));
    const stale = snap.docs.filter((d) => {
      const m: any = d.data();
      return m.displayName !== name || (photo && m.photoURL !== photo);
    });
    for (let i = 0; i < stale.length; i += 400) {
      const batch = writeBatch(db);
      stale.slice(i, i + 400).forEach((d) => batch.update(d.ref, { displayName: name, ...(photo ? { photoURL: photo } : {}) }));
      await batch.commit();
    }
    try { localStorage.setItem(storeKey, sig); } catch { /* ignore */ }
  } catch (err) {
    console.error('Could not bring member rows in line with the profile:', err);
  }
}
