import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collection, doc, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { VaccineDose, VaccineDoseGroup } from '../lib/vaccinations';
import { cancelVaccineReminders } from '../lib/vaccinationReminders';
import ImageAttachments from '../components/ImageAttachments';
import ImageLightbox from '../components/ImageLightbox';

interface EditState {
  brand: string;
  batch: string;
  expiryDate: string;
  photoFront: string | null;
  photoBack: string | null;
  notes: string;
}

const DoseRow: React.FC<{ dose: VaccineDose; group?: VaccineDoseGroup; siblingNames: string[] }> = ({ dose, group, siblingNames }) => {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A grouped dose's proof lives on its group doc, not the dose itself — this is the one place
  // brand/batch/expiry/photo are actually read from for both the collapsed summary and the edit
  // form below.
  const proof = group || dose;
  const [form, setForm] = useState<EditState>({
    brand: proof.brand || '', batch: proof.batchNo || '', expiryDate: proof.expiryDate || '',
    photoFront: proof.photoFront || null, photoBack: proof.photoBack || null,
    notes: dose.notes || '',
  });

  const openEdit = () => {
    setForm({
      brand: proof.brand || '', batch: proof.batchNo || '', expiryDate: proof.expiryDate || '',
      photoFront: proof.photoFront || null, photoBack: proof.photoBack || null, notes: dose.notes || '',
    });
    setEditing(true);
  };

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      if (dose.doseGroupId) {
        // Shared proof goes on the group doc (every linked vaccine sees the update); notes stay
        // per-dose since they were never part of the shared fields.
        await updateDoc(doc(db, 'vaccineDoseGroups', dose.doseGroupId), {
          brand: form.brand.trim() || null,
          batchNo: form.batch.trim() || null,
          expiryDate: form.expiryDate || null,
          photoFront: form.photoFront,
          photoBack: form.photoBack,
          loggedBy: user.uid,
          updatedAt: now,
        });
        await updateDoc(doc(db, 'vaccineDoses', dose.id), { notes: form.notes.trim() || null, loggedBy: user.uid, updatedAt: now });
      } else {
        await updateDoc(doc(db, 'vaccineDoses', dose.id), {
          brand: form.brand.trim() || null,
          batchNo: form.batch.trim() || null,
          expiryDate: form.expiryDate || null,
          photoFront: form.photoFront,
          photoBack: form.photoBack,
          notes: form.notes.trim() || null,
          loggedBy: user.uid,
          updatedAt: now,
        });
      }
      setEditing(false);
    } catch (err) {
      console.error('Failed to update dose:', err);
      alert(t('babyVax.saveVisitFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        onClick={() => { if (dose.status === 'given') openEdit(); }}
        className={clsx('bg-white border border-border-subtle rounded-2xl p-3.5 flex items-center gap-3', dose.status === 'given' && 'cursor-pointer')}
      >
        {proof.photoFront ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); setViewingPhoto(proof.photoFront); }} className="shrink-0">
            <img src={proof.photoFront} alt="" className="w-12 h-12 rounded-xl object-cover border border-border-subtle" />
          </button>
        ) : (
          <span className="w-12 h-12 rounded-xl bg-surface-container-high text-text-muted flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[20px]">vaccines</span>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-primary flex items-center gap-1.5 flex-wrap">
            {dose.vaccineName} <span className="text-text-muted font-semibold">· {t('babyVax.dose')} {dose.doseNumber}</span>
            {(dose.source || 'template') === 'custom' && (
              <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">{t('babyVax.customBadge')}</span>
            )}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">
            {dose.status === 'given'
              ? (proof.brand ? `${proof.brand} · ` : '') + (proof.batchNo ? `${t('babyVax.batchNo')} ${proof.batchNo}` : t('babyVax.noBatchRecorded')) + (proof.expiryDate ? ` · ${t('babyVax.expiryDate')} ${proof.expiryDate}` : '')
              : t(`babyVax.status.${dose.status}`)}
          </p>
          {siblingNames.length > 0 && (
            <p className="text-[11px] text-primary font-bold mt-0.5 flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">link</span>
              {t('babyVax.sameDoseAs', { names: siblingNames.join(', ') })}
            </p>
          )}
          {dose.notes && <p className="text-[11px] text-text-muted mt-0.5 italic">{dose.notes}</p>}
        </div>
        {dose.status === 'given' && (
          <button type="button" onClick={(e) => { e.stopPropagation(); openEdit(); }} className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-text-muted hover:bg-surface" aria-label={t('common.edit')}>
            <span className="material-symbols-outlined text-[17px]">edit</span>
          </button>
        )}
      </div>

      {viewingPhoto && <ImageLightbox src={viewingPhoto} onClose={() => setViewingPhoto(null)} />}

      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 pt-20" onClick={() => setEditing(false)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-primary flex-1 truncate">
                {dose.vaccineName} <span className="text-text-muted font-semibold">· {t('babyVax.dose')} {dose.doseNumber}</span>
              </h2>
              <button type="button" onClick={() => setEditing(false)} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
            </div>
            {siblingNames.length > 0 && (
              <p className="text-[11px] font-bold text-primary bg-primary/5 border border-primary/20 rounded-lg p-2.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] shrink-0">link</span>
                {t('babyVax.sharedDoseNote', { names: siblingNames.join(', ') })}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2.5">
              <input type="text" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder={t('babyVax.brand')} className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
              <input type="text" value={form.batch} onChange={(e) => setForm((f) => ({ ...f, batch: e.target.value }))} placeholder={t('babyVax.batchNo')} className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('babyVax.expiryDate')}</label>
              <input type="date" value={form.expiryDate} onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))} className="w-full mt-1 bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs font-bold text-primary outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('babyVax.proofPhotoFront')}</p>
                <ImageAttachments images={form.photoFront ? [form.photoFront] : []} onChange={(imgs) => setForm((f) => ({ ...f, photoFront: imgs[imgs.length - 1] || null }))} maxImages={1} label={t('babyVax.addPhoto')} />
              </div>
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1">{t('babyVax.proofPhotoBack')}</p>
                <ImageAttachments images={form.photoBack ? [form.photoBack] : []} onChange={(imgs) => setForm((f) => ({ ...f, photoBack: imgs[imgs.length - 1] || null }))} maxImages={1} label={t('babyVax.addPhoto')} />
              </div>
            </div>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder={t('babyVax.notesPlaceholder')} rows={2} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-xs text-primary outline-none resize-none" />
            <div className="flex gap-2">
              <button type="button" onClick={save} disabled={saving} className="flex-1 py-2.5 bg-primary text-white text-sm font-bold rounded-xl disabled:opacity-50">{saving ? t('common.saving') : t('common.save')}</button>
              <button type="button" onClick={() => setEditing(false)} className="flex-1 py-2.5 bg-surface border border-border-subtle text-text-muted text-sm font-bold rounded-xl">{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default function VaccineVisitDetail() {
  const { profileId, visitKey } = useParams<{ profileId: string; visitKey: string }>();
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [profileSnap] = useDocument(profileId ? doc(db, 'babyProfiles', profileId) : null);
  const babyName = profileSnap?.exists() ? (profileSnap.data() as any).name : '';
  const babyPhoto = profileSnap?.exists() ? (profileSnap.data() as any).photo : null;

  const [dosesValue] = useCollection(
    profileId && visitKey ? query(collection(db, 'vaccineDoses'), where('profileId', '==', profileId), where('visitKey', '==', visitKey)) : null,
  );
  const doses: VaccineDose[] = useMemo(() => (dosesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [dosesValue]);
  const first = doses[0];
  const givenCount = doses.filter((d) => d.status === 'given').length;

  // Dose groups referenced by this visit's own doses (see VaccineDoseGroup) — fetched once per
  // profile so each grouped DoseRow can read its shared proof and list its linked siblings.
  const [doseGroupsValue] = useCollection(profileId ? query(collection(db, 'vaccineDoseGroups'), where('profileId', '==', profileId)) : null);
  const groupsById = useMemo(() => {
    const m = new Map<string, VaccineDoseGroup>();
    (doseGroupsValue?.docs || []).forEach((d) => m.set(d.id, { id: d.id, ...(d.data() as any) }));
    return m;
  }, [doseGroupsValue]);
  const [reverting, setReverting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteVisit = async () => {
    if (!user || doses.length === 0 || deleting) return;
    if (!window.confirm(t('babyVax.confirmDeleteVisit'))) return;
    setDeleting(true);
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      doses.forEach((d) => batch.update(doc(db, 'vaccineDoses', d.id), { deletedAt: now, loggedBy: user.uid, updatedAt: now }));
      await batch.commit();
      // This screen only ever shows fully-resolved visits (no pending doses), so there's normally
      // no active alarm to cancel — kept anyway for the same reason as LogVaccineVisit.tsx's own
      // delete handler, so nothing here depends on a reactive effect noticing the change in time.
      await cancelVaccineReminders();
      navigate('/baby-vaccinations');
    } catch (err) {
      console.error('Failed to delete visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    } finally {
      setDeleting(false);
    }
  };

  // Undo for a visit marked complete by mistake — flips every given dose back to pending and clears
  // its log-entry fields (brand/batch/photos/etc.), matching a freshly generated pending dose's
  // shape exactly. Once nothing here is 'given' anymore, the visit naturally reappears in Upcoming
  // (BabyVaccinations.tsx classifies purely by dose status, not by any separate "history" flag).
  const handleRevertVisit = async () => {
    if (!user) return;
    if (!window.confirm(t('babyVax.confirmRevertVisit'))) return;
    setReverting(true);
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      doses.filter((d) => d.status === 'given').forEach((d) => {
        batch.update(doc(db, 'vaccineDoses', d.id), {
          status: 'pending', givenDate: null, brand: null, batchNo: null, expiryDate: null,
          clinic: null, doctor: null, photoFront: null, photoBack: null, notes: null,
          doseGroupId: null,
          loggedBy: user.uid, updatedAt: now,
        });
      });
      await batch.commit();
      navigate('/baby-vaccinations');
    } catch (err) {
      console.error('Failed to revert visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    } finally {
      setReverting(false);
    }
  };

  if (!first) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full">
          <p className="text-sm text-text-muted text-center mt-10">{t('common.loading')}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-10">
        {/* Sticky, like LogVaccineVisit.tsx's own header — the baby icon and visit summary stay
            visible while only the dose list below scrolls, so it's always clear whose visit (and
            which one) this is even after scrolling past several doses. */}
        <div className="sticky top-0 z-20 bg-surface pb-3 space-y-3">
        <div className="flex items-center gap-2">
          {babyPhoto ? (
            <img src={babyPhoto} alt="" className="w-8 h-8 rounded-full object-cover shrink-0 border border-border-subtle" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-primary/10 text-primary font-black flex items-center justify-center shrink-0 text-xs">
              {(babyName || '?').charAt(0).toUpperCase()}
            </div>
          )}
          <span className="text-xs font-bold text-text-muted truncate">{babyName}</span>
        </div>
        <h1 className="text-xl font-black text-primary">{first.visitLabel}</h1>

        <div className="bg-white border border-border-subtle rounded-2xl p-4 flex gap-6">
          <div>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('babyVax.date')}</p>
            <p className="text-sm font-bold text-primary mt-0.5">{first.givenDate || first.dueDate}</p>
          </div>
          {first.clinic && (
            <div>
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('babyVax.clinic')}</p>
              <p className="text-sm font-bold text-primary mt-0.5">{first.clinic}</p>
            </div>
          )}
        </div>
        {first.doctor && <p className="text-xs text-text-muted -mt-2">{first.doctor} · {givenCount} {t('babyVax.of')} {doses.length} {t('babyVax.dosesGiven')}</p>}

        <div className="flex gap-2">
          {givenCount > 0 && (
            <button
              type="button"
              onClick={handleRevertVisit}
              disabled={reverting}
              className="flex-1 py-2.5 bg-white border border-border-subtle text-text-muted text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]">undo</span>
              {reverting ? t('common.saving') : t('babyVax.revertVisit')}
            </button>
          )}
          <button
            type="button"
            onClick={handleDeleteVisit}
            disabled={deleting}
            className="flex-1 py-2.5 bg-white border border-error/30 text-error text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
            {deleting ? t('common.saving') : t('babyVax.deleteVisit')}
          </button>
        </div>
        </div>

        <p className="text-[11px] text-text-muted px-1">{t('babyVax.editDoseHint')}</p>

        <div className="space-y-2">
          {doses.map((d) => (
            <DoseRow
              key={d.id}
              dose={d}
              group={d.doseGroupId ? groupsById.get(d.doseGroupId) : undefined}
              siblingNames={d.doseGroupId ? doses.filter((other) => other.id !== d.id && other.doseGroupId === d.doseGroupId).map((other) => other.vaccineName) : []}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
