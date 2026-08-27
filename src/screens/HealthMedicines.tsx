import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { collection, query, where, documentId, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { motion } from 'motion/react';
import { fireWrite } from '../lib/offlineWrite';
import { shareOrDownloadFile } from '../lib/fileShare';
import { toLocalDateString, todayLocalDateString } from '../lib/dateUtils';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { scheduleMedicineReminders } from '../lib/medicineReminders';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { WEEKDAY_LABELS } from '../lib/frequency';
import { auth } from '../lib/firebase';
import {
  Medicine,
  MedicineDoseTime,
  MedicineLog,
  MedicineLogStatus,
  MedicineShareSettings,
  MedicineDelegateSettings,
  FoodTiming,
  FOOD_TIMING_OPTIONS,
  DEFAULT_MEDICINE_SHARE_SETTINGS,
  DEFAULT_MEDICINE_DELEGATE_SETTINGS,
  hasMedicineShareTarget,
  isMedicineShareActiveForDate,
  isMedicineDueOn,
  medicineEndDateStr,
  medicineStatusLabel,
  medicineLogId,
} from '../lib/medicines';

const DATE_PRESETS = ['all', '7d', '14d', '30d', 'custom'] as const;
type DatePreset = (typeof DATE_PRESETS)[number];

function presetBounds(preset: DatePreset, customStart: string, customEnd: string): { start: string | null; end: string | null } {
  if (preset === 'all') return { start: null, end: null };
  if (preset === 'custom') return { start: customStart || null, end: customEnd || null };
  const days = preset === '7d' ? 7 : preset === '14d' ? 14 : 30;
  const end = todayLocalDateString();
  const startD = new Date();
  startD.setDate(startD.getDate() - (days - 1));
  return { start: toLocalDateString(startD), end };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let nextDoseTimeId = 1;
function newDoseTimeId(): string {
  return `dose_${Date.now()}_${nextDoseTimeId++}`;
}

interface DueInstance {
  dateStr: string;
  medicine: Medicine;
  doseTime: MedicineDoseTime;
  log: MedicineLog | null;
  status: MedicineLogStatus | 'missed' | 'pending';
}

export default function HealthMedicines() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [tab, setTab] = useState<'medicines' | 'log' | 'dashboard'>('medicines');

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

  const [ownMedicinesValue] = useCollection(
    user ? query(collection(db, 'medicines'), where('userId', '==', user.uid)) : null,
  );
  const [sharedMedByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'medicines'), where('groupId', 'in', groupIds)) : null,
  );
  const [sharedMedByFriendValue] = useCollection(
    user ? query(collection(db, 'medicines'), where('sharedFriendUids', 'array-contains', user.uid)) : null,
  );

  const [delegatedToMeByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'medicineDelegateSettings'), where('medicine.groupId', 'in', groupIds)) : null,
  );
  const [delegatedToMeByFriendValue] = useCollection(
    user ? query(collection(db, 'medicineDelegateSettings'), where('medicine.friendUids', 'array-contains', user.uid)) : null,
  );
  const resolveSharer = (uid: string): { userId: string; displayName: string; photoURL: string } => {
    const member = allMembers.find((m: any) => m.userId === uid);
    if (member) return { userId: uid, displayName: member.displayName, photoURL: member.photoURL };
    const friend = friendUsersByUid.get(uid);
    return { userId: uid, displayName: friend?.displayName || t('common.someone'), photoURL: friend?.photoURL || '' };
  };
  const delegatorsForMe = useMemo(() => {
    const uids = new Set<string>();
    delegatedToMeByGroupValue?.docs.forEach((d) => uids.add(d.id));
    delegatedToMeByFriendValue?.docs.forEach((d) => uids.add(d.id));
    return Array.from(uids).filter((uid) => uid !== user?.uid).map(resolveSharer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delegatedToMeByGroupValue, delegatedToMeByFriendValue, allMembers, friendUsersByUid, user]);
  const delegatorUids = useMemo(() => delegatorsForMe.map((d) => d.userId), [delegatorsForMe]);

  // Medicines belonging to anyone who's granted ME delegate access — the delegate READ grant in
  // firestore.rules (see isMedicineDelegateFor) is what makes this query legal even when nothing
  // has been separately shared with a group/friend.
  const [delegatedMedicinesValue] = useCollection(
    delegatorUids.length > 0 ? query(collection(db, 'medicines'), where('userId', 'in', delegatorUids.slice(0, 30))) : null,
  );

  const medicines: Medicine[] = useMemo(() => {
    const byId = new Map<string, Medicine>();
    ownMedicinesValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    sharedMedByGroupValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    sharedMedByFriendValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    delegatedMedicinesValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  }, [ownMedicinesValue, sharedMedByGroupValue, sharedMedByFriendValue, delegatedMedicinesValue]);

  // Own medicine LOGS — needed to compute due/adherence for "my" medicines everywhere.
  const [ownLogsValue] = useCollection(
    user ? query(collection(db, 'medicineLogs'), where('userId', '==', user.uid)) : null,
  );
  const [sharedLogsByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'medicineLogs'), where('groupId', 'in', groupIds)) : null,
  );
  const [sharedLogsByFriendValue] = useCollection(
    user ? query(collection(db, 'medicineLogs'), where('sharedFriendUids', 'array-contains', user.uid)) : null,
  );
  const allLogs: MedicineLog[] = useMemo(() => {
    const byId = new Map<string, MedicineLog>();
    ownLogsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    sharedLogsByGroupValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    sharedLogsByFriendValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  }, [ownLogsValue, sharedLogsByGroupValue, sharedLogsByFriendValue]);
  const logsById = useMemo(() => new Map(allLogs.map((l) => [l.id, l])), [allLogs]);

  const shareSettingsDocRef = user ? doc(db, 'medicineShareSettings', user.uid) : null;
  const delegateSettingsDocRef = user ? doc(db, 'medicineDelegateSettings', user.uid) : null;
  const [shareSettingsSnap] = useDocument(shareSettingsDocRef);
  const shareSettings: MedicineShareSettings = (shareSettingsSnap?.data()?.medicine as any) || DEFAULT_MEDICINE_SHARE_SETTINGS;
  const [delegateSettingsSnap] = useDocument(delegateSettingsDocRef);
  const delegateSettings: MedicineDelegateSettings = (delegateSettingsSnap?.data()?.medicine as any) || DEFAULT_MEDICINE_DELEGATE_SETTINGS;

  // --- Settings menu (Sharing / Delegates — no Target Range or standalone Reminders here; see
  // medicines.ts's top-of-file comment for why reminders live on each medicine instead) ---
  const [settingsPanel, setSettingsPanel] = useState<'menu' | 'sharing' | 'delegates' | null>(null);
  const [shareForm, setShareForm] = useState<MedicineShareSettings>(shareSettings);
  const [delegateForm, setDelegateForm] = useState<MedicineDelegateSettings>(delegateSettings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [friendSearchQuery, setFriendSearchQuery] = useState('');

  const openSettingsMenu = () => {
    setShareForm(shareSettings);
    setDelegateForm(delegateSettings);
    setFriendSearchQuery('');
    setSettingsPanel('menu');
  };

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

  const handleSaveSharing = async () => {
    if (!user || !shareSettingsDocRef) return;
    setSavingSettings(true);
    try {
      await setDoc(shareSettingsDocRef, { userId: user.uid, medicine: shareForm, updatedAt: new Date().toISOString() });

      const nextGroupIdFor = (dateStr: string) => (isMedicineShareActiveForDate(shareForm, dateStr) ? shareForm.groupId : null);
      const nextFriendUidsFor = (dateStr: string) => (isMedicineShareActiveForDate(shareForm, dateStr) ? shareForm.friendUids : []);
      const sameFriendUids = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((u) => b.includes(u));

      const myMedicines = medicines.filter((m) => m.userId === user.uid);
      const myLogs = allLogs.filter((l) => l.userId === user.uid);
      const medBatches = chunk(
        myMedicines.filter((m) => nextGroupIdFor(m.startDate) !== m.groupId || !sameFriendUids(nextFriendUidsFor(m.startDate), m.sharedFriendUids)),
        400,
      );
      for (const group of medBatches) {
        const batch = writeBatch(db);
        group.forEach((m) => batch.update(doc(db, 'medicines', m.id), { groupId: nextGroupIdFor(m.startDate), sharedFriendUids: nextFriendUidsFor(m.startDate) }));
        await batch.commit();
      }
      const logBatches = chunk(
        myLogs.filter((l) => nextGroupIdFor(l.dateStr) !== l.groupId || !sameFriendUids(nextFriendUidsFor(l.dateStr), l.sharedFriendUids)),
        400,
      );
      for (const group of logBatches) {
        const batch = writeBatch(db);
        group.forEach((l) => batch.update(doc(db, 'medicineLogs', l.id), { groupId: nextGroupIdFor(l.dateStr), sharedFriendUids: nextFriendUidsFor(l.dateStr) }));
        await batch.commit();
      }

      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save medicine sharing settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveDelegates = async () => {
    if (!user || !delegateSettingsDocRef) return;
    setSavingSettings(true);
    try {
      await setDoc(delegateSettingsDocRef, { userId: user.uid, medicine: delegateForm, updatedAt: new Date().toISOString() });
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save medicine delegate settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  // Reminders live on each medicine itself — reconcile native notifications whenever the
  // caller's OWN active medicine list changes (add/edit/pause/delete/duration elapses).
  const myActiveMedicines = useMemo(() => medicines.filter((m) => m.userId === user?.uid), [medicines, user]);
  useEffect(() => {
    scheduleMedicineReminders(myActiveMedicines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(myActiveMedicines.map((m) => [m.id, m.active, m.remindersEnabled, m.times, m.weekdays, m.startDate, m.durationMode, m.endDate, m.dayCount]))]);

  // --- "Managing for" — who Medicines/Log tabs act on behalf of (me, or someone who's granted
  // delegate access) — distinct from Dashboard's "viewing" picker below, which is read-only and
  // covers anyone who's *shared* with me (a broader, non-delegate set). ---
  const [manageUid, setManageUid] = useState<string>('me');
  const manageTargetUid = manageUid === 'me' ? user?.uid || '' : manageUid;

  // --- Medicines tab ---
  const [medForm, setMedForm] = useState(false); // whether the add/edit floating form is open
  const [editingMedicine, setEditingMedicine] = useState<Medicine | null>(null);
  const [formName, setFormName] = useState('');
  const [formDosage, setFormDosage] = useState('');
  const [formTimes, setFormTimes] = useState<MedicineDoseTime[]>([{ id: newDoseTimeId(), label: 'Morning', time: '08:00', foodTiming: 'after' }]);
  const [formWeekdays, setFormWeekdays] = useState<number[]>([]);
  const [formStartDate, setFormStartDate] = useState(todayLocalDateString());
  const [formDurationMode, setFormDurationMode] = useState<'ongoing' | 'endDate' | 'dayCount'>('ongoing');
  const [formEndDate, setFormEndDate] = useState('');
  const [formDayCount, setFormDayCount] = useState('30');
  const [formReminders, setFormReminders] = useState(true);
  const [formNotes, setFormNotes] = useState('');
  const [savingMed, setSavingMed] = useState(false);

  const openAddMedicine = () => {
    setEditingMedicine(null);
    setFormName('');
    setFormDosage('');
    setFormTimes([{ id: newDoseTimeId(), label: 'Morning', time: '08:00', foodTiming: 'after' }]);
    setFormWeekdays([]);
    setFormStartDate(todayLocalDateString());
    setFormDurationMode('ongoing');
    setFormEndDate('');
    setFormDayCount('30');
    setFormReminders(true);
    setFormNotes('');
    setMedForm(true);
  };
  const openEditMedicine = (med: Medicine) => {
    setEditingMedicine(med);
    setFormName(med.name);
    setFormDosage(med.dosage);
    setFormTimes(med.times.length > 0 ? med.times : [{ id: newDoseTimeId(), label: 'Morning', time: '08:00', foodTiming: 'after' }]);
    setFormWeekdays(med.weekdays);
    setFormStartDate(med.startDate);
    setFormDurationMode(med.durationMode);
    setFormEndDate(med.endDate || '');
    setFormDayCount(med.dayCount ? String(med.dayCount) : '30');
    setFormReminders(med.remindersEnabled);
    setFormNotes(med.notes || '');
    setManageUid(med.userId === user?.uid ? 'me' : med.userId);
    setMedForm(true);
  };

  const handleSaveMedicine = async () => {
    if (!user || !formName.trim() || formTimes.length === 0) return;
    setSavingMed(true);
    try {
      const targetUid = manageTargetUid || user.uid;
      const effectiveShareSettings: MedicineShareSettings =
        targetUid === user.uid ? shareSettings : ((await getDoc(doc(db, 'medicineShareSettings', targetUid))).data()?.medicine as any) || DEFAULT_MEDICINE_SHARE_SETTINGS;
      const shouldShare = isMedicineShareActiveForDate(effectiveShareSettings, formStartDate);

      const fields = {
        name: formName.trim(),
        dosage: formDosage.trim(),
        times: formTimes,
        weekdays: formWeekdays,
        startDate: formStartDate,
        durationMode: formDurationMode,
        endDate: formDurationMode === 'endDate' ? formEndDate || null : null,
        dayCount: formDurationMode === 'dayCount' ? parseInt(formDayCount, 10) || null : null,
        remindersEnabled: formReminders,
        notes: formNotes.trim() || null,
        groupId: shouldShare ? effectiveShareSettings.groupId : null,
        sharedFriendUids: shouldShare ? effectiveShareSettings.friendUids : [],
      };

      if (editingMedicine) {
        fireWrite(updateDoc(doc(db, 'medicines', editingMedicine.id), { userId: targetUid, loggedBy: user.uid, ...fields }), 'update medicine');
      } else {
        fireWrite(
          setDoc(doc(collection(db, 'medicines')), { userId: targetUid, loggedBy: user.uid, active: true, createdAt: new Date().toISOString(), ...fields }),
          'add medicine',
        );
      }
      setMedForm(false);
      setEditingMedicine(null);
    } finally {
      setSavingMed(false);
    }
  };

  const handleTogglePause = (med: Medicine) => {
    fireWrite(updateDoc(doc(db, 'medicines', med.id), { active: !med.active }), 'toggle medicine pause');
  };
  const handleDeleteMedicine = (med: Medicine) => {
    if (!window.confirm(t('medicine.confirmDeleteMedicine'))) return;
    fireWrite(deleteDoc(doc(db, 'medicines', med.id)), 'delete medicine');
  };

  const manageMedicines = useMemo(
    () =>
      medicines
        .filter((m) => m.userId === manageTargetUid)
        .sort((a, b) => {
          const rank = (m: Medicine) => (medicineStatusLabel(m, todayLocalDateString()) === 'active' ? 0 : medicineStatusLabel(m, todayLocalDateString()) === 'upcoming' ? 1 : medicineStatusLabel(m, todayLocalDateString()) === 'paused' ? 2 : 3);
          return rank(a) - rank(b) || a.name.localeCompare(b.name);
        }),
    [medicines, manageTargetUid],
  );

  const foodTimingLabel = (ft: FoodTiming) => t(`medicine.foodTiming.${ft}`);
  const doseTimeSummary = (med: Medicine) =>
    med.times
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((slot) => `${slot.label ? `${slot.label} ` : ''}${slot.time} (${foodTimingLabel(slot.foodTiming)})`)
      .join(' · ');
  const durationSummary = (med: Medicine) => {
    if (med.durationMode === 'ongoing') return t('medicine.startedOn', { date: med.startDate });
    const end = medicineEndDateStr(med);
    return end ? t('medicine.endsOn', { date: end }) : t('medicine.startedOn', { date: med.startDate });
  };

  // --- Log tab ---
  const [logDate, setLogDate] = useState(todayLocalDateString());
  const dueToday = useMemo(
    () =>
      manageMedicines
        .filter((m) => isMedicineDueOn(m, logDate))
        .flatMap((m) => m.times.map((slot) => ({ medicine: m, doseTime: slot }))),
    [manageMedicines, logDate],
  );
  const dueTodayIds = useMemo(
    () => dueToday.map(({ medicine, doseTime }) => medicineLogId(manageTargetUid, medicine.id, doseTime.id, logDate)),
    [dueToday, manageTargetUid, logDate],
  );
  const [dueLogsValue] = useCollection(
    dueTodayIds.length > 0 ? query(collection(db, 'medicineLogs'), where(documentId(), 'in', dueTodayIds.slice(0, 30))) : null,
  );
  const dueLogsById = useMemo(() => {
    const map = new Map<string, MedicineLog>();
    dueLogsValue?.docs.forEach((d) => map.set(d.id, { id: d.id, ...(d.data() as any) } as MedicineLog));
    return map;
  }, [dueLogsValue]);

  const handleMarkDose = async (medicine: Medicine, doseTime: MedicineDoseTime, status: MedicineLogStatus) => {
    if (!user) return;
    const targetUid = manageTargetUid || user.uid;
    const id = medicineLogId(targetUid, medicine.id, doseTime.id, logDate);
    const loggedAt = new Date().toISOString();
    fireWrite(
      setDoc(doc(db, 'medicineLogs', id), {
        userId: targetUid,
        loggedBy: user.uid,
        groupId: medicine.groupId,
        sharedFriendUids: medicine.sharedFriendUids,
        medicineId: medicine.id,
        medicineName: medicine.name,
        doseTimeId: doseTime.id,
        doseLabel: doseTime.label,
        scheduledTime: doseTime.time,
        status,
        dateStr: logDate,
        loggedAt,
        notes: null,
        createdAt: loggedAt,
      }),
      'mark medicine dose',
    );
    if (status === 'taken') {
      const actorName = profile?.displayName || user.displayName || undefined;
      const contextLabel = `${medicine.name} — ${doseTime.label}`;
      if (medicine.groupId) {
        notifyGroupActivity({ groupId: medicine.groupId, action: 'medicine_logged', contextLabel, actorName });
      }
      if (medicine.sharedFriendUids.length > 0) {
        auth.currentUser
          ?.getIdToken()
          .then((idToken) =>
            fetch('/api/health/notify-glucose-shared', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ friendUids: medicine.sharedFriendUids, kind: 'medicine', readingLabel: doseTime.label, contextLabel: medicine.name, actorName }),
            }),
          )
          .catch((err) => console.error('notify-medicine-shared failed:', err));
      }
    }
  };
  const handleUndoDose = (medicine: Medicine, doseTime: MedicineDoseTime) => {
    const id = medicineLogId(manageTargetUid, medicine.id, doseTime.id, logDate);
    fireWrite(deleteDoc(doc(db, 'medicineLogs', id)), 'undo medicine dose');
  };

  // --- Dashboard tab ---
  const [viewUid, setViewUid] = useState<string>('me');
  const viewTargetUid = viewUid === 'me' ? user?.uid || '' : viewUid;
  const [datePreset, setDatePreset] = useState<DatePreset>('7d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [filterMedicineId, setFilterMedicineId] = useState('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'taken' | 'skipped' | 'missed'>('all');
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);

  const shareableMembers = useMemo(() => {
    const uids = Array.from(new Set(medicines.filter((m) => m.userId !== user?.uid).map((m) => m.userId)));
    return uids.map(resolveSharer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medicines, allMembers, friendUsersByUid, user]);

  const viewMedicines = useMemo(() => medicines.filter((m) => m.userId === viewTargetUid), [medicines, viewTargetUid]);
  const { start: rangeStart, end: rangeEnd } = presetBounds(datePreset, customStart, customEnd);
  const today = todayLocalDateString();

  const dueInstances: DueInstance[] = useMemo(() => {
    if (viewMedicines.length === 0) return [];
    const earliestStart = viewMedicines.reduce((min, m) => (m.startDate < min ? m.startDate : min), viewMedicines[0].startDate);
    let start = rangeStart || earliestStart;
    let end = rangeEnd || today;
    if (end > today) end = today;
    // 'YYYY-MM-DD' parses as UTC midnight via `new Date(str)`, which can land on the wrong local
    // calendar day in negative-UTC-offset zones — parse with the local-time constructor instead,
    // same fix medicines.ts's medicineEndDateStr() already applies.
    const parseLocalDate = (s: string) => {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    // Bound the scan to 180 days for performance — a personal medicine history rarely needs more.
    const startD = parseLocalDate(start);
    const endD = parseLocalDate(end);
    const maxSpanMs = 180 * 24 * 60 * 60 * 1000;
    if (endD.getTime() - startD.getTime() > maxSpanMs) start = toLocalDateString(new Date(endD.getTime() - maxSpanMs));

    const out: DueInstance[] = [];
    for (let d = parseLocalDate(start); toLocalDateString(d) <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = toLocalDateString(d);
      viewMedicines.forEach((med) => {
        if (filterMedicineId !== 'all' && med.id !== filterMedicineId) return;
        if (!isMedicineDueOn(med, dateStr)) return;
        med.times.forEach((slot) => {
          const id = medicineLogId(viewTargetUid, med.id, slot.id, dateStr);
          const log = logsById.get(id) || null;
          const status: DueInstance['status'] = log ? log.status : dateStr < today ? 'missed' : 'pending';
          out.push({ dateStr, medicine: med, doseTime: slot, log, status });
        });
      });
    }
    return out.sort((a, b) => (b.dateStr + b.doseTime.time).localeCompare(a.dateStr + a.doseTime.time));
  }, [viewMedicines, rangeStart, rangeEnd, today, filterMedicineId, viewTargetUid, logsById]);

  const filteredInstances = useMemo(
    () => dueInstances.filter((i) => filterStatus === 'all' || i.status === filterStatus),
    [dueInstances, filterStatus],
  );

  const resolvedInstances = filteredInstances.filter((i) => i.status !== 'pending');
  const takenCount = resolvedInstances.filter((i) => i.status === 'taken').length;
  const adherenceRate = resolvedInstances.length > 0 ? Math.round((takenCount / resolvedInstances.length) * 100) : 0;

  const clearDashboardFilters = () => {
    setDatePreset('7d');
    setCustomStart('');
    setCustomEnd('');
    setFilterMedicineId('all');
    setFilterStatus('all');
  };

  const viewingName =
    viewUid === 'me' ? profile?.displayName || user?.displayName || t('health.myReport') : shareableMembers.find((m: any) => m.userId === viewUid)?.displayName || t('common.someone');

  const trend = useMemo(() => {
    const byDate = new Map<string, { taken: number; resolved: number }>();
    dueInstances.forEach((i) => {
      if (i.status === 'pending') return;
      const bucket = byDate.get(i.dateStr) || { taken: 0, resolved: 0 };
      bucket.resolved += 1;
      if (i.status === 'taken') bucket.taken += 1;
      byDate.set(i.dateStr, bucket);
    });
    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-20)
      .map(([dateStr, v]) => ({
        date: new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        adherence: Math.round((v.taken / v.resolved) * 100),
      }));
  }, [dueInstances]);

  const handleClearHistory = () => {
    const logged = filteredInstances.filter((i) => i.log);
    if (logged.length === 0) return;
    if (!window.confirm(t('medicine.confirmClearHistory'))) return;
    logged.forEach((i) => fireWrite(deleteDoc(doc(db, 'medicineLogs', i.log!.id)), 'clear medicine log'));
  };

  const [exportingPdf, setExportingPdf] = useState(false);
  const chartRef = React.useRef<HTMLDivElement | null>(null);

  const handleExportPdf = async () => {
    if (filteredInstances.length === 0) {
      alert(t('health.noDataToExport'));
      return;
    }
    setExportingPdf(true);
    try {
      const [{ default: jsPDF }, autoTableModule, html2canvasModule] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('html2canvas-pro'),
      ]);
      const autoTable = autoTableModule.default;
      const html2canvas = html2canvasModule.default;
      const docPdf = new jsPDF();
      const brandColor: [number, number, number] = [15, 71, 97];
      const webUrl = 'https://familyledger-backend-192700919713.us-central1.run.app';
      const androidUrl = 'https://play.google.com/store/apps/details?id=com.familyledger.app';

      const pageWidth = docPdf.internal.pageSize.getWidth();
      docPdf.setFontSize(13);
      docPdf.setTextColor(...brandColor);
      docPdf.setFont('helvetica', 'bold');
      docPdf.text('FamilyLedger', pageWidth - 14, 14, { align: 'right' });
      docPdf.setFont('helvetica', 'normal');

      const badgeLabel = 'Get it on Google Play';
      const badgeY = 19;
      docPdf.setFontSize(8);
      const badgeTextWidth = docPdf.getTextWidth(badgeLabel);
      const iconSize = 3;
      const iconGap = 1.5;
      const badgeWidth = iconSize + iconGap + badgeTextWidth;
      const badgeStartX = pageWidth - 14 - badgeWidth;
      docPdf.setFillColor(...brandColor);
      docPdf.triangle(badgeStartX, badgeY - iconSize / 2, badgeStartX, badgeY + iconSize / 2, badgeStartX + iconSize, badgeY, 'F');
      docPdf.text(badgeLabel, badgeStartX + iconSize + iconGap, badgeY + 1.3);
      docPdf.link(badgeStartX - 1, badgeY - 3, badgeWidth + 2, 6, { url: androidUrl });

      docPdf.setFontSize(16);
      docPdf.setTextColor(0);
      docPdf.text('Medicine Adherence Report', 14, 18);
      docPdf.setFontSize(9);
      docPdf.setTextColor(120);
      const rangeLabel = rangeStart || rangeEnd ? `${rangeStart || 'earliest'} to ${rangeEnd || 'latest'}` : 'All time';
      docPdf.text(`Patient: ${viewingName}`, 14, 24);
      docPdf.text(`Generated via FamilyLedger Health Monitoring — ${new Date().toLocaleString()} — Period: ${rangeLabel}`, 14, 29);
      docPdf.setTextColor(0);
      docPdf.setFontSize(10);
      docPdf.text(`Adherence: ${adherenceRate}%     Doses logged: ${resolvedInstances.length}     Active medicines: ${viewMedicines.filter((m) => medicineStatusLabel(m, today) === 'active').length}`, 14, 37);

      autoTable(docPdf, {
        startY: 44,
        head: [['Date', 'Medicine', 'Dose', 'Time', 'Food Timing', 'Status']],
        body: filteredInstances.map((i) => [
          i.dateStr,
          i.medicine.name,
          i.doseTime.label,
          i.doseTime.time,
          foodTimingLabel(i.doseTime.foodTiming),
          i.status.charAt(0).toUpperCase() + i.status.slice(1),
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [15, 71, 97] },
      });

      const finalY = (docPdf as any).lastAutoTable?.finalY || 44;
      const medList = viewMedicines
        .map((m) => `${m.name}${m.dosage ? ` (${m.dosage})` : ''} — ${doseTimeSummary(m)} — ${medicineStatusLabel(m, today)}`)
        .join('\n');
      if (medList) {
        docPdf.setFontSize(9);
        docPdf.text('Medicines:', 14, finalY + 10);
        docPdf.text(docPdf.splitTextToSize(medList, 180), 14, finalY + 15);
      }

      if (trend.length >= 2 && chartRef.current) {
        docPdf.addPage();
        docPdf.setFontSize(13);
        docPdf.setTextColor(0);
        docPdf.text('Adherence Trend', 14, 18);
        const canvas = await html2canvas(chartRef.current, { scale: 1.5, backgroundColor: '#ffffff' });
        const imgData = canvas.toDataURL('image/png');
        const imgWidth = 180;
        const imgHeight = (canvas.height / canvas.width) * imgWidth;
        docPdf.addImage(imgData, 'PNG', 14, 26, imgWidth, imgHeight);
      }

      const totalPages = docPdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        docPdf.setPage(i);
        docPdf.setFontSize(7);
        docPdf.setTextColor(150);
        docPdf.text(`${viewingName} · FamilyLedger — Web: ${webUrl}  ·  Android: ${androidUrl}`, 14, 291);
      }

      const pdfBlob = docPdf.output('blob') as Blob;
      const safeName = viewingName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
      await shareOrDownloadFile(pdfBlob, `medicine_adherence_${safeName}_${todayLocalDateString()}.pdf`, 'application/pdf');
    } catch (err) {
      console.error('Medicine PDF export failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      alert(`${t('health.exportFailed')}\n\n${detail}`);
    } finally {
      setExportingPdf(false);
    }
  };

  const statusBadge = (status: DueInstance['status']) => {
    if (status === 'taken') return { cls: 'text-success', text: t('medicine.doseStatusTaken'), icon: '✅' };
    if (status === 'skipped') return { cls: 'text-warning', text: t('medicine.doseStatusSkipped'), icon: '⏭️' };
    if (status === 'missed') return { cls: 'text-error', text: t('medicine.doseStatusMissed'), icon: '⚠️' };
    return { cls: 'text-text-muted', text: t('medicine.doseStatusPending'), icon: '⏳' };
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-3 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-primary leading-tight">{t('medicine.tracker')}</h1>
            <p className="text-[11px] text-text-muted leading-tight">{t('medicine.trackerDesc')}</p>
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

        <div className="flex bg-white rounded-xl border border-border-subtle p-1 gap-1">
          <button type="button" onClick={() => setTab('medicines')} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', tab === 'medicines' ? 'bg-primary text-white' : 'text-text-muted')}>
            {t('medicine.medicinesTab')}
          </button>
          <button type="button" onClick={() => setTab('log')} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', tab === 'log' ? 'bg-primary text-white' : 'text-text-muted')}>
            {t('medicine.logTab')}
          </button>
          <button type="button" onClick={() => setTab('dashboard')} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', tab === 'dashboard' ? 'bg-primary text-white' : 'text-text-muted')}>
            {t('health.dashboard')}
          </button>
        </div>

        {(tab === 'medicines' || tab === 'log') && delegatorsForMe.length > 0 && (
          <div className="space-y-1">
            <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('medicine.managingFor')}</label>
            <select
              value={manageUid}
              onChange={(e) => setManageUid(e.target.value)}
              className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
            >
              <option value="me">{t('health.myself')}</option>
              {delegatorsForMe.map((d) => (
                <option key={d.userId} value={d.userId}>{d.displayName}</option>
              ))}
            </select>
          </div>
        )}

        {tab === 'medicines' && (
          <div className="space-y-3">
            <button type="button" onClick={openAddMedicine} className="w-full py-2.5 bg-primary text-white font-bold rounded-xl flex items-center justify-center gap-1.5">
              <span className="material-symbols-outlined text-[18px]">add</span>
              {t('medicine.addMedicine')}
            </button>

            {manageMedicines.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-8">{t('medicine.noMedicinesYet')}</p>
            ) : (
              <div className="space-y-2">
                {manageMedicines.map((med) => {
                  const status = medicineStatusLabel(med, today);
                  const canManage = med.userId === user?.uid || med.loggedBy === user?.uid;
                  return (
                    <div key={med.id} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold text-primary text-sm truncate">{med.name}{med.dosage ? <span className="text-text-muted font-semibold"> · {med.dosage}</span> : null}</p>
                          <p className="text-[11px] text-text-muted mt-0.5">{doseTimeSummary(med)}</p>
                          <p className="text-[10px] text-text-muted mt-0.5">{durationSummary(med)}</p>
                        </div>
                        <span
                          className={clsx(
                            'shrink-0 text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded-full',
                            status === 'active' && 'bg-success/10 text-success',
                            status === 'paused' && 'bg-surface-container text-text-muted',
                            status === 'ended' && 'bg-error/10 text-error',
                            status === 'upcoming' && 'bg-primary/10 text-primary',
                          )}
                        >
                          {t(`medicine.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
                        </span>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-1 pt-1 border-t border-border-subtle">
                          <button type="button" onClick={() => openEditMedicine(med)} className="flex-1 py-1.5 text-[11px] font-bold text-primary flex items-center justify-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">edit</span>{t('common.edit')}
                          </button>
                          <button type="button" onClick={() => handleTogglePause(med)} className="flex-1 py-1.5 text-[11px] font-bold text-text-muted flex items-center justify-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">{med.active ? 'pause' : 'play_arrow'}</span>
                            {med.active ? t('medicine.pause') : t('medicine.resume')}
                          </button>
                          <button type="button" onClick={() => handleDeleteMedicine(med)} className="flex-1 py-1.5 text-[11px] font-bold text-error flex items-center justify-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">delete</span>{t('common.delete')}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'log' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('medicine.forDate')}</label>
              <input
                type="date"
                value={logDate}
                max={todayLocalDateString()}
                onChange={(e) => setLogDate(e.target.value)}
                className="w-full bg-white p-2.5 rounded-xl border border-border-subtle text-sm font-bold text-primary outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {dueToday.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-8">{t('medicine.noDosesDue')}</p>
            ) : (
              <div className="space-y-2">
                {dueToday
                  .slice()
                  .sort((a, b) => a.doseTime.time.localeCompare(b.doseTime.time))
                  .map(({ medicine, doseTime }) => {
                    const id = medicineLogId(manageTargetUid, medicine.id, doseTime.id, logDate);
                    const log = dueLogsById.get(id);
                    return (
                      <div key={id} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-bold text-primary text-sm truncate">{medicine.name}{medicine.dosage ? <span className="text-text-muted font-semibold"> · {medicine.dosage}</span> : null}</p>
                            <p className="text-[11px] text-text-muted">{doseTime.label} · {doseTime.time} · {foodTimingLabel(doseTime.foodTiming)}</p>
                          </div>
                          {log ? (
                            <span className={clsx('shrink-0 text-[10px] font-bold flex items-center gap-1', log.status === 'taken' ? 'text-success' : 'text-warning')}>
                              {log.status === 'taken' ? '✅' : '⏭️'} {log.status === 'taken' ? t('medicine.doseStatusTaken') : t('medicine.doseStatusSkipped')}
                            </span>
                          ) : (
                            <span className="shrink-0 text-[10px] font-bold text-text-muted">{t('medicine.doseStatusPending')}</span>
                          )}
                        </div>
                        {log ? (
                          <button type="button" onClick={() => handleUndoDose(medicine, doseTime)} className="w-full py-1.5 text-[11px] font-bold text-text-muted border border-border-subtle rounded-lg">
                            {t('medicine.undo')}
                          </button>
                        ) : (
                          <div className="flex gap-1.5">
                            <button type="button" onClick={() => handleMarkDose(medicine, doseTime, 'taken')} className="flex-1 py-1.5 bg-success/10 text-success text-[11px] font-bold rounded-lg">
                              {t('medicine.markTaken')}
                            </button>
                            <button type="button" onClick={() => handleMarkDose(medicine, doseTime, 'skipped')} className="flex-1 py-1.5 bg-surface text-text-muted text-[11px] font-bold rounded-lg border border-border-subtle">
                              {t('medicine.markSkipped')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {tab === 'dashboard' && (
          <div className="space-y-6">
            {shareableMembers.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('health.viewingReportFor')}</label>
                <select value={viewUid} onChange={(e) => setViewUid(e.target.value)} className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none shadow-sm">
                  <option value="me">{t('health.myReport')}</option>
                  {shareableMembers.map((m: any) => (
                    <option key={m.userId} value={m.userId}>{m.displayName}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('health.filters')}</span>
                <button type="button" onClick={clearDashboardFilters} className="text-[10px] font-bold text-primary">{t('health.clearFilters')}</button>
              </div>
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setDatePreset(p)}
                    className={clsx('shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold border transition-all', datePreset === p ? 'bg-primary text-white border-primary' : 'bg-surface text-text-muted border-border-subtle')}
                  >
                    {t(`health.datePreset.${p}`)}
                  </button>
                ))}
              </div>
              {datePreset === 'custom' && (
                <div className="flex items-center gap-2">
                  <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-1.5 text-xs font-bold text-primary outline-none" />
                  <span className="text-[10px] font-bold text-text-muted uppercase shrink-0">{t('common.to')}</span>
                  <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-1.5 text-xs font-bold text-primary outline-none" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                <select value={filterMedicineId} onChange={(e) => setFilterMedicineId(e.target.value)} className="w-full bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none">
                  <option value="all">{t('medicine.allMedicines')}</option>
                  {viewMedicines.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)} className="w-full bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none">
                  <option value="all">{t('medicine.allStatuses')}</option>
                  <option value="taken">{t('medicine.doseStatusTaken')}</option>
                  <option value="skipped">{t('medicine.doseStatusSkipped')}</option>
                  <option value="missed">{t('medicine.doseStatusMissed')}</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('medicine.adherenceRate')}</p>
                <p className="text-2xl font-black text-primary mt-1">{resolvedInstances.length > 0 ? `${adherenceRate}%` : '—'}</p>
              </div>
              <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('medicine.totalDoses')}</p>
                <p className="text-2xl font-black text-primary mt-1">{resolvedInstances.length} <span className="text-xs font-bold text-text-muted">{t('health.records')}</span></p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleExportPdf}
              disabled={exportingPdf || filteredInstances.length === 0}
              className="w-full py-3 bg-primary/5 border border-primary/20 text-primary font-bold rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">picture_as_pdf</span>
              {exportingPdf ? t('health.generatingPdf') : viewUid === 'me' ? t('medicine.exportPdfTitle') : t('health.downloadReportFor', { name: viewingName })}
            </button>

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4 space-y-3">
              <button type="button" onClick={() => setChartCollapsed((c) => !c)} className="w-full flex items-center justify-between text-left">
                <div>
                  <h3 className="font-bold text-primary text-sm">{t('medicine.adherenceTrend')}</h3>
                  <p className="text-[11px] text-text-muted">{t('medicine.adherenceTrendDesc')}</p>
                </div>
                <span className={clsx('material-symbols-outlined text-text-muted transition-transform shrink-0', chartCollapsed && '-rotate-90')}>expand_more</span>
              </button>
              <motion.div initial={false} animate={{ height: chartCollapsed ? 0 : 'auto', opacity: chartCollapsed ? 0 : 1 }} transition={{ duration: 0.2, ease: 'easeInOut' }} className="overflow-hidden">
                <div ref={chartRef} className="bg-surface rounded-xl border border-border-subtle p-3">
                  {trend.length >= 2 ? (
                    <div className="h-52">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={trend} margin={{ top: 16, right: 12, left: 12, bottom: 0 }}>
                          <XAxis dataKey="date" fontSize={9} tick={{ fill: '#9CA3AF' }} axisLine={false} tickLine={false} padding={{ left: 12, right: 12 }} />
                          <YAxis hide width={0} domain={[0, 100]} />
                          <Tooltip formatter={(v: number) => [`${v}%`, t('medicine.adherenceRate')]} labelStyle={{ fontSize: 11 }} />
                          <Line type="monotone" dataKey="adherence" stroke="#0f4761" strokeWidth={2} dot={{ r: 2 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-[11px] text-text-muted italic py-3 text-center">{t('medicine.needTrendData')}</p>
                  )}
                </div>
              </motion.div>
            </div>

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <button type="button" onClick={() => setTableCollapsed((c) => !c)} className="flex items-center gap-1.5 text-left min-w-0">
                  <span className={clsx('material-symbols-outlined text-text-muted transition-transform text-[18px] shrink-0', tableCollapsed && '-rotate-90')}>expand_more</span>
                  <h3 className="font-bold text-primary text-sm truncate">{t('medicine.doseLog')}</h3>
                </button>
                {viewUid === 'me' && filteredInstances.some((i) => i.log) && (
                  <button type="button" onClick={handleClearHistory} className="text-[11px] font-bold text-error shrink-0">{t('health.clearHistory')}</button>
                )}
              </div>
              {!tableCollapsed &&
                (filteredInstances.length === 0 ? (
                  <p className="text-sm text-text-muted text-center py-8">{t('medicine.noDosesDue')}</p>
                ) : (
                  <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto">
                    {filteredInstances.map((i) => {
                      const badge = statusBadge(i.status);
                      const canDelete = i.log && (i.medicine.userId === user?.uid || i.medicine.loggedBy === user?.uid);
                      return (
                        <div key={`${i.dateStr}_${i.medicine.id}_${i.doseTime.id}`} className="px-4 py-3 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-primary truncate">{i.medicine.name}</p>
                            <p className="text-[10px] text-text-muted">{i.dateStr} · {i.doseTime.label} {i.doseTime.time}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={clsx('text-[10px] font-bold', badge.cls)}>{badge.icon} {badge.text}</span>
                            {canDelete && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (!window.confirm(t('medicine.confirmUndoDose'))) return;
                                  fireWrite(deleteDoc(doc(db, 'medicineLogs', i.log!.id)), 'delete medicine log');
                                }}
                                className="p-1 text-text-muted hover:text-error transition-colors"
                              >
                                <span className="material-symbols-outlined text-[16px]">delete</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </div>
          </div>
        )}
      </main>

      {medForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setMedForm(false)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-primary flex-1">{editingMedicine ? t('medicine.editMedicine') : t('medicine.addMedicine')}</h2>
              <button type="button" onClick={() => setMedForm(false)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.name')}</label>
              <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={t('medicine.namePlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.dosage')}</label>
              <input type="text" value={formDosage} onChange={(e) => setFormDosage(e.target.value)} placeholder={t('medicine.dosagePlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.doseTimes')}</label>
              {formTimes.map((slot) => (
                <div key={slot.id} className="flex items-center gap-1.5 bg-surface rounded-lg p-2 border border-border-subtle">
                  <input
                    type="text"
                    value={slot.label}
                    onChange={(e) => setFormTimes((ts) => ts.map((s) => (s.id === slot.id ? { ...s, label: e.target.value } : s)))}
                    placeholder={t('medicine.doseLabelPlaceholder')}
                    className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                  />
                  <input
                    type="time"
                    value={slot.time}
                    onChange={(e) => setFormTimes((ts) => ts.map((s) => (s.id === slot.id ? { ...s, time: e.target.value } : s)))}
                    className="w-24 shrink-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                  />
                  <select
                    value={slot.foodTiming}
                    onChange={(e) => setFormTimes((ts) => ts.map((s) => (s.id === slot.id ? { ...s, foodTiming: e.target.value as FoodTiming } : s)))}
                    className="w-28 shrink-0 bg-white border border-border-subtle rounded-md px-1.5 py-1 text-[11px] font-bold text-primary outline-none"
                  >
                    {FOOD_TIMING_OPTIONS.map((ft) => (
                      <option key={ft} value={ft}>{foodTimingLabel(ft)}</option>
                    ))}
                  </select>
                  {formTimes.length > 1 && (
                    <button type="button" onClick={() => setFormTimes((ts) => ts.filter((s) => s.id !== slot.id))} className="shrink-0 p-1 text-text-muted hover:text-error transition-colors">
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setFormTimes((ts) => [...ts, { id: newDoseTimeId(), label: '', time: '12:00', foodTiming: 'any' }])}
                className="w-full py-2 rounded-lg text-xs font-bold text-primary border border-dashed border-primary/30 hover:bg-primary/5 transition-colors"
              >
                + {t('medicine.addDoseTime')}
              </button>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('medicine.repeatsOn')}</label>
              <div className="flex gap-1">
                {WEEKDAY_LABELS.map((label, idx) => {
                  const selected = formWeekdays.length === 0 || formWeekdays.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() =>
                        setFormWeekdays((prev) => {
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
              <p className="text-[10px] text-text-muted px-1">{formWeekdays.length === 0 || formWeekdays.length === 7 ? t('medicine.everyDay') : ''}</p>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.startDate')}</label>
              <input type="date" value={formStartDate} onChange={(e) => setFormStartDate(e.target.value)} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('medicine.duration')}</label>
              <div className="flex gap-1.5">
                {(['ongoing', 'endDate', 'dayCount'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setFormDurationMode(mode)}
                    className={clsx('flex-1 py-2 rounded-lg text-[10px] font-bold border transition-all', formDurationMode === mode ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                  >
                    {t(`medicine.duration${mode.charAt(0).toUpperCase()}${mode.slice(1)}`)}
                  </button>
                ))}
              </div>
              {formDurationMode === 'endDate' && (
                <input type="date" value={formEndDate} onChange={(e) => setFormEndDate(e.target.value)} min={formStartDate} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
              )}
              {formDurationMode === 'dayCount' && (
                <input type="number" min="1" value={formDayCount} onChange={(e) => setFormDayCount(e.target.value)} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-muted font-bold">{t('medicine.remindMe')}</span>
              <button
                type="button"
                onClick={() => setFormReminders((r) => !r)}
                className={clsx('w-10 h-6 rounded-full transition-colors relative shrink-0', formReminders ? 'bg-primary' : 'bg-surface-container')}
              >
                <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', formReminders ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </div>
            <p className="text-[10px] text-text-muted">{t('medicine.reminderNote')}</p>

            <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} placeholder={t('health.notesPlaceholder')} rows={2} className="w-full bg-white p-2 rounded-xl border border-border-subtle text-xs outline-none focus:ring-2 focus:ring-primary/20 resize-none" />

            <button type="button" onClick={handleSaveMedicine} disabled={savingMed || !formName.trim()} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {savingMed ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {settingsPanel === 'menu' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-xs rounded-2xl p-2 space-y-0.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2">
              <h2 className="text-sm font-black text-primary">{t('health.settings')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted"><span className="material-symbols-outlined text-[18px]">close</span></button>
            </div>
            {[
              { key: 'sharing' as const, icon: 'share', label: t('health.sharing') },
              { key: 'delegates' as const, icon: 'group_add', label: t('health.delegates') },
            ].map((item) => (
              <button key={item.key} type="button" onClick={() => setSettingsPanel(item.key)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-surface transition-colors text-left">
                <span className="material-symbols-outlined text-primary text-[20px]">{item.icon}</span>
                <span className="flex-1 text-sm font-bold">{item.label}</span>
                <span className="material-symbols-outlined text-text-muted text-[18px]">chevron_right</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {settingsPanel === 'sharing' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSettingsPanel('menu')} className="text-text-muted shrink-0"><span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span></button>
              <h2 className="text-base font-black text-primary flex-1">{t('health.sharing')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('health.shareWithGroup')}</label>
              <select value={shareForm.groupId || ''} onChange={(e) => setShareForm((f) => ({ ...f, groupId: e.target.value || null, mode: e.target.value ? f.mode || 'always' : f.mode }))} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none">
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
                      <button key={fam.id} type="button" onClick={() => toggleFamilyInShare(fam.id)} className={clsx('w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}>
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
                  {shareForm.friendUids.length > 0 && <span className="text-[10px] font-bold text-primary">{t('health.friendsSelectedCount', { count: shareForm.friendUids.length })}</span>}
                </div>
                <input type="text" value={friendSearchQuery} onChange={(e) => setFriendSearchQuery(e.target.value)} placeholder={t('health.searchFriends')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none" />
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
                  {filteredFriends.length === 0 ? (
                    <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
                  ) : (
                    filteredFriends.map(({ friendUid }) => {
                      const friend = friendUsersByUid.get(friendUid);
                      const selected = shareForm.friendUids.includes(friendUid);
                      return (
                        <button key={friendUid} type="button" onClick={() => toggleFriendInShare(friendUid)} className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors">
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
            {hasMedicineShareTarget(shareForm) && (
              <>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShareForm((f) => ({ ...f, mode: 'always' }))} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold border transition-all', shareForm.mode === 'always' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}>
                    {t('health.always')}
                  </button>
                  <button type="button" onClick={() => setShareForm((f) => ({ ...f, mode: 'range' }))} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold border transition-all', shareForm.mode === 'range' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}>
                    {t('health.dateRangeLabel')}
                  </button>
                </div>
                {shareForm.mode === 'range' && (
                  <div className="flex items-center gap-2">
                    <input type="date" value={shareForm.startDate || ''} onChange={(e) => setShareForm((f) => ({ ...f, startDate: e.target.value || null }))} className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-2 text-xs font-bold text-primary outline-none" />
                    <span className="text-[10px] font-bold text-text-muted uppercase shrink-0">{t('common.to')}</span>
                    <input type="date" value={shareForm.endDate || ''} onChange={(e) => setShareForm((f) => ({ ...f, endDate: e.target.value || null }))} placeholder={t('health.ongoing')} className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-2 py-2 text-xs font-bold text-primary outline-none" />
                  </div>
                )}
                <p className="text-[10px] text-text-muted">{t('health.sharingHint')}</p>
              </>
            )}

            <button type="button" onClick={handleSaveSharing} disabled={savingSettings} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {settingsPanel === 'delegates' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSettingsPanel(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSettingsPanel('menu')} className="text-text-muted shrink-0"><span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span></button>
              <h2 className="text-base font-black text-primary flex-1">{t('health.delegates')}</h2>
              <button type="button" onClick={() => setSettingsPanel(null)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>
            <p className="text-[11px] text-text-muted">{t('medicine.delegatesHint')}</p>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('health.shareWithGroup')}</label>
              <select value={delegateForm.groupId || ''} onChange={(e) => setDelegateForm((f) => ({ ...f, groupId: e.target.value || null }))} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none">
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
                      <button key={fam.id} type="button" onClick={() => toggleFamilyInDelegate(fam.id)} className={clsx('w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}>
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
                  {delegateForm.friendUids.length > 0 && <span className="text-[10px] font-bold text-primary">{t('health.friendsSelectedCount', { count: delegateForm.friendUids.length })}</span>}
                </div>
                <input type="text" value={friendSearchQuery} onChange={(e) => setFriendSearchQuery(e.target.value)} placeholder={t('health.searchFriends')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none" />
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
                  {filteredFriends.length === 0 ? (
                    <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
                  ) : (
                    filteredFriends.map(({ friendUid }) => {
                      const friend = friendUsersByUid.get(friendUid);
                      const selected = delegateForm.friendUids.includes(friendUid);
                      return (
                        <button key={friendUid} type="button" onClick={() => toggleFriendInDelegate(friendUid)} className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors">
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

            <button type="button" onClick={handleSaveDelegates} disabled={savingSettings} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
