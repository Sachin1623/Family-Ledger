import type express from 'express';
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';

// Quests: a game-like to-do board that never runs out. Everything here is checked by the SERVER from records the app already keeps:
//   questCounters/{uid}_{day}      what the person did each day (counts per action), written wherever XP is awarded and by /api/quests/event
//   userPoints/{uid}.actionCounts  the same counts for the whole lifetime (filled in once from the points ledger for long-time users)
//   userQuests/{uid}               small bits of cached state (family check, "already has a group" style facts, journey tiers claimed)
// A quest pays XP and coins ONCE, through the same transaction and ledger the rest of the points system uses (ledger key = uid + quest key),
// so a quest can never be claimed twice. Days follow the person's own time zone, weeks start on Monday.

export type Period = 'onboarding' | 'daily' | 'weekly' | 'monthly' | 'journey';

type ExistsCheck = 'group' | 'goal' | 'account' | 'reminder';
type Metric =
  | { kind: 'count'; keys: string[] } // total of these actions inside the quest's time window
  | { kind: 'days'; keys: string[] } // number of different days in the window with at least one of these actions
  | { kind: 'life'; keys: string[] } // total of these actions ever
  | { kind: 'streak' } // longest expense streak
  | { kind: 'joined' } // people who joined because of me (a friend I invited who accepted, or someone in a group I own)
  | { kind: 'exists'; check: ExistsCheck }
  | { kind: 'anyOf'; metrics: Metric[] }; // the highest of several (used where two different things count)

interface QuestDef {
  id: string;
  title: string;
  desc: string;
  icon: string; // Material Symbols name
  target: number;
  xp: number;
  coins: number;
  metric: Metric;
  go?: string; // where "Go" takes the person (an app path), or 'cheer' to open the cheer picker
  needs?: 'family' | 'history'; // only offered to people it makes sense for
  historyKeys?: string[]; // 'history': offered once they have done any of these before
}

const EXPENSE = ['expense_logged'];
const TASKS = ['todo_completed', 'habit_occurrence'];

// ---------- Getting started (everyone sees it once; long-time users just claim what they already did) ----------
const ONBOARDING: QuestDef[] = [
  { id: 'ob_expense', title: 'Log your first expense', desc: 'Add any expense, big or small.', icon: 'receipt_long', target: 1, xp: 15, coins: 15, metric: { kind: 'life', keys: EXPENSE }, go: '/add-expense' },
  { id: 'ob_group', title: 'Start or join a group', desc: 'Your family, flat or trip. Money is easier together.', icon: 'groups', target: 1, xp: 15, coins: 15, metric: { kind: 'exists', check: 'group' }, go: '/create-group' },
  { id: 'ob_budget', title: 'Set a budget', desc: 'Give a group a monthly budget to aim for.', icon: 'savings', target: 1, xp: 15, coins: 15, metric: { kind: 'life', keys: ['budget_set'] }, go: '/analysis' },
  { id: 'ob_goal', title: 'Add a goal or an account', desc: 'A goal to save for, or an account to watch.', icon: 'flag', target: 1, xp: 15, coins: 15, metric: { kind: 'anyOf', metrics: [{ kind: 'exists', check: 'goal' }, { kind: 'exists', check: 'account' }] }, go: '/goals' },
  { id: 'ob_voice', title: 'Try Talk to add', desc: 'Say "spent 500 for pizza" and watch it appear.', icon: 'mic', target: 1, xp: 15, coins: 15, metric: { kind: 'life', keys: ['ev_voice_used'] }, go: '/add-expense' },
  { id: 'ob_reminder', title: 'Set a reminder', desc: 'A bill, a payment or anything you must not forget.', icon: 'notifications_active', target: 1, xp: 15, coins: 15, metric: { kind: 'exists', check: 'reminder' }, go: '/reminders' },
  { id: 'ob_invite', title: 'Invite someone you love', desc: 'Send an invite to a family member or friend.', icon: 'person_add', target: 1, xp: 20, coins: 20, metric: { kind: 'life', keys: ['ev_invite_sent', 'friend_accepted', 'friend_request_converted'] }, go: '/friends' },
  { id: 'ob_joined', title: 'Get a family member or friend to join', desc: 'Ticks when someone you invited joins FamilyLedger.', icon: 'diversity_3', target: 1, xp: 25, coins: 25, metric: { kind: 'joined' }, go: '/friends' },
  { id: 'ob_share', title: 'Share your progress', desc: 'Send your weekly recap or the app to family and friends.', icon: 'ios_share', target: 1, xp: 20, coins: 20, metric: { kind: 'life', keys: ['ev_recap_shared', 'ev_spread_shared'] }, go: '/weekly-summary' },
];
const ONBOARDING_DONE: QuestDef = { id: 'ob_done', title: 'Guardian Starter', desc: 'You finished every Getting started quest.', icon: 'military_tech', target: ONBOARDING.length, xp: 50, coins: 50, metric: { kind: 'count', keys: [] } };

// ---------- Daily: 3 a day, the first is always "log an expense" ----------
const DAILY_FIRST: QuestDef = { id: 'd_log1', title: 'Log an expense', desc: 'Add one expense today. It also lights your streak.', icon: 'receipt_long', target: 1, xp: 8, coins: 8, metric: { kind: 'count', keys: EXPENSE }, go: '/add-expense' };
const DAILY_POOL: QuestDef[] = [
  { id: 'd_log3', title: 'Log 3 expenses', desc: 'Three entries today keep your picture complete.', icon: 'checklist', target: 3, xp: 10, coins: 10, metric: { kind: 'count', keys: EXPENSE }, go: '/add-expense' },
  { id: 'd_todo', title: 'Finish a to-do', desc: 'Tick off one task today.', icon: 'task_alt', target: 1, xp: 8, coins: 8, metric: { kind: 'count', keys: ['todo_completed'] }, go: '/tools?category=productivity', needs: 'history', historyKeys: ['todo_completed'] },
  { id: 'd_habit', title: 'Keep a habit going', desc: 'Mark one habit done today.', icon: 'self_improvement', target: 1, xp: 8, coins: 8, metric: { kind: 'count', keys: ['habit_occurrence'] }, go: '/tools?category=productivity', needs: 'history', historyKeys: ['habit_occurrence'] },
  { id: 'd_health', title: 'Look after your health', desc: 'Log a medicine dose or a reading today.', icon: 'favorite', target: 1, xp: 8, coins: 8, metric: { kind: 'count', keys: ['ev_health_log'] }, go: '/health', needs: 'history', historyKeys: ['ev_health_log'] },
  { id: 'd_game', title: 'Play a game', desc: 'Finish one game, solo or with family.', icon: 'sports_esports', target: 1, xp: 8, coins: 8, metric: { kind: 'count', keys: ['game_played'] }, go: '/tools?category=games' },
  { id: 'd_cheer', title: 'Cheer a family member', desc: 'Send someone a cheer. A little kindness goes far.', icon: 'celebration', target: 1, xp: 8, coins: 8, metric: { kind: 'count', keys: ['ev_cheer'] }, go: 'cheer', needs: 'family' },
];
const DAILY_BONUS: QuestDef = { id: 'd_all', title: 'Daily sweep', desc: 'Finish all three of today\'s quests.', icon: 'workspace_premium', target: 3, xp: 15, coins: 15, metric: { kind: 'count', keys: [] } };

// ---------- Weekly: new set every Monday (a new person gets this week's set the day they join) ----------
const WEEKLY_FIXED: QuestDef[] = [
  { id: 'w_days5', title: 'Log on 5 days', desc: 'Add an expense on five different days this week.', icon: 'event_available', target: 5, xp: 40, coins: 40, metric: { kind: 'days', keys: EXPENSE }, go: '/add-expense' },
  { id: 'w_recap', title: 'Share your weekly recap', desc: 'Send your recap pictures to family and friends.', icon: 'ios_share', target: 1, xp: 25, coins: 25, metric: { kind: 'count', keys: ['ev_recap_shared', 'ev_spread_shared'] }, go: '/weekly-summary' },
];
const WEEKLY_POOL: QuestDef[] = [
  { id: 'w_tasks5', title: 'Complete 5 tasks', desc: 'Any mix of to-dos and habits.', icon: 'task_alt', target: 5, xp: 30, coins: 30, metric: { kind: 'count', keys: TASKS }, go: '/tools?category=productivity', needs: 'history', historyKeys: TASKS },
  { id: 'w_budget', title: 'Set or meet a budget', desc: 'Make a budget, or stay inside one.', icon: 'savings', target: 1, xp: 50, coins: 50, metric: { kind: 'count', keys: ['budget_set', 'budget_met'] }, go: '/analysis' },
  { id: 'w_health3', title: 'Health on 3 days', desc: 'Log medicine or a reading on three different days.', icon: 'monitor_heart', target: 3, xp: 30, coins: 30, metric: { kind: 'days', keys: ['ev_health_log'] }, go: '/health', needs: 'history', historyKeys: ['ev_health_log'] },
  { id: 'w_game3', title: 'Play 3 games', desc: 'Three finished games this week.', icon: 'sports_esports', target: 3, xp: 20, coins: 20, metric: { kind: 'count', keys: ['game_played'] }, go: '/tools?category=games' },
  { id: 'w_cheer3', title: 'Cheer 3 times', desc: 'Cheer family members three times this week.', icon: 'celebration', target: 3, xp: 20, coins: 20, metric: { kind: 'count', keys: ['ev_cheer'] }, go: 'cheer', needs: 'family' },
];

// ---------- Monthly ----------
const MONTH_THEMES = ['Fresh start', 'Love your family', 'Spring clean your money', 'Budget builder', 'Steady saver', 'Mid-year check-in', 'Health first', 'Goal getter', 'Back to routine', 'Festival of savings', 'Gratitude month', 'Year-end review'];
const MONTHLY_FIXED: QuestDef = { id: 'm_days20', title: 'Log on 20 days', desc: 'Add an expense on twenty different days this month.', icon: 'calendar_month', target: 20, xp: 100, coins: 100, metric: { kind: 'days', keys: EXPENSE }, go: '/add-expense' };
const MONTHLY_POOL: QuestDef[] = [
  { id: 'm_budget', title: 'Meet a budget', desc: 'Finish the month inside a group budget.', icon: 'savings', target: 1, xp: 100, coins: 100, metric: { kind: 'count', keys: ['budget_met'] }, go: '/analysis' },
  { id: 'm_health10', title: '10 health logs', desc: 'Medicine doses and readings count.', icon: 'monitor_heart', target: 10, xp: 80, coins: 80, metric: { kind: 'count', keys: ['ev_health_log'] }, go: '/health', needs: 'history', historyKeys: ['ev_health_log'] },
  { id: 'm_games10', title: 'Play 10 games', desc: 'Ten finished games this month.', icon: 'sports_esports', target: 10, xp: 60, coins: 60, metric: { kind: 'count', keys: ['game_played'] }, go: '/tools?category=games' },
  { id: 'm_cheer10', title: 'Cheer 10 times', desc: 'Lift your family up ten times this month.', icon: 'celebration', target: 10, xp: 60, coins: 60, metric: { kind: 'count', keys: ['ev_cheer'] }, go: 'cheer', needs: 'family' },
];

// ---------- Journey: milestones that keep going. Each category lists its early steps, then doubles forever ----------
interface JourneyCat { id: string; title: (n: number) => string; desc: string; icon: string; steps: number[]; metric: Metric; go?: string; rewardOf: (n: number) => number }
const JOURNEY: JourneyCat[] = [
  { id: 'streak', title: (n) => `${n}-day streak`, desc: 'Look after your family\'s spending day after day.', icon: 'local_fire_department', steps: [3, 7, 14, 30, 60, 100, 180, 365], metric: { kind: 'streak' }, go: '/add-expense', rewardOf: (n) => Math.max(10, Math.round(n * 1.5)) },
  { id: 'expenses', title: (n) => `Log ${n} expenses`, desc: 'Every entry builds a clearer picture.', icon: 'receipt_long', steps: [10, 25, 50, 100, 250, 500, 1000, 2500], metric: { kind: 'life', keys: EXPENSE }, go: '/add-expense', rewardOf: (n) => Math.max(10, Math.round(n / 5)) },
  { id: 'tasks', title: (n) => `Finish ${n} tasks`, desc: 'To-dos and habits, one at a time.', icon: 'task_alt', steps: [10, 25, 50, 100, 250, 500], metric: { kind: 'life', keys: TASKS }, go: '/tools?category=productivity', rewardOf: (n) => Math.max(10, Math.round(n / 4)) },
  { id: 'games', title: (n) => `Play ${n} games`, desc: 'Family game nights add up.', icon: 'sports_esports', steps: [5, 10, 25, 50, 100, 250], metric: { kind: 'life', keys: ['game_played'] }, go: '/tools?category=games', rewardOf: (n) => Math.max(10, Math.round(n / 3)) },
  { id: 'budgets', title: (n) => `Meet ${n} budget${n === 1 ? '' : 's'}`, desc: 'Staying inside a budget is the real win.', icon: 'savings', steps: [1, 3, 5, 10, 25, 50], metric: { kind: 'life', keys: ['budget_met'] }, go: '/analysis', rewardOf: (n) => Math.max(40, n * 25) },
  { id: 'health', title: (n) => `${n} health logs`, desc: 'Care for the people who matter most.', icon: 'monitor_heart', steps: [5, 10, 25, 50, 100, 250], metric: { kind: 'life', keys: ['ev_health_log'] }, go: '/health', rewardOf: (n) => Math.max(10, Math.round(n / 2)) },
  { id: 'joined', title: (n) => `${n} family member${n === 1 ? '' : 's'} or friend${n === 1 ? '' : 's'} joined`, desc: 'Invite people you love and watch your circle grow.', icon: 'diversity_3', steps: [1, 3, 5, 10, 25, 50, 100], metric: { kind: 'joined' }, go: '/friends', rewardOf: (n) => Math.max(30, n * 20) },
  { id: 'cheers', title: (n) => `Cheer ${n} time${n === 1 ? '' : 's'}`, desc: 'Be someone\'s reason to smile.', icon: 'celebration', steps: [1, 5, 10, 25, 50, 100], metric: { kind: 'life', keys: ['ev_cheer'] }, go: 'cheer', rewardOf: (n) => Math.max(10, n * 2) },
];

const thresholdAt = (cat: JourneyCat, i: number): number => (i < cat.steps.length ? cat.steps[i] : cat.steps[cat.steps.length - 1] * 2 ** (i - cat.steps.length + 1));

// ---------- helpers ----------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededOrder<T>(items: T[], seed: string): T[] {
  return items
    .map((x, i) => ({ x, k: hash(`${seed}:${i}`) }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.x);
}
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (day: string): string => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
};
const safeKey = (k: string) => k.replace(/[^a-zA-Z0-9_]/g, '_');

export interface QuestDeps {
  getDb: () => Firestore | null;
  verifyAuth: (req: express.Request) => Promise<admin.auth.DecodedIdToken | null>;
  getUserTimezone: (db: Firestore, uid: string) => Promise<string | null>;
  dayInTimezone: (instant: Date | string | number, tz: string | null | undefined) => string;
  awardMultipleInTx: (tx: FirebaseFirestore.Transaction, db: Firestore, uid: string, awards: any[]) => Promise<boolean>;
  collectPushTokens: (db: Firestore, uids: string[], prefField: string) => Promise<string[]>;
  sendPush: (tokens: string[], title: string, body: string, data: Record<string, string>) => Promise<number>;
}

export interface QuestView {
  key: string; // the claim key, e.g. "d:2026-10-23:d_log1"
  id: string;
  period: Period;
  title: string;
  desc: string;
  icon: string;
  progress: number;
  target: number;
  xp: number;
  coins: number;
  claimed: boolean;
  claimable: boolean;
  go?: string;
}

const EVENT_TYPES = new Set(['recap_shared', 'spread_shared', 'health_log', 'voice_used', 'invite_sent', 'play_review_tap']);
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
const EVENT_DAILY_CAP = 30;

// Called from wherever XP is awarded or an event is recorded: adds to today's counters and the lifetime counters. `tx` must be mid-write phase.
export function bumpQuestCounts(tx: FirebaseFirestore.Transaction, db: Firestore, uid: string, day: string, counts: Record<string, number>): void {
  const keys = Object.keys(counts).filter((k) => counts[k] > 0);
  if (keys.length === 0) return;
  const inc = admin.firestore.FieldValue.increment;
  tx.set(db.collection('questCounters').doc(`${uid}_${day}`), { uid, day, counts: Object.fromEntries(keys.map((k) => [k, inc(counts[k])])) }, { merge: true });
  tx.set(db.collection('userPoints').doc(uid), { actionCounts: Object.fromEntries(keys.map((k) => [k, inc(counts[k])])) }, { merge: true });
}

export function registerQuestRoutes(app: express.Express, deps: QuestDeps): void {
  const { getDb, verifyAuth, getUserTimezone, dayInTimezone } = deps;

  interface Context {
    uid: string;
    today: string;
    weekStart: string;
    monthKey: string; // YYYY-MM
    lifetime: Record<string, number>;
    dayCounts: Record<string, Record<string, number>>; // day -> counts
    streakLongest: number;
    exists: Record<ExistsCheck, boolean>;
    hasFamily: boolean;
    joined: number; // family members and friends who joined because of this person
    joinedDay: string | null;
    claimed: Set<string>; // ledger keys already paid
    journeyDone: Record<string, number>;
  }

  // Makes sure lifetime counts exist: long-time users get them filled in once from the points ledger.
  async function loadLifetime(db: Firestore, uid: string, qState: Record<string, any>): Promise<Record<string, number>> {
    const pointsRef = db.collection('userPoints').doc(uid);
    if (!qState.backfilledAt) {
      const snap = await db.collection('pointsLedger').where('uid', '==', uid).select('actionType').get();
      const counts: Record<string, number> = {};
      snap.docs.forEach((d) => {
        const t = String(d.data().actionType || '');
        if (t && !t.startsWith('quest_')) counts[t] = (counts[t] || 0) + 1;
      });
      // Writes the full truth (overwriting any partial counts written since this feature went live).
      await pointsRef.set({ actionCounts: counts }, { merge: true });
      await db.collection('userQuests').doc(uid).set({ backfilledAt: new Date().toISOString() }, { merge: true });
      qState.backfilledAt = new Date().toISOString();
      return counts;
    }
    const snap = await pointsRef.get();
    return (snap.data()?.actionCounts as Record<string, number>) || {};
  }

  async function buildContext(db: Firestore, uid: string): Promise<Context> {
    const tz = await getUserTimezone(db, uid);
    const now = new Date();
    const today = dayInTimezone(now, tz);
    const weekStart = mondayOf(today);
    const monthKey = today.slice(0, 7);
    const qRef = db.collection('userQuests').doc(uid);
    const qSnap = await qRef.get();
    const qState: Record<string, any> = qSnap.data() || {};

    const lifetime = await loadLifetime(db, uid, qState);

    // days we need counters for: the whole month so far plus this week (a week can begin in the previous month)
    const first = `${monthKey}-01`;
    const start = weekStart < first ? weekStart : first;
    const days: string[] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) days.push(d);
    const refs = days.map((d) => db.collection('questCounters').doc(`${uid}_${d}`));
    const [daySnaps, streakSnap, userSnap] = await Promise.all([
      refs.length ? db.getAll(...refs) : Promise.resolve([]),
      db.collection('userPoints').doc(uid).collection('meta').doc('expenseStreak').get(),
      db.collection('users').doc(uid).get(),
    ]);
    const dayCounts: Record<string, Record<string, number>> = {};
    daySnaps.forEach((s, i) => {
      if (s.exists) dayCounts[days[i]] = (s.data()?.counts as Record<string, number>) || {};
    });

    // facts that, once true, stay true (cached on the quest doc)
    const cachedExists: Partial<Record<ExistsCheck, boolean>> = qState.exists || {};
    const exists: Record<ExistsCheck, boolean> = { group: !!cachedExists.group, goal: !!cachedExists.goal, account: !!cachedExists.account, reminder: !!cachedExists.reminder };
    const checks: [ExistsCheck, () => Promise<boolean>][] = [
      ['group', async () => !(await db.collection('members').where('userId', '==', uid).limit(1).get()).empty],
      ['goal', async () => !(await db.collection('goals').where('userId', '==', uid).limit(1).get()).empty],
      ['account', async () => !(await db.collection('financialAccounts').where('userId', '==', uid).limit(1).get()).empty],
      ['reminder', async () => !(await db.collection('expenseReminders').where('userId', '==', uid).limit(1).get()).empty],
    ];
    const missing = checks.filter(([k]) => !exists[k]);
    const results = await Promise.all(missing.map(([, fn]) => fn().catch(() => false)));
    let existsChanged = false;
    missing.forEach(([k], i) => {
      if (results[i]) {
        exists[k] = true;
        existsChanged = true;
      }
    });

    // does the person share a group with anyone else (someone to cheer)? re-checked at most every 6 hours while false
    let hasFamily = !!qState.hasFamily;
    let familyChecked = false;
    if (!hasFamily && (!qState.familyCheckedAt || Date.now() - new Date(qState.familyCheckedAt).getTime() > 6 * 3600e3)) {
      familyChecked = true;
      const mine = await db.collection('members').where('userId', '==', uid).get();
      const groupIds = Array.from(new Set(mine.docs.map((d) => d.data().groupId as string))).slice(0, 10);
      if (groupIds.length > 0) {
        const others = await db.collection('members').where('groupId', 'in', groupIds).limit(40).get();
        hasFamily = others.docs.some((d) => d.data().userId !== uid);
      }
    }
    // people who joined because of me: friends I invited who accepted, plus everyone else in the groups I own. Cached, looked at again every 6 hours.
    let joined = Number(qState.joinedCount) || 0;
    let joinedChecked = false;
    if (!qState.joinedCheckedAt || Date.now() - new Date(qState.joinedCheckedAt).getTime() > 6 * 3600e3) {
      joinedChecked = true;
      const people = new Set<string>();
      const conv = await db.collection('pointsLedger').where('uid', '==', uid).where('actionType', '==', 'friend_request_converted').select('sourceDocId').get().catch(() => null);
      conv?.docs.forEach((d) => {
        String(d.data().sourceDocId || '').split('_').forEach((u) => u && u !== uid && people.add(u));
      });
      const owned = await db.collection('members').where('userId', '==', uid).where('role', '==', 'owner').get().catch(() => null);
      const ownedIds = Array.from(new Set((owned?.docs || []).map((d) => d.data().groupId as string))).slice(0, 10);
      if (ownedIds.length) {
        const others = await db.collection('members').where('groupId', 'in', ownedIds).limit(200).get().catch(() => null);
        others?.docs.forEach((d) => d.data().userId && d.data().userId !== uid && people.add(d.data().userId));
      }
      joined = people.size;
    }
    if (existsChanged || familyChecked || joinedChecked) {
      await qRef.set({ ...(existsChanged ? { exists } : {}), ...(familyChecked ? { hasFamily, familyCheckedAt: new Date().toISOString() } : {}), ...(joinedChecked ? { joinedCount: joined, joinedCheckedAt: new Date().toISOString() } : {}) }, { merge: true });
    }

    const streakData = streakSnap.data() || {};
    return {
      uid, today, weekStart, monthKey, lifetime, dayCounts,
      streakLongest: Number(streakData.longest) || 0,
      exists, hasFamily, joined,
      joinedDay: typeof userSnap.data()?.createdAt === 'string' ? dayInTimezone(userSnap.data()!.createdAt, tz) : null,
      claimed: new Set<string>(),
      journeyDone: (qState.journeyDone as Record<string, number>) || {},
    };
  }

  // Builds the context, then looks up exactly the claim records for the quests on offer right now (a couple of dozen documents, never the history).
  async function load(db: Firestore, uid: string): Promise<Context> {
    const c = await buildContext(db, uid);
    const q = buildQuests(c);
    const keys = [...q.onboarding, q.obDone, ...q.daily, q.dailyBonus, ...q.weekly, ...q.monthly, ...q.journey].map((x) => x.key);
    const snaps = await db.getAll(...keys.map((k) => db.collection('pointsLedger').doc(`${uid}_quest_${safeKey(k)}`)));
    c.claimed = new Set(keys.filter((_, i) => snaps[i].exists));
    return c;
  }

  const sumKeys = (counts: Record<string, number> | undefined, keys: string[]) => (counts ? keys.reduce((s, k) => s + (counts[k] || 0), 0) : 0);

  function measure(m: Metric, c: Context, window: string[] | null): number {
    switch (m.kind) {
      case 'count':
        return (window || []).reduce((s, d) => s + sumKeys(c.dayCounts[d], m.keys), 0);
      case 'days':
        return (window || []).filter((d) => sumKeys(c.dayCounts[d], m.keys) > 0).length;
      case 'life':
        return sumKeys(c.lifetime, m.keys);
      case 'streak':
        return c.streakLongest;
      case 'joined':
        return c.joined;
      case 'exists':
        return c.exists[m.check] ? 1 : 0;
      case 'anyOf':
        return Math.max(0, ...m.metrics.map((x) => measure(x, c, window)));
    }
  }

  const eligible = (q: QuestDef, c: Context) => {
    if (q.needs === 'family') return c.hasFamily;
    if (q.needs === 'history') return sumKeys(c.lifetime, q.historyKeys || []) > 0;
    return true;
  };

  function view(q: QuestDef, key: string, period: Period, c: Context, window: string[] | null, overrideProgress?: number): QuestView {
    const progress = Math.min(q.target, overrideProgress ?? measure(q.metric, c, window));
    const claimed = c.claimed.has(key);
    return { key, id: q.id, period, title: q.title, desc: q.desc, icon: q.icon, progress, target: q.target, xp: q.xp, coins: q.coins, claimed, claimable: !claimed && progress >= q.target, go: q.go };
  }

  function buildQuests(c: Context) {
    // Getting started
    const onboarding = ONBOARDING.map((q) => view(q, `ob:${q.id}`, 'onboarding', c, null));
    const obClaimed = onboarding.filter((q) => q.claimed).length;
    const obDone: QuestView = view(ONBOARDING_DONE, `ob:${ONBOARDING_DONE.id}`, 'onboarding', c, null, obClaimed);

    // Daily
    const dayWindow = [c.today];
    const poolOk = DAILY_POOL.filter((q) => eligible(q, c));
    const filler = DAILY_POOL.filter((q) => !eligible(q, c) && !q.needs);
    const picks = [...seededOrder(poolOk, `${c.uid}:${c.today}`), ...seededOrder(filler, `${c.uid}:${c.today}:f`)].slice(0, 2);
    const dailyDefs = [DAILY_FIRST, ...picks];
    const daily = dailyDefs.map((q) => view(q, `d:${c.today}:${q.id}`, 'daily', c, dayWindow));
    const dailyBonus = view(DAILY_BONUS, `d:${c.today}:${DAILY_BONUS.id}`, 'daily', c, null, daily.filter((q) => q.claimed).length);

    // Weekly (Monday to Sunday)
    const weekDays: string[] = [];
    for (let d = c.weekStart; d <= c.today; d = addDays(d, 1)) weekDays.push(d);
    const wPool = seededOrder(WEEKLY_POOL.filter((q) => eligible(q, c)), `${c.uid}:${c.weekStart}`).slice(0, 2);
    const weekly = [...WEEKLY_FIXED, ...wPool].map((q) => view(q, `w:${c.weekStart}:${q.id}`, 'weekly', c, weekDays));
    const weekEnds = addDays(c.weekStart, 6);

    // Monthly
    const monthDays: string[] = [];
    for (let d = `${c.monthKey}-01`; d <= c.today; d = addDays(d, 1)) monthDays.push(d);
    const mPick = seededOrder(MONTHLY_POOL.filter((q) => eligible(q, c)), `${c.uid}:${c.monthKey}`).slice(0, 1);
    const monthly = [MONTHLY_FIXED, ...mPick].map((q) => view(q, `m:${c.monthKey}:${q.id}`, 'monthly', c, monthDays));
    const theme = MONTH_THEMES[Number(c.monthKey.slice(5, 7)) - 1];

    // Journey: the next step of every category (and the app anniversary)
    const journey: QuestView[] = JOURNEY.map((cat) => {
      const done = c.journeyDone[cat.id] ?? -1;
      const next = done + 1;
      const target = thresholdAt(cat, next);
      const reward = cat.rewardOf(target);
      const progress = Math.min(target, measure(cat.metric, c, null));
      const key = `j:${cat.id}:${next}`;
      const claimed = c.claimed.has(key);
      return { key, id: `j_${cat.id}`, period: 'journey' as Period, title: cat.title(target), desc: cat.desc, icon: cat.icon, progress, target, xp: reward, coins: reward, claimed, claimable: !claimed && progress >= target, go: cat.go };
    });
    // A one-time "rate us on Google Play" quest: tapping Go opens the store page and counts, collecting pays once, and then it is gone for good.
    const playKey = 'j:playreview:0';
    if (!c.claimed.has(playKey)) {
      const tapped = sumKeys(c.lifetime, ['ev_play_review_tap']) > 0;
      journey.push({ key: playKey, id: 'j_playreview', period: 'journey', title: 'Rate us on Google Play', desc: 'A quick rating helps other families find us. One time only.', icon: 'star', progress: tapped ? 1 : 0, target: 1, xp: 30, coins: 30, claimed: false, claimable: tapped, go: PLAY_URL });
    }
    if (c.joinedDay) {
      const days = Math.max(0, Math.floor((new Date(`${c.today}T00:00:00Z`).getTime() - new Date(`${c.joinedDay}T00:00:00Z`).getTime()) / 86400e3));
      const years = Math.floor(days / 365);
      const done = c.journeyDone.anniversary ?? 0;
      const nextYear = done + 1;
      const key = `j:anniversary:${nextYear}`;
      const claimed = c.claimed.has(key);
      const target = nextYear * 365;
      journey.push({ key, id: 'j_anniversary', period: 'journey', title: nextYear === 1 ? 'One year with FamilyLedger' : `${nextYear} years with FamilyLedger`, desc: 'Thank you for growing with us.', icon: 'cake', progress: Math.min(target, days), target, xp: 100 * nextYear, coins: 100 * nextYear, claimed, claimable: !claimed && years >= nextYear });
    }
    return { onboarding, obDone, daily, dailyBonus, weekly, weekEnds, monthly, theme, journey };
  }

  const answer = (c: Context) => {
    const q = buildQuests(c);
    const onboardingFinished = q.obDone.claimed;
    const todayTotal = q.daily.length;
    const todayDone = q.daily.filter((x) => x.claimed || x.claimable).length;
    const all = [...(onboardingFinished ? [] : [...q.onboarding, q.obDone]), ...q.daily, q.dailyBonus, ...q.weekly, ...q.monthly, ...q.journey];
    const claimable = all.filter((x) => x.claimable).length;
    return {
      day: c.today,
      onboardingFinished,
      onboarding: q.onboarding,
      onboardingBonus: q.obDone,
      daily: q.daily,
      dailyBonus: q.dailyBonus,
      weekly: q.weekly,
      weeklyEnds: q.weekEnds,
      monthly: q.monthly,
      monthTheme: q.theme,
      journey: q.journey,
      summary: { todayDone, todayTotal, claimable, pending: all.filter((x) => !x.claimed && !x.claimable).length },
      all,
    };
  };

  app.get('/api/quests', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      const { all, ...rest } = answer(await load(db, decoded.uid));
      void all;
      return res.json(rest);
    } catch (err) {
      console.error('quests error:', err);
      return res.status(500).json({ error: 'Could not load quests.' });
    }
  });

  app.post('/api/quests/claim', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const key = String(req.body?.key || '');
    try {
      const uid = decoded.uid;
      const c = await load(db, uid);
      const a = answer(c);
      const quest = a.all.find((x) => x.key === key);
      if (!quest) return res.status(400).json({ error: 'That quest is not available.' });
      if (quest.claimed) return res.json({ ok: true, alreadyAwarded: true, xp: 0, coins: 0 });
      if (!quest.claimable) return res.status(400).json({ error: 'Not finished yet.' });
      let awarded = false;
      await db.runTransaction(async (tx) => {
        const award = { actionType: 'quest_claim', ledgerKey: `${uid}_quest_${safeKey(key)}`, xp: quest.xp, coins: quest.coins, meta: { key, title: quest.title } };
        // Everything the award reads happens inside awardMultipleInTx before it writes; the tier bump below is a plain write after it.
        awarded = await deps.awardMultipleInTx(tx, db, uid, [award]);
        if (awarded && quest.period === 'journey') {
          const [, cat, idx] = key.split(':');
          tx.set(db.collection('userQuests').doc(uid), { journeyDone: { [cat]: Number(idx) } }, { merge: true });
        }
      });
      return res.json({ ok: true, alreadyAwarded: !awarded, xp: awarded ? quest.xp : 0, coins: awarded ? quest.coins : 0, title: quest.title });
    } catch (err) {
      console.error('quest claim error:', err);
      return res.status(500).json({ error: 'Could not claim this quest. Please try again.' });
    }
  });

  // Things the app did that points do not cover (a recap share, a health log, an invite ...). Each only moves a counter; the reward
  // itself is still paid once per quest, so repeating an event cannot pay more than the quest is worth.
  app.post('/api/quests/event', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const type = String(req.body?.type || '');
    if (!EVENT_TYPES.has(type)) return res.status(400).json({ error: 'Unknown event.' });
    try {
      await recordQuestEvent(db, decoded.uid, `ev_${type}`);
      return res.json({ ok: true });
    } catch (err) {
      console.error('quest event error:', err);
      return res.status(500).json({ error: 'Could not record that.' });
    }
  });

  async function recordQuestEvent(db: Firestore, uid: string, key: string): Promise<void> {
    const day = dayInTimezone(new Date(), await getUserTimezone(db, uid));
    await db.runTransaction(async (tx) => {
      const ref = db.collection('questCounters').doc(`${uid}_${day}`);
      const snap = await tx.get(ref);
      if ((snap.data()?.counts?.[key] || 0) >= EVENT_DAILY_CAP) return;
      bumpQuestCounts(tx, db, uid, day, { [key]: 1 });
    });
  }

  // People the person can cheer: everyone who shares a group with them.
  app.get('/api/quests/cheer-targets', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      const mine = await db.collection('members').where('userId', '==', decoded.uid).get();
      const groupIds = Array.from(new Set(mine.docs.map((d) => d.data().groupId as string))).slice(0, 10);
      if (groupIds.length === 0) return res.json({ people: [] });
      const others = await db.collection('members').where('groupId', 'in', groupIds).limit(80).get();
      const seen = new Map<string, { uid: string; name: string; photoURL: string | null }>();
      others.docs.forEach((d) => {
        const m = d.data();
        if (m.userId && m.userId !== decoded.uid && !seen.has(m.userId)) seen.set(m.userId, { uid: m.userId, name: m.displayName || 'Family member', photoURL: m.photoURL || null });
      });
      const day = dayInTimezone(new Date(), await getUserTimezone(db, decoded.uid));
      const cheered = await Promise.all(Array.from(seen.keys()).map((u) => db.collection('questCheers').doc(`${decoded.uid}_${u}_${day}`).get()));
      const people = Array.from(seen.values()).map((p, i) => ({ ...p, cheeredToday: cheered[i].exists }));
      return res.json({ people: people.slice(0, 40) });
    } catch (err) {
      console.error('cheer targets error:', err);
      return res.status(500).json({ error: 'Could not load people.' });
    }
  });

  app.post('/api/quests/cheer', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const toUid = String(req.body?.toUid || '');
    if (!toUid || toUid === decoded.uid) return res.status(400).json({ error: 'Choose someone to cheer.' });
    try {
      // they must share a group
      const mine = await db.collection('members').where('userId', '==', decoded.uid).get();
      const groupIds = Array.from(new Set(mine.docs.map((d) => d.data().groupId as string))).slice(0, 10);
      const theirs = groupIds.length ? await db.collection('members').where('groupId', 'in', groupIds).where('userId', '==', toUid).limit(1).get() : null;
      if (!theirs || theirs.empty) return res.status(403).json({ error: 'You can only cheer people in your groups.' });
      const day = dayInTimezone(new Date(), await getUserTimezone(db, decoded.uid));
      const cheerRef = db.collection('questCheers').doc(`${decoded.uid}_${toUid}_${day}`);
      let first = false;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(cheerRef);
        if (snap.exists) return;
        first = true;
        tx.set(cheerRef, { from: decoded.uid, to: toUid, day, at: new Date().toISOString() });
        bumpQuestCounts(tx, db, decoded.uid, day, { ev_cheer: 1 });
      });
      if (first) {
        const me = mine.docs[0]?.data();
        const name = me?.displayName || decoded.name || 'Someone in your family';
        const tokens = await deps.collectPushTokens(db, [toUid], 'notificationsEnabled');
        await deps.sendPush(tokens, `${name} cheered you on 👏`, 'Keep it up. Your family is proud of you!', { type: 'cheer' });
      }
      return res.json({ ok: true, already: !first });
    } catch (err) {
      console.error('cheer error:', err);
      return res.status(500).json({ error: 'Could not send the cheer.' });
    }
  });
}

// Exposed so other server code (e.g. the voice endpoint) can count an event without an HTTP round trip.
export async function recordServerQuestEvent(db: Firestore, uid: string, type: string, dayInTimezone: (i: Date, tz: string | null) => string, tz: string | null): Promise<void> {
  const day = dayInTimezone(new Date(), tz);
  const key = `ev_${type}`;
  await db.runTransaction(async (tx) => {
    bumpQuestCounts(tx, db, uid, day, { [key]: 1 });
  });
}
