import { collection, doc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { fireWrite } from './offlineWrite';
import { notifyGroupActivity } from './notifyGroupActivity';

// Records a payment between two members of a group: "Ravi paid Anita 500". It is saved in its own `settlements` collection, NOT as an expense, so it never
// counts toward the group's spending, a budget, a report or points. It only moves the balance (see settleMath.ts). Shown in the group's list and the feed as a payment.
export interface RecordSettlementInput {
  groupId: string;
  groupName?: string;
  currencyCode?: string;
  fromUid: string;
  fromName: string;
  toUid: string;
  toName: string;
  amount: number;
  date?: string; // YYYY-MM-DD, defaults to today
  note?: string;
  addedBy: string;
  actorName: string;
  actorPhoto?: string;
}

const todayLocal = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function recordSettlement(input: RecordSettlementInput): string {
  const ref = doc(collection(db, 'settlements'));
  const now = new Date().toISOString();
  const amount = Math.round(input.amount * 100) / 100;
  fireWrite(
    setDoc(ref, {
      groupId: input.groupId,
      fromUid: input.fromUid,
      toUid: input.toUid,
      fromName: input.fromName,
      toName: input.toName,
      amount,
      date: input.date || todayLocal(),
      ...(input.note ? { note: input.note.slice(0, 200) } : {}),
      addedBy: input.addedBy,
      createdAt: now,
    }),
    'record payment',
  );
  fireWrite(
    setDoc(doc(collection(db, 'activities')), {
      groupId: input.groupId,
      userId: input.addedBy,
      userName: input.actorName,
      userPhoto: input.actorPhoto || '',
      type: 'settle_payment',
      description: `${input.fromName} paid ${input.toName}`,
      data: {
        amount,
        fromName: input.fromName,
        toName: input.toName,
        settlementId: ref.id,
        ...(input.groupName ? { groupName: input.groupName } : {}),
        ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
      },
      createdAt: now,
    }),
    'log payment activity',
  );
  notifyGroupActivity({
    groupId: input.groupId,
    action: 'payment_recorded',
    description: `${input.fromName} paid ${input.toName}`,
    amount,
    actorName: input.actorName,
  });
  return ref.id;
}
