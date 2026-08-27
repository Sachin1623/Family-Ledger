import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { db } from '../lib/firebase';
import { collection, query, where, doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { motion } from 'motion/react';
import { fireWrite } from '../lib/offlineWrite';
import { shareOrDownloadFile } from '../lib/fileShare';
import { toLocalDateString, todayLocalDateString, nowLocalTimeString, combineLocalDateAndTime } from '../lib/dateUtils';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { scheduleBpReminders } from '../lib/bpReminders';
import { useFriendships } from '../lib/useFriendships';
import { useFamilies } from '../lib/useFamilies';
import { WEEKDAY_LABELS } from '../lib/frequency';
import { auth } from '../lib/firebase';
import {
  BloodPressureLog,
  BpTarget,
  BpShareSettings,
  BpDelegateSettings,
  BpReminderSettings,
  BpReminderTime,
  DEFAULT_BP_TARGET,
  DEFAULT_BP_SHARE_SETTINGS,
  DEFAULT_BP_DELEGATE_SETTINGS,
  DEFAULT_BP_REMINDERS,
  hasBpShareTarget,
  hasBpDelegateTarget,
  isBpShareActiveForDate,
  bpRangeStatus,
} from '../lib/bloodPressure';

const DATE_PRESETS = ['all', '7d', '14d', '30d', 'custom'] as const;
type DatePreset = (typeof DATE_PRESETS)[number];

function rangeBadge(systolic: number, diastolic: number, target: BpTarget, t: (k: string) => string) {
  const status = bpRangeStatus(systolic, diastolic, target);
  if (status === 'high') return { text: t('bp.rangeHigh'), cls: 'text-error', icon: '⚠️' };
  if (status === 'low') return { text: t('bp.rangeLow'), cls: 'text-error', icon: '⚠️' };
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let nextTimeSlotId = 1;
function newTimeSlotId(): string {
  return `slot_${Date.now()}_${nextTimeSlotId++}`;
}

export default function HealthBloodPressure() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const [tab, setTab] = useState<'log' | 'dashboard'>('log');

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

  const [logsValue] = useCollection(
    user ? query(collection(db, 'bloodPressureLogs'), where('userId', '==', user.uid)) : null,
  );
  const logs: BloodPressureLog[] = useMemo(
    () => (logsValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || []) as BloodPressureLog[],
    [logsValue],
  );

  const [sharedByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'bloodPressureLogs'), where('groupId', 'in', groupIds)) : null,
  );
  const [sharedByFriendValue] = useCollection(
    user ? query(collection(db, 'bloodPressureLogs'), where('sharedFriendUids', 'array-contains', user.uid)) : null,
  );
  const sharedLogs: BloodPressureLog[] = useMemo(() => {
    const byId = new Map<string, BloodPressureLog>();
    sharedByGroupValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    sharedByFriendValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  }, [sharedByGroupValue, sharedByFriendValue]);

  const [delegatedToMeByGroupValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'bpDelegateSettings'), where('bp.groupId', 'in', groupIds)) : null,
  );
  const [delegatedToMeByFriendValue] = useCollection(
    user ? query(collection(db, 'bpDelegateSettings'), where('bp.friendUids', 'array-contains', user.uid)) : null,
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

  const target: BpTarget = profile?.bpTargets || DEFAULT_BP_TARGET;
  const [shareSettingsSnap] = useDocument(user ? doc(db, 'bpShareSettings', user.uid) : null);
  const shareSettings: BpShareSettings = (shareSettingsSnap?.data()?.bp as any) || DEFAULT_BP_SHARE_SETTINGS;
  const [delegateSettingsSnap] = useDocument(user ? doc(db, 'bpDelegateSettings', user.uid) : null);
  const delegateSettings: BpDelegateSettings = (delegateSettingsSnap?.data()?.bp as any) || DEFAULT_BP_DELEGATE_SETTINGS;
  const reminders: BpReminderSettings = profile?.bpReminders || DEFAULT_BP_REMINDERS;

  const [settingsPanel, setSettingsPanel] = useState<'menu' | 'target' | 'sharing' | 'delegates' | 'reminders' | null>(null);
  const [targetForm, setTargetForm] = useState<BpTarget>(target);
  const [shareForm, setShareForm] = useState<BpShareSettings>(shareSettings);
  const [delegateForm, setDelegateForm] = useState<BpDelegateSettings>(delegateSettings);
  const [remindersForm, setRemindersForm] = useState<BpReminderSettings>(reminders);
  const [remindersForUid, setRemindersForUid] = useState<string>('me');
  const [savingSettings, setSavingSettings] = useState(false);
  const [friendSearchQuery, setFriendSearchQuery] = useState('');

  const openSettingsMenu = () => {
    setTargetForm(target);
    setShareForm(shareSettings);
    setDelegateForm(delegateSettings);
    setRemindersForm(reminders);
    setRemindersForUid('me');
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

  const handleSaveTarget = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { bpTargets: targetForm });
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save BP target ranges:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveSharing = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      await setDoc(doc(db, 'bpShareSettings', user.uid), { userId: user.uid, bp: shareForm, updatedAt: new Date().toISOString() });

      const nextGroupIdFor = (log: BloodPressureLog) => (isBpShareActiveForDate(shareForm, log.loggedAt) ? shareForm.groupId : null);
      const nextFriendUidsFor = (log: BloodPressureLog) => (isBpShareActiveForDate(shareForm, log.loggedAt) ? shareForm.friendUids : []);
      const sameFriendUids = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((u) => b.includes(u));
      const batches = chunk(logs, 400);
      for (const group of batches) {
        const toUpdate = group.filter((log) => nextGroupIdFor(log) !== log.groupId || !sameFriendUids(nextFriendUidsFor(log), log.sharedFriendUids));
        if (toUpdate.length === 0) continue;
        const { writeBatch } = await import('firebase/firestore');
        const batch = writeBatch(db);
        toUpdate.forEach((log) => {
          batch.update(doc(db, 'bloodPressureLogs', log.id), { groupId: nextGroupIdFor(log), sharedFriendUids: nextFriendUidsFor(log) });
        });
        await batch.commit();
      }

      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save BP sharing settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveDelegates = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      await setDoc(doc(db, 'bpDelegateSettings', user.uid), { userId: user.uid, bp: delegateForm, updatedAt: new Date().toISOString() });
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save BP delegate settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const loadRemindersFor = async (targetUid: string) => {
    if (targetUid === 'me') {
      setRemindersForm(reminders);
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'users', targetUid));
      setRemindersForm((snap.data() as any)?.bpReminders || DEFAULT_BP_REMINDERS);
    } catch (err) {
      console.error('Failed to load BP reminders for delegate target:', err);
      setRemindersForm(DEFAULT_BP_REMINDERS);
    }
  };

  const handleSaveReminders = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      const targetUid = remindersForUid === 'me' ? user.uid : remindersForUid;
      await updateDoc(doc(db, 'users', targetUid), { bpReminders: remindersForm });
      if (remindersForUid === 'me') scheduleBpReminders(remindersForm);
      setSettingsPanel(null);
    } catch (err) {
      console.error('Failed to save BP reminder settings:', err);
      alert(t('health.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => {
    scheduleBpReminders(reminders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(reminders)]);

  // --- Log entry form ---
  const [systolicInput, setSystolicInput] = useState('');
  const [diastolicInput, setDiastolicInput] = useState('');
  const [pulseInput, setPulseInput] = useState('');
  const [notes, setNotes] = useState('');
  const [loggedDate, setLoggedDate] = useState(todayLocalDateString());
  const [loggedTime, setLoggedTime] = useState(nowLocalTimeString());
  const [saving, setSaving] = useState(false);
  const [enteringForUid, setEnteringForUid] = useState<string>('me');
  const [editingLog, setEditingLog] = useState<BloodPressureLog | null>(null);

  const handleEditStart = (log: BloodPressureLog) => {
    setEditingLog(log);
    setSystolicInput(String(log.systolic));
    setDiastolicInput(String(log.diastolic));
    setPulseInput(log.pulse != null ? String(log.pulse) : '');
    setNotes(log.notes || '');
    const d = new Date(log.loggedAt);
    setLoggedDate(toLocalDateString(d));
    setLoggedTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    setEnteringForUid(log.userId === user?.uid ? 'me' : log.userId);
    setTab('log');
  };

  const handleCancelEdit = () => {
    setEditingLog(null);
    setSystolicInput('');
    setDiastolicInput('');
    setPulseInput('');
    setNotes('');
    setLoggedDate(todayLocalDateString());
    setLoggedTime(nowLocalTimeString());
  };

  const parsedSystolic = parseInt(systolicInput, 10);
  const parsedDiastolic = parseInt(diastolicInput, 10);
  const parsedPulse = pulseInput.trim() ? parseInt(pulseInput, 10) : null;
  const hasValidValue = !isNaN(parsedSystolic) && parsedSystolic > 0 && !isNaN(parsedDiastolic) && parsedDiastolic > 0;

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

      const effectiveShareSettings: BpShareSettings =
        targetUid === user.uid
          ? shareSettings
          : ((await getDoc(doc(db, 'bpShareSettings', targetUid))).data()?.bp as any) || DEFAULT_BP_SHARE_SETTINGS;

      const shouldShare = isBpShareActiveForDate(effectiveShareSettings, loggedAt);
      const computedGroupId = shouldShare ? effectiveShareSettings.groupId : null;
      const computedFriendUids = shouldShare ? effectiveShareSettings.friendUids : [];
      const fields = {
        groupId: computedGroupId,
        sharedFriendUids: computedFriendUids,
        systolic: parsedSystolic,
        diastolic: parsedDiastolic,
        pulse: parsedPulse,
        notes: notes.trim() || null,
        loggedAt,
      };

      if (editingLog) {
        fireWrite(updateDoc(doc(db, 'bloodPressureLogs', editingLog.id), { userId: targetUid, ...fields }), 'update BP log');
      } else {
        fireWrite(
          setDoc(doc(collection(db, 'bloodPressureLogs')), {
            userId: targetUid,
            loggedBy: user.uid,
            createdAt: new Date().toISOString(),
            ...fields,
          }),
          'add BP log',
        );
        const actorName = profile?.displayName || user.displayName || undefined;
        const readingLabel = `${parsedSystolic}/${parsedDiastolic}`;
        if (computedGroupId) {
          notifyGroupActivity({
            groupId: computedGroupId,
            action: 'glucose_logged', // reuses the existing generic "health reading logged" Feed/push type
            amount: parsedSystolic,
            contextLabel: `BP ${readingLabel}`,
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
                body: JSON.stringify({ friendUids: computedFriendUids, value: readingLabel, contextLabel: 'Blood pressure', actorName }),
              }),
            )
            .catch((err) => console.error('notify-bp-shared failed:', err));
        }
      }

      setEditingLog(null);
      setSystolicInput('');
      setDiastolicInput('');
      setPulseInput('');
      setNotes('');
      setLoggedDate(todayLocalDateString());
      setLoggedTime(nowLocalTimeString());
      setShowConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id: string) => {
    if (!window.confirm(t('bp.confirmDeleteEntry'))) return;
    fireWrite(deleteDoc(doc(db, 'bloodPressureLogs', id)), 'delete BP log');
  };

  // --- Dashboard ---
  const [viewUid, setViewUid] = useState<string>('me');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [filterRangeStatus, setFilterRangeStatus] = useState<'all' | 'inRange' | 'outOfRange'>('all');
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);

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

  const [viewedUserSnap] = useDocument(viewUid !== 'me' ? doc(db, 'users', viewUid) : null);
  const viewedTarget: BpTarget = viewUid === 'me' ? target : (viewedUserSnap?.data() as any)?.bpTargets || DEFAULT_BP_TARGET;

  const filteredLogs = useMemo(() => {
    return baseLogs.filter((l) => {
      const day = l.loggedAt.slice(0, 10);
      if (rangeStart && day < rangeStart) return false;
      if (rangeEnd && day > rangeEnd) return false;
      if (filterRangeStatus !== 'all') {
        const status = bpRangeStatus(l.systolic, l.diastolic, viewedTarget);
        if (filterRangeStatus === 'inRange' && status !== 'inRange') return false;
        if (filterRangeStatus === 'outOfRange' && status === 'inRange') return false;
      }
      return true;
    }).sort((a, b) => (b.loggedAt || '').localeCompare(a.loggedAt || ''));
  }, [baseLogs, rangeStart, rangeEnd, filterRangeStatus, viewedTarget]);

  const clearDashboardFilters = () => {
    setDatePreset('all');
    setCustomStart('');
    setCustomEnd('');
    setFilterRangeStatus('all');
  };

  const avgSystolic = filteredLogs.length > 0 ? Math.round(filteredLogs.reduce((s, l) => s + l.systolic, 0) / filteredLogs.length) : 0;
  const avgDiastolic = filteredLogs.length > 0 ? Math.round(filteredLogs.reduce((s, l) => s + l.diastolic, 0) / filteredLogs.length) : 0;

  const viewingName =
    viewUid === 'me'
      ? profile?.displayName || user?.displayName || t('health.myReport')
      : shareableMembers.find((m: any) => m.userId === viewUid)?.displayName || t('common.someone');

  const trend = useMemo(
    () =>
      filteredLogs
        .slice()
        .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
        .slice(-20)
        .map((l) => ({
          date: new Date(l.loggedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          systolic: l.systolic,
          diastolic: l.diastolic,
        })),
    [filteredLogs],
  );

  const chartRef = useRef<HTMLDivElement | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const handleClearHistory = () => {
    if (filteredLogs.length === 0) return;
    if (!window.confirm(t('bp.confirmClearHistory'))) return;
    filteredLogs.forEach((log) => fireWrite(deleteDoc(doc(db, 'bloodPressureLogs', log.id)), 'clear BP log'));
  };

  const handleExportPdf = async () => {
    if (filteredLogs.length === 0) {
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
      docPdf.text('Patient Blood Pressure Report', 14, 18);
      docPdf.setFontSize(9);
      docPdf.setTextColor(120);
      const rangeLabel = rangeStart || rangeEnd ? `${rangeStart || 'earliest'} to ${rangeEnd || 'latest'}` : 'All time';
      docPdf.text(`Patient: ${viewingName}`, 14, 24);
      docPdf.text(`Generated via FamilyLedger Health Monitoring — ${new Date().toLocaleString()} — Period: ${rangeLabel}`, 14, 29);
      docPdf.setTextColor(0);
      docPdf.setFontSize(10);
      docPdf.text(
        `Average: ${avgSystolic}/${avgDiastolic} mmHg     Total readings: ${filteredLogs.length}     Target: ${viewedTarget.systolicMin}-${viewedTarget.systolicMax}/${viewedTarget.diastolicMin}-${viewedTarget.diastolicMax} mmHg`,
        14,
        37,
      );

      autoTable(docPdf, {
        startY: 44,
        head: [['Date & Time', 'Systolic', 'Diastolic', 'Pulse']],
        body: filteredLogs.map((l) => [
          new Date(l.loggedAt).toLocaleString(),
          String(l.systolic),
          String(l.diastolic),
          l.pulse != null ? String(l.pulse) : '—',
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [15, 71, 97] },
      });

      const finalY = (docPdf as any).lastAutoTable?.finalY || 44;
      const notesText = filteredLogs
        .filter((l) => l.notes)
        .map((l) => `${new Date(l.loggedAt).toLocaleDateString()}: ${l.notes}`)
        .join('   |   ');
      if (notesText) {
        docPdf.setFontSize(9);
        docPdf.text('Patient Notes / Symptoms:', 14, finalY + 10);
        docPdf.text(docPdf.splitTextToSize(notesText, 180), 14, finalY + 15);
      }

      if (trend.length >= 2 && chartRef.current) {
        docPdf.addPage();
        docPdf.setFontSize(13);
        docPdf.setTextColor(0);
        docPdf.text('Blood Pressure Trend', 14, 18);
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
      await shareOrDownloadFile(pdfBlob, `blood_pressure_${safeName}_${todayLocalDateString()}.pdf`, 'application/pdf');
    } catch (err) {
      console.error('BP PDF export failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      alert(`${t('health.exportFailed')}\n\n${detail}`);
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-3 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-primary leading-tight">{t('bp.tracker')}</h1>
            <p className="text-[11px] text-text-muted leading-tight">{t('bp.trackerDesc')}</p>
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
          <button
            type="button"
            onClick={() => setTab('log')}
            className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', tab === 'log' ? 'bg-primary text-white' : 'text-text-muted')}
          >
            {t('health.logEntry')}
          </button>
          <button
            type="button"
            onClick={() => setTab('dashboard')}
            className={clsx('flex-1 py-2 rounded-lg text-xs font-bold transition-all', tab === 'dashboard' ? 'bg-primary text-white' : 'text-text-muted')}
          >
            {t('health.dashboard')}
          </button>
        </div>

        {tab === 'log' && (
          <form onSubmit={handleSubmit} className="space-y-2.5">
            {editingLog && (
              <div className="flex items-center justify-between gap-2 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
                <span className="text-[11px] font-bold text-primary flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">edit</span>
                  {t('health.editingEntry')}
                </span>
                <button type="button" onClick={handleCancelEdit} className="text-[11px] font-bold text-text-muted">
                  {t('common.cancel')}
                </button>
              </div>
            )}
            {(editingLog || delegatorsForMe.length > 0) && (
              <div className="space-y-1">
                <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">
                  {editingLog ? t('health.assignTo') : t('health.enteringFor')}
                </label>
                <select
                  value={enteringForUid}
                  onChange={(e) => setEnteringForUid(e.target.value)}
                  className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
                >
                  <option value="me">{t('health.myself')}</option>
                  {[
                    ...delegatorsForMe,
                    ...(editingLog && editingLog.userId !== user?.uid && !delegatorsForMe.some((d) => d.userId === editingLog.userId)
                      ? [resolveSharer(editingLog.userId)]
                      : []),
                  ].map((d) => (
                    <option key={d.userId} value={d.userId}>{d.displayName}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-2">
              <label className="text-[10px] text-text-muted font-bold uppercase tracking-wider">{t('bp.enterReading')}</label>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 space-y-1">
                  <input
                    type="number"
                    inputMode="numeric"
                    value={systolicInput}
                    onChange={(e) => setSystolicInput(e.target.value)}
                    placeholder="120"
                    className="w-full text-2xl font-black text-primary bg-surface rounded-xl border border-border-subtle text-center py-2 outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <p className="text-[9px] font-bold text-text-muted text-center uppercase tracking-wider">{t('bp.systolic')}</p>
                </div>
                <span className="text-2xl font-black text-text-muted pb-4">/</span>
                <div className="flex-1 min-w-0 space-y-1">
                  <input
                    type="number"
                    inputMode="numeric"
                    value={diastolicInput}
                    onChange={(e) => setDiastolicInput(e.target.value)}
                    placeholder="80"
                    className="w-full text-2xl font-black text-primary bg-surface rounded-xl border border-border-subtle text-center py-2 outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <p className="text-[9px] font-bold text-text-muted text-center uppercase tracking-wider">{t('bp.diastolic')}</p>
                </div>
                <div className="w-16 shrink-0 space-y-1">
                  <input
                    type="number"
                    inputMode="numeric"
                    value={pulseInput}
                    onChange={(e) => setPulseInput(e.target.value)}
                    placeholder="—"
                    className="w-full text-sm font-bold text-primary bg-surface rounded-xl border border-border-subtle text-center py-2.5 outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <p className="text-[9px] font-bold text-text-muted text-center uppercase tracking-wider">{t('bp.pulse')}</p>
                </div>
              </div>
              {hasValidValue && (
                <div className={clsx('text-[10px] font-bold flex items-center justify-center gap-1', rangeBadge(parsedSystolic, parsedDiastolic, target, t).cls)}>
                  {rangeBadge(parsedSystolic, parsedDiastolic, target, t).icon} {rangeBadge(parsedSystolic, parsedDiastolic, target, t).text}
                </div>
              )}
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
              {saving ? t('common.saving') : editingLog ? t('health.updateLogEntry') : t('health.saveLogEntry')}
            </button>
          </form>
        )}

        {tab === 'dashboard' && (
          <div className="space-y-6">
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
              <select
                value={filterRangeStatus}
                onChange={(e) => setFilterRangeStatus(e.target.value as any)}
                className="w-full bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none"
              >
                <option value="all">{t('health.allReadings')}</option>
                <option value="inRange">{t('health.rangeInTarget')}</option>
                <option value="outOfRange">{t('health.outOfRange')}</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-4">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('bp.average')}</p>
                <p className="text-2xl font-black text-primary mt-1">{avgSystolic || '—'}/{avgDiastolic || '—'} <span className="text-xs font-bold text-text-muted">mmHg</span></p>
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
              <button type="button" onClick={() => setChartCollapsed((c) => !c)} className="w-full flex items-center justify-between text-left">
                <div>
                  <h3 className="font-bold text-primary text-sm">{t('bp.trendChart')}</h3>
                  <p className="text-[11px] text-text-muted">{t('bp.trendChartDesc', { sysMin: viewedTarget.systolicMin, sysMax: viewedTarget.systolicMax, diaMin: viewedTarget.diastolicMin, diaMax: viewedTarget.diastolicMax })}</p>
                </div>
                <span className={clsx('material-symbols-outlined text-text-muted transition-transform shrink-0', chartCollapsed && '-rotate-90')}>expand_more</span>
              </button>
              <motion.div
                initial={false}
                animate={{ height: chartCollapsed ? 0 : 'auto', opacity: chartCollapsed ? 0 : 1 }}
                transition={{ duration: 0.2, ease: 'easeInOut' }}
                className="overflow-hidden"
              >
                <div ref={chartRef} className="bg-surface rounded-xl border border-border-subtle p-3">
                  {trend.length >= 2 ? (
                    <div className="h-52">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={trend} margin={{ top: 16, right: 12, left: 12, bottom: 0 }}>
                          <XAxis dataKey="date" fontSize={9} tick={{ fill: '#9CA3AF' }} axisLine={false} tickLine={false} padding={{ left: 12, right: 12 }} />
                          <YAxis hide width={0} domain={['dataMin - 10', 'dataMax + 10']} />
                          <Tooltip formatter={(v: number, name: string) => [`${v} mmHg`, name === 'systolic' ? t('bp.systolic') : t('bp.diastolic')]} labelStyle={{ fontSize: 11 }} />
                          <Legend
                            wrapperStyle={{ fontSize: 10 }}
                            formatter={(value) => (value === 'systolic' ? t('bp.systolic') : t('bp.diastolic'))}
                          />
                          <Line type="monotone" dataKey="systolic" stroke="#DC2626" strokeWidth={2} dot={{ r: 2 }} />
                          <Line type="monotone" dataKey="diastolic" stroke="#0f4761" strokeWidth={2} dot={{ r: 2 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-[11px] text-text-muted italic py-3 text-center">{t('health.needTwoEntries')}</p>
                  )}
                </div>
              </motion.div>
            </div>

            <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <button type="button" onClick={() => setTableCollapsed((c) => !c)} className="flex items-center gap-1.5 text-left min-w-0">
                  <span className={clsx('material-symbols-outlined text-text-muted transition-transform text-[18px] shrink-0', tableCollapsed && '-rotate-90')}>expand_more</span>
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
                      const badge = rangeBadge(log.systolic, log.diastolic, viewedTarget, t);
                      return (
                        <div key={log.id} className="px-4 py-3 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[10px] text-text-muted">{new Date(log.loggedAt).toLocaleString()}</p>
                            {log.notes && <p className="text-[10px] text-text-muted italic truncate mt-0.5">{log.notes}</p>}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-black text-primary">
                              {log.systolic}/{log.diastolic} <span className="text-[10px] font-bold text-text-muted">mmHg</span>
                              {log.pulse != null && <span className="text-[10px] font-bold text-text-muted"> · {log.pulse} bpm</span>}
                            </p>
                            <p className={clsx('text-[9px] font-bold', badge.cls)}>{badge.icon} {badge.text}</p>
                          </div>
                          {(log.userId === user?.uid || log.loggedBy === user?.uid) && (
                            <div className="flex items-center shrink-0">
                              <button type="button" onClick={() => handleEditStart(log)} className="p-1.5 text-text-muted hover:text-primary transition-colors">
                                <span className="material-symbols-outlined text-[16px]">edit</span>
                              </button>
                              <button type="button" onClick={() => handleDelete(log.id)} className="p-1.5 text-text-muted hover:text-error transition-colors">
                                <span className="material-symbols-outlined text-[16px]">delete</span>
                              </button>
                            </div>
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
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowConfirm(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-black text-primary">{editingLog ? t('health.confirmUpdateTitle') : t('health.confirmTitle')}</h2>

            <div className="bg-surface rounded-2xl border border-border-subtle p-4 space-y-3">
              {enteringForUid !== 'me' && (
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
                  <span className="material-symbols-outlined text-[14px]">person</span>
                  {t(editingLog ? 'health.assignedToName' : 'health.enteringForName', { name: resolveSharer(enteringForUid).displayName })}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">{t('bp.reading')}</span>
                <div className="text-right">
                  <p className="text-2xl font-black text-primary">
                    {parsedSystolic}/{parsedDiastolic} <span className="text-xs font-bold text-text-muted">mmHg</span>
                  </p>
                  {parsedPulse != null && <p className="text-[10px] font-bold text-text-muted">{parsedPulse} bpm</p>}
                  <p className={clsx('text-[10px] font-bold flex items-center justify-end gap-1', rangeBadge(parsedSystolic, parsedDiastolic, target, t).cls)}>
                    {rangeBadge(parsedSystolic, parsedDiastolic, target, t).icon} {rangeBadge(parsedSystolic, parsedDiastolic, target, t).text}
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-text-muted border-t border-border-subtle pt-3">{combineLocalDateAndTime(loggedDate, loggedTime).toLocaleString()}</p>

              {notes.trim() && (
                <div className="border-t border-border-subtle pt-3">
                  <p className="text-[11px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('health.notes')}</p>
                  <p className="text-xs text-on-surface">{notes.trim()}</p>
                </div>
              )}

              <div className="flex items-center gap-1.5 border-t border-border-subtle pt-3 text-[11px] text-text-muted">
                <span className="material-symbols-outlined text-[14px]">{hasBpShareTarget(shareSettings) ? 'share' : 'lock'}</span>
                {hasBpShareTarget(shareSettings) ? t('health.sharing') : t('todo.justMe')}
              </div>
            </div>

            <div className="flex gap-2">
              <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle">
                {t('health.change')}
              </button>
              <button type="button" onClick={handleConfirmSave} disabled={saving} className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
                {saving ? t('common.saving') : editingLog ? t('health.confirmUpdate') : t('health.confirmAndSave')}
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
              { key: 'reminders' as const, icon: 'notifications_active', label: t('bp.reminders') },
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

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 bg-surface rounded-lg p-2 border border-border-subtle">
                <span className="text-[10px] font-bold text-text-muted w-20 shrink-0">{t('bp.systolic')}</span>
                <input
                  type="number"
                  value={targetForm.systolicMin}
                  onChange={(e) => setTargetForm((f) => ({ ...f, systolicMin: Number(e.target.value) }))}
                  className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                />
                <span className="text-text-muted text-[10px] font-bold shrink-0">{t('common.to')}</span>
                <input
                  type="number"
                  value={targetForm.systolicMax}
                  onChange={(e) => setTargetForm((f) => ({ ...f, systolicMax: Number(e.target.value) }))}
                  className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                />
              </div>
              <div className="flex items-center gap-2 bg-surface rounded-lg p-2 border border-border-subtle">
                <span className="text-[10px] font-bold text-text-muted w-20 shrink-0">{t('bp.diastolic')}</span>
                <input
                  type="number"
                  value={targetForm.diastolicMin}
                  onChange={(e) => setTargetForm((f) => ({ ...f, diastolicMin: Number(e.target.value) }))}
                  className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                />
                <span className="text-text-muted text-[10px] font-bold shrink-0">{t('common.to')}</span>
                <input
                  type="number"
                  value={targetForm.diastolicMax}
                  onChange={(e) => setTargetForm((f) => ({ ...f, diastolicMax: Number(e.target.value) }))}
                  className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                />
              </div>
            </div>

            <button type="button" onClick={handleSaveTarget} disabled={savingSettings} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
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
            {hasBpShareTarget(shareForm) && (
              <>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShareForm((f) => ({ ...f, mode: 'always' }))}
                    className={clsx('flex-1 py-2 rounded-lg text-xs font-bold border transition-all', shareForm.mode === 'always' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                  >
                    {t('health.always')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShareForm((f) => ({ ...f, mode: 'range' }))}
                    className={clsx('flex-1 py-2 rounded-lg text-xs font-bold border transition-all', shareForm.mode === 'range' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
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

            <button type="button" onClick={handleSaveDelegates} disabled={savingSettings} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
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
              <h2 className="text-base font-black text-primary flex-1">{t('bp.reminders')}</h2>
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
              <span className="text-[11px] text-text-muted font-bold uppercase tracking-wider">{t('bp.reminders')}</span>
              <button
                type="button"
                onClick={() => setRemindersForm((f) => ({ ...f, enabled: !f.enabled }))}
                className={clsx('w-10 h-6 rounded-full transition-colors relative shrink-0', remindersForm.enabled ? 'bg-primary' : 'bg-surface-container')}
              >
                <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', remindersForm.enabled ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </div>
            {remindersForm.enabled && (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  {remindersForm.times.map((slot) => (
                    <div key={slot.id} className="flex items-center gap-2 bg-surface rounded-lg p-2 border border-border-subtle">
                      <input
                        type="text"
                        value={slot.label}
                        onChange={(e) =>
                          setRemindersForm((f) => ({ ...f, times: f.times.map((s) => (s.id === slot.id ? { ...s, label: e.target.value } : s)) }))
                        }
                        placeholder={t('bp.reminderLabelPlaceholder')}
                        className="flex-1 min-w-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                      />
                      <input
                        type="time"
                        value={slot.time}
                        onChange={(e) =>
                          setRemindersForm((f) => ({ ...f, times: f.times.map((s) => (s.id === slot.id ? { ...s, time: e.target.value } : s)) }))
                        }
                        className="w-24 shrink-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setRemindersForm((f) => ({ ...f, times: f.times.filter((s) => s.id !== slot.id) }))}
                        className="shrink-0 p-1 text-text-muted hover:text-error transition-colors"
                      >
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setRemindersForm((f) => ({ ...f, times: [...f.times, { id: newTimeSlotId(), label: '', time: '12:00' }] }))
                  }
                  className="w-full py-2 rounded-lg text-xs font-bold text-primary border border-dashed border-primary/30 hover:bg-primary/5 transition-colors"
                >
                  + {t('bp.addReminderTime')}
                </button>

                <div className="space-y-1 pt-1">
                  <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('health.repeats')}</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setRemindersForm((f) => ({ ...f, cadence: 'daily' }))}
                      className={clsx('flex-1 py-2 rounded-lg text-xs font-bold border transition-all', remindersForm.cadence === 'daily' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                    >
                      {t('health.daily')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemindersForm((f) => ({ ...f, cadence: 'weekly' }))}
                      className={clsx('flex-1 py-2 rounded-lg text-xs font-bold border transition-all', remindersForm.cadence === 'weekly' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
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
                              setRemindersForm((f) => ({ ...f, weekdays: selected ? f.weekdays.filter((d) => d !== idx) : [...f.weekdays, idx] }))
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
                <p className="text-[10px] text-text-muted">{t('bp.reminderHint')}</p>
              </div>
            )}

            <button type="button" onClick={handleSaveReminders} disabled={savingSettings} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {savingSettings ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
