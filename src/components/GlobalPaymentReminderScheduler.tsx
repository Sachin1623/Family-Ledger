import { useEffect, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { collection, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { PaymentReminder, rings, syncPaymentReminders } from '../lib/paymentReminders';
import { canPay } from './PaymentRolePicker';

// Keeps this phone's payment reminders right without the person opening anything: the reminders that name them, plus those of every
// Payments group where they are marked Payer. A person added as payer later (or whose role is set later) is picked up as soon as the
// membership changes, so their phone starts ringing without anyone setting the reminder up again. Phone apps only: the web has no
// on-device reminders, so it reads nothing.
export default function GlobalPaymentReminderScheduler() {
  const { user } = useAuth();
  const native = Capacitor.isNativePlatform();
  const uid = native ? user?.uid : undefined;

  const [membersSnap] = useCollection(uid ? query(collection(db, 'members'), where('userId', '==', uid)) : null);
  const payerGroups = useMemo(
    () => Array.from(new Set((membersSnap?.docs || []).map((d) => d.data() as any).filter((m) => canPay(m.paymentRole)).map((m) => m.groupId as string))).slice(0, 30),
    [membersSnap],
  );
  const [byRoleSnap] = useCollection(uid && payerGroups.length > 0 ? query(collection(db, 'groupPaymentReminders'), where('groupId', 'in', payerGroups)) : null);
  const [byNameSnap] = useCollection(uid ? query(collection(db, 'groupPaymentReminders'), where('payerUid', '==', uid)) : null);

  const mine = useMemo(() => {
    if (!uid) return [];
    const groups = new Set<string>(payerGroups);
    const seen = new Map<string, PaymentReminder>();
    [...(byRoleSnap?.docs || []), ...(byNameSnap?.docs || [])].forEach((d) => seen.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(seen.values()).filter((r) => rings(r, uid, groups));
  }, [uid, payerGroups, byRoleSnap, byNameSnap]);

  // re-arm only when something about a reminder actually changed
  const signature = useMemo(
    () => JSON.stringify(mine.map((r) => [r.id, r.label, r.amount, r.startDate, r.time, r.freq, r.mode, r.active, r.groupName]).sort()),
    [mine],
  );
  const loaded = !!membersSnap && !!byNameSnap && (payerGroups.length === 0 || !!byRoleSnap);

  useEffect(() => {
    if (!uid || !loaded) return;
    void syncPaymentReminders(mine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, loaded, signature]);

  return null;
}
