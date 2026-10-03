import React, { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { collection, doc, query, updateDoc, where } from 'firebase/firestore';
import { useCollection, useDocument } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BabyCaregiverInvite, ReminderPrefs, DEFAULT_REMINDER_PREFS } from '../lib/vaccinations';

function Avatar({ name, photo }: { name: string; photo?: string }) {
  return photo ? (
    <img src={photo} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
  ) : (
    <div className="w-8 h-8 rounded-full bg-primary/15 text-primary font-black flex items-center justify-center shrink-0 text-xs">
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

const TOGGLE_DEFS: { key: keyof ReminderPrefs; labelKey: string; noteKey?: string }[] = [
  { key: 'leadUpNotices', labelKey: 'babyVax.toggleLeadUp' },
  { key: 'dayOfAlarm', labelKey: 'babyVax.toggleDayOf' },
  { key: 'overdueRecurring', labelKey: 'babyVax.toggleOverdue', noteKey: 'babyVax.toggleOverdueNote' },
];

// Purely how-it-works + who's-notified before this screen also got on/off switches per reminder
// category (see ReminderPrefs) — what actually fires for a given visit still branches on that
// visit's own appointment state (booked / not booked / walk-in) exactly as vaccinationReminders.ts
// describes; a switch here just gates whether that category fires at all.
export default function VaccineReminders() {
  const { profileId } = useParams<{ profileId: string }>();
  const { user, profile } = useAuth();
  const { t } = useLanguage();

  const [profileSnap] = useDocument(profileId ? doc(db, 'babyProfiles', profileId) : null);
  const babyProfile = profileSnap?.exists() ? { id: profileSnap.id, ...(profileSnap.data() as any) } : null;
  const prefs: ReminderPrefs = babyProfile?.reminderPrefs || DEFAULT_REMINDER_PREFS;

  const [invitesValue] = useCollection(
    profileId ? query(collection(db, 'babyCaregiverInvites'), where('profileId', '==', profileId), where('status', '==', 'accepted')) : null,
  );
  const acceptedCaregivers: BabyCaregiverInvite[] = useMemo(() => (invitesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [invitesValue]);

  const toggle = async (key: keyof ReminderPrefs) => {
    if (!profileId) return;
    try {
      await updateDoc(doc(db, 'babyProfiles', profileId), {
        reminderPrefs: { ...prefs, [key]: !prefs[key] },
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to update reminder preference:', err);
      alert(t('babyVax.appointmentSaveFailed'));
    }
  };

  if (!babyProfile) {
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
        <div>
          <h1 className="text-xl font-black text-primary">{t('babyVax.remindersTitle')}</h1>
          <p className="text-xs text-text-muted mt-1">{t('babyVax.remindersSubtitle', { name: babyProfile.name })}</p>
        </div>

        <div className="bg-primary/5 rounded-2xl p-3.5">
          <p className="text-xs text-primary leading-relaxed">{t('babyVax.remindersIntro')}</p>
        </div>

        <div>
          <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider mb-2">{t('babyVax.whenToRemind')}</h2>
          <div className="bg-white border border-border-subtle rounded-2xl divide-y divide-border-subtle">
            {TOGGLE_DEFS.map((def) => {
              const on = prefs[def.key];
              return (
                <div key={def.key} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-on-surface">{t(def.labelKey)}</span>
                    <button
                      type="button"
                      onClick={() => toggle(def.key)}
                      className={clsx('w-11 h-6 rounded-full relative shrink-0 transition-colors', on ? 'bg-primary' : 'bg-surface-container')}
                      aria-label={t(def.labelKey)}
                    >
                      <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
                    </button>
                  </div>
                  {def.noteKey && <p className="text-[11px] text-text-muted mt-1">{t(def.noteKey)}</p>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="bg-white border border-border-subtle rounded-2xl p-3.5">
            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('babyVax.remindersBookedTitle')}</p>
            <p className="text-xs text-on-surface leading-relaxed">{t('babyVax.remindersBookedDesc')}</p>
          </div>
          <div className="bg-white border border-border-subtle rounded-2xl p-3.5">
            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('babyVax.remindersNotBookedTitle')}</p>
            <p className="text-xs text-on-surface leading-relaxed">{t('babyVax.remindersNotBookedDesc')}</p>
          </div>
          <div className="bg-white border border-border-subtle rounded-2xl p-3.5">
            <p className="text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">{t('babyVax.remindersWalkInTitle')}</p>
            <p className="text-xs text-on-surface leading-relaxed">{t('babyVax.remindersWalkInDesc')}</p>
          </div>
        </div>

        <div>
          <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider mb-2">{t('babyVax.whoGetsNotified')}</h2>
          <div className="bg-white border border-border-subtle rounded-2xl divide-y divide-border-subtle">
            <div className="flex items-center gap-2.5 px-3.5 py-2.5">
              <Avatar name={babyProfile.ownerUid === user?.uid ? (profile?.displayName || t('common.someone')) : t('common.someone')} photo={profile?.photoURL} />
              <span className="flex-1 text-sm font-bold text-primary">{babyProfile.ownerUid === user?.uid ? t('babyVax.you') : t('babyVax.owner')}</span>
              <span className="material-symbols-outlined text-[16px] text-primary">notifications_active</span>
            </div>
            {acceptedCaregivers.map((c) => (
              <div key={c.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <Avatar name={c.caregiverUid === user?.uid ? (profile?.displayName || t('common.someone')) : t('common.someone')} />
                <span className="flex-1 text-sm font-bold text-primary">{c.caregiverUid === user?.uid ? t('babyVax.you') : t('babyVax.aCaregiver')}</span>
                <span className="material-symbols-outlined text-[16px] text-primary">notifications_active</span>
              </div>
            ))}
            {acceptedCaregivers.length === 0 && (
              <p className="text-xs text-text-muted px-3.5 py-2.5">{t('babyVax.noOtherCaregivers')}</p>
            )}
          </div>
        </div>

        <p className="text-[11px] text-text-muted leading-relaxed px-1">{t('babyVax.remindersDeviceNote')}</p>
      </main>
    </div>
  );
}
