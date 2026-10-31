import React, { Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { doc } from 'firebase/firestore';
import { useDocument } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { lazyScreen } from '../lib/lazyScreen';

// A "Payments" group has no expenses or analysis, so its group routes show the payments record instead. Every other group
// type renders the screen the route would have shown anyway.
const GroupPayments = lazyScreen(() => import('../screens/GroupPayments'));

export default function PaymentsGate({ children }: { children: React.ReactNode }) {
  const { groupId } = useParams<{ groupId: string }>();
  const [snap, loading] = useDocument(groupId ? doc(db, 'groups', groupId) : null);
  if (groupId && loading) return null;
  if (snap?.data()?.groupType === 'payments') {
    return <Suspense fallback={null}><GroupPayments /></Suspense>;
  }
  return <>{children}</>;
}
