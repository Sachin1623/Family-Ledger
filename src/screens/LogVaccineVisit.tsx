import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { collection, deleteDoc, doc, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { todayLocalDateString } from '../lib/dateUtils';
import { VaccineDose, VaccineDoseGroup, VaccineBrandCatalogEntry, VaccineAppointment, vaccineAppointmentId, appointmentSummaryText } from '../lib/vaccinations';
import { cancelVaccineRemindersForVisit } from '../lib/vaccinationReminders';
import { getParentPath } from '../lib/navigationParents';
import ImageAttachments from '../components/ImageAttachments';
import VaccineAppointmentModal from '../components/VaccineAppointmentModal';

// A vaccine only becomes "given" by being assigned to a SHOT (see ShotState) — there is no
// standalone given/not-given toggle or per-vaccine brand/batch/photo any more. This mirrors real
// life: the doctor gives a physical injection (the shot), which may cover one vaccine name or
// several at once, and the proof (brand/batch/photo) belongs to that injection, not to each name.
interface VaccineRowState {
  isNew: boolean;
  source: 'template' | 'custom';
  vaccineName: string;
  doseNumber: string;
  // Which shot (local key into `shots` below) this vaccine is assigned to — presence IS "given".
  groupKey: string | null;
  notGivenReason: string;
}

interface ShotState {
  name: string;
  brand: string;
  batch: string;
  expiryDate: string;
  photoFront: string | null;
  photoBack: string | null;
}

let nextTempId = 1;
let nextShotTempId = 1;

export default function LogVaccineVisit() {
  const { profileId, visitKey } = useParams<{ profileId: string; visitKey: string }>();
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = () => navigate(getParentPath(location.pathname, location.search));

  const [profileSnap] = useDocument(profileId ? doc(db, 'babyProfiles', profileId) : null);
  const babyName = profileSnap?.exists() ? (profileSnap.data() as any).name : '';
  const babyPhoto = profileSnap?.exists() ? (profileSnap.data() as any).photo : null;

  const [dosesValue] = useCollection(
    profileId && visitKey ? query(collection(db, 'vaccineDoses'), where('profileId', '==', profileId), where('visitKey', '==', visitKey)) : null,
  );
  const doses: VaccineDose[] = useMemo(() => (dosesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [dosesValue]);
  const visitLabel = doses[0]?.visitLabel || '';

  // Shots this visit's own doses point to (see VaccineDoseGroup) — fetched so an existing shot's
  // name/brand/batch/expiry/photo can be seeded below.
  const [doseGroupsValue] = useCollection(profileId ? query(collection(db, 'vaccineDoseGroups'), where('profileId', '==', profileId)) : null);
  const groupsById = useMemo(() => {
    const m = new Map<string, VaccineDoseGroup>();
    (doseGroupsValue?.docs || []).forEach((d) => m.set(d.id, { id: d.id, ...(d.data() as any) }));
    return m;
  }, [doseGroupsValue]);
  // AI-curated suggestions (refreshed every 3 months) for common shot names/brands and the
  // vaccines each covers (see server.ts's /api/cron/refresh-vaccine-brand-catalog) — purely
  // optional, the "Add a shot" flow works fine with none of this loaded.
  const [brandCatalogSnap] = useDocument(doc(db, 'vaccineBrandCatalog', 'current'));
  const brandCatalog: VaccineBrandCatalogEntry[] = brandCatalogSnap?.exists() ? (brandCatalogSnap.data() as any).entries || [] : [];
  // A visit reached with no existing doses at all is a brand-new one (see BabyVaccinations.tsx's
  // "Add a Visit" button) — `dosesValue !== undefined` waits for the query's first snapshot so
  // this doesn't briefly read as "new" before the real doses have even loaded.
  const isNewVisit = dosesValue !== undefined && doses.length === 0;

  // Every other visit this baby has (any status, current one excluded) — only fetched/grouped to
  // power the "copy from existing visit" shortcut below, so a new visit doesn't have to be built
  // one vaccine at a time when it's really the same list as, say, an earlier custom visit.
  const [allDosesValue] = useCollection(profileId ? query(collection(db, 'vaccineDoses'), where('profileId', '==', profileId)) : null);
  const existingVisits = useMemo(() => {
    const byKey = new Map<string, { visitKey: string; visitLabel: string; dueDate: string; doses: VaccineDose[] }>();
    (allDosesValue?.docs || []).forEach((docSnap) => {
      const d = { id: docSnap.id, ...(docSnap.data() as any) } as VaccineDose;
      if (d.deletedAt || d.visitKey === visitKey) return;
      if (!byKey.has(d.visitKey)) byKey.set(d.visitKey, { visitKey: d.visitKey, visitLabel: d.visitLabel, dueDate: d.dueDate, doses: [] });
      byKey.get(d.visitKey)!.doses.push(d);
    });
    return Array.from(byKey.values()).sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  }, [allDosesValue, visitKey]);
  const [showCopyModal, setShowCopyModal] = useState(false);

  const [apptSnap] = useDocument(profileId && visitKey ? doc(db, 'vaccineAppointments', vaccineAppointmentId(profileId, visitKey)) : null);
  const appt: VaccineAppointment | undefined = apptSnap?.exists() ? ({ id: apptSnap.id, ...(apptSnap.data() as any) }) : undefined;
  const [showAppointmentModal, setShowAppointmentModal] = useState(false);

  const [visitDate, setVisitDate] = useState(todayLocalDateString());
  const [clinic, setClinic] = useState('');
  const [doctor, setDoctor] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const effectiveVisitLabel = visitLabel || customLabel.trim() || t('babyVax.customVisit');
  const [rowOrder, setRowOrder] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, VaccineRowState>>({});
  const [shotOrder, setShotOrder] = useState<string[]>([]);
  const [shots, setShots] = useState<Record<string, ShotState>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);
  // Set right after a successful save — drives the post-save modal, which can offer BOTH a
  // one-click follow-up visit for anything left not-given AND the usual "log this as an expense"
  // prompt, depending on what actually happened in that save.
  const [postSave, setPostSave] = useState<{ followUpIds: string[]; showExpense: boolean } | null>(null);
  // Which shot's detail popup is open, if any — at most one at a time.
  const [openShotModalId, setOpenShotModalId] = useState<string | null>(null);
  const [showAddShotModal, setShowAddShotModal] = useState(false);
  const [newShotName, setNewShotName] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [inlineVaccineName, setInlineVaccineName] = useState('');

  // Seed row + shot state from loaded doses exactly once each dose first appears.
  useEffect(() => {
    // A shot's own name/brand/batch/expiry/photo live on its vaccineDoseGroups doc — if groups
    // haven't loaded yet, wait rather than seeding blanks this effect would never revisit (it only
    // ever seeds each id ONCE).
    if (doseGroupsValue === undefined) return;
    setRows((prev) => {
      const next = { ...prev };
      doses.forEach((d) => {
        if (next[d.id]) return;
        next[d.id] = {
          isNew: false, source: d.source || 'template',
          vaccineName: d.vaccineName, doseNumber: String(d.doseNumber),
          groupKey: d.doseGroupId || null,
          notGivenReason: '',
        };
      });
      return next;
    });
    setRowOrder((prevOrder) => {
      const existing = new Set(prevOrder);
      const added = doses.map((d) => d.id).filter((id) => !existing.has(id));
      return [...prevOrder, ...added];
    });
    setShots((prev) => {
      const next = { ...prev };
      doses.forEach((d) => {
        if (!d.doseGroupId || next[d.doseGroupId]) return;
        const group = groupsById.get(d.doseGroupId);
        if (!group) return; // not loaded yet — the next run of this effect (doseGroupsValue changing) will pick it up
        next[d.doseGroupId] = {
          name: group.name || '', brand: group.brand || '', batch: group.batchNo || '', expiryDate: group.expiryDate || '',
          photoFront: group.photoFront || null, photoBack: group.photoBack || null,
        };
      });
      return next;
    });
    setShotOrder((prevOrder) => {
      const existing = new Set(prevOrder);
      const added = doses.map((d) => d.doseGroupId).filter((id): id is string => !!id && !existing.has(id) && groupsById.has(id));
      // De-dupe — several doses can point at the same shot.
      const seen = new Set(existing);
      const uniqueAdded = added.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
      return [...prevOrder, ...uniqueAdded];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doses, doseGroupsValue]);

  // Seed the shared visit date from the visit's existing schedule exactly once, so opening this
  // screen doesn't silently default every not-yet-given dose's due date to today on save — only a
  // brand-new visit (no existing doses) keeps the today() default from useState above.
  const visitDateSeeded = React.useRef(false);
  useEffect(() => {
    if (visitDateSeeded.current || dosesValue === undefined || doses.length === 0) return;
    visitDateSeeded.current = true;
    setVisitDate(doses.find((d) => d.givenDate)?.givenDate || doses[0].dueDate || todayLocalDateString());
  }, [dosesValue, doses]);

  // A dose's deletedAt lives on the Firestore doc itself (doses, the live query result) — not on
  // local row state — so "deleted" here means the exact same thing it means everywhere else this
  // field is read (BabyVaccinations.tsx's Deleted section, VaccineVisitDetail.tsx). Restoring one
  // just clears deletedAt, which flows straight back through this same live query.
  const deletedDoseIds = useMemo(() => new Set(doses.filter((d) => d.deletedAt).map((d) => d.id)), [doses]);
  const deletedDoses = useMemo(() => doses.filter((d) => d.deletedAt), [doses]);
  // Removing an already-persisted dose from this visit (trash icon, or the discard step of "copy
  // from an existing visit") is staged here, not written to Firestore, until Save actually commits
  // it — matches every other edit on this screen. Writing immediately meant hitting Cancel/the
  // header back button right after a delete permanently lost that visit's vaccines even though
  // nothing was ever saved.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const pendingDeleteDoses = useMemo(() => doses.filter((d) => pendingDeleteIds.has(d.id)), [doses, pendingDeleteIds]);
  const visibleRowIds = rowOrder.filter((id) => rows[id] && !deletedDoseIds.has(id) && !pendingDeleteIds.has(id));
  const givenCount = visibleRowIds.filter((id) => rows[id]?.groupKey).length;
  const visibleShotIds = shotOrder.filter((id) => shots[id]);

  const updateRow = (id: string, patch: Partial<VaccineRowState>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const updateShot = (shotKey: string, patch: Partial<ShotState>) => setShots((s) => ({ ...s, [shotKey]: { ...s[shotKey], ...patch } }));

  const assignVaccineToShot = (vaccineId: string, shotKey: string) => updateRow(vaccineId, { groupKey: shotKey });
  const unassignVaccine = (vaccineId: string) => updateRow(vaccineId, { groupKey: null });

  // "+ Add Shot" — name is the only thing required to create one; vaccines, photo, brand and batch
  // can all be filled in afterward (or never, for a bare-minimum record). Creating one opens its
  // full detail popup right away so there's somewhere to add vaccines to it next.
  const confirmAddShot = () => {
    const name = newShotName.trim();
    if (!name) return;
    const shotKey = `shot_${nextShotTempId++}`;
    setShots((s) => ({ ...s, [shotKey]: { name, brand: '', batch: '', expiryDate: '', photoFront: null, photoBack: null } }));
    setShotOrder((o) => [...o, shotKey]);
    setShowAddShotModal(false);
    setNewShotName('');
    setCatalogSearch('');
    setOpenShotModalId(shotKey);
  };

  // Picking a suggestion from the AI-curated brand catalog (see brandCatalog above) instead of
  // typing a name by hand — pre-fills the shot's brand too, and auto-assigns any currently-
  // unassigned vaccine on this visit whose name matches one this product covers, so picking e.g.
  // "Pentavalent (5-in-1)" checks off DTP/HepB/Hib in one tap instead of five.
  const createShotFromCatalog = (entry: VaccineBrandCatalogEntry) => {
    const shotKey = `shot_${nextShotTempId++}`;
    setShots((s) => ({ ...s, [shotKey]: { name: entry.shotName, brand: entry.brand, batch: '', expiryDate: '', photoFront: null, photoBack: null } }));
    setShotOrder((o) => [...o, shotKey]);
    const wantedNames = entry.vaccines.map((v) => v.toLowerCase());
    setRows((r) => {
      const next = { ...r };
      Object.keys(next).forEach((id) => {
        if (next[id].groupKey) return;
        const nameLower = next[id].vaccineName.toLowerCase();
        if (nameLower && wantedNames.some((w) => nameLower.includes(w) || w.includes(nameLower))) {
          next[id] = { ...next[id], groupKey: shotKey };
        }
      });
      return next;
    });
    setShowAddShotModal(false);
    setNewShotName('');
    setCatalogSearch('');
    setOpenShotModalId(shotKey);
  };

  // Deleting a shot un-assigns every vaccine currently in it (they fall back to not-given, still
  // listed, ready to be added to a different shot) rather than deleting the vaccines themselves.
  const deleteShot = (shotKey: string) => {
    if (!window.confirm(t('babyVax.confirmDeleteShot'))) return;
    setRows((r) => {
      const next = { ...r };
      Object.keys(next).forEach((id) => { if (next[id].groupKey === shotKey) next[id] = { ...next[id], groupKey: null }; });
      return next;
    });
    setShots((s) => { const next = { ...s }; delete next[shotKey]; return next; });
    setShotOrder((o) => o.filter((id) => id !== shotKey));
    setOpenShotModalId(null);
  };

  // Adds a brand-new vaccine (not on the visit's existing list) directly into a shot — the "given
  // for something not in the list" case never has to leave this popup to go add it elsewhere first.
  const addVaccineToShot = (shotKey: string) => {
    const name = inlineVaccineName.trim();
    if (!name) return;
    const id = `new_${nextTempId++}`;
    setRows((r) => ({
      ...r,
      [id]: { isNew: true, source: 'custom', vaccineName: name, doseNumber: '1', groupKey: shotKey, notGivenReason: '' },
    }));
    setRowOrder((o) => [...o, id]);
    setInlineVaccineName('');
  };

  // A row that was never actually persisted (still being drafted) just drops out of local state. A
  // real dose is only staged for removal (see pendingDeleteIds above) — it moves to "Deleted
  // vaccines in this visit" with an Undo option, and only actually gets soft-deleted in Firestore
  // when Save is pressed.
  const handleDeleteDose = (id: string) => {
    const row = rows[id];
    if (!row) return;
    if (row.isNew) {
      setRows((r) => { const next = { ...r }; delete next[id]; return next; });
      setRowOrder((o) => o.filter((rowId) => rowId !== id));
      return;
    }
    setPendingDeleteIds((s) => new Set(s).add(id));
  };
  const undoDeleteDose = (id: string) => setPendingDeleteIds((s) => { const next = new Set(s); next.delete(id); return next; });

  const handleRestoreDose = async (id: string) => {
    if (!user) return;
    try {
      const now = new Date().toISOString();
      await updateDoc(doc(db, 'vaccineDoses', id), { deletedAt: null, loggedBy: user.uid, updatedAt: now });
    } catch (err) {
      console.error('Failed to restore vaccine:', err);
      alert(t('babyVax.saveVisitFailed'));
    }
  };

  const handlePermanentlyDeleteDose = async (id: string) => {
    if (!window.confirm(t('babyVax.confirmDeleteVisitPermanently'))) return;
    try {
      await deleteDoc(doc(db, 'vaccineDoses', id));
    } catch (err) {
      console.error('Failed to permanently delete vaccine:', err);
      alert(t('babyVax.saveVisitFailed'));
    }
  };

  const addRow = () => {
    const id = `new_${nextTempId++}`;
    setRows((r) => ({
      ...r,
      [id]: { isNew: true, source: 'custom', vaccineName: '', doseNumber: '1', groupKey: null, notGivenReason: '' },
    }));
    setRowOrder((o) => [...o, id]);
  };

  // Discards whatever's currently listed on this visit (soft-deleting any already-persisted dose,
  // dropping any still-local unsaved row) and replaces it with a fresh copy of a past visit's
  // vaccines — names only, dose numbers moved up by one (this visit is the NEXT occurrence of that
  // same series, not a repeat of the same dose). Shots are visit-specific and never copied.
  const copyFromVisit = (visit: { doses: VaccineDose[] }) => {
    if (visibleRowIds.length > 0 && !window.confirm(t('babyVax.confirmDiscardAndCopy'))) return;
    visibleRowIds.forEach((id) => handleDeleteDose(id));

    const newRows: Record<string, VaccineRowState> = {};
    const newIds: string[] = [];
    visit.doses.forEach((d) => {
      const id = `new_${nextTempId++}`;
      newRows[id] = {
        isNew: true, source: d.source || 'template',
        vaccineName: d.vaccineName, doseNumber: String((d.doseNumber || 0) + 1),
        groupKey: null, notGivenReason: '',
      };
      newIds.push(id);
    });
    setRows((r) => ({ ...r, ...newRows }));
    setRowOrder((o) => [...o, ...newIds]);
    setShowCopyModal(false);
  };

  const handleSave = async () => {
    if (!user || !profileId || !visitKey || saving) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);

      // Resolves a local shot key to a real vaccineDoseGroups doc id, writing that shot's fields.
      // A key that's already a real Firestore id (seeded from an existing dose's doseGroupId, not
      // our `shot_N` temp shape) updates that same doc instead of creating a new one. Memoized per
      // save so every vaccine in the same shot resolves to the identical doc.
      const shotKeyToRealId = new Map<string, string>();
      const resolveShotId = (shotKey: string): string => {
        const cached = shotKeyToRealId.get(shotKey);
        if (cached) return cached;
        const isExisting = !shotKey.startsWith('shot_');
        const shot = shots[shotKey];
        const shotRef = isExisting ? doc(db, 'vaccineDoseGroups', shotKey) : doc(collection(db, 'vaccineDoseGroups'));
        const fields = {
          name: shot?.name.trim() || t('babyVax.vaccineNamePlaceholder'),
          brand: shot?.brand.trim() || null,
          batchNo: shot?.batch.trim() || null,
          expiryDate: shot?.expiryDate || null,
          photoFront: shot?.photoFront || null,
          photoBack: shot?.photoBack || null,
          loggedBy: user.uid,
          updatedAt: now,
        };
        if (isExisting) {
          batch.update(shotRef, fields);
        } else {
          batch.set(shotRef, {
            profileId, ownerUid: doses[0]?.ownerUid || (profileSnap?.exists() ? (profileSnap.data() as any).ownerUid : user.uid),
            ...fields, deletedAt: null, createdAt: now,
          });
        }
        shotKeyToRealId.set(shotKey, shotRef.id);
        return shotRef.id;
      };

      doses.forEach((d) => {
        if (d.deletedAt) return; // managed separately via Restore/Delete permanently, not this Save
        if (pendingDeleteIds.has(d.id)) {
          batch.update(doc(db, 'vaccineDoses', d.id), { deletedAt: now, loggedBy: user.uid, updatedAt: now });
          return;
        }
        const row = rows[d.id];
        if (!row) return;
        const given = !!row.groupKey;
        const shotId = row.groupKey ? resolveShotId(row.groupKey) : null;
        batch.update(doc(db, 'vaccineDoses', d.id), {
          vaccineName: row.vaccineName.trim() || d.vaccineName,
          doseNumber: parseInt(row.doseNumber, 10) || 0,
          dueDate: visitDate,
          status: given ? 'given' : 'pending',
          givenDate: given ? visitDate : null,
          // Only a GIVEN dose gets clinic/doctor stamped from the visit-level fields; a still-
          // pending dose keeps whatever it already had. `?? null` guards against Firestore's SDK
          // rejecting `undefined` for a doc that never had this optional field written at all.
          clinic: given ? clinic.trim() || null : d.clinic ?? null,
          doctor: given ? doctor.trim() || null : d.doctor ?? null,
          doseGroupId: shotId,
          // Brand/batch/expiry/photo live ONLY on the shot now — never on the individual vaccine.
          brand: null, batchNo: null, expiryDate: null, photoFront: null, photoBack: null,
          notes: given ? (d.notes ?? null) : (row.notGivenReason.trim() || d.notes || null),
          loggedBy: user.uid,
          updatedAt: now,
        });
      });

      visibleRowIds.filter((id) => rows[id].isNew).forEach((id) => {
        const row = rows[id];
        if (!row.vaccineName.trim()) return; // skip an empty "+ Add another vaccine" row nobody filled in
        const given = !!row.groupKey;
        const shotId = row.groupKey ? resolveShotId(row.groupKey) : null;
        const doseRef = doc(collection(db, 'vaccineDoses'));
        batch.set(doseRef, {
          profileId, ownerUid: doses[0]?.ownerUid || (profileSnap?.exists() ? (profileSnap.data() as any).ownerUid : user.uid), loggedBy: user.uid,
          visitKey, visitLabel: effectiveVisitLabel,
          dueDate: visitDate,
          vaccineName: row.vaccineName.trim(), doseNumber: parseInt(row.doseNumber, 10) || 0,
          status: given ? 'given' : 'pending',
          givenDate: given ? visitDate : null,
          doseGroupId: shotId,
          brand: null, batchNo: null, expiryDate: null, photoFront: null, photoBack: null,
          clinic: given ? clinic.trim() || null : null,
          doctor: given ? doctor.trim() || null : null,
          notes: given ? null : row.notGivenReason.trim() || null,
          source: 'custom', deletedAt: null, createdAt: now, updatedAt: now,
        });
      });

      // Any shot that existed before this session but is no longer referenced by any vaccine being
      // saved (deleted via deleteShot, or every vaccine in it got reassigned/unassigned) is now
      // orphaned — clean it up rather than leaving a dangling, invisible doc behind.
      const usedShotIds = new Set(visibleRowIds.map((id) => rows[id].groupKey).filter((k): k is string => !!k && !k.startsWith('shot_')));
      groupsById.forEach((_group, groupId) => {
        if (!usedShotIds.has(groupId) && doses.some((d) => d.doseGroupId === groupId)) {
          batch.update(doc(db, 'vaccineDoseGroups', groupId), { deletedAt: now, loggedBy: user.uid, updatedAt: now });
        }
      });

      await batch.commit();
      setPendingDeleteIds(new Set());
      // Doses that stayed unassigned (still pending) after a save that DID give something else — a
      // partial visit. Offering a one-click follow-up only makes sense here: if nothing was given,
      // the visit is untouched and already sitting in Upcoming/Overdue as-is; if everything was
      // given, there's nothing left to follow up on.
      const remainingIds = doses
        .filter((d) => { if (d.deletedAt || pendingDeleteIds.has(d.id)) return false; const row = rows[d.id]; return row && !row.groupKey; })
        .map((d) => d.id);
      const showFollowUp = remainingIds.length > 0 && givenCount > 0;
      const showExpense = givenCount > 0;
      if (showFollowUp || showExpense) setPostSave({ followUpIds: showFollowUp ? remainingIds : [], showExpense });
      else navigate('/baby-vaccinations');
    } catch (err) {
      console.error('Failed to save vaccine visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Moves (not copies) the still-pending doses out of this visit into a brand-new one — one click,
  // no re-typing the vaccine names. The original visit ends up with only given doses left, so it
  // naturally resolves into History; the new visitKey carries the leftovers into Upcoming, ready
  // for its own appointment via "Update appointment".
  const handleCreateFollowUp = async () => {
    if (!user || !postSave || postSave.followUpIds.length === 0) return;
    setCreatingFollowUp(true);
    try {
      const now = new Date().toISOString();
      const newVisitKey = `custom_${Date.now()}`;
      const newVisitLabel = t('babyVax.followUpVisitLabel', { visit: effectiveVisitLabel });
      const newDueDate = todayLocalDateString();
      const batch = writeBatch(db);
      postSave.followUpIds.forEach((id) => {
        batch.update(doc(db, 'vaccineDoses', id), {
          visitKey: newVisitKey, visitLabel: newVisitLabel, dueDate: newDueDate,
          loggedBy: user.uid, updatedAt: now,
        });
      });
      await batch.commit();
      navigate('/baby-vaccinations');
    } catch (err) {
      console.error('Failed to create follow-up visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    } finally {
      setCreatingFollowUp(false);
    }
  };

  // Soft-delete for the WHOLE visit — every dose it currently has, regardless of any in-progress
  // (unsaved) row edits. Moves it to BabyVaccinations.tsx's Deleted section, restorable or
  // permanently removable from there.
  const handleDeleteVisit = async () => {
    if (!user || doses.length === 0 || deleting) return;
    if (!window.confirm(t('babyVax.confirmDeleteVisit'))) return;
    setDeleting(true);
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      doses.forEach((d) => batch.update(doc(db, 'vaccineDoses', d.id), { deletedAt: now, loggedBy: user.uid, updatedAt: now }));
      await batch.commit();
      // Cancels this visit's native alarms right here, immediately, by their derived ids (only
      // this visit's — other babies'/visits' alarms are left alone) rather than waiting on the
      // reactive reconcile in GlobalVaccineReminderScheduler.tsx to notice.
      if (profileId && visitKey) await cancelVaccineRemindersForVisit(profileId, visitKey);
      navigate('/baby-vaccinations');
    } catch (err) {
      console.error('Failed to delete visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    // Bounded, self-contained layout (not min-h-screen) — a fixed header above a genuinely
    // scrolling body, so trailing padding in the body reliably clears the fixed Save/Cancel bar
    // and the bottom nav, the same fix already applied to BabyVaccinations.tsx/HealthMedicines.tsx.
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <div className="shrink-0 p-4 md:p-8 pb-3 max-w-xl mx-auto w-full space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {babyPhoto ? (
              <img src={babyPhoto} alt="" className="w-8 h-8 rounded-full object-cover shrink-0 border border-border-subtle" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary font-black flex items-center justify-center shrink-0 text-xs">
                {(babyName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-xs font-bold text-text-muted truncate">{babyName}</span>
          </div>
          {/* Visit date lives here (not in its own card below) — it's the single date now used as
              the due date for every dose in this visit, so it needs to stay visible and editable,
              not buried further down. */}
          <input
            type="date"
            value={visitDate}
            onChange={(e) => setVisitDate(e.target.value)}
            className="shrink-0 bg-white border border-border-subtle rounded-lg px-2 py-1 text-xs font-bold text-primary outline-none"
          />
        </div>
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-xl font-black text-primary">{t('babyVax.logVisitTitle', { visit: effectiveVisitLabel, name: babyName })}</h1>
          {doses.length > 0 && (
            <button type="button" onClick={handleDeleteVisit} disabled={deleting} className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-error/70 hover:bg-error/10 disabled:opacity-50" aria-label={t('babyVax.deleteVisit')}>
              <span className="material-symbols-outlined text-[18px]">delete</span>
            </button>
          )}
        </div>

        {isNewVisit && (
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.visitName')}</label>
            <input
              type="text"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder={t('babyVax.visitNamePlaceholder')}
              className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
            />
          </div>
        )}

        {existingVisits.length > 0 && (
          <button
            type="button"
            onClick={() => setShowCopyModal(true)}
            className="w-full py-2.5 border-1.5 border-dashed border-border-subtle text-text-muted text-xs font-bold rounded-2xl flex items-center justify-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">content_copy</span>
            {t('babyVax.copyFromVisit')}
          </button>
        )}

        {/* Appointment status + clinic/doctor, compacted to exactly two rows: the appointment row,
            then clinic and doctor side by side instead of stacked. */}
        <div className="bg-white border border-border-subtle rounded-2xl p-3.5 space-y-2.5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('babyVax.appointmentStatus')}</p>
              <p className="text-xs font-bold text-primary mt-0.5 truncate">{appointmentSummaryText(appt, t)}</p>
            </div>
            <button type="button" onClick={() => setShowAppointmentModal(true)} className="shrink-0 py-1.5 px-3 bg-surface border border-border-subtle text-text-muted text-[11px] font-bold rounded-lg">
              {t('babyVax.updateAppointment')}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="text" value={clinic} onChange={(e) => setClinic(e.target.value)} placeholder={t('babyVax.clinicPlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
            <input type="text" value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder={t('babyVax.doctorPlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 pt-0 max-w-xl mx-auto w-full space-y-4 pb-40">
        {/* Shots come first — they're the actual unit of proof and the primary way to record what
            was given. The vaccine checklist below is secondary, showing what's still outstanding. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider">{t('babyVax.shotsSection')}</h2>
            <span className="text-[11px] font-bold text-text-muted">{t('babyVax.givenOfTotal', { given: String(givenCount), total: String(visibleRowIds.length) })}</span>
          </div>

          {visibleShotIds.length === 0 && (
            <p className="text-xs text-text-muted px-1">{t('babyVax.noShotsYet')}</p>
          )}

          {visibleShotIds.map((shotKey) => {
            const shot = shots[shotKey];
            const memberIds = visibleRowIds.filter((id) => rows[id].groupKey === shotKey);
            return (
              <button
                key={shotKey}
                type="button"
                onClick={() => setOpenShotModalId(shotKey)}
                className="w-full text-left bg-white border border-primary/20 rounded-2xl p-3.5 flex items-center gap-3"
              >
                {shot.photoFront ? (
                  <img src={shot.photoFront} alt="" className="w-11 h-11 rounded-xl object-cover border border-border-subtle shrink-0" />
                ) : (
                  <span className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-[20px]">vaccines</span>
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-primary truncate">{shot.name}</p>
                  <p className="text-[11px] text-text-muted truncate">
                    {memberIds.length > 0 ? memberIds.map((id) => rows[id].vaccineName || t('babyVax.vaccineNamePlaceholder')).join(', ') : t('babyVax.noVaccinesInShotYet')}
                  </p>
                  {(shot.brand || shot.batch) && (
                    <p className="text-[10px] text-text-muted truncate mt-0.5">
                      {[shot.brand, shot.batch && `${t('babyVax.batchNo')} ${shot.batch}`].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <span className="material-symbols-outlined text-[18px] text-text-muted shrink-0">chevron_right</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setShowAddShotModal(true)}
            className="w-full py-2.5 border-1.5 border-dashed border-primary/40 text-primary text-xs font-bold rounded-2xl flex items-center justify-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            {t('babyVax.addShotButton')}
          </button>
        </div>

        <div className="space-y-2">
          <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider px-1">{t('babyVax.vaccinesSection')}</h2>
          {visibleRowIds.map((id) => {
            const row = rows[id];
            const shot = row.groupKey ? shots[row.groupKey] : undefined;
            return (
              <div key={id} className={clsx('rounded-2xl border p-3.5', shot ? 'bg-white border-border-subtle' : 'bg-warning/5 border-warning/25')}>
                <div className="flex items-center gap-2.5">
                  <input
                    type="text"
                    value={row.vaccineName}
                    onChange={(e) => updateRow(id, { vaccineName: e.target.value })}
                    placeholder={t('babyVax.vaccineNamePlaceholder')}
                    className="flex-1 min-w-0 bg-transparent text-sm font-bold text-primary outline-none border-b border-transparent focus:border-border-subtle"
                  />
                  {row.source === 'custom' && (
                    <span className="shrink-0 text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">{t('babyVax.customBadge')}</span>
                  )}
                  <input
                    type="number"
                    min={0}
                    value={row.doseNumber}
                    onChange={(e) => updateRow(id, { doseNumber: e.target.value })}
                    className="w-11 shrink-0 bg-surface border border-border-subtle rounded-md px-1.5 py-1 text-xs font-bold text-primary outline-none text-center"
                  />
                  <button type="button" onClick={() => handleDeleteDose(id)} className="shrink-0 text-error/70" aria-label={t('babyVax.removeDose')}>
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>

                {shot ? (
                  <button type="button" onClick={() => setOpenShotModalId(row.groupKey!)} className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-primary">
                    <span className="material-symbols-outlined text-[13px]">check_circle</span>
                    {t('babyVax.givenViaShot', { name: shot.name })}
                  </button>
                ) : (
                  <input
                    type="text"
                    value={row.notGivenReason}
                    onChange={(e) => updateRow(id, { notGivenReason: e.target.value })}
                    placeholder={t('babyVax.notGivenReasonPlaceholder')}
                    className="w-full mt-2.5 bg-white border border-warning/30 rounded-lg px-3 py-1.5 text-[11px] text-warning outline-none"
                  />
                )}
              </div>
            );
          })}
        </div>

        <button type="button" onClick={addRow} className="w-full py-3 border-1.5 border-dashed border-border-subtle text-text-muted text-xs font-bold rounded-2xl flex items-center justify-center gap-1.5">
          <span className="material-symbols-outlined text-[16px]">add</span>
          {t('babyVax.addAnotherVaccine')}
        </button>

        {pendingDeleteDoses.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-[11px] font-black text-warning uppercase tracking-wider">{t('babyVax.removedPendingSave')}</h2>
            {pendingDeleteDoses.map((d) => (
              <div key={d.id} className="rounded-2xl border border-warning/30 bg-warning/5 p-3.5">
                <p className="text-sm font-bold text-primary truncate">{d.vaccineName}{d.doseNumber ? ` · ${t('babyVax.dose')} ${d.doseNumber}` : ''}</p>
                <button type="button" onClick={() => undoDeleteDose(d.id)} className="w-full mt-2 py-1.5 bg-white border border-warning/30 text-warning text-[11px] font-bold rounded-lg flex items-center justify-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">undo</span>
                  {t('babyVax.undoRemove')}
                </button>
              </div>
            ))}
          </div>
        )}

        {deletedDoses.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider">{t('babyVax.deletedVaccinesInVisit')}</h2>
            {deletedDoses.map((d) => (
              <div key={d.id} className="rounded-2xl border border-border-subtle bg-surface-container/60 p-3.5">
                <p className="text-sm font-bold text-text-muted truncate">{d.vaccineName}{d.doseNumber ? ` · ${t('babyVax.dose')} ${d.doseNumber}` : ''}</p>
                <div className="flex items-center gap-2 mt-2">
                  <button type="button" onClick={() => handleRestoreDose(d.id)} className="flex-1 py-1.5 bg-primary/5 border border-primary/20 text-primary text-[11px] font-bold rounded-lg flex items-center justify-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">undo</span>
                    {t('babyVax.restoreVisit')}
                  </button>
                  <button type="button" onClick={() => handlePermanentlyDeleteDose(d.id)} className="flex-1 py-1.5 bg-white border border-error/30 text-error text-[11px] font-bold rounded-lg">
                    {t('babyVax.deletePermanently')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCopyModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 pt-20" onClick={() => setShowCopyModal(false)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-primary flex-1">{t('babyVax.copyFromVisitTitle')}</h2>
              <button type="button" onClick={() => setShowCopyModal(false)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="space-y-2">
              {existingVisits.map((v) => (
                <button
                  key={v.visitKey}
                  type="button"
                  onClick={() => copyFromVisit(v)}
                  className="w-full text-left p-3 bg-surface border border-border-subtle rounded-xl"
                >
                  <p className="text-sm font-bold text-primary truncate">{v.visitLabel}</p>
                  <p className="text-[11px] text-text-muted mt-0.5 truncate">
                    {v.dueDate} · {v.doses.length} {t('babyVax.dosesCount')} · {v.doses.map((d) => d.vaccineName).join(', ')}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showAddShotModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 pt-16" onClick={() => { setShowAddShotModal(false); setCatalogSearch(''); }}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-primary flex-1">{t('babyVax.addShotTitle')}</h2>
              <button type="button" onClick={() => { setShowAddShotModal(false); setCatalogSearch(''); }} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>

            {/* Browsable + searchable dropdown of the AI-curated catalog (see brandCatalog above)
                — shows the full list by default (browsable), narrows live as you type (searchable
                by shot name, brand, or any vaccine it covers). Picking one creates the shot
                immediately, skipping the manual name entry below entirely. */}
            {brandCatalog.length > 0 && (() => {
              const q = catalogSearch.trim().toLowerCase();
              const matches = brandCatalog.filter(
                (e) => !q || e.shotName.toLowerCase().includes(q) || e.brand.toLowerCase().includes(q) || e.vaccines.some((v) => v.toLowerCase().includes(q)),
              );
              return (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('babyVax.commonShotsLabel')}</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-muted">search</span>
                    <input
                      type="text"
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      placeholder={t('babyVax.searchShotsPlaceholder')}
                      className="w-full bg-surface border border-border-subtle rounded-lg pl-8 pr-3 py-2 text-sm font-bold text-primary outline-none"
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
                    {matches.length === 0 ? (
                      <p className="text-xs text-text-muted text-center py-4">{t('babyVax.noCommonShotsMatch')}</p>
                    ) : (
                      matches.map((entry, i) => (
                        <button
                          key={`${entry.shotName}_${i}`}
                          type="button"
                          onClick={() => createShotFromCatalog(entry)}
                          className="w-full text-left p-2.5 bg-white hover:bg-surface transition-colors"
                        >
                          <p className="text-xs font-bold text-primary truncate">{entry.shotName} <span className="text-text-muted font-semibold">· {entry.brand}</span></p>
                          <p className="text-[10px] text-text-muted truncate">{entry.vaccines.join(', ')}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="space-y-1.5 pt-1 border-t border-border-subtle">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('babyVax.orCreateCustomShot')}</label>
              <input
                type="text"
                value={newShotName}
                onChange={(e) => setNewShotName(e.target.value)}
                placeholder={t('babyVax.shotNamePlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmAddShot(); }}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2.5 text-sm font-bold text-primary outline-none"
              />
              <button type="button" onClick={confirmAddShot} disabled={!newShotName.trim()} className="w-full py-2.5 bg-primary text-white font-bold rounded-xl text-sm disabled:opacity-50">
                {t('babyVax.createShotButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {openShotModalId && shots[openShotModalId] && (() => {
        const shotKey = openShotModalId;
        const shot = shots[shotKey];
        const memberIds = visibleRowIds.filter((id) => rows[id].groupKey === shotKey);
        const availableIds = visibleRowIds.filter((id) => !rows[id].groupKey || rows[id].groupKey === shotKey);
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 pt-16" onClick={() => setOpenShotModalId(null)}>
            <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={shot.name}
                  onChange={(e) => updateShot(shotKey, { name: e.target.value })}
                  placeholder={t('babyVax.shotNamePlaceholder')}
                  className="flex-1 min-w-0 text-base font-black text-primary outline-none border-b border-transparent focus:border-border-subtle"
                />
                <button type="button" onClick={() => setOpenShotModalId(null)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('babyVax.vaccinesInShot')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {availableIds.length === 0 && <p className="text-xs text-text-muted px-1">{t('babyVax.noVaccinesAvailable')}</p>}
                  {availableIds.map((id) => {
                    const inShot = rows[id].groupKey === shotKey;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => (inShot ? unassignVaccine(id) : assignVaccineToShot(id, shotKey))}
                        className={clsx('px-3 py-1.5 rounded-full text-xs font-bold border transition-all flex items-center gap-1', inShot ? 'bg-primary text-white border-primary' : 'bg-surface text-text-muted border-border-subtle')}
                      >
                        {inShot && <span className="material-symbols-outlined text-[13px]">check</span>}
                        {rows[id].vaccineName || t('babyVax.vaccineNamePlaceholder')}
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-1.5 pt-1">
                  <input
                    type="text"
                    value={inlineVaccineName}
                    onChange={(e) => setInlineVaccineName(e.target.value)}
                    placeholder={t('babyVax.newVaccineNamePlaceholder')}
                    onKeyDown={(e) => { if (e.key === 'Enter') addVaccineToShot(shotKey); }}
                    className="flex-1 min-w-0 bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none"
                  />
                  <button type="button" onClick={() => addVaccineToShot(shotKey)} disabled={!inlineVaccineName.trim()} className="shrink-0 px-3 py-2 bg-primary/10 text-primary text-xs font-bold rounded-lg disabled:opacity-50">
                    {t('common.add')}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <input type="text" value={shot.brand} onChange={(e) => updateShot(shotKey, { brand: e.target.value })} placeholder={t('babyVax.brand')} className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
                <input type="text" value={shot.batch} onChange={(e) => updateShot(shotKey, { batch: e.target.value })} placeholder={t('babyVax.batchNo')} className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('babyVax.expiryDate')}</label>
                <input type="date" value={shot.expiryDate} onChange={(e) => updateShot(shotKey, { expiryDate: e.target.value })} className="w-full mt-1 bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('babyVax.proofPhotoFront')}</p>
                  <ImageAttachments images={shot.photoFront ? [shot.photoFront] : []} onChange={(imgs) => updateShot(shotKey, { photoFront: imgs[imgs.length - 1] || null })} maxImages={1} label={t('babyVax.addPhoto')} />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('babyVax.proofPhotoBack')}</p>
                  <ImageAttachments images={shot.photoBack ? [shot.photoBack] : []} onChange={(imgs) => updateShot(shotKey, { photoBack: imgs[imgs.length - 1] || null })} maxImages={1} label={t('babyVax.addPhoto')} />
                </div>
              </div>

              <div className="flex gap-2">
                <button type="button" onClick={() => deleteShot(shotKey)} className="shrink-0 px-4 py-2.5 bg-white border border-error/30 text-error text-sm font-bold rounded-xl">
                  {t('babyVax.deleteShot')}
                </button>
                <button type="button" onClick={() => setOpenShotModalId(null)} className="flex-1 py-2.5 bg-primary text-white font-bold rounded-xl text-sm">
                  {t('common.done')}
                </button>
              </div>
              {memberIds.length === 0 && (
                <p className="text-[11px] text-warning text-center">{t('babyVax.shotNeedsVaccineHint')}</p>
              )}
            </div>
          </div>
        );
      })()}

      <div className="fixed left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-border-subtle p-4 flex gap-2" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom))' }}>
        {/* Same destination as the app header's own back arrow (getParentPath) — a Cancel here
            just saves the trip back up to the header to leave this screen without saving. */}
        <button type="button" onClick={goBack} className="shrink-0 px-5 py-3.5 bg-white border border-border-subtle text-text-muted font-bold rounded-2xl">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={handleSave} disabled={saving || visibleRowIds.length === 0} className="flex-1 py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">
          {saving ? t('common.saving') : t('babyVax.saveVisitButton', { given: givenCount, total: visibleRowIds.length })}
        </button>
      </div>

      {postSave && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 text-center">
            <span className="material-symbols-outlined text-4xl text-success">check_circle</span>
            <h2 className="text-base font-black text-primary">{t('babyVax.visitLoggedTitle')}</h2>

            {postSave.followUpIds.length > 0 && (
              <div className="text-left bg-warning/5 border border-warning/20 rounded-xl p-3 space-y-2">
                <p className="text-xs text-on-surface leading-relaxed">{t('babyVax.followUpBody', { count: String(postSave.followUpIds.length) })}</p>
                <button type="button" onClick={handleCreateFollowUp} disabled={creatingFollowUp} className="w-full py-2 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-50">
                  {creatingFollowUp ? t('common.saving') : t('babyVax.createFollowUpButton')}
                </button>
              </div>
            )}

            {postSave.showExpense && (
              <div className="text-left space-y-2">
                <p className="text-sm text-text-muted">{t('babyVax.addExpensePrompt')}</p>
                <button
                  type="button"
                  onClick={() => navigate(`/add-expense?category=health&description=${encodeURIComponent(t('babyVax.expenseDescription', { visit: effectiveVisitLabel, name: babyName }))}`)}
                  className="w-full py-3 bg-primary text-white font-bold rounded-xl"
                >
                  {t('babyVax.addExpenseButton')}
                </button>
              </div>
            )}

            <button type="button" onClick={() => navigate('/baby-vaccinations')} className="w-full py-2 text-xs font-bold text-text-muted">
              {t('babyVax.notNow')}
            </button>
          </div>
        </div>
      )}

      {showAppointmentModal && profileId && visitKey && (
        <VaccineAppointmentModal
          profileId={profileId}
          ownerUid={doses[0]?.ownerUid || (profileSnap?.exists() ? (profileSnap.data() as any).ownerUid : '') || ''}
          visitKey={visitKey}
          visitLabel={effectiveVisitLabel}
          appt={appt}
          onClose={() => setShowAppointmentModal(false)}
        />
      )}
    </div>
  );
}
