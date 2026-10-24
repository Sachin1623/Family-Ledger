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
let boardCache: { at: number; boards: Map<string, Map<string, Tally>> } | null = null;

// Every finished game ever played (the permanent gameOutcomes record, which survives players deleting a game), tallied per game and per person. Cached
// for ten minutes: a rank that is a few minutes old is fine, and it keeps a profile view from reading every game each time.
async function gameBoards(db: Firestore): Promise<Map<string, Map<string, Tally>>> {
  if (boardCache && Date.now() - boardCache.at < 10 * 60_000) return boardCache.boards;
  const snap = await db.collection('gameOutcomes').select('gameType', 'playerUids', 'winnerUid', 'winningTeam', 'winnerTeam', 'players').get();
  const boards = new Map<string, Map<string, Tally>>();
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
  boardCache = { at: Date.now(), boards };
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
      const userSnap = await db.collection('users').doc(uid).get();
      if (!userSnap.exists) return res.status(404).json({ error: 'This profile is not available.' });
      const user = userSnap.data() || {};
      if (viewer !== uid && Array.isArray(user.blockedUsers) && user.blockedUsers.includes(viewer)) return res.status(404).json({ error: 'This profile is not available.' });

      const friendUids = await friendUidsOf(db, uid);
      const relation: Relation = viewer === uid ? 'self' : friendUids.includes(viewer) ? 'friend' : 'member';
      const vis = readVisibility(user);
      const can = (s: Section) => allowed(vis, s, relation);

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
        sections: SECTIONS.reduce((acc, s) => ({ ...acc, [s]: can(s) }), {} as Record<string, boolean>),
      };
      if (relation === 'self') result.settings = vis;

      const tz = await getUserTimezone(db, uid);
      const today = dayInTimezone(new Date(), tz);
      const dayOffset = (n: number) => dayInTimezone(new Date(Date.now() - n * 86_400_000), tz);

      const [pointsSnap, streakSnap] = await Promise.all([
        db.collection('userPoints').doc(uid).get(),
        db.collection('userPoints').doc(uid).collection('meta').doc('expenseStreak').get(),
      ]);
      const points = pointsSnap.data() || {};
      const streak = streakSnap.data() || {};

      if (can('level')) result.level = { level: points.level || 1, xp: points.xp || 0 };
      if (can('streaks')) {
        const alive = streak.lastDateStr === today || streak.lastDateStr === dayOffset(1);
        result.streaks = { current: alive ? Number(streak.current) || 0 : 0, longest: Number(streak.longest) || 0, games: points.gameStreaks || {} };
      }
      if (can('birthday') && typeof user.dateOfBirth === 'string') {
        const [, m, d] = user.dateOfBirth.split('-');
        if (m && d) result.birthday = `${m}-${d}`; // month and day only, never the year
      }

      // badges and flames come from the person's own style record (cosmetics.ts)
      if (can('badges') || can('flames')) {
        const cos = await publicCosmetics(db, uid);
        if (can('badges')) result.badges = cos.badges;
        if (can('flames')) result.flames = cos.flames;
        result.style = cos.style; // the flame they use and the badge icons they chose to show: part of the header, always allowed
      } else {
        const cos = await publicCosmetics(db, uid);
        result.style = cos.style;
      }

      // this week and the weekly recap: counts and category names only, from the person's own entries
      if (can('week') || can('recap')) {
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
        const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        if (can('week')) result.week = { days: last7.map((d) => ({ date: d, logged: days.has(d) })), expenses: count, daysLogged: days.size };
        if (can('recap')) {
          const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
          const claims = await db.collection('pointsLedger').where('uid', '==', uid).where('actionType', '==', 'quest_claim').select('createdAt').get();
          result.recap = {
            expenses: count,
            daysLogged: days.size,
            topCategory: top,
            vsLastWeek: count - prevCount,
            questsDone: claims.docs.filter((d) => String(d.data().createdAt || '') >= cutoff).length,
            streakKept: (Number(streak.current) || 0) > 0 && (streak.lastDateStr === today || streak.lastDateStr === dayOffset(1)),
          };
        }
      }

      // the person's friends: photo, name and the flame they use. Friends only by default, because it shows other people.
      if (can('friends')) {
        const shownUids = friendUids.slice(0, 12);
        const cards = await Promise.all(
          shownUids.map(async (u) => {
            const [us, st] = await Promise.all([db.collection('users').doc(u).get(), publicCosmetics(db, u).catch(() => null)]);
            const d = us.data() || {};
            return { uid: u, name: d.displayName || 'Someone', photoURL: d.photoURL || '', flame: st?.style.flame || 'classic' };
          }),
        );
        result.friendList = { total: friendUids.length, people: cards };
      }

      if (can('games')) {
        const boards = await gameBoards(db);
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

      if (can('journey')) {
        const [groups, pairs, quests] = await Promise.all([
          db.collection('members').where('userId', '==', uid).count().get().catch(() => null),
          db.collection('friendStreaks').where('uids', 'array-contains', uid).get(),
          db.collection('pointsLedger').where('uid', '==', uid).where('actionType', '==', 'quest_claim').count().get().catch(() => null),
        ]);
        const running = pairs.docs.filter((d) => d.data().status === 'active');
        result.journey = {
          groups: groups?.data().count || 0,
          questsDone: quests?.data().count || 0,
          friendStreaksRunning: running.length,
          bestFriendStreak: pairs.docs.reduce((m, d) => Math.max(m, Number(d.data().longest) || 0, Number(d.data().current) || 0), 0),
        };
      }

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
