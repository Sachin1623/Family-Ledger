import { useEffect, useMemo } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useVaccineCaregivers } from '../lib/useVaccineCaregivers';
import { scheduleVaccineReminders, groupDosesIntoVisits } from '../lib/vaccinationReminders';
import { VaccineDose, VaccineAppointment } from '../lib/vaccinations';

// Vaccination alarms previously only got (re)armed by BabyVaccinations.tsx's own mount effect —
// and even then, only for whichever ONE baby happened to be "active" in that screen (see its own
// updated header comment: scheduleVaccineReminders cancels-and-rebuilds a single shared alarm set,
// so reconciling with just the active profile's visits would silently wipe every other baby's
// already-armed alarms). A baby nobody has opened Baby Vaccinations for recently — or whose
// caregiver simply hasn't had that screen open this session — could ring a stale alarm (course
// changed, dose logged, reminder settings edited) that never gets reconciled against current state.
// Same root cause, and same fix, GlobalMedicineReminderScheduler.tsx already applied to medicines:
// mounted once at the app root so every profile's reminders get reconciled every session,
// regardless of which screen is open. Covers every profile the user owns OR has accepted
// caregiver access to (useVaccineCaregivers) — the same set BabyVaccinations.tsx and AlarmsHub.tsx
// use, so all three can never again disagree on which babies are in scope.
export default function GlobalVaccineReminderScheduler() {
  const { user } = useAuth();
  const { profiles, loaded: profilesLoaded } = useVaccineCaregivers(user?.uid);
  const profileIds = useMemo(() => profiles.map((p) => p.id), [profiles]);

  const [dosesValue] = useCollection(
    profileIds.length > 0 ? query(collection(db, 'vaccineDoses'), where('profileId', 'in', profileIds.slice(0, 30))) : null,
  );
  const [appointmentsValue] = useCollection(
    profileIds.length > 0 ? query(collection(db, 'vaccineAppointments'), where('profileId', 'in', profileIds.slice(0, 30))) : null,
  );

  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const visits = useMemo(() => {
    const liveDoses = (dosesValue?.docs || [])
      .map((d) => ({ id: d.id, ...(d.data() as any) }) as VaccineDose)
      .filter((d) => !d.deletedAt);
    return groupDosesIntoVisits(liveDoses, profilesById);
  }, [dosesValue, profilesById]);
  const appointmentsById = useMemo(() => {
    const m = new Map<string, VaccineAppointment>();
    (appointmentsValue?.docs || []).forEach((d) => m.set(d.id, { id: d.id, ...(d.data() as any) }));
    return m;
  }, [appointmentsValue]);

  // Every (profile, visit) present in the data — deleted and completed ones included — so their
  // alarms get cancelled by derived id even if the stored list of armed ids is missing them.
  const knownVisits = useMemo(() => {
    const seen = new Map<string, { profileId: string; visitKey: string }>();
    (dosesValue?.docs || []).forEach((d) => {
      const data = d.data() as any;
      seen.set(`${data.profileId}_${data.visitKey}`, { profileId: data.profileId, visitKey: data.visitKey });
    });
    return Array.from(seen.values());
  }, [dosesValue]);

  const dataReady = profilesLoaded && (profileIds.length === 0 || (dosesValue !== undefined && appointmentsValue !== undefined));

  useEffect(() => {
    if (!user || !dataReady) return;
    scheduleVaccineReminders(visits, appointmentsById, knownVisits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user?.uid,
    dataReady,
    knownVisits.length,
    JSON.stringify(visits.map((v) => [v.profileId, v.visitKey, v.dueDate, v.reminderPrefs, v.doses.map((d) => [d.id, d.status])])),
    JSON.stringify(Array.from(appointmentsById.values()).map((a: VaccineAppointment) => [a.id, a.booked, a.date, a.time, a.walkIn])),
  ]);

  return null;
}
