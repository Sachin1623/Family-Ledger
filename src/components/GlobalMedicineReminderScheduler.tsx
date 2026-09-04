import { useEffect } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { Medicine } from '../lib/medicines';
import { scheduleMedicineReminders } from '../lib/medicineReminders';

// Medicine reminder alarms previously only got (re)armed by HealthMedicines.tsx's own mount
// effect — so on any day the user didn't happen to open Medicine Reminders before a dose's time,
// that dose's alarm for TODAY was never scheduled at all. It isn't "missed" in the sense of firing
// late or silently failing: computeNextTrigger() (AlarmScheduler.java) correctly rolls a time
// that's already passed forward to tomorrow, the next time scheduling runs — so whatever moment
// the app happens to next reschedule from becomes the cutoff, and only dose times still ahead of
// THAT moment get armed for today. A user who opened the app mid-afternoon would see their morning
// dose silently roll to tomorrow while their evening doses still fire — exactly the "only got an
// alarm for the later dose" symptom this was built to fix.
//
// Same root cause, and same fix, GlobalReminderScheduler.tsx already applied to Shared Reminders
// (see its own header comment) — mounted once at the app root (alongside it) so alarms get
// (re)armed every session regardless of which screen happens to be open, not just when Medicine
// Reminders itself is visited. HealthMedicines.tsx keeps its own local scheduling call too (same
// belt-and-suspenders precedent RemindersHub.tsx follows for shared reminders) — rescheduling with
// identical data twice is a harmless no-op, not a real duplicate.
export default function GlobalMedicineReminderScheduler() {
  const { user } = useAuth();
  // Only this user's OWN medicines — group/friend-shared ones (someone else's medicine visible to
  // you) and delegate-managed ones (added by a caregiver, owned by the OTHER person) never belong
  // on THIS device's alarm list, same filter HealthMedicines.tsx's own scheduling effect applies.
  const [medicinesValue] = useCollection(user ? query(collection(db, 'medicines'), where('userId', '==', user.uid)) : null);
  const myMedicines: Medicine[] = medicinesValue?.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) || [];

  useEffect(() => {
    if (!user) return;
    scheduleMedicineReminders(myMedicines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user?.uid,
    JSON.stringify(myMedicines.map((m) => [m.id, m.active, m.remindersEnabled, m.times, m.weekdays, m.intervalDays, m.startDate, m.durationMode, m.endDate, m.dayCount])),
  ]);

  return null;
}
