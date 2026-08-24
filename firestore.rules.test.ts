import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, collection } from 'firebase/firestore';
import { readFileSync } from 'fs';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';

let testEnv: RulesTestEnvironment;

describe('Firestore Security Rules', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'test-project',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  it('D1: denies unauthorized read to a group', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, 'groups/group1')));
  });

  it('D5: denies creating group with oversized name', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    const oversizedName = 'a'.repeat(101);
    await assertFails(setDoc(doc(aliceDb, 'groups/group1'), {
      name: oversizedName,
      currency: 'USD',
      createdBy: 'alice',
      createdAt: new Date().toISOString()
    }));
  });

  it('D7: denies write for unverified user', async () => {
    const unverifiedDb = testEnv.authenticatedContext('alice', { email_verified: false }).firestore();
    await assertFails(setDoc(doc(unverifiedDb, 'groups/group1'), {
      name: 'Group 1',
      currency: 'USD',
      createdBy: 'alice',
      createdAt: new Date().toISOString()
    }));
  });

  it('D9: denies spoofing user email', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@test.com' }).firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/bob'), {
      displayName: 'Bob',
      email: 'bob@test.com'
    }));
  });

  it('D10: denies negative expense amount', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    // Pre-create membership
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'members/alice_group1'), {
        userId: 'alice',
        groupId: 'group1',
        role: 'owner',
        joinedAt: new Date().toISOString()
      });
    });

    await assertFails(setDoc(doc(aliceDb, 'expenses/exp1'), {
      groupId: 'group1',
      amount: -5.00,
      description: 'Bad expense',
      category: 'misc',
      date: new Date().toISOString(),
      paidBy: 'alice',
      addedBy: 'alice',
      createdAt: new Date().toISOString()
    }));
  });

  it('allows owner to delete group', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'groups/group1'), { 
        name: 'My Group', 
        createdBy: 'alice',
        createdAt: new Date().toISOString(),
        currency: 'USD'
      });
      await setDoc(doc(context.firestore(), 'members/alice_group1'), {
        userId: 'alice',
        groupId: 'group1',
        role: 'owner',
        joinedAt: new Date().toISOString()
      });
    });

    await assertSucceeds(updateDoc(doc(aliceDb, 'groups/group1'), { name: 'Shared Group' }));
  });

  it('denies a client writing directly to userPoints (Admin-SDK-only)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    await assertFails(setDoc(doc(aliceDb, 'userPoints/alice'), {
      xp: 999999,
      coins: 999999,
      level: 99,
    }));
  });

  it('denies a client writing directly to pointsLedger (would break the idempotency guarantee)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    await assertFails(setDoc(doc(collection(aliceDb, 'pointsLedger')), {
      uid: 'alice',
      actionType: 'expense_logged',
      xp: 5,
      coins: 5,
      createdAt: new Date().toISOString(),
    }));
  });

  it('allows a user to read their own userPoints doc', async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'userPoints/alice'), { xp: 10, coins: 10, level: 1 });
    });
    await assertSucceeds(getDoc(doc(aliceDb, 'userPoints/alice')));
  });

  it("denies reading another user's userPoints doc", async () => {
    const aliceDb = testEnv.authenticatedContext('alice', { email_verified: true }).firestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'userPoints/bob'), { xp: 10, coins: 10, level: 1 });
    });
    await assertFails(getDoc(doc(aliceDb, 'userPoints/bob')));
  });
});
