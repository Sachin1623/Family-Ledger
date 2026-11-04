import React, { useEffect, useState } from 'react';
import { ReminderPermissions, checkReminderPermissions, fixReminderPermissions } from '../lib/paymentReminders';

// A reminder that cannot reach the phone fails without a sound, so say so where the reminders are: on the web they only ring in the
// phone app, and in the app they need the notification permission (and, for exact times, "Alarms & reminders") to be on.
export default function ReminderDeliveryNotice({ needed }: { needed: boolean }) {
  const [perm, setPerm] = useState<ReminderPermissions | null>(null);

  useEffect(() => {
    let live = true;
    checkReminderPermissions().then((p) => { if (live) setPerm(p); });
    return () => { live = false; };
  }, []);

  if (!perm) return null;
  if (!perm.native) {
    return <p className="rounded-xl bg-amber-50 text-amber-800 px-3 py-2 text-xs font-bold">Reminders ring in the FamilyLedger phone app. You can set them up here, but this browser will not ring.</p>;
  }
  if (!needed || (perm.notifications && perm.exact)) return null;
  const fix = async () => {
    await fixReminderPermissions(perm);
    setPerm(await checkReminderPermissions());
  };
  return (
    <div className="rounded-xl bg-amber-50 text-amber-900 px-3 py-2.5 space-y-1.5">
      <p className="text-xs font-bold">
        {!perm.notifications
          ? 'Notifications are off for FamilyLedger, so your payment reminders cannot reach you.'
          : 'Allow “Alarms & reminders” so payment reminders arrive on time, not just sometime that day.'}
      </p>
      <button type="button" onClick={fix} className="rounded-lg bg-amber-200 px-3 py-1.5 text-xs font-black active:scale-95">
        {perm.notifications ? 'Allow' : 'Allow notifications'}
      </button>
      {!perm.notifications && <p className="text-xs">If nothing appears, turn them on in your phone's Settings, under Apps, FamilyLedger.</p>}
    </div>
  );
}
