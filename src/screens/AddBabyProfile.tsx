import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collection, doc, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { clsx } from 'clsx';
import ImageAttachments from '../components/ImageAttachments';
import {
  ScheduleTemplate, Country, VaccineDose, BLOOD_GROUPS, COUNTRIES, DEFAULT_COUNTRY, TEMPLATES_BY_COUNTRY, TEMPLATE_META,
  DEFAULT_REMINDER_PREFS, generateScheduleDoses,
} from '../lib/vaccinations';
import { todayLocalDateString } from '../lib/dateUtils';

// Dual-purpose: no :profileId in the route (reached via "Add a Child") creates a new profile AND
// generates its schedule from the chosen template; a :profileId (reached via the Dashboard/View
// Profile's Edit button) loads and updates that profile in place. Editing the country/plan here is
// allowed (unlike the schedule itself, which is otherwise only edited per-visit from
// LogVaccineVisit.tsx) — but changing it swaps only the still-upcoming, template-generated part of
// the schedule; see handlePlanChangeConfirmed below.
export default function AddBabyProfile() {
  const { profileId } = useParams<{ profileId?: string }>();
  const isEdit = !!profileId;
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [existingSnap] = useDocument(profileId ? doc(db, 'babyProfiles', profileId) : null);
  const [existingDosesValue] = useCollection(
    isEdit && profileId ? query(collection(db, 'vaccineDoses'), where('profileId', '==', profileId)) : null,
  );
  const existingDoses: VaccineDose[] = useMemo(() => (existingDosesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [existingDosesValue]);

  const [name, setName] = useState('');
  const [dob, setDob] = useState(todayLocalDateString());
  const [sex, setSex] = useState<'male' | 'female' | 'other'>('male');
  const [photo, setPhoto] = useState<string | null>(null);
  const [backgroundPhoto, setBackgroundPhoto] = useState<string | null>(null);
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [template, setTemplate] = useState<ScheduleTemplate>('iap');
  const [birthWeek, setBirthWeek] = useState('');
  const [motherBloodGroup, setMotherBloodGroup] = useState('');
  const [babyBloodGroup, setBabyBloodGroup] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadedExisting, setLoadedExisting] = useState(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);

  // The plan as loaded — compared against the current country/template selections at save time to
  // detect a real change, and used to compute what the confirmation dialog below shows.
  const originalPlanRef = useRef<{ country: Country; template: ScheduleTemplate } | null>(null);

  useEffect(() => {
    if (!isEdit || !existingSnap?.exists() || loadedExisting) return;
    const d = existingSnap.data() as any;
    setName(d.name || '');
    setDob(d.dob || todayLocalDateString());
    setSex(d.sex || 'male');
    setPhoto(d.photo || null);
    setBackgroundPhoto(d.backgroundPhoto || null);
    setCountry(d.country || DEFAULT_COUNTRY);
    setTemplate(d.scheduleTemplate || 'blank');
    setBirthWeek(d.birthWeek != null ? String(d.birthWeek) : '');
    setMotherBloodGroup(d.motherBloodGroup || '');
    setBabyBloodGroup(d.babyBloodGroup || '');
    setOwnerUid(d.ownerUid || null);
    originalPlanRef.current = { country: d.country || DEFAULT_COUNTRY, template: d.scheduleTemplate || 'blank' };
    setLoadedExisting(true);
  }, [isEdit, existingSnap, loadedExisting]);

  // Re-defaults the template whenever the chosen country changes to one it doesn't offer — in
  // create mode this can fire from the very first render (nothing loaded yet to preserve); in edit
  // mode it's skipped until the existing profile has actually loaded, and skipped once more right
  // after that load so it doesn't immediately clobber the plan that was just read from Firestore.
  const skipNextTemplateResetRef = useRef(true);
  useEffect(() => {
    if (isEdit && !loadedExisting) return;
    if (skipNextTemplateResetRef.current) {
      skipNextTemplateResetRef.current = false;
      return;
    }
    const opts = TEMPLATES_BY_COUNTRY[country];
    setTemplate(opts.includes('iap') ? 'iap' : opts[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, loadedExisting]);

  const planChanged = isEdit && loadedExisting && originalPlanRef.current != null &&
    (originalPlanRef.current.country !== country || originalPlanRef.current.template !== template);

  const [planChangeConfirm, setPlanChangeConfirm] = useState<{ removeCount: number; addCount: number } | null>(null);

  const buildProfileFields = () => ({
    name: name.trim(),
    dob,
    sex,
    photo,
    backgroundPhoto,
    birthWeek: birthWeek ? parseInt(birthWeek, 10) : null,
    motherBloodGroup: motherBloodGroup || null,
    babyBloodGroup: babyBloodGroup || null,
    updatedAt: new Date().toISOString(),
  });

  const handleSave = async () => {
    if (!user || !name.trim() || saving) return;
    if (isEdit && planChanged) {
      // Only the not-yet-given, template-generated part of the schedule is swapped — doses already
      // given (or skipped/not-needed) are history and untouched, and anything the caregiver added
      // by hand (source: 'custom') isn't part of "the plan" being changed, so it's kept too.
      const toRemove = existingDoses.filter((d) => (d.source || 'template') === 'template' && d.status === 'pending');
      const newDoses = generateScheduleDoses(dob, template);
      setPlanChangeConfirm({ removeCount: toRemove.length, addCount: newDoses.length });
      return;
    }
    await commitSave();
  };

  const commitSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const fields = buildProfileFields();

      if (isEdit && profileId) {
        if (planChanged) {
          const toRemove = existingDoses.filter((d) => (d.source || 'template') === 'template' && d.status === 'pending');
          const newDoses = generateScheduleDoses(dob, template);
          const batch = writeBatch(db);
          batch.update(doc(db, 'babyProfiles', profileId), { ...fields, country, scheduleTemplate: template });
          toRemove.forEach((d) => batch.delete(doc(db, 'vaccineDoses', d.id)));
          newDoses.forEach((dd) => {
            const doseRef = doc(collection(db, 'vaccineDoses'));
            batch.set(doseRef, {
              profileId, ownerUid: ownerUid || user.uid, loggedBy: user.uid,
              visitKey: dd.visitKey, visitLabel: dd.visitLabel, dueDate: dd.dueDate,
              vaccineName: dd.vaccineName, doseNumber: dd.doseNumber,
              status: 'pending', givenDate: null, brand: null, batchNo: null, expiryDate: null, clinic: null, doctor: null,
              photoFront: null, photoBack: null, notes: null, source: 'template', deletedAt: null, createdAt: now, updatedAt: now,
            });
          });
          await batch.commit();
        } else {
          await updateDoc(doc(db, 'babyProfiles', profileId), fields);
        }
      } else {
        const profileRef = doc(collection(db, 'babyProfiles'));
        const doses = generateScheduleDoses(dob, template);
        // Same "not one transaction" reasoning as before — a batch, not atomic with the profile
        // write, since a partial failure just leaves an editable/topupable schedule, not a
        // corrupted one.
        const batch = writeBatch(db);
        batch.set(profileRef, { ownerUid: user.uid, country, scheduleTemplate: template, reminderPrefs: DEFAULT_REMINDER_PREFS, deletedAt: null, createdAt: now, ...fields });
        doses.forEach((dd) => {
          const doseRef = doc(collection(db, 'vaccineDoses'));
          batch.set(doseRef, {
            profileId: profileRef.id, ownerUid: user.uid, loggedBy: user.uid,
            visitKey: dd.visitKey, visitLabel: dd.visitLabel, dueDate: dd.dueDate,
            vaccineName: dd.vaccineName, doseNumber: dd.doseNumber,
            status: 'pending', givenDate: null, brand: null, batchNo: null, expiryDate: null, clinic: null, doctor: null,
            photoFront: null, photoBack: null, notes: null, source: 'template', deletedAt: null, createdAt: now, updatedAt: now,
          });
        });
        await batch.commit();
      }
      navigate(isEdit && profileId ? `/baby-vaccinations/profile/${profileId}` : '/baby-vaccinations');
    } catch (err) {
      console.error('Failed to save baby profile:', err);
      alert(t('babyVax.createFailed'));
    } finally {
      setSaving(false);
      setPlanChangeConfirm(null);
    }
  };

  const newPlanLabel = `${t(TEMPLATE_META[template]?.titleKey || 'babyVax.templateBlank')} (${COUNTRIES.find((c) => c.id === country)?.label || ''})`;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-5 pb-40">
        <div>
          <h1 className="text-2xl font-black text-primary">{isEdit ? t('babyVax.editProfileTitle') : t('babyVax.addChildTitle')}</h1>
          {!isEdit && <p className="text-sm text-text-muted mt-1">{t('babyVax.addChildSubtitle')}</p>}
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.addPhoto')}</label>
          <ImageAttachments images={photo ? [photo] : []} onChange={(imgs) => setPhoto(imgs[imgs.length - 1] || null)} maxImages={1} label={t('babyVax.addPhoto')} />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.backgroundPhoto')}</label>
          <ImageAttachments images={backgroundPhoto ? [backgroundPhoto] : []} onChange={(imgs) => setBackgroundPhoto(imgs[imgs.length - 1] || null)} maxImages={1} label={t('babyVax.backgroundPhoto')} />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.childName')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('babyVax.childNamePlaceholder')}
            className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.dob')}</label>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              max={todayLocalDateString()}
              className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.sex')}</label>
            <div className="flex bg-white border border-border-subtle rounded-xl p-1 gap-1">
              {(['male', 'female', 'other'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSex(s)}
                  className={clsx('flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-colors', sex === s ? 'bg-primary text-white' : 'text-text-muted')}
                >
                  {t(`babyVax.sex.${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.birthWeek')}</label>
            <input
              type="number" min={20} max={45} value={birthWeek} onChange={(e) => setBirthWeek(e.target.value)}
              placeholder={t('babyVax.birthWeekPlaceholder')}
              className="w-full bg-white border border-border-subtle rounded-xl px-3 py-2.5 text-sm font-bold text-primary outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.babyBloodGroup')}</label>
            <select value={babyBloodGroup} onChange={(e) => setBabyBloodGroup(e.target.value)} className="w-full bg-white border border-border-subtle rounded-xl px-2 py-2.5 text-sm font-bold text-primary outline-none">
              <option value="">—</option>
              {BLOOD_GROUPS.map((bg) => <option key={bg} value={bg}>{bg}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.motherBloodGroup')}</label>
            <select value={motherBloodGroup} onChange={(e) => setMotherBloodGroup(e.target.value)} className="w-full bg-white border border-border-subtle rounded-xl px-2 py-2.5 text-sm font-bold text-primary outline-none">
              <option value="">—</option>
              {BLOOD_GROUPS.map((bg) => <option key={bg} value={bg}>{bg}</option>)}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.country')}</label>
          <div className="grid grid-cols-2 gap-2">
            {COUNTRIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCountry(c.id)}
                className={clsx(
                  'py-2.5 rounded-xl border text-sm font-bold flex items-center justify-center gap-1.5 transition-colors',
                  country === c.id ? 'bg-primary/5 border-primary text-primary' : 'bg-white border-border-subtle text-on-surface',
                )}
              >
                <span>{c.flag}</span>{c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('babyVax.scheduleTemplate')}</label>
          {TEMPLATES_BY_COUNTRY[country].map((tplId) => {
            const tpl = TEMPLATE_META[tplId];
            return (
              <button
                key={tplId}
                type="button"
                onClick={() => setTemplate(tplId)}
                className={clsx(
                  'w-full text-left p-3 rounded-2xl border transition-colors flex items-start gap-3',
                  template === tplId ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle',
                )}
              >
                <span className={clsx('w-4 h-4 rounded-full border-2 mt-0.5 shrink-0', template === tplId ? 'border-primary bg-primary' : 'border-border-subtle')} />
                <span>
                  <p className="text-sm font-bold text-primary">{t(tpl.titleKey)}</p>
                  <p className="text-xs text-text-muted mt-0.5">{t(tpl.descKey)}</p>
                </span>
              </button>
            );
          })}
        </div>

        <div className="bg-primary/5 rounded-2xl p-3.5 flex gap-2.5">
          <span className="material-symbols-outlined text-[18px] text-primary shrink-0">info</span>
          <p className="text-xs text-primary leading-relaxed">{t('babyVax.scheduleDisclaimer')}</p>
        </div>
      </main>

      <div className="fixed left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-border-subtle p-4" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom))' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
        >
          {saving ? t('common.saving') : isEdit ? t('common.save') : t('babyVax.createProfileButton')}
        </button>
      </div>

      {planChangeConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setPlanChangeConfirm(null)}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-black text-primary">{t('babyVax.changePlanTitle')}</h2>
            <p className="text-sm text-on-surface leading-relaxed">
              {t('babyVax.changePlanBody', { plan: newPlanLabel, removeCount: String(planChangeConfirm.removeCount), addCount: String(planChangeConfirm.addCount) })}
            </p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setPlanChangeConfirm(null)} className="flex-1 py-2.5 bg-surface border border-border-subtle text-text-muted text-sm font-bold rounded-xl">
                {t('babyVax.changePlanCancel')}
              </button>
              <button type="button" onClick={commitSave} disabled={saving} className="flex-1 py-2.5 bg-primary text-white text-sm font-bold rounded-xl disabled:opacity-50">
                {saving ? t('common.saving') : t('babyVax.changePlanConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
