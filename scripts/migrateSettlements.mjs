// One-off migration: turns the old "settlement saved as an expense" records into real payments in the `settlements` collection.
//
// Run (dry run, changes nothing, prints what it would do):   node scripts/migrateSettlements.mjs
// Run for real:                                               node scripts/migrateSettlements.mjs --apply
//
// For every expense that is a settlement (flagged `isSettlement`, or described "Settlement" / "Settlement to <name>" with exactly one split to someone
// other than the payer): creates settlements/mig_<expenseId> (so re-running never duplicates), then deletes the expense and takes its amount back off
// the group's totalSpending. Anything that does not look like a clean one-to-one payment is listed and left alone.
// Uses the Admin SDK with Application Default Credentials (same setup as deploy_rules.py), so it bypasses firestore.rules.

import fs from 'node:fs';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: config.projectId });
const db = getFirestore(admin.app(), config.firestoreDatabaseId);

const looksLikeSettlement = (e) => e.isSettlement === true || /^settlement( to .*)?$/i.test(String(e.description || '').trim());

const snap = await db.collection('expenses').get();
const candidates = snap.docs.filter((d) => looksLikeSettlement(d.data()) && d.data().type !== 'income');
console.log(`${snap.size} expenses scanned, ${candidates.length} look like settlements.`);

const convert = [];
const skipped = [];
for (const d of candidates) {
  const e = d.data();
  const splits = e.splitInfo?.splits || [];
  const fromUid = e.paidBy;
  const toUid = e.settledWith || splits[0]?.userId;
  const amount = Number(splits[0]?.amount ?? e.amount);
  const multiPayer = Array.isArray(e.payers) && e.payers.length > 1;
  if (!fromUid || !toUid || fromUid === toUid || !(amount > 0) || splits.length !== 1 || multiPayer || (e.settledWith && splits[0]?.userId !== e.settledWith)) {
    skipped.push({ id: d.id, groupId: e.groupId, description: e.description, amount: e.amount, why: 'not a clean one-to-one payment' });
    continue;
  }
  convert.push({ d, e, fromUid, toUid, amount });
}

// names, for display only
const nameCache = new Map();
async function nameOf(groupId, uid) {
  const key = `${uid}_${groupId}`;
  if (nameCache.has(key)) return nameCache.get(key);
  const m = await db.collection('members').doc(key).get();
  let name = m.exists ? m.data().displayName : '';
  if (!name) {
    const g = await db.collection('groups').doc(groupId).get();
    name = g.exists ? g.data()?.participants?.[uid]?.name || '' : '';
  }
  nameCache.set(key, name || 'Someone');
  return nameCache.get(key);
}

for (const { d, e, fromUid, toUid, amount } of convert) {
  console.log(`  ${APPLY ? 'converting' : 'would convert'}: ${e.date} group ${e.groupId} ${fromUid} -> ${toUid} amount ${amount} (expense ${d.id}, "${e.description}", expense amount ${e.amount})`);
}
if (skipped.length) {
  console.log(`\n${skipped.length} left alone:`);
  skipped.forEach((s) => console.log(`  expense ${s.id} group ${s.groupId} "${s.description}" amount ${s.amount} - ${s.why}`));
}

if (!APPLY) {
  console.log('\nDry run only. Nothing was changed. Run with --apply to convert.');
  process.exit(0);
}

let done = 0;
for (const { d, e, fromUid, toUid, amount } of convert) {
  const settlementRef = db.collection('settlements').doc(`mig_${d.id}`);
  const groupRef = db.collection('groups').doc(e.groupId);
  const fromName = await nameOf(e.groupId, fromUid);
  const toName = await nameOf(e.groupId, toUid);
  const batch = db.batch();
  batch.set(settlementRef, {
    groupId: e.groupId,
    fromUid,
    toUid,
    fromName,
    toName,
    amount: Math.round(amount * 100) / 100,
    date: e.date || String(e.createdAt || '').slice(0, 10),
    addedBy: e.addedBy || fromUid,
    createdAt: e.createdAt || new Date().toISOString(),
    migratedFromExpense: d.id,
  });
  batch.delete(d.ref);
  const grp = await groupRef.get();
  if (grp.exists) batch.update(groupRef, { totalSpending: admin.firestore.FieldValue.increment(-(Number(e.amount) || 0)) });
  await batch.commit();
  done += 1;
}
console.log(`\nConverted ${done} settlements.`);
