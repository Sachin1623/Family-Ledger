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
import { MedicalIncident, GENERAL_INCIDENT_ID, isIncidentEnded } from '../lib/medicalIncidents';

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

// Plain, unlocalized default text — matches this app's existing precedent for dose-time labels
// (the original hardcoded "Morning" default for a brand-new medicine's first slot was never
// localized either), so what gets auto-filled here is consistent with what's already saved for
// medicines created before this feature existed.
function autoDoseLabel(time: string): string {
  const hour = Number(time.split(':')[0]);
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 21) return 'Evening';
  return 'Night';
}

// 'HH:mm' (24h, the stored/native-input format) -> '8:00 AM' for the read-only dose-time rows —
// the editable row still uses the native time input directly, which already renders 12h/24h per
// the device's own locale, so this is only needed once a slot collapses to plain text.
function formatDoseTimeDisplay(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// Always fully auto-derived from each slot's time now — the label is display-only (see the dose-
// time row's read-only <span> instead of an <input>), so there's no "did the user customize this"
// question to track anymore. Numbered ("Morning 1"/"Morning 2") when two or more slots land in the
// same period — in TIME order, not insertion order, which is also why this sorts the whole list by
// time first: a dose time added out of order (e.g. 09:08 PM added after two later ones already
// exist) should both display AND number itself where it chronologically belongs, not get tacked
// onto the end just because it was the last one typed.
function withAutoDoseLabels(times: MedicineDoseTime[]): MedicineDoseTime[] {
  const sorted = [...times].sort((a, b) => a.time.localeCompare(b.time));
  const totalPerBase: Record<string, number> = {};
  sorted.forEach((s) => {
    const base = autoDoseLabel(s.time);
    totalPerBase[base] = (totalPerBase[base] || 0) + 1;
  });
  const seenSoFar: Record<string, number> = {};
  return sorted.map((s) => {
    const base = autoDoseLabel(s.time);
    seenSoFar[base] = (seenSoFar[base] || 0) + 1;
    return { ...s, label: totalPerBase[base] > 1 ? `${base} ${seenSoFar[base]}` : base };
  });
}

interface DueInstance {
  dateStr: string;
  medicine: Medicine;
  doseTime: MedicineDoseTime;
  log: MedicineLog | null;
  status: MedicineLogStatus | 'missed' | 'pending';
}

// Walks forward from `now` (up to a week out) for the next scheduled dose that's still ahead of
// it — pure schedule math, no Firestore read needed (unlike lastTaken/history below, which need
// actual log data).
function computeNextDue(med: Medicine, now: Date): { dateStr: string; time: string } | null {
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const dateStr = toLocalDateString(d);
    if (!isMedicineDueOn(med, dateStr)) continue;
    for (const time of med.times.map((slot) => slot.time).sort()) {
      const [h, mi] = time.split(':').map(Number);
      const slotInstant = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi);
      if (slotInstant > now) return { dateStr, time };
    }
  }
  return null;
}

// One medicine row on the Medicines tab — pulled out to its own component so the incident
// grouping above (medicinesByIncident.map) can render it identically whether a medicine sits
// under a colored incident section or (single-section case) in a plain flat list. Collapsible in
// its own right: collapsed shows just name/dosage/status; expanded additionally computes and
// shows last-taken/next-due/recent history, entirely from already-loaded data (allLogs) — no
// extra Firestore query per tile.
interface MedicineCardProps {
  med: Medicine;
  status: 'active' | 'paused' | 'ended' | 'upcoming';
  canManage: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: (med: Medicine) => void;
  onTogglePause: (med: Medicine) => void;
  onDelete: (med: Medicine) => void;
  doseTimeSummary: (med: Medicine) => string;
  durationSummary: (med: Medicine) => string;
  allLogs: MedicineLog[];
  today: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const MedicineCard: React.FC<MedicineCardProps> = ({
  med, status, canManage, expanded, onToggleExpand, onEdit, onTogglePause, onDelete, doseTimeSummary, durationSummary, allLogs, today, t,
}) => {
  const logsForMed = useMemo(() => (expanded ? allLogs.filter((l) => l.medicineId === med.id) : []), [expanded, allLogs, med.id]);

  const lastTaken = useMemo(() => {
    if (!expanded) return null;
    const taken = logsForMed.filter((l) => l.status === 'taken').sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));
    return taken[0] || null;
  }, [expanded, logsForMed]);

  const nextDue = useMemo(() => (expanded ? computeNextDue(med, new Date()) : null), [expanded, med]);

  // Last 7 days of scheduled doses for this medicine, newest first — reconstructed the same way
  // the Dashboard tab builds its own history (schedule × date range, cross-referenced against
  // actual logs), just scoped to one medicine and a short fixed window instead of a user-chosen one.
  const recentHistory = useMemo(() => {
    if (!expanded) return [];
    const out: { dateStr: string; doseTime: MedicineDoseTime; status: MedicineLogStatus | 'missed' | 'pending' }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = toLocalDateString(d);
      if (!isMedicineDueOn(med, dateStr)) continue;
      med.times.forEach((slot) => {
        const log = logsForMed.find((l) => l.dateStr === dateStr && l.doseTimeId === slot.id);
        out.push({ dateStr, doseTime: slot, status: log ? log.status : dateStr < today ? 'missed' : 'pending' });
      });
    }
    return out.sort((a, b) => (b.dateStr + b.doseTime.time).localeCompare(a.dateStr + a.doseTime.time));
  }, [expanded, logsForMed, med, today]);

  return (
    <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
      <button type="button" onClick={onToggleExpand} className="w-full p-3 flex items-start justify-between gap-2 text-left">
        <div className="min-w-0">
          <p className="font-bold text-primary text-sm truncate">{med.name}{med.dosage ? <span className="text-text-muted font-semibold"> · {med.dosage}</span> : null}</p>
          <p className="text-[11px] text-text-muted mt-0.5">{doseTimeSummary(med)}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className={clsx(
              'text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded-full',
              status === 'active' && 'bg-success/10 text-success',
              status === 'paused' && 'bg-surface-container text-text-muted',
              status === 'ended' && 'bg-error/10 text-error',
              status === 'upcoming' && 'bg-primary/10 text-primary',
            )}
          >
            {t(`medicine.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
          </span>
          <span className={clsx('material-symbols-outlined text-[18px] text-text-muted transition-transform', expanded && 'rotate-180')}>expand_more</span>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-border-subtle pt-2.5">
          <p className="text-[11px] text-text-muted">{durationSummary(med)}</p>

          <div className="grid grid-cols-2 gap-2">
            <div className="bg-surface rounded-xl p-2.5">
              <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{t('medicine.lastTaken')}</p>
              <p className="text-xs font-bold text-primary mt-0.5">
                {lastTaken ? t('medicine.lastTakenValue', { date: lastTaken.dateStr, time: lastTaken.scheduledTime }) : t('medicine.noneYet')}
              </p>
            </div>
            <div className="bg-surface rounded-xl p-2.5">
              <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{t('medicine.nextDue')}</p>
              <p className="text-xs font-bold text-primary mt-0.5">
                {nextDue ? `${nextDue.dateStr} · ${nextDue.time}` : t('medicine.noUpcomingDose')}
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{t('medicine.recentHistory')}</p>
            {recentHistory.length === 0 ? (
              <p className="text-[11px] text-text-muted italic">{t('medicine.noRecentDoses')}</p>
            ) : (
              <div className="space-y-1">
                {recentHistory.map((h) => (
                  <div key={`${h.dateStr}_${h.doseTime.id}`} className="flex items-center justify-between text-[11px]">
                    <span className="text-text-muted">{h.dateStr} · {h.doseTime.label}</span>
                    <span
                      className={clsx(
                        'font-bold',
                        h.status === 'taken' && 'text-success',
                        h.status === 'missed' && 'text-error',
                        h.status === 'skipped' && 'text-text-muted',
                        h.status === 'pending' && 'text-primary',
                      )}
                    >
                      {h.status === 'taken' ? t('medicine.doseStatusTaken')
                        : h.status === 'missed' ? t('medicine.doseStatusMissed')
                        : h.status === 'skipped' ? t('medicine.doseStatusSkipped')
                        : t('medicine.doseStatusPending')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {canManage && (
            <div className="flex items-center gap-1 pt-1 border-t border-border-subtle">
              <button type="button" onClick={() => onEdit(med)} className="flex-1 py-1.5 text-[11px] font-bold text-primary flex items-center justify-center gap-1">
                <span className="material-symbols-outlined text-[14px]">edit</span>{t('common.edit')}
              </button>
              <button type="button" onClick={() => onTogglePause(med)} className="flex-1 py-1.5 text-[11px] font-bold text-text-muted flex items-center justify-center gap-1">
                <span className="material-symbols-outlined text-[14px]">{med.active ? 'pause' : 'play_arrow'}</span>
                {med.active ? t('medicine.pause') : t('medicine.resume')}
              </button>
              <button type="button" onClick={() => onDelete(med)} className="flex-1 py-1.5 text-[11px] font-bold text-error flex items-center justify-center gap-1">
                <span className="material-symbols-outlined text-[14px]">delete</span>{t('common.delete')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

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

  // Incidents — simpler sharing model than medicines themselves (own + delegate access only, no
  // separate group/friend incident-sharing yet; that can be added later the same way medicines'
  // was, if ever asked for).
  const [ownIncidentsValue] = useCollection(
    user ? query(collection(db, 'medicalIncidents'), where('userId', '==', user.uid)) : null,
  );
  const [delegatedIncidentsValue] = useCollection(
    delegatorUids.length > 0 ? query(collection(db, 'medicalIncidents'), where('userId', 'in', delegatorUids.slice(0, 30))) : null,
  );
  const incidents: MedicalIncident[] = useMemo(() => {
    const byId = new Map<string, MedicalIncident>();
    ownIncidentsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    delegatedIncidentsValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values());
  }, [ownIncidentsValue, delegatedIncidentsValue]);

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
  }, [JSON.stringify(myActiveMedicines.map((m) => [m.id, m.active, m.remindersEnabled, m.times, m.weekdays, m.intervalDays, m.startDate, m.durationMode, m.endDate, m.dayCount]))]);

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
  const [formIncidentId, setFormIncidentId] = useState(''); // '' = General (no incident)
  const [formTimes, setFormTimes] = useState<MedicineDoseTime[]>([{ id: newDoseTimeId(), label: 'Morning', time: '08:00', foodTiming: 'after' }]);
  // Only ONE dose-time slot is ever interactive at a time — this is its id. Every other slot
  // renders read-only (plain text + an Edit button that switches focus here instead). The
  // underlying values in `formTimes` are always live regardless of which slot has focus — "Save"
  // on the focused slot is a pure UI toggle (defocus it), not a separate write; there's no draft
  // copy to reconcile.
  const [editingDoseTimeId, setEditingDoseTimeId] = useState<string | null>(null);
  // Snapshot of which slot ids already existed when this form was opened — lets the focused
  // slot's badge say "New" for one truly just created (via + Add dose time, or the very first
  // slot on a brand-new medicine) versus "Editing" for an existing one the user tapped Edit on.
  const [originalDoseTimeIds, setOriginalDoseTimeIds] = useState<Set<string>>(new Set());
  const [formWeekdays, setFormWeekdays] = useState<number[]>([]);
  // 'daily' and 'specific' both save as weekdays (empty = every day); 'alternate' saves as
  // intervalDays: 2 instead — see intervalDays' own comment in medicines.ts for why the two are
  // mutually exclusive rather than combined.
  const [formRepeatMode, setFormRepeatMode] = useState<'daily' | 'specific' | 'alternate'>('daily');
  const [formStartDate, setFormStartDate] = useState(todayLocalDateString());
  const [formDurationMode, setFormDurationMode] = useState<'ongoing' | 'endDate' | 'dayCount'>('dayCount');
  const [formEndDate, setFormEndDate] = useState('');
  const [formDayCount, setFormDayCount] = useState('30');
  const [formReminders, setFormReminders] = useState(true);
  const [formNotes, setFormNotes] = useState('');
  const [savingMed, setSavingMed] = useState(false);

  // `presetIncidentId` is set when opened from a specific incident section's own "Add Medicine"
  // button, so the new medicine lands in that section without the user having to pick it again.
  const openAddMedicine = (presetIncidentId?: string) => {
    setEditingMedicine(null);
    setFormName('');
    setFormDosage('');
    setFormIncidentId(presetIncidentId || '');
    // A brand-new medicine's very first dose time is just as much "the one being added right now"
    // as anything created via the + button below — it gets focus (and the "New" badge) too, not
    // just ones added after it. originalDoseTimeIds stays empty, since nothing exists yet.
    const firstDoseId = newDoseTimeId();
    setFormTimes([{ id: firstDoseId, label: 'Morning', time: '08:00', foodTiming: 'after' }]);
    setEditingDoseTimeId(firstDoseId);
    setOriginalDoseTimeIds(new Set());
    setFormWeekdays([]);
    setFormRepeatMode('daily');
    setFormStartDate(todayLocalDateString());
    setFormDurationMode('dayCount');
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
    setFormIncidentId(med.incidentId || '');
    // Re-derived through withAutoDoseLabels even for an existing medicine — label is purely a
    // computed display of the time now (see that function's own comment), so this keeps it
    // consistent immediately on open rather than only once a time is next touched.
    const loadedTimes = withAutoDoseLabels(med.times.length > 0 ? med.times : [{ id: newDoseTimeId(), label: 'Morning', time: '08:00', foodTiming: 'after' }]);
    setFormTimes(loadedTimes);
    // Every already-saved dose time starts read-only (none in focus) — opening Edit on a medicine
    // shouldn't drop the user straight into editing an arbitrary slot.
    setEditingDoseTimeId(null);
    setOriginalDoseTimeIds(new Set(loadedTimes.map((s) => s.id)));
    setFormWeekdays(med.weekdays);
    setFormRepeatMode(med.intervalDays && med.intervalDays > 1 ? 'alternate' : med.weekdays.length > 0 && med.weekdays.length < 7 ? 'specific' : 'daily');
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
        incidentId: formIncidentId || null,
        times: formTimes,
        weekdays: formRepeatMode === 'specific' ? formWeekdays : [],
        intervalDays: formRepeatMode === 'alternate' ? 2 : null,
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

  // --- Incidents ---
  const [incidentForm, setIncidentForm] = useState(false);
  const [editingIncident, setEditingIncident] = useState<MedicalIncident | null>(null);
  const [incidentFormName, setIncidentFormName] = useState('');
  const [incidentFormDescription, setIncidentFormDescription] = useState('');
  const [incidentFormEndDate, setIncidentFormEndDate] = useState('');
  const [savingIncident, setSavingIncident] = useState(false);

  const openAddIncident = () => {
    setEditingIncident(null);
    setIncidentFormName('');
    setIncidentFormDescription('');
    setIncidentFormEndDate('');
    setIncidentForm(true);
  };
  const openEditIncident = (inc: MedicalIncident) => {
    setEditingIncident(inc);
    setIncidentFormName(inc.name);
    setIncidentFormDescription(inc.description || '');
    setIncidentFormEndDate(inc.endDate || '');
    setIncidentForm(true);
  };
  const handleSaveIncident = async () => {
    if (!user || !incidentFormName.trim()) return;
    setSavingIncident(true);
    try {
      const targetUid = manageTargetUid || user.uid;
      const fields = { name: incidentFormName.trim(), description: incidentFormDescription.trim() || null, endDate: incidentFormEndDate || null };
      if (editingIncident) {
        fireWrite(updateDoc(doc(db, 'medicalIncidents', editingIncident.id), fields), 'update incident');
      } else {
        fireWrite(
          setDoc(doc(collection(db, 'medicalIncidents')), { userId: targetUid, loggedBy: user.uid, createdAt: new Date().toISOString(), ...fields }),
          'add incident',
        );
      }
      setIncidentForm(false);
      setEditingIncident(null);
    } finally {
      setSavingIncident(false);
    }
  };
  // Deleting an incident never deletes or orphans its medicines — they move to the General
  // bucket (incidentId: null), same "close it, don't destroy what's under it" reasoning already
  // applied elsewhere in this app (e.g. discontinuing a goal never touches its funds).
  const handleDeleteIncident = (inc: MedicalIncident) => {
    if (!window.confirm(t('medicine.confirmDeleteIncident'))) return;
    const batch = writeBatch(db);
    batch.delete(doc(db, 'medicalIncidents', inc.id));
    manageMedicines.filter((m) => m.incidentId === inc.id).forEach((m) => batch.update(doc(db, 'medicines', m.id), { incidentId: null }));
    fireWrite(batch.commit(), 'delete incident');
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

  // Every incident belonging to whoever manageTargetUid currently points at — the add/edit
  // medicine form's incident picker and the Medicines tab's sections both key off this.
  const manageIncidents = useMemo(
    () => incidents.filter((inc) => inc.userId === manageTargetUid).sort((a, b) => a.name.localeCompare(b.name)),
    [incidents, manageTargetUid],
  );

  // The Add/Edit Medicine form's own incident picker, further trimmed to exclude ended incidents
  // (endDate in the past) — an incident list only ever grows over the years, and offering every
  // long-resolved one as a tappable chip forever would make that picker unusable. The incident
  // currently selected on the medicine being edited is always kept in, even if it has since ended,
  // so opening Edit on an old medicine never silently loses/hides its existing association.
  const activeIncidentsForForm = useMemo(() => {
    const todayStr = todayLocalDateString();
    return manageIncidents.filter((inc) => inc.id === formIncidentId || !isIncidentEnded(inc, todayStr));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manageIncidents, formIncidentId]);

  // Medicines tab groups by incident — a medicine with no incidentId still shows, just under the
  // General bucket, never hidden. Sections sort alphabetically by incident name; General always
  // sorts last so it doesn't visually compete with the deliberately-named incidents above it.
  const medicinesByIncidentAll = useMemo(() => {
    const map = new Map<string, Medicine[]>();
    manageMedicines.forEach((med) => {
      const key = med.incidentId || GENERAL_INCIDENT_ID;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(med);
    });
    // Every incident shows even if it currently has zero medicines — it was just created and
    // needs somewhere for its own "Add Medicine" button to live. General always shows too, even
    // with nothing in it yet, so there's always at least one section to add a medicine through.
    manageIncidents.forEach((inc) => { if (!map.has(inc.id)) map.set(inc.id, []); });
    if (!map.has(GENERAL_INCIDENT_ID)) map.set(GENERAL_INCIDENT_ID, []);
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === GENERAL_INCIDENT_ID) return 1;
      if (b === GENERAL_INCIDENT_ID) return -1;
      const nameA = incidents.find((i) => i.id === a)?.name || '';
      const nameB = incidents.find((i) => i.id === b)?.name || '';
      return nameA.localeCompare(nameB);
    });
  }, [manageMedicines, manageIncidents, incidents]);

  // Split out ended incidents (General is never "ended" — it has no end date at all) into their
  // own tucked-away group at the bottom of the tab, so a long-resolved illness from years ago
  // doesn't clutter the main list the same way it's already kept out of the Add Medicine picker.
  const todayForIncidents = todayLocalDateString();
  const medicinesByIncident = useMemo(
    () => medicinesByIncidentAll.filter(([key]) => key === GENERAL_INCIDENT_ID || !isIncidentEnded(incidents.find((i) => i.id === key) || { endDate: null }, todayForIncidents)),
    [medicinesByIncidentAll, incidents, todayForIncidents],
  );
  const historicMedicinesByIncident = useMemo(
    () => medicinesByIncidentAll.filter(([key]) => key !== GENERAL_INCIDENT_ID && isIncidentEnded(incidents.find((i) => i.id === key) || { endDate: null }, todayForIncidents)),
    [medicinesByIncidentAll, incidents, todayForIncidents],
  );

  // Which incident sections are expanded — opt-in (a Set of expanded incident ids, not collapsed
  // ones) so sections default to COLLAPSED, same "expanded" naming convention Dashboard.tsx's
  // archived-groups section already established for the identical reason: a brand-new section (an
  // incident nobody's toggled yet) should start tucked away, not sprawled open. No animation on
  // the toggle — Dashboard's own archived-groups history is exactly why (see that file's
  // comments): an animated collapse/expand tied to a value that can legitimately change on an
  // ordinary re-render risks looking like it's firing on its own, so this is a plain conditional
  // render instead.
  const [expandedIncidents, setExpandedIncidents] = useState<Set<string>>(new Set());
  // The "Historic Illnesses" umbrella section itself (holding every ended incident) — default
  // collapsed, same reasoning as everything else that defaults collapsed on this tab.
  const [historicExpanded, setHistoricExpanded] = useState(false);
  const toggleIncidentExpanded = (incidentId: string) => {
    setExpandedIncidents((prev) => {
      const next = new Set(prev);
      if (next.has(incidentId)) next.delete(incidentId); else next.add(incidentId);
      return next;
    });
  };
  // Individual medicine tiles within a section are separately collapsible (dosage/schedule/last-
  // taken/next-due/history only compute and render once a tile is actually opened).
  const [expandedMedicineIds, setExpandedMedicineIds] = useState<Set<string>>(new Set());
  const toggleMedicineExpanded = (medId: string) => {
    setExpandedMedicineIds((prev) => {
      const next = new Set(prev);
      if (next.has(medId)) next.delete(medId); else next.add(medId);
      return next;
    });
  };

  // An incident's color/icon are derived from its name (a simple string hash into a small fixed
  // palette) rather than stored anywhere — so the same name always renders the same way without
  // needing a color picker in the incident form or a migration if the palette ever changes.
  // `light` is the section's own tinted "shell" background (holding its medicine tiles) — a
  // literal class string per color, not a runtime-built one (`` `${bg}/10` ``), since Tailwind's
  // build-time scanner only picks up class names it can see written out in the source.
  const INCIDENT_PALETTE = [
    { bg: 'bg-teal-600', light: 'bg-teal-50', icon: 'healing' },
    { bg: 'bg-blue-600', light: 'bg-blue-50', icon: 'psychology' },
    { bg: 'bg-emerald-600', light: 'bg-emerald-50', icon: 'vaccines' },
    { bg: 'bg-amber-600', light: 'bg-amber-50', icon: 'medical_services' },
    { bg: 'bg-rose-600', light: 'bg-rose-50', icon: 'sick' },
    { bg: 'bg-violet-600', light: 'bg-violet-50', icon: 'emergency' },
  ];
  const incidentStyle = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return INCIDENT_PALETTE[Math.abs(hash) % INCIDENT_PALETTE.length];
  };

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
  const [logFilterIncident, setLogFilterIncident] = useState('all');
  // Which log rows have their Mark Taken/Skipped/Undo action revealed — tapping the row's pencil
  // toggles membership. Collapsed by default so the list reads as a compact status report (per the
  // redesign) rather than every row carrying its own always-visible button row.
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());
  const toggleLogExpanded = (id: string) =>
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const formatLoggedTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const dueToday = useMemo(
    () =>
      manageMedicines
        .filter((m) => isMedicineDueOn(m, logDate))
        .filter((m) => logFilterIncident === 'all' || (m.incidentId || GENERAL_INCIDENT_ID) === logFilterIncident)
        .flatMap((m) => m.times.map((slot) => ({ medicine: m, doseTime: slot }))),
    [manageMedicines, logDate, logFilterIncident],
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

  // --- Medicines tab: "due today, not yet taken" banner ---
  // Deliberately independent of `logDate`/`dueToday` above (the Log tab lets the user pick a past
  // date to log for) — this list must always reflect *today*, regardless of what date the Log tab
  // happens to be scrolled to.
  const todayStr = todayLocalDateString();
  const dueTodayAll = useMemo(
    () => manageMedicines.filter((m) => isMedicineDueOn(m, todayStr)).flatMap((m) => m.times.map((slot) => ({ medicine: m, doseTime: slot }))),
    [manageMedicines, todayStr],
  );
  const dueTodayAllIds = useMemo(
    () => dueTodayAll.map(({ medicine, doseTime }) => medicineLogId(manageTargetUid, medicine.id, doseTime.id, todayStr)),
    [dueTodayAll, manageTargetUid, todayStr],
  );
  const [dueTodayAllLogsValue] = useCollection(
    dueTodayAllIds.length > 0 ? query(collection(db, 'medicineLogs'), where(documentId(), 'in', dueTodayAllIds.slice(0, 30))) : null,
  );
  const dueTodayAllLogsById = useMemo(() => {
    const map = new Map<string, MedicineLog>();
    dueTodayAllLogsValue?.docs.forEach((d) => map.set(d.id, { id: d.id, ...(d.data() as any) } as MedicineLog));
    return map;
  }, [dueTodayAllLogsValue]);
  const pendingDueToday = useMemo(
    () =>
      dueTodayAll
        .filter(({ medicine, doseTime }) => !dueTodayAllLogsById.has(medicineLogId(manageTargetUid, medicine.id, doseTime.id, todayStr)))
        .sort((a, b) => a.doseTime.time.localeCompare(b.doseTime.time)),
    [dueTodayAll, dueTodayAllLogsById, manageTargetUid, todayStr],
  );

  const handleMarkDose = async (medicine: Medicine, doseTime: MedicineDoseTime, status: MedicineLogStatus, dateStr: string = logDate) => {
    if (!user) return;
    const targetUid = manageTargetUid || user.uid;
    const id = medicineLogId(targetUid, medicine.id, doseTime.id, dateStr);
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
        dateStr,
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
  const handleUndoDose = (medicine: Medicine, doseTime: MedicineDoseTime, dateStr: string = logDate) => {
    const id = medicineLogId(manageTargetUid, medicine.id, doseTime.id, dateStr);
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
  const [filterIncident, setFilterIncident] = useState('all');
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [tableCollapsed, setTableCollapsed] = useState(false);

  const shareableMembers = useMemo(() => {
    const uids = Array.from(new Set(medicines.filter((m) => m.userId !== user?.uid).map((m) => m.userId)));
    return uids.map(resolveSharer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medicines, allMembers, friendUsersByUid, user]);

  const viewMedicines = useMemo(() => medicines.filter((m) => m.userId === viewTargetUid), [medicines, viewTargetUid]);
  const viewIncidents = useMemo(() => incidents.filter((inc) => inc.userId === viewTargetUid), [incidents, viewTargetUid]);
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
        if (filterIncident !== 'all' && (med.incidentId || GENERAL_INCIDENT_ID) !== filterIncident) return;
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
  }, [viewMedicines, rangeStart, rangeEnd, today, filterMedicineId, filterIncident, viewTargetUid, logsById]);

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
    setFilterIncident('all');
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

  // One incident's card — colored header, tinted "shell" holding its medicines, Edit/Delete +
  // Add Medicine. Shared by the main Medicines tab list and the Historic Illnesses umbrella
  // section below, since an ended incident's own card looks identical to an active one once
  // you've actually opened the umbrella to see it — only WHERE it's grouped differs.
  // `forceSolo` mirrors the original "a lone General bucket renders as a plain flat list, no
  // colored header" behavior — passed as true only when this is the single section in its list.
  const renderIncidentSection = (incidentId: string, meds: Medicine[], forceSolo: boolean) => {
    const isGeneral = incidentId === GENERAL_INCIDENT_ID;
    const incident = isGeneral ? null : incidents.find((i) => i.id === incidentId) || null;
    const style = isGeneral ? { bg: 'bg-surface-container-high', light: 'bg-surface-container', icon: 'medication' } : incidentStyle(incident?.name || '');
    const sectionLabel = isGeneral ? t('medicine.generalIncident') : incident?.name || '';
    const expanded = forceSolo || expandedIncidents.has(incidentId);
    const canManageIncident = isGeneral ? true : incident?.userId === user?.uid || incident?.loggedBy === user?.uid;
    return (
      <div key={incidentId} className={clsx(forceSolo ? 'space-y-2' : 'rounded-2xl overflow-hidden shadow-sm border border-border-subtle')}>
        {!forceSolo && (
          <button
            type="button"
            onClick={() => toggleIncidentExpanded(incidentId)}
            className={clsx('w-full flex items-center gap-2 px-3 py-2.5', style.bg, isGeneral ? 'text-text-muted' : 'text-white')}
          >
            <span className="material-symbols-outlined text-[18px] shrink-0">{style.icon}</span>
            <span className="flex-1 min-w-0 text-left text-sm font-bold truncate">{sectionLabel}</span>
            <span className={clsx('shrink-0 text-[10px] font-black rounded-full px-2 py-0.5', isGeneral ? 'bg-surface text-text-muted' : 'bg-white/25')}>{meds.length}</span>
            <span className={clsx('material-symbols-outlined text-[18px] shrink-0 transition-transform', expanded && 'rotate-180')}>expand_more</span>
          </button>
        )}
        {expanded && (
          // The tinted "shell" is what makes the medicines underneath read as BELONGING TO this
          // incident (not just sitting below an unrelated header) — same light-tint-of-the-
          // header-color idea for every section, General included (using a neutral gray tint
          // rather than a hue, since General isn't color-themed).
          <div className={clsx('space-y-2', !forceSolo && ['p-2.5', style.light])}>
            {!isGeneral && incident?.description && (
              <p className="text-[11px] text-text-muted px-1">{incident.description}</p>
            )}
            <div className="flex items-center justify-between gap-2 px-1">
              {!isGeneral && canManageIncident && incident ? (
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => openEditIncident(incident)} className="text-[10px] font-bold text-primary flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px]">edit</span>{t('common.edit')}
                  </button>
                  <button type="button" onClick={() => handleDeleteIncident(incident)} className="text-[10px] font-bold text-error flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px]">delete</span>{t('medicine.deleteIncident')}
                  </button>
                </div>
              ) : <span />}
              <button
                type="button"
                onClick={() => openAddMedicine(isGeneral ? undefined : incidentId)}
                className="py-1.5 px-3 bg-primary/5 border border-primary/20 text-primary font-bold text-[11px] rounded-lg flex items-center justify-center gap-1 shrink-0"
              >
                <span className="material-symbols-outlined text-[14px]">add</span>
                {t('medicine.addMedicine')}
              </button>
            </div>
            {meds.length === 0 ? (
              <p className="text-xs text-text-muted text-center py-4">{t('medicine.noMedicinesInSection')}</p>
            ) : (
              meds.map((med) => (
                <MedicineCard
                  key={med.id}
                  med={med}
                  status={medicineStatusLabel(med, today)}
                  canManage={med.userId === user?.uid || med.loggedBy === user?.uid}
                  expanded={expandedMedicineIds.has(med.id)}
                  onToggleExpand={() => toggleMedicineExpanded(med.id)}
                  onEdit={openEditMedicine}
                  onTogglePause={handleTogglePause}
                  onDelete={handleDeleteMedicine}
                  doseTimeSummary={doseTimeSummary}
                  durationSummary={durationSummary}
                  allLogs={allLogs}
                  today={today}
                  t={t}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-3 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-primary leading-tight">{t('medicine.tracker')}</h1>
            <p className="text-[11px] text-text-muted leading-tight">{t('medicine.trackerDesc')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openSettingsMenu}
              className="w-9 h-9 rounded-xl bg-white border border-border-subtle flex items-center justify-center text-primary hover:bg-primary/5 transition-colors"
              title={t('health.settings')}
            >
              <span className="material-symbols-outlined text-[18px]">settings</span>
            </button>
          </div>
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
          <div className="space-y-4">
            {pendingDueToday.length > 0 && (
              <div className="rounded-2xl overflow-hidden shadow-sm border border-warning/30 bg-warning/5">
                <div className="flex items-center gap-2 px-3 py-2.5 bg-warning/10">
                  <span className="material-symbols-outlined text-[18px] text-warning shrink-0">notifications_active</span>
                  <span className="flex-1 min-w-0 text-sm font-bold text-primary truncate">{t('medicine.dueTodayTitle')}</span>
                  <span className="shrink-0 text-[10px] font-black rounded-full px-2 py-0.5 bg-warning/20 text-warning">{pendingDueToday.length}</span>
                </div>
                <div className="p-2.5 space-y-2">
                  {pendingDueToday.map(({ medicine, doseTime }) => {
                    const id = medicineLogId(manageTargetUid, medicine.id, doseTime.id, todayStr);
                    return (
                      <div key={id} className="bg-white rounded-2xl border border-border-subtle shadow-sm p-2.5 flex items-center gap-2.5">
                        <span className="shrink-0 w-9 h-9 rounded-full bg-surface-container-high text-text-muted flex items-center justify-center">
                          <span className="material-symbols-outlined text-[18px]">medication</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-primary text-sm truncate">{medicine.name}{medicine.dosage ? <span className="text-text-muted font-semibold"> · {medicine.dosage}</span> : null}</p>
                          <p className="text-[13px] font-bold text-text truncate">{formatDoseTimeDisplay(doseTime.time)} · {foodTimingLabel(doseTime.foodTiming)}</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-2.5">
                          <button type="button" onClick={() => handleMarkDose(medicine, doseTime, 'taken', todayStr)} className="flex flex-col items-center gap-0.5" aria-label={t('medicine.markTaken')}>
                            <span className="w-9 h-9 rounded-full bg-success/15 text-success flex items-center justify-center">
                              <span className="material-symbols-outlined text-[20px]">check</span>
                            </span>
                            <span className="text-[9px] font-bold text-success">{t('medicine.doseStatusTaken')}</span>
                          </button>
                          <button type="button" onClick={() => handleMarkDose(medicine, doseTime, 'skipped', todayStr)} className="flex flex-col items-center gap-0.5" aria-label={t('medicine.markSkipped')}>
                            <span className="w-9 h-9 rounded-full bg-surface-container-high text-text-muted flex items-center justify-center">
                              <span className="material-symbols-outlined text-[20px]">close</span>
                            </span>
                            <span className="text-[9px] font-bold text-text-muted">{t('medicine.doseStatusSkipped')}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={openAddIncident}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-primary bg-white border border-dashed border-primary/30 hover:bg-primary/5 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              {t('medicine.addIncident')}
            </button>
            {medicinesByIncident.map(([incidentId, meds]) => renderIncidentSection(incidentId, meds, medicinesByIncident.length <= 1))}
            {historicMedicinesByIncident.length > 0 && (
              <div className="rounded-2xl overflow-hidden shadow-sm border border-border-subtle">
                <button
                  type="button"
                  onClick={() => setHistoricExpanded((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface-container-high text-text-muted"
                >
                  <span className="material-symbols-outlined text-[18px] shrink-0">history</span>
                  <span className="flex-1 min-w-0 text-left text-sm font-bold truncate">{t('medicine.historicIllnesses')}</span>
                  <span className="shrink-0 text-[10px] font-black rounded-full px-2 py-0.5 bg-surface text-text-muted">{historicMedicinesByIncident.length}</span>
                  <span className={clsx('material-symbols-outlined text-[18px] shrink-0 transition-transform', historicExpanded && 'rotate-180')}>expand_more</span>
                </button>
                {historicExpanded && (
                  <div className="p-2.5 bg-surface-container space-y-3">
                    {historicMedicinesByIncident.map(([incidentId, meds]) => renderIncidentSection(incidentId, meds, false))}
                  </div>
                )}
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

            {manageIncidents.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] text-text-muted px-1 font-bold uppercase tracking-wider">{t('medicine.incident')}</label>
                <select value={logFilterIncident} onChange={(e) => setLogFilterIncident(e.target.value)} className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none">
                  <option value="all">{t('medicine.allIncidents')}</option>
                  {manageIncidents.map((inc) => <option key={inc.id} value={inc.id}>{inc.name}</option>)}
                  <option value={GENERAL_INCIDENT_ID}>{t('medicine.generalIncident')}</option>
                </select>
              </div>
            )}

            {dueToday.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-8">{t('medicine.noDosesDue')}</p>
            ) : (
              (() => {
                const sortedDueToday = dueToday.slice().sort((a, b) => a.doseTime.time.localeCompare(b.doseTime.time));
                const isPastDate = logDate < todayLocalDateString();
                const takenCount = sortedDueToday.filter(
                  ({ medicine, doseTime }) => dueLogsById.get(medicineLogId(manageTargetUid, medicine.id, doseTime.id, logDate))?.status === 'taken',
                ).length;
                const adherencePct = Math.round((takenCount / sortedDueToday.length) * 100);
                return (
                  <>
                    <div className="rounded-2xl overflow-hidden border border-border-subtle shadow-sm divide-y divide-border-subtle">
                      {sortedDueToday.map(({ medicine, doseTime }, idx) => {
                        const id = medicineLogId(manageTargetUid, medicine.id, doseTime.id, logDate);
                        const log = dueLogsById.get(id);
                        const expanded = expandedLogIds.has(id);
                        return (
                          <div key={id} className={clsx(idx % 2 === 1 && 'bg-surface-container')}>
                            <div className="flex items-center gap-2.5 p-3">
                              <span className="shrink-0 w-8 h-8 rounded-full bg-surface-container-high text-text-muted flex items-center justify-center">
                                <span className="material-symbols-outlined text-[16px]">medication</span>
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="font-bold text-primary text-sm truncate">{medicine.name}{medicine.dosage ? <span className="text-text-muted font-semibold"> · {medicine.dosage}</span> : null}</p>
                                <p className="text-[11px] text-text-muted truncate">{doseTime.label} {doseTime.time} · {foodTimingLabel(doseTime.foodTiming)}</p>
                              </div>
                              <div className="shrink-0 flex items-center gap-1.5">
                                {log ? (
                                  <span className={clsx('text-[11px] font-bold text-right', log.status === 'taken' ? 'text-success' : 'text-warning')}>
                                    {log.status === 'taken' ? t('medicine.statusTakenAt', { time: formatLoggedTime(log.loggedAt) }) : t('medicine.statusSkippedAt', { time: formatLoggedTime(log.loggedAt) })}
                                  </span>
                                ) : (
                                  <span className={clsx('text-[11px] font-bold text-right', isPastDate ? 'text-error' : 'text-text-muted')}>
                                    {isPastDate ? t('medicine.statusMissedNoAction') : t('medicine.doseStatusPending')}
                                  </span>
                                )}
                                <button type="button" onClick={() => toggleLogExpanded(id)} className="w-7 h-7 rounded-full flex items-center justify-center text-text-muted hover:bg-surface-container-high" aria-label={t('common.edit')}>
                                  <span className="material-symbols-outlined text-[16px]">edit</span>
                                </button>
                              </div>
                            </div>
                            {expanded && (
                              <div className="px-3 pb-3">
                                {log ? (
                                  <button type="button" onClick={() => { handleUndoDose(medicine, doseTime, logDate); toggleLogExpanded(id); }} className="w-full py-1.5 text-[11px] font-bold text-text-muted border border-border-subtle rounded-lg bg-white">
                                    {t('medicine.undo')}
                                  </button>
                                ) : (
                                  <div className="flex gap-1.5">
                                    <button type="button" onClick={() => { handleMarkDose(medicine, doseTime, 'taken', logDate); toggleLogExpanded(id); }} className="flex-1 py-1.5 bg-success/10 text-success text-[11px] font-bold rounded-lg">
                                      {t('medicine.markTaken')}
                                    </button>
                                    <button type="button" onClick={() => { handleMarkDose(medicine, doseTime, 'skipped', logDate); toggleLogExpanded(id); }} className="flex-1 py-1.5 bg-white text-text-muted text-[11px] font-bold rounded-lg border border-border-subtle">
                                      {t('medicine.markSkipped')}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-3 space-y-1">
                      <p className="font-bold text-primary text-sm">{t('medicine.adherenceSummary')}</p>
                      <p className="text-xs text-text-muted">
                        {t(isPastDate ? 'medicine.adherenceLineDate' : 'medicine.adherenceLineToday', { pct: adherencePct, taken: takenCount, total: sortedDueToday.length })}
                      </p>
                    </div>
                  </>
                );
              })()
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
              {viewIncidents.length > 0 && (
                <select value={filterIncident} onChange={(e) => setFilterIncident(e.target.value)} className="w-full bg-surface border border-border-subtle rounded-lg px-1.5 py-1.5 text-[10px] font-bold text-primary outline-none">
                  <option value="all">{t('medicine.allIncidents')}</option>
                  {viewIncidents.map((inc) => <option key={inc.id} value={inc.id}>{inc.name}</option>)}
                  <option value={GENERAL_INCIDENT_ID}>{t('medicine.generalIncident')}</option>
                </select>
              )}
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

            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.name')}</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={t('medicine.namePlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
              </div>
              <div className="w-28 shrink-0 space-y-1">
                <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.dosage')}</label>
                <input type="text" value={formDosage} onChange={(e) => setFormDosage(e.target.value)} placeholder={t('medicine.dosagePlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.incident')}</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setFormIncidentId('')}
                  className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border transition-all', formIncidentId === '' ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                >
                  {t('medicine.generalIncident')}
                </button>
                {activeIncidentsForForm.map((inc) => (
                  <button
                    key={inc.id}
                    type="button"
                    onClick={() => setFormIncidentId(inc.id)}
                    className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border transition-all', formIncidentId === inc.id ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                  >
                    {inc.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.doseTimes')}</label>
              {/* formTimes is already sorted+labeled — every setter below pipes through
                  withAutoDoseLabels. Read-only rows render in that (chronological) order; the one
                  slot in focus (if any) is pulled out of that flow and always shown last, directly
                  above "+ Add dose time" — its own position doesn't need to reflect its time,
                  since it's a staging area, not part of the settled list. */}
              {formTimes.filter((s) => s.id !== editingDoseTimeId).map((slot) => (
                <div key={slot.id} className="flex items-center gap-1.5 bg-surface border border-border-subtle rounded-lg p-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-primary">{formatDoseTimeDisplay(slot.time)} <span className="text-text-muted font-semibold">· {slot.label}</span></p>
                    <p className="text-[10px] text-text-muted mt-0.5">{foodTimingLabel(slot.foodTiming)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingDoseTimeId(slot.id)}
                    className="shrink-0 px-2.5 py-1 rounded-md text-[10px] font-bold text-primary border border-primary/30"
                  >
                    {t('common.edit')}
                  </button>
                  {formTimes.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setFormTimes((ts) => withAutoDoseLabels(ts.filter((s) => s.id !== slot.id)))}
                      className="shrink-0 p-1 text-text-muted hover:text-error transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  )}
                </div>
              ))}
              {(() => {
                const slot = formTimes.find((s) => s.id === editingDoseTimeId);
                if (!slot) return null;
                const isNew = !originalDoseTimeIds.has(slot.id);
                return (
                  <div className="relative rounded-lg p-2 pt-4 space-y-1.5 bg-blue-50 border border-dashed border-blue-300">
                    <span className="absolute -top-2 right-2 bg-blue-500 text-white text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full">
                      {isNew ? t('medicine.newBadge') : t('medicine.editingBadge')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="time"
                        value={slot.time}
                        onClick={(e) => {
                          // Native time inputs are supposed to open their picker on any tap, but
                          // that isn't reliable on every WebView — calling showPicker() explicitly
                          // guarantees it rather than depending on exactly where inside the field
                          // was tapped. showPicker() is itself guarded (older WebView versions
                          // don't have it) — the input still works as a normal tappable field
                          // either way.
                          const el = e.currentTarget;
                          try { el.showPicker?.(); } catch { /* unsupported — plain tap-to-open still applies */ }
                        }}
                        onChange={(e) => {
                          const val = e.target.value;
                          setFormTimes((ts) => withAutoDoseLabels(ts.map((s) => (s.id === slot.id ? { ...s, time: val } : s))));
                        }}
                        className="w-28 shrink-0 bg-white border border-border-subtle rounded-md px-2 py-1 text-xs font-bold text-primary outline-none"
                      />
                      {/* Label is purely computed from the time above — see withAutoDoseLabels —
                          never directly editable, so this is plain text, not an input. */}
                      <span className="flex-1 min-w-0 text-right text-xs font-bold text-text-muted truncate px-1">{slot.label}</span>
                      {formTimes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            setFormTimes((ts) => withAutoDoseLabels(ts.filter((s) => s.id !== slot.id)));
                            setEditingDoseTimeId(null);
                          }}
                          className="shrink-0 p-1 text-text-muted hover:text-error transition-colors"
                        >
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {FOOD_TIMING_OPTIONS.map((ft) => (
                        <button
                          key={ft}
                          type="button"
                          onClick={() => setFormTimes((ts) => ts.map((s) => (s.id === slot.id ? { ...s, foodTiming: ft } : s)))}
                          className={clsx('flex-1 py-1 rounded-md text-[9px] font-bold border transition-all', slot.foodTiming === ft ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                        >
                          {foodTimingLabel(ft)}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingDoseTimeId(null)}
                      className="w-full py-1.5 rounded-md text-xs font-bold text-white bg-primary flex items-center justify-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[14px]">check</span>
                      {t('common.save')}
                    </button>
                  </div>
                );
              })()}
              <button
                type="button"
                onClick={() => {
                  const newId = newDoseTimeId();
                  setFormTimes((ts) => withAutoDoseLabels([...ts, { id: newId, label: '', time: '12:00', foodTiming: 'any' }]));
                  setEditingDoseTimeId(newId);
                }}
                className="w-full py-2 rounded-lg text-xs font-bold text-primary border border-dashed border-primary/30 hover:bg-primary/5 transition-colors"
              >
                + {t('medicine.addDoseTime')}
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('medicine.repeatsOn')}</label>
              <div className="flex gap-1.5">
                {(['daily', 'specific', 'alternate'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setFormRepeatMode(mode)}
                    className={clsx('flex-1 py-2 rounded-lg text-[10px] font-bold border transition-all', formRepeatMode === mode ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                  >
                    {t(`medicine.repeat${mode.charAt(0).toUpperCase()}${mode.slice(1)}`)}
                  </button>
                ))}
              </div>
              {formRepeatMode === 'specific' && (
                <div className="flex gap-1">
                  {WEEKDAY_LABELS.map((label, idx) => {
                    const selected = formWeekdays.includes(idx);
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setFormWeekdays((prev) => (prev.includes(idx) ? prev.filter((d) => d !== idx) : [...prev, idx]))}
                        className={clsx('flex-1 py-1.5 rounded-lg text-[10px] font-bold border transition-all', selected ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle')}
                      >
                        {label.slice(0, 1)}
                      </button>
                    );
                  })}
                </div>
              )}
              {formRepeatMode === 'alternate' && (
                <p className="text-[10px] text-text-muted px-1">{t('medicine.alternateHint')}</p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.startDate')}</label>
              <input type="date" value={formStartDate} onChange={(e) => setFormStartDate(e.target.value)} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('medicine.duration')}</label>
              <div className="flex gap-1.5">
                {(['dayCount', 'endDate', 'ongoing'] as const).map((mode) => (
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

      {incidentForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setIncidentForm(false)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-primary flex-1">{editingIncident ? t('medicine.editIncident') : t('medicine.addIncident')}</h2>
              <button type="button" onClick={() => setIncidentForm(false)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.incidentName')}</label>
              <input
                type="text"
                value={incidentFormName}
                onChange={(e) => setIncidentFormName(e.target.value)}
                placeholder={t('medicine.incidentNamePlaceholder')}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.incidentDescription')}</label>
              <textarea
                value={incidentFormDescription}
                onChange={(e) => setIncidentFormDescription(e.target.value)}
                placeholder={t('medicine.incidentDescriptionPlaceholder')}
                rows={3}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-primary outline-none resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted px-1">{t('medicine.incidentEndDate')}</label>
              <input
                type="date"
                value={incidentFormEndDate}
                onChange={(e) => setIncidentFormEndDate(e.target.value)}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
              />
              <p className="text-[10px] text-text-muted px-1">{t('medicine.incidentEndDateHint')}</p>
            </div>
            <button type="button" onClick={handleSaveIncident} disabled={savingIncident || !incidentFormName.trim()} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {savingIncident ? t('common.saving') : t('common.save')}
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
