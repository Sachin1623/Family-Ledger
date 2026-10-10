import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { scheduleMedicineReminders } from '../lib/medicineReminders';
import { useMedicineDelegators } from '../lib/useMedicineDelegators';

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
//
// ALSO includes every medicine the signed-in user is a DELEGATE for (via useMedicineDelegators,
// mirroring HealthMedicines.tsx's own `myActiveMedicines` filter) — this used to be a bare
// userId==uid query that deliberately left delegate-managed medicines out, on the theory that
// HealthMedicines.tsx's own effect would cover them. It doesn't, in practice: that effect only
// runs while the Medicines screen is mounted, so a delegate's alarm for someone else's medicine
// only ever gets reconciled against that medicine's CURRENT state (course ended, incident closed,
// paused, deleted...) if the delegate happens to reopen that specific screen afterward. A native
// AlarmClock alarm has no built-in expiry (see medicineReminders.ts's own comment on this) — it
// just keeps ringing on schedule until something explicitly cancels it — so a delegate who
// scheduled the alarm once while the course was active, then never revisited Medicines after it
// ended, kept hearing it forever. Folding delegate medicines into this app-root scheduler closes
// that gap the same way it already closed it for the user's own medicines.
export default function GlobalMedicineReminderScheduler() {
  const { user } = useAuth();
  const { medicines, ownerNames, loaded } = useMedicineDelegators(user?.uid);

  useEffect(() => {
    if (!user || !loaded) return;
    scheduleMedicineReminders(medicines, user.uid, ownerNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user?.uid,
    loaded,
    JSON.stringify(medicines.map((m) => [m.id, m.userId, m.active, m.remindersEnabled, m.times, m.weekdays, m.intervalDays, m.startDate, m.durationMode, m.endDate, m.dayCount])),
    ownerNames,
  ]);

  return null;
}
