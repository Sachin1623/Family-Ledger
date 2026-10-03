import React, { useMemo, useState } from 'react';
import { collection, doc, getDocs, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BabyProfile } from '../lib/vaccinations';

// Deliberately scoped to babies the current user OWNS (not ones they're a caregiver on) — deleting
// a baby is an owner-only action (VaccineProfileView.tsx's own Delete button is gated the same
// way), so there's never a caregiver-owned entry to show here.
export default function VaccineDeletedBabies() {
  const { user } = useAuth();
  const { t } = useLanguage();

  const [ownProfilesValue] = useCollection(user ? query(collection(db, 'babyProfiles'), where('ownerUid', '==', user.uid)) : null);
  const deletedProfiles: BabyProfile[] = useMemo(
    () => (ownProfilesValue?.docs || [])
      .map((d) => ({ id: d.id, ...(d.data() as any) }))
      .filter((p: BabyProfile) => !!p.deletedAt)
      .sort((a: BabyProfile, b: BabyProfile) => (b.deletedAt || '').localeCompare(a.deletedAt || '')),
    [ownProfilesValue],
  );

  const [busyId, setBusyId] = useState<string | null>(null);

  const handleRestore = async (profile: BabyProfile) => {
    setBusyId(profile.id);
    try {
      await updateDoc(doc(db, 'babyProfiles', profile.id), { deletedAt: null, updatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('Failed to restore baby profile:', err);
      alert(t('babyVax.createFailed'));
    } finally {
      setBusyId(null);
    }
  };

  // Cascades into every collection scoped to this profile — otherwise "permanently delete" would
  // leave the baby's own doses/appointments/invites behind as orphaned reads nothing ever surfaces
  // again, which isn't what "permanent" promised in the confirmation dialog.
  const handlePermanentlyDelete = async (profile: BabyProfile) => {
    if (!window.confirm(t('babyVax.confirmDeleteBabyPermanently', { name: profile.name }))) return;
    setBusyId(profile.id);
    try {
      const [dosesSnap, apptsSnap, invitesSnap] = await Promise.all([
        getDocs(query(collection(db, 'vaccineDoses'), where('profileId', '==', profile.id))),
        getDocs(query(collection(db, 'vaccineAppointments'), where('profileId', '==', profile.id))),
        getDocs(query(collection(db, 'babyCaregiverInvites'), where('profileId', '==', profile.id))),
      ]);
      const batch = writeBatch(db);
      dosesSnap.docs.forEach((d) => batch.delete(d.ref));
      apptsSnap.docs.forEach((d) => batch.delete(d.ref));
      invitesSnap.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(doc(db, 'babyProfiles', profile.id));
      await batch.commit();
    } catch (err) {
      console.error('Failed to permanently delete baby profile:', err);
      alert(t('babyVax.createFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-4 pb-10">
        <h1 className="text-xl font-black text-primary">{t('babyVax.deletedBabies')}</h1>

        {deletedProfiles.length === 0 ? (
          <p className="text-sm text-text-muted text-center mt-10">{t('babyVax.noDeletedBabies')}</p>
        ) : (
          <div className="space-y-2">
            {deletedProfiles.map((p) => (
              <div key={p.id} className="bg-white border border-border-subtle rounded-2xl p-3.5 flex items-center gap-3">
                {p.photo ? (
                  <img src={p.photo} alt="" className="w-11 h-11 rounded-full object-cover shrink-0 opacity-70" />
                ) : (
                  <div className="w-11 h-11 rounded-full bg-surface-container text-text-muted font-black flex items-center justify-center shrink-0">
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-text-muted truncate">{p.name}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      type="button"
                      onClick={() => handleRestore(p)}
                      disabled={busyId === p.id}
                      className="flex-1 py-1.5 bg-primary/5 border border-primary/20 text-primary text-[11px] font-bold rounded-lg flex items-center justify-center gap-1 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[14px]">undo</span>
                      {t('babyVax.restoreBaby')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePermanentlyDelete(p)}
                      disabled={busyId === p.id}
                      className="flex-1 py-1.5 bg-white border border-error/30 text-error text-[11px] font-bold rounded-lg disabled:opacity-50"
                    >
                      {t('babyVax.deleteBabyPermanently')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
