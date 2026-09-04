import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { collection, query, where, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { scheduleSharedReminders } from '../lib/sharedReminderNotifications';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { WEEKDAY_LABELS } from '../lib/frequency';
import { auth } from '../lib/firebase';
import { todayLocalDateString } from '../lib/dateUtils';
import {
  SharedReminder,
  ReminderCadence,
  ReminderCompletionMode,
  ReminderResponseStatus,
  hasReminderTarget,
  reminderRecipientUids,
  nextOccurrence,
  describeCadence,
  ackId,
  isOccurrenceComplete,
} from '../lib/sharedReminders';

interface ResolvedPerson { userId: string; displayName: string; photoURL: string }

export default function RemindersHub() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayLocalDateString();

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];
  const [allMembersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const allMembers = allMembersValue?.docs.map((d) => d.data() as any) || [];

  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(user?.uid);
  const { families: myFamilies, membersByFamilyId } = useFamilies(user?.uid);

  const resolvePerson = (uid: string): ResolvedPerson => {
    if (uid === user?.uid) return { userId: uid, displayName: profile?.displayName || user?.displayName || t('health.myself'), photoURL: profile?.photoURL || user?.photoURL || '' };
    const member = allMembers.find((m: any) => m.userId === uid);
    if (member) return { userId: uid, displayName: member.displayName, photoURL: member.photoURL };
    const friend = friendUsersByUid.get(uid);
    return { userId: uid, displayName: friend?.displayName || t('common.someone'), photoURL: friend?.photoURL || '' };
  };

  // Three separate queries — each maps onto exactly one OR-branch in the Firestore rule, the
  // same provably-safe list-query pattern already used for group/friend sharing elsewhere.
  const [ownValue] = useCollection(user ? query(collection(db, 'sharedReminders'), where('createdBy', '==', user.uid)) : null);
  const [groupSharedValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'sharedReminders'), where('groupId', 'in', groupIds)) : null,
  );
  const [friendSharedValue] = useCollection(
    user ? query(collection(db, 'sharedReminders'), where('friendUids', 'array-contains', user.uid)) : null,
  );
  const allReminders: SharedReminder[] = useMemo(() => {
    const byId = new Map<string, SharedReminder>();
    ownValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    groupSharedValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    friendSharedValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  }, [ownValue, groupSharedValue, friendSharedValue]);

  // My own accept/decline response to each reminder someone else shared with me — a reminder I
  // created has no response of my own (I authored it, nothing to accept). Fetched as one doc read
  // per reminder (small, same reasoning as the ack fetch below) rather than a collectionGroup
  // query, since a collectionGroup `list` here couldn't be proven safe against the rules the same
  // way the three top-level queries above are — this stays scoped one reminder at a time instead.
  const [myResponses, setMyResponses] = useState<Map<string, ReminderResponseStatus>>(new Map());
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const others = allReminders.filter((r) => r.createdBy !== user.uid);
      const entries = await Promise.all(
        others.map(async (r) => {
          const snap = await getDoc(doc(db, 'sharedReminders', r.id, 'responses', user.uid));
          return [r.id, snap.exists() ? (snap.data().status as ReminderResponseStatus) : undefined] as const;
        }),
      );
      if (!cancelled) {
        setMyResponses(new Map(entries.filter((e): e is [string, ReminderResponseStatus] => e[1] !== undefined)));
      }
    })();
    return () => { cancelled = true; };
  }, [allReminders.map((r) => r.id).join(','), user?.uid]);

  // Fire-and-forget: tells the server to push + feed-log this action to every OTHER recipient of
  // the reminder (server re-reads the reminder doc itself for the actual recipient set — the
  // client never has to enumerate/trust it). Never blocks or fails the action it's attached to.
  const notifyReminderAction = (reminderId: string, action: string, actorName: string) => {
    auth.currentUser
      ?.getIdToken()
      .then((idToken) =>
        fetch('/api/reminders/notify-action', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reminderId, action, actorName }),
        }),
      )
      .catch((err) => console.error('notify-reminder-action failed:', err));
  };

  const handleRespond = async (r: SharedReminder, status: ReminderResponseStatus) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'sharedReminders', r.id, 'responses', user.uid), {
        uid: user.uid,
        status,
        respondedAt: new Date().toISOString(),
      });
      setMyResponses((prev) => new Map(prev).set(r.id, status));
      notifyReminderAction(r.id, status, profile?.displayName || user.displayName || 'Someone');
    } catch (err) {
      console.error('Failed to respond to reminder:', err);
    }
  };

  // Reschedule local notifications whenever the relevant reminder set (or my own responses)
  // changes — a reminder I've explicitly declined is excluded here so its due-time notification
  // never fires for me, even though it stays visible (with a Declined label) in my own list below.
  // Reminders I created myself are never affected by my own response state.
  useEffect(() => {
    const schedulable = allReminders.filter((r) => r.createdBy === user?.uid || myResponses.get(r.id) !== 'declined');
    scheduleSharedReminders(schedulable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(allReminders.map((r) => [r.id, r.active, r.cadence, r.startDate, r.time, r.weekdays])),
    JSON.stringify(Array.from(myResponses.entries())),
  ]);

  const [filter, setFilter] = useState<'all' | 'mine' | 'shared'>('all');
  const visibleReminders = useMemo(() => {
    return allReminders
      .filter((r) => (filter === 'mine' ? r.createdBy === user?.uid : filter === 'shared' ? r.createdBy !== user?.uid : true))
      .sort((a, b) => {
        const nextA = nextOccurrence(a, today) || '9999-99-99';
        const nextB = nextOccurrence(b, today) || '9999-99-99';
        return nextA === nextB ? a.time.localeCompare(b.time) : nextA.localeCompare(nextB);
      });
  }, [allReminders, filter, user, today]);

  // Top-of-screen slider: next 5 upcoming occurrences across ALL reminders, independent of the
  // All/Mine/Shared tab below — same sort key as visibleReminders, just unfiltered + capped.
  const upcomingReminders = useMemo(() => {
    return allReminders
      .filter((r) => r.active && nextOccurrence(r, today))
      .sort((a, b) => {
        const nextA = nextOccurrence(a, today) || '9999-99-99';
        const nextB = nextOccurrence(b, today) || '9999-99-99';
        return nextA === nextB ? a.time.localeCompare(b.time) : nextA.localeCompare(nextB);
      })
      .slice(0, 5);
  }, [allReminders, today]);

  // Every ack for every visible reminder, fetched once per reminder set — small subcollections,
  // fine to pull in full rather than a per-occurrence query.
  const [acksByReminder, setAcksByReminder] = useState<Map<string, { uid: string; occurrenceDate: string }[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        allReminders.map(async (r) => {
          const snap = await getDocs(collection(db, 'sharedReminders', r.id, 'acknowledgments'));
          return [r.id, snap.docs.map((d) => d.data() as any)] as const;
        }),
      );
      if (!cancelled) setAcksByReminder(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [allReminders.map((r) => r.id).join(',')]);

  // Every recipient's accept/decline response per reminder, for the creator's own checklist below
  // — a different shape from myResponses above (that one's "my status on someone else's
  // reminder"; this one's "everyone's status on a reminder I created"), same per-reminder-getDocs
  // approach as acksByReminder just above it.
  const [responsesByReminder, setResponsesByReminder] = useState<Map<string, { uid: string; status: ReminderResponseStatus }[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        allReminders.map(async (r) => {
          const snap = await getDocs(collection(db, 'sharedReminders', r.id, 'responses'));
          return [r.id, snap.docs.map((d) => d.data() as any)] as const;
        }),
      );
      if (!cancelled) setResponsesByReminder(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [allReminders.map((r) => r.id).join(',')]);

  const recipientsFor = (reminder: SharedReminder): ResolvedPerson[] => {
    const groupMemberUids = reminder.groupId ? allMembers.filter((m: any) => m.groupId === reminder.groupId).map((m: any) => m.userId) : [];
    return reminderRecipientUids(reminder, groupMemberUids).map(resolvePerson);
  };

  // --- Create / Edit form ---
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SharedReminder | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [time, setTime] = useState('09:00');
  const [cadence, setCadence] = useState<ReminderCadence>('once');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [requireAck, setRequireAck] = useState(true);
  const [completionMode, setCompletionMode] = useState<ReminderCompletionMode>('all');
  const [shareGroupId, setShareGroupId] = useState<string | null>(null);
  const [shareFriendUids, setShareFriendUids] = useState<string[]>([]);
  const [friendSearch, setFriendSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setTitle('');
    setNotes('');
    setStartDate(today);
    setTime('09:00');
    setCadence('once');
    setWeekdays([]);
    setRequireAck(true);
    setCompletionMode('all');
    setShareGroupId(null);
    setShareFriendUids([]);
    setFriendSearch('');
    setShowForm(true);
  };
  const openEdit = (r: SharedReminder) => {
    setEditing(r);
    setTitle(r.title);
    setNotes(r.notes || '');
    setStartDate(r.startDate);
    setTime(r.time);
    setCadence(r.cadence);
    setWeekdays(r.weekdays);
    setRequireAck(r.requireAck);
    setCompletionMode(r.completionMode || 'all');
    setShareGroupId(r.groupId);
    setShareFriendUids(r.friendUids);
    setFriendSearch('');
    setShowForm(true);
  };

  const isFamilyFullySelected = (familyId: string) => {
    const members = membersByFamilyId.get(familyId) || [];
    return members.length > 0 && members.every((m) => shareFriendUids.includes(m.userId));
  };
  const toggleFamily = (familyId: string) => {
    const memberUids = (membersByFamilyId.get(familyId) || []).map((m) => m.userId);
    const allSelected = isFamilyFullySelected(familyId);
    setShareFriendUids((prev) => (allSelected ? prev.filter((u) => !memberUids.includes(u)) : Array.from(new Set([...prev, ...memberUids]))));
  };
  const toggleFriend = (uid: string) => {
    setShareFriendUids((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : [...prev, uid]));
  };
  const filteredFriends = acceptedFriends.filter(({ friendUid }) => {
    if (!friendSearch.trim()) return true;
    const name = friendUsersByUid.get(friendUid)?.displayName || '';
    return name.toLowerCase().includes(friendSearch.trim().toLowerCase());
  });

  const handleSave = async () => {
    if (!user || !title.trim() || saving) return;
    // A one-time reminder whose date+time has already passed would otherwise save silently and
    // just never notify anyone — scheduleSharedReminders' 'once' branch deliberately skips
    // scheduling anything already in the past, so this has to be caught here instead, before
    // that silent no-op, not after it.
    if (cadence === 'once') {
      const [y, m, d] = startDate.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      if (new Date(y, m - 1, d, hh, mm).getTime() <= Date.now()) {
        alert(t('reminders.pastTime'));
        return;
      }
    }
    setSaving(true);
    try {
      const actorName = profile?.displayName || user.displayName || 'Someone';
      const fields = {
        title: title.trim(),
        notes: notes.trim() || null,
        startDate,
        time,
        cadence,
        weekdays,
        requireAck,
        completionMode,
        groupId: shareGroupId,
        friendUids: shareFriendUids,
      };
      if (editing) {
        await updateDoc(doc(db, 'sharedReminders', editing.id), fields);
      } else {
        const ref = doc(collection(db, 'sharedReminders'));
        await setDoc(ref, {
          ...fields,
          createdBy: user.uid,
          createdByName: actorName,
          active: true,
          createdAt: new Date().toISOString(),
        });
        if (shareGroupId) {
          notifyGroupActivity({ groupId: shareGroupId, action: 'reminder_set', contextLabel: title.trim(), actorName, reminderId: ref.id, reminderTime: time });
        }
        if (shareFriendUids.length > 0) {
          auth.currentUser
            ?.getIdToken()
            .then((idToken) =>
              fetch('/api/health/notify-glucose-shared', {
                method: 'POST',
                headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ friendUids: shareFriendUids, kind: 'reminder', readingLabel: title.trim(), actorName, reminderId: ref.id, time }),
              }),
            )
            .catch((err) => console.error('notify-reminder-shared failed:', err));
        }
      }
      setShowForm(false);
      setEditing(null);
    } catch (err) {
      console.error('Failed to save reminder:', err);
      alert(t('reminders.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (r: SharedReminder) => {
    if (!window.confirm(t('reminders.confirmDelete'))) return;
    try {
      await deleteDoc(doc(db, 'sharedReminders', r.id));
      setDetailReminder(null);
    } catch (err) {
      console.error('Failed to delete reminder:', err);
    }
  };
  const handleTogglePause = async (r: SharedReminder) => {
    try {
      await updateDoc(doc(db, 'sharedReminders', r.id), { active: !r.active });
    } catch (err) {
      console.error('Failed to toggle reminder:', err);
    }
  };

  // --- Mark Done (any recipient) ---
  const handleMarkDone = async (r: SharedReminder) => {
    if (!user) return;
    const occ = nextOccurrence(r, today) || today;
    try {
      // Computed BEFORE the write, from the ack/response state already in memory, so the
      // before/after comparison reflects exactly what this tap is about to change — whether it's
      // just partial progress ('all' mode, not the last person) or what actually finishes the
      // occurrence for everyone ('any' mode's first completer, or 'all' mode's last one).
      const declinedUids = new Set<string>((responsesByReminder.get(r.id) || []).filter((x) => x.status === 'declined').map((x) => x.uid));
      const activeRecipientUids = recipientsFor(r).map((p) => p.userId).filter((uid) => !declinedUids.has(uid));
      const priorDoneUids = new Set<string>((acksByReminder.get(r.id) || []).filter((a) => a.occurrenceDate === occ).map((a) => a.uid));
      const mode = r.completionMode || 'all';
      const wasComplete = isOccurrenceComplete(mode, activeRecipientUids, priorDoneUids);

      await setDoc(doc(db, 'sharedReminders', r.id, 'acknowledgments', ackId(user.uid, occ)), {
        uid: user.uid,
        occurrenceDate: occ,
        acknowledgedAt: new Date().toISOString(),
      });
      setAcksByReminder((prev) => {
        const next = new Map<string, { uid: string; occurrenceDate: string }[]>(prev);
        const existing: { uid: string; occurrenceDate: string }[] = next.get(r.id) || [];
        next.set(r.id, [...existing, { uid: user.uid, occurrenceDate: occ }]);
        return next;
      });

      const isComplete = isOccurrenceComplete(mode, activeRecipientUids, new Set([...priorDoneUids, user.uid]));
      notifyReminderAction(r.id, !wasComplete && isComplete ? 'task_completed' : 'marked_done', profile?.displayName || user.displayName || 'Someone');
    } catch (err) {
      console.error('Failed to acknowledge reminder:', err);
    }
  };

  // Lets a recipient walk back an accidental "Mark Done" tap — the Firestore rule already scopes
  // delete to the ack's own author, so this is just removing today's ack doc.
  const handleUndoDone = async (r: SharedReminder) => {
    if (!user) return;
    const occ = nextOccurrence(r, today) || today;
    try {
      await deleteDoc(doc(db, 'sharedReminders', r.id, 'acknowledgments', ackId(user.uid, occ)));
      setAcksByReminder((prev) => {
        const next = new Map<string, { uid: string; occurrenceDate: string }[]>(prev);
        next.set(r.id, (next.get(r.id) || []).filter((a) => !(a.uid === user.uid && a.occurrenceDate === occ)));
        return next;
      });
    } catch (err) {
      console.error('Failed to undo acknowledgment:', err);
    }
  };

  // A one-off re-notification 10 minutes out, independent of the reminder's own tracked
  // schedule — doesn't touch the reminder doc or its regular recurring notification at all, so
  // snoozing today never affects tomorrow's (or anyone else's) occurrence.
  const handleSnooze = async (r: SharedReminder) => {
    closeOpenCard();
    if (!Capacitor.isNativePlatform()) return;
    try {
      const id = Math.floor(Math.random() * 2147483647);
      await LocalNotifications.schedule({
        notifications: [{
          id,
          title: 'Reminder',
          body: r.title,
          schedule: { at: new Date(Date.now() + 10 * 60 * 1000), allowWhileIdle: true },
          extra: { type: 'shared_reminder', reminderId: r.id },
        }],
      });
    } catch (err) {
      console.error('Failed to snooze reminder:', err);
    }
  };

  // --- Detail view (creator's status checklist) ---
  const [detailReminder, setDetailReminder] = useState<SharedReminder | null>(null);

  // --- Notification-tap deep link: ?open=<id> opens the recipient card directly. ---
  const openParam = searchParams.get('open');
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  useEffect(() => {
    if (openParam) setOpenCardId(openParam);
  }, [openParam]);
  const openCardReminder = allReminders.find((r) => r.id === openCardId) || null;
  const closeOpenCard = () => {
    setOpenCardId(null);
    if (searchParams.get('open')) {
      const next = new URLSearchParams(searchParams);
      next.delete('open');
      setSearchParams(next, { replace: true });
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-24">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-primary leading-tight">{t('reminders.hubTitle')}</h1>
            <p className="text-[11px] text-text-muted leading-tight">{t('reminders.hubSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="shrink-0 w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center shadow-md active:scale-95 transition-all"
            aria-label={t('reminders.newReminder')}
          >
            <span className="material-symbols-outlined text-[22px]">add</span>
          </button>
        </div>

        {upcomingReminders.length > 0 && (
          <div className="-mx-4 px-4 overflow-x-auto">
            <div className="flex gap-2.5 pb-1" style={{ scrollSnapType: 'x mandatory' }}>
              {upcomingReminders.map((r) => {
                const occ = nextOccurrence(r, today);
                const isCreator = r.createdBy === user?.uid;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => (isCreator ? setDetailReminder(r) : setOpenCardId(r.id))}
                    style={{ scrollSnapAlign: 'start' }}
                    className="shrink-0 w-40 text-left bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-1"
                  >
                    <p className="text-[10px] font-bold text-primary uppercase tracking-wide">
                      {occ === today ? t('reminders.today') : occ}
                    </p>
                    <p className="text-xs font-bold text-on-surface truncate">{r.title}</p>
                    <p className="text-[10px] text-text-muted">{r.time}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
          {(['all', 'mine', 'shared'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', filter === f ? 'bg-primary text-white' : 'text-text-muted')}
            >
              {t(`reminders.filter${f.charAt(0).toUpperCase()}${f.slice(1)}`)}
            </button>
          ))}
        </div>

        {visibleReminders.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-12">{t('reminders.noneYet')}</p>
        ) : (
          <div className="space-y-2">
            {visibleReminders.map((r) => {
              const recipients = recipientsFor(r);
              const occ = nextOccurrence(r, today);
              const acks = acksByReminder.get(r.id) || [];
              const declinedUids = new Set<string>((responsesByReminder.get(r.id) || []).filter((x) => x.status === 'declined').map((x) => x.uid));
              // A decline is excluded from both the denominator (an 'all' reminder shouldn't need
              // a decliner's ack to ever close) and the numerator's eligibility (an 'any' reminder
              // shouldn't count a decline as the one completion that closes it).
              const activeRecipients = recipients.filter((p) => !declinedUids.has(p.userId));
              const doneUids = new Set<string>(occ ? acks.filter((a) => a.occurrenceDate === occ).map((a) => a.uid) : []);
              const confirmedCount = activeRecipients.filter((p) => doneUids.has(p.userId)).length;
              const completionMode = r.completionMode || 'all';
              const occurrenceComplete = occ ? isOccurrenceComplete(completionMode, activeRecipients.map((p) => p.userId), doneUids) : false;
              const isCreator = r.createdBy === user?.uid;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => (isCreator ? setDetailReminder(r) : setOpenCardId(r.id))}
                  className={clsx(
                    'w-full text-left bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-2 transition-opacity',
                    !r.active && 'opacity-50',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-primary truncate">{r.title}</p>
                      <p className="text-[11px] text-text-muted">
                        {occ === today ? t('reminders.today') : occ === undefined || occ === null ? t('reminders.past') : occ}
                        {' · '}{r.time}{' · '}{describeCadence(r, t, WEEKDAY_LABELS)}
                      </p>
                    </div>
                    {isCreator && r.requireAck && occ && (
                      <span className={clsx(
                        'shrink-0 text-[10px] font-bold px-2 py-1 rounded-full',
                        occurrenceComplete ? 'text-success bg-success/10' : 'text-primary bg-primary/10',
                      )}>
                        {completionMode === 'any'
                          ? t(occurrenceComplete ? 'reminders.taskComplete' : 'reminders.awaitingAnyone')
                          : t('reminders.confirmedCount', { count: confirmedCount, total: activeRecipients.length })}
                      </span>
                    )}
                    {!isCreator && (
                      <span className={clsx(
                        'shrink-0 text-[10px] font-bold px-2 py-1 rounded-full',
                        myResponses.get(r.id) === 'accepted' ? 'text-success bg-success/10'
                          : myResponses.get(r.id) === 'declined' ? 'text-error bg-error/10'
                          : 'text-warning bg-warning/10',
                      )}>
                        {t(myResponses.get(r.id) === 'accepted' ? 'reminders.accepted' : myResponses.get(r.id) === 'declined' ? 'reminders.declined' : 'reminders.pending')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {recipients.slice(0, 5).map((p) => (
                      <img key={p.userId} src={p.photoURL || `https://ui-avatars.com/api/?name=${p.displayName}`} alt="" className="w-6 h-6 rounded-full border border-white object-cover -ml-1.5 first:ml-0" />
                    ))}
                    {recipients.length > 5 && (
                      <span className="w-6 h-6 rounded-full bg-surface-container text-[9px] font-bold text-text-muted flex items-center justify-center -ml-1.5">
                        +{recipients.length - 5}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>

      {/* Create / Edit form */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black text-primary">{editing ? t('reminders.editReminder') : t('reminders.newReminder')}</h2>
              <button type="button" onClick={() => setShowForm(false)} className="text-text-muted">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('reminders.titlePlaceholder')}
              autoFocus
              className="w-full bg-surface border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none focus:ring-2 focus:ring-primary/20"
            />
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('reminders.notesPlaceholder')}
              rows={2}
              className="w-full bg-surface border border-border-subtle rounded-xl px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />

            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
              />
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('reminders.repeat')}</label>
              <div className="flex gap-1.5">
                {(['once', 'daily', 'weekly', 'monthly'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCadence(c)}
                    className={clsx('flex-1 py-2 rounded-lg text-[10px] font-bold border transition-all', cadence === c ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                  >
                    {t(`reminders.cadence${c.charAt(0).toUpperCase()}${c.slice(1)}`)}
                  </button>
                ))}
              </div>
              {cadence === 'weekly' && (
                <div className="flex gap-1 pt-1">
                  {WEEKDAY_LABELS.map((label, idx) => {
                    const selected = weekdays.length === 0 || weekdays.includes(idx);
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() =>
                          setWeekdays((prev) => {
                            const base = prev.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : prev;
                            return base.includes(idx) ? base.filter((d) => d !== idx) : [...base, idx];
                          })
                        }
                        className={clsx('flex-1 py-1.5 rounded-lg text-[10px] font-bold border transition-all', selected ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                      >
                        {label.slice(0, 1)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-1.5 pt-1 border-t border-border-subtle">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('reminders.shareWith')}</label>
              <select
                value={shareGroupId || ''}
                onChange={(e) => setShareGroupId(e.target.value || null)}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
              >
                <option value="">{t('todo.justMe')}</option>
                {groups.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              {myFamilies.length > 0 && (
                <div className="space-y-1">
                  {myFamilies.map((fam: any) => {
                    const members = membersByFamilyId.get(fam.id) || [];
                    const selected = isFamilyFullySelected(fam.id);
                    return (
                      <button
                        key={fam.id}
                        type="button"
                        onClick={() => toggleFamily(fam.id)}
                        className={clsx('w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}
                      >
                        <span className="text-xs font-bold flex items-center gap-1.5">
                          <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                            {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                          </span>
                          {fam.name}
                        </span>
                        <span className="text-[10px] font-bold text-text-muted shrink-0">{t('health.membersCount', { count: members.length })}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {acceptedFriends.length > 0 && (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={friendSearch}
                    onChange={(e) => setFriendSearch(e.target.value)}
                    placeholder={t('health.searchFriends')}
                    className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none"
                  />
                  <div className="max-h-32 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
                    {filteredFriends.length === 0 ? (
                      <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
                    ) : (
                      filteredFriends.map(({ friendUid }) => {
                        const friend = friendUsersByUid.get(friendUid);
                        const selected = shareFriendUids.includes(friendUid);
                        return (
                          <button
                            key={friendUid}
                            type="button"
                            onClick={() => toggleFriend(friendUid)}
                            className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors"
                          >
                            <img src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                            <span className="flex-1 text-left text-xs font-bold truncate">{friend?.displayName || t('common.someone')}</span>
                            <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                              {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            {hasReminderTarget(shareGroupId, shareFriendUids) && (
              <div className="flex items-center justify-between pt-1 border-t border-border-subtle">
                <div>
                  <p className="text-[11px] font-bold text-primary">{t('reminders.requireAck')}</p>
                  <p className="text-[10px] text-text-muted">{t('reminders.requireAckDesc')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setRequireAck((v) => !v)}
                  className={clsx('w-10 h-6 rounded-full transition-colors relative shrink-0', requireAck ? 'bg-primary' : 'bg-surface-container')}
                >
                  <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', requireAck ? 'left-[18px]' : 'left-0.5')} />
                </button>
              </div>
            )}

            {hasReminderTarget(shareGroupId, shareFriendUids) && requireAck && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-bold text-primary">{t('reminders.whoMustAct')}</p>
                <div className="flex bg-surface-container rounded-xl p-1 gap-1">
                  {(['all', 'any'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setCompletionMode(mode)}
                      className={clsx('flex-1 py-2 rounded-lg text-[11px] font-bold transition-all', completionMode === mode ? 'bg-primary text-white' : 'text-text-muted')}
                    >
                      {t(mode === 'all' ? 'reminders.everyoneActs' : 'reminders.anyoneActs')}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-text-muted px-1">
                  {t(completionMode === 'all' ? 'reminders.everyoneActsDesc' : 'reminders.anyoneActsDesc')}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !title.trim()}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {/* Creator's status checklist */}
      {detailReminder && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDetailReminder(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => { openEdit(detailReminder); setDetailReminder(null); }} className="p-1.5 text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">edit</span>
                </button>
                <button type="button" onClick={() => handleDelete(detailReminder)} className="p-1.5 text-error">
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
              <button type="button" onClick={() => setDetailReminder(null)} className="text-text-muted">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <div>
              <h2 className="text-lg font-black text-primary">{detailReminder.title}</h2>
              <p className="text-[11px] text-text-muted">{describeCadence(detailReminder, t, WEEKDAY_LABELS)} · {detailReminder.time}</p>
              {detailReminder.notes && <p className="text-xs text-on-surface mt-1">{detailReminder.notes}</p>}
            </div>
            {/* The creator is also always an implicit recipient of their own reminder (see
                reminderRecipientUids) — this used to only be actionable from the OTHER side of a
                notification tap; the creator's own detail view had no way to mark it done at all. */}
            {detailReminder.requireAck && (() => {
              const occ = nextOccurrence(detailReminder, today);
              if (!occ) return null;
              const acksForOcc = (acksByReminder.get(detailReminder.id) || []).filter((a) => a.occurrenceDate === occ);
              const myAck = user ? acksForOcc.find((a) => a.uid === user.uid) : undefined;
              const mode = detailReminder.completionMode || 'all';
              const completedByOther = mode === 'any' && !myAck ? acksForOcc[0] : undefined;
              if (myAck) {
                return (
                  <div className="space-y-1.5">
                    <p className="text-sm font-bold text-success flex items-center justify-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px]">check_circle</span>{t('reminders.markedDone')}
                    </p>
                    <button type="button" onClick={() => { handleUndoDone(detailReminder); }} className="w-full py-1.5 text-xs font-bold text-text-muted underline">
                      {t('reminders.undo')}
                    </button>
                  </div>
                );
              }
              if (completedByOther) {
                return (
                  <p className="text-sm font-bold text-success flex items-center justify-center gap-1.5">
                    <span className="material-symbols-outlined text-[18px]">check_circle</span>
                    {t('reminders.completedByOther', { name: resolvePerson(completedByOther.uid).displayName })}
                  </p>
                );
              }
              return (
                <button
                  type="button"
                  onClick={() => { handleMarkDone(detailReminder); }}
                  className="w-full py-2.5 bg-primary text-white font-bold rounded-xl text-sm"
                >
                  {t('reminders.markDone')}
                </button>
              );
            })()}

            <button
              type="button"
              onClick={() => handleTogglePause(detailReminder)}
              className="w-full py-2 rounded-xl text-xs font-bold border border-border-subtle text-text-muted"
            >
              {detailReminder.active ? t('reminders.pause') : t('reminders.resume')}
            </button>

            {recipientsFor(detailReminder).length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-border-subtle">
                <div className="flex items-center justify-between px-1">
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('reminders.recipientStatuses')}</label>
                  {detailReminder.requireAck && (() => {
                    const occ = nextOccurrence(detailReminder, today);
                    if (!occ) return null;
                    const responses = responsesByReminder.get(detailReminder.id) || [];
                    const declinedUids = new Set<string>(responses.filter((x) => x.status === 'declined').map((x) => x.uid));
                    const activeUids = recipientsFor(detailReminder).map((p) => p.userId).filter((uid) => !declinedUids.has(uid));
                    const doneUids = new Set<string>((acksByReminder.get(detailReminder.id) || []).filter((a) => a.occurrenceDate === occ).map((a) => a.uid));
                    const complete = isOccurrenceComplete(detailReminder.completionMode || 'all', activeUids, doneUids);
                    return (
                      <span className={clsx('text-[9px] font-bold px-1.5 py-0.5 rounded-full', complete ? 'text-success bg-success/10' : 'text-warning bg-warning/10')}>
                        {t(complete ? 'reminders.taskComplete' : 'reminders.taskPending')}
                      </span>
                    );
                  })()}
                </div>
                {(() => {
                  const occ = nextOccurrence(detailReminder, today);
                  const acks = acksByReminder.get(detailReminder.id) || [];
                  const responses = responsesByReminder.get(detailReminder.id) || [];
                  return recipientsFor(detailReminder).map((p) => {
                    const done = occ && detailReminder.requireAck ? acks.some((a) => a.uid === p.userId && a.occurrenceDate === occ) : false;
                    const status = responses.find((r) => r.uid === p.userId)?.status;
                    return (
                      <div key={p.userId} className="flex items-center gap-2 py-1.5">
                        <img src={p.photoURL || `https://ui-avatars.com/api/?name=${p.displayName}`} className="w-7 h-7 rounded-full object-cover" alt="" />
                        <span className="flex-1 text-xs font-bold text-on-surface truncate">{p.displayName}</span>
                        {status && (
                          <span className={clsx(
                            'text-[9px] font-bold px-1.5 py-0.5 rounded-full',
                            status === 'accepted' ? 'text-success bg-success/10' : 'text-error bg-error/10',
                          )}>
                            {t(status === 'accepted' ? 'reminders.accepted' : 'reminders.declined')}
                          </span>
                        )}
                        {detailReminder.requireAck && (
                          <span className={clsx('material-symbols-outlined text-[18px]', done ? 'text-success' : 'text-text-muted')}>
                            {done ? 'check_circle' : 'schedule'}
                          </span>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recipient's card — what opening a notification (or tapping a shared reminder) shows */}
      {openCardReminder && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeOpenCard}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-6 space-y-4 text-center" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-outlined text-[40px] text-primary">notifications_active</span>
            <div>
              <h2 className="text-lg font-black text-primary">{openCardReminder.title}</h2>
              <p className="text-[11px] text-text-muted mt-1">
                {t('reminders.sentBy', { name: openCardReminder.createdByName })} · {openCardReminder.time}
              </p>
              {openCardReminder.notes && <p className="text-xs text-on-surface mt-2">{openCardReminder.notes}</p>}
            </div>
            {(() => {
              const isCardCreator = openCardReminder.createdBy === user?.uid;
              const myStatus = isCardCreator ? undefined : myResponses.get(openCardReminder.id);

              // Declined: no due-time acting UI at all — just a way to change their mind. The
              // suppression itself lives in the scheduling effect above; this is just the surface
              // for it.
              if (myStatus === 'declined') {
                return (
                  <div className="space-y-2">
                    <p className="text-sm font-bold text-error flex items-center justify-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px]">block</span>{t('reminders.youDeclined')}
                    </p>
                    <button
                      type="button"
                      onClick={() => { handleRespond(openCardReminder, 'accepted'); }}
                      className="w-full py-3 bg-primary text-white font-bold rounded-xl"
                    >
                      {t('reminders.acceptNow')}
                    </button>
                  </div>
                );
              }

              return (
                <>
                  {!isCardCreator && myStatus !== 'accepted' && (
                    <div className="space-y-2 pb-3 border-b border-border-subtle">
                      <p className="text-xs font-bold text-text-muted">{t('reminders.respondPrompt')}</p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => { handleRespond(openCardReminder, 'accepted'); }}
                          className="flex-1 py-2.5 bg-success text-white font-bold rounded-xl text-sm"
                        >
                          {t('reminders.accept')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { handleRespond(openCardReminder, 'declined'); }}
                          className="flex-1 py-2.5 bg-surface-alt text-error font-bold rounded-xl text-sm"
                        >
                          {t('reminders.decline')}
                        </button>
                      </div>
                    </div>
                  )}
                  {openCardReminder.requireAck ? (
                    (() => {
                      const occ = nextOccurrence(openCardReminder, today) || today;
                      const acksForOcc = (acksByReminder.get(openCardReminder.id) || []).filter((a) => a.occurrenceDate === occ);
                      const myAck = user ? acksForOcc.find((a) => a.uid === user.uid) : undefined;
                      const mode = openCardReminder.completionMode || 'all';
                      // 'any' mode: someone ELSE already closed it for everyone — nothing left for
                      // me to do, and there's no ack of MY OWN here to undo.
                      const completedByOther = mode === 'any' && !myAck ? acksForOcc[0] : undefined;
                      if (myAck) {
                        return (
                          <div className="space-y-2">
                            <p className="text-sm font-bold text-success flex items-center justify-center gap-1.5">
                              <span className="material-symbols-outlined text-[18px]">check_circle</span>{t('reminders.markedDone')}
                            </p>
                            <button
                              type="button"
                              onClick={() => { handleUndoDone(openCardReminder); }}
                              className="w-full py-2 text-xs font-bold text-text-muted underline"
                            >
                              {t('reminders.undo')}
                            </button>
                          </div>
                        );
                      }
                      if (completedByOther) {
                        return (
                          <p className="text-sm font-bold text-success flex items-center justify-center gap-1.5">
                            <span className="material-symbols-outlined text-[18px]">check_circle</span>
                            {t('reminders.completedByOther', { name: resolvePerson(completedByOther.uid).displayName })}
                          </p>
                        );
                      }
                      return (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => { handleMarkDone(openCardReminder); }}
                            className="flex-1 py-3 bg-primary text-white font-bold rounded-xl"
                          >
                            {t('reminders.markDone')}
                          </button>
                          <button
                            type="button"
                            onClick={() => { handleSnooze(openCardReminder); }}
                            className="px-4 py-3 bg-surface-alt text-text-muted font-bold rounded-xl flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-[18px]">snooze</span>
                            {t('reminders.snooze')}
                          </button>
                        </div>
                      );
                    })()
                  ) : (
                    <button
                      type="button"
                      onClick={() => { handleSnooze(openCardReminder); }}
                      className="w-full py-2 text-xs font-bold text-text-muted flex items-center justify-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[16px]">snooze</span>
                      {t('reminders.snooze')}
                    </button>
                  )}
                </>
              );
            })()}
            <button type="button" onClick={closeOpenCard} className="w-full py-2 text-xs font-bold text-text-muted">
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
