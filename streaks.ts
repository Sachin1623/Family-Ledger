import type express from 'express';
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';

// Streak freeze rescue and friend streaks.
//
// A streak that misses a day is not lost at once: it sits FROZEN for up to 3 days (the streak count is kept). While it is frozen the person
// can unfreeze it with coins (15 per missed day) or, for their own streak, with a freeze they have earned. If a streak is broken by logging
// again without unfreezing, the old count is remembered for the same few days and can still be restored. After that it ends, and a new one
// can be started at any time.
//
// A friend streak is one shared streak between two people, started by invitation and accepted by the other person. It grows on a day when BOTH
// of them logged (an expense or "No spend today", in their own time zone). When a day is missed it freezes the same way, and either of them can
// pay to unfreeze it, up to 2 rescues per streak. A person can keep streaks going with several friends at once (up to 5), one per friend.

const FROZEN_MAX_MISSED = 3;
const COST_PER_MISSED_DAY = 15;
const MAX_RESCUES = 2;
const MAX_FRIEND_STREAKS = 5;

const daysBetween = (a: string, b: string): number => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface StreakDeps {
  getDb: () => Firestore | null;
  verifyAuth: (req: express.Request) => Promise<admin.auth.DecodedIdToken | null>;
  getUserTimezone: (db: Firestore, uid: string) => Promise<string | null>;
  dayInTimezone: (instant: Date | string | number, tz: string | null | undefined) => string;
  collectPushTokens: (db: Firestore, uids: string[], prefField: string) => Promise<string[]>;
  sendPush: (tokens: string[], title: string, body: string, data: Record<string, string>) => Promise<number>;
}

interface Pair {
  uids: string[];
  status: 'invited' | 'active' | 'ended' | 'declined';
  invitedBy: string;
  createdAt: string;
  startedAt?: string;
  startedDay?: string;
  endedAt?: string;
  current: number;
  longest: number;
  lastBothDay?: string | null;
  lastLogged: Record<string, string>;
  rescues: number;
  lost?: { value: number; missedDays: number; until: string } | null;
  lastNudge?: Record<string, string>;
}

type FieldValueDelete = ReturnType<typeof admin.firestore.FieldValue.delete>;

interface Links {
  active?: Record<string, string>; // pairId -> the friend's uid
  outgoing?: Record<string, string>; // invites I sent that are waiting: pairId -> their uid
  incoming?: Record<string, { from: string; name: string; at: string }>;
}

// Called right after a day was logged for `uid` (an expense or "No spend today"). Moves every friend streak this person is in. Best effort: a
// failure here never affects the logging itself.
export async function advanceFriendStreak(db: Firestore, uid: string, day: string): Promise<void> {
  const links = ((await db.collection('friendStreakLinks').doc(uid).get()).data() || {}) as Links;
  const pairIds = Object.keys(links.active || {});
  await Promise.all(pairIds.map((pairId) => advanceOne(db, uid, day, pairId)));
}

async function advanceOne(db: Firestore, uid: string, day: string, pairId: string): Promise<void> {
  const ref = db.collection('friendStreaks').doc(pairId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const p = snap.data() as Pair | undefined;
    if (!p || p.status !== 'active') return;
    const other = p.uids.find((u) => u !== uid);
    const lastLogged = { ...(p.lastLogged || {}) };
    if (!lastLogged[uid] || lastLogged[uid] < day) lastLogged[uid] = day;
    const update: Record<string, unknown> = { lastLogged };
    if (other && lastLogged[other] === day && p.lastBothDay !== day) {
      let current = p.current || 0;
      let lost: Pair['lost'] | FieldValueDelete | undefined;
      if (!p.lastBothDay) {
        current = 1;
      } else {
        const gap = daysBetween(p.lastBothDay, day);
        if (gap === 1) current += 1;
        else if (gap >= 2 && gap <= FROZEN_MAX_MISSED + 1 && current > 0) {
          // a day was missed and nobody unfroze it: start again, but remember the old count so it can still be restored
          lost = { value: current, missedDays: gap - 1, until: addDays(p.lastBothDay, FROZEN_MAX_MISSED + 1) };
          current = 1;
        } else current = 1;
      }
      update.current = current;
      update.longest = Math.max(p.longest || 0, current);
      update.lastBothDay = day;
      if (lost) update.lost = lost;
      else if (p.lost) update.lost = admin.firestore.FieldValue.delete();
    }
    tx.update(ref, update);
  });
}

export function registerStreakRoutes(app: express.Express, deps: StreakDeps): void {
  const { getDb, verifyAuth, getUserTimezone, dayInTimezone } = deps;
  const todayFor = async (db: Firestore, uid: string) => dayInTimezone(new Date(), await getUserTimezone(db, uid));

  // ---------------- your own streak: unfreeze / restore ----------------
  app.post('/api/streak/restore', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    const method = req.body?.method === 'freeze' ? 'freeze' : 'coins';
    try {
      const today = await todayFor(db, uid);
      const streakRef = db.collection('userPoints').doc(uid).collection('meta').doc('expenseStreak');
      const pointsRef = db.collection('userPoints').doc(uid);
      let result: { kind: string; cost: number; method: string; days: number } | { error: string } = { error: 'Nothing to unfreeze.' };
      await db.runTransaction(async (tx) => {
        const [sSnap, pSnap] = await Promise.all([tx.get(streakRef), tx.get(pointsRef)]);
        const s = sSnap.data() || {};
        const coins = Number(pSnap.data()?.coins) || 0;
        const freezes = Math.max(0, Number(s.freezes) || 0);
        const last: string | null = s.lastDateStr || null;
        let missed = 0;
        let kind: 'frozen' | 'lost' | null = null;
        if (last && (Number(s.current) || 0) > 0) {
          const gap = daysBetween(last, today);
          if (gap >= 2 && gap <= FROZEN_MAX_MISSED + 1) {
            kind = 'frozen';
            missed = gap - 1;
          }
        }
        if (!kind && s.lostStreak && today <= String(s.lostStreak.until)) {
          kind = 'lost';
          missed = Number(s.lostStreak.missedDays) || 1;
        }
        if (!kind) return;
        const cost = COST_PER_MISSED_DAY * missed;
        if (method === 'freeze') {
          if (freezes < missed) {
            result = { error: `You need ${missed} freeze${missed === 1 ? '' : 's'} for this. Pay with coins instead.` };
            return;
          }
        } else if (coins < cost) {
          result = { error: `You need ${cost} coins to unfreeze this. You have ${coins}.` };
          return;
        }
        const now = new Date().toISOString();
        const patch: Record<string, unknown> = { lastFreezeUsedOn: addDays(today, -1) };
        if (kind === 'frozen') {
          patch.lastDateStr = addDays(today, -1); // the missed days are covered, so logging today continues the streak
        } else {
          const lost = s.lostStreak;
          const merged = (Number(lost.value) || 0) + (Number(s.current) || 0);
          patch.current = merged;
          patch.longest = Math.max(Number(s.longest) || 0, merged);
          patch.lostStreak = admin.firestore.FieldValue.delete();
        }
        if (method === 'freeze') patch.freezes = freezes - missed;
        tx.set(streakRef, patch, { merge: true });
        tx.set(db.collection('streakWatch').doc(uid), { ...(patch.lastDateStr ? { lastDateStr: patch.lastDateStr } : {}), ...(patch.current ? { current: patch.current } : {}), ...(method === 'freeze' ? { freezes: freezes - missed } : {}) }, { merge: true });
        if (method === 'coins') {
          tx.set(pointsRef, { coins: admin.firestore.FieldValue.increment(-cost), updatedAt: now }, { merge: true });
          tx.set(db.collection('coinSpends').doc(), { uid, coins: cost, reason: kind === 'frozen' ? 'unfreeze_streak' : 'restore_streak', days: missed, at: now });
        }
        result = { kind, cost: method === 'coins' ? cost : 0, method, days: missed };
      });
      const done = result as any;
      if (done.error) return res.status(400).json(done);
      return res.json({ ok: true, ...done });
    } catch (err) {
      console.error('streak restore error:', err);
      return res.status(500).json({ error: 'Could not unfreeze right now. Please try again.' });
    }
  });

  // ---------------- friend streaks ----------------
  const linksRef = (db: Firestore, uid: string) => db.collection('friendStreakLinks').doc(uid);
  const del = () => admin.firestore.FieldValue.delete();

  async function personCard(db: Firestore, uid: string): Promise<{ uid: string; name: string; photoURL: string | null }> {
    const snap = await db.collection('users').doc(uid).get();
    const d = snap.data() || {};
    return { uid, name: d.displayName || 'Someone', photoURL: d.photoURL || null };
  }

  // Takes a finished streak out of both people's lists.
  function unlinkBoth(batch: FirebaseFirestore.WriteBatch, db: Firestore, pairId: string, uids: string[]) {
    uids.forEach((u) => batch.set(linksRef(db, u), { active: { [pairId]: del() }, outgoing: { [pairId]: del() }, incoming: { [pairId]: del() } }, { merge: true }));
  }

  // Ends a streak that has been frozen too long (looked at whenever someone opens it).
  async function endIfExpired(db: Firestore, pairId: string, p: Pair, today: string): Promise<boolean> {
    const base = p.lastBothDay || p.startedDay;
    if (!base || daysBetween(base, today) < FROZEN_MAX_MISSED + 2) return false;
    const batch = db.batch();
    batch.update(db.collection('friendStreaks').doc(pairId), { status: 'ended', endedAt: new Date().toISOString(), endReason: 'expired' });
    unlinkBoth(batch, db, pairId, p.uids);
    await batch.commit();
    return true;
  }

  app.get('/api/friend-streak', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    try {
      const today = await todayFor(db, uid);
      const links = ((await linksRef(db, uid).get()).data() || {}) as Links;
      const incoming = Object.entries(links.incoming || {}).map(([pairId, v]) => ({ pairId, ...v }));

      const streaks = (
        await Promise.all(
          Object.keys(links.active || {}).map(async (pairId) => {
            const p = (await db.collection('friendStreaks').doc(pairId).get()).data() as Pair | undefined;
            if (!p || p.status !== 'active') return null;
            if (await endIfExpired(db, pairId, p, today)) return null;
            const otherUid = p.uids.find((u) => u !== uid)!;
            const [partner, partnerToday] = await Promise.all([personCard(db, otherUid), todayFor(db, otherUid)]);
            const base = p.lastBothDay || p.startedDay || today;
            const gap = daysBetween(base, today);
            const lit = p.lastBothDay === today;
            const frozen = !lit && (p.current || 0) > 0 && gap >= 2 && gap <= FROZEN_MAX_MISSED + 1;
            const lostOk = !!p.lost && today <= p.lost.until;
            const missed = frozen ? gap - 1 : lostOk ? p.lost!.missedDays : 0;
            return {
              pairId,
              partner,
              current: p.current || 0,
              longest: p.longest || 0,
              state: lit ? 'lit' : frozen ? 'frozen' : 'waiting',
              myDone: p.lastLogged?.[uid] === today,
              partnerDone: p.lastLogged?.[otherUid] === partnerToday,
              frozenDaysLeft: frozen ? FROZEN_MAX_MISSED + 2 - gap : 0,
              canRescue: (frozen || lostOk) && (p.rescues || 0) < MAX_RESCUES,
              rescueKind: frozen ? 'frozen' : lostOk ? 'lost' : null,
              lostValue: lostOk ? p.lost!.value : 0,
              rescueCost: COST_PER_MISSED_DAY * missed,
              rescuesLeft: Math.max(0, MAX_RESCUES - (p.rescues || 0)),
            };
          }),
        )
      ).filter(Boolean);
      streaks.sort((a: any, b: any) => b.current - a.current);

      const outgoing = await Promise.all(
        Object.entries(links.outgoing || {}).map(async ([pairId, toUid]) => ({ pairId, partner: await personCard(db, toUid) })),
      );
      return res.json({ streaks, outgoing, incoming, max: MAX_FRIEND_STREAKS });
    } catch (err) {
      console.error('friend streak state error:', err);
      return res.status(500).json({ error: 'Could not load the friend streaks.' });
    }
  });

  // Friends and group members the person can invite (people already in a streak with them, or invited, are marked).
  app.get('/api/friend-streak/candidates', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    try {
      const links = ((await linksRef(db, uid).get()).data() || {}) as Links;
      const taken = new Set<string>([...Object.values(links.active || {}), ...Object.values(links.outgoing || {}), ...Object.values(links.incoming || {}).map((v) => v.from)]);
      const ids = new Set<string>();
      const fs = await db.collection('friendships').where('participants', 'array-contains', uid).get();
      fs.docs.forEach((d) => {
        const data = d.data();
        if (data.status === 'accepted') (data.participants as string[]).forEach((u) => u !== uid && ids.add(u));
      });
      const mine = await db.collection('members').where('userId', '==', uid).get();
      const groupIds = Array.from(new Set(mine.docs.map((d) => d.data().groupId as string))).slice(0, 10);
      if (groupIds.length) {
        const others = await db.collection('members').where('groupId', 'in', groupIds).limit(80).get();
        others.docs.forEach((d) => d.data().userId !== uid && ids.add(d.data().userId));
      }
      const list = Array.from(ids).slice(0, 60);
      const cards = await Promise.all(list.map((u) => personCard(db, u)));
      return res.json({ people: cards.map((c) => ({ ...c, taken: taken.has(c.uid) })).sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (err) {
      console.error('friend streak candidates error:', err);
      return res.status(500).json({ error: 'Could not load people.' });
    }
  });

  app.post('/api/friend-streak/invite', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    const toUid = String(req.body?.toUid || '');
    if (!toUid || toUid === uid) return res.status(400).json({ error: 'Choose a friend to invite.' });
    try {
      // must be an accepted friend or share a group
      const friendshipId = uid < toUid ? `${uid}_${toUid}` : `${toUid}_${uid}`;
      let allowed = (await db.collection('friendships').doc(friendshipId).get()).data()?.status === 'accepted';
      if (!allowed) {
        const mine = await db.collection('members').where('userId', '==', uid).get();
        const groupIds = Array.from(new Set(mine.docs.map((d) => d.data().groupId as string))).slice(0, 10);
        if (groupIds.length) allowed = !(await db.collection('members').where('groupId', 'in', groupIds).where('userId', '==', toUid).limit(1).get()).empty;
      }
      if (!allowed) return res.status(403).json({ error: 'You can invite friends and people in your groups.' });

      const me = await personCard(db, uid);
      const pairRef = db.collection('friendStreaks').doc();
      let failure: string | null = null;
      await db.runTransaction(async (tx) => {
        const [mineSnap, theirsSnap] = await Promise.all([tx.get(linksRef(db, uid)), tx.get(linksRef(db, toUid))]);
        const mine = (mineSnap.data() || {}) as Links;
        const theirs = (theirsSnap.data() || {}) as Links;
        const count = (l: Links) => Object.keys(l.active || {}).length + Object.keys(l.outgoing || {}).length;
        if (count(mine) >= MAX_FRIEND_STREAKS) { failure = `You can have up to ${MAX_FRIEND_STREAKS} friend streaks at a time. End one to start another.`; return; }
        if (Object.values(mine.active || {}).includes(toUid) || Object.values(mine.outgoing || {}).includes(toUid) || Object.values(mine.incoming || {}).some((v) => v.from === toUid)) {
          failure = 'You already have a streak or an invite with this friend.';
          return;
        }
        if (Object.keys(theirs.active || {}).length >= MAX_FRIEND_STREAKS) { failure = 'They already have as many friend streaks as they can keep.'; return; }
        const pair: Pair = { uids: [uid, toUid], status: 'invited', invitedBy: uid, createdAt: new Date().toISOString(), current: 0, longest: 0, lastLogged: {}, rescues: 0 };
        tx.set(pairRef, pair);
        tx.set(linksRef(db, uid), { outgoing: { [pairRef.id]: toUid } }, { merge: true });
        tx.set(linksRef(db, toUid), { incoming: { [pairRef.id]: { from: uid, name: me.name, at: pair.createdAt } } }, { merge: true });
      });
      if (failure) return res.status(409).json({ error: failure });
      const tokens = await deps.collectPushTokens(db, [toUid], 'notificationsEnabled');
      await deps.sendPush(tokens, `${me.name} wants a streak with you 🔥`, 'Log something every day together. Tap to accept.', { type: 'friend_streak_invite' });
      return res.json({ ok: true, pairId: pairRef.id });
    } catch (err) {
      console.error('friend streak invite error:', err);
      return res.status(500).json({ error: 'Could not send the invite.' });
    }
  });

  app.post('/api/friend-streak/respond', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    const pairId = String(req.body?.pairId || '');
    const accept = req.body?.accept === true;
    try {
      const today = await todayFor(db, uid);
      let failure: string | null = null;
      let inviter = '';
      await db.runTransaction(async (tx) => {
        const pairRef = db.collection('friendStreaks').doc(pairId);
        const pSnap = await tx.get(pairRef);
        const p = pSnap.data() as Pair | undefined;
        if (!p || p.status !== 'invited' || !p.uids.includes(uid) || p.invitedBy === uid) { failure = 'That invite is no longer available.'; return; }
        inviter = p.invitedBy;
        const [myLinks, theirLinks] = await Promise.all([tx.get(linksRef(db, uid)), tx.get(linksRef(db, inviter))]);
        if (accept) {
          if (Object.keys(((myLinks.data() || {}) as Links).active || {}).length >= MAX_FRIEND_STREAKS) { failure = `You already have ${MAX_FRIEND_STREAKS} friend streaks. End one first.`; return; }
          if (Object.keys(((theirLinks.data() || {}) as Links).active || {}).length >= MAX_FRIEND_STREAKS) { failure = 'They already have as many friend streaks as they can keep.'; return; }
          tx.update(pairRef, { status: 'active', startedAt: new Date().toISOString(), startedDay: today });
          tx.set(linksRef(db, uid), { active: { [pairId]: inviter }, incoming: { [pairId]: del() } }, { merge: true });
          tx.set(linksRef(db, inviter), { active: { [pairId]: uid }, outgoing: { [pairId]: del() } }, { merge: true });
        } else {
          tx.update(pairRef, { status: 'declined', endedAt: new Date().toISOString() });
          tx.set(linksRef(db, uid), { incoming: { [pairId]: del() } }, { merge: true });
          tx.set(linksRef(db, inviter), { outgoing: { [pairId]: del() } }, { merge: true });
        }
      });
      if (failure) return res.status(409).json({ error: failure });
      if (accept) {
        const me = await personCard(db, uid);
        const tokens = await deps.collectPushTokens(db, [inviter], 'notificationsEnabled');
        await deps.sendPush(tokens, `${me.name} accepted your streak 🔥`, 'Your friend streak has started. Log something today!', { type: 'friend_streak_started' });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('friend streak respond error:', err);
      return res.status(500).json({ error: 'Could not answer the invite.' });
    }
  });

  // End one active streak, or cancel an invite that is still waiting.
  app.post('/api/friend-streak/end', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    const pairId = String(req.body?.pairId || '');
    try {
      const pRef = db.collection('friendStreaks').doc(pairId);
      const p = (await pRef.get()).data() as Pair | undefined;
      if (!p || !p.uids.includes(uid)) return res.json({ ok: true });
      const batch = db.batch();
      batch.update(pRef, { status: p.status === 'invited' ? 'declined' : 'ended', endedAt: new Date().toISOString(), endReason: 'left' });
      unlinkBoth(batch, db, pairId, p.uids);
      await batch.commit();
      return res.json({ ok: true });
    } catch (err) {
      console.error('friend streak end error:', err);
      return res.status(500).json({ error: 'Could not end the streak.' });
    }
  });

  // loads one of MY active friend streaks, or null
  async function myActivePair(db: Firestore, uid: string, pairId: string): Promise<{ ref: FirebaseFirestore.DocumentReference; p: Pair } | null> {
    const links = ((await linksRef(db, uid).get()).data() || {}) as Links;
    if (!links.active?.[pairId]) return null;
    const ref = db.collection('friendStreaks').doc(pairId);
    const p = (await ref.get()).data() as Pair | undefined;
    return p && p.status === 'active' ? { ref, p } : null;
  }

  app.post('/api/friend-streak/nudge', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    try {
      const mine = await myActivePair(db, uid, String(req.body?.pairId || ''));
      if (!mine) return res.status(400).json({ error: 'No friend streak.' });
      const today = await todayFor(db, uid);
      if (mine.p.lastNudge?.[uid] === today) return res.json({ ok: true, already: true });
      await mine.ref.update({ [`lastNudge.${uid}`]: today });
      const other = mine.p.uids.find((u) => u !== uid)!;
      const me = await personCard(db, uid);
      const tokens = await deps.collectPushTokens(db, [other], 'notificationsEnabled');
      await deps.sendPush(tokens, `${me.name} is keeping your streak alive 🔥`, `Log something today so your ${mine.p.current || 0}-day streak keeps going.`, { type: 'friend_streak_nudge' });
      return res.json({ ok: true });
    } catch (err) {
      console.error('friend streak nudge error:', err);
      return res.status(500).json({ error: 'Could not send the nudge.' });
    }
  });

  // Either partner pays coins to unfreeze (or restore) a shared streak. At most 2 rescues per streak.
  app.post('/api/friend-streak/rescue', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    try {
      const today = await todayFor(db, uid);
      const mine = await myActivePair(db, uid, String(req.body?.pairId || ''));
      if (!mine) return res.status(400).json({ error: 'No friend streak.' });
      const pairRef = mine.ref;
      const pointsRef = db.collection('userPoints').doc(uid);
      let out: Record<string, unknown> | { error: string } = { error: 'Nothing to unfreeze.' };
      await db.runTransaction(async (tx) => {
        const [pSnap, ptSnap] = await Promise.all([tx.get(pairRef), tx.get(pointsRef)]);
        const p = pSnap.data() as Pair | undefined;
        if (!p || p.status !== 'active') return;
        if ((p.rescues || 0) >= MAX_RESCUES) { out = { error: 'This streak has used its 2 unfreezes.' }; return; }
        const base = p.lastBothDay || p.startedDay || today;
        const gap = daysBetween(base, today);
        let kind: 'frozen' | 'lost' | null = null;
        let missed = 0;
        if (p.lastBothDay !== today && (p.current || 0) > 0 && gap >= 2 && gap <= FROZEN_MAX_MISSED + 1) { kind = 'frozen'; missed = gap - 1; }
        else if (p.lost && today <= p.lost.until) { kind = 'lost'; missed = p.lost.missedDays; }
        if (!kind) return;
        const cost = COST_PER_MISSED_DAY * missed;
        const coins = Number(ptSnap.data()?.coins) || 0;
        if (coins < cost) { out = { error: `You need ${cost} coins to unfreeze this. You have ${coins}.` }; return; }
        const now = new Date().toISOString();
        const patch: Record<string, unknown> = { rescues: (p.rescues || 0) + 1 };
        if (kind === 'frozen') patch.lastBothDay = addDays(today, -1);
        else {
          const merged = (p.lost!.value || 0) + (p.current || 0);
          patch.current = merged;
          patch.longest = Math.max(p.longest || 0, merged);
          patch.lost = admin.firestore.FieldValue.delete();
        }
        tx.update(pairRef, patch);
        tx.set(pointsRef, { coins: admin.firestore.FieldValue.increment(-cost), updatedAt: now }, { merge: true });
        tx.set(db.collection('coinSpends').doc(), { uid, coins: cost, reason: 'friend_streak_rescue', days: missed, at: now });
        out = { ok: true, cost, kind };
      });
      const done = out as any;
      if (done.error) return res.status(400).json(done);
      return res.json(done);
    } catch (err) {
      console.error('friend streak rescue error:', err);
      return res.status(500).json({ error: 'Could not unfreeze right now. Please try again.' });
    }
  });
}
