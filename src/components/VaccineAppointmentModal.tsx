import React, { useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { VaccineAppointment, vaccineAppointmentId } from '../lib/vaccinations';

// Shared by the visit detail screen (LogVaccineVisit.tsx) — the only place this now opens from;
// it used to also live inline on BabyVaccinations.tsx's dashboard tiles, but "update appointment"
// belongs to the visit you've actually opened, not a tap target on the summary tile itself (which
// now just shows the resulting status — see appointmentSummaryText in vaccinations.ts).
export default function VaccineAppointmentModal({
  profileId, ownerUid, visitKey, visitLabel, appt, onClose,
}: { profileId: string; ownerUid: string; visitKey: string; visitLabel: string; appt: VaccineAppointment | undefined; onClose: () => void }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [booked, setBooked] = useState(!!appt?.booked);
  const [date, setDate] = useState(appt?.date || '');
  const [time, setTime] = useState(appt?.time || '');
  const [clinic, setClinic] = useState(appt?.clinic || '');
  const [doctor, setDoctor] = useState(appt?.doctor || '');
  const [saving, setSaving] = useState(false);

  const save = async (walkIn: boolean) => {
    if (!user) return;
    setSaving(true);
    try {
      const id = vaccineAppointmentId(profileId, visitKey);
      await setDoc(doc(db, 'vaccineAppointments', id), {
        profileId,
        ownerUid,
        visitKey,
        visitLabel,
        booked: walkIn ? false : booked,
        date: walkIn ? null : booked ? date || null : null,
        time: walkIn ? null : booked ? time || null : null,
        clinic: walkIn ? null : booked ? clinic || null : null,
        doctor: walkIn ? null : booked ? doctor || null : null,
        walkIn,
        updatedAt: new Date().toISOString(),
        updatedBy: user.uid,
      });
      onClose();
    } catch (err) {
      console.error('Failed to save appointment:', err);
      alert(t('babyVax.appointmentSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-black text-primary flex-1">{t('babyVax.appointmentFor', { visit: visitLabel })}</h2>
          <button type="button" onClick={onClose} className="text-text-muted shrink-0"><span className="material-symbols-outlined">close</span></button>
        </div>

        <div className="flex bg-surface border border-border-subtle rounded-xl p-1 gap-1">
          <button type="button" onClick={() => setBooked(true)} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold', booked ? 'bg-primary text-white' : 'text-text-muted')}>{t('babyVax.appointmentBooked')}</button>
          <button type="button" onClick={() => setBooked(false)} className={clsx('flex-1 py-2 rounded-lg text-xs font-bold', !booked ? 'bg-primary text-white' : 'text-text-muted')}>{t('babyVax.appointmentNotBooked')}</button>
        </div>

        {booked ? (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            </div>
            <input type="text" value={clinic} onChange={(e) => setClinic(e.target.value)} placeholder={t('babyVax.clinicPlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            <input type="text" value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder={t('babyVax.doctorPlaceholder')} className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none" />
            <p className="text-[11px] text-text-muted leading-relaxed">{t('babyVax.appointmentBookedHint')}</p>
            <button type="button" onClick={() => save(false)} disabled={saving || !date || !time} className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50">
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[11px] text-text-muted leading-relaxed">{t('babyVax.appointmentNotBookedHint')}</p>
            <button type="button" onClick={() => save(true)} disabled={saving} className="w-full py-3 bg-surface border border-border-subtle text-primary font-bold rounded-xl disabled:opacity-50">
              {t('babyVax.walkInButton')}
            </button>
            <button type="button" onClick={onClose} className="w-full py-2 text-xs font-bold text-text-muted">{t('babyVax.decideLater')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
