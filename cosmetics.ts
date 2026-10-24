import type express from 'express';
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';

// Personal style: flame styles for the streak flame (some bought with coins, one earned) and badges (all earned) shown next to a person's name.
//
// Everything is decided here, never in the app: the catalogue and prices, whether a coin purchase goes through, and which badges a person has earned.
// A person's own record is userPoints/{uid}/meta/cosmetics (readable by them, written only by this server):
//   { owned: string[]   flame styles bought with coins
//     earned: string[]  flame styles and badges earned by reaching something (kept for good once earned, even if a streak later breaks)
//     flame: string     the flame style they use
//     badges: string[]  up to 3 earned badges shown next to their name }
// Friends see only the flame id and the chosen badge icons (see publicStyle), never what else a person owns.

export const MAX_SHOWN_BADGES = 3;

interface FlameItem { id: string; name: string; price: number; earnedBy?: string; hint?: string }
export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'legend';
type Metric = 'streak' | 'groups' | 'settled' | 'buddy' | 'quests';
interface BadgeItem { id: string; name: string; icon: string; hint: string; tier: BadgeTier; metric: Metric; target: number }

export const FLAMES: FlameItem[] = [
  { id: 'classic', name: 'Classic', price: 0 },
  { id: 'blue', name: 'Blue flame', price: 1000 },
  { id: 'gold', name: 'Golden', price: 1500 },
  { id: 'green', name: 'Emerald', price: 1500 },
  { id: 'purple', name: 'Royal purple', price: 2500 },
  { id: 'frost', name: 'Frostfire', price: 0, earnedBy: 'streak_30', hint: 'Reach a 30-day streak' },
];

// Every badge is earned by reaching a number (`target`) on one measure (`metric`), so the app can show exactly how far along a person is. Four tiers: the higher the tier, the rarer.
export const BADGES: BadgeItem[] = [
  { id: 'streak_7', name: 'Week of fire', icon: '🔥', hint: 'Keep a 7-day streak', tier: 'bronze', metric: 'streak', target: 7 },
  { id: 'streak_30', name: 'Month strong', icon: '🏅', hint: 'Keep a 30-day streak', tier: 'silver', metric: 'streak', target: 30 },
  { id: 'streak_100', name: 'Hundred club', icon: '💯', hint: 'Keep a 100-day streak', tier: 'gold', metric: 'streak', target: 100 },
  { id: 'streak_365', name: 'A whole year', icon: '👑', hint: 'Keep a 365-day streak', tier: 'legend', metric: 'streak', target: 365 },
  { id: 'first_group', name: 'Group builder', icon: '🏠', hint: 'Create a group', tier: 'bronze', metric: 'groups', target: 1 },
  { id: 'settled_up', name: 'Settled up', icon: '🤝', hint: 'Pay someone back in Settlements', tier: 'bronze', metric: 'settled', target: 1 },
  { id: 'settle_10', name: 'Debt crusher', icon: '💸', hint: 'Record 10 payments', tier: 'silver', metric: 'settled', target: 10 },
  { id: 'buddy_7', name: 'Streak buddy', icon: '👯', hint: 'Reach 7 days in a friend streak', tier: 'silver', metric: 'buddy', target: 7 },
  { id: 'buddy_30', name: 'Inseparable', icon: '💞', hint: 'Reach 30 days in a friend streak', tier: 'gold', metric: 'buddy', target: 30 },
  { id: 'quest_10', name: 'Quest master', icon: '🎯', hint: 'Finish 10 quests', tier: 'bronze', metric: 'quests', target: 10 },
  { id: 'quest_50', name: 'Quest hero', icon: '⚔️', hint: 'Finish 50 quests', tier: 'gold', metric: 'quests', target: 50 },
  { id: 'quest_150', name: 'Legend of the ledger', icon: '🌟', hint: 'Finish 150 quests', tier: 'legend', metric: 'quests', target: 150 },
];

const FLAME_IDS = new Set(FLAMES.map((f) => f.id));
const BADGE_BY_ID = new Map(BADGES.map((b) => [b.id, b]));

interface Cosmetics { owned: string[]; earned: string[]; flame: string; badges: string[] }

const cosRef = (db: Firestore, uid: string) => db.collection('userPoints').doc(uid).collection('meta').doc('cosmetics');

function normalise(raw: Partial<Cosmetics> | undefined): Cosmetics {
  const owned = Array.isArray(raw?.owned) ? raw!.owned!.filter((x) => FLAME_IDS.has(x)) : [];
  const earned = Array.isArray(raw?.earned) ? raw!.earned! : [];
  return { owned, earned, flame: raw?.flame && FLAME_IDS.has(raw.flame) ? raw.flame : 'classic', badges: Array.isArray(raw?.badges) ? raw!.badges!.slice(0, MAX_SHOWN_BADGES) : [] };
}

// A flame style the person may use right now.
function hasFlame(c: Cosmetics, id: string): boolean {
  const f = FLAMES.find((x) => x.id === id);
  if (!f) return false;
  return f.price === 0 && !f.earnedBy ? true : f.earnedBy ? c.earned.includes(f.earnedBy) : c.owned.includes(id);
}

// How far along the person is on each measure, worked out from their own history.
async function measures(db: Firestore, uid: string): Promise<Record<Metric, number>> {
  const countOf = async (q: FirebaseFirestore.Query) => (await q.count().get().catch(() => null))?.data().count || 0;
  const [streakSnap, groups, paid, oldPaid, pairSnap, quests] = await Promise.all([
    db.collection('userPoints').doc(uid).collection('meta').doc('expenseStreak').get(),
    countOf(db.collection('groups').where('createdBy', '==', uid)),
    countOf(db.collection('settlements').where('fromUid', '==', uid)),
    countOf(db.collection('expenses').where('addedBy', '==', uid).where('isSettlement', '==', true)),
    db.collection('friendStreaks').where('uids', 'array-contains', uid).get(),
    countOf(db.collection('pointsLedger').where('uid', '==', uid).where('actionType', '==', 'quest_claim')),
  ]);
  const s = streakSnap.data() || {};
  return {
    streak: Math.max(Number(s.longest) || 0, Number(s.current) || 0),
    groups,
    settled: paid + oldPaid,
    buddy: pairSnap.docs.reduce((m, d) => Math.max(m, Number(d.data().longest) || 0, Number(d.data().current) || 0), 0),
    quests,
  };
}

// Adds anything newly reached to the person's record. Returns the record, the measures, and the badges earned just now (for the celebration).
async function refreshEarned(db: Firestore, uid: string): Promise<{ c: Cosmetics; m: Record<Metric, number>; fresh: string[] }> {
  const ref = cosRef(db, uid);
  const current = normalise((await ref.get()).data() as Partial<Cosmetics> | undefined);
  const m = await measures(db, uid);
  const fresh = BADGES.filter((b) => m[b.metric] >= b.target && !current.earned.includes(b.id)).map((b) => b.id);
  if (fresh.length > 0) {
    current.earned = [...current.earned, ...fresh];
    await ref.set({ earned: admin.firestore.FieldValue.arrayUnion(...fresh) }, { merge: true });
  }
  return { c: current, m, fresh };
}

// What other people see of someone: the flame id and the icons of the badges they chose to show.
export async function publicStyle(db: Firestore, uid: string): Promise<{ flame: string; badges: string[] }> {
  const c = normalise((await cosRef(db, uid).get()).data() as Partial<Cosmetics> | undefined);
  const flame = hasFlame(c, c.flame) ? c.flame : 'classic';
  return { flame, badges: c.badges.filter((b) => c.earned.includes(b)).map((b) => BADGE_BY_ID.get(b)?.icon || '').filter(Boolean) };
}

export interface CosmeticsDeps {
  getDb: () => Firestore | null;
  verifyAuth: (req: express.Request) => Promise<admin.auth.DecodedIdToken | null>;
}

export function registerCosmeticsRoutes(app: express.Express, deps: CosmeticsDeps): void {
  const { getDb, verifyAuth } = deps;

  app.get('/api/cosmetics', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    try {
      const [{ c, m, fresh }, pts] = await Promise.all([refreshEarned(db, uid), db.collection('userPoints').doc(uid).get()]);
      return res.json({
        coins: Number(pts.data()?.coins) || 0,
        equipped: { flame: hasFlame(c, c.flame) ? c.flame : 'classic', badges: c.badges.filter((b) => c.earned.includes(b)) },
        maxBadges: MAX_SHOWN_BADGES,
        flames: FLAMES.map((f) => ({ id: f.id, name: f.name, price: f.price, hint: f.hint || null, unlocked: hasFlame(c, f.id), earnedOnly: !!f.earnedBy })),
        badges: BADGES.map((b) => ({ id: b.id, name: b.name, icon: b.icon, hint: b.hint, tier: b.tier, target: b.target, progress: Math.min(b.target, m[b.metric]), earned: c.earned.includes(b.id) })),
        newlyEarned: fresh,
      });
    } catch (err) {
      console.error('cosmetics load error:', err);
      return res.status(500).json({ error: 'Could not load your style.' });
    }
  });

  // Buy a flame style with coins. The balance check, the deduction, the spend log and the unlock are one transaction, so a double tap cannot charge twice.
  app.post('/api/cosmetics/buy', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    const id = String(req.body?.id || '');
    const item = FLAMES.find((f) => f.id === id);
    if (!item || item.price <= 0 || item.earnedBy) return res.status(400).json({ error: 'That style cannot be bought.' });
    try {
      let error: string | null = null;
      await db.runTransaction(async (tx) => {
        const pointsRef = db.collection('userPoints').doc(uid);
        const [cSnap, pSnap] = await Promise.all([tx.get(cosRef(db, uid)), tx.get(pointsRef)]);
        const c = normalise(cSnap.data() as Partial<Cosmetics> | undefined);
        if (c.owned.includes(id)) { error = 'You already own this style.'; return; }
        const coins = Number(pSnap.data()?.coins) || 0;
        if (coins < item.price) { error = `You need ${item.price} coins for this. You have ${coins}.`; return; }
        const now = new Date().toISOString();
        tx.set(pointsRef, { coins: admin.firestore.FieldValue.increment(-item.price), updatedAt: now }, { merge: true });
        tx.set(db.collection('coinSpends').doc(), { uid, coins: item.price, reason: 'flame_style', item: id, at: now });
        tx.set(cosRef(db, uid), { owned: admin.firestore.FieldValue.arrayUnion(id), flame: id }, { merge: true });
      });
      if (error) return res.status(400).json({ error });
      return res.json({ ok: true });
    } catch (err) {
      console.error('cosmetics buy error:', err);
      return res.status(500).json({ error: 'Could not complete the purchase. Nothing was charged.' });
    }
  });

  // Choose the flame style and/or the badges shown next to the name. Free, and only ever from what the person actually has.
  app.post('/api/cosmetics/equip', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = decoded.uid;
    try {
      const { c } = await refreshEarned(db, uid);
      const patch: Record<string, unknown> = {};
      if (typeof req.body?.flame === 'string') {
        if (!hasFlame(c, req.body.flame)) return res.status(400).json({ error: 'You do not have that style yet.' });
        patch.flame = req.body.flame;
      }
      if (Array.isArray(req.body?.badges)) {
        const ids: string[] = Array.from(new Set<string>(req.body.badges.map(String))).slice(0, MAX_SHOWN_BADGES);
        if (ids.some((b) => !c.earned.includes(b) || !BADGE_BY_ID.has(b))) return res.status(400).json({ error: 'You have not earned that badge yet.' });
        patch.badges = ids;
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change.' });
      await cosRef(db, uid).set(patch, { merge: true });
      return res.json({ ok: true });
    } catch (err) {
      console.error('cosmetics equip error:', err);
      return res.status(500).json({ error: 'Could not save your choice.' });
    }
  });
}
