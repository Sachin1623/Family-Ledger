import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BabyProfile, ageLabel, COUNTRIES, DEFAULT_COUNTRY, TEMPLATE_META } from '../lib/vaccinations';
import ImageLightbox from '../components/ImageLightbox';

// Read-only profile summary, reached from the Dashboard's name/avatar (instead of jumping
// straight into the edit form) — matches the "view, then explicitly choose to edit" flow used for
// vaccine doses (VaccineVisitDetail.tsx). The banner/avatar here mirror the Dashboard's own hero
// header (same decorative pattern when no background photo is set), and are tappable full-screen
// here as well as on the Dashboard.
export default function VaccineProfileView() {
  const { profileId } = useParams<{ profileId: string }>();
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [profileSnap] = useDocument(profileId ? doc(db, 'babyProfiles', profileId) : null);
  const profile: BabyProfile | null = profileSnap?.exists() ? { id: profileSnap.id, ...(profileSnap.data() as any) } : null;
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteBaby = async () => {
    if (!profile) return;
    if (!window.confirm(t('babyVax.confirmDeleteBaby', { name: profile.name }))) return;
    setDeleting(true);
    try {
      await updateDoc(doc(db, 'babyProfiles', profile.id), { deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      navigate('/baby-vaccinations');
    } catch (err) {
      console.error('Failed to delete baby profile:', err);
      alert(t('babyVax.createFailed'));
    } finally {
      setDeleting(false);
    }
  };

  if (!profile) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full">
          <p className="text-sm text-text-muted text-center mt-10">{t('common.loading')}</p>
        </main>
      </div>
    );
  }

  const countryInfo = COUNTRIES.find((c) => c.id === (profile.country || DEFAULT_COUNTRY));
  const planLabel = t(TEMPLATE_META[profile.scheduleTemplate]?.titleKey || 'babyVax.templateBlank');

  const Row = ({ label, value }: { label: string; value: string | null | undefined }) => (
    !value ? null : (
      <div className="flex items-center justify-between py-2.5 border-b border-border-subtle last:border-0">
        <span className="text-xs text-text-muted">{label}</span>
        <span className="text-sm font-bold text-primary">{value}</span>
      </div>
    )
  );

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-10">
        <button
          type="button"
          onClick={() => profile.backgroundPhoto && setLightbox(profile.backgroundPhoto)}
          className="relative w-full rounded-3xl overflow-hidden bg-gradient-to-br from-primary to-primary-container px-5 pt-5 pb-10 block text-left"
        >
          {profile.backgroundPhoto ? (
            <img src={profile.backgroundPhoto} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div aria-hidden className="absolute inset-0 opacity-10 text-4xl leading-none select-none pointer-events-none flex flex-wrap content-start gap-5 p-3 -rotate-6 -mx-4 -my-2">
              {Array.from({ length: 14 }).map((_, i) => (
                <span key={i}>{['🍼', '🧸', '👶', '⭐', '🩹', '🎈'][i % 6]}</span>
              ))}
            </div>
          )}
          <div className="absolute inset-0 bg-black/10" />
          <h1 className="relative text-lg font-black text-white">{t('babyVax.viewProfile')}</h1>
        </button>

        <div className="flex flex-col items-center -mt-9 relative z-10 mb-1">
          <button type="button" onClick={() => profile.photo && setLightbox(profile.photo)}>
            {profile.photo ? (
              <img src={profile.photo} alt="" className="w-16 h-16 rounded-full object-cover border-4 border-white shadow-md" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-white border-4 border-white shadow-md flex items-center justify-center text-primary font-black text-xl">
                {profile.name.charAt(0).toUpperCase()}
              </div>
            )}
          </button>
          <p className="text-sm font-bold text-primary mt-1.5">{profile.name} · {ageLabel(profile.dob)}</p>
          <span className="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
            {countryInfo?.flag} {planLabel}
          </span>
        </div>

        <div className="bg-white border border-border-subtle rounded-2xl p-4">
          <Row label={t('babyVax.dob')} value={profile.dob} />
          <Row label={t('babyVax.sex')} value={t(`babyVax.sex.${profile.sex}`)} />
          <Row label={t('babyVax.birthWeek')} value={profile.birthWeek != null ? String(profile.birthWeek) : null} />
          <Row label={t('babyVax.babyBloodGroup')} value={profile.babyBloodGroup} />
          <Row label={t('babyVax.motherBloodGroup')} value={profile.motherBloodGroup} />
          <Row label={t('babyVax.country')} value={countryInfo ? `${countryInfo.flag} ${countryInfo.label}` : null} />
          <Row label={t('babyVax.scheduleTemplate')} value={planLabel} />
        </div>

        <button
          type="button"
          onClick={() => navigate(`/baby-vaccinations/edit-profile/${profile.id}`)}
          className="w-full py-3 bg-primary text-white font-bold rounded-2xl flex items-center justify-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[18px]">edit</span>
          {t('common.edit')}
        </button>

        {user && profile.ownerUid === user.uid && (
          <button
            type="button"
            onClick={handleDeleteBaby}
            disabled={deleting}
            className="w-full py-2.5 bg-white border border-error/30 text-error text-xs font-bold rounded-2xl flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
            {deleting ? t('common.saving') : t('babyVax.deleteBaby')}
          </button>
        )}
      </main>

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
