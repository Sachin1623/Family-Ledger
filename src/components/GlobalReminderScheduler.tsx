import { useEffect, useState } from 'react';
import { collection, doc, getDoc, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { SharedReminder } from '../lib/sharedReminders';
import { scheduleSharedReminders } from '../lib/sharedReminderNotifications';

// Shared Reminders only get their on-device trigger-time notification scheduled by whichever
// screen last called scheduleSharedReminders() — previously that was RemindersHub.tsx alone, so a
// recipient who was shared a reminder but never happened to open the Reminders Hub screen itself
// never got anything scheduled on their device, even if the "X shared a reminder with you" push
// reached them and they opened some *other* screen from it. Mounted once at the app root
// (alongside PointsToastBridge/LudoTurnIndicator etc. — the established pattern for "must run
// regardless of which screen is open") so scheduling happens on every app session for every
// active/shared reminder, not just when the hub itself is visited.
export default function GlobalReminderScheduler() {
  const { user } = useAuth();

  const [ownValue] = useCollection(user ? query(collection(db, 'sharedReminders'), where('createdBy', '==', user.uid)) : null);
  const [membershipsValue] = useCollection(user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null);
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupSharedValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'sharedReminders'), where('groupId', 'in', groupIds)) : null,
  );
  const [friendSharedValue] = useCollection(
    user ? query(collection(db, 'sharedReminders'), where('friendUids', 'array-contains', user.uid)) : null,
  );

  const allReminders: SharedReminder[] = (() => {
    const byId = new Map<string, SharedReminder>();
    ownValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    groupSharedValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    friendSharedValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  })();
  const remindersKey = allReminders.map((r) => r.id).sort().join(',');

  // Reminders I've explicitly declined must never get scheduled here either — mirrors
  // RemindersHub.tsx's own myResponses fetch/filter exactly, so a decline made from either place
  // sticks regardless of which screen (or app-wide mount) does the actual scheduling.
  const [declinedIds, setDeclinedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const others = allReminders.filter((r) => r.createdBy !== user.uid);
      const entries = await Promise.all(
        others.map(async (r) => {
          const snap = await getDoc(doc(db, 'sharedReminders', r.id, 'responses', user.uid));
          return snap.exists() && snap.data().status === 'declined' ? r.id : null;
        }),
      );
      if (!cancelled) setDeclinedIds(new Set(entries.filter((id): id is string => id !== null)));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remindersKey, user?.uid]);

  useEffect(() => {
    if (!user) return;
    scheduleSharedReminders(allReminders.filter((r) => r.createdBy === user.uid || !declinedIds.has(r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user,
    JSON.stringify(allReminders.map((r) => [r.id, r.active, r.cadence, r.startDate, r.time, r.weekdays])),
    JSON.stringify(Array.from(declinedIds)),
  ]);

  return null;
}
