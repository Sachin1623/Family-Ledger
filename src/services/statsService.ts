import { db } from '../lib/firebase';
import { doc, updateDoc, increment, getDoc, setDoc, collection, getCountFromServer, getDocs } from 'firebase/firestore';

const STATS_DOC_PATH = 'stats/global';

export const initializeStatsIfEmpty = async () => {
  const statsRef = doc(db, STATS_DOC_PATH);
  const statsDoc = await getDoc(statsRef);
  
  // Re-syncs from live collection counts whenever any core counter looks like it's drifted to
  // zero while the others haven't — this is a real failure mode, not hypothetical: a Firestore
  // data migration/re-sync (bulk-writing users/groups/expenses directly) doesn't go through the
  // normal signup/create-group/add-expense code paths that increment these counters, so a
  // migration can leave totalUsers/totalGroups stuck at 0 indefinitely while totalExpenses keeps
  // incrementing normally from real usage afterward — the original narrower check here missed
  // exactly that case (found 2026-08-04: totalUsers/totalGroups were 0 against 37 users/26
  // groups/87 expenses actually in Firestore).
  const existingData = statsDoc.data();
  const shouldInitialize =
    !statsDoc.exists() ||
    existingData?.totalExpenses === 0 ||
    existingData?.totalUsers === 0 ||
    existingData?.totalGroups === 0;

  if (shouldInitialize) {
    try {
      console.log('Stats initialization starting...');
      // Get counts efficiently
      const usersCount = (await getCountFromServer(collection(db, 'users'))).data().count;
      const groupsCount = (await getCountFromServer(collection(db, 'groups'))).data().count;
      
      let expensesCount = 0;
      let totalAmount = 0;

      // This will now work for Sachin because of the updated rules
      try {
        const expensesSnapshot = await getDocs(collection(db, 'expenses'));
        expensesCount = expensesSnapshot.size;
        expensesSnapshot.forEach(doc => {
          totalAmount += parseFloat(doc.data().amount || 0);
        });
        console.log(`Counted ${expensesCount} expenses with total ${totalAmount}`);
      } catch (e) {
        console.warn('Could not count expenses in init', e);
      }

      await setDoc(statsRef, {
        totalUsers: usersCount,
        totalGroups: groupsCount,
        totalExpenses: expensesCount,
        totalAmount: totalAmount
      }, { merge: true });
    } catch (error) {
      console.error('Error during stats initialization:', error);
    }
  }
};

export const updateGlobalStats = async (updates: {
  users?: number;
  groups?: number;
  expenses?: number;
  amount?: number;
}) => {
  const statsRef = doc(db, STATS_DOC_PATH);
  
  try {
    const statsDoc = await getDoc(statsRef);
    
    const incrementData: any = {};
    if (updates.users) incrementData.totalUsers = increment(updates.users);
    if (updates.groups) incrementData.totalGroups = increment(updates.groups);
    if (updates.expenses) incrementData.totalExpenses = increment(updates.expenses);
    if (updates.amount) incrementData.totalAmount = increment(updates.amount);
    
    if (!statsDoc.exists()) {
      // First time initialization
      await setDoc(statsRef, {
        totalUsers: updates.users || 0,
        totalGroups: updates.groups || 0,
        totalExpenses: updates.expenses || 0,
        totalAmount: updates.amount || 0
      });
    } else {
      await updateDoc(statsRef, incrementData);
    }
  } catch (error) {
    console.error('Error updating global stats:', error);
  }
};
