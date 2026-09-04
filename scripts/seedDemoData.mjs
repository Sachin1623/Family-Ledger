// One-off script: seeds realistic demo data across most of FamilyLedger's features, all owned by
// the App Store review demo account (system@thirteenapps.com), for App Store Connect screenshots.
//
// Run with:  node scripts/seedDemoData.mjs
//
// Writes directly to production Firestore via the Admin SDK (Application Default Credentials —
// `gcloud auth application-default login` must already be set up, same as deploy_rules.py), which
// bypasses firestore.rules entirely — so this can write fields (userPoints, gameOutcomes, etc.)
// that ordinary client writes never could. Financial-amount fields on Goals/Financial Accounts are
// field-level encrypted (see src/lib/fieldCrypto.ts) — this script re-implements that exact
// AES-256-GCM scheme locally using FIELD_ENCRYPTION_SECRET from .env (the same master secret
// server.ts's /api/crypto/key derives from), rather than going through the live key endpoint, so
// no network round trip or auth token is needed to write correctly-encrypted values.
//
// Idempotency: guarded by a marker doc (appSeed/system_demo_v1) — re-running after a partial
// failure is safe to retry from scratch (it always overwrites its own docs by fixed/deterministic
// ID), but running it a second time after a full success is a no-op unless RESEED=1 is set.

import 'dotenv/config';
import crypto from 'node:crypto';
import admin from 'firebase-admin';

const DEMO_EMAIL = 'system@thirteenapps.com';
const DEMO_PASSWORD = 'apple@ta124';
const DEMO_NAME = 'Priya Verma';

const SECRET = process.env.FIELD_ENCRYPTION_SECRET;
if (!SECRET) {
  console.error('FIELD_ENCRYPTION_SECRET is not set in .env — cannot write encrypted Goal/Account fields.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'familyledgerta',
});
const db = admin.firestore();
const auth = admin.auth();

// ---------- Field-level crypto (mirrors src/lib/fieldCrypto.ts byte-for-byte) ----------
const ENC_PREFIX = 'enc:v1:';
function scopeKey(scopeType, scopeId) {
  // Same derivation as server.ts's /api/crypto/key: HMAC-SHA256(secret, "scopeType:scopeId"),
  // and the raw 32-byte digest is used directly as the AES-256-GCM key (no base64 round trip
  // needed here since we're not crossing a network boundary).
  return crypto.createHmac('sha256', SECRET).update(`${scopeType}:${scopeId}`).digest();
}
function encAmount(scopeType, scopeId, valueMinor) {
  const key = scopeKey(scopeType, scopeId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(String(Math.round(valueMinor)), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const combined = Buffer.concat([ct, cipher.getAuthTag()]); // WebCrypto appends the tag to the ciphertext — match that here
  return `${ENC_PREFIX}${iv.toString('base64')}:${combined.toString('base64')}`;
}
function encText(scopeType, scopeId, text) {
  const key = scopeKey(scopeType, scopeId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(text, 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const combined = Buffer.concat([ct, cipher.getAuthTag()]);
  return `${ENC_PREFIX}${iv.toString('base64')}:${combined.toString('base64')}`;
}
function decAmount(scopeType, scopeId, value) {
  // Self-check helper only (used right after writing, to prove the round trip works) — never
  // called by the app itself, which decrypts client-side via WebCrypto.
  const [ivB64, ctB64] = value.slice(ENC_PREFIX.length).split(':');
  const key = scopeKey(scopeType, scopeId);
  const iv = Buffer.from(ivB64, 'base64');
  const combined = Buffer.from(ctB64, 'base64');
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return Number(plain.toString('utf8'));
}

// ---------- Small helpers ----------
const toMinor = (rupees) => Math.round(rupees * 100); // Goals/Accounts: paise
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const dateStrDaysAgo = (n) => isoDaysAgo(n).slice(0, 10); // YYYY-MM-DD
const monthKeyMonthsAgo = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 7); // YYYY-MM
};
const avatar = (name, bg) => `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${bg}&color=fff&bold=true`;
const rid = () => crypto.randomUUID();
const newId = (col) => db.collection(col).doc().id;

let writeCount = 0;
async function set(ref, data) {
  await ref.set(data);
  writeCount++;
}

async function main() {
  console.log(`Seeding demo data for ${DEMO_EMAIL} ...`);

  // ---------- 0. Marker / idempotency guard ----------
  const markerRef = db.collection('appSeed').doc('system_demo_v1');
  const markerSnap = await markerRef.get();
  if (markerSnap.exists && process.env.RESEED !== '1') {
    console.log('Already seeded (appSeed/system_demo_v1 exists). Set RESEED=1 to re-run anyway.');
    process.exit(0);
  }

  // ---------- 1. Demo account itself ----------
  let demoUser;
  try {
    demoUser = await auth.getUserByEmail(DEMO_EMAIL);
    console.log(`Found existing auth user ${demoUser.uid}`);
  } catch {
    demoUser = await auth.createUser({
      email: DEMO_EMAIL, password: DEMO_PASSWORD, displayName: DEMO_NAME, emailVerified: true,
    });
    console.log(`Created auth user ${demoUser.uid}`);
  }
  const uid = demoUser.uid;
  const demoPhoto = avatar(DEMO_NAME, '6C5CE7');

  await set(db.collection('users').doc(uid), {
    displayName: DEMO_NAME, photoURL: demoPhoto, email: DEMO_EMAIL,
    uid, joinedAt: isoDaysAgo(180),
  });

  // ---------- 2. Synthetic family/friend "people" (not real accounts — just users/{fakeUid} +
  // member/loanContact records denormalizing their name/photo, same as any group member) ----------
  const PEOPLE = {
    rohan: { uid: 'demo_rohan_verma', name: 'Rohan Verma', bg: '0984E3' },
    aarav: { uid: 'demo_aarav_verma', name: 'Aarav Verma', bg: 'E17055' },
    meera: { uid: 'demo_meera_verma', name: 'Meera Verma', bg: 'FD79A8' },
    karan: { uid: 'demo_karan_mehta', name: 'Karan Mehta', bg: '00B894' },
    amit: { uid: 'demo_amit_singh', name: 'Amit Singh', bg: 'FDCB6E' },
  };
  for (const p of Object.values(PEOPLE)) {
    p.photo = avatar(p.name, p.bg);
    await set(db.collection('users').doc(p.uid), {
      displayName: p.name, photoURL: p.photo, email: '', uid: p.uid, joinedAt: isoDaysAgo(200),
    });
  }

  // ==================================================================================
  // 3. FAMILY GROUP — expenses, category budget split, recurring bill, activities
  // ==================================================================================
  const familyGroupId = newId('groups');
  await set(db.collection('groups').doc(familyGroupId), {
    name: 'The Sharma-Verma Family', description: 'Household budget & shared bills', currency: 'INR',
    icon: '👨‍👩‍👧‍👦', photoURL: '', splitEnabled: true, incomeEnabled: true, groupType: 'regular',
    createdBy: uid, createdAt: isoDaysAgo(120), totalSpending: 0, totalIncome: 0, memberCount: 4,
    coverImage: 'https://images.unsplash.com/photo-1511895426328-dc8714191300?auto=format&fit=crop&q=80&w=1000',
  });
  const familyMembers = [
    { uid, role: 'owner', name: DEMO_NAME, photo: demoPhoto },
    { uid: PEOPLE.rohan.uid, role: 'admin', name: PEOPLE.rohan.name, photo: PEOPLE.rohan.photo },
    { uid: PEOPLE.aarav.uid, role: 'member', name: PEOPLE.aarav.name, photo: PEOPLE.aarav.photo },
    { uid: PEOPLE.meera.uid, role: 'member', name: PEOPLE.meera.name, photo: PEOPLE.meera.photo },
  ];
  for (const m of familyMembers) {
    await set(db.collection('members').doc(`${m.uid}_${familyGroupId}`), {
      userId: m.uid, groupId: familyGroupId, role: m.role, canInvite: true,
      joinedAt: isoDaysAgo(120), displayName: m.name, photoURL: m.photo,
    });
  }

  const familyExpenses = [
    { cat: 'housing', desc: 'September Rent', amt: 25000, days: 3, paidBy: uid, fav: false, income: false },
    { cat: 'groceries', desc: 'BigBasket weekly order', amt: 3200, days: 2, paidBy: uid, fav: true, income: false },
    { cat: 'bills', desc: 'Electricity Bill', amt: 2400, days: 5, paidBy: uid, fav: false, income: false },
    { cat: 'food', desc: 'Zomato — family dinner', amt: 850, days: 3, paidBy: uid, fav: false, income: false },
    { cat: 'travel', desc: 'Uber to airport', amt: 650, days: 7, paidBy: PEOPLE.rohan.uid, fav: false, income: false },
    { cat: 'health', desc: 'Pharmacy — Metformin refill', amt: 480, days: 6, paidBy: uid, fav: true, income: false },
    { cat: 'education', desc: "Aarav's tuition fee", amt: 4000, days: 10, paidBy: PEOPLE.rohan.uid, fav: false, income: false },
    { cat: 'kids', desc: 'School supplies', amt: 1200, days: 12, paidBy: uid, fav: false, income: false },
    { cat: 'ent', desc: 'Movie night', amt: 1400, days: 14, paidBy: PEOPLE.rohan.uid, fav: false, income: false },
    { cat: 'finance', desc: 'Mutual fund SIP', amt: 10000, days: 15, paidBy: uid, fav: false, income: false },
    { cat: 'shopping', desc: 'Winter clothes', amt: 3500, days: 20, paidBy: uid, fav: false, income: false },
    { cat: 'household', desc: 'Cleaning supplies', amt: 900, days: 22, paidBy: uid, fav: false, income: false },
    { cat: 'gifts', desc: "Birthday gift for Meera", amt: 1500, days: 25, paidBy: PEOPLE.rohan.uid, fav: false, income: false },
    { cat: 'misc', desc: 'Miscellaneous', amt: 300, days: 28, paidBy: uid, fav: false, income: false },
    { cat: 'groceries', desc: 'Monthly ration', amt: 5200, days: 32, paidBy: uid, fav: false, income: false },
    { cat: 'bills', desc: 'Internet Bill', amt: 1200, days: 35, paidBy: uid, fav: false, income: false },
    { cat: 'salary', desc: "Priya's Salary", amt: 85000, days: 3, paidBy: uid, fav: false, income: true },
    { cat: 'house_rent', desc: 'Rental income — 2nd flat', amt: 15000, days: 33, paidBy: uid, fav: false, income: true },
  ];
  const familyExpenseIds = [];
  for (const e of familyExpenses) {
    const ref = db.collection('expenses').doc();
    const createdAtIso = isoDaysAgo(e.days);
    const doc = {
      groupId: familyGroupId, amount: e.amt, description: e.desc, category: e.cat,
      date: dateStrDaysAgo(e.days), paidBy: e.paidBy, paymentMethod: e.income ? 'bank' : (e.days % 2 === 0 ? 'upi' : 'card'),
      addedBy: uid, type: e.income ? 'income' : 'expense', createdAt: createdAtIso,
      favoritedBy: e.fav ? [uid] : [],
    };
    if (!e.income) {
      doc.splitInfo = {
        splitType: 'equally',
        splits: familyMembers.map((m) => ({ userId: m.uid, amount: e.amt / familyMembers.length })),
      };
    }
    await set(ref, doc);
    familyExpenseIds.push({ id: ref.id, income: e.income, createdAt: createdAtIso });
  }

  // Category budget split — current month (in progress) + last month (fully closed, for
  // budget_met scoring below).
  const thisMonthKey = monthKeyMonthsAgo(0);
  const lastMonthKey = monthKeyMonthsAgo(1);
  const categoryAllocations = {
    housing: 30, groceries: 15, bills: 10, travel: 8, health: 8, education: 10, ent: 5, shopping: 5, household: 5, finance: 4,
  };
  await set(db.collection('groupBudgets').doc(`${familyGroupId}_${thisMonthKey}`), {
    groupId: familyGroupId, month: thisMonthKey, amount: 85000, createdAt: isoDaysAgo(3), setBy: uid, categoryAllocations,
  });
  await set(db.collection('groupBudgets').doc(`${familyGroupId}_${lastMonthKey}`), {
    groupId: familyGroupId, month: lastMonthKey, amount: 60000, createdAt: isoDaysAgo(33), setBy: uid, categoryAllocations,
  });

  // Recurring bill.
  await set(db.collection('recurringExpenses').doc(), {
    userId: uid, groupId: familyGroupId, category: 'housing', amount: 25000, active: true, type: 'expense',
    createdAt: isoDaysAgo(90), frequency: 'monthly', nextRunDate: dateStrDaysAgo(-27), // ~27 days from now
  });

  // Feed activity + a couple of comments.
  await set(db.collection('activities').doc(), {
    groupId: familyGroupId, userId: uid, userName: DEMO_NAME, userPhoto: demoPhoto, type: 'create_group',
    description: `${DEMO_NAME} created the group "The Sharma-Verma Family"`,
    data: { name: 'The Sharma-Verma Family', currency: 'INR', icon: '👨‍👩‍👧‍👦' }, createdAt: isoDaysAgo(120),
  });
  await set(db.collection('activities').doc(), {
    groupId: familyGroupId, userId: uid, userName: DEMO_NAME, userPhoto: demoPhoto, type: 'add_expense',
    description: `${DEMO_NAME} added an expense: September Rent`,
    data: { amount: 25000, description: 'September Rent', groupName: 'The Sharma-Verma Family', currencySymbol: '₹', currencyCode: 'INR' },
    createdAt: isoDaysAgo(3),
  });
  await set(db.collection('groups').doc(familyGroupId).collection('comments').doc(), {
    userId: PEOPLE.rohan.uid, text: "Don't forget to add the water bill too!", createdAt: isoDaysAgo(4),
  });
  await set(db.collection('groups').doc(familyGroupId).collection('comments').doc(), {
    userId: uid, text: 'On it — adding it tonight.', createdAt: isoDaysAgo(4),
  });

  // ==================================================================================
  // 4. TRIP GROUP (event) — a smaller, settlement-worthy group
  // ==================================================================================
  const tripGroupId = newId('groups');
  await set(db.collection('groups').doc(tripGroupId), {
    name: 'Goa Trip 2026', description: 'Beach getaway with Rohan & Karan', currency: 'INR',
    icon: '🏖️', photoURL: '', splitEnabled: true, incomeEnabled: false, groupType: 'event',
    createdBy: uid, createdAt: isoDaysAgo(18), totalSpending: 0, totalIncome: 0, memberCount: 3,
    coverImage: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&q=80&w=1000',
  });
  const tripMembers = [
    { uid, role: 'owner', name: DEMO_NAME, photo: demoPhoto },
    { uid: PEOPLE.rohan.uid, role: 'member', name: PEOPLE.rohan.name, photo: PEOPLE.rohan.photo },
    { uid: PEOPLE.karan.uid, role: 'member', name: PEOPLE.karan.name, photo: PEOPLE.karan.photo },
  ];
  for (const m of tripMembers) {
    await set(db.collection('members').doc(`${m.uid}_${tripGroupId}`), {
      userId: m.uid, groupId: tripGroupId, role: m.role, canInvite: true,
      joinedAt: isoDaysAgo(18), displayName: m.name, photoURL: m.photo,
    });
  }
  const tripExpenses = [
    { cat: 'housing', desc: 'Taj Resort — 3 nights', amt: 18000, days: 17, paidBy: uid },
    { cat: 'travel', desc: 'Flight tickets', amt: 22000, days: 16, paidBy: uid },
    { cat: 'food', desc: 'Beach shack dinner', amt: 3200, days: 15, paidBy: PEOPLE.karan.uid },
    { cat: 'food', desc: 'Brunch', amt: 1800, days: 14, paidBy: PEOPLE.rohan.uid },
    { cat: 'ent', desc: 'Water sports', amt: 4500, days: 14, paidBy: uid },
    { cat: 'travel', desc: 'Cab rentals', amt: 2600, days: 13, paidBy: PEOPLE.karan.uid },
    { cat: 'shopping', desc: 'Souvenirs', amt: 1900, days: 12, paidBy: uid },
    { cat: 'misc', desc: 'Tips & misc', amt: 700, days: 12, paidBy: PEOPLE.rohan.uid },
  ];
  for (const e of tripExpenses) {
    await set(db.collection('expenses').doc(), {
      groupId: tripGroupId, amount: e.amt, description: e.desc, category: e.cat,
      date: dateStrDaysAgo(e.days), paidBy: e.paidBy, paymentMethod: 'card', addedBy: uid,
      type: 'expense', createdAt: isoDaysAgo(e.days), favoritedBy: [],
      splitInfo: { splitType: 'equally', splits: tripMembers.map((m) => ({ userId: m.uid, amount: e.amt / tripMembers.length })) },
    });
  }

  // ==================================================================================
  // 5. PERSONAL LOANS
  // ==================================================================================
  const karanContactRef = db.collection('loanContacts').doc();
  await set(karanContactRef, {
    ownerId: uid, name: 'Karan Mehta', balance: 10000, currency: 'INR', createdAt: isoDaysAgo(20),
    installmentPlan: { amount: 2500, frequency: 'monthly', status: 'active' },
  });
  await set(karanContactRef.collection('entries').doc(), {
    type: 'given', amount: 15000, addedBy: uid, createdAt: isoDaysAgo(20), note: 'For his car repair',
  });
  await set(karanContactRef.collection('entries').doc(), {
    type: 'repayment_by_them', amount: 5000, addedBy: uid, createdAt: isoDaysAgo(5),
  });

  const amitContactRef = db.collection('loanContacts').doc();
  await set(amitContactRef, {
    ownerId: uid, name: 'Amit Singh', balance: -5000, currency: 'INR', createdAt: isoDaysAgo(25),
  });
  await set(amitContactRef.collection('entries').doc(), {
    type: 'taken', amount: 8000, addedBy: uid, createdAt: isoDaysAgo(25), note: 'Emergency cash',
  });
  await set(amitContactRef.collection('entries').doc(), {
    type: 'repayment_by_me', amount: 3000, addedBy: uid, createdAt: isoDaysAgo(8),
  });

  // ==================================================================================
  // 6. GOALS + FINANCIAL ACCOUNTS (accounts-only funding, reserve-on-target-met demoed live)
  // ==================================================================================
  const hdfcId = newId('financialAccounts');
  const zerodhaId = newId('financialAccounts');
  const sbiMfId = newId('financialAccounts');
  const carFundId = newId('financialAccounts');

  const emergencyGoalId = newId('goals');
  const europeGoalId = newId('goals');
  const carGoalId = newId('goals');
  const cashHoldingId = `cashHolding_${uid}`;

  // -- Goals --
  const nowIso = new Date().toISOString();
  await set(db.collection('goals').doc(emergencyGoalId), {
    userId: uid, name: 'Emergency Fund', targetAmountMinor: encAmount('goal', emergencyGoalId, toMinor(300000)),
    currentAmountMinor: encAmount('goal', emergencyGoalId, 0),
    accountAllocatedMinor: encAmount('goal', emergencyGoalId, toMinor(100000)),
    status: 'active', currency: 'INR', groupId: null, friendUids: [],
    createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(60), updatedAt: isoDaysAgo(1),
    targetDate: dateStrDaysAgo(-300), notes: 'Six months of household expenses.', icon: '🚨', imageUrl: null, completedAt: null,
  });
  await set(db.collection('goals').doc(europeGoalId), {
    userId: uid, name: 'Europe Trip 2027', targetAmountMinor: encAmount('goal', europeGoalId, toMinor(400000)),
    currentAmountMinor: encAmount('goal', europeGoalId, 0),
    accountAllocatedMinor: encAmount('goal', europeGoalId, toMinor(108000)),
    status: 'active', currency: 'INR', groupId: null, friendUids: [],
    createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(50), updatedAt: isoDaysAgo(1),
    targetDate: dateStrDaysAgo(-480), notes: 'Two weeks, four countries.', icon: '✈️', imageUrl: null, completedAt: null,
  });
  await set(db.collection('goals').doc(carGoalId), {
    userId: uid, name: 'New Car', targetAmountMinor: encAmount('goal', carGoalId, toMinor(80000)),
    currentAmountMinor: encAmount('goal', carGoalId, 0),
    accountAllocatedMinor: encAmount('goal', carGoalId, toMinor(80000)), // clamped to target — reserve-on-target-met
    status: 'completed', currency: 'INR', groupId: null, friendUids: [],
    createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(70), updatedAt: isoDaysAgo(1),
    targetDate: null, notes: 'Down payment for the new hatchback.', icon: '🚗', imageUrl: null, completedAt: isoDaysAgo(1),
  });
  await set(db.collection('goals').doc(cashHoldingId), {
    userId: uid, name: 'Cash Savings', targetAmountMinor: encAmount('goal', cashHoldingId, 0),
    currentAmountMinor: encAmount('goal', cashHoldingId, toMinor(45000)),
    accountAllocatedMinor: encAmount('goal', cashHoldingId, 0),
    status: 'active', currency: 'INR', groupId: null, friendUids: [], isCashHolding: true,
    createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(65), updatedAt: isoDaysAgo(5),
    targetDate: null, notes: null, icon: '🏦', imageUrl: null, completedAt: null,
  });

  // Goal ledgers — matches exactly what applyAccountChange() would have written.
  await set(db.collection('goals').doc(emergencyGoalId).collection('ledger').doc(), {
    type: 'account_alloc', amountMinor: encAmount('goal', emergencyGoalId, toMinor(100000)), monthKey: null,
    note: 'HDFC Savings — 40% allocated', createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(60),
  });
  await set(db.collection('goals').doc(europeGoalId).collection('ledger').doc(), {
    type: 'account_alloc', amountMinor: encAmount('goal', europeGoalId, toMinor(108000)), monthKey: null,
    note: 'Zerodha Broker — 60% allocated', createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(50),
  });
  await set(db.collection('goals').doc(carGoalId).collection('ledger').doc(), {
    type: 'account_alloc', amountMinor: encAmount('goal', carGoalId, toMinor(80000)), monthKey: null,
    note: 'New Car Fund — reserved, goal met', createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(1),
  });

  // Cash Savings: two closed months (userGoalMonths) totalling its 45,000 balance.
  const cashMonths = [
    { monthsAgo: 2, amount: 20000 },
    { monthsAgo: 1, amount: 25000 },
  ];
  for (const cm of cashMonths) {
    const mk = monthKeyMonthsAgo(cm.monthsAgo);
    const closedAt = isoDaysAgo(cm.monthsAgo * 30 - 3);
    await set(db.collection('userGoalMonths').doc(`${uid}_${mk}`), {
      userId: uid, monthKey: mk, closedAt, closedBy: uid,
      netSavingsMinor: encAmount('user', uid, toMinor(cm.amount)),
      allocations: { [cashHoldingId]: encAmount('goal', cashHoldingId, toMinor(cm.amount)) },
      unallocatedMinor: encAmount('user', uid, 0),
    });
    await set(db.collection('goals').doc(cashHoldingId).collection('ledger').doc(), {
      type: 'auto', amountMinor: encAmount('goal', cashHoldingId, toMinor(cm.amount)), monthKey: mk,
      note: null, createdBy: uid, createdByName: DEMO_NAME, createdAt: closedAt,
    });
  }

  // -- Financial Accounts --
  await set(db.collection('financialAccounts').doc(hdfcId), {
    userId: uid, name: 'HDFC Savings', type: 'bank', currency: 'INR',
    currentBalanceMinor: encAmount('account', hdfcId, toMinor(250000)), archived: false,
    createdAt: isoDaysAgo(60), updatedAt: isoDaysAgo(1), purpose: 'expense',
    interestRatePct: 3.5, compoundFrequency: 'yearly', balanceAsOf: dateStrDaysAgo(0),
    accountNumber: encText('account', hdfcId, 'XXXXXXXX4821'),
    nominees: [{ name: 'Rohan Verma', pct: 100 }],
    goalAllocations: [{ goalId: emergencyGoalId, goalName: 'Emergency Fund', pct: 40 }],
    allocatedGoalIds: [emergencyGoalId],
  });
  await set(db.collection('financialAccounts').doc(zerodhaId), {
    userId: uid, name: 'Zerodha Broker', type: 'broker', currency: 'INR',
    currentBalanceMinor: encAmount('account', zerodhaId, toMinor(180000)), archived: false,
    createdAt: isoDaysAgo(50), updatedAt: isoDaysAgo(1), purpose: 'investment',
    interestRatePct: null, compoundFrequency: null, balanceAsOf: dateStrDaysAgo(0),
    accountNumber: null, nominees: [],
    goalAllocations: [{ goalId: europeGoalId, goalName: 'Europe Trip 2027', pct: 60 }],
    allocatedGoalIds: [europeGoalId],
  });
  await set(db.collection('financialAccounts').doc(sbiMfId), {
    userId: uid, name: 'SBI Mutual Fund SIP', type: 'mutual_fund', currency: 'INR',
    currentBalanceMinor: encAmount('account', sbiMfId, toMinor(95000)), archived: false,
    createdAt: isoDaysAgo(45), updatedAt: isoDaysAgo(2), purpose: 'investment',
    interestRatePct: null, compoundFrequency: null, balanceAsOf: dateStrDaysAgo(0),
    accountNumber: null, nominees: [],
    contributionAmountMinor: encAmount('account', sbiMfId, toMinor(10000)),
    contributionFrequency: 'monthly', contributionNextDate: dateStrDaysAgo(-8),
    goalAllocations: [], allocatedGoalIds: [],
  });
  await set(db.collection('financialAccounts').doc(carFundId), {
    userId: uid, name: 'New Car Fund', type: 'bank', currency: 'INR',
    currentBalanceMinor: encAmount('account', carFundId, toMinor(85000)), archived: false,
    createdAt: isoDaysAgo(70), updatedAt: isoDaysAgo(1), purpose: 'expense',
    interestRatePct: 3, compoundFrequency: 'yearly', balanceAsOf: dateStrDaysAgo(0),
    accountNumber: null, nominees: [],
    goalAllocations: [{ goalId: carGoalId, goalName: 'New Car', pct: 94, reservedAmountMinor: toMinor(80000) }],
    allocatedGoalIds: [carGoalId],
  });

  // Account logs — one "Account added" entry each, allocationChanges under the 'account' scope
  // (matches applyAccountChange()'s own encryption choice for that array).
  const accountLogs = [
    { id: hdfcId, name: 'HDFC Savings', balance: 250000, goalId: emergencyGoalId, goalName: 'Emergency Fund', pct: 40, amt: 100000, days: 60 },
    { id: zerodhaId, name: 'Zerodha Broker', balance: 180000, goalId: europeGoalId, goalName: 'Europe Trip 2027', pct: 60, amt: 108000, days: 50 },
    { id: carFundId, name: 'New Car Fund', balance: 85000, goalId: carGoalId, goalName: 'New Car', pct: 94, amt: 80000, days: 70 },
  ];
  for (const l of accountLogs) {
    await set(db.collection('financialAccounts').doc(l.id).collection('log').doc(), {
      balanceBeforeMinor: encAmount('account', l.id, 0),
      balanceAfterMinor: encAmount('account', l.id, toMinor(l.balance)),
      allocationChanges: [{
        goalId: l.goalId, goalName: l.goalName, beforePct: 0, afterPct: l.pct,
        beforeAmountMinor: encAmount('account', l.id, 0),
        afterAmountMinor: encAmount('account', l.id, toMinor(l.amt)),
      }],
      note: 'Account added', images: [], createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(l.days),
    });
  }
  await set(db.collection('financialAccounts').doc(sbiMfId).collection('log').doc(), {
    balanceBeforeMinor: encAmount('account', sbiMfId, 0),
    balanceAfterMinor: encAmount('account', sbiMfId, toMinor(95000)),
    allocationChanges: [], note: 'Account added', images: [], createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(45),
  });

  // Self-check: prove one round trip actually decrypts back to what we intended, so a subtle
  // format mismatch fails loudly here instead of silently shipping broken ciphertext.
  const roundTrip = decAmount('account', hdfcId, encAmount('account', hdfcId, toMinor(250000)));
  if (roundTrip !== toMinor(250000)) throw new Error(`Encryption round-trip check failed: got ${roundTrip}`);
  console.log('Encryption round-trip check passed.');

  // ==================================================================================
  // 7. HEALTH — Blood Pressure, Glucose, Medicines, Illness grouping
  // ==================================================================================
  for (let i = 0; i < 10; i++) {
    const days = 2 + i * 3;
    await set(db.collection('bloodPressureLogs').doc(), {
      userId: uid, loggedBy: uid, systolic: 112 + (i % 5) * 4, diastolic: 74 + (i % 4) * 3,
      pulse: 68 + (i % 6) * 2, loggedAt: isoDaysAgo(days), createdAt: isoDaysAgo(days), notes: null,
      groupId: null, sharedFriendUids: [],
    });
  }
  const meals = ['breakfast', 'lunch', 'dinner'];
  for (let i = 0; i < 10; i++) {
    const days = 1 + i * 3;
    await set(db.collection('glucoseLogs').doc(), {
      userId: uid, loggedBy: uid, mealType: meals[i % 3], timing: i % 2 === 0 ? 'before' : 'after',
      value: 95 + (i % 7) * 8, loggedAt: isoDaysAgo(days), createdAt: isoDaysAgo(days),
      postMealHours: i % 2 === 0 ? null : 2, notes: null, groupId: null, sharedFriendUids: [],
    });
  }

  const fluIncidentId = newId('medicalIncidents');
  await set(db.collection('medicalIncidents').doc(fluIncidentId), {
    userId: uid, loggedBy: uid, name: 'Seasonal Flu', createdAt: isoDaysAgo(7),
    description: 'Fever and cold, treated with a short antibiotic course.', endDate: dateStrDaysAgo(1),
  });

  const metforminId = newId('medicines');
  const metforminTimes = [
    { id: rid(), label: 'Morning', time: '08:00', foodTiming: 'after' },
    { id: rid(), label: 'Night', time: '20:00', foodTiming: 'after' },
  ];
  await set(db.collection('medicines').doc(metforminId), {
    userId: uid, loggedBy: uid, groupId: null, sharedFriendUids: [], name: 'Metformin', dosage: '500mg',
    incidentId: null, times: metforminTimes, weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: null,
    startDate: dateStrDaysAgo(90), durationMode: 'ongoing', endDate: null, dayCount: null,
    remindersEnabled: true, notes: 'For blood sugar management.', active: true, createdAt: isoDaysAgo(90),
  });

  const amoxicillinId = newId('medicines');
  const amoxTimes = [{ id: rid(), label: 'Morning', time: '09:00', foodTiming: 'before' }];
  await set(db.collection('medicines').doc(amoxicillinId), {
    userId: uid, loggedBy: uid, groupId: null, sharedFriendUids: [], name: 'Amoxicillin', dosage: '250mg',
    incidentId: fluIncidentId, times: amoxTimes, weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: null,
    startDate: dateStrDaysAgo(6), durationMode: 'dayCount', endDate: null, dayCount: 7,
    remindersEnabled: true, notes: null, active: true, createdAt: isoDaysAgo(6),
  });

  // Dose logs — Metformin, last 5 days x 2 doses/day (mostly taken, one skipped).
  for (let d = 0; d < 5; d++) {
    for (let t = 0; t < metforminTimes.length; t++) {
      const dateStr = dateStrDaysAgo(d);
      const skipped = d === 2 && t === 1;
      const logId = `${uid}_${metforminId}_${metforminTimes[t].id}_${dateStr}`;
      await set(db.collection('medicineLogs').doc(logId), {
        userId: uid, loggedBy: uid, medicineId: metforminId, medicineName: 'Metformin',
        doseTimeId: metforminTimes[t].id, doseLabel: metforminTimes[t].label, scheduledTime: metforminTimes[t].time,
        status: skipped ? 'skipped' : 'taken', dateStr, loggedAt: isoDaysAgo(d), createdAt: isoDaysAgo(d),
        groupId: null, sharedFriendUids: [], notes: null,
      });
    }
  }
  // Amoxicillin — every day since its start.
  for (let d = 0; d <= 6; d++) {
    const dateStr = dateStrDaysAgo(d);
    const logId = `${uid}_${amoxicillinId}_${amoxTimes[0].id}_${dateStr}`;
    await set(db.collection('medicineLogs').doc(logId), {
      userId: uid, loggedBy: uid, medicineId: amoxicillinId, medicineName: 'Amoxicillin',
      doseTimeId: amoxTimes[0].id, doseLabel: amoxTimes[0].label, scheduledTime: amoxTimes[0].time,
      status: 'taken', dateStr, loggedAt: isoDaysAgo(d), createdAt: isoDaysAgo(d),
      groupId: null, sharedFriendUids: [], notes: null,
    });
  }

  // ==================================================================================
  // 8. SHARED REMINDERS
  // ==================================================================================
  const billReminderId = newId('sharedReminders');
  await set(db.collection('sharedReminders').doc(billReminderId), {
    title: 'Pay Electricity Bill', createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(20),
    startDate: dateStrDaysAgo(20), time: '09:00', cadence: 'monthly', weekdays: [], requireAck: true,
    active: true, groupId: familyGroupId, friendUids: [], notes: 'Due on the 5th every month.', completionMode: 'all',
  });
  await set(db.collection('sharedReminders').doc(billReminderId).collection('acknowledgments').doc(), {
    uid, occurrenceDate: dateStrDaysAgo(0), acknowledgedAt: isoDaysAgo(0),
  });
  await set(db.collection('sharedReminders').doc(billReminderId).collection('responses').doc(uid), {
    uid, status: 'accepted', respondedAt: isoDaysAgo(20),
  });

  const movieReminderId = newId('sharedReminders');
  await set(db.collection('sharedReminders').doc(movieReminderId), {
    title: 'Family Movie Night', createdBy: uid, createdByName: DEMO_NAME, createdAt: isoDaysAgo(1),
    startDate: dateStrDaysAgo(-2), time: '19:30', cadence: 'once', weekdays: [], requireAck: false,
    active: true, groupId: familyGroupId, friendUids: [], notes: null, completionMode: 'any',
  });

  // ==================================================================================
  // 9. SHOPPING LIST
  // ==================================================================================
  const shoppingListId = newId('shoppingLists');
  await set(db.collection('shoppingLists').doc(shoppingListId), {
    userId: uid, title: 'Weekly Groceries', createdAt: isoDaysAgo(1), groupId: familyGroupId, scheduledAt: null,
  });
  const shoppingItems = [
    { text: 'Milk', status: 'bought' }, { text: 'Eggs', status: 'bought' },
    { text: 'Bread', status: 'pending' }, { text: 'Vegetables', status: 'pending' },
    { text: 'Rice (5kg)', status: 'unavailable' }, { text: 'Chicken', status: 'pending' },
  ];
  for (const item of shoppingItems) {
    await set(db.collection('shoppingLists').doc(shoppingListId).collection('items').doc(), {
      text: item.text, addedBy: uid, createdAt: isoDaysAgo(1), status: item.status, notes: null,
    });
  }

  // ==================================================================================
  // 10. TO-DOS / HABITS
  // ==================================================================================
  const insuranceTodoId = newId('todos');
  await set(db.collection('todos').doc(insuranceTodoId), {
    userId: uid, text: 'Renew car insurance', done: true, createdAt: isoDaysAgo(10),
    groupId: null, reminderAt: null, dueDate: dateStrDaysAgo(1), status: 'done', notes: null,
    recurring: false, completedAt: isoDaysAgo(2),
  });
  const waterHabitId = newId('todos');
  await set(db.collection('todos').doc(waterHabitId), {
    userId: uid, text: 'Drink 8 glasses of water', done: false, createdAt: isoDaysAgo(15),
    groupId: null, reminderAt: null, dueDate: null, status: 'pending', notes: null,
    recurring: true, recurringActive: true, frequency: 'daily', nextRunDate: dateStrDaysAgo(-1),
    history: { [dateStrDaysAgo(1)]: true, [dateStrDaysAgo(2)]: true, [dateStrDaysAgo(3)]: true, [dateStrDaysAgo(4)]: false },
  });
  await set(db.collection('todos').doc(), {
    userId: uid, text: 'Book dentist appointment', done: false, createdAt: isoDaysAgo(2),
    groupId: null, reminderAt: null, dueDate: dateStrDaysAgo(-5), status: 'pending', notes: null, recurring: false,
  });

  // ==================================================================================
  // 11. FRIEND + DM CHAT (Karan Mehta)
  // ==================================================================================
  const friendshipId = uid < PEOPLE.karan.uid ? `${uid}_${PEOPLE.karan.uid}` : `${PEOPLE.karan.uid}_${uid}`;
  await set(db.collection('friendships').doc(friendshipId), {
    participants: [uid, PEOPLE.karan.uid].sort(), status: 'accepted',
    requestedBy: PEOPLE.karan.uid, requestedAt: isoDaysAgo(30), respondedAt: isoDaysAgo(29),
  });
  const dmChatId = uid < PEOPLE.karan.uid ? `${uid}_${PEOPLE.karan.uid}` : `${PEOPLE.karan.uid}_${uid}`;
  await set(db.collection('directChats').doc(dmChatId), {
    participants: [uid, PEOPLE.karan.uid], lastMessageAt: isoDaysAgo(12),
    lastMessageText: 'Sounds good, see you at the airport!', lastMessageBy: PEOPLE.karan.uid,
    unreadFor: { [uid]: 0, [PEOPLE.karan.uid]: 0 },
  });
  const dmMessages = [
    { from: PEOPLE.karan.uid, name: PEOPLE.karan.name, text: 'Hey! Booked the resort for Goa 🏖️', days: 17 },
    { from: uid, name: DEMO_NAME, text: 'Awesome, sending you my flight details.', days: 17 },
    { from: PEOPLE.karan.uid, name: PEOPLE.karan.name, text: 'Sounds good, see you at the airport!', days: 12 },
  ];
  for (const m of dmMessages) {
    await set(db.collection('directChats').doc(dmChatId).collection('comments').doc(), {
      userId: m.from, displayName: m.name, text: m.text, createdAt: isoDaysAgo(m.days),
    });
  }

  // ==================================================================================
  // 12. GAME HISTORY (leaderboard/"recently played" only — no live boards, per plan)
  // ==================================================================================
  await set(db.collection('gameOutcomes').doc(), {
    gameType: 'rummy', status: 'finished', playerUids: [uid, PEOPLE.rohan.uid, PEOPLE.karan.uid],
    winnerUid: uid, finishedAt: isoDaysAgo(6),
    players: [
      { uid, displayName: DEMO_NAME, photoURL: demoPhoto },
      { uid: PEOPLE.rohan.uid, displayName: PEOPLE.rohan.name, photoURL: PEOPLE.rohan.photo },
      { uid: PEOPLE.karan.uid, displayName: PEOPLE.karan.name, photoURL: PEOPLE.karan.photo },
    ],
  });
  await set(db.collection('gameOutcomes').doc(), {
    gameType: 'sweep', status: 'finished', playerUids: [uid, PEOPLE.rohan.uid, PEOPLE.karan.uid, PEOPLE.amit.uid],
    winnerTeam: 0, finishedAt: isoDaysAgo(9),
    players: [
      { uid, displayName: DEMO_NAME, photoURL: demoPhoto, team: 0 },
      { uid: PEOPLE.rohan.uid, displayName: PEOPLE.rohan.name, photoURL: PEOPLE.rohan.photo, team: 0 },
      { uid: PEOPLE.karan.uid, displayName: PEOPLE.karan.name, photoURL: PEOPLE.karan.photo, team: 1 },
      { uid: PEOPLE.amit.uid, displayName: PEOPLE.amit.name, photoURL: PEOPLE.amit.photo, team: 1 },
    ],
  });

  // ==================================================================================
  // 13. GAMIFICATION — via the REAL /api/points/claim endpoint (re-verifies against the actual
  // docs just written above, exactly like the client would), so xp/level/badges/streaks are
  // computed by production business logic, never hand-faked.
  // ==================================================================================
  console.log('Signing in as demo account to claim points through the live backend...');
  const apiKey = (await import('../firebase-applet-config.json', { with: { type: 'json' } })).default.apiKey;
  const signInRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD, returnSecureToken: true }),
  });
  const signInJson = await signInRes.json();
  if (!signInJson.idToken) {
    console.warn('Could not sign in as demo account — skipping gamification (points/xp/badges). Reason:', signInJson.error?.message);
  } else {
    const idToken = signInJson.idToken;
    const BACKEND = 'https://familyledger-backend-192700919713.us-central1.run.app';
    const claim = async (body) => {
      try {
        const res = await fetch(`${BACKEND}/api/points/claim`, {
          method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) console.warn(`claim(${body.actionType}) -> ${res.status}:`, json.error);
      } catch (err) {
        console.warn(`claim(${body.actionType}) failed:`, err.message);
      }
    };
    // Expense-logged for every real expense we just wrote (family + trip groups).
    for (const e of familyExpenseIds) {
      if (!e.income) await claim({ actionType: 'expense_logged', expenseId: e.id });
    }
    await claim({ actionType: 'budget_set', budgetDocId: `${familyGroupId}_${thisMonthKey}` });
    await claim({ actionType: 'budget_met', groupId: familyGroupId, monthKey: lastMonthKey });
    await claim({ actionType: 'todo_completed', todoId: insuranceTodoId });
    await claim({ actionType: 'habit_occurrence', todoId: waterHabitId, dateStr: dateStrDaysAgo(1) });
    await claim({ actionType: 'habit_occurrence', todoId: waterHabitId, dateStr: dateStrDaysAgo(2) });
    await claim({ actionType: 'habit_occurrence', todoId: waterHabitId, dateStr: dateStrDaysAgo(3) });
    await claim({ actionType: 'feature_explorer', feature: 'personal_loans', sourceCollection: 'loanContacts', sourceDocId: karanContactRef.id });
    await claim({ actionType: 'feature_explorer', feature: 'goals', sourceCollection: 'goals', sourceDocId: emergencyGoalId });
    await claim({ actionType: 'feature_explorer', feature: 'shared_reminders', sourceCollection: 'sharedReminders', sourceDocId: billReminderId });
    console.log('Gamification claims sent.');
  }

  // ---------- Done ----------
  await markerRef.set({ seededAt: new Date().toISOString(), uid, writeCount });
  console.log(`\nDone. ${writeCount} documents written.`);
  console.log(`Demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`Family group: /groups/${familyGroupId}`);
  console.log(`Trip group:   /groups/${tripGroupId}`);
  console.log(`Goals:        /goals`);
  console.log(`Accounts:     /goals/accounts`);
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
