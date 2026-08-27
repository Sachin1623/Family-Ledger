import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { collection, query, where, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { motion } from 'motion/react';
import { fireWrite } from '../lib/offlineWrite';
import { shareOrDownloadFile } from '../lib/fileShare';
import { toLocalDateString, todayLocalDateString, nowLocalTimeString, combineLocalDateAndTime } from '../lib/dateUtils';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { scheduleGlucoseReminders } from '../lib/healthReminders';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { WEEKDAY_LABELS } from '../lib/frequency';
import { auth } from '../lib/firebase';
import {
  GlucoseLog,
  GlucoseMealType,
  GlucoseTiming,
  GlucoseTarget,
  GlucoseTargetMap,
  GlucoseShareSettings,
  GlucoseReminderSettings,
  GlucoseDelegateSettings,
  defaultGlucoseTargetMap,
  targetForWindow,
  hasShareTarget,
  hasDelegateTarget,
  DEFAULT_GLUCOSE_SHARE_SETTINGS,
  DEFAULT_GLUCOSE_REMINDERS,
  DEFAULT_GLUCOSE_DELEGATE_SETTINGS,
  POST_MEAL_HOUR_OPTIONS,
  GLUCOSE_WINDOWS,
  glucoseWindowOf,
  isGlucoseInRange,
  isShareActiveForDate,
} from '../lib/health';

const MEAL_TYPES: { value: GlucoseMealType; icon: string; labelKey: string }[] = [
  { value: 'breakfast', icon: '🍳', labelKey: 'health.breakfast' },
  { value: 'lunch', icon: '🥗', labelKey: 'health.lunch' },
  { value: 'dinner', icon: '🍽️', labelKey: 'health.dinner' },
];

const DATE_PRESETS = ['all', '7d', '14d', '30d', 'custom'] as const;
type DatePreset = (typeof DATE_PRESETS)[number];

function rangeInfo(value: number, target: GlucoseTarget, t: (k: string) => string) {
  if (value > target.max) return { text: t('health.rangeHigh'), cls: 'text-error', icon: '⚠️' };
  if (value < target.min) return { text: t('health.rangeLow'), cls: 'text-error', icon: '⚠️' };
  return { text: t('health.rangeInTarget'), cls: 'text-success', icon: '✨' };
}

function presetBounds(preset: DatePreset, customStart: string, customEnd: string): { start: string | null; end: string | null } {
  if (preset === 'all') return { start: null, end: null };
  if (preset === 'custom') return { start: customStart || null, end: customEnd || null };
  const days = preset === '7d' ? 7 : preset === '14d' ? 14 : 30;
  const end = todayLocalDateString();
  const startD = new Date();
  startD.setDate(startD.getDate() - (days - 1));
  return { start: toLocalDateString(startD), end };
}

// Splits an array into <=400-item chunks — Firestore batches cap at 500 writes, and a personal
// glucose log can plausibly exceed that after a year or more of daily entries.
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function HealthGlucose() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<'log' | 'dashboard'>('log');

  // Groups I'm in — the standing sharing preference targets one of these (see healthShareSettings).
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

  // Individual friends — the second, group-independent sharing target (see health.ts's
  // GlucoseShareSettings). `usersByUid` doubles as the name/photo source for anyone I share WITH
  // and, further below, for anyone who has shared WITH me directly (not through any group).
  const { accepted: acceptedFriends, usersByUid: friendUsersByUid } = useFriendships(user?.uid);

  // Families (Friends.tsx's "families" feature) are just named subsets of my own accepted
  // friends — see firestore.rules' comment on `families`: a family member is never anyone but an
  // already-accepted friend. So "share with a family" needs no new sharing target at all — picking
  // one just bulk-adds/removes its current member uids into shareForm.friendUids below.
  const { families: myFamilies, membersByFamilyId } = useFamilies(user?.uid);

  // My own logs — whether personal or shared, I'm always the owner and always see all of them.
  const [logsValue] = useCollection(
    user ? query(collection(db, 'glucoseLogs'), where('userId', '==', user.uid)) : null,
  );
  const logs: GlucoseLog[] = useMemo(
    () => (logsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as GlucoseLog[],
    [logsValue],
  );

  // Everyone's readings shared with me — either via a group I'm in, or shared with me directly as
  // a friend (see firestore.rules' glucoseLogs read rule) — merged and deduped by doc id, same
  // pattern ToDoList uses for its own personal+shared queries.
  const [sharedByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'glucoseLogs'), where('groupId', 'in', groupIds)) : null,
  );
  const [sharedByFriendValue] = useCollection(
    user ? query(collection(db, 'glucoseLogs'), where('sharedFriendUids', 'array-contains', user.uid)) : null,
  );
  const sharedLogs: GlucoseLog[] = useMemo(() => {
    const byId = new Map<string, GlucoseLog>();
    sharedByGroupValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    sharedByFriendValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  }, [sharedByGroupValue, sharedByFriendValue]);

  // Who has authorized ME to log a reading or set reminders on THEIR behalf (the reverse of who
  // I've delegated to — see healthDelegateSettings). Same group-scalar + friend-array merge shape
  // as sharedLogs above. Feeds both the Log Entry "Entering for" picker and the Reminders panel's
  // "Setting reminders for" picker — the same permission covers both capabilities.
  const [delegatedToMeByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'healthDelegateSettings'), where('glucose.groupId', 'in', groupIds)) : null,
  );
  const [delegatedToMeByFriendValue] = useCollection(
    user ? query(collection(db, 'healthDelegateSettings'), where('glucose.friendUids', 'array-contains', user.uid)) : null,
  );
  const delegatorsForMe = useMemo(() => {
    const uids = new Set<string>();
    delegatedToMeByGroupValue?.docs.forEach((d) => uids.add(d.id));
    delegatedToMeByFriendValue?.docs.forEach((d) => uids.add(d.id));
    return Array.from(uids)
      .filter((uid) => uid !== user?.uid)
      .map((uid) => {
        const member = allMembers.find((m: any) => m.userId === uid);
        if (member) return { userId: uid, displayName: member.displayName, photoURL: member.photoURL };
        const friend = friendUsersByUid.get(uid);
        return { userId: uid, displayName: friend?.displayName || t('common.someone'), photoURL: friend?.photoURL || '' };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delegatedToMeByGroupValue, delegatedToMeByFriendValue, allMembers, friendUsersByUid, user]);

  // --- Settings: target ranges (per meal window), sharing, delegated entry, reminders ---
  const targets: GlucoseTargetMap = profile?.healthTargets?.glucose || defaultGlucoseTargetMap();
  const [shareSettingsSnap] = useDocument(user ? doc(db, 'healthShareSettings', user.uid) : null);
  const shareSettings: GlucoseShareSettings = (shareSettingsSnap?.data()?.glucose as any) || DEFAULT_GLUCOSE_SHARE_SETTINGS;
  const [delegateSettingsSnap] = useDocument(user ? doc(db, 'healthDelegateSettings', user.uid) : null);
  const delegateSettings: GlucoseDelegateSettings = (delegateSettingsSnap?.data()?.glucose as any) || DEFAULT_GLUCOSE_DELEGATE_SETTINGS;
  const reminders: GlucoseReminderSettings = profile?.glucoseReminders || DEFAULT_GLUCOSE_REMINDERS;

  // The gear button opens a small menu first (Target Range / Sharing / Delegates / Reminders),
  // each of which then opens as its own floating window with its own Save — rather than one long
  // combined sheet, so changing just one thing doesn't require scrolling past the others.
  const [settingsPanel, setSettingsPanel] = useState<'menu' | 'target' | 'sharing' | 'delegates' | 'reminders' | null>(null);
  const [targetForm, setTargetForm] = useState<GlucoseTargetMap>(targets);
  const [shareForm, setShareForm] = useState<GlucoseShareSettings>(shareSettings);
  const [delegateForm, setDelegateForm] = useState<GlucoseDelegateSettings>(delegateSettings);
  const [remindersForm, setRemindersForm] = useState(reminders);
  // Who the Reminders panel is currently editing for — Self, or someone who's delegated to me.
  // Loads/saves THEIR users/{uid}.glucoseReminders instead of mine when not 'me'.
  const [remindersForUid, setRemindersForUid] = useState<string>('me');
  const [savingSettings, setSavingSettings] = useState(false);
  const [friendSearchQuery, setFriendSearchQuery] = useState('');

  const openSettingsMenu = () => {
    setTargetForm(targets);
    setShareForm(shareSettings);
    setDelegateForm(delegateSettings);
    setRemindersForm(reminders);
    setRemindersForUid('me');
    setFriendSearchQuery('');
    setSettingsPanel('menu');
  };

  // A family (Friends.tsx's "families" feature) is just a named subset of my own accepted
  // friends — see useFamilies.ts / firestore.rules' comment on `families`. So a family's
  // "selected" state is derived, not stored: fully selected only once every one of its current
  // members is in the target friendUids list, and toggling it just bulk-adds/removes that set.
  // Shared by the Sharing and Delegates panels — both are "a group and/or some friends" pickers
  // over a different friendUids array, so the toggle logic itself doesn't need to know which.
  const isFamilyFullySelectedIn = (friendUids: string[], familyId: string) => {
    const members = membersByFamilyId.get(familyId) || [];
    return members.length > 0 && members.every((m) => friendUids.includes(m.userId));
  };
  const toggleFamilyInShare = (familyId: string) => {
    const memberUids = (membersByFamilyId.get(familyId) || []).map((m) => m.userId);
    const allSelected = isFamilyFullySelectedIn(shareForm.friendUids, familyId);
    setShareForm((f) => ({
      ...f,
      friendUids: allSelected ? f.friendUids.filter((u) => !memberUids.includes(u)) : Array.from(new Set([...f.friendUids, ...memberUids])),
      mode: !allSelected ? f.mode || 'always' : f.mode,
    }));
  };
  const toggleFriendInShare = (friendUid: string) => {
    setShareForm((f) => {
      const selected = f.friendUids.includes(friendUid);
      return {
        ...f,
        friendUids: selected ? f.friendUids.filter((u) => u !== friendUid) : [...f.friendUids, friendUid],
        mode: !selected ? f.mode || 'always' : f.mode,
      };
    });
  };
  const toggleFamilyInDelegate = (familyId: string) => {
    const memberUids = (membersByFamilyId.get(familyId) || []).map((m) => m.userId);
    const allSelected = isFamilyFullySelectedIn(delegateForm.friendUids, familyId);
    setDelegateForm((f) => ({
      ...f,
      friendUids: allSelected ? f.friendUids.filter((u) => !memberUids.includes(u)) : Array.from(new Set([...f.friendUids, ...memberUids])),
    }));
  };
  const toggleFriendInDelegate = (friendUid: string) => {
    setDelegateForm((f) => ({
      ...f,
      friendUids: f.friendUids.includes(friendUid) ? f.friendUids.filter((u) => u !== friendUid) : [...f.friendUids, friendUid],
    }));
  };
  const filteredFriends = acceptedFriends.filter(({ friendUid }) => {
    if (!friendSearchQuery.trim()) return true;
    const name = friendUsersByUid.get(friendUid)?.displayName || '';
    return name.toLowerCase().includes(friendSearchQuery.trim().toLowerCase());
  });

  const handleSaveTarget = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { healthTargets: { glucose: targetForm } });
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save target ranges:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveSharing = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      await setDoc(doc(db, 'healthShareSettings', user.uid), {
        userId: user.uid,
        glucose: shareForm,
        updatedAt: new Date().toISOString(),
      });

      // Re-tag every existing entry against the NEW sharing rule, evaluated against each entry's
      // own date — a standing preference, not a per-entry choice, so changing it must apply
      // retroactively (e.g. widening a date range should reveal past entries too), not just to
      // whatever gets logged from now on.
      const nextGroupIdFor = (log: GlucoseLog) => (isShareActiveForDate(shareForm, log.loggedAt) ? shareForm.groupId : null);
      const nextFriendUidsFor = (log: GlucoseLog) => (isShareActiveForDate(shareForm, log.loggedAt) ? shareForm.friendUids : []);
      const sameFriendUids = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((u) => b.includes(u));
      const batches = chunk(logs, 400);
      for (const group of batches) {
        const toUpdate = group.filter((log) => nextGroupIdFor(log) !== log.groupId || !sameFriendUids(nextFriendUidsFor(log), log.sharedFriendUids));
        if (toUpdate.length === 0) continue;
        const batch = writeBatch(db);
        toUpdate.forEach((log) => {
          batch.update(doc(db, 'glucoseLogs', log.id), { groupId: nextGroupIdFor(log), sharedFriendUids: nextFriendUidsFor(log) });
        });
        await batch.commit();
      }

      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save sharing settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveDelegates = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      await setDoc(doc(db, 'healthDelegateSettings', user.uid), {
        userId: user.uid,
        glucose: delegateForm,
        updatedAt: new Date().toISOString(),
      });
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save delegate settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  // Loads whoever remindersForUid currently points at, so switching the panel's "Setting
  // reminders for" dropdown always starts from their actual saved settings, not mine.
  const loadRemindersFor = async (targetUid: string) => {
    if (targetUid === 'me') {
      setRemindersForm(reminders);
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'users', targetUid));
      setRemindersForm((snap.data() as any)?.glucoseReminders || DEFAULT_GLUCOSE_REMINDERS);
    } catch (err) {
      console.error('Failed to load reminders for delegate target:', err);
      setRemindersForm(DEFAULT_GLUCOSE_REMINDERS);
    }
  };

  const handleSaveReminders = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      const targetUid = remindersForUid === 'me' ? user.uid : remindersForUid;
      await updateDoc(doc(db, 'users', targetUid), { glucoseReminders: remindersForm });
      // Local notifications are on-device only — scheduling them here would fire on MY phone even
      // when I just set them for someone else. Only self-schedule; the target's own device picks
      // up the change and self-schedules via the effect below the next time THEY open this screen.
      if (remindersForUid === 'me') scheduleGlucoseReminders(remindersForm);
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save reminder settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  // Keeps THIS device's local notifications in sync with my own glucoseReminders field, however
  // it last changed — including a delegate (e.g. a caregiver) setting it on my behalf. Local
  // notifications can only ever be scheduled on the device that runs this, so this is the only
  // point my own phone actually picks up a change made remotely.
  useEffect(() => {
    scheduleGlucoseReminders(reminders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(reminders)]);

  // --- Log entry form ---
  const [mealType, setMealType] = useState<GlucoseMealType>('breakfast');
  const [timing, setTiming] = useState<GlucoseTiming>('before');
  const [postMealHours, setPostMealHours] = useState<number>(2);
  const [valueInput, setValueInput] = useState('');
  const [notes, setNotes] = useState('');
  // Defaults to right now, but editable — for a reading actually taken earlier and only logged
  // later. loggedAt (what these drive) is the clinically-meaningful timestamp everywhere else in
  // this screen; createdAt (separately, always "now") is untouched, preserving when the record
  // itself was actually entered.
  const [loggedDate, setLoggedDate] = useState(todayLocalDateString());
  const [loggedTime, setLoggedTime] = useState(nowLocalTimeString());
  const [saving, setSaving] = useState(false);
  // Self by default; or anyone who's authorized me to log on their behalf (see
  // healthDelegateSettings). The saved entry's userId becomes THEM, loggedBy stays me.
  const [enteringForUid, setEnteringForUid] = useState<string>('me');

  // A `glucose_reminder` push (see healthReminders.ts + pushNotifications.ts) deep-links here as
  // `?meal=&timing=` — prefills the log form and switches to it. Reacts to searchParams itself
  // (not mount-only) since this route can already be mounted when the notification is tapped.
  useEffect(() => {
    const meal = searchParams.get('meal');
    const timing = searchParams.get('timing');
    if (meal || timing) {
      if (meal === 'breakfast' || meal === 'lunch' || meal === 'dinner') setMealType(meal);
      if (timing === 'before' || timing === 'after') setTiming(timing);
      setTab('log');
      const next = new URLSearchParams(searchParams);
      next.delete('meal');
      next.delete('timing');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const parsedValue = parseInt(valueInput, 10);
  const hasValidValue = !isNaN(parsedValue) && parsedValue > 0;

  const windowLabel = (m: GlucoseMealType, tm: GlucoseTiming) => {
    const w = GLUCOSE_WINDOWS.find((x) => x.mealType === m && x.timing === tm);
    return w ? t(w.labelKey) : '';
  };

  const liveWindowTarget = targetForWindow(targets, `${mealType}_${timing}`);

  // Tapping Save doesn't write immediately — it opens a summary to confirm or go back and
  // change, since a glucose reading is often typed in a hurry and a typo is easy to miss.
  const [showConfirm, setShowConfirm] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasValidValue) return;
    setShowConfirm(true);
  };

  const handleConfirmSave = async () => {
    if (!user || !hasValidValue) return;
    setSaving(true);
    try {
      const targetUid = enteringForUid === 'me' ? user.uid : enteringForUid;
      const loggedAt = combineLocalDateAndTime(loggedDate, loggedTime).toISOString();
      const createdAt = new Date().toISOString();

      // Sharing is a property of whose data it is, not who's typing it in — entering for someone
      // else uses THEIR standing sharing preference, fetched fresh rather than the live
      // subscription above (which only ever tracks my own).
      const effectiveShareSettings: GlucoseShareSettings =
        targetUid === user.uid
          ? shareSettings
          : ((await getDoc(doc(db, 'healthShareSettings', targetUid))).data()?.glucose as any) || DEFAULT_GLUCOSE_SHARE_SETTINGS;

      const shouldShare = isShareActiveForDate(effectiveShareSettings, loggedAt);
      const computedGroupId = shouldShare ? effectiveShareSettings.groupId : null;
      const computedFriendUids = shouldShare ? effectiveShareSettings.friendUids : [];
      fireWrite(
        setDoc(doc(collection(db, 'glucoseLogs')), {
          userId: targetUid,
          loggedBy: user.uid,
          groupId: computedGroupId,
          sharedFriendUids: computedFriendUids,
          mealType,
          timing,
          postMealHours: timing === 'after' ? postMealHours : null,
          value: parsedValue,
          notes: notes.trim() || null,
          loggedAt,
          createdAt,
        }),
        'add glucose log',
      );
      const actorName = profile?.displayName || user.displayName || undefined;
      if (computedGroupId) {
        notifyGroupActivity({
          groupId: computedGroupId,
          action: 'glucose_logged',
          amount: parsedValue,
          contextLabel: windowLabel(mealType, timing),
          actorName,
        });
      }
      if (computedFriendUids.length > 0) {
        auth.currentUser
          ?.getIdToken()
          .then((idToken) =>
            fetch('/api/health/notify-glucose-shared', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ friendUids: computedFriendUids, value: parsedValue, contextLabel: windowLabel(mealType, timing), actorName }),
            }),
          )
          .catch((err) => console.error('notify-glucose-shared failed:', err));
      }
      setValueInput('');
      setNotes('');
      setLoggedDate(todayLocalDateString());
      setLoggedTime(nowLocalTimeString());
      setShowConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id: string) => {
    fireWrite(deleteDoc(doc(db, 'glucoseLogs', id)), 'delete glucose log');
  };

  // --- Dashboard: unified filters (whose data, date range, meal, timing, in/out of range) ---
  const [viewUid, setViewUid] = useState<string>('me');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [filterMeal, setFilterMeal] = useState<'all' | GlucoseMealType>('all');
  const [filterTiming, setFilterTiming] = useState<'all' | GlucoseTiming>('all');
  const [filterRangeStatus, setFilterRangeStatus] = useState<'all' | 'inRange' | 'outOfRange'>('all');
  // Collapsed by CSS height, not unmounted — chartRefs must stay measurable by html2canvas for
  // PDF export even while a section is visually collapsed on screen.
  const [chartsCollapsed, setChartsCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);

  // A shared-with-me entry's owner might not share any group with me at all (a friend-only
  // share) — falls back from the group-members list to the friends list for name/photo.
  const resolveSharer = (uid: string): { userId: string; displayName: string; photoURL: string } => {
    const member = allMembers.find((m: any) => m.userId === uid);
    if (member) return { userId: uid, displayName: member.displayName, photoURL: member.photoURL };
    const friend = friendUsersByUid.get(uid);
    return { userId: uid, displayName: friend?.displayName || t('common.someone'), photoURL: friend?.photoURL || '' };
  };

  const shareableMembers = useMemo(() => {
    const uids = Array.from(new Set(sharedLogs.map((l) => l.userId))).filter((uid) => uid !== user?.uid);
    return uids.map(resolveSharer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedLogs, allMembers, friendUsersByUid, user]);

  const baseLogs = viewUid === 'me' ? logs : sharedLogs.filter((l) => l.userId === viewUid);
  const { start: rangeStart, end: rangeEnd } = presetBounds(datePreset, customStart, customEnd);

  // In-range/out-of-range judgments on someone ELSE's readings should use THEIR own target
  // ranges, not mine — `users/{uid}` is readable by any signed-in user (see firestore.rules), so
  // this is just a plain doc read, not a new access grant.
  const [viewedUserSnap] = useDocument(viewUid !== 'me' ? doc(db, 'users', viewUid) : null);
  const viewedTargets: GlucoseTargetMap = viewUid === 'me' ? targets : (viewedUserSnap?.data() as any)?.healthTargets?.glucose || defaultGlucoseTargetMap();

  const filteredLogs = useMemo(() => {
    return baseLogs.filter((l) => {
      const day = l.loggedAt.slice(0, 10);
      if (rangeStart && day < rangeStart) return false;
      if (rangeEnd && day > rangeEnd) return false;
      if (filterMeal !== 'all' && l.mealType !== filterMeal) return false;
      if (filterTiming !== 'all' && l.timing !== filterTiming) return false;
      if (filterRangeStatus !== 'all') {
        const inRange = isGlucoseInRange(l.value, targetForWindow(viewedTargets, glucoseWindowOf(l)));
        if (filterRangeStatus === 'inRange' && !inRange) return false;
        if (filterRangeStatus === 'outOfRange' && inRange) return false;
      }
      return true;
    }).sort((a, b) => (b.loggedAt || '').localeCompare(a.loggedAt || ''));
  }, [baseLogs, rangeStart, rangeEnd, filterMeal, filterTiming, filterRangeStatus, viewedTargets]);

  const clearDashboardFilters = () => {
    setDatePreset('all');
    setCustomStart('');
    setCustomEnd('');
    setFilterMeal('all');
    setFilterTiming('all');
    setFilterRangeStatus('all');
  };

  const average = filteredLogs.length > 0 ? Math.round(filteredLogs.reduce((sum, l) => sum + l.value, 0) / filteredLogs.length) : 0;

  const viewingName =
    viewUid === 'me'
      ? profile?.displayName || user?.displayName || t('health.myReport')
      : shareableMembers.find((m: any) => m.userId === viewUid)?.displayName || t('common.someone');

  const windowAverage = (windowKey: string) => {
    const windowLogs = filteredLogs.filter((l) => glucoseWindowOf(l) === windowKey);
    if (windowLogs.length === 0) return null;
    return Math.round(windowLogs.reduce((sum, l) => sum + l.value, 0) / windowLogs.length);
  };

  const windowTrend = (windowKey: string) =>
    filteredLogs
      .filter((l) => glucoseWindowOf(l) === windowKey)
      .slice()
      .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
      .slice(-14)
      .map((l) => ({
        date: new Date(l.loggedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        value: l.value,
      }));

  const visibleWindows = GLUCOSE_WINDOWS.filter(
    (w) => (filterMeal === 'all' || w.mealType === filterMeal) && (filterTiming === 'all' || w.timing === filterTiming),
  );

  const chartRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [exportingPdf, setExportingPdf] = useState(false);

  const handleClearHistory = () => {
    if (filteredLogs.length === 0) return;
    if (!window.confirm(t('health.confirmClearHistory'))) return;
    filteredLogs.forEach((log) => fireWrite(deleteDoc(doc(db, 'glucoseLogs', log.id)), 'clear glucose log'));
  };

  const handleExportPdf = async () => {
    if (filteredLogs.length === 0) {
      alert(t('health.noDataToExport'));
      return;
    }
    setExportingPdf(true);
    try {
      // Lazy-loaded so these ~300KB+ libraries only ship to whoever actually exports a report.
      const [{ default: jsPDF }, autoTableModule, html2canvasModule] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('html2canvas'),
      ]);
      const autoTable = autoTableModule.default;
      const html2canvas = html2canvasModule.default;
      const docPdf = new jsPDF();

      docPdf.setFontSize(16);
      docPdf.text('Patient Blood Glucose Report', 14, 18);
      docPdf.setFontSize(9);
      docPdf.setTextColor(120);
      const rangeLabel = rangeStart || rangeEnd ? `${rangeStart || 'earliest'} to ${rangeEnd || 'latest'}` : 'All time';
      docPdf.text(`Patient: ${viewingName}`, 14, 24);
      docPdf.text(`Generated via FamilyLedger Health Monitoring — ${new Date().toLocaleString()} — Period: ${rangeLabel}`, 14, 29);
      docPdf.setTextColor(0);
      docPdf.setFontSize(10);
      docPdf.text(`Overall average: ${average} mg/dL     Total readings: ${filteredLogs.length}`, 14, 37);

      let y = 42;
      docPdf.setFontSize(11);
      docPdf.text('Meal Window Averages (target range per window)', 14, y);
      y += 6;
      docPdf.setFontSize(9);
      visibleWindows.forEach((w) => {
        const avg = windowAverage(w.key);
        const wTarget = targetForWindow(viewedTargets, w.key);
        docPdf.text(`${t(w.labelKey)}: ${avg != null ? avg + ' mg/dL' : 'No data'} (target ${wTarget.min}-${wTarget.max})`, 14, y);
        y += 5;
      });
      y += 3;

      autoTable(docPdf, {
        startY: y,
        head: [['Date & Time', 'Meal', 'Timing', 'Reading (mg/dL)']],
        body: filteredLogs.map((l) => [
          new Date(l.loggedAt).toLocaleString(),
          t(`health.${l.mealType}`),
          l.timing === 'before' ? t('health.beforeMeal') : `${t('health.afterMeal')} (${l.postMealHours}hr)`,
          String(l.value),
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [15, 71, 97] },
      });

      const finalY = (docPdf as any).lastAutoTable?.finalY || y;
      const notesText = filteredLogs
        .filter((l) => l.notes)
        .map((l) => `${new Date(l.loggedAt).toLocaleDateString()}: ${l.notes}`)
        .join('   |   ');
      if (notesText) {
        docPdf.setFontSize(9);
        docPdf.text('Patient Notes / Symptoms:', 14, finalY + 10);
        docPdf.text(docPdf.splitTextToSize(notesText, 180), 14, finalY + 15);
      }

      // Charts, one per meal window with at least 2 points — captured from the already-rendered
      // Dashboard tab charts via html2canvas, so this needs the user to have viewed the Dashboard
      // tab in this session first (chartRefs only populate once each chart actually mounts).
      const chartable = visibleWindows.filter((w) => windowTrend(w.key).length >= 2 && chartRefs.current.get(w.key));
      if (chartable.length > 0) {
        docPdf.addPage();
        docPdf.setFontSize(13);
        docPdf.setTextColor(0);
        docPdf.text('Meal Trend Charts', 14, 18);
        let cy = 28;
        for (const w of chartable) {
          const el = chartRefs.current.get(w.key)!;
          const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' });
          const imgData = canvas.toDataURL('image/png');
          const imgWidth = 110;
          const imgHeight = (canvas.height / canvas.width) * imgWidth;
          if (cy + imgHeight + 12 > 280) {
            docPdf.addPage();
            cy = 18;
          }
          docPdf.setFontSize(10);
          docPdf.text(t(w.labelKey), 14, cy);
          docPdf.addImage(imgData, 'PNG', 14, cy + 3, imgWidth, imgHeight);
          cy += imgHeight + 14;
        }
      }

      // Footer on every page — patient name (already in the header too, but a footer survives a
      // page getting separated from the rest) and where to get/open FamilyLedger. No iOS link yet
      // — the app isn't published there; add it here once it is.
      const webUrl = 'https://familyledger-backend-192700919713.us-central1.run.app';
      const androidUrl = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
      const totalPages = docPdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        docPdf.setPage(i);
        docPdf.setFontSize(7);
        docPdf.setTextColor(150);
        docPdf.text(`${viewingName} · FamilyLedger — Web: ${webUrl}  ·  Android: ${androidUrl}`, 14, 291);
      }

      const pdfBlob = docPdf.output('blob') as Blob;
      const safeName = viewingName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
      await shareOrDownloadFile(pdfBlob, `glucose_${safeName}_${todayLocalDateString()}.pdf`, 'application/pdf');
    } catch (err) {
      console.error('Glucose PDF export failed:', err);
      alert(t('health.exportFailed'));
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-3 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-primary leading-tight">{t('health.glucoseTracker')}</h1>
            <p className="text-[11px] text-text-muted leading-tight">{t('health.glucoseTrackerDesc')}</p>
          </div>
          <button
            type="button"
            onClick={openSettingsMenu}
            className="shrink-0 w-9 h-9 rounded-xl bg-white border border-border-subtle flex items-center justify-center text-primary hover:bg-primary/5 transition-colors"
            title={t('health.settings')}
          >
            <span className="material-symbols-outlined text-[18px]">settings</span>
          </button>
        </div>

        {/* Log Entry / Dashboard tabs */}
        <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
          <button
            type="button"
            onClick={() => setTab('log')}
            className={clsx(
              'flex-1 py-2 rounded-lg text-xs font-bold transition-all',
              tab === 'log' ? 'bg-primary text-white' : 'text-text-muted',
            )}
          >
            {t('health.logEntry')}
          </button>
          <button
            type="button"
            onClick={() => setTab('dashboard')}
            className={clsx(
              'flex-1 py-2 rounded-lg text-xs font-bold transition-all',
              tab === 'dashboard' ? 'bg-primary text-white' : 'text-text-muted',
            )}
          >
            {t('health.dashboard')}
          </button>
        </div>

        {tab === 'log' && (
          <form onSubmit={handleSubmit} className="space-y-2.5">
            {delegatorsForMe.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('health.enteringFor')}</label>
                <select
                  value={enteringForUid}
                  onChange={(e) => setEnteringForUid(e.target.value)}
                  className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
                >
                  <option value="me">{t('health.myself')}</option>
                  {delegatorsForMe.map((d) => (
                    <option key={d.userId} value={d.userId}>{d.displayName}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('health.selectMealType')}</label>
              <div className="grid grid-cols-3 gap-1.5">
                {MEAL_TYPES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMealType(m.value)}
                    className={clsx(
                      'py-3.5 rounded-xl border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all',
                      mealType === m.value ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                    )}
                  >
                    <span className="text-3xl">{m.icon}</span>
                    {t(m.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('health.testingTiming')}</label>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setTiming('before')}
                  className={clsx(
                    'flex-1 py-2 rounded-xl text-xs font-bold border transition-all',
                    timing === 'before' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {t('health.beforeMeal')}
                </button>
                <button
                  type="button"
                  onClick={() => setTiming('after')}
                  className={clsx(
                    'flex-1 py-2 rounded-xl text-xs font-bold border transition-all',
                    timing === 'after' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                  )}
                >
                  {t('health.afterMeal')}
                </button>
                {timing === 'after' && (
                  <select
                    value={postMealHours}
                    onChange={(e) => setPostMealHours(Number(e.target.value))}
                    title={t('health.postMealDuration')}
                    className="shrink-0 w-16 bg-white border border-border-subtle rounded-xl text-xs font-bold text-primary outline-none text-center"
                  >
                    {POST_MEAL_HOUR_OPTIONS.map((hr) => (
                      <option key={hr} value={hr}>+{hr}hr</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-2.5 space-y-1.5">
              <label className="text-[10px] text-text-muted font-bold uppercase tracking-wider">{t('health.enterGlucoseValue')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  value={valueInput}
                  onChange={(e) => setValueInput(e.target.value)}
                  placeholder="0"
                  className="flex-1 min-w-0 text-2xl font-black text-primary bg-surface rounded-xl border border-border-subtle text-center py-2 outline-none focus:ring-2 focus:ring-primary/20"
                />
                <div className="shrink-0 text-left space-y-0.5">
                  <div className="text-[11px] font-bold text-text-muted">mg/dL</div>
                  {hasValidValue && (
                    <div className={clsx('text-[10px] font-bold flex items-center gap-1 whitespace-nowrap', rangeInfo(parsedValue, liveWindowTarget, t).cls)}>
                      {rangeInfo(parsedValue, liveWindowTarget, t).icon} {rangeInfo(parsedValue, liveWindowTarget, t).text}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('health.dateAndTime')}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={loggedDate}
                  max={todayLocalDateString()}
                  onChange={(e) => setLoggedDate(e.target.value)}
                  className="flex-1 min-w-0 bg-white p-2.5 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none focus:ring-2 focus:ring-primary/20"
                />
                <input
                  type="time"
                  value={loggedTime}
                  onChange={(e) => setLoggedTime(e.target.value)}
                  className="flex-1 min-w-0 bg-white p-2.5 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('health.notesPlaceholder')}
              rows={2}
              className="w-full bg-white p-2 rounded-xl border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />

            <button
              type="submit"
              disabled={saving || !hasValidValue}
              className="w-full py-2.5 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('health.saveLogEntry')}
            </button>
          </form>
        )}

        {tab === 'dashboard' && (
          <div className="space-y-6">
            {/* Whose report — my own, or anyone who's shared readings with me (via a group,
                friend, or family) — drives everything below, including the PDF download. */}
            {shareableMembers.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('health.viewingReportFor')}</label>
                <select
                  value={viewUid}
                  onChange={(e) => setViewUid(e.target.value)}
                  className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none shadow-sm"
                >
                  <option value="me">{t('health.myReport')}</option>
                  {shareableMembers.map((m: any) => (
                    <option key={m.userId} value={m.userId}>{m.displayName}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Filters — date range, meal, timing, in/out of range; apply to stats, charts & table */}
            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('health.filters')}</span>
                <button type="button" onClick={clearDashboardFilters} className="text-[10px] font-bold text-primary">
                  {t('health.clearFilters')}
                </button>
              </div>
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setDatePreset(p)}
                    className={clsx(
                      'shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold border transition-all',
                      datePreset === p ? 'bg-primary text-white border-primary' : 'bg-surface text-text-muted border-border-subtle',
                    )}
                  >
                    {t(`health.datePreset.${p}`)}
                  </button>
                ))}
              </div>
              {datePreset === 'custom' && (
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-1.5 text-xs font-bold text-primary outline-none"
                  />
                  <span className="text-[10px] font-bold text-text-muted uppercase shrink-0">{t('common.to')}</span>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-1.5 text-xs font-bold text-primary outline-none"
                  />
                </div>
              )}
              <div className="grid grid-cols-3 gap-1.5">
                <select
                  value={filterMeal}
                  onChange={(e) => setFilterMeal(e.target.value as any)}
                  className="bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none"
                >
                  <option value="all">{t('health.allMeals')}</option>
                  {MEAL_TYPES.map((m) => (
                    <option key={m.value} value={m.value}>{t(m.labelKey)}</option>
                  ))}
                </select>
                <select
                  value={filterTiming}
                  onChange={(e) => setFilterTiming(e.target.value as any)}
                  className="bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none"
                >
                  <option value="all">{t('health.allTimings')}</option>
                  <option value="before">{t('health.beforeMeal')}</option>
                  <option value="after">{t('health.afterMeal')}</option>
                </select>
                <select
                  value={filterRangeStatus}
                  onChange={(e) => setFilterRangeStatus(e.target.value as any)}
                  className="bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none"
                >
                  <option value="all">{t('health.allReadings')}</option>
                  <option value="inRange">{t('health.rangeInTarget')}</option>
                  <option value="outOfRange">{t('health.outOfRange')}</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('health.averageGlucose')}</p>
                <p className="text-2xl font-black text-primary mt-1">{average || '—'} <span className="text-xs font-bold text-text-muted">mg/dL</span></p>
              </div>
              <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('health.totalEntries')}</p>
                <p className="text-2xl font-black text-primary mt-1">{filteredLogs.length} <span className="text-xs font-bold text-text-muted">{t('health.records')}</span></p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleExportPdf}
              disabled={exportingPdf || filteredLogs.length === 0}
              className="w-full py-3 bg-primary/5 border border-primary/20 text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">picture_as_pdf</span>
              {exportingPdf ? t('health.generatingPdf') : viewUid === 'me' ? t('health.exportPdfForDoctor') : t('health.downloadReportFor', { name: viewingName })}
            </button>

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-3">
              <button
                type="button"
                onClick={() => setChartsCollapsed((c) => !c)}
                className="w-full flex items-center justify-between text-left"
              >
                <div>
                  <h3 className="font-bold text-primary text-sm">{t('health.mealTrendCharts')}</h3>
                  <p className="text-[11px] text-text-muted">{t('health.mealTrendChartsDesc')}</p>
                </div>
                <span className={clsx('material-symbols-outlined text-text-muted transition-transform shrink-0', chartsCollapsed && '-rotate-90')}>
                  expand_more
                </span>
              </button>
              <motion.div
                initial={false}
                animate={{ height: chartsCollapsed ? 0 : 'auto', opacity: chartsCollapsed ? 0 : 1 }}
                transition={{ duration: 0.2, ease: 'easeInOut' }}
                className="overflow-hidden"
              >
              <div className="space-y-3">
                {visibleWindows.map((w) => {
                  const trend = windowTrend(w.key);
                  const avg = windowAverage(w.key);
                  const wTarget = targetForWindow(viewedTargets, w.key);
                  return (
                    <div
                      key={w.key}
                      ref={(el) => {
                        if (el) chartRefs.current.set(w.key, el);
                      }}
                      className="bg-surface rounded-xl border border-border-subtle p-3"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold flex items-center gap-1.5">
                          <span>{w.icon}</span>{t(w.labelKey)}
                          <span className="text-[9px] font-medium text-text-muted normal-case">({wTarget.min}-{wTarget.max})</span>
                        </span>
                        <span className="text-xs font-black text-primary">{avg != null ? `${avg} mg/dL` : t('health.noData')}</span>
                      </div>
                      {trend.length >= 2 ? (
                        <div className="h-28">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={trend} margin={{ top: 16, right: 12, left: 12, bottom: 0 }}>
                              {/* padding on the axis (not just chart margin) keeps the first/last
                                  tick's own text centered fully inside the plot area — margin alone
                                  still lets the tick render right at the container edge. */}
                              <XAxis dataKey="date" fontSize={9} tick={{ fill: '#9CA3AF' }} axisLine={false} tickLine={false} padding={{ left: 12, right: 12 }} />
                              <YAxis hide width={0} domain={['dataMin - 10', 'dataMax + 10']} />
                              <Tooltip formatter={(v: number) => [`${v} mg/dL`, '']} labelStyle={{ fontSize: 11 }} />
                              <Line
                                type="monotone"
                                dataKey="value"
                                stroke="#0f4761"
                                strokeWidth={2}
                                dot={{ r: 2 }}
                                label={{ position: 'top', fontSize: 9, fontWeight: 700, fill: '#0f4761' }}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <p className="text-[11px] text-text-muted italic py-3 text-center">{t('health.needTwoEntries')}</p>
                      )}
                    </div>
                  );
                })}
              </div>
              </motion.div>
            </div>

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setTableCollapsed((c) => !c)}
                  className="flex items-center gap-1.5 text-left min-w-0"
                >
                  <span className={clsx('material-symbols-outlined text-text-muted transition-transform text-[18px] shrink-0', tableCollapsed && '-rotate-90')}>
                    expand_more
                  </span>
                  <h3 className="font-bold text-primary text-sm truncate">{t('health.tabularRecordsLog')}</h3>
                </button>
                {viewUid === 'me' && filteredLogs.length > 0 && (
                  <button type="button" onClick={handleClearHistory} className="text-[11px] font-bold text-error shrink-0">
                    {t('health.clearHistory')}
                  </button>
                )}
              </div>
              {!tableCollapsed && (
                filteredLogs.length === 0 ? (
                  <p className="text-sm text-text-muted text-center py-8">{t('health.noEntriesYet')}</p>
                ) : (
                  <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto">
                    {filteredLogs.map((log) => {
                      const info = rangeInfo(log.value, targetForWindow(viewedTargets, glucoseWindowOf(log)), t);
                      return (
                        <div key={log.id} className="px-4 py-3 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-bold truncate">
                              {t(`health.${log.mealType}`)} · {log.timing === 'before' ? t('health.beforeMeal') : `${t('health.afterMeal')} (${log.postMealHours}hr)`}
                            </p>
                            <p className="text-[10px] text-text-muted">{new Date(log.loggedAt).toLocaleString()}</p>
                            {log.notes && <p className="text-[10px] text-text-muted italic truncate mt-0.5">{log.notes}</p>}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-black text-primary">{log.value} <span className="text-[10px] font-bold text-text-muted">mg/dL</span></p>
                            <p className={clsx('text-[9px] font-bold', info.cls)}>{info.icon} {info.text}</p>
                          </div>
                          {viewUid === 'me' && (
                            <button
                              type="button"
                              onClick={() => handleDelete(log.id)}
                              className="shrink-0 p-1.5 text-text-muted hover:text-error transition-colors"
                            >
                              <span className="material-symbols-outlined text-[16px]">delete</span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </main>

      {showConfirm && (
        // Centered on every screen size (not a bottom sheet) — anchoring this to the bottom on
        // mobile put its Confirm button right behind the fixed bottom nav bar, off-screen and
        // untappable. max-h + its own overflow-y-auto keeps it fully on-screen and scrollable
        // internally on short viewports instead of pushing content below the fold.
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowConfirm(false)}>
          <div
            className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-black text-primary">{t('health.confirmTitle')}</h2>

            <div className="bg-surface rounded-2xl border border-border-subtle p-4 space-y-3">
              {enteringForUid !== 'me' && (
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
                  <span className="material-symbols-outlined text-[14px]">person</span>
                  {t('health.enteringForName', { name: delegatorsForMe.find((d) => d.userId === enteringForUid)?.displayName || '' })}
                </div>
              )}
              <div className="flex items-center gap-3">
                <span className="text-3xl shrink-0">{MEAL_TYPES.find((m) => m.value === mealType)?.icon}</span>
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">{windowLabel(mealType, timing)}{timing === 'after' ? ` (+${postMealHours}hr)` : ''}</p>
                  <p className="text-[11px] text-text-muted">{combineLocalDateAndTime(loggedDate, loggedTime).toLocaleString()}</p>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-border-subtle pt-3">
                <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">{t('health.readingLabel')}</span>
                <div className="text-right">
                  <p className="text-2xl font-black text-primary">{parsedValue} <span className="text-xs font-bold text-text-muted">mg/dL</span></p>
                  <p className={clsx('text-[10px] font-bold flex items-center justify-end gap-1', rangeInfo(parsedValue, liveWindowTarget, t).cls)}>
                    {rangeInfo(parsedValue, liveWindowTarget, t).icon} {rangeInfo(parsedValue, liveWindowTarget, t).text}
                  </p>
                </div>
              </div>

              {notes.trim() && (
                <div className="border-t border-border-subtle pt-3">
                  <p className="text-[11px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('health.notes')}</p>
                  <p className="text-xs text-on-surface">{notes.trim()}</p>
                </div>
              )}

              <div className="flex items-center gap-1.5 border-t border-border-subtle pt-3 text-[11px] text-text-muted">
                <span className="material-symbols-outlined text-[14px]">{hasShareTarget(shareSettings) ? 'share' : 'lock'}</span>
                {hasShareTarget(shareSettings) ? t('health.sharing') : t('todo.justMe')}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle"
              >
                {t('health.change')}
              </button>
              <button
                type="button"
                onClick={handleConfirmSave}
                disabled={saving}
                className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
              >
                {saving ? t('common.saving') : t('health.confirmAndSave')}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsPanel === 'menu' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-xs rounded-2xl p-2 space-y-0.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2">
              <h2 className="text-sm font-black text-primary">{t('health.settings')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            {[
              { key: 'target' as const, icon: 'track_changes', label: t('health.targetRange') },
              { key: 'sharing' as const, icon: 'share', label: t('health.sharing') },
              { key: 'delegates' as const, icon: 'group_add', label: t('health.delegates') },
              { key: 'reminders' as const, icon: 'notifications_active', label: t('health.reminders') },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSettingsPanel(item.key)}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-surface transition-colors text-left"
              >
                <span className="material-symbols-outlined text-primary text-[20px]">{item.icon}</span>
                <span className="flex-1 text-sm font-bold">{item.label}</span>
                <span className="material-symbols-outlined text-text-muted text-[18px]">chevron_right</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {settingsPanel === 'target' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSettingsPanel('menu')} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
              </button>
              <h2 className="text-base font-black text-primary flex-1">{t('health.targetRange')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* One range per meal window, since before/after targets genuinely differ */}
            <div className="space-y-1.5">
              {GLUCOSE_WINDOWS.map((w) => (
                <div key={w.key} className="flex items-center gap-2 bg-surface rounded-lg p-2 border border-border-subtle">
                  <span className="text-sm shrink-0">{w.icon}</span>
                  <span className="text-[10px] font-bold text-text-muted w-20 shrink-0">{t(w.labelKey)}</span>
                  <input
                    type="number"
                    value={targetForm[w.key]?.min ?? ''}
                    onChange={(e) => setTargetForm((f) => ({ ...f, [w.key]: { ...f[w.key], min: Number(e.target.value) } }))}
                    className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                  />
                  <span className="text-text-muted text-[10px] font-bold shrink-0">{t('common.to')}</span>
                  <input
                    type="number"
                    value={targetForm[w.key]?.max ?? ''}
                    onChange={(e) => setTargetForm((f) => ({ ...f, [w.key]: { ...f[w.key], max: Number(e.target.value) } }))}
                    className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={handleSaveTarget}
              disabled={savingSettings}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {settingsPanel === 'sharing' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSettingsPanel('menu')} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
              </button>
              <h2 className="text-base font-black text-primary flex-1">{t('health.sharing')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* One group AND/OR any number of individual friends, independent of each other */}
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('health.shareWithGroup')}</label>
              <select
                value={shareForm.groupId || ''}
                onChange={(e) => setShareForm((f) => ({ ...f, groupId: e.target.value || null, mode: e.target.value ? f.mode || 'always' : f.mode }))}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
              >
                <option value="">{t('todo.justMe')}</option>
                {groups.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            {myFamilies.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted px-1">{t('health.shareWithFamilies')}</label>
                <div className="space-y-1">
                  {myFamilies.map((fam: any) => {
                    const members = membersByFamilyId.get(fam.id) || [];
                    const selected = isFamilyFullySelectedIn(shareForm.friendUids, fam.id);
                    return (
                      <button
                        key={fam.id}
                        type="button"
                        onClick={() => toggleFamilyInShare(fam.id)}
                        className={clsx(
                          'w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all',
                          selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle',
                        )}
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
              </div>
            )}
            {acceptedFriends.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1">
                  <label className="text-[10px] font-bold text-text-muted">{t('health.shareWithFriends')}</label>
                  {shareForm.friendUids.length > 0 && (
                    <span className="text-[10px] font-bold text-primary">{t('health.friendsSelectedCount', { count: shareForm.friendUids.length })}</span>
                  )}
                </div>
                <input
                  type="text"
                  value={friendSearchQuery}
                  onChange={(e) => setFriendSearchQuery(e.target.value)}
                  placeholder={t('health.searchFriends')}
                  className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none"
                />
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
                  {filteredFriends.length === 0 ? (
                    <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
                  ) : (
                    filteredFriends.map(({ friendUid }) => {
                      const friend = friendUsersByUid.get(friendUid);
                      const selected = shareForm.friendUids.includes(friendUid);
                      return (
                        <button
                          key={friendUid}
                          type="button"
                          onClick={() => toggleFriendInShare(friendUid)}
                          className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors"
                        >
                          <img
                            src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`}
                            className="w-6 h-6 rounded-full object-cover shrink-0"
                            alt=""
                          />
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
            {hasShareTarget(shareForm) && (
              <>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShareForm((f) => ({ ...f, mode: 'always' }))}
                    className={clsx(
                      'flex-1 py-2 rounded-lg text-xs font-bold border transition-all',
                      shareForm.mode === 'always' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                    )}
                  >
                    {t('health.always')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShareForm((f) => ({ ...f, mode: 'range' }))}
                    className={clsx(
                      'flex-1 py-2 rounded-lg text-xs font-bold border transition-all',
                      shareForm.mode === 'range' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                    )}
                  >
                    {t('health.dateRangeLabel')}
                  </button>
                </div>
                {shareForm.mode === 'range' && (
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={shareForm.startDate || ''}
                      onChange={(e) => setShareForm((f) => ({ ...f, startDate: e.target.value || null }))}
                      className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-2 text-xs font-bold text-primary outline-none"
                    />
                    <span className="text-[10px] font-bold text-text-muted uppercase shrink-0">{t('common.to')}</span>
                    <input
                      type="date"
                      value={shareForm.endDate || ''}
                      onChange={(e) => setShareForm((f) => ({ ...f, endDate: e.target.value || null }))}
                      placeholder={t('health.ongoing')}
                      className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-2 text-xs font-bold text-primary outline-none"
                    />
                  </div>
                )}
                <p className="text-[10px] text-text-muted">{t('health.sharingHint')}</p>
              </>
            )}

            <button
              type="button"
              onClick={handleSaveSharing}
              disabled={savingSettings}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {settingsPanel === 'delegates' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSettingsPanel('menu')} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
              </button>
              <h2 className="text-base font-black text-primary flex-1">{t('health.delegates')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <p className="text-[11px] text-text-muted">{t('health.delegatesHint')}</p>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('health.shareWithGroup')}</label>
              <select
                value={delegateForm.groupId || ''}
                onChange={(e) => setDelegateForm((f) => ({ ...f, groupId: e.target.value || null }))}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
              >
                <option value="">{t('todo.justMe')}</option>
                {groups.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            {myFamilies.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted px-1">{t('health.shareWithFamilies')}</label>
                <div className="space-y-1">
                  {myFamilies.map((fam: any) => {
                    const members = membersByFamilyId.get(fam.id) || [];
                    const selected = isFamilyFullySelectedIn(delegateForm.friendUids, fam.id);
                    return (
                      <button
                        key={fam.id}
                        type="button"
                        onClick={() => toggleFamilyInDelegate(fam.id)}
                        className={clsx(
                          'w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all',
                          selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle',
                        )}
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
              </div>
            )}
            {acceptedFriends.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1">
                  <label className="text-[10px] font-bold text-text-muted">{t('health.shareWithFriends')}</label>
                  {delegateForm.friendUids.length > 0 && (
                    <span className="text-[10px] font-bold text-primary">{t('health.friendsSelectedCount', { count: delegateForm.friendUids.length })}</span>
                  )}
                </div>
                <input
                  type="text"
                  value={friendSearchQuery}
                  onChange={(e) => setFriendSearchQuery(e.target.value)}
                  placeholder={t('health.searchFriends')}
                  className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none"
                />
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
                  {filteredFriends.length === 0 ? (
                    <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
                  ) : (
                    filteredFriends.map(({ friendUid }) => {
                      const friend = friendUsersByUid.get(friendUid);
                      const selected = delegateForm.friendUids.includes(friendUid);
                      return (
                        <button
                          key={friendUid}
                          type="button"
                          onClick={() => toggleFriendInDelegate(friendUid)}
                          className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors"
                        >
                          <img
                            src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`}
                            className="w-6 h-6 rounded-full object-cover shrink-0"
                            alt=""
                          />
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

            <button
              type="button"
              onClick={handleSaveDelegates}
              disabled={savingSettings}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {settingsPanel === 'reminders' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSettingsPanel('menu')} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
              </button>
              <h2 className="text-base font-black text-primary flex-1">{t('health.reminders')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted shrink-0">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {delegatorsForMe.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted px-1">{t('health.settingRemindersFor')}</label>
                <select
                  value={remindersForUid}
                  onChange={(e) => {
                    setRemindersForUid(e.target.value);
                    loadRemindersFor(e.target.value);
                  }}
                  className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
                >
                  <option value="me">{t('health.myself')}</option>
                  {delegatorsForMe.map((d) => (
                    <option key={d.userId} value={d.userId}>{d.displayName}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('health.reminders')}</span>
              <button
                type="button"
                onClick={() => setRemindersForm((f) => ({ ...f, enabled: !f.enabled }))}
                className={clsx('w-10 h-6 rounded-full transition-colors relative shrink-0', remindersForm.enabled ? 'bg-primary' : 'bg-surface-container')}
              >
                <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', remindersForm.enabled ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </div>
            {remindersForm.enabled && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('health.remindMeFor')}</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {MEAL_TYPES.map((m) => {
                      const selected = remindersForm.meals.includes(m.value);
                      return (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() =>
                            setRemindersForm((f) => ({
                              ...f,
                              meals: selected ? f.meals.filter((x) => x !== m.value) : [...f.meals, m.value],
                            }))
                          }
                          className={clsx(
                            'py-2 rounded-lg text-xs font-bold border flex items-center justify-center gap-1 transition-all',
                            selected ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                          )}
                        >
                          <span>{m.icon}</span>{t(m.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('health.repeats')}</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setRemindersForm((f) => ({ ...f, cadence: 'daily' }))}
                      className={clsx(
                        'flex-1 py-2 rounded-lg text-xs font-bold border transition-all',
                        remindersForm.cadence === 'daily' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                      )}
                    >
                      {t('health.daily')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemindersForm((f) => ({ ...f, cadence: 'weekly' }))}
                      className={clsx(
                        'flex-1 py-2 rounded-lg text-xs font-bold border transition-all',
                        remindersForm.cadence === 'weekly' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                      )}
                    >
                      {t('health.weekly')}
                    </button>
                  </div>
                  {remindersForm.cadence === 'weekly' && (
                    <div className="flex gap-1 pt-1">
                      {WEEKDAY_LABELS.map((label, idx) => {
                        const selected = remindersForm.weekdays.includes(idx);
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() =>
                              setRemindersForm((f) => ({
                                ...f,
                                weekdays: selected ? f.weekdays.filter((d) => d !== idx) : [...f.weekdays, idx],
                              }))
                            }
                            className={clsx(
                              'flex-1 py-1.5 rounded-lg text-[10px] font-bold border transition-all',
                              selected ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle',
                            )}
                          >
                            {label.slice(0, 1)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {remindersForm.meals.length > 0 && (
                  <div className="space-y-2">
                    {MEAL_TYPES.filter((m) => remindersForm.meals.includes(m.value)).map((m) => (
                      <div key={m.value} className="flex items-center gap-2 bg-surface rounded-lg p-2 border border-border-subtle">
                        <span className="text-sm shrink-0">{m.icon}</span>
                        <span className="text-[11px] font-bold text-text-muted w-16 shrink-0">{t(m.labelKey)}</span>
                        <input
                          type="time"
                          value={remindersForm[m.value].time}
                          onChange={(e) => setRemindersForm((f) => ({ ...f, [m.value]: { ...f[m.value], time: e.target.value } }))}
                          className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                        />
                        <select
                          value={remindersForm[m.value].afterHours}
                          onChange={(e) => setRemindersForm((f) => ({ ...f, [m.value]: { ...f[m.value], afterHours: Number(e.target.value) } }))}
                          className="shrink-0 bg-white border border-border-subtle rounded-md px-1.5 py-1 text-xs font-bold text-primary outline-none"
                        >
                          {POST_MEAL_HOUR_OPTIONS.map((hr) => (
                            <option key={hr} value={hr}>+{hr}hr</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-text-muted">{t('health.reminderHint')}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleSaveReminders}
              disabled={savingSettings}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
