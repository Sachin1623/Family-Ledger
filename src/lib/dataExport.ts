import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { shareOrDownloadFile } from './fileShare';

// GDPR/UK-GDPR data portability (Article 20) — a self-serve export of the data this account
// actually concerns, alongside the existing account-deletion path. Deliberately scoped to what a
// user would reasonably recognize as "my data" (their own profile, what they've added, what
// they're a party to) rather than every document a group's Firestore rules happen to let them
// read — a group's OTHER members' full expense history isn't this user's personal data to export.
// Uses only queries this account's own Firestore rules already permit (the same reads the rest of
// the app already performs), so no new server endpoint or elevated access is needed.
export async function exportMyData(uid: string): Promise<void> {
  const [
    userSnap,
    privateSnap,
    membershipsSnap,
    myLoanContactsSnap,
    theirLoanContactsSnap,
    todosSnap,
    userPointsSnap,
    myLedgerSnap,
    friendshipsSnap,
  ] = await Promise.all([
    getDoc(doc(db, 'users', uid)),
    getDoc(doc(db, 'users', uid, 'private', 'info')),
    getDocs(query(collection(db, 'members'), where('userId', '==', uid))),
    getDocs(query(collection(db, 'loanContacts'), where('ownerId', '==', uid))),
    getDocs(query(collection(db, 'loanContacts'), where('linkedUserId', '==', uid))),
    getDocs(query(collection(db, 'todos'), where('userId', '==', uid))),
    getDoc(doc(db, 'userPoints', uid)),
    getDocs(query(collection(db, 'pointsLedger'), where('uid', '==', uid))),
    getDocs(query(collection(db, 'friendships'), where('participants', 'array-contains', uid))),
  ]);

  // `expenses` rules gate reads on group membership (via `canModifyGroup(resource.data.groupId)`),
  // not on `addedBy` — a query filtering only by `addedBy` (no groupId) can't be proven safe by
  // Firestore's rule engine for a `list` operation and would be rejected outright. Queried per
  // group instead (each one provably safe, since this account is a genuine member of every group
  // in its own `membershipsSnap`), then filtered down to entries this account actually added.
  const myGroupIds = Array.from(new Set(membershipsSnap.docs.map((d) => d.data().groupId as string)));
  const expensesByGroup = await Promise.all(
    myGroupIds.map((groupId) => getDocs(query(collection(db, 'expenses'), where('groupId', '==', groupId)))),
  );
  const myExpenses = expensesByGroup
    .flatMap((snap) => snap.docs)
    .filter((d) => d.data().addedBy === uid)
    .map((d) => ({ id: d.id, ...d.data() }));

  // Loan contact entries live in a subcollection per contact — fetched after the contacts
  // themselves so we know which contact IDs to walk.
  const ownedContactIds = myLoanContactsSnap.docs.map((d) => d.id);
  const contactEntries = await Promise.all(
    ownedContactIds.map(async (contactId) => {
      const entriesSnap = await getDocs(collection(db, 'loanContacts', contactId, 'entries'));
      return { contactId, entries: entriesSnap.docs.map((d) => ({ id: d.id, ...d.data() })) };
    }),
  );

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    profile: userSnap.exists() ? userSnap.data() : null,
    privateInfo: privateSnap.exists() ? privateSnap.data() : null,
    groupMemberships: membershipsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    expensesIAdded: myExpenses,
    personalLoans: {
      contactsIOwn: myLoanContactsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      contactsLinkedToMe: theirLoanContactsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      entriesByContact: contactEntries,
    },
    todosAndHabits: todosSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    gamification: {
      points: userPointsSnap.exists() ? userPointsSnap.data() : null,
      ledger: myLedgerSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    },
    friendships: friendshipsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  await shareOrDownloadFile(blob, `familyledger-my-data-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}
