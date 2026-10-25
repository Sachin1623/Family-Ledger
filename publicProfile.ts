import type express from 'express';
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { publicCosmetics } from './cosmetics';

// The public profile: what other FamilyLedger members can see about a person, decided by that person.
//
// Who can ask: any signed-in member, never anyone without an account. How the viewer relates to the owner decides what they get:
//   self   : everything (it is their own profile)
//   friend : an accepted friend (also anyone with a pending invite to look at before accepting is just a "member")
//   member : any other signed-in FamilyLedger user (leaderboards, group lists, a friend invite they are about to answer)
// The owner stores one main setting and one setting per section in users/{uid}.profileVisibility:
//   { main: 'only_me' | 'friends' | 'members', sections: { <section>: 'only_me' | 'friends' | 'members' } }
// A section is shown only if it passes BOTH its own setting and the main setting (the stricter of the two wins), so a section can never be wider than
// the main setting. A section that is not allowed is left out of the response entirely, so it never leaves the server.
//
// Money is never part of a profile: no amounts, balances, totals or coins, in any section, whatever the settings. Only counts, days and names of categories.

type Level = 'only_me' | 'friends' | 'members';
const LEVELS: Level[] = ['only_me', 'friends', 'members'];
const ORDER: Record<Level, number> = { only_me: 0, friends: 1, members: 2 };

export const SECTIONS = ['level', 'streaks', 'badges', 'flames', 'week', 'games', 'recap', 'journey', 'friends', 'birthday'] as const;
type Section = (typeof SECTIONS)[number];

// What each section is set to until the person chooses. level, streaks and badges were already visible to every signed-in member before this existed,
// so they stay that way; the more personal ones start with friends only, and the birthday starts private.
const DEFAULTS: Record<Section, Level> = { level: 'members', streaks: 'members', badges: 'members', flames: 'members', week: 'friends', games: 'friends', recap: 'friends', journey: 'friends', friends: 'friends', birthday: 'only_me' };

// The older on/off switches (publicProfileSettings) still count until the person uses the new screen: off becomes "only me", on becomes visible to members.
const LEGACY_KEY: Partial<Record<Section, string>> = { level: 'level', streaks: 'streaks', badges: 'badges', games: 'gameStats', birthday: 'birthday' };

export interface ProfileVisibility { main: Level; sections: Record<Section, Level> }

export function readVisibility(user: Record<string, any>): ProfileVisibility {
  const saved = (user.profileVisibility || {}) as { main?: string; sections?: Record<string, string> };
  const legacy = (user.publicProfileSettings || {}) as Record<string, unknown>;
  const main: Level = LEVELS.includes(saved.main as Level) ? (saved.main as Level) : 'members';
  const sections = {} as Record<Section, Level>;
  for (const s of SECTIONS) {
    const own = saved.sections?.[s];
    if (LEVELS.includes(own as Level)) { sections[s] = own as Level; continue; }
    const lk = LEGACY_KEY[s];
    if (lk && typeof legacy[lk] === 'boolean') { sections[s] = legacy[lk] ? 'members' : 'only_me'; continue; }
    sections[s] = DEFAULTS[s];
  }
  return { main, sections };
}

const stricter = (a: Level, b: Level): Level => (ORDER[a] <= ORDER[b] ? a : b);

type Relation = 'self' | 'friend' | 'member';
function allowed(vis: ProfileVisibility, section: Section, relation: Relation): boolean {
  if (relation === 'self') return true;
  const level = stricter(vis.sections[section], vis.main);
  return level === 'members' || (level === 'friends' && relation === 'friend');
}

// ---- games: wins and rank per game ----
interface Tally { played: number; won: number }
type Boards = Map<string, Map<string, Tally>>;

// ---- small in-memory caches: slow things are computed once and shared, so a profile view is not a pile of queries ----
const memoStore = new Map<string, { at: number; value: Promise<unknown> }>();
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  if (memoStore.size > 600) memoStore.clear();
  const value = fn().catch((err) => { memoStore.delete(key); throw err; });
  memoStore.set(key, { at: Date.now(), value });
  return value;
}

// ---- games: wins and rank per game ----
// Tallying every finished game ever played takes many seconds, so it is NOT done while someone waits for a profile. The tallies are kept in Firestore
// (gameBoards/{gameType}: { updatedAt, players: { uid: [played, won] } }) and in memory. A profile just reads them. If they are older than 15 minutes
// they are rebuilt in the background for the next viewer; if they have never been built the games section simply has no ranks until the first rebuild ends.
let boardMemory: { at: number; boards: Boards } | null = null;
let boardRebuilding = false;

export async function rebuildGameBoards(db: Firestore): Promise<number> {
  // the permanent gameOutcomes record survives players deleting a game
  const snap = await db.collection('gameOutcomes').select('gameType', 'playerUids', 'winnerUid', 'winningTeam', 'winnerTeam', 'players').get();
  const boards: Boards = new Map();
  snap.docs.forEach((d) => {
    const o = d.data();
    if (!o.gameType || !Array.isArray(o.playerUids)) return;
    const board = boards.get(o.gameType) || new Map<string, Tally>();
    boards.set(o.gameType, board);
    let winners: string[] = [];
    if (o.winnerUid) winners = [o.winnerUid];
    else if (Array.isArray(o.winningTeam)) winners = o.winningTeam;
    else if (typeof o.winnerTeam === 'number' && Array.isArray(o.players)) winners = o.players.filter((p: any) => p.team === o.winnerTeam).map((p: any) => p.uid);
    const winSet = new Set(winners);
    (o.playerUids as string[]).forEach((u) => {
      const t = board.get(u) || { played: 0, won: 0 };
      t.played += 1;
      if (winSet.has(u)) t.won += 1;
      board.set(u, t);
    });
  });
  const now = new Date().toISOString();
  await Promise.all(
    [...boards.entries()].map(([game, board]) => {
      const players: Record<string, [number, number]> = {};
      board.forEach((t, u) => { players[u] = [t.played, t.won]; });
      return db.collection('gameBoards').doc(game).set({ updatedAt: now, players });
    }),
  );
  boardMemory = { at: Date.now(), boards };
  return boards.size;
}

async function gameBoards(db: Firestore): Promise<Boards> {
  if (boardMemory && Date.now() - boardMemory.at < 15 * 60_000) return boardMemory.boards;
  const snap = await db.collection('gameBoards').get();
  const boards: Boards = new Map();
  let oldest = Date.now();
  snap.docs.forEach((d) => {
    const data = d.data();
    const board = new Map<string, Tally>();
    Object.entries((data.players || {}) as Record<string, [number, number]>).forEach(([u, v]) => board.set(u, { played: v[0] || 0, won: v[1] || 0 }));
    boards.set(d.id, board);
    oldest = Math.min(oldest, new Date(data.updatedAt || 0).getTime());
  });
  boardMemory = { at: Date.now(), boards };
  if ((snap.empty || Date.now() - oldest > 15 * 60_000) && !boardRebuilding) {
    boardRebuilding = true;
    rebuildGameBoards(db).catch((err) => console.error('game boards rebuild failed:', err)).finally(() => { boardRebuilding = false; });
  }
  return boards;
}

function rankIn(board: Map<string, Tally>, uid: string, scope: Set<string> | null): { rank: number; of: number } | null {
  const rows = [...board.entries()].filter(([u, t]) => t.played > 0 && (scope === null || scope.has(u)));
  rows.sort((a, b) => b[1].won - a[1].won || b[1].won / b[1].played - a[1].won / a[1].played || b[1].played - a[1].played);
  const i = rows.findIndex(([u]) => u === uid);
  return i < 0 ? null : { rank: i + 1, of: rows.length };
}

export interface ProfileDeps {
  getDb: () => Firestore | null;
  verifyAuth: (req: express.Request) => Promise<admin.auth.DecodedIdToken | null>;
  getUserTimezone: (db: Firestore, uid: string) => Promise<string | null>;
  dayInTimezone: (instant: Date | string | number, tz: string | null | undefined) => string;
}

export function registerPublicProfileRoutes(app: express.Express, deps: ProfileDeps): void {
  const { getDb, verifyAuth, getUserTimezone, dayInTimezone } = deps;

  async function friendUidsOf(db: Firestore, uid: string): Promise<string[]> {
    const snap = await db.collection('friendships').where('participants', 'array-contains', uid).where('status', '==', 'accepted').get();
    return snap.docs.map((d) => (d.data().participants || []).find((u: string) => u !== uid)).filter(Boolean);
  }

  app.get('/api/profile/:uid', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const uid = String(req.params.uid);
    const viewer = decoded.uid;
    try {
      // who it is and how the viewer relates to them: the only two things needed before the rest can start
      const [userSnap, friendUids] = await Promise.all([db.collection('users').doc(uid).get(), friendUidsOf(db, uid)]);
      if (!userSnap.exists) return res.status(404).json({ error: 'This profile is not available.' });
      const user = userSnap.data() || {};
      if (viewer !== uid && Array.isArray(user.blockedUsers) && user.blockedUsers.includes(viewer)) return res.status(404).json({ error: 'This profile is not available.' });

      const relation: Relation = viewer === uid ? 'self' : friendUids.includes(viewer) ? 'friend' : 'member';
      const vis = readVisibility(user);
      const can = (s: Section) => allowed(vis, s, relation);

      // everything else is started at the same moment, and only for sections this viewer may see; the slow, viewer-independent parts are cached for a minute
      const tzP = getUserTimezone(db, uid);
      const dayFns = tzP.then((tz) => ({ today: dayInTimezone(new Date(), tz), dayOffset: (n: number) => dayInTimezone(new Date(Date.now() - n * 86_400_000), tz) }));
      const pointsP = db.collection('userPoints').doc(uid).get();
      const streakP = db.collection('userPoints').doc(uid).collection('meta').doc('expenseStreak').get();
      const cosP = publicCosmetics(db, uid);

      const weekP = can('week') || can('recap')
        ? memo(`week:${uid}`, 60_000, async () => {
            const { dayOffset } = await dayFns;
            const expSnap = await db.collection('expenses').where('addedBy', '==', uid).select('date', 'category', 'type', 'isSettlement').get();
            const last7 = Array.from({ length: 7 }, (_, i) => dayOffset(6 - i));
            const prev7 = new Set(Array.from({ length: 7 }, (_, i) => dayOffset(13 - i)));
            const inWeek = new Set(last7);
            const days = new Set<string>();
            const cats: Record<string, number> = {};
            let count = 0;
            let prevCount = 0;
            expSnap.docs.forEach((d) => {
              const e = d.data();
              if (e.type === 'income' || e.isSettlement === true || typeof e.date !== 'string') return;
              if (inWeek.has(e.date)) { count += 1; days.add(e.date); cats[e.category] = (cats[e.category] || 0) + 1; }
              else if (prev7.has(e.date)) prevCount += 1;
            });
            return { last7: last7.map((d) => ({ date: d, logged: days.has(d) })), count, daysLogged: days.size, prevCount, top: Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null };
          })
        : Promise.resolve(null);

      const claimsP = can('recap') || can('journey')
        ? memo(`claims:${uid}`, 60_000, async () => {
            const snap = await db.collection('pointsLedger').where('uid', '==', uid).where('actionType', '==', 'quest_claim').select('createdAt').get();
            return snap.docs.map((d) => String(d.data().createdAt || ''));
          })
        : Promise.resolve(null);

      const friendsP = can('friends')
        ? memo(`friends:${uid}`, 60_000, async () => {
            const cards = await Promise.all(
              friendUids.slice(0, 12).map(async (u) => {
                const [us, st] = await Promise.all([db.collection('users').doc(u).get(), publicCosmetics(db, u).catch(() => null)]);
                const d = us.data() || {};
                return { uid: u, name: d.displayName || 'Someone', photoURL: d.photoURL || '', flame: st?.style.flame || 'classic' };
              }),
            );
            return { total: friendUids.length, people: cards };
          })
        : Promise.resolve(null);

      const gamesP = can('games') ? gameBoards(db).catch(() => new Map() as Boards) : Promise.resolve(null);

      const journeyP = can('journey')
        ? memo(`journey:${uid}`, 60_000, async () => {
            const [groups, pairs] = await Promise.all([
              db.collection('members').where('userId', '==', uid).count().get().catch(() => null),
              db.collection('friendStreaks').where('uids', 'array-contains', uid).get(),
            ]);
            return {
              groups: groups?.data().count || 0,
              friendStreaksRunning: pairs.docs.filter((d) => d.data().status === 'active').length,
              bestFriendStreak: pairs.docs.reduce((m, d) => Math.max(m, Number(d.data().longest) || 0, Number(d.data().current) || 0), 0),
            };
          })
        : Promise.resolve(null);

      const [{ today, dayOffset }, pointsSnap, streakSnap, cos, week, claims, friendList, boards, journey] = await Promise.all([dayFns, pointsP, streakP, cosP, weekP, claimsP, friendsP, gamesP, journeyP]);
      const points = pointsSnap.data() || {};
      const streak = streakSnap.data() || {};

      const result: Record<string, any> = {
        relation,
        visibleTo: vis.main,
        header: {
          uid,
          displayName: user.displayName || 'A FamilyLedger user',
          photoURL: user.photoURL || '',
          memberSince: typeof user.createdAt === 'string' ? user.createdAt.slice(0, 7) : null,
          friends: friendUids.length,
        },
        // which sections the viewer is allowed to see, so the screen can say "private" instead of a blank gap (names only, never contents)
        sections: SECTIONS.reduce((acc, sec) => ({ ...acc, [sec]: can(sec) }), {} as Record<string, boolean>),
        style: cos.style, // the flame they use and the badge icons they chose to show: part of the header, always allowed
      };
      if (relation === 'self') result.settings = vis;

      const alive = streak.lastDateStr === today || streak.lastDateStr === dayOffset(1);
      if (can('level')) result.level = { level: points.level || 1, xp: points.xp || 0 };
      if (can('streaks')) result.streaks = { current: alive ? Number(streak.current) || 0 : 0, longest: Number(streak.longest) || 0, games: points.gameStreaks || {} };
      if (can('birthday') && typeof user.dateOfBirth === 'string') {
        const [, m, d] = user.dateOfBirth.split('-');
        if (m && d) result.birthday = `${m}-${d}`; // month and day only, never the year
      }
      if (can('badges')) result.badges = cos.badges;
      if (can('flames')) result.flames = cos.flames;

      if (can('week') && week) result.week = { days: week.last7, expenses: week.count, daysLogged: week.daysLogged };
      if (can('recap') && week) {
        const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
        result.recap = {
          expenses: week.count,
          daysLogged: week.daysLogged,
          topCategory: week.top,
          vsLastWeek: week.count - week.prevCount,
          questsDone: (claims || []).filter((at) => at >= cutoff).length,
          streakKept: (Number(streak.current) || 0) > 0 && alive,
        };
      }
      if (can('friends') && friendList) result.friendList = friendList;

      if (can('games') && boards) {
        const friendScope = new Set<string>([uid, ...friendUids]);
        const games: { game: string; played: number; won: number; friends: { rank: number; of: number } | null; everyone: { rank: number; of: number } | null }[] = [];
        boards.forEach((board, game) => {
          const t = board.get(uid);
          if (!t || t.played === 0) return;
          games.push({ game, played: t.played, won: t.won, friends: rankIn(board, uid, friendScope), everyone: rankIn(board, uid, null) });
        });
        games.sort((a, b) => b.won - a.won || b.played - a.played);
        result.games = games;
      }

      if (can('journey') && journey) result.journey = { ...journey, questsDone: (claims || []).length };

      return res.json(result);
    } catch (err) {
      console.error('profile error:', err);
      return res.status(500).json({ error: 'Could not load this profile.' });
    }
  });

  // Save who can see what. Only the person themselves, and only known values.
  app.post('/api/profile/visibility', async (req, res) => {
    const decoded = await verifyAuth(req);
    const db = getDb();
    if (!decoded || !db) return res.status(401).json({ error: 'Unauthorized.' });
    const main = req.body?.main;
    const sections = req.body?.sections as Record<string, string> | undefined;
    const patch: Record<string, unknown> = {};
    if (main !== undefined) {
      if (!LEVELS.includes(main)) return res.status(400).json({ error: 'Choose Only me, Friends or Members.' });
      patch['profileVisibility.main'] = main;
    }
    if (sections) {
      for (const [k, v] of Object.entries(sections)) {
        if (!(SECTIONS as readonly string[]).includes(k) || !LEVELS.includes(v as Level)) return res.status(400).json({ error: 'Unknown section or choice.' });
        patch[`profileVisibility.sections.${k}`] = v;
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      await db.collection('users').doc(decoded.uid).update(patch);
      return res.json({ ok: true });
    } catch (err) {
      console.error('profile visibility error:', err);
      return res.status(500).json({ error: 'Could not save your choice.' });
    }
  });
}
