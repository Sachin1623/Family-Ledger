import { useCallback, useMemo } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from './firebase';
import { useAuth } from '../context/AuthContext';

// A "set" is a saved list of your groups ("Everyday", "Festivals & events", "Work"), so Analysis and the home page can look at just those groups with one tap.
// They are stored on the private part of your profile (users/{uid}/private/info), not on the public user record, since other people can read that one.
export interface GroupSet {
  id: string;
  name: string;
  icon: string;
  groupIds: string[];
  openByDefault?: boolean; // Analysis opens on this set. At most one set has this.
}

export const GROUP_SET_ICONS = ['🏠', '👨‍👩‍👧', '🪔', '🎉', '✈️', '💼', '🎓', '🍽️', '🎁', '💰', '🧳', '⭐'];

export const makeSetId = () => `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normalize(raw: unknown): GroupSet[] {
  if (!Array.isArray(raw)) return [];
  const sets: GroupSet[] = [];
  for (const s of raw as any[]) {
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') continue;
    sets.push({
      id: s.id,
      name: s.name.slice(0, 40),
      icon: typeof s.icon === 'string' && s.icon ? s.icon : '📁',
      groupIds: Array.isArray(s.groupIds) ? s.groupIds.filter((g: unknown) => typeof g === 'string') : [],
      ...(s.openByDefault ? { openByDefault: true } : {}),
    });
  }
  return sets;
}

export function useGroupSets() {
  const { user } = useAuth();
  const [snap, loading] = useDocument(user ? doc(db, 'users', user.uid, 'private', 'info') : null);
  const sets = useMemo(() => normalize(snap?.data()?.groupSets), [snap]);

  const saveSets = useCallback(async (next: GroupSet[]) => {
    if (!user) return;
    await setDoc(doc(db, 'users', user.uid, 'private', 'info'), { groupSets: next }, { merge: true });
  }, [user?.uid]);

  return { sets, loaded: !loading, saveSets };
}

// Add or replace one set. Only one set may open Analysis by default, so choosing it on this one clears it from the others.
export function upsertSet(sets: GroupSet[], set: GroupSet): GroupSet[] {
  const cleared = set.openByDefault ? sets.map((s) => ({ ...s, openByDefault: false })) : sets;
  return cleared.some((s) => s.id === set.id) ? cleared.map((s) => (s.id === set.id ? set : s)) : [...cleared, set];
}
