import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import admin from "firebase-admin";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { BigQuery } from "@google-cloud/bigquery";
import allEnglishWords from "an-array-of-english-words";
import { Filter as BadWordsFilter } from "bad-words";
import { getWordsList as getMostCommonWordsList } from "most-common-words-by-language";

dotenv.config();

const otpStore = new Map<string, { codeHash: string; expiresAt: number }>();
const resetTokenStore = new Map<string, { token: string; expiresAt: number }>();

// --- Scramble dictionary (multiplayer answer validation + hints) ---
// Built once at process startup — cheap (a single pass over ~275k words). Filtering matches
// scripts/generateScrambleWords.cjs (the client's smaller bundled offline dictionary): alphabetic-
// only, lengths 4-10, minus a profanity blocklist. Must stay a superset of whatever the client
// might submit, so nothing a legitimate offline single-player answer accepts gets rejected here —
// bump SCRAMBLE_DICTIONARY_VERSION (src/lib/scramble.ts's constant, kept in sync manually) if this
// filtering ever changes.
const SCRAMBLE_MIN_LEN = 4;
const SCRAMBLE_MAX_LEN = 10;
const scrambleAllWords = new Set<string>();
// A round's TARGET word (the one scrambled into tiles) is picked from this much smaller,
// frequency-curated pool, NOT the full validation set above — that set is broad on purpose so an
// unusual-but-real word someone actually finds isn't rejected, but is a bad source for what to
// make someone SOLVE (too many obscure/archaic words). Intersected with scrambleAllWords so a
// picked target is always itself guaranteed to be a valid, acceptable answer.
const scrambleTargetWordsByLength: Record<number, string[]> = {};
{
  const banned = new Set(new BadWordsFilter().list.map((w: string) => w.toLowerCase()));
  const fullDictSet = new Set((allEnglishWords as string[]).map((w) => w.toLowerCase()));
  for (const raw of allEnglishWords as string[]) {
    const w = raw.toLowerCase();
    if (!/^[a-z]+$/.test(w)) continue;
    if (w.length < SCRAMBLE_MIN_LEN || w.length > SCRAMBLE_MAX_LEN) continue;
    if (banned.has(w)) continue;
    scrambleAllWords.add(w);
  }
  // Every common word regardless of length (e.g. "met", only 3 letters) — kept separately so a
  // plural's shorter singular is still recognized below even if the singular is itself too short
  // to ever be a target word on its own.
  const commonWordSet = new Set<string>();
  for (const raw of getMostCommonWordsList('english') as string[]) {
    const w = raw.toLowerCase();
    if (!/^[a-z]+$/.test(w)) continue;
    if (banned.has(w)) continue;
    if (!fullDictSet.has(w)) continue; // drops internet jargon/proper nouns the frequency list includes
    commonWordSet.add(w);
  }
  // Drop simple regular plurals ("+s"/"+es") of another common word — e.g. "balls" once "ball" is
  // common, "mets" once "met" is — so target selection doesn't burn variety on trivial
  // base+plural pairs. Doesn't touch scrambleAllWords (answer validation) — a plural is still a
  // perfectly good answer, it just won't be chosen as what a round makes someone solve.
  const isRegularPluralOfCommon = (word: string): boolean => {
    if (word.endsWith('es') && commonWordSet.has(word.slice(0, -2))) return true;
    if (word.endsWith('s') && commonWordSet.has(word.slice(0, -1))) return true;
    return false;
  };
  for (const w of commonWordSet) {
    if (w.length < SCRAMBLE_MIN_LEN || w.length > SCRAMBLE_MAX_LEN) continue;
    if (isRegularPluralOfCommon(w)) continue;
    (scrambleTargetWordsByLength[w.length] ||= []).push(w);
  }
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

const smtpHost = process.env.SMTP_HOST;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const smtpSecure = process.env.SMTP_SECURE === 'true';
const emailFrom = process.env.EMAIL_FROM || smtpUser || 'noreply@familyledger.app';
// Origin used to build join links in invite emails. This is the same origin the app's WebView
// loads from (capacitor.config.ts server.url), so the link works identically whether opened on
// web, Android, or iOS.
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://familyledger.thirteenapps.com';
const debugOtpDelivery =
  process.env.NODE_ENV !== 'production' ||
  process.env.DEV_SHOW_OTP === 'true';

let transporter: nodemailer.Transporter | null = null;
if (smtpHost && smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
}

const verifySmtpConnection = async () => {
  if (!transporter) {
    console.warn('SMTP is not configured. OTP emails cannot be sent.');
    return;
  }

  try {
    await transporter.verify();
    console.log('SMTP transporter verified successfully.');
  } catch (err) {
    console.error('SMTP verification failed:', err);
  }
};

let currentFilename = "";
let currentDirname = "";

try {
  currentFilename = __filename;
  currentDirname = __dirname;
} catch (e) {
  currentFilename = fileURLToPath(import.meta.url);
  currentDirname = path.dirname(currentFilename);
}

let adminAuth: admin.auth.Auth | null = null;
let adminDb: Firestore | null = null;
try {
  const firebaseConfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf-8"),
  );
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: firebaseConfig.projectId });
  }
  adminAuth = admin.auth();
  adminDb = getFirestore(admin.app(), firebaseConfig.firestoreDatabaseId);
} catch (err) {
  console.warn(
    "Firebase Admin SDK not initialized; existing-account check on OTP signup will be skipped:",
    err,
  );
}

// Returns true if an account already exists for this email, false if not,
// and null if the check itself couldn't be performed (e.g. no admin credentials).
async function emailHasExistingAccount(email: string): Promise<boolean | null> {
  if (!adminAuth) return null;
  try {
    await adminAuth.getUserByEmail(email);
    return true;
  } catch (err: any) {
    if (err?.code === "auth/user-not-found") return false;
    console.error("Admin getUserByEmail error:", err);
    return null;
  }
}

// Verifies the caller's Firebase ID token from the Authorization header.
// Returns the decoded token (with uid, email, email_verified, firebase.sign_in_provider)
// or null if missing/invalid.
// Per-instance, in-memory throttle for the lastActiveAt touch below — deliberately NOT a
// Firestore read-before-write (that would double this function's read cost on literally every
// authenticated request in the app). Not perfectly consistent across Cloud Run instances/restarts,
// but it only needs to be an approximate rate-limiter, not a correctness-critical cache.
const lastActiveWriteCache = new Map<string, number>();
const LAST_ACTIVE_WRITE_INTERVAL_MS = 5 * 60 * 1000;

async function verifyAuthHeader(req: express.Request): Promise<admin.auth.DecodedIdToken | null> {
  if (!adminAuth) return null;
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(match[1]);
    // Touches lastActiveAt for ANY authenticated server interaction — not just AuthContext.tsx's
    // client-side foreground-visibility heartbeat, which only reflects whether the app's UI is
    // literally the visible tab/screen right now. This catches genuine activity that heartbeat
    // misses: accepting a recurring-expense confirmation from a notification, playing a turn,
    // anything hitting the API while the app happens to be backgrounded or the heartbeat hasn't
    // ticked yet. Fire-and-forget + throttled (see lastActiveWriteCache above) so this doesn't add
    // a write to every single API call.
    if (adminDb) {
      const now = Date.now();
      const lastWrite = lastActiveWriteCache.get(decoded.uid) || 0;
      if (now - lastWrite >= LAST_ACTIVE_WRITE_INTERVAL_MS) {
        lastActiveWriteCache.set(decoded.uid, now);
        adminDb
          .collection('users')
          .doc(decoded.uid)
          .set({ lastActiveAt: new Date().toISOString() }, { merge: true })
          .catch((err) => console.error('lastActiveAt touch failed:', err));
      }
    }
    return decoded;
  } catch (err) {
    console.error("verifyIdToken failed:", err);
    return null;
  }
}

// Primary admins mirror firestore.rules' isSachin() — same trusted identity, full access.
// sachin.rajputs@gmail.com is the sole primary admin (2026-08-20) — any other admin account
// should go through the Manage Admins screen (`admins` collection, see /api/admin/manage-admin)
// so it's visible/revocable there instead of silently hardcoded. This UID is project-specific
// (Firebase Auth UIDs don't carry over on a project migration — see the familyledgerta migration
// notes) — verified current via admin.auth().getUserByEmail() against the live familyledgerta
// project. The previous hardcoded value was a stale leftover from the old pre-migration project
// and matched no real account, which silently broke getAllAdminUids()-based notification fan-out
// (push + Feed) below, even though the email-fallback checks (isPrimaryAdmin, isSachin() in
// firestore.rules) kept admin panel access itself working the whole time.
const PRIMARY_ADMIN_UIDS = ["iTxTkTsrwONnm6mVvwe43cZeX8i1"];
const PRIMARY_ADMIN_EMAILS = ["sachin.rajputs@gmail.com"];
// Only this exact email may grant/revoke secondary admins.
const SUPER_ADMIN_EMAIL = "sachin.rajputs@gmail.com";

function isPrimaryAdmin(decoded: admin.auth.DecodedIdToken): boolean {
  return (
    PRIMARY_ADMIN_UIDS.includes(decoded.uid) ||
    PRIMARY_ADMIN_EMAILS.includes(normalizeEmail(decoded.email || ""))
  );
}

function isSuperAdmin(decoded: admin.auth.DecodedIdToken): boolean {
  return normalizeEmail(decoded.email || "") === SUPER_ADMIN_EMAIL;
}

async function isAnyAdmin(db: Firestore, decoded: admin.auth.DecodedIdToken): Promise<boolean> {
  if (isPrimaryAdmin(decoded)) return true;
  const doc = await db.collection("admins").doc(decoded.uid).get();
  return doc.exists;
}

// All admin UIDs (primary + secondary) — used to fan out feedback/suggestion notifications.
async function getAllAdminUids(db: Firestore): Promise<string[]> {
  const adminsSnap = await db.collection("admins").get();
  return Array.from(new Set([...PRIMARY_ADMIN_UIDS, ...adminsSnap.docs.map((d) => d.id)]));
}

// Verifies the caller is signed in AND is (primary or secondary) admin. On failure, writes
// the response itself (401/403) and returns null so callers can just `if (!decoded) return;`.
async function requireAdmin(
  req: express.Request,
  res: express.Response,
): Promise<admin.auth.DecodedIdToken | null> {
  const decoded = await verifyAuthHeader(req);
  if (!decoded || !adminDb) {
    res.status(401).json({ error: "Unauthorized." });
    return null;
  }
  if (!(await isAnyAdmin(adminDb, decoded))) {
    res.status(403).json({ error: "Forbidden." });
    return null;
  }
  return decoded;
}

// Commits Firestore writes in chunks of <=450 to stay under the 500-operation batch limit.
async function commitInChunks(db: Firestore, ops: Array<(batch: FirebaseFirestore.WriteBatch) => void>) {
  const CHUNK_SIZE = 450;
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    ops.slice(i, i + CHUNK_SIZE).forEach((op) => op(batch));
    await batch.commit();
  }
}

// Migrates all group memberships, group ownership, expenses (addedBy/paidBy/splitInfo),
// and activities from oldUid to newUid, then removes the old profile. Used both when a
// duplicate account exists for the same verified email (e.g. Google vs email/password
// created separate Firebase Auth users) and when a user re-registers after deleting their
// account within the last 30 days (matching the retention window promised in the privacy
// policy / data-deletion page).
async function mergeUidData(
  db: Firestore,
  oldUid: string,
  newUid: string,
  newProfile: { displayName?: string; photoURL?: string },
) {
  const summary = { groupsUpdated: 0, membershipsMigrated: 0, expensesUpdated: 0, activitiesUpdated: 0 };

  // 1. Group memberships: recreate under newUid, delete the old doc.
  const membersSnap = await db.collection("members").where("userId", "==", oldUid).get();
  const groupIds = new Set<string>();
  const memberOps: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  membersSnap.docs.forEach((docSnap) => {
    const data = docSnap.data();
    groupIds.add(data.groupId);
    const newRef = db.collection("members").doc(`${newUid}_${data.groupId}`);
    memberOps.push((batch) =>
      batch.set(newRef, {
        ...data,
        userId: newUid,
        displayName: newProfile.displayName || data.displayName,
        photoURL: newProfile.photoURL ?? data.photoURL,
      }),
    );
    memberOps.push((batch) => batch.delete(docSnap.ref));
  });
  await commitInChunks(db, memberOps);
  summary.membershipsMigrated = membersSnap.size;

  // 2. Groups the old uid created (ownership).
  const ownedGroupsSnap = await db.collection("groups").where("createdBy", "==", oldUid).get();
  const groupOps: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  ownedGroupsSnap.docs.forEach((docSnap) => {
    groupIds.add(docSnap.id);
    groupOps.push((batch) => batch.update(docSnap.ref, { createdBy: newUid }));
  });
  await commitInChunks(db, groupOps);
  summary.groupsUpdated = ownedGroupsSnap.size;

  // 3. Expenses added by or paid by the old uid.
  const expenseDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  const [addedBySnap, paidBySnap] = await Promise.all([
    db.collection("expenses").where("addedBy", "==", oldUid).get(),
    db.collection("expenses").where("paidBy", "==", oldUid).get(),
  ]);
  [...addedBySnap.docs, ...paidBySnap.docs].forEach((d) => {
    expenseDocs.set(d.id, d);
    groupIds.add(d.data().groupId);
  });

  // 4. Also scan every expense in the affected groups for splitInfo.splits entries
  //    referencing the old uid (covers expenses added by other group members that split
  //    a cost with this user).
  const groupIdList = Array.from(groupIds);
  for (let i = 0; i < groupIdList.length; i += 30) {
    const chunk = groupIdList.slice(i, i + 30);
    if (chunk.length === 0) continue;
    const snap = await db.collection("expenses").where("groupId", "in", chunk).get();
    snap.docs.forEach((d) => expenseDocs.set(d.id, d));
  }

  const expenseOps: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  expenseDocs.forEach((docSnap) => {
    const data = docSnap.data();
    const update: Record<string, any> = {};
    if (data.addedBy === oldUid) update.addedBy = newUid;
    if (data.paidBy === oldUid) update.paidBy = newUid;
    if (data.splitInfo?.splits?.some((s: any) => s.userId === oldUid)) {
      update.splitInfo = {
        ...data.splitInfo,
        splits: data.splitInfo.splits.map((s: any) => (s.userId === oldUid ? { ...s, userId: newUid } : s)),
      };
    }
    if (Object.keys(update).length > 0) {
      expenseOps.push((batch) => batch.update(docSnap.ref, update));
    }
  });
  await commitInChunks(db, expenseOps);
  summary.expensesUpdated = expenseOps.length;

  // 5. Activities logged by the old uid (cosmetic — keeps the activity feed attributed correctly).
  const activitiesSnap = await db.collection("activities").where("userId", "==", oldUid).get();
  const activityOps: Array<(batch: FirebaseFirestore.WriteBatch) => void> = activitiesSnap.docs.map(
    (docSnap) => (batch) => batch.update(docSnap.ref, { userId: newUid }),
  );
  await commitInChunks(db, activityOps);
  summary.activitiesUpdated = activitiesSnap.size;

  // 6. Clean up the orphaned old profile + deletion tombstone.
  const cleanupOps: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [
    (batch) => batch.delete(db.collection("users").doc(oldUid).collection("private").doc("info")),
    (batch) => batch.delete(db.collection("users").doc(oldUid)),
    (batch) => batch.delete(db.collection("accountDeletions").doc(oldUid)),
  ];
  await commitInChunks(db, cleanupOps);

  return summary;
}

// Fetches FCM tokens for a set of users, skipping anyone who has disabled the given
// preference field (default: enabled, matching the app's "on by default" notification design).
async function collectPushTokens(db: Firestore, uids: string[], prefField: string): Promise<string[]> {
  const tokens: string[] = [];
  const snaps = await Promise.all(
    uids.map((uid) => db.collection('users').doc(uid).collection('private').doc('info').get()),
  );
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const data = snap.data()!;
    if (data[prefField] === false) return;
    if (Array.isArray(data.fcmTokens)) tokens.push(...data.fcmTokens);
  });
  return Array.from(new Set(tokens));
}

// Sends a push notification to a list of device tokens, pruning any that FCM reports as
// invalid/unregistered so they don't keep failing on future sends. Returns the number of
// tokens the message was actually delivered to.
async function sendPush(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<number> {
  if (tokens.length === 0 || !adminDb) return 0;
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
    });

    const staleTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === 'messaging/registration-token-not-registered' || r.error?.code === 'messaging/invalid-argument')) {
        staleTokens.push(tokens[i]);
      }
    });
    if (staleTokens.length > 0) {
      pruneStaleTokens(adminDb, staleTokens).catch((err) => console.error('pruneStaleTokens failed:', err));
    }

    return response.successCount;
  } catch (error) {
    console.error('sendPush error:', error);
    return 0;
  }
}

// Shared "it's your turn" notifier for every server-mediated multiplayer game (Rummy, Sweep,
// Sequence) plus a generic endpoint below for the client-authoritative ones (Business, Chess) —
// generalizes the exact three-way logic /api/notify-ludo-turn pioneered (on-screen: nothing, since
// the live listener already shows it; foregrounded elsewhere: a lightweight in-app indicator;
// backgrounded/closed: a real push) without duplicating it per game. Deliberately left Ludo on its
// own bespoke `activeLudoGameId`/`ludoTurnIndicator` fields rather than migrating it here — it
// already works, and this is purely additive. `opponentNames` is passed in by the caller (who
// already has the game's players in scope) rather than re-fetched here, so this never needs to
// know each game's player-array shape.
const GAME_TURN_META: Record<string, { label: string; routeBase: string; pushType: string }> = {
  rummy: { label: '27-Hand Rummy', routeBase: '/games/rummy', pushType: 'rummy_turn' },
  sweep: { label: 'Sweep', routeBase: '/games/sweep', pushType: 'sweep_turn' },
  sequence: { label: 'Sequence', routeBase: '/games/sequence', pushType: 'sequence_turn' },
  business: { label: 'Business', routeBase: '/games/business', pushType: 'business_turn' },
  chess: { label: 'Chess', routeBase: '/games/chess', pushType: 'chess_turn' },
};

async function notifyGameTurn(
  db: Firestore,
  params: { gameType: string; gameId: string; nextPlayerUid: string; movedByUid: string; opponentNames: string | null },
): Promise<{ sent: number; indicator: boolean }> {
  const meta = GAME_TURN_META[params.gameType];
  if (!meta || params.nextPlayerUid === params.movedByUid) return { sent: 0, indicator: false };

  const userSnap = await db.collection('users').doc(params.nextPlayerUid).get();
  const userData = userSnap.data() || {};

  if (userData.activeGameRef?.gameType === params.gameType && userData.activeGameRef?.gameId === params.gameId) {
    return { sent: 0, indicator: false };
  }

  const FOREGROUND_WINDOW_MS = 45000; // covers AuthContext's 25s heartbeat interval plus latency
  const foregroundedRecently =
    userData.appForegroundAt && Date.now() - new Date(userData.appForegroundAt).getTime() < FOREGROUND_WINDOW_MS;

  if (foregroundedRecently) {
    await db.collection('users').doc(params.nextPlayerUid).set(
      {
        gameTurnIndicator: {
          gameType: params.gameType,
          gameId: params.gameId,
          gameLabel: meta.label,
          route: `${meta.routeBase}/${params.gameId}`,
          opponentNames: params.opponentNames || null,
          updatedAt: new Date().toISOString(),
        },
      },
      { merge: true },
    );
    return { sent: 0, indicator: true };
  }

  const tokens = await collectPushTokens(db, [params.nextPlayerUid], 'notificationsEnabled');
  const body = params.opponentNames ? `It's your move against ${params.opponentNames}!` : "It's your move!";
  const sent = await sendPush(tokens, meta.label, body, { type: meta.pushType, gameId: params.gameId });
  return { sent, indicator: false };
}

// Writes a lightweight `inviteNotices` doc alongside the push notification for a group/game
// invite (or, for `type: 'chat'`, a new chat message), so a client that's already OPEN can show
// an in-app drop-down banner the instant it arrives (a push notification's foreground-delivery
// behavior is inconsistent across platforms, and this doesn't need any of that machinery — it's
// just another Firestore listener, same pattern as the chat/reaction "something new" indicators).
// `photoURL` is only meaningful for `type: 'chat'` (the sender's avatar, so the banner can show a
// real profile picture instead of a generic icon) — see InviteBanner.tsx. Firestore rules restrict
// reads to `toUid == request.auth.uid`, so this never leaks who else got invited/messaged.
async function createInviteNotice(
  db: Firestore,
  toUid: string,
  type: 'group' | 'game' | 'chat' | 'friend',
  title: string,
  body: string,
  to: string,
  photoURL?: string,
): Promise<void> {
  try {
    await db.collection('inviteNotices').add({
      toUid, type, title, body, to, photoURL: photoURL || null, createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('createInviteNotice error:', error);
  }
}

// Writes a durable Activity Feed entry (`activities`, the same collection/screen ActivityFeed.tsx
// already renders) alongside a push notification, so dismissing or missing the push doesn't lose
// the notification entirely — it's still sitting in the Feed to scroll back to. Two shapes, same
// as every existing hand-written `activities` write in this file:
//   - groupId set: ONE doc reaches every member of that group via the existing groupId list rule
//     (`userId`/`userName`/`userPhoto` describe who CAUSED it, exactly like add_expense already
//     does — the doc isn't duplicated per recipient).
//   - groupId omitted: `userId` IS the recipient instead (matches the existing `invite_received`
//     convention), a private entry only that one person can read.
// Fire-and-forget — never blocks or fails the push it's paired with.
async function logFeedActivity(
  db: Firestore,
  opts: {
    userId: string;
    type: string;
    description: string;
    userName?: string;
    userPhoto?: string;
    groupId?: string;
    data?: Record<string, any>;
  },
): Promise<void> {
  try {
    await db.collection('activities').add({
      userId: opts.userId,
      userName: opts.userName || 'FamilyLedger',
      userPhoto: opts.userPhoto || '',
      type: opts.type,
      description: opts.description,
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      // Marks "userId IS the recipient" (personal, no group to fan out through) vs. "userId is
      // the actor" (group-scoped, visible to every member) — Header.tsx's unread-badge count
      // needs this distinction because it otherwise can't tell, from a personal-query result
      // alone, "a notification for me" apart from "my own group action that also happens to
      // list me as userId" (those get their self-exclusion via the separate groupId-based query
      // instead, so counting them again here would double-count AND wrongly never-exclude them).
      personal: !opts.groupId,
      data: opts.data || {},
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('logFeedActivity error:', error);
  }
}

// ============================================================================
// --- Gamification: points engine (Phase 1) ---
// Dual currency: `xp` (permanent, drives level, never spent) + `coins` (spendable, later phases'
// shop). Every award is idempotent — see awardPointsInTx below — so re-toggling a to-do, editing
// an already-logged expense, or a retried/double-tapped claim can never double-award. Aura
// (badges-on-avatars, public profile, live milestone banners), the Shop, and leaderboards are
// explicitly later phases; this is just the scoring engine + a personal progress view.
// ============================================================================

// Fixed at (a few days before) the moment this feature shipped — NOT `new Date()` at module load,
// which would reset on every server restart/redeploy and reopen the "claim points for
// pre-existing data" window every time. Every verifier that checks a `createdAt`-style field
// compares against this. Deliberately padded several days earlier than the actual ship date
// rather than pinned to midnight UTC on that exact day — a hard UTC-midnight cutoff meant anyone
// testing in a positive-UTC-offset timezone (IST, say) during the first few hours after a
// same-day deploy could have a `createdAt` that's still "yesterday" in UTC, and get silently
// rejected as "predates launch" for an expense they'd just that moment logged. The real purpose
// here is blocking bulk-claiming of months/years-old historical data, which a few days of slack
// doesn't meaningfully weaken.
const POINTS_LAUNCH_AT = '2026-08-18T00:00:00.000Z';

// Cumulative XP required to REACH a given level: 25 * level * (level - 1) — i.e. the gap between
// consecutive levels grows by a flat 50 XP each time (50, 100, 150, 200, ...), so level 2 needs
// 50 XP, level 3 needs 150, level 16 needs 6000, level 30 needs 21750, and so on with no ceiling.
// A closed-form formula rather than a fixed lookup table specifically so leveling never plateaus —
// an early version of this used a 16-entry table that silently stopped awarding new levels past
// 6000 XP, which is exactly the kind of cap a points system should never have.
function xpForLevel(level: number): number {
  return 25 * level * (level - 1);
}
function levelForXp(xp: number): number {
  if (xp <= 0) return 1;
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + xp / 6.25)) / 2));
}

interface PointsAward {
  actionType: string;
  ledgerKey: string; // becomes the pointsLedger doc ID — the idempotency key
  xp: number;
  coins: number;
  sourceCollection?: string;
  sourceDocId?: string;
  meta?: Record<string, any>;
}

// The one place points are ever actually written. MUST be called with a transaction already in
// flight (either the claim endpoint's own, or — for games/friends/recurring-confirm, which are
// already server-mediated — the SAME transaction that performs the underlying action, so a
// finished game/accepted friendship can never exist without its points already applied).
//
// Firestore transactions require EVERY read across the WHOLE transaction to happen before ANY
// write — not per-document, per-call-site — so this is deliberately split into a read phase
// (`readAwardPlan`) and a write phase (`writeAwardPlan`) rather than one function that reads then
// writes. A single `await awardMultipleInTx(...)` call is safe on its own (its own reads finish
// before its own writes start), but calling it more than once inside the same transaction is NOT
// — the second call's reads land after the first call's writes and Firestore throws. Multi-uid
// call sites must batch: read every plan first, then write every plan, never interleave
// read-then-write per uid in a loop (see `readGamePointsPlan`/`writeGamePointsPlan` below, the
// game-specific counterpart of this same split, used by Rummy/Sweep/Sequence).
//
// Each plan also writes `userPoints/{uid}` at most ONCE, deliberately — Firestore transactions
// apply multiple writes to the same document as independent operations in call order, not merged
// together, so two separate `tx.set(userPointsRef, {...}, {merge:true})` calls in one transaction
// (e.g. a "logged an expense" award immediately followed by a "7-day streak" bonus award, both
// crediting the same doc) risk the second silently clobbering the first's increments instead of
// composing with them. Collecting every award for a given uid into one list and summing before
// the single `tx.set` sidesteps that entirely, rather than relying on same-document multi-write
// semantics being safe.
interface AwardReadState {
  uid: string;
  userPointsRef: FirebaseFirestore.DocumentReference;
  userPointsData: Record<string, any>;
  ledgerRefs: FirebaseFirestore.DocumentReference[];
  ledgerExists: boolean[];
  awards: PointsAward[];
  extraUserPointsFields?: Record<string, any>;
}

async function readAwardPlan(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  uid: string,
  awards: PointsAward[],
  extraUserPointsFields?: Record<string, any>,
): Promise<AwardReadState> {
  const userPointsRef = db.collection('userPoints').doc(uid);
  const ledgerRefs = awards.map((award) => db.collection('pointsLedger').doc(award.ledgerKey));
  const [userPointsSnap, ledgerSnaps] = await Promise.all([
    tx.get(userPointsRef),
    Promise.all(ledgerRefs.map((ref) => tx.get(ref))),
  ]);
  return {
    uid, userPointsRef, userPointsData: userPointsSnap.data() || {},
    ledgerRefs, ledgerExists: ledgerSnaps.map((snap) => snap.exists),
    awards, extraUserPointsFields,
  };
}

function writeAwardPlan(tx: FirebaseFirestore.Transaction, state: AwardReadState): boolean {
  let runningXp = state.userPointsData.xp || 0;
  let totalXp = 0;
  let totalCoins = 0;
  let anyAwarded = false;

  state.awards.forEach((award, i) => {
    if (state.ledgerExists[i]) return; // already awarded — safe no-op for this one entry
    tx.set(state.ledgerRefs[i], {
      uid: state.uid, actionType: award.actionType, xp: award.xp, coins: award.coins,
      sourceCollection: award.sourceCollection || null, sourceDocId: award.sourceDocId || null,
      meta: award.meta || {}, createdAt: new Date().toISOString(),
    });
    totalXp += award.xp;
    totalCoins += award.coins;
    runningXp += award.xp;
    anyAwarded = true;
  });

  if (anyAwarded || state.extraUserPointsFields) {
    tx.set(state.userPointsRef, {
      ...(totalXp ? { xp: admin.firestore.FieldValue.increment(totalXp) } : {}),
      ...(totalCoins ? { coins: admin.firestore.FieldValue.increment(totalCoins) } : {}),
      ...(totalXp ? { level: levelForXp(runningXp) } : {}),
      updatedAt: new Date().toISOString(),
      ...(state.extraUserPointsFields || {}),
    }, { merge: true });
  }
  return anyAwarded;
}

// Convenience wrapper for the common case of a single uid's awards with nothing else to batch
// into the same transaction — reads then writes in one call, safe as long as it's the only such
// call in the transaction (see the doc comment above).
async function awardMultipleInTx(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  uid: string,
  awards: PointsAward[],
  extraUserPointsFields?: Record<string, any>,
): Promise<boolean> {
  const state = await readAwardPlan(tx, db, uid, awards, extraUserPointsFields);
  return writeAwardPlan(tx, state);
}

// Single-award convenience wrapper — most call sites only ever have one award to grant at a time.
async function awardPointsInTx(
  tx: FirebaseFirestore.Transaction, db: Firestore, uid: string, award: PointsAward,
): Promise<boolean> {
  return awardMultipleInTx(tx, db, uid, [award]);
}

function isoDateStr(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD, UTC calendar day — a Phase 1 simplification (no per-user timezone field exists to do better)
}
function daysBetween(aDateStr: string, bDateStr: string): number {
  const a = new Date(aDateStr + 'T00:00:00Z').getTime();
  const b = new Date(bDateStr + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

// Shared by the expense-logging streak and each habit's own streak (a subdoc keyed by todoId) —
// both are "consecutive distinct calendar days this got claimed". Deliberately READ-ONLY — no
// `tx.set()` calls at all — because the caller still has more reads to do afterward (the main
// award's `readAwardPlan`), and Firestore requires every read in a transaction to happen before
// any write. Returns the computed new streak state and any streak-bonus PointsAwards, and the
// badge-grant decision (if applicable); the caller writes the streak doc, folds the bonus awards
// into the SAME `writeAwardPlan` as the main action's award (see the same-document-multi-write
// note on that function), and writes the badge doc — all AFTER every read is done. Advanced only
// as a side effect of an already-verified award, so a streak can never be claimed for a day
// nothing real happened.
interface StreakComputation {
  streakRef: FirebaseFirestore.DocumentReference;
  newStreakState: { current: number; longest: number; lastDateStr: string };
  bonuses: PointsAward[];
  badgeRef?: FirebaseFirestore.DocumentReference;
  badgeAlreadyExists: boolean;
}

async function computeStreakBonusAwards(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  uid: string,
  streakRef: FirebaseFirestore.DocumentReference,
  todayStr: string,
  bonusActionType: string,
  bonusLedgerKeyPrefix: string,
  bonusXpAt7: number,
  bonusXpAt30?: number,
  badgeIdPrefix?: string,
): Promise<StreakComputation | null> {
  const snap = await tx.get(streakRef);
  const data = snap.data() || {};
  let current: number = data.current || 0;
  const longest: number = data.longest || 0;
  const lastDateStr: string | null = data.lastDateStr || null;

  if (lastDateStr === todayStr) return null; // already advanced today — nothing to compute or write
  if (lastDateStr && daysBetween(lastDateStr, todayStr) === 1) current += 1;
  else current = 1;

  const bonuses: PointsAward[] = [];
  if (current > 0 && current % 7 === 0) {
    bonuses.push({
      actionType: bonusActionType, ledgerKey: `${bonusLedgerKeyPrefix}_${todayStr}`,
      xp: bonusXpAt7, coins: bonusXpAt7, meta: { streakDays: current },
    });
  }

  let badgeRef: FirebaseFirestore.DocumentReference | undefined;
  let badgeAlreadyExists = false;
  if (bonusXpAt30 && current === 30 && badgeIdPrefix) {
    bonuses.push({
      actionType: `${bonusActionType}_30`, ledgerKey: `${bonusLedgerKeyPrefix}_30_${todayStr}`,
      xp: bonusXpAt30, coins: bonusXpAt30, meta: { streakDays: current },
    });
    badgeRef = db.collection('userPoints').doc(uid).collection('badges').doc(badgeIdPrefix);
    badgeAlreadyExists = (await tx.get(badgeRef)).exists;
  }

  return {
    streakRef,
    newStreakState: { current, longest: Math.max(longest, current), lastDateStr: todayStr },
    bonuses,
    badgeRef,
    badgeAlreadyExists,
  };
}

// Awards game-completion points for a server-mediated game (Rummy/Sweep/Sequence) — called with
// the SAME transaction already in flight for the game's own finish write, so a finished game can
// never exist without its points already applied. Every non-winning participant gets `game_played`;
// winners additionally get `game_won` and their win streak advanced (non-winners' streaks reset).
// Split into a read phase and a write phase (like readAwardPlan/writeAwardPlan) for the same
// reason, PLUS one more wrinkle specific to games: who won isn't always known yet at the point in
// a game's own transaction where it's still safe to do reads — e.g. Sweep/Sequence's `play`
// handlers already write the player's hand/deck state (a card being played) before they can even
// tell whether that play ends the game. So the read phase deliberately does NOT take `winnerUids`
// — it reads BOTH the `game_played` and `game_won` ledger keys for every player, whether or not
// they'll turn out to be a winner, so the caller can call it unconditionally as early as possible
// (right after the transaction's own initial reads, before its first write) and only decide who
// actually won once that's known, safely, in the write phase.
interface GamePointsReadState {
  uid: string;
  userPointsRef: FirebaseFirestore.DocumentReference;
  userPointsData: Record<string, any>;
  playedRef: FirebaseFirestore.DocumentReference;
  playedExists: boolean;
  wonRef: FirebaseFirestore.DocumentReference;
  wonExists: boolean;
}

async function readGamePointsPlan(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  params: { gameType: string; gameId: string; playerUids: string[] },
): Promise<GamePointsReadState[]> {
  return Promise.all(params.playerUids.map(async (uid) => {
    const userPointsRef = db.collection('userPoints').doc(uid);
    const playedRef = db.collection('pointsLedger').doc(`${uid}_game_played_${params.gameType}_${params.gameId}`);
    const wonRef = db.collection('pointsLedger').doc(`${uid}_game_won_${params.gameType}_${params.gameId}`);
    const [userPointsSnap, playedSnap, wonSnap] = await Promise.all([tx.get(userPointsRef), tx.get(playedRef), tx.get(wonRef)]);
    return {
      uid, userPointsRef, userPointsData: userPointsSnap.data() || {},
      playedRef, playedExists: playedSnap.exists, wonRef, wonExists: wonSnap.exists,
    };
  }));
}

// Every non-winning participant gets `game_played`; winners additionally get `game_won` and their
// win streak advanced (non-winners' streaks reset). Pure writes — safe to call any time after
// `readGamePointsPlan` resolved, interleaved with the caller's other writes in any order.
function writeGamePointsPlan(
  tx: FirebaseFirestore.Transaction,
  states: GamePointsReadState[],
  params: { gameType: string; gameId: string; winnerUids: string[] },
): void {
  for (const state of states) {
    const won = params.winnerUids.includes(state.uid);
    let runningXp: number = state.userPointsData.xp || 0;
    let totalXp = 0;
    let totalCoins = 0;

    if (!state.playedExists) {
      tx.set(state.playedRef, {
        uid: state.uid, actionType: 'game_played', xp: 2, coins: 2,
        sourceCollection: `${params.gameType}Games`, sourceDocId: params.gameId,
        meta: {}, createdAt: new Date().toISOString(),
      });
      totalXp += 2; totalCoins += 2; runningXp += 2;
    }
    if (won && !state.wonExists) {
      tx.set(state.wonRef, {
        uid: state.uid, actionType: 'game_won', xp: 8, coins: 8,
        sourceCollection: `${params.gameType}Games`, sourceDocId: params.gameId,
        meta: {}, createdAt: new Date().toISOString(),
      });
      totalXp += 8; totalCoins += 8; runningXp += 8;
    }
    const currentStreak = state.userPointsData.gameStreaks?.[params.gameType] || 0;
    // gameStreaks rides along on the SAME userPoints write as the awards above (see
    // awardMultipleInTx's doc comment for why this can't be a separate follow-up tx.set).
    tx.set(state.userPointsRef, {
      ...(totalXp ? { xp: admin.firestore.FieldValue.increment(totalXp) } : {}),
      ...(totalCoins ? { coins: admin.firestore.FieldValue.increment(totalCoins) } : {}),
      ...(totalXp ? { level: levelForXp(runningXp) } : {}),
      updatedAt: new Date().toISOString(),
      gameStreaks: { [params.gameType]: won ? currentStreak + 1 : 0 },
    }, { merge: true });
  }
}

// Convenience wrapper for call sites where NOTHING else in the transaction writes before this is
// called (true for Rummy's declare-win/drop, once ordered so this always runs before the game's
// own finish write) — reads then writes in one call. Sweep/Sequence's `play` handlers write hand/
// deck state earlier and can't use this; they call readGamePointsPlan up front instead and
// writeGamePointsPlan later once the winner (if any) is known — see those handlers.
async function awardGamePoints(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  params: { gameType: string; gameId: string; playerUids: string[]; winnerUids: string[] },
): Promise<void> {
  const states = await readGamePointsPlan(tx, db, { gameType: params.gameType, gameId: params.gameId, playerUids: params.playerUids });
  writeGamePointsPlan(tx, states, { gameType: params.gameType, gameId: params.gameId, winnerUids: params.winnerUids });
}

// Permanent, deletion-proof snapshot of a finished game's OUTCOME only (never its board/hand
// state) — written in the SAME transaction as the game's own finish write (a pure write, safe
// anywhere among the other writes once all reads are done). GameRanks and the Ranks screen read
// this ALONGSIDE the live `{gameType}Games` collection and merge by id, so a player deleting a
// finished game from their lobby (`/api/{game}/delete`, which only ever refuses to delete an
// ACTIVE game) can no longer silently erase anyone's win/loss history — a real bug this fixes: a
// just-won game, deleted right after via the normal "delete this game" button, vanished from that
// day's Ranks for every player in it, not just the one who deleted it.
function recordGameOutcome(tx: FirebaseFirestore.Transaction, db: Firestore, gameId: string, outcome: Record<string, any>): void {
  tx.set(db.collection('gameOutcomes').doc(gameId), { status: 'finished', ...outcome });
}

// For call sites that award points as a side effect of an endpoint that ISN'T itself wrapped in a
// transaction (Friends accept/respond, recurring-confirm) — opens its own small transaction just
// for the award rather than forcing a wider transactional refactor onto already-working endpoints.
// Best-effort: errors are logged, never thrown, matching how this file already treats every other
// notification-adjacent side effect (logFeedActivity, sendPush) around these same call sites.
async function awardPointsStandalone(db: Firestore, uid: string, award: PointsAward): Promise<void> {
  try {
    await db.runTransaction((tx) => awardPointsInTx(tx, db, uid, award));
  } catch (error) {
    console.error(`awardPointsStandalone(${award.actionType}) failed:`, error);
  }
}

// --- /api/points/claim verifiers ---
// Each verifier re-reads the real source document via the Admin SDK and decides, from ONLY that
// re-read data (never from client-sent amounts/flags), whether an award is earned and how big it
// is. `creditUid` lets an award go to someone other than the caller (a group milestone credits the
// group's owner, for instance). `streakDateStr`/`habitTodoId` tell the claim endpoint whether to
// also run the streak-bonus computation, and for which streak.
type PointsVerifyResult =
  | { ok: true; award: PointsAward; creditUid?: string; streakDateStr?: string; habitTodoId?: string }
  | { ok: false; reason: string };

async function verifyExpenseLogged(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const expenseId = String(body.expenseId || '');
  if (!expenseId) return { ok: false, reason: 'expenseId is required.' };
  const snap = await db.collection('expenses').doc(expenseId).get();
  if (!snap.exists) return { ok: false, reason: 'Expense not found.' };
  const data = snap.data()!;
  if (data.addedBy !== uid) return { ok: false, reason: 'Not your expense.' };
  if (data.type !== 'expense') return { ok: false, reason: 'Income entries are not scored.' };
  if (!data.createdAt || data.createdAt < POINTS_LAUNCH_AT) return { ok: false, reason: 'Predates points launch.' };
  const createdMs = new Date(data.createdAt).getTime();
  const dateMs = new Date(data.date).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(dateMs) || Math.abs(createdMs - dateMs) > 24 * 3600 * 1000) {
    return { ok: false, reason: 'Not logged within 24h of the expense date.' };
  }
  return {
    ok: true,
    award: { actionType: 'expense_logged', ledgerKey: `${uid}_expense_logged_${expenseId}`, xp: 5, coins: 5, sourceCollection: 'expenses', sourceDocId: expenseId },
    streakDateStr: isoDateStr(data.createdAt),
  };
}

async function verifyTodoCompleted(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const todoId = String(body.todoId || '');
  if (!todoId) return { ok: false, reason: 'todoId is required.' };
  const snap = await db.collection('todos').doc(todoId).get();
  if (!snap.exists) return { ok: false, reason: 'To-do not found.' };
  const data = snap.data()!;
  if (data.userId !== uid) return { ok: false, reason: 'Not your to-do.' };
  if (data.recurring === true) return { ok: false, reason: 'Habits are scored separately.' };
  if (data.status !== 'done') return { ok: false, reason: 'Not marked done.' };
  const completedAt = data.completedAt;
  if (!completedAt || completedAt < POINTS_LAUNCH_AT) return { ok: false, reason: 'Predates points launch.' };
  let xp = 1; // late completion still earns a small base amount, never the on-time bonus
  if (data.dueDate) {
    xp = new Date(completedAt).getTime() <= new Date(`${data.dueDate}T23:59:59`).getTime() ? 5 : 1;
  } else if (data.createdAt && isoDateStr(completedAt) === isoDateStr(data.createdAt)) {
    xp = 3; // same-day-created, no explicit due date
  }
  return { ok: true, award: { actionType: 'todo_completed', ledgerKey: `${uid}_todo_completed_${todoId}`, xp, coins: xp, sourceCollection: 'todos', sourceDocId: todoId } };
}

async function verifyHabitOccurrence(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const todoId = String(body.todoId || '');
  const dateStr = String(body.dateStr || '');
  if (!todoId || !dateStr) return { ok: false, reason: 'todoId and dateStr are required.' };
  const snap = await db.collection('todos').doc(todoId).get();
  if (!snap.exists) return { ok: false, reason: 'Habit not found.' };
  const data = snap.data()!;
  if (data.userId !== uid) return { ok: false, reason: 'Not your habit.' };
  if (data.recurring !== true) return { ok: false, reason: 'Not a habit.' };
  const todayStr = isoDateStr(new Date().toISOString());
  if (dateStr > todayStr) return { ok: false, reason: 'Future date.' };
  const done = dateStr === todayStr ? data.status === 'done' : data.history?.[dateStr] === true;
  if (!done) return { ok: false, reason: 'Not completed for that day.' };
  return {
    ok: true,
    award: { actionType: 'habit_occurrence', ledgerKey: `${uid}_habit_occurrence_${todoId}_${dateStr}`, xp: 3, coins: 3, sourceCollection: 'todos', sourceDocId: todoId, meta: { dateStr } },
    streakDateStr: dateStr,
    habitTodoId: todoId,
  };
}

async function verifyBudgetSet(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const budgetDocId = String(body.budgetDocId || '');
  if (!budgetDocId) return { ok: false, reason: 'budgetDocId is required.' };
  const snap = await db.collection('groupBudgets').doc(budgetDocId).get();
  if (!snap.exists) return { ok: false, reason: 'Budget not found.' };
  const data = snap.data()!;
  if (data.setBy !== uid) return { ok: false, reason: 'Not your budget.' };
  const memberSnap = await db.collection('members').doc(`${uid}_${data.groupId}`).get();
  if (!memberSnap.exists) return { ok: false, reason: 'Not a member of that group.' };
  const priorSnap = await db.collection('groupBudgets').where('groupId', '==', data.groupId).get();
  if (priorSnap.size > 1) return { ok: false, reason: 'Not this group\'s first budget.' };
  return { ok: true, award: { actionType: 'budget_set', ledgerKey: `${uid}_budget_set_${data.groupId}`, xp: 10, coins: 10, sourceCollection: 'groupBudgets', sourceDocId: budgetDocId } };
}

async function verifyBudgetMet(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const groupId = String(body.groupId || '');
  const monthKey = String(body.monthKey || '');
  if (!groupId || !monthKey) return { ok: false, reason: 'groupId and monthKey are required.' };
  const nowMonthKey = new Date().toISOString().slice(0, 7);
  if (monthKey >= nowMonthKey) return { ok: false, reason: 'That month has not fully elapsed yet.' };
  const memberSnap = await db.collection('members').doc(`${uid}_${groupId}`).get();
  if (!memberSnap.exists) return { ok: false, reason: 'Not a member of that group.' };
  const budgetSnap = await db.collection('groupBudgets').doc(`${groupId}_${monthKey}`).get();
  if (!budgetSnap.exists) return { ok: false, reason: 'No budget was set for that month.' };
  const budget = budgetSnap.data()!;
  const monthStart = `${monthKey}-01`;
  const [y, m] = monthKey.split('-').map(Number);
  const nextMonthStart = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  // Two equality filters only (no range) to avoid needing a composite index — the date-range
  // filtering happens in memory below. Fine at this app's per-group expense volume.
  const expensesSnap = await db.collection('expenses').where('groupId', '==', groupId).where('type', '==', 'expense').get();
  let total = 0;
  expensesSnap.docs.forEach((d) => {
    const date = d.data().date;
    if (date && date >= monthStart && date < nextMonthStart) total += Number(d.data().amount) || 0;
  });
  if (total > Number(budget.amount)) return { ok: false, reason: 'Over budget that month.' };
  return {
    ok: true, creditUid: budget.setBy,
    award: { actionType: 'budget_met', ledgerKey: `${budget.setBy}_budget_met_${groupId}_${monthKey}`, xp: 50, coins: 50, sourceCollection: 'groupBudgets', sourceDocId: `${groupId}_${monthKey}` },
  };
}

async function verifyFeatureExplorer(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const feature = String(body.feature || '');
  const sourceCollection = String(body.sourceCollection || '');
  const sourceDocId = String(body.sourceDocId || '');
  if (!feature || !sourceCollection || !sourceDocId) return { ok: false, reason: 'feature, sourceCollection, and sourceDocId are required.' };
  const snap = await db.collection(sourceCollection).doc(sourceDocId).get();
  if (!snap.exists) return { ok: false, reason: 'Referenced item not found.' };
  const data = snap.data()!;
  const owner = data.userId || data.addedBy || data.createdBy;
  if (owner !== uid) return { ok: false, reason: 'Not yours.' };
  if (!data.createdAt || data.createdAt < POINTS_LAUNCH_AT) return { ok: false, reason: 'Predates points launch.' };
  return { ok: true, award: { actionType: 'feature_explorer', ledgerKey: `${uid}_feature_explorer_${feature}`, xp: 15, coins: 15, sourceCollection, sourceDocId, meta: { feature } } };
}

async function verifyGroupMilestone(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const groupId = String(body.groupId || '');
  if (!groupId) return { ok: false, reason: 'groupId is required.' };
  const memberSnap = await db.collection('members').doc(`${uid}_${groupId}`).get();
  if (!memberSnap.exists) return { ok: false, reason: 'Not a member of that group.' };
  const groupSnap = await db.collection('groups').doc(groupId).get();
  if (!groupSnap.exists) return { ok: false, reason: 'Group not found.' };
  const countSnap = await db.collection('members').where('groupId', '==', groupId).get();
  const count = countSnap.size;
  if (![3, 5, 10].includes(count)) return { ok: false, reason: 'Not a milestone member count.' };
  const ownerUid = groupSnap.data()!.createdBy;
  return {
    ok: true, creditUid: ownerUid,
    award: { actionType: 'group_milestone', ledgerKey: `${ownerUid}_group_milestone_${groupId}_${count}`, xp: 10, coins: 10, sourceCollection: 'groups', sourceDocId: groupId, meta: { count } },
  };
}

async function verifyHabitResumed(db: Firestore, uid: string, body: any): Promise<PointsVerifyResult> {
  const todoId = String(body.todoId || '');
  if (!todoId) return { ok: false, reason: 'todoId is required.' };
  const snap = await db.collection('todos').doc(todoId).get();
  if (!snap.exists) return { ok: false, reason: 'Habit not found.' };
  const data = snap.data()!;
  if (data.userId !== uid) return { ok: false, reason: 'Not your habit.' };
  if (data.recurringActive !== true) return { ok: false, reason: 'Habit is not currently active.' };
  if (!data.pausedAt) return { ok: false, reason: 'No pause on record.' };
  const daysSincePause = (Date.now() - new Date(data.pausedAt).getTime()) / 86400000;
  if (daysSincePause > 7) return { ok: false, reason: 'Paused more than a week ago.' };
  return { ok: true, award: { actionType: 'habit_resumed', ledgerKey: `${uid}_habit_resumed_${todoId}_${data.pausedAt}`, xp: 5, coins: 5, sourceCollection: 'todos', sourceDocId: todoId } };
}

async function verifyLudoResult(db: Firestore, uid: string, body: any): Promise<
  { ok: true; gameId: string; won: boolean } | { ok: false; reason: string }
> {
  const gameId = String(body.gameId || '');
  if (!gameId) return { ok: false, reason: 'gameId is required.' };
  const snap = await db.collection('ludoGames').doc(gameId).get();
  if (!snap.exists) return { ok: false, reason: 'Game not found.' };
  const data = snap.data()!;
  if (data.status !== 'finished') return { ok: false, reason: 'Game is not finished.' };
  const playerUids: string[] = data.playerUids || [];
  if (!playerUids.includes(uid)) return { ok: false, reason: 'Not a player in that game.' };
  return { ok: true, gameId, won: data.winnerUid === uid };
}

const POINTS_VERIFIERS: Record<string, (db: Firestore, uid: string, body: any) => Promise<PointsVerifyResult>> = {
  expense_logged: verifyExpenseLogged,
  todo_completed: verifyTodoCompleted,
  habit_occurrence: verifyHabitOccurrence,
  budget_set: verifyBudgetSet,
  budget_met: verifyBudgetMet,
  feature_explorer: verifyFeatureExplorer,
  group_milestone: verifyGroupMilestone,
  habit_resumed: verifyHabitResumed,
};

// Every multiplayer game collection's document shares this shape: `playerUids: string[]`,
// `status`, `createdAt`, `finishedAt` (null until finish). Top-level (not nested inside
// startServer) so both the admin games-analytics route AND computeUserWeeklyStats below can share
// one definition — used to live as a local const only inside the analytics route, duplicated here
// instead of kept in sync by hand.
const GAME_COLLECTIONS: Array<{ key: string; label: string; collection: string }> = [
  { key: 'rummy', label: '27-Hand Rummy', collection: 'rummyGames' },
  { key: 'sweep', label: 'Sweep', collection: 'sweepGames' },
  { key: 'ludo', label: 'Ludo', collection: 'ludoGames' },
  { key: 'business', label: 'Business', collection: 'businessGames' },
  { key: 'chess', label: 'Chess', collection: 'chessGames' },
  { key: 'sequence', label: 'Sequence', collection: 'sequenceGames' },
  { key: 'scramble', label: 'Scramble (Multiplayer)', collection: 'scrambleGames' },
];

// --- Weekly per-user summary (see /api/cron/send-weekly-summary) ---

interface WeeklySummaryBucket {
  gamesPlayed: number;
  coPlayers: number;
  groupsEngaged: number;
  expensesTracked: number;
  expenseLinesAdded: number;
  chatGroups: number;
  chatPeople: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
type SummaryWindow = 'week' | 'prevWeek' | 'month' | 'prevMonth';
const SUMMARY_WINDOWS: SummaryWindow[] = ['week', 'prevWeek', 'month', 'prevMonth'];

// Which comparison window(s) an event `ageMs` old belongs to. `month`/`prevMonth` are a SEPARATE
// 30-day comparison, not "this week plus the rest of the month" — but `week`'s own 7 days and
// `prevWeek`'s 7 days are BOTH still within the last 30 days, so an event also counts toward
// `month` whenever it counts toward `week` or `prevWeek`. Only `prevMonth` (days 31-60) is
// mutually exclusive with everything else — it exists purely to compute the month-over-month delta.
function summaryBucketsFor(ageMs: number): SummaryWindow[] {
  if (ageMs <= 7 * DAY_MS) return ['week', 'month'];
  if (ageMs <= 14 * DAY_MS) return ['prevWeek', 'month'];
  if (ageMs <= 30 * DAY_MS) return ['month'];
  if (ageMs <= 60 * DAY_MS) return ['prevMonth'];
  return [];
}

function isoWeekStartDate(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diffToMonday);
  return monday.toISOString().slice(0, 10);
}

// Computes one user's stats across all 4 comparison windows in a single pass over each data
// source (one query per source/thread, not per window) — see the plan this was built from for the
// full reasoning on why per-user fan-out (rather than one giant collection-group aggregation) is
// the right shape at this app's real scale.
async function computeUserWeeklyStats(
  db: Firestore,
  uid: string,
  now: number,
): Promise<Record<SummaryWindow, WeeklySummaryBucket>> {
  const cutoff60 = new Date(now - 60 * DAY_MS).toISOString();

  const raw: Record<SummaryWindow, {
    games: number; coPlayers: Set<string>; groupsEngaged: Set<string>;
    expensesTracked: number; expenseLinesAdded: number; chatGroups: Set<string>; chatPeople: Set<string>;
  }> = {} as any;
  SUMMARY_WINDOWS.forEach((w) => {
    raw[w] = { games: 0, coPlayers: new Set(), groupsEngaged: new Set(), expensesTracked: 0, expenseLinesAdded: 0, chatGroups: new Set(), chatPeople: new Set() };
  });

  // 1. Games played + co-players.
  for (const { collection } of GAME_COLLECTIONS) {
    const snap = await db.collection(collection)
      .where('playerUids', 'array-contains', uid)
      .where('finishedAt', '>=', cutoff60)
      .select('playerUids', 'finishedAt')
      .get();
    snap.docs.forEach((d) => {
      const data = d.data();
      if (!data.finishedAt) return;
      const others: string[] = (data.playerUids || []).filter((p: string) => p !== uid);
      summaryBucketsFor(now - new Date(data.finishedAt).getTime()).forEach((w) => {
        raw[w].games += 1;
        others.forEach((o) => raw[w].coPlayers.add(o));
      });
    });
  }

  // 2. Group membership (cheap, used by both the expenses-in-my-groups query and chat-thread list).
  const membersSnap = await db.collection('members').where('userId', '==', uid).select('groupId').get();
  const groupIds: string[] = membersSnap.docs.map((d) => d.data().groupId).filter(Boolean);

  // 3. Groups engaged in — driven off the user's own `activities` (expenses, invites, edits, ...).
  const activitiesSnap = await db.collection('activities')
    .where('userId', '==', uid)
    .where('createdAt', '>=', cutoff60)
    .select('groupId', 'createdAt')
    .get();
  activitiesSnap.docs.forEach((d) => {
    const data = d.data();
    if (!data.groupId) return;
    summaryBucketsFor(now - new Date(data.createdAt).getTime()).forEach((w) => raw[w].groupsEngaged.add(data.groupId));
  });

  // 4. Expense LINES this user personally added.
  const myExpensesSnap = await db.collection('expenses')
    .where('addedBy', '==', uid)
    .where('createdAt', '>=', cutoff60)
    .select('createdAt')
    .get();
  myExpensesSnap.docs.forEach((d) => {
    summaryBucketsFor(now - new Date(d.data().createdAt).getTime()).forEach((w) => raw[w].expenseLinesAdded += 1);
  });

  // 5. Total expenses TRACKED across every group this user belongs to (not just ones they added).
  for (let i = 0; i < groupIds.length; i += 30) {
    const chunk = groupIds.slice(i, i + 30); // Firestore 'in' queries cap at 30 values
    const snap = await db.collection('expenses')
      .where('groupId', 'in', chunk)
      .where('createdAt', '>=', cutoff60)
      .select('createdAt')
      .get();
    snap.docs.forEach((d) => {
      summaryBucketsFor(now - new Date(d.data().createdAt).getTime()).forEach((w) => raw[w].expensesTracked += 1);
    });
  }

  // 6. Chat — group threads (from groupIds above) + every game thread this user is currently in.
  const chatThreads: Array<{ collection: string; id: string }> = groupIds.map((gid) => ({ collection: 'groups', id: gid }));
  for (const { collection } of GAME_COLLECTIONS) {
    const snap = await db.collection(collection).where('playerUids', 'array-contains', uid).select().get();
    snap.docs.forEach((d) => chatThreads.push({ collection, id: d.id }));
  }
  for (const thread of chatThreads) {
    const commentsSnap = await db.collection(thread.collection).doc(thread.id).collection('comments')
      .where('createdAt', '>=', cutoff60)
      .select('userId', 'createdAt')
      .get();
    if (commentsSnap.empty) continue;
    const authorsByWindow: Record<SummaryWindow, Set<string>> = { week: new Set(), prevWeek: new Set(), month: new Set(), prevMonth: new Set() };
    commentsSnap.docs.forEach((d) => {
      const data = d.data();
      summaryBucketsFor(now - new Date(data.createdAt).getTime()).forEach((w) => authorsByWindow[w].add(data.userId));
    });
    // Only counts toward "chatted in this thread" for a window the user THEMSELVES posted in —
    // otherwise every co-member of a chatty group would inflate this user's own chat stats.
    SUMMARY_WINDOWS.forEach((w) => {
      const authors = authorsByWindow[w];
      if (!authors.has(uid)) return;
      raw[w].chatGroups.add(`${thread.collection}/${thread.id}`);
      authors.forEach((a) => { if (a !== uid) raw[w].chatPeople.add(a); });
    });
  }

  // 7. DMs — the parent `directChats` doc's `participants` already IDs the other person; no need
  // to check who posted first, since a DM by definition only ever has these two people in it.
  const dmSnap = await db.collection('directChats').where('participants', 'array-contains', uid).select('participants').get();
  for (const dmDoc of dmSnap.docs) {
    const participants: string[] = dmDoc.data().participants || [];
    const otherUid = participants.find((p) => p !== uid);
    if (!otherUid) continue;
    const commentsSnap = await dmDoc.ref.collection('comments').where('createdAt', '>=', cutoff60).select('createdAt').get();
    commentsSnap.docs.forEach((d) => {
      summaryBucketsFor(now - new Date(d.data().createdAt).getTime()).forEach((w) => raw[w].chatPeople.add(otherUid));
    });
  }

  const result = {} as Record<SummaryWindow, WeeklySummaryBucket>;
  SUMMARY_WINDOWS.forEach((w) => {
    result[w] = {
      gamesPlayed: raw[w].games,
      coPlayers: raw[w].coPlayers.size,
      groupsEngaged: raw[w].groupsEngaged.size,
      expensesTracked: raw[w].expensesTracked,
      expenseLinesAdded: raw[w].expenseLinesAdded,
      chatGroups: raw[w].chatGroups.size,
      chatPeople: raw[w].chatPeople.size,
    };
  });
  return result;
}

// Deterministic (no external AI call) "kudos" line — picks whichever stat improved most week-
// over-week and frames it warmly, matching this file's existing pick-a-random-templated-line
// convention (see SPEND_MESSAGES etc. in /api/cron/send-daily-reminders) rather than a fixed
// generic sentence every user would see verbatim.
function buildWeeklyKudosLine(week: WeeklySummaryBucket, prevWeek: WeeklySummaryBucket): string {
  const totalActivity = week.gamesPlayed + week.groupsEngaged + week.expensesTracked + week.expenseLinesAdded + week.chatPeople;
  if (totalActivity === 0) {
    return "Quiet week! Play a game or log an expense to kick off next week's recap. 🙂";
  }
  const candidates = [
    { text: `played ${week.gamesPlayed} game${week.gamesPlayed === 1 ? '' : 's'} with ${week.coPlayers} family/friend${week.coPlayers === 1 ? '' : 's'}`, delta: week.gamesPlayed - prevWeek.gamesPlayed, emoji: '🎲' },
    { text: `stayed active in ${week.groupsEngaged} family group${week.groupsEngaged === 1 ? '' : 's'}`, delta: week.groupsEngaged - prevWeek.groupsEngaged, emoji: '👨‍👩‍👧‍👦' },
    { text: `tracked ${week.expensesTracked} expense${week.expensesTracked === 1 ? '' : 's'}`, delta: week.expensesTracked - prevWeek.expensesTracked, emoji: '📊' },
    { text: `chatted with ${week.chatPeople} family member${week.chatPeople === 1 ? '' : 's'}/friend${week.chatPeople === 1 ? '' : 's'}`, delta: week.chatPeople - prevWeek.chatPeople, emoji: '💬' },
  ];
  const best = candidates.reduce((a, b) => (b.delta > a.delta ? b : a));
  if (best.delta > 0) {
    return `You ${best.text} this week — up ${best.delta} from last week! ${best.emoji} Great habit-building with your family & friends.`;
  }
  return `This week you ${best.text} — keep building those habits with your family & friends! ${best.emoji}`;
}

// Computes, writes, and delivers (feed + push) one user's weekly summary — shared by the
// Cloud-Scheduler-triggered /api/cron/send-weekly-summary (which additionally checks the
// weeklySummaryEnabled opt-out before calling this) and the self-service
// /api/weekly-summary/generate-mine (an on-demand "Generate my recap" button in Profile, used
// while testing this feature before the real weekly schedule is registered — deliberately does
// NOT check that opt-out, since a user pressing a button to try the feature should always work
// even if they'd previously turned off the automatic weekly push).
async function generateAndDeliverWeeklySummary(
  db: Firestore,
  uid: string,
  now: number,
): Promise<{ summaryId: string; pushSent: boolean }> {
  const weekStart = isoWeekStartDate(new Date(now));
  const periodLabel = `Week of ${new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const windows = await computeUserWeeklyStats(db, uid, now);
  const kudos = buildWeeklyKudosLine(windows.week, windows.prevWeek);
  const summaryId = `${uid}_${weekStart}`;

  await db.collection('userWeeklySummaries').doc(summaryId).set({
    userId: uid,
    generatedAt: new Date(now).toISOString(),
    periodLabel,
    week: windows.week,
    prevWeek: windows.prevWeek,
    month: windows.month,
    prevMonth: windows.prevMonth,
    kudos,
  });

  await logFeedActivity(db, {
    userId: uid,
    type: 'weekly_summary',
    description: kudos,
    data: { summaryId },
  });

  const privateSnap = await db.collection('users').doc(uid).collection('private').doc('info').get();
  const fcmTokens: string[] = privateSnap.exists ? (privateSnap.data()!.fcmTokens || []) : [];
  const sent = fcmTokens.length > 0 ? await sendPush(fcmTokens, 'Your Weekly FamilyLedger Recap', kudos, { type: 'weekly_summary', summaryId }) : 0;
  return { summaryId, pushSent: sent > 0 };
}

// Shared by every multiplayer game's /api/<game>/invite endpoint. `poke: true` sends the same
// notification through the same channels (push + inviteNotices banner) but with a "come join now"
// tone instead of "you're invited" — used to nudge people who were already invited/are group
// co-members but haven't joined the waiting room yet. Deliberately reuses the exact same
// candidate/target computation as a fresh invite (there's no persisted "who was already invited"
// record for games, unlike group invites' `invites` subcollection — see project notes), so poking
// is just "send the nudge version of the same notification" rather than tracking separate state.
async function sendGameInvites(
  db: Firestore,
  opts: {
    gameId: string;
    game: any;
    callerUid: string;
    targets: string[];
    gameLabel: string;
    routeSegment: string;
    poke: boolean;
  },
): Promise<number> {
  const { gameId, game, callerUid, targets, gameLabel, routeSegment, poke } = opts;
  const hostName = (game.players || []).find((p: any) => p.uid === callerUid)?.displayName || 'Someone';
  const title = poke ? `${gameLabel} — come join!` : `${gameLabel} invite`;
  const body = poke
    ? `${hostName} is waiting for you to join ${gameLabel}. Code: ${game.code}`
    : `${hostName} invited you to play ${gameLabel}. Code: ${game.code}`;
  const tokens = await collectPushTokens(db, targets, 'notificationsEnabled');
  const feedType = `${routeSegment}_${poke ? 'poke' : 'invite'}`;
  const sent = await sendPush(tokens, title, body, { type: feedType, gameId });
  await Promise.all(targets.map((uid) => createInviteNotice(db, uid, 'game', title, body, `/games/${routeSegment}/${gameId}`)));
  // `routeSegment` (e.g. 'ludo', 'chess') doubles as the i18n key suffix FeedList.tsx looks up
  // (`games.${routeSegment}`) to render the game's name in the viewer's own language, and `code`
  // is a room code, not translatable content, so it's passed through as-is.
  await Promise.all(targets.map((uid) => logFeedActivity(db, {
    userId: uid, type: feedType, description: body, userName: hostName, data: { gameId, routeSegment, code: game.code },
  })));
  return sent;
}

async function pruneStaleTokens(db: Firestore, staleTokens: string[]) {
  const snap = await db.collectionGroup('private').where('fcmTokens', 'array-contains-any', staleTokens.slice(0, 30)).get();
  const ops: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  snap.docs.forEach((d) => {
    const remaining = (d.data().fcmTokens || []).filter((t: string) => !staleTokens.includes(t));
    ops.push((batch) => batch.update(d.ref, { fcmTokens: remaining }));
  });
  if (ops.length > 0) await commitInChunks(db, ops);
}

// Date math for recurring expenses / expense reminders. Deliberately duplicated from
// src/lib/frequency.ts rather than imported — the client (Vite) and server (esbuild) bundles
// are built separately and don't share a module graph. Keep the two in sync if either changes.
interface FrequencyConfig {
  frequency: 'daily' | 'alternate_day' | 'weekly' | 'monthly' | 'alternate_month' | 'quarterly' | 'half_yearly' | 'annually';
  dayOfWeek?: number; // legacy single-day field, kept for old rules; new rules use daysOfWeek
  daysOfWeek?: number[]; // one or more of 0=Sun..6=Sat, for 'weekly'
  dayOfMonth?: number;
  month?: number;
  hour?: number; // 0-23 — user-chosen reminder time, any frequency
  minute?: number; // 0-59 — user-chosen reminder time, any frequency
}

function resolveDaysOfWeek(config: Pick<FrequencyConfig, 'dayOfWeek' | 'daysOfWeek'>): number[] {
  if (config.daysOfWeek && config.daysOfWeek.length > 0) return config.daysOfWeek;
  return [config.dayOfWeek ?? 0];
}

// Every frequency lets the user pick a reminder time now; unset hour/minute falls back to each
// frequency's old fixed default (9am for daily/alternate_day, noon otherwise). Mirrors
// src/lib/frequency.ts.
function reminderTimeOfDay(config: Pick<FrequencyConfig, 'frequency' | 'hour' | 'minute'>): { hour: number; minute: number } {
  const defaultHour = config.frequency === 'daily' || config.frequency === 'alternate_day' ? 9 : 12;
  return { hour: config.hour ?? defaultHour, minute: config.minute ?? 0 };
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function atMidnight(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

// The day-selection logic below always lands on a calendar day strictly later than `after`'s
// own day, so applying any time-of-day to that day is always guaranteed to be later than the
// exact `after` instant — see the matching comment in src/lib/frequency.ts for why no same-day
// edge case needs handling here.
function nextOccurrenceAfter(config: FrequencyConfig, after: Date): Date {
  const from = atMidnight(after);
  const { frequency, dayOfMonth = 1, month = 1 } = config;
  let result: Date;

  switch (frequency) {
    case 'daily': {
      const d = new Date(from);
      d.setDate(d.getDate() + 1);
      result = d;
      break;
    }
    case 'alternate_day': {
      const d = new Date(from);
      d.setDate(d.getDate() + 2);
      result = d;
      break;
    }
    case 'weekly': {
      const days = resolveDaysOfWeek(config);
      const d = new Date(from);
      d.setDate(d.getDate() + 1);
      while (!days.includes(d.getDay())) d.setDate(d.getDate() + 1);
      result = d;
      break;
    }
    case 'monthly': {
      // Mirrors src/lib/frequency.ts's fix — this month's target date first, only rolling to
      // next month if it's already on/before `from`.
      const thisMonth = new Date(from.getFullYear(), from.getMonth(), 1);
      thisMonth.setDate(Math.min(dayOfMonth, daysInMonth(thisMonth.getFullYear(), thisMonth.getMonth())));
      if (thisMonth > from) {
        result = thisMonth;
      } else {
        const d = new Date(from.getFullYear(), from.getMonth() + 1, 1);
        d.setDate(Math.min(dayOfMonth, daysInMonth(d.getFullYear(), d.getMonth())));
        result = d;
      }
      break;
    }
    case 'alternate_month':
    case 'quarterly':
    case 'half_yearly':
    case 'annually': {
      const stepMonths = frequency === 'alternate_month' ? 2 : frequency === 'quarterly' ? 3 : frequency === 'half_yearly' ? 6 : 12;
      const anchorMonth0 = Math.max(0, Math.min(11, month - 1));
      let candidate = new Date(from.getFullYear(), anchorMonth0, 1);
      candidate.setDate(Math.min(dayOfMonth, daysInMonth(candidate.getFullYear(), candidate.getMonth())));
      while (candidate <= from) {
        const next = new Date(candidate.getFullYear(), candidate.getMonth() + stepMonths, 1);
        next.setDate(Math.min(dayOfMonth, daysInMonth(next.getFullYear(), next.getMonth())));
        candidate = next;
      }
      result = candidate;
      break;
    }
    default:
      throw new Error(`Unknown frequency: ${frequency}`);
  }

  const { hour, minute } = reminderTimeOfDay(config);
  result.setHours(hour, minute, 0, 0);
  return result;
}

// Builds the expense's splitInfo from a recurring rule's stored split config (set on the
// rule when its group has splitEnabled — see RecurringExpenses.tsx). Falls back to an equal
// split across all current group members if the rule predates split configuration, or its
// chosen members are no longer in the group.
function computeRecurringSplitInfo(
  rule: FirebaseFirestore.DocumentData | undefined,
  amount: number,
  allMemberUids: string[],
): { splitType: string; splits: { userId: string; amount: number; percentage?: number }[] } | null {
  const configuredMembers: string[] = Array.isArray(rule?.splitMembers) ? rule!.splitMembers : [];
  const members = configuredMembers.length > 0 ? configuredMembers : allMemberUids;
  if (members.length === 0) return null;

  const splitType = rule?.splitType || 'equally';
  if (splitType === 'percentage' && rule?.memberSplits) {
    return {
      splitType,
      splits: members.map((uid) => ({
        userId: uid,
        percentage: rule!.memberSplits[uid] || 0,
        amount: (amount * (rule!.memberSplits[uid] || 0)) / 100,
      })),
    };
  }
  if (splitType === 'amount' && rule?.memberSplits) {
    const originalTotal = members.reduce((sum, uid) => sum + (rule!.memberSplits[uid] || 0), 0);
    return {
      splitType,
      splits: members.map((uid) => ({
        userId: uid,
        amount: originalTotal > 0 ? (amount * (rule!.memberSplits[uid] || 0)) / originalTotal : amount / members.length,
      })),
    };
  }
  const share = amount / members.length;
  return { splitType: 'equally', splits: members.map((uid) => ({ userId: uid, amount: share })) };
}

// Returns a Date whose LOCAL getters (getFullYear/getMonth/getDate/getDay/getHours/...) reflect
// the wall-clock date/time in `timeZone`, so nextOccurrenceAfter's existing (timezone-naive)
// date math — which resolves "which weekday/date is it" via those same local getters — resolves
// it correctly for that user instead of for this server process's own timezone (Cloud Run
// defaults to UTC), without needing to rewrite that math to be timezone-aware itself. This is
// NOT a real point in time — only use it for local-getter-based calendar math. Its own
// .toISOString()/.getTime() would reinterpret the borrowed numbers in this process's timezone,
// not `timeZone`; the app's granularity is "check once daily, fire if due" though, so the
// resulting instant landing a few hours off true local midnight has no practical effect — this
// fix is about selecting the correct calendar day, which is what actually mattered.
function nowInTimeZone(timeZone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return new Date(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  } catch {
    return new Date(); // unknown/invalid timezone string — fall back to server time
  }
}

// nextOccurrenceAfter's *return value* lives in the same "fake local" space as nowInTimeZone's
// output described above — its y/m/d/h/mi/s reflect the correct wall-clock time in `timeZone`,
// but the Date object's own internal instant is wrong (built via this process's local timezone,
// UTC on Cloud Run). Calling `.toISOString()` directly on it — which every caller of
// nextOccurrenceAfter used to do — reinterprets those borrowed components as literal UTC, so a
// user in any non-UTC zone got a `nextRunDate` shifted by exactly their UTC offset: recurring
// expenses and reminders fired at the wrong real-world instant relative to the user's own clock
// (e.g. IST users saw confirmations appear 5.5 hours later than their chosen local time). This
// converts a "fake local" Date back to the real UTC instant those wall-clock components denote in
// `timeZone`, via a guess-and-correct pass against Intl (handles DST since it re-checks the
// offset at the guessed instant itself, not just the zone's "current" offset).
function fakeLocalToRealIso(fakeLocal: Date, timeZone: string): string {
  const y = fakeLocal.getFullYear();
  const mo = fakeLocal.getMonth();
  const d = fakeLocal.getDate();
  const h = fakeLocal.getHours();
  const mi = fakeLocal.getMinutes();
  const s = fakeLocal.getSeconds();
  const intendedUtcMs = Date.UTC(y, mo, d, h, mi, s);
  try {
    let guess = intendedUtcMs;
    for (let i = 0; i < 2; i++) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(new Date(guess));
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      const shownUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      const diff = intendedUtcMs - shownUtcMs;
      if (diff === 0) break;
      guess += diff;
    }
    return new Date(guess).toISOString();
  } catch {
    return fakeLocal.toISOString(); // unknown/invalid timezone — fall back to the old (offset-shifted but non-crashing) behavior
  }
}

function todayDateStringInTimeZone(timeZone: string): string {
  return dateStringInTimeZone(new Date(), timeZone);
}

// Same wall-clock-in-a-given-zone conversion as todayDateStringInTimeZone, generalized to any
// instant (not just "now") — used to key a recurring to-do's per-day completion history off the
// calendar day its `nextRunDate` fell on in *its own* timezone, not the server's (UTC).
function dateStringInTimeZone(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().split('T')[0];
  }
}

// `users/{uid}.timezone` is captured client-side on every foreground heartbeat (AuthContext.tsx),
// so it's a reliable fallback wherever a feature doesn't (yet, or ever will) capture its own
// per-item timezone the way recurring expenses/expense reminders already do.
async function getUserTimezone(db: Firestore, uid: string | undefined | null): Promise<string | null> {
  if (!uid) return null;
  try {
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists ? snap.data()!.timezone || null : null;
  } catch {
    return null;
  }
}

// Processes due recurring expenses: creates the expense (auto-splitting equally if the
// group has splitEnabled, matching the Add Expense form's default), notifies the group,
// and advances nextRunDate to the following occurrence.
// Recurring expenses no longer auto-add themselves — when due, this creates a *pending*
// confirmation the user must Accept, Decline, or Change before anything is actually added
// (see /api/recurring-confirm/:id/{accept,decline} and RecurringApprovals.tsx). The schedule
// still advances immediately regardless of how/whether the user responds, so a slow response
// doesn't push every future occurrence back.
async function processRecurringExpenses(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('recurringExpenses').where('active', '==', true).get();
  let processed = 0;

  for (const ruleDoc of snap.docs) {
    const rule = ruleDoc.data();
    if (new Date(rule.nextRunDate) > now) continue;

    try {
      const groupRef = db.collection('groups').doc(rule.groupId);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) {
        await ruleDoc.ref.update({ active: false });
        continue;
      }
      const groupData = groupSnap.data()!;
      const amount = rule.amount;
      const description = rule.description || `Recurring: ${rule.category}`;
      const ruleTimeZone = rule.timezone || (await getUserTimezone(db, rule.userId)) || 'UTC';
      const todayIso = todayDateStringInTimeZone(ruleTimeZone);

      const isIncome = rule.type === 'income';
      const createdAt = new Date().toISOString();
      const pendingRef = await db.collection('pendingRecurringExpenses').add({
        userId: rule.userId,
        recurringExpenseId: ruleDoc.id,
        groupId: rule.groupId,
        groupName: groupData.name,
        type: isIncome ? 'income' : 'expense',
        category: rule.category,
        amount,
        description,
        date: todayIso,
        status: 'pending',
        createdAt,
        ...(rule.images?.length ? { images: rule.images } : {}),
        // Gates processRecurringReminderNudges' 3-hourly re-reminder below — seeded to the same
        // moment as the initial push so the first nudge fires a full 3 hours after THIS
        // notification, not immediately on the next cron tick.
        lastReminderAt: createdAt,
      });

      // This push is the only one that's safe to fire before confirming the pending doc is
      // actually readable by the client — it's sent from the exact same request that just
      // `await`ed the doc's creation, so by the time this resolves the write is durably
      // committed and any live listener on pendingRecurringExpenses will already see it. See
      // processRecurringReminderNudges below for the repeating follow-up, which re-queries the
      // collection itself rather than assuming anything about what's already on screen.
      const tokens = await collectPushTokens(db, [rule.userId], 'notificationsEnabled');
      await sendPush(
        tokens,
        isIncome ? `Confirm recurring income` : `Confirm recurring expense`,
        `"${description}" — ${amount} for "${groupData.name}". Accept, decline, or change it.`,
        { type: 'recurring_confirm', pendingId: pendingRef.id },
      );

      // The push above told rule.userId a confirmation is waiting on them, but until now nothing
      // ever recorded that in the Activity Feed — the only trace of "this became due" was the
      // push itself, easy to miss/dismiss, with no later record anyone could scroll back to.
      await db.collection('activities').add({
        groupId: rule.groupId,
        userId: rule.userId,
        userName: 'Recurring expense',
        userPhoto: '',
        type: 'recurring_confirm_pending',
        // Raw, untranslated value only — FeedList.tsx composes the sentence in the viewer's own
        // language from `type` + `data` at render time (this `description` field is kept only as
        // a plain-text fallback for anything that reads it directly instead).
        description,
        data: { amount, description, pendingId: pendingRef.id },
        createdAt: new Date().toISOString(),
      });

      const nextRunDate = fakeLocalToRealIso(nextOccurrenceAfter(rule as FrequencyConfig, nowInTimeZone(ruleTimeZone)), ruleTimeZone);
      await ruleDoc.ref.update({ nextRunDate });
      processed++;
    } catch (err) {
      console.error(`processRecurringExpenses failed for rule ${ruleDoc.id}:`, err);
    }
  }

  return processed;
}

// Nudges users who still have unconfirmed recurring-expense pending items, every 3 hours, until
// none are left — separate from the one-off "just became due" push in processRecurringExpenses
// above. Queries `pendingRecurringExpenses` itself (rather than trusting anything about what a
// client screen currently shows) so a nudge only ever fires for items that are genuinely,
// durably sitting in that collection right now — the fix for these notifications firing before
// the confirmation screen actually has anything to show. One push per user per cycle (not one per
// item) so someone with several pending items gets a single combined nudge, not a burst.
async function processRecurringReminderNudges(db: Firestore): Promise<number> {
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const now = Date.now();
  const snap = await db.collection('pendingRecurringExpenses').where('status', '==', 'pending').get();

  const byUser = new Map<string, Array<{ id: string; description: string; lastReminderAt: string }>>();
  snap.docs.forEach((d) => {
    const data = d.data();
    const list = byUser.get(data.userId) || [];
    list.push({ id: d.id, description: data.description, lastReminderAt: data.lastReminderAt || data.createdAt });
    byUser.set(data.userId, list);
  });

  let nudged = 0;
  for (const [userId, items] of byUser) {
    // Gate on the STALEST item in this user's pending set, so a newly-added item doesn't get its
    // own separate 3-hour clock — everything due for this user gets nudged together, on the
    // original item's schedule.
    const stalestAt = Math.min(...items.map((it) => new Date(it.lastReminderAt).getTime()));
    if (now - stalestAt < THREE_HOURS_MS) continue;

    try {
      const tokens = await collectPushTokens(db, [userId], 'notificationsEnabled');
      const title = items.length === 1 ? 'Confirm recurring expense' : `${items.length} recurring expenses need confirming`;
      const body =
        items.length === 1
          ? `"${items[0].description}" is still waiting for your confirmation.`
          : `You have ${items.length} recurring expenses waiting for confirmation.`;
      const sent = await sendPush(tokens, title, body, { type: 'recurring_confirm', pendingId: items[0].id });
      if (sent > 0) {
        const nowIso = new Date().toISOString();
        await commitInChunks(
          db,
          items.map((it) => (batch) => batch.update(db.collection('pendingRecurringExpenses').doc(it.id), { lastReminderAt: nowIso })),
        );
        nudged += items.length;
      }
    } catch (err) {
      console.error(`processRecurringReminderNudges failed for user ${userId}:`, err);
    }
  }

  return nudged;
}

// Processes due expense reminders: sends a push (never creates an expense) carrying whatever
// group/category/amount was preset, then advances nextRunDate — or, for a one-time reminder
// (oneTime: true), just deactivates it instead, since it isn't meant to recur.
async function processExpenseReminders(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('expenseReminders').where('active', '==', true).get();
  let sentCount = 0;

  for (const reminderDoc of snap.docs) {
    const reminder = reminderDoc.data();
    if (new Date(reminder.nextRunDate) > now) continue;

    try {
      const tokens = await collectPushTokens(db, [reminder.userId], 'notificationsEnabled');
      const data: Record<string, string> = { type: 'expense_reminder' };
      if (reminder.presetGroupId) data.groupId = reminder.presetGroupId;
      if (reminder.presetCategory) data.category = reminder.presetCategory;
      if (reminder.presetAmount) data.amount = String(reminder.presetAmount);
      // Preset photos are base64 data URIs — far too large for a push payload or URL query
      // string, so only the reminder's own doc id is carried through; AddExpense.tsx fetches
      // `expenseReminders/{reminderId}` itself to read `presetImages` when prefilling.
      if (reminder.presetImages?.length) data.reminderId = reminderDoc.id;

      const sent = await sendPush(tokens, 'Log an expense?', "Don't forget to add today's spend.", data);
      if (sent > 0) sentCount++;
      await logFeedActivity(db, {
        userId: reminder.userId, type: 'expense_reminder', description: "Log an expense? Don't forget to add today's spend.",
        userName: 'Expense reminder', data,
      });
      // FeedList.tsx renders this type from a fixed translated string (no dynamic parts in the
      // English original either), so no further `data` fields are needed for translation here.

      if (reminder.oneTime) {
        // Only deactivate once actually delivered — if delivery failed for every token (or
        // there were none), leave it active so the next cron run (within 15 min) retries,
        // instead of silently marking it done when nothing reached the user.
        if (sent > 0) await reminderDoc.ref.update({ active: false });
      } else {
        const reminderTimeZone = reminder.timezone || (await getUserTimezone(db, reminder.userId)) || 'UTC';
        const nextRunDate = fakeLocalToRealIso(nextOccurrenceAfter(reminder as FrequencyConfig, nowInTimeZone(reminderTimeZone)), reminderTimeZone);
        await reminderDoc.ref.update({ nextRunDate });
      }
    } catch (err) {
      console.error(`processExpenseReminders failed for reminder ${reminderDoc.id}:`, err);
    }
  }

  return sentCount;
}

// Processes due to-do reminders for group-shared items only: sends a one-time push to the
// item's creator (sharing a to-do with a group controls who can *see/edit* it, not who gets
// reminded about it — see firestore.rules' /todos block). Personal (non-shared) to-dos are
// scheduled entirely on-device instead (see scheduleLocalTodoReminder in localReminders.ts) —
// server delivery is only needed here because it's the only thing that can reach a device other
// than the one that set the reminder. Marks reminderSent so it doesn't fire again; editing the
// to-do's reminder time clears that flag (ToDoList.tsx), letting it fire again.
async function processTodoReminders(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('todos').where('done', '==', false).get();
  let sentCount = 0;

  for (const todoDoc of snap.docs) {
    const todo = todoDoc.data();
    if (!todo.groupId) continue;
    if (!todo.reminderAt || todo.reminderSent) continue;
    if (new Date(todo.reminderAt) > now) continue;

    try {
      const tokens = await collectPushTokens(db, [todo.userId], 'notificationsEnabled');
      const sent = await sendPush(tokens, 'To-Do reminder', todo.text, { type: 'todo_reminder', todoId: todoDoc.id });
      await logFeedActivity(db, {
        userId: todo.userId, type: 'todo_reminder', description: todo.text,
        userName: 'To-Do reminder', data: { todoId: todoDoc.id, text: todo.text },
      });
      if (sent > 0) {
        sentCount++;
        await todoDoc.ref.update({ reminderSent: true });
      }
      // sent === 0 (no tokens, notifications disabled, or delivery failed for every token):
      // leave reminderSent unset so the next cron run (within 15 min) retries, instead of
      // silently marking it "sent" when nothing actually reached the user.
    } catch (err) {
      console.error(`processTodoReminders failed for todo ${todoDoc.id}:`, err);
    }
  }

  return sentCount;
}

// Advances recurring to-dos ("habits") whose scheduled occurrence has come due: records that
// occurrence's outcome (`todo.done` at the moment it came due) into a per-day `history` map on
// the doc — this is what lets ToDoList.tsx's habit tracker grid show a habit's completion history
// even after the live `done`/`status` fields get reset for the next occurrence — then resets the
// doc to pending and advances `nextRunDate`. Unlike recurring expenses, a habit reset has no
// financial/multi-collection side effect, so there's no confirmation gate here (see
// processRecurringExpenses above for why that one needs one and this one doesn't) — and unlike
// recurring expenses, this deliberately sends no push: a daily/weekly habit would otherwise spam
// a notification every single occurrence, when the point of a habit tracker is a passive visual,
// not a nag. `recurringActive` lets the owner pause a habit without losing its schedule/history.
async function processRecurringTodos(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('todos').where('recurring', '==', true).get();
  let processed = 0;

  for (const todoDoc of snap.docs) {
    const todo = todoDoc.data();
    if (todo.recurringActive === false) continue;
    if (!todo.nextRunDate || new Date(todo.nextRunDate) > now) continue;

    try {
      const timeZone = todo.timezone || (await getUserTimezone(db, todo.userId)) || 'UTC';
      const dueDateKey = dateStringInTimeZone(new Date(todo.nextRunDate), timeZone);
      const nextRunDate = fakeLocalToRealIso(nextOccurrenceAfter(todo as FrequencyConfig, nowInTimeZone(timeZone)), timeZone);

      await todoDoc.ref.update({
        [`history.${dueDateKey}`]: todo.done === true,
        done: false,
        status: 'pending',
        nextRunDate,
        // Re-arms the advance reminder (see processHabitReminders below) for the occurrence that
        // just started — without this it would stay `true` from the prior occurrence and the new
        // one would never get its own advance reminder.
        habitReminderSent: false,
      });
      processed++;
    } catch (err) {
      console.error(`processRecurringTodos failed for todo ${todoDoc.id}:`, err);
    }
  }

  return processed;
}

// Sends the optional "remind me before it's due" push for a habit — e.g. reminderOffsetMinutes:60
// fires a push one hour before the current occurrence's due time (nextRunDate). Deliberately a
// separate pass/query from processRecurringTodos above: that one fires exactly AT nextRunDate to
// reset the occurrence, this one fires BEFORE it and must never also perform the reset (the two
// conditions — "occurrence about to become due" vs "occurrence now due" — briefly overlap in the
// last few minutes before nextRunDate, hence the `nextRunDate > now` guard, so a slow cron tick
// can't send the advance reminder AND the (silent) reset in the same run for one occurrence).
async function processHabitReminders(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('todos').where('recurring', '==', true).get();
  let sentCount = 0;

  for (const todoDoc of snap.docs) {
    const todo = todoDoc.data();
    if (todo.recurringActive === false) continue;
    if (!todo.reminderOffsetMinutes || !todo.nextRunDate || todo.habitReminderSent) continue;
    const dueAt = new Date(todo.nextRunDate);
    if (dueAt <= now) continue; // already due — processRecurringTodos owns this occurrence now
    const triggerAt = new Date(dueAt.getTime() - todo.reminderOffsetMinutes * 60000);
    if (triggerAt > now) continue;

    try {
      const tokens = await collectPushTokens(db, [todo.userId], 'notificationsEnabled');
      const sent = await sendPush(tokens, 'Habit reminder', todo.text, { type: 'todo_reminder', todoId: todoDoc.id });
      if (sent > 0) {
        sentCount++;
        await todoDoc.ref.update({ habitReminderSent: true });
      }
      // sent === 0: leave habitReminderSent unset so the next cron run (within 15 min) retries,
      // same reasoning as processTodoReminders above.
    } catch (err) {
      console.error(`processHabitReminders failed for todo ${todoDoc.id}:`, err);
    }
  }

  return sentCount;
}

// Carries a group's budget forward into the current month if nothing's been set for it yet
// (budgets stay in effect "until manually changed" — see ManageGroup.tsx's handleSaveBudget),
// then nudges members to set a budget for the current month: once when the month begins
// (no reminder yet sent for this month), then weekly after that until a budget exists. Only
// groups with no budget history at all (first month ever) get nudged, since everyone else's
// budget just carried forward automatically. Any member can set it, so all members are
// notified — matches the app's "any member can act on the group" pattern (same as inviting).
async function processBudgetReminders(db: Firestore): Promise<number> {
  const realNow = new Date(); // a true instant — only for elapsed-time math below, never calendar math
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
  let remindersSent = 0;

  const groupsSnap = await db.collection('groups').get();
  for (const groupDoc of groupsSnap.docs) {
    const groupId = groupDoc.id;
    const groupData = groupDoc.data();

    try {
      // "Which month" is a per-GROUP decision (the budget doc is shared across every member), so
      // there's no single objectively-correct zone if members are scattered across timezones —
      // the group creator's zone is the most reasonable single choice, falling back to UTC for
      // groups from before per-user timezone capture existed.
      const groupTimeZone = (await getUserTimezone(db, groupData.createdBy)) || 'UTC';
      const monthKey = todayDateStringInTimeZone(groupTimeZone).slice(0, 7);
      const budgetSnap = await db.collection('groupBudgets').doc(`${groupId}_${monthKey}`).get();
      if (budgetSnap.exists) continue; // Already set for this month — nothing to nudge.

      // No doc for this month yet — before nudging, check whether an earlier month's budget
      // should just carry forward. Filtering by `groupId` only (no `orderBy`) avoids needing a
      // composite index; sorting the (small, per-group) result in memory is fine since `month`
      // is a lexicographically-sortable "YYYY-MM" string.
      const priorBudgetsSnap = await db.collection('groupBudgets').where('groupId', '==', groupId).get();
      const priorBudgets = priorBudgetsSnap.docs
        .map((d) => d.data())
        .filter((b) => typeof b.month === 'string' && b.month < monthKey)
        .sort((a, b) => b.month.localeCompare(a.month));
      if (priorBudgets.length > 0) {
        const latest = priorBudgets[0];
        await db.collection('groupBudgets').doc(`${groupId}_${monthKey}`).set({
          groupId,
          month: monthKey,
          amount: latest.amount,
          setBy: latest.setBy,
          createdAt: new Date().toISOString(),
          carriedForward: true,
        });
        continue; // Budget continued automatically — no "please set a budget" nudge needed.
      }

      const lastReminderMonth = groupData.lastBudgetReminderMonth;
      const lastReminderAt = groupData.lastBudgetReminderAt ? new Date(groupData.lastBudgetReminderAt).getTime() : 0;
      const isNewMonth = lastReminderMonth !== monthKey;
      const dueForWeeklyNudge = realNow.getTime() - lastReminderAt >= ONE_WEEK;
      if (!isNewMonth && !dueForWeeklyNudge) continue;

      const membersSnap = await db.collection('members').where('groupId', '==', groupId).get();
      const memberUids = membersSnap.docs.map((d) => d.data().userId);
      if (memberUids.length === 0) continue;

      const tokens = await collectPushTokens(db, memberUids, 'notificationsEnabled');
      const budgetBody = isNewMonth
        ? `A new month has started — set a spending budget for "${groupData.name}".`
        : `Still no budget set for "${groupData.name}" this month.`;
      const sent = await sendPush(
        tokens,
        `${groupData.name}: Set this month's budget`,
        budgetBody,
        { type: 'group_activity', groupId },
      );
      // One doc reaches every group member via the groupId list rule — no single "actor" here
      // (this fires from the cron), so userId is left blank rather than attributed to a member.
      // `isNewMonth` (not the pre-composed English sentence) is what FeedList.tsx needs to pick
      // and translate the right template — the group name it resolves itself from `groupId` via
      // the groups already loaded for the Feed, same as every other group-scoped activity type.
      await logFeedActivity(db, {
        userId: '', type: 'budget_reminder', description: budgetBody, userName: 'Budget reminder', groupId,
        data: { isNewMonth },
      });

      await groupDoc.ref.update({ lastBudgetReminderMonth: monthKey, lastBudgetReminderAt: new Date().toISOString() });
      if (sent > 0) remindersSent++;
    } catch (err) {
      console.error(`processBudgetReminders failed for group ${groupId}:`, err);
    }
  }

  return remindersSent;
}

// Personal Loans: fires each contact's owner/counterparty reminder (independent — see
// firestore.rules' loanContacts comment for why they're separate fields) once its target time
// passes, plus the active installment plan's next-due reminder. Both reminder kinds are
// one-shot per instant, same as todo/expense reminders — re-setting a reminder date clears the
// matching `*Sent` flag client-side, which is what lets it fire again.
function advanceInstallmentDueDate(current: Date, frequency: 'weekly' | 'monthly'): Date {
  const next = new Date(current);
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

async function processLoanReminders(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('loanContacts').get();
  let sentCount = 0;

  for (const contactDoc of snap.docs) {
    const contact = contactDoc.data();
    try {
      // Owner's own reminder about this contact.
      if (contact.ownerReminderAt && !contact.ownerReminderSent && new Date(contact.ownerReminderAt) <= now) {
        const tokens = await collectPushTokens(db, [contact.ownerId], 'notificationsEnabled');
        const body = `You set a reminder to check in on your loan record with ${contact.name}.`;
        const sent = await sendPush(tokens, `${contact.name}: Reminder`, body, { type: 'loan_reminder', contactId: contactDoc.id });
        await logFeedActivity(db, {
          userId: contact.ownerId, type: 'loan_reminder', description: body,
          userName: 'Loan reminder', data: { contactId: contactDoc.id, contactName: contact.name, forOwner: true },
        });
        if (sent > 0) {
          await contactDoc.ref.update({ ownerReminderSent: true });
          sentCount++;
        }
      }

      // Linked counterparty's own reminder, if they have one set.
      if (contact.counterpartyUserId && contact.counterpartyReminderAt && !contact.counterpartyReminderSent && new Date(contact.counterpartyReminderAt) <= now) {
        const tokens = await collectPushTokens(db, [contact.counterpartyUserId], 'notificationsEnabled');
        const body = `You set a reminder about your loan record with ${contact.name}.`;
        const sent = await sendPush(tokens, `${contact.name}: Reminder`, body, { type: 'loan_reminder', contactId: contactDoc.id });
        await logFeedActivity(db, {
          userId: contact.counterpartyUserId, type: 'loan_reminder', description: body,
          userName: 'Loan reminder', data: { contactId: contactDoc.id, contactName: contact.name, forOwner: false },
        });
        if (sent > 0) {
          await contactDoc.ref.update({ counterpartyReminderSent: true });
          sentCount++;
        }
      }

      // Installment plan's next-due reminder — targets whichever side currently owes money
      // (the contact's `balance` sign can change between installments, so this is resolved
      // fresh at fire time rather than fixed when the plan was proposed).
      const plan = contact.installmentPlan;
      if (plan && plan.status === 'active' && plan.nextDueDate && !plan.reminderSent && new Date(plan.nextDueDate) <= now) {
        const balance = contact.balance || 0;
        // balance > 0: contact owes the owner, so the counterparty (if linked) is the debtor.
        // balance < 0: the owner owes the contact, so the owner is the debtor.
        const debtorUid = balance > 0 ? contact.counterpartyUserId : balance < 0 ? contact.ownerId : null;
        if (debtorUid) {
          const tokens = await collectPushTokens(db, [debtorUid], 'notificationsEnabled');
          const installmentBody = `Your ${plan.frequency} installment of ${plan.amount} is due.`;
          const sent = await sendPush(tokens, `${contact.name}: Installment due`, installmentBody, { type: 'loan_installment_due', contactId: contactDoc.id });
          await logFeedActivity(db, {
            userId: debtorUid, type: 'loan_installment_due', description: installmentBody, userName: 'Loan reminder',
            data: { contactId: contactDoc.id, contactName: contact.name, frequency: plan.frequency, amount: plan.amount },
          });
          if (sent > 0) sentCount++;
        }
        // Advancing nextDueDate to the following period in this same write means reminderSent
        // resets to false for that new date, not true — it hasn't been sent yet.
        await contactDoc.ref.update({
          'installmentPlan.reminderSent': false,
          'installmentPlan.nextDueDate': advanceInstallmentDueDate(new Date(plan.nextDueDate), plan.frequency).toISOString(),
        });
      }
    } catch (err) {
      console.error(`processLoanReminders failed for contact ${contactDoc.id}:`, err);
    }
  }

  return sentCount;
}

// Retention for the Activity Feed (`activities`) — keeps 3 months of history, same window this
// was promised for. Runs on every cron tick (see /api/cron/send-reminders); that's safe/cheap
// even at a ~15-minute cadence since a query that matches nothing still only costs one read, and
// the number of docs actually crossing the 90-day line at any given tick is naturally small
// (trickles in continuously, doesn't arrive in a burst) — no separate "once a day" throttle
// needed, unlike processBudgetReminders' weekly nudge. `limit(500)` just bounds a single run's
// work in case of a large backlog (e.g. the first run after this retention policy shipped).
const ACTIVITY_RETENTION_DAYS = 90;
async function cleanupOldActivities(db: Firestore): Promise<number> {
  const cutoff = new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const snap = await db.collection('activities').where('createdAt', '<', cutoff).limit(500).get();
  if (snap.empty) return 0;
  await commitInChunks(db, snap.docs.map((d) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(d.ref)));
  return snap.size;
}

// Fires any broadcast whose `scheduledFor` has arrived — see /api/admin/broadcast's scheduling
// path. Filters `status === 'scheduled'` alone (no range clause combined with it, matching this
// project's usual composite-index-avoidance convention) and checks `scheduledFor <= now` in
// memory instead; the number of pending scheduled broadcasts at any moment is always tiny.
async function processScheduledBroadcasts(db: Firestore): Promise<number> {
  const now = new Date();
  const snap = await db.collection('broadcasts').where('status', '==', 'scheduled').get();
  let sentCount = 0;

  for (const bDoc of snap.docs) {
    const b = bDoc.data();
    if (!b.scheduledFor || new Date(b.scheduledFor) > now) continue;

    try {
      const broadcastId = bDoc.id;
      const title = b.title || 'FamilyLedger';
      const message = b.message || '';

      await db.collection('app_config').doc('broadcast').set({
        id: broadcastId,
        title,
        message,
        images: b.images || [],
        createdAt: new Date().toISOString(),
        createdBy: b.createdBy,
      });

      const usersSnap = await db.collection('users').select().get();
      const allUids = usersSnap.docs.map((d) => d.id);
      const tokens = await collectPushTokens(db, allUids, 'notificationsEnabled');
      const pushSent = await sendPush(tokens, title, message, { type: 'broadcast', broadcastId });

      await bDoc.ref.update({
        status: 'sent',
        sentAt: new Date().toISOString(),
        recipientCount: allUids.length,
        pushSent,
      });
      sentCount++;
    } catch (err) {
      console.error(`processScheduledBroadcasts failed for broadcast ${bDoc.id}:`, err);
    }
  }

  return sentCount;
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Use JSON and urlencoded body parsers. Default express.json() limit is 100kb, which is too
  // small for /api/admin/broadcast's resized-image data URIs (up to 3 images, base64-encoded —
  // every other image upload in this app writes straight to Firestore from the client, bypassing
  // this body parser entirely, so this is the first endpoint that actually needs the headroom).
  // Every endpoint here requires a verified Firebase ID token, so raising this ceiling doesn't
  // meaningfully change this server's exposure to unauthenticated large-payload abuse.
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: true, limit: '6mb' }));

  // API Route: Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Reports which Cloud Run revision is CURRENTLY serving this request — compared client-side
  // (see UpdateBanner.tsx) against the `app_config/webBuild` doc this same revision stamped into
  // Firestore at startup below. A mismatch means a newer revision has since been deployed and
  // this tab is still running the old JS bundle, since the PWA service worker (`registerType:
  // 'autoUpdate'`) activates a new version silently in the background without ever reloading an
  // already-open tab. `K_REVISION` is set automatically by Cloud Run; falls back to 'local' for
  // `npm start` outside Cloud Run, where the banner should never fire (see the startup write's
  // matching guard below).
  app.get("/api/build-info", (req, res) => {
    res.json({ revision: process.env.K_REVISION || "local" });
  });

  // Deliberately unauthenticated — AddFriendInvite.tsx (the public "you've been invited to be
  // friends" landing page at /add-friend/:uid) needs to show who invited you BEFORE you've signed
  // in, same reason group invite links can show the group name/icon pre-auth (see `groups/{id}`'s
  // `allow get: if true` in firestore.rules). Deliberately returns nothing beyond
  // displayName/photoURL — no email, uid confirmation only implicit via the URL param itself.
  // Instant claim+verify: the client calls this right after its own existing (unchanged)
  // Firestore write; this endpoint re-reads the real document via the Admin SDK to confirm the
  // action genuinely happened before awarding anything — see the POINTS_VERIFIERS registry and
  // awardMultipleInTx's doc comment above for the full design. Ludo is special-cased (its own
  // dedicated verifier + inline transaction) since it's the one game without a server-mediated
  // finish write to award inline, unlike Rummy/Sweep/Sequence.
  app.post('/api/points/claim', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const actionType = String(req.body?.actionType || '');

    try {
      if (actionType === 'ludo_result') {
        const ludoResult = await verifyLudoResult(db, decoded.uid, req.body || {});
        if (ludoResult.ok === false) return res.status(400).json({ error: ludoResult.reason });
        const { gameId, won } = ludoResult;
        let awarded = false;
        await db.runTransaction(async (tx) => {
          const awards: PointsAward[] = [{
            actionType: 'game_played', ledgerKey: `${decoded.uid}_game_played_ludo_${gameId}`,
            xp: 2, coins: 2, sourceCollection: 'ludoGames', sourceDocId: gameId,
          }];
          if (won) {
            awards.push({
              actionType: 'game_won', ledgerKey: `${decoded.uid}_game_won_ludo_${gameId}`,
              xp: 8, coins: 8, sourceCollection: 'ludoGames', sourceDocId: gameId,
            });
          }
          const state = await readAwardPlan(tx, db, decoded.uid, awards);
          const currentStreak = state.userPointsData.gameStreaks?.ludo || 0;
          state.extraUserPointsFields = { gameStreaks: { ludo: won ? currentStreak + 1 : 0 } };
          awarded = writeAwardPlan(tx, state);
        });
        return res.json({ ok: true, alreadyAwarded: !awarded });
      }

      const verifier = POINTS_VERIFIERS[actionType];
      if (!verifier) return res.status(400).json({ error: 'Unknown actionType.' });

      const claimResult = await verifier(db, decoded.uid, req.body || {});
      if (claimResult.ok === false) return res.status(400).json({ error: claimResult.reason });
      const result = claimResult;

      const creditUid = result.creditUid || decoded.uid;
      let awarded = false;
      let xpAwarded = 0;
      let coinsAwarded = 0;
      await db.runTransaction(async (tx) => {
        // --- READ PHASE: every tx.get() in this transaction happens here, before any tx.set(). ---
        const mainLedgerSnap = await tx.get(db.collection('pointsLedger').doc(result.award.ledgerKey));
        const awards: PointsAward[] = [result.award];
        let streakComputation: StreakComputation | null = null;
        if (!mainLedgerSnap.exists && result.streakDateStr) {
          const streakRef = result.habitTodoId
            ? db.collection('userPoints').doc(creditUid).collection('habitStreaks').doc(result.habitTodoId)
            : db.collection('userPoints').doc(creditUid).collection('meta').doc('expenseStreak');
          streakComputation = result.habitTodoId
            ? await computeStreakBonusAwards(tx, db, creditUid, streakRef, result.streakDateStr, 'habit_streak7', `${creditUid}_habit_streak7_${result.habitTodoId}`, 20, 75, `habit30_${result.habitTodoId}`)
            : await computeStreakBonusAwards(tx, db, creditUid, streakRef, result.streakDateStr, 'expense_streak7', `${creditUid}_expense_streak7`, 25);
          if (streakComputation) awards.push(...streakComputation.bonuses);
        }
        const awardState = await readAwardPlan(tx, db, creditUid, awards);

        // --- WRITE PHASE: no tx.get() calls below this line. ---
        awarded = writeAwardPlan(tx, awardState);
        if (awarded) {
          xpAwarded = awards.reduce((sum, a) => sum + a.xp, 0);
          coinsAwarded = awards.reduce((sum, a) => sum + a.coins, 0);
        }
        if (streakComputation) {
          tx.set(streakComputation.streakRef, streakComputation.newStreakState, { merge: true });
          if (streakComputation.badgeRef && !streakComputation.badgeAlreadyExists) {
            tx.set(streakComputation.badgeRef, {
              awardedAt: new Date().toISOString(),
              streakDays: streakComputation.newStreakState.current,
            });
          }
        }
      });
      return res.json({ ok: true, alreadyAwarded: !awarded, xp: xpAwarded, coins: coinsAwarded });
    } catch (error) {
      console.error('points/claim error:', error);
      return res.status(500).json({ error: 'Unable to award points. Please try again.' });
    }
  });

  // The gamification-stats counterpart to /api/public-profile/:uid — deliberately a SEPARATE
  // endpoint (rather than folding this into public-profile) because it needs to be auth-gated
  // (viewed from inside the app by another signed-in user, unlike public-profile which is shown
  // pre-signup on the friend-invite landing page) and because it deliberately excludes `coins`
  // and the raw activity ledger — a spendable balance and a log of exactly when/what someone
  // logs stays private, the same way another user's wallet balance would in most apps; only
  // level/XP/badges/streaks are shown, which are the "aura" pieces meant to be seen.
  app.get('/api/public-points/:uid', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const uid = String(req.params.uid);

    try {
      const [pointsSnap, badgesSnap, expenseStreakSnap] = await Promise.all([
        db.collection('userPoints').doc(uid).get(),
        db.collection('userPoints').doc(uid).collection('badges').get(),
        db.collection('userPoints').doc(uid).collection('meta').doc('expenseStreak').get(),
      ]);
      const points = pointsSnap.data() || {};
      const badges = badgesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return res.json({
        xp: points.xp || 0,
        level: points.level || 1,
        gameStreaks: points.gameStreaks || {},
        expenseStreakLongest: expenseStreakSnap.data()?.longest || 0,
        badges,
      });
    } catch (error) {
      console.error('public-points error:', error);
      return res.status(500).json({ error: 'Unable to load points.' });
    }
  });

  // Friends/group-scoped ranking — deliberately NOT a global "every FamilyLedger user" board,
  // since that's a much less meaningful comparison for a family-finance app than "how am I doing
  // against the people I actually share expenses/games with."
  app.get('/api/points/leaderboard', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const scope = String(req.query.scope || 'friends');

    try {
      let uids: string[] = [decoded.uid];
      if (scope === 'friends') {
        const friendsSnap = await db.collection('friendships')
          .where('participants', 'array-contains', decoded.uid)
          .where('status', '==', 'accepted')
          .get();
        friendsSnap.docs.forEach((d) => {
          const other = (d.data().participants || []).find((u: string) => u !== decoded.uid);
          if (other) uids.push(other);
        });
      } else if (scope === 'group') {
        const groupId = String(req.query.groupId || '');
        if (!groupId) return res.status(400).json({ error: 'groupId is required for group scope.' });
        const memberSnap = await db.collection('members').doc(`${decoded.uid}_${groupId}`).get();
        if (!memberSnap.exists) return res.status(403).json({ error: 'Not a member of that group.' });
        const membersSnap = await db.collection('members').where('groupId', '==', groupId).get();
        uids = membersSnap.docs.map((d) => d.data().userId);
      } else {
        return res.status(400).json({ error: 'Unknown scope.' });
      }
      uids = Array.from(new Set(uids)).slice(0, 50);

      const [pointsSnaps, userSnaps] = await Promise.all([
        Promise.all(uids.map((uid) => db.collection('userPoints').doc(uid).get())),
        Promise.all(uids.map((uid) => db.collection('users').doc(uid).get())),
      ]);
      const entries = uids
        .map((uid, i) => ({
          uid,
          displayName: userSnaps[i].data()?.displayName || 'Someone',
          photoURL: userSnaps[i].data()?.photoURL || '',
          xp: pointsSnaps[i].data()?.xp || 0,
          level: pointsSnaps[i].data()?.level || 1,
          coins: pointsSnaps[i].data()?.coins || 0,
        }))
        .sort((a, b) => b.xp - a.xp);

      return res.json({ entries });
    } catch (error) {
      console.error('points/leaderboard error:', error);
      return res.status(500).json({ error: 'Unable to load leaderboard.' });
    }
  });

  app.get("/api/public-profile/:uid", async (req, res) => {
    if (!adminDb) return res.status(500).json({ error: "Server not ready." });
    try {
      const snap = await adminDb.collection("users").doc(String(req.params.uid)).get();
      if (!snap.exists) return res.status(404).json({ error: "Not found." });
      const data = snap.data() || {};
      return res.json({ displayName: data.displayName || "A FamilyLedger user", photoURL: data.photoURL || "" });
    } catch (error) {
      console.error("public-profile error:", error);
      return res.status(500).json({ error: "Unable to load profile." });
    }
  });

  // Android App Links verification file — lets Android confirm this app is authorized to
  // open links to this domain directly (instead of the browser), so invite links open the
  // app instead of a web page. Must list every signing certificate that could ever be
  // installed: debug, local upload key, and all three Play App Signing certificates
  // (classical, post-quantum, and the legacy pre-Android-17 deployment cert — see
  // CREDENTIALS.md for why there are three).
  app.get("/.well-known/assetlinks.json", (req, res) => {
    res.json([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.familyledger.app",
          sha256_cert_fingerprints: [
            "4D:EF:96:29:55:4B:FA:26:19:52:6A:01:51:B9:C2:FA:6C:8F:28:6F:43:9F:57:78:4B:DD:84:F7:97:B7:98:4E", // debug
            "1A:9C:F5:36:77:A7:B2:F3:75:CB:0C:49:7B:A2:71:42:AA:2E:CD:9E:9C:AC:59:AA:F9:AA:43:96:50:81:8D:C2", // upload key
            "41:5A:6F:A4:C9:98:F9:62:9D:0B:52:1D:03:80:11:F9:66:A7:FF:15:21:86:DC:66:FF:B2:A5:56:B0:87:AD:07", // Play App Signing — classical
            "23:68:4C:0E:DD:50:0E:A9:32:45:82:79:F5:E9:FB:14:DA:FA:40:2D:06:11:EF:4A:E4:0F:E4:6A:AC:DB:55:D3", // Play App Signing — post-quantum
            "88:C7:ED:D1:40:5A:C9:28:91:B2:6A:EE:4B:D5:F9:BC:5E:A2:FC:4F:F2:81:CD:CF:A1:60:DD:12:50:0E:E5:65", // Play App Signing — legacy deployment cert
          ],
        },
      },
    ]);
  });

  // iOS Universal Links verification file — the same purpose as assetlinks.json above, but for
  // Apple: lets iOS confirm this app is authorized to open links to this domain directly instead
  // of Safari, so invite links open the app there too. TEAM_ID must be replaced with the real
  // 10-character Apple Developer Team ID (Apple Developer → Account → Membership) before this
  // works — it's the prefix of appID, formatted "<TEAMID>.<bundleId>".
  app.get("/.well-known/apple-app-site-association", (req, res) => {
    res.json({
      applinks: {
        apps: [],
        details: [
          {
            appID: "B6D93WXCD7.com.thirteenapps.familyledger",
            paths: ["*"],
          },
        ],
      },
    });
  });

  const sendOtpEmail = async (
    res: express.Response,
    email: string,
    purpose: 'signup' | 'reset',
  ) => {
    let otpCode = '';

    try {
      otpCode = String(Math.floor(1000 + Math.random() * 9000));
      const otpHash = hashCode(otpCode);
      const expiresAt = Date.now() + 5 * 60 * 1000;

      otpStore.set(`${purpose}:${email}`, { codeHash: otpHash, expiresAt });
      if (debugOtpDelivery) {
        console.log(`[dev] OTP for ${purpose}:${email}: ${otpCode}`);
      }

      const subject =
        purpose === 'reset'
          ? 'Your FamilyLedger password reset code'
          : 'Your FamilyLedger verification code';
      const intro =
        purpose === 'reset'
          ? 'Your 4-digit FamilyLedger password reset code is:'
          : 'Your 4-digit FamilyLedger verification code is:';

      if (!transporter) {
        const responseBody: any = {
          message: 'Verification code prepared for your email.',
        };

        if (debugOtpDelivery) {
          responseBody.otp = otpCode;
          responseBody.devMode = true;
          responseBody.details = 'SMTP is not configured; using local development fallback.';
        } else {
          return res.status(500).json({ error: 'SMTP settings are missing. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in the environment.' });
        }

        return res.json(responseBody);
      }

      const info = await transporter.sendMail({
        from: emailFrom,
        to: email,
        subject,
        text: `${intro} ${otpCode}. It expires in 5 minutes. If you did not request this code, please ignore this email.`,
        html: `
          <p>${intro}</p>
          <p style="font-size: 1.4rem; font-weight: bold;">${otpCode}</p>
          <p>This code expires in 5 minutes.</p>
          <p>If you did not request this code, please ignore this email.</p>
        `,
      });

      if (debugOtpDelivery) {
        console.log('[dev] Nodemailer sendMail response:', info);
      }

      const responseBody: any = {
        message: 'Verification code sent to your email.',
      };
      if (debugOtpDelivery) {
        responseBody.otp = otpCode;
      }

      return res.json(responseBody);
    } catch (error) {
      console.error('Send OTP error:', error);
      const responseBody: any = {
        error:
          'Unable to send OTP email. Please check server email settings and provider status.',
      };
      if (debugOtpDelivery) {
        responseBody.otp = otpCode || String(Math.floor(1000 + Math.random() * 9000));
        responseBody.details = String(error);
        responseBody.devMode = true;
        return res.status(200).json(responseBody);
      }
      return res.status(500).json(responseBody);
    }
  };

  app.post('/api/send-otp', async (req, res) => {
    const email = normalizeEmail(String(req.body.email || ''));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const alreadyExists = await emailHasExistingAccount(email);
    if (alreadyExists) {
      return res.status(409).json({
        error: 'This email is already registered. Please log in with your password.',
        userExists: true,
      });
    }

    return sendOtpEmail(res, email, 'signup');
  });

  app.post('/api/send-reset-otp', async (req, res) => {
    const email = normalizeEmail(String(req.body.email || ''));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const exists = await emailHasExistingAccount(email);
    if (exists === false) {
      return res.status(404).json({
        error: 'No account found for that email. Please check the address or sign up.',
      });
    }

    return sendOtpEmail(res, email, 'reset');
  });

  app.post('/api/verify-otp', async (req, res) => {
    try {
      const email = normalizeEmail(String(req.body.email || ''));
      const code = String(req.body.code || '').trim();
      const purpose = req.body.purpose === 'reset' ? 'reset' : 'signup';

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
      if (!/^[0-9]{4}$/.test(code)) {
        return res.status(400).json({ error: 'Please enter the 4-digit code sent to your email.' });
      }

      const storeKey = `${purpose}:${email}`;
      const otpRecord = otpStore.get(storeKey);
      if (debugOtpDelivery) {
        console.log(`[dev] Verify request for ${storeKey}; has record: ${Boolean(otpRecord)}`);
      }

      if (!otpRecord) {
        return res.status(400).json({ error: 'No valid code found for this email. Request a new code.' });
      }

      if (otpRecord.expiresAt < Date.now()) {
        otpStore.delete(storeKey);
        return res.status(400).json({ error: 'The code has expired. Please request a new one.' });
      }

      if (otpRecord.codeHash !== hashCode(code)) {
        return res.status(400).json({ error: 'Invalid code. Please check the 4-digit number and try again.' });
      }

      otpStore.delete(storeKey);

      if (purpose === 'reset') {
        const resetToken = crypto.randomBytes(24).toString('hex');
        resetTokenStore.set(email, { token: resetToken, expiresAt: Date.now() + 10 * 60 * 1000 });
        return res.json({ ok: true, email, resetToken });
      }

      return res.json({ ok: true, email });
    } catch (error) {
      console.error('Verify OTP error:', error);
      return res.status(500).json({ error: 'Unable to verify OTP at this time.' });
    }
  });

  app.post('/api/reset-password', async (req, res) => {
    try {
      const email = normalizeEmail(String(req.body.email || ''));
      const resetToken = String(req.body.resetToken || '');
      const newPassword = String(req.body.newPassword || '');

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const record = resetTokenStore.get(email);
      if (!record || record.token !== resetToken) {
        return res.status(400).json({ error: 'Reset session is invalid. Please verify your email again.' });
      }
      if (record.expiresAt < Date.now()) {
        resetTokenStore.delete(email);
        return res.status(400).json({ error: 'Reset session has expired. Please verify your email again.' });
      }

      resetTokenStore.delete(email);

      if (!adminAuth) {
        return res.status(500).json({
          error: 'Password reset is not available right now. Please try again later.',
        });
      }

      try {
        const userRecord = await adminAuth.getUserByEmail(email);
        await adminAuth.updateUser(userRecord.uid, { password: newPassword });
      } catch (err: any) {
        if (err?.code === 'auth/user-not-found') {
          return res.status(404).json({ error: 'No account found for that email.' });
        }
        console.error('Admin updateUser error:', err);
        return res.status(500).json({ error: 'Unable to reset password at this time.' });
      }

      return res.json({ ok: true, message: 'Password updated. You can now log in with your new password.' });
    } catch (error) {
      console.error('Reset password error:', error);
      return res.status(500).json({ error: 'Unable to reset password at this time.' });
    }
  });

  // Self-service: mark the caller's own email as verified. Called right after
  // createUserWithEmailAndPassword succeeds during signup, since our OTP flow already
  // proved inbox ownership before that point — this lets /api/merge-account trust the
  // email claim for password accounts the same way it already trusts Google accounts
  // (which are verified by Google automatically).
  app.post('/api/mark-email-verified', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminAuth) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
      await adminAuth.updateUser(decoded.uid, { emailVerified: true });
      return res.json({ ok: true });
    } catch (error) {
      console.error('mark-email-verified error:', error);
      return res.status(500).json({ error: 'Unable to update account.' });
    }
  });

  // Finds any other account(s) tied to the caller's verified email address — either a
  // still-active duplicate (e.g. created via a different sign-in provider) or one deleted
  // within the last 30 days via the in-app "Delete account" flow — and migrates their
  // groups/expenses/activities onto the currently signed-in uid. Safe to call on every
  // login: a no-op when there's nothing to merge.
  app.post('/api/merge-account', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminAuth || !adminDb) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const newUid = decoded.uid;
    const email = normalizeEmail(decoded.email || '');
    const isGoogleProvider = decoded.firebase?.sign_in_provider === 'google.com';
    if (!email || !(decoded.email_verified || isGoogleProvider)) {
      return res.json({ merged: false, reason: 'Email not verified.' });
    }

    try {
      const [duplicateProfiles, deletionTombstones, newUserSnap] = await Promise.all([
        adminDb.collection('users').where('email', '==', email).get(),
        adminDb.collection('accountDeletions').where('email', '==', email).get(),
        adminDb.collection('users').doc(newUid).get(),
      ]);

      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const candidateUids = new Set<string>();

      duplicateProfiles.docs.forEach((d) => {
        if (d.id !== newUid) candidateUids.add(d.id);
      });
      deletionTombstones.docs.forEach((d) => {
        const deletedAt = new Date(d.data().deletedAt || 0).getTime();
        if (d.id !== newUid && Date.now() - deletedAt <= THIRTY_DAYS_MS) {
          candidateUids.add(d.id);
        }
      });

      if (candidateUids.size === 0) {
        return res.json({ merged: false, reason: 'No prior account found for this email.' });
      }

      const newProfile = newUserSnap.exists
        ? { displayName: newUserSnap.data()?.displayName, photoURL: newUserSnap.data()?.photoURL }
        : { displayName: decoded.name, photoURL: decoded.picture };

      const summaries = [];
      for (const oldUid of candidateUids) {
        summaries.push({ oldUid, ...(await mergeUidData(adminDb, oldUid, newUid, newProfile)) });
      }

      return res.json({ merged: true, mergedFrom: Array.from(candidateUids), summaries });
    } catch (error) {
      console.error('merge-account error:', error);
      return res.status(500).json({ error: 'Unable to merge account data at this time.' });
    }
  });

  // ===================== Admin API =====================
  // Every route below requires a signed-in primary or secondary admin (requireAdmin), except
  // /api/admin/manage-admin which is further restricted to sachin.rajputs@gmail.com only.

  app.get('/api/admin/me', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) {
      return res.json({ isAdmin: false, isPrimaryAdmin: false, isSuperAdmin: false });
    }
    const primary = isPrimaryAdmin(decoded);
    return res.json({
      isAdmin: primary || (await isAnyAdmin(adminDb, decoded)),
      isPrimaryAdmin: primary,
      isSuperAdmin: isSuperAdmin(decoded),
    });
  });

  // Live-ish actual GCP spend, read from the BigQuery Billing Export dataset (`billing_export`,
  // enabled manually in the Billing Console — see project memory `project_playstore_release` /
  // the AdminDashboard.tsx comment history for context). No standard export API exists, so this
  // queries the export table directly; the table itself doesn't appear until ~24-48h after export
  // is first turned on, and even once it exists, data only starts from that point forward (no
  // backfill of past spend) with its own ~24h ingestion lag. `tableReady: false` tells the client
  // to show a "still setting up" state instead of a broken chart. The BigQuery client uses the
  // same Application Default Credentials as firebase-admin above — on Cloud Run that's the
  // service account (needs bigquery.dataViewer + bigquery.jobUser, granted separately), locally
  // it's whatever `gcloud auth application-default login` identity is active.
  const bigquery = new BigQuery({ projectId: 'familyledgerta' });
  let billingTableCache: { name: string | null; checkedAt: number } | null = null;

  async function findBillingExportTable(): Promise<string | null> {
    if (billingTableCache && Date.now() - billingTableCache.checkedAt < 60 * 60 * 1000) {
      return billingTableCache.name;
    }
    try {
      const [tables] = await bigquery.dataset('billing_export').getTables();
      const match = tables.find((t) => t.id?.startsWith('gcp_billing_export_v1_'));
      const name = match?.id || null;
      billingTableCache = { name, checkedAt: Date.now() };
      return name;
    } catch (err) {
      console.error('findBillingExportTable failed:', err);
      billingTableCache = { name: null, checkedAt: Date.now() };
      return null;
    }
  }

  app.get('/api/admin/cloud-cost', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded) return;

    try {
      const tableName = await findBillingExportTable();
      if (!tableName) {
        return res.json({ tableReady: false });
      }

      const query = `
        SELECT
          currency,
          SUM(CASE WHEN DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH) THEN net_cost ELSE 0 END) AS this_month,
          SUM(CASE WHEN DATE(usage_start_time) >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)
                     AND DATE(usage_start_time) < DATE_TRUNC(CURRENT_DATE(), MONTH) THEN net_cost ELSE 0 END) AS last_month,
          SUM(CASE WHEN DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) THEN net_cost ELSE 0 END) AS last_7_days,
          MIN(usage_start_time) AS earliest
        FROM (
          SELECT
            cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0) AS net_cost,
            currency,
            usage_start_time
          FROM \`familyledgerta.billing_export.${tableName}\`
          WHERE DATE(usage_start_time) >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)
        )
        GROUP BY currency
        ORDER BY this_month DESC
        LIMIT 1
      `;
      const [rows] = await bigquery.query({ query });
      if (rows.length === 0) {
        return res.json({ tableReady: true, hasData: false });
      }
      const row = rows[0];
      return res.json({
        tableReady: true,
        hasData: true,
        currency: row.currency,
        thisMonth: Number(row.this_month) || 0,
        lastMonth: Number(row.last_month) || 0,
        last7Days: Number(row.last_7_days) || 0,
        earliest: row.earliest?.value || row.earliest || null,
      });
    } catch (error) {
      console.error('admin/cloud-cost error:', error);
      return res.status(500).json({ error: 'Unable to load cloud cost data.' });
    }
  });

  app.get('/api/admin/overview', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    try {
      // "Today" here means the current UTC calendar day (matches AdminUsers.tsx's `Joined`/`Last
      // Active` columns, which just show `new Date(...).toLocaleDateString()` — a plain date, not
      // a rolling window) — NOT "the last 24 hours". Those are genuinely different measures that
      // can diverge a lot depending on what time of day you check (e.g. at 3 AM, "last 24 hours"
      // still counts most of yesterday evening's activity, which no user would call "today"). This
      // was the actual cause of the two screens showing different active-user counts — not a data
      // bug, but a definition mismatch between this endpoint and how the numbers were displayed
      // elsewhere. `weekAgo` is left as a genuine rolling 7-day window since there's no calendar
      // "week" grid anywhere else in the admin UI to stay consistent with.
      const todayStartUtc = new Date().toISOString().split('T')[0] + 'T00:00:00.000Z';
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [usersSnap, groupsSnap, expensesSnap] = await Promise.all([
        db.collection('users').select('country', 'lastActiveAt', 'joinedAt').get(),
        db.collection('groups').select('createdBy').get(),
        db.collection('expenses').select('addedBy', 'amount').get(),
      ]);

      const uidToCountry = new Map<string, string>();
      let activeUsersToday = 0;
      let activeUsersThisWeek = 0;
      let newUsersToday = 0;

      type CountryStats = { country: string; users: number; groups: number; expenses: number; totalSpend: number; activeToday: number };
      const countryStats = new Map<string, CountryStats>();
      const getBucket = (country: string): CountryStats => {
        if (!countryStats.has(country)) {
          countryStats.set(country, { country, users: 0, groups: 0, expenses: 0, totalSpend: 0, activeToday: 0 });
        }
        return countryStats.get(country)!;
      };

      usersSnap.docs.forEach((d) => {
        const data = d.data();
        const country = data.country || 'Unknown';
        uidToCountry.set(d.id, country);
        const bucket = getBucket(country);
        bucket.users += 1;

        const isActiveToday = data.lastActiveAt && data.lastActiveAt >= todayStartUtc;
        if (isActiveToday) {
          activeUsersToday += 1;
          bucket.activeToday += 1;
        }
        if (data.lastActiveAt && data.lastActiveAt >= weekAgo) activeUsersThisWeek += 1;
        if (data.joinedAt && data.joinedAt >= todayStartUtc) newUsersToday += 1;
      });

      groupsSnap.docs.forEach((d) => {
        const country = uidToCountry.get(d.data().createdBy) || 'Unknown';
        getBucket(country).groups += 1;
      });

      let totalSpend = 0;
      expensesSnap.docs.forEach((d) => {
        const data = d.data();
        const amount = data.amount || 0;
        totalSpend += amount;
        const country = uidToCountry.get(data.addedBy) || 'Unknown';
        const bucket = getBucket(country);
        bucket.expenses += 1;
        bucket.totalSpend += amount;
      });

      const countryBreakdown = Array.from(countryStats.values()).sort((a, b) => b.users - a.users);

      return res.json({
        totalUsers: usersSnap.size,
        totalGroups: groupsSnap.size,
        totalExpenses: expensesSnap.size,
        totalSpendAllTime: totalSpend,
        activeUsersToday,
        activeUsersThisWeek,
        newUsersToday,
        countryBreakdown,
      });
    } catch (error) {
      console.error('admin/overview error:', error);
      return res.status(500).json({ error: 'Unable to load overview.' });
    }
  });

  app.get('/api/admin/users', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    try {
      const search = normalizeEmail(String(req.query.search || ''));
      // `offset`/`limit` page through the in-memory-filtered, in-memory-SORTED list (not a
      // Firestore cursor) — this endpoint already pulls up to 500 users into memory and filters
      // by search there, so paging is just a slice of that same array. Defaults to pages of 20
      // for the admin Users table's "load next 20" button.
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
      const sortKey = String(req.query.sortKey || 'joinedAt');
      const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';
      const usersSnap = await db.collection('users').orderBy('joinedAt', 'desc').limit(500).get();
      const adminsSnap = await db.collection('admins').get();
      const adminUids = new Set(adminsSnap.docs.map((d) => d.id));

      let allUsers = usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() } as any));
      if (search) {
        allUsers = allUsers.filter(
          (u) => (u.email || '').toLowerCase().includes(search) || (u.displayName || '').toLowerCase().includes(search),
        );
      }
      const totalMatched = allUsers.length;
      // Aggregated (group/expense/spend) for EVERY matched user, not just whatever page is about
      // to be sliced out below — sorting by one of those aggregate columns needs the full matched
      // set ranked BEFORE paging, otherwise "sort by Expenses" only ever reorders whichever users
      // happened to already be loaded (by join date, unrelated to expense count), silently
      // hiding/misplacing anyone not on the first page. The Firestore reads below were already a
      // full unfiltered collection scan either way, so widening which uids the in-memory
      // aggregation keeps costs nothing extra.
      const allUidSet = new Set(allUsers.map((u) => u.uid));

      // Bulk-fetch once and aggregate in memory instead of N+1 queries per user — this
      // endpoint previously issued 2 queries per user (up to 200 reads for 100 users).
      const [membersSnap, expensesSnap] = await Promise.all([
        db.collection('members').select('userId').get(),
        db.collection('expenses').select('addedBy', 'amount').get(),
      ]);

      const groupCountByUid = new Map<string, number>();
      membersSnap.docs.forEach((d) => {
        const uid = d.data().userId;
        if (allUidSet.has(uid)) groupCountByUid.set(uid, (groupCountByUid.get(uid) || 0) + 1);
      });

      const spendByUid = new Map<string, { total: number; count: number }>();
      expensesSnap.docs.forEach((d) => {
        const data = d.data();
        if (!allUidSet.has(data.addedBy)) return;
        const entry = spendByUid.get(data.addedBy) || { total: 0, count: 0 };
        entry.total += data.amount || 0;
        entry.count += 1;
        spendByUid.set(data.addedBy, entry);
      });

      const dateVal = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0);
      const sortValue = (u: any): number => {
        switch (sortKey) {
          case 'lastActiveAt':
            return dateVal(u.lastActiveAt);
          case 'groupCount':
            return groupCountByUid.get(u.uid) || 0;
          case 'expenseCount':
            return spendByUid.get(u.uid)?.count || 0;
          case 'totalSpend':
            return spendByUid.get(u.uid)?.total || 0;
          case 'joinedAt':
          default:
            return dateVal(u.joinedAt);
        }
      };
      allUsers.sort((a, b) => (sortDir === 'asc' ? sortValue(a) - sortValue(b) : sortValue(b) - sortValue(a)));

      const users = allUsers.slice(offset, offset + limit);

      // Password-reset only makes sense for email/password accounts — look up each user's
      // sign-in providers (getUsers supports up to 100 identifiers per call, matching our cap).
      const hasPasswordByUid = new Map<string, boolean>();
      if (adminAuth) {
        try {
          const lookup = await adminAuth.getUsers(users.map((u) => ({ uid: u.uid })));
          lookup.users.forEach((rec) => {
            hasPasswordByUid.set(rec.uid, rec.providerData.some((p) => p.providerId === 'password'));
          });
        } catch (err) {
          console.error('admin/users getUsers lookup failed:', err);
        }
      }

      const enriched = users.map((u) => ({
        uid: u.uid,
        email: u.email || '',
        displayName: u.displayName || '',
        photoURL: u.photoURL || '',
        country: u.country || 'Unknown',
        joinedAt: u.joinedAt || null,
        lastActiveAt: u.lastActiveAt || null,
        groupCount: groupCountByUid.get(u.uid) || 0,
        expenseCount: spendByUid.get(u.uid)?.count || 0,
        totalSpend: spendByUid.get(u.uid)?.total || 0,
        hasPassword: hasPasswordByUid.get(u.uid) || false,
        isAdmin: adminUids.has(u.uid) || PRIMARY_ADMIN_UIDS.includes(u.uid) || PRIMARY_ADMIN_EMAILS.includes(normalizeEmail(u.email || '')),
        isPrimaryAdmin: PRIMARY_ADMIN_UIDS.includes(u.uid) || PRIMARY_ADMIN_EMAILS.includes(normalizeEmail(u.email || '')),
      }));

      return res.json({ users: enriched, total: totalMatched, offset, limit, hasMore: offset + limit < totalMatched });
    } catch (error) {
      console.error('admin/users error:', error);
      return res.status(500).json({ error: 'Unable to load users.' });
    }
  });

  app.get('/api/admin/users/:uid', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;
    const targetUid = req.params.uid;

    try {
      const [userSnap, privateSnap, membersSnap] = await Promise.all([
        db.collection('users').doc(targetUid).get(),
        db.collection('users').doc(targetUid).collection('private').doc('info').get(),
        db.collection('members').where('userId', '==', targetUid).get(),
      ]);

      if (!userSnap.exists) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const groupIds = membersSnap.docs.map((d) => d.data().groupId);
      const groupsSnaps = groupIds.length
        ? await Promise.all(groupIds.map((gid) => db.collection('groups').doc(gid).get()))
        : [];
      const groups = membersSnap.docs.map((m, i) => ({
        groupId: m.data().groupId,
        role: m.data().role,
        name: groupsSnaps[i]?.exists ? groupsSnaps[i]!.data()!.name : '(deleted group)',
        currency: groupsSnaps[i]?.exists ? groupsSnaps[i]!.data()!.currency : null,
      }));

      const [expensesAddedSnap, activitiesSnap] = await Promise.all([
        db.collection('expenses').where('addedBy', '==', targetUid).orderBy('createdAt', 'desc').limit(200).get(),
        db.collection('activities').where('userId', '==', targetUid).orderBy('createdAt', 'desc').limit(100).get(),
      ]);

      return res.json({
        profile: { uid: targetUid, ...userSnap.data(), private: privateSnap.exists ? privateSnap.data() : null },
        groups,
        expenses: expensesAddedSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        activities: activitiesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      });
    } catch (error) {
      console.error('admin/users/:uid error:', error);
      return res.status(500).json({ error: 'Unable to load user detail.' });
    }
  });

  app.post('/api/admin/users/reset-password', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminAuth) return;

    const email = normalizeEmail(String(req.body.email || ''));
    const newPassword = String(req.body.newPassword || '');
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    try {
      const userRecord = await adminAuth.getUserByEmail(email);
      await adminAuth.updateUser(userRecord.uid, { password: newPassword });
      return res.json({ ok: true, message: `Password reset for ${email}.` });
    } catch (error: any) {
      if (error?.code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'No account found for that email.' });
      }
      console.error('admin/reset-password error:', error);
      return res.status(500).json({ error: 'Unable to reset password.' });
    }
  });

  // Deletes one category of a user's data (expenses they added, activities they logged, or
  // groups they own — leaving other members' data untouched).
  app.delete('/api/admin/users/:uid/data', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;
    const targetUid = req.params.uid;
    const type = String(req.query.type || '');

    try {
      let deleted = 0;
      if (type === 'expenses') {
        const snap = await db.collection('expenses').where('addedBy', '==', targetUid).get();
        await commitInChunks(db, snap.docs.map((d) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(d.ref)));
        deleted = snap.size;
      } else if (type === 'activities') {
        const snap = await db.collection('activities').where('userId', '==', targetUid).get();
        await commitInChunks(db, snap.docs.map((d) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(d.ref)));
        deleted = snap.size;
      } else if (type === 'groups') {
        // Only groups this user owns; also removes their memberships in them.
        const ownedSnap = await db.collection('groups').where('createdBy', '==', targetUid).get();
        const ops: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
        for (const g of ownedSnap.docs) {
          const membersSnap = await db.collection('members').where('groupId', '==', g.id).get();
          membersSnap.docs.forEach((m) => ops.push((batch) => batch.delete(m.ref)));
          ops.push((batch) => batch.delete(g.ref));
        }
        await commitInChunks(db, ops);
        deleted = ownedSnap.size;
      } else {
        return res.status(400).json({ error: 'type must be one of: expenses, activities, groups.' });
      }
      return res.json({ ok: true, deleted });
    } catch (error) {
      console.error('admin/users/:uid/data error:', error);
      return res.status(500).json({ error: 'Unable to delete data.' });
    }
  });

  // Full wipe of every record tied to an email: Auth account, profile, memberships, owned
  // groups (and their members), expenses (added or paid by them), activities.
  app.post('/api/admin/wipe-by-email', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminAuth || !adminDb) return;
    const db = adminDb;

    const email = normalizeEmail(String(req.body.email || ''));
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
      const usersSnap = await db.collection('users').where('email', '==', email).get();
      if (usersSnap.empty) {
        return res.status(404).json({ error: 'No account found for that email.' });
      }

      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const ops: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];

        const membersSnap = await db.collection('members').where('userId', '==', uid).get();
        membersSnap.docs.forEach((d) => ops.push((batch) => batch.delete(d.ref)));

        const ownedGroupsSnap = await db.collection('groups').where('createdBy', '==', uid).get();
        for (const g of ownedGroupsSnap.docs) {
          const groupMembersSnap = await db.collection('members').where('groupId', '==', g.id).get();
          groupMembersSnap.docs.forEach((m) => ops.push((batch) => batch.delete(m.ref)));
          const groupExpensesSnap = await db.collection('expenses').where('groupId', '==', g.id).get();
          groupExpensesSnap.docs.forEach((e) => ops.push((batch) => batch.delete(e.ref)));
          ops.push((batch) => batch.delete(g.ref));
        }

        const [addedExpensesSnap, paidExpensesSnap, activitiesSnap] = await Promise.all([
          db.collection('expenses').where('addedBy', '==', uid).get(),
          db.collection('expenses').where('paidBy', '==', uid).get(),
          db.collection('activities').where('userId', '==', uid).get(),
        ]);
        addedExpensesSnap.docs.forEach((d) => ops.push((batch) => batch.delete(d.ref)));
        paidExpensesSnap.docs.forEach((d) => ops.push((batch) => batch.delete(d.ref)));
        activitiesSnap.docs.forEach((d) => ops.push((batch) => batch.delete(d.ref)));

        ops.push((batch) => batch.delete(db.collection('users').doc(uid).collection('private').doc('info')));
        ops.push((batch) => batch.delete(db.collection('users').doc(uid)));
        ops.push((batch) => batch.delete(db.collection('admins').doc(uid)));
        ops.push((batch) => batch.delete(db.collection('accountDeletions').doc(uid)));

        await commitInChunks(db, ops);

        try {
          await adminAuth.deleteUser(uid);
        } catch (err: any) {
          if (err?.code !== 'auth/user-not-found') throw err;
        }
      }

      return res.json({ ok: true, wipedUids: usersSnap.docs.map((d) => d.id) });
    } catch (error) {
      console.error('admin/wipe-by-email error:', error);
      return res.status(500).json({ error: 'Unable to wipe account data.' });
    }
  });

  app.get('/api/admin/analytics/top', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    try {
      const [groupsSnap, expensesSnap, usersSnap] = await Promise.all([
        db.collection('groups').get(),
        db.collection('expenses').select('groupId', 'addedBy', 'amount').get(),
        db.collection('users').select('displayName', 'email').get(),
      ]);

      const userNames = new Map(usersSnap.docs.map((d) => [d.id, d.data().displayName || d.data().email || d.id]));

      const groupStats = new Map<string, { name: string; totalSpend: number; entryCount: number }>();
      groupsSnap.docs.forEach((g) => groupStats.set(g.id, { name: g.data().name || '(unnamed)', totalSpend: 0, entryCount: 0 }));

      const userStats = new Map<string, { name: string; totalSpend: number; entryCount: number }>();

      expensesSnap.docs.forEach((e) => {
        const data = e.data();
        const gs = groupStats.get(data.groupId);
        if (gs) {
          gs.totalSpend += data.amount || 0;
          gs.entryCount += 1;
        }
        const uid = data.addedBy;
        if (uid) {
          if (!userStats.has(uid)) {
            userStats.set(uid, { name: userNames.get(uid) || uid, totalSpend: 0, entryCount: 0 });
          }
          const us = userStats.get(uid)!;
          us.totalSpend += data.amount || 0;
          us.entryCount += 1;
        }
      });

      const topGroups = Array.from(groupStats.entries())
        .map(([groupId, s]) => ({ groupId, ...s }))
        .sort((a, b) => b.totalSpend - a.totalSpend)
        .slice(0, 15);
      const topUsers = Array.from(userStats.entries())
        .map(([uid, s]) => ({ uid, ...s }))
        .sort((a, b) => b.totalSpend - a.totalSpend)
        .slice(0, 15);

      return res.json({ topGroups, topUsers });
    } catch (error) {
      console.error('admin/analytics/top error:', error);
      return res.status(500).json({ error: 'Unable to load analytics.' });
    }
  });

  app.get('/api/admin/analytics/usage-trend', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    try {
      const days = Math.min(Math.max(parseInt(String(req.query.days || '30'), 10) || 30, 1), 90);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const loginEventsSnap = await db.collection('loginEvents').where('createdAt', '>=', since).get();

      const perDay = new Map<string, { logins: number; uniqueUsers: Set<string> }>();
      loginEventsSnap.docs.forEach((d) => {
        const data = d.data();
        const day = String(data.createdAt).slice(0, 10);
        if (!perDay.has(day)) perDay.set(day, { logins: 0, uniqueUsers: new Set() });
        const bucket = perDay.get(day)!;
        bucket.logins += 1;
        bucket.uniqueUsers.add(data.uid);
      });

      const trend = Array.from(perDay.entries())
        .map(([day, b]) => ({ day, logins: b.logins, activeUsers: b.uniqueUsers.size }))
        .sort((a, b) => a.day.localeCompare(b.day));

      return res.json({ trend });
    } catch (error) {
      console.error('admin/analytics/usage-trend error:', error);
      return res.status(500).json({ error: 'Unable to load usage trend.' });
    }
  });

  app.get('/api/admin/analytics/inactive', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    try {
      const usersSnap = await db.collection('users').select('email', 'displayName', 'lastActiveAt', 'joinedAt').get();
      const now = Date.now();
      const users = usersSnap.docs
        .map((d) => {
          const data = d.data();
          const lastActive = data.lastActiveAt ? new Date(data.lastActiveAt).getTime() : new Date(data.joinedAt || 0).getTime();
          const daysInactive = Math.floor((now - lastActive) / (24 * 60 * 60 * 1000));
          return { uid: d.id, email: data.email || '', displayName: data.displayName || '', daysInactive };
        })
        .sort((a, b) => b.daysInactive - a.daysInactive);

      return res.json({ users });
    } catch (error) {
      console.error('admin/analytics/inactive error:', error);
      return res.status(500).json({ error: 'Unable to load inactivity report.' });
    }
  });

  // Every multiplayer game collection stamps `createdAt` (at creation, in every *Lobby.tsx) and
  // `finishedAt` (the moment `status` becomes 'finished', whether via a natural win or someone
  // ending it early — checked across every game type's server AND client-side finish paths
  // before building this) plus `playerUids` — consistent enough across all 7 game types to build
  // real hours-played/unique-player numbers from, without needing separate session-tracking
  // infrastructure. "Hours played" only counts FINISHED games (`finishedAt - createdAt`) — an
  // abandoned or still-in-progress game has no real end time, and using "now" as a stand-in would
  // make the number drift upward just from stale open tabs, not actual play.
  // `GAME_COLLECTIONS` itself now lives at the top of this file (also used by
  // computeUserWeeklyStats for /api/cron/send-weekly-summary) — see its definition there.

  app.get('/api/admin/analytics/games', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    try {
      const allUniquePlayers = new Set<string>();
      let grandTotalGames = 0;
      let grandTotalHours = 0;

      const perGame = await Promise.all(
        GAME_COLLECTIONS.map(async ({ key, label, collection }) => {
          const snap = await db.collection(collection).select('createdAt', 'finishedAt', 'status', 'playerUids').get();
          const uniquePlayers = new Set<string>();
          let finishedGames = 0;
          let inProgressGames = 0;
          let totalHours = 0;

          snap.docs.forEach((d) => {
            const data = d.data();
            (data.playerUids || []).forEach((uid: string) => {
              uniquePlayers.add(uid);
              allUniquePlayers.add(uid);
            });
            if (data.status === 'finished') {
              finishedGames += 1;
              if (data.createdAt && data.finishedAt) {
                const hours = (new Date(data.finishedAt).getTime() - new Date(data.createdAt).getTime()) / (60 * 60 * 1000);
                if (hours > 0) totalHours += hours;
              }
            } else if (data.status && data.status !== 'waiting') {
              inProgressGames += 1;
            }
          });

          grandTotalGames += snap.size;
          grandTotalHours += totalHours;

          return {
            key,
            label,
            totalGames: snap.size,
            finishedGames,
            inProgressGames,
            uniquePlayers: uniquePlayers.size,
            totalHours: Math.round(totalHours * 10) / 10,
          };
        }),
      );

      return res.json({
        games: perGame,
        summary: {
          totalGames: grandTotalGames,
          totalUniquePlayers: allUniquePlayers.size,
          totalHours: Math.round(grandTotalHours * 10) / 10,
        },
      });
    } catch (error) {
      console.error('admin/analytics/games error:', error);
      return res.status(500).json({ error: 'Unable to load game stats.' });
    }
  });

  app.get('/api/admin/admins', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('admins').get();
      return res.json({ admins: snap.docs.map((d) => ({ uid: d.id, ...d.data() })) });
    } catch (error) {
      console.error('admin/admins error:', error);
      return res.status(500).json({ error: 'Unable to load admin list.' });
    }
  });

  app.get('/api/admin/feedback', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('feedback').orderBy('createdAt', 'desc').limit(500).get();
      return res.json({ feedback: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
    } catch (error) {
      console.error('admin/feedback error:', error);
      return res.status(500).json({ error: 'Unable to load feedback.' });
    }
  });

  app.post('/api/admin/feedback/:id/resolve', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const feedbackRef = adminDb.collection('feedback').doc(req.params.id);
      await feedbackRef.set(
        { resolved: true, resolvedBy: decoded.email, resolvedAt: new Date().toISOString() },
        { merge: true },
      );

      // Notify the submitter their item was marked resolved — skipped if the admin resolving it
      // is also the submitter (self-action shouldn't self-notify, same rule as every other
      // feedback notification below).
      const feedbackSnap = await feedbackRef.get();
      const data = feedbackSnap.data();
      if (data?.userId && data.userId !== decoded.uid) {
        const tokens = await collectPushTokens(adminDb, [data.userId], 'notificationsEnabled');
        const typeLabel = FEEDBACK_TYPE_LABEL[data.type] || 'feedback';
        const title = `Your ${typeLabel} was marked resolved`;
        const body = data.text ? String(data.text).slice(0, 120) : '';
        await sendPush(tokens, title, body, { type: 'feedback_resolved', feedbackId: req.params.id });
        await logFeedActivity(adminDb, {
          userId: data.userId, type: 'feedback_resolved', description: body,
          userName: decoded.name || 'An admin',
          // Raw feedback `type` id (feedback/suggestion/bug), not the pre-composed English
          // label — FeedList.tsx maps it through its own translated noun at render time.
          data: { feedbackId: req.params.id, feedbackType: data.type || 'feedback', text: body },
        });
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/feedback/resolve error:', error);
      return res.status(500).json({ error: 'Unable to update feedback.' });
    }
  });

  app.delete('/api/admin/feedback/:id', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      await adminDb.collection('feedback').doc(req.params.id).delete();
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/feedback/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete feedback.' });
    }
  });

  // ===================== Game chat abuse reports =====================
  app.get('/api/admin/chat-reports', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('chatReports').orderBy('createdAt', 'desc').limit(500).get();
      return res.json({ reports: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
    } catch (error) {
      console.error('admin/chat-reports error:', error);
      return res.status(500).json({ error: 'Unable to load reports.' });
    }
  });

  app.post('/api/admin/chat-reports/:id/resolve', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      await adminDb.collection('chatReports').doc(req.params.id).set(
        { resolved: true, resolvedBy: decoded.email, resolvedAt: new Date().toISOString() },
        { merge: true },
      );
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/chat-reports/resolve error:', error);
      return res.status(500).json({ error: 'Unable to update report.' });
    }
  });

  // Deletes the actual offending message (Admin SDK — bypasses the "own message only" client
  // delete rule) in addition to resolving the report, giving this real teeth beyond just
  // record-keeping. The message may already be gone (player deleted their own, or a duplicate
  // report on the same message) — that's not an error, just a no-op delete.
  app.post('/api/admin/chat-reports/:id/delete-message', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const reportRef = adminDb.collection('chatReports').doc(req.params.id);
      const reportSnap = await reportRef.get();
      if (!reportSnap.exists) return res.status(404).json({ error: 'Report not found.' });
      const report = reportSnap.data()!;
      await adminDb.collection(report.gameType).doc(report.gameId).collection('comments').doc(report.commentId).delete().catch(() => {});
      await reportRef.set(
        { resolved: true, resolvedBy: decoded.email, resolvedAt: new Date().toISOString(), messageDeleted: true },
        { merge: true },
      );
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/chat-reports/delete-message error:', error);
      return res.status(500).json({ error: 'Unable to delete message.' });
    }
  });

  app.delete('/api/admin/chat-reports/:id', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      await adminDb.collection('chatReports').doc(req.params.id).delete();
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/chat-reports/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete report.' });
    }
  });

  // Notifies all admins (primary + secondary) when a user submits new feedback/suggestion/bug
  // report. Called by the client right after the Firestore write succeeds (see Feedback.tsx).
  // No indefinite article baked in ("suggestion", not "a suggestion") — this feeds both
  // `New ${typeLabel} from ${name}` (reads fine either way) and `Your ${typeLabel} was marked
  // resolved` (an article here reads as a typo: "Your a suggestion was marked resolved").
  const FEEDBACK_TYPE_LABEL: Record<string, string> = {
    feedback: 'feedback',
    suggestion: 'suggestion',
    bug: 'bug report',
  };
  app.post('/api/notify-new-feedback', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const feedbackId = String(req.body?.feedbackId || '');
    if (!feedbackId) return res.status(400).json({ error: 'feedbackId is required.' });

    try {
      const feedbackSnap = await adminDb.collection('feedback').doc(feedbackId).get();
      if (!feedbackSnap.exists) return res.json({ sent: 0 });
      const data = feedbackSnap.data()!;

      const adminUids = (await getAllAdminUids(adminDb)).filter((uid) => uid !== decoded.uid);
      if (adminUids.length === 0) return res.json({ sent: 0 });

      const typeLabel = FEEDBACK_TYPE_LABEL[data.type] || 'feedback';
      const title = `New ${typeLabel} from ${data.displayName || 'a user'}`;
      const body = data.text ? String(data.text).slice(0, 120) : '';
      const tokens = await collectPushTokens(adminDb, adminUids, 'notificationsEnabled');
      const sent = await sendPush(tokens, title, body, { type: 'admin_feedback', feedbackId });
      // Feed entry per admin — durable and visible even if push never fires (no token registered,
      // notifications disabled, web/PWA session, etc.), unlike the push above.
      await Promise.all(adminUids.map((uid) => logFeedActivity(adminDb, {
        userId: uid, type: 'admin_feedback', description: `${title}${body ? `: "${body}"` : ''}`,
        userName: data.displayName, data: { feedbackId },
      })));
      return res.json({ sent });
    } catch (error) {
      console.error('notify-new-feedback error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // Notifies the other side of a feedback conversation when a new reply is posted: if an
  // admin replies, the original submitter is notified; if the submitter replies, all admins
  // are notified. Called by the client right after posting the comment (see Feedback.tsx /
  // AdminFeedback.tsx).
  app.post('/api/notify-feedback-comment', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const feedbackId = String(req.body?.feedbackId || '');
    const commentText = String(req.body?.commentText || '');
    if (!feedbackId) return res.status(400).json({ error: 'feedbackId is required.' });

    try {
      const feedbackSnap = await adminDb.collection('feedback').doc(feedbackId).get();
      if (!feedbackSnap.exists) return res.json({ sent: 0 });
      const data = feedbackSnap.data()!;

      const callerIsAdmin = await isAnyAdmin(adminDb, decoded);
      const actorName = decoded.name || 'Someone';

      let recipientUids: string[];
      let title: string;
      let pushType: string;
      if (callerIsAdmin) {
        recipientUids = data.userId && data.userId !== decoded.uid ? [data.userId] : [];
        title = 'An admin replied to your feedback';
        pushType = 'feedback_reply';
      } else {
        recipientUids = (await getAllAdminUids(adminDb)).filter((uid) => uid !== decoded.uid);
        title = `${actorName} replied on a feedback thread`;
        pushType = 'admin_feedback';
      }
      if (recipientUids.length === 0) return res.json({ sent: 0 });

      const body = commentText ? commentText.slice(0, 120) : 'New reply';
      const tokens = await collectPushTokens(adminDb, recipientUids, 'notificationsEnabled');
      const sent = await sendPush(tokens, title, body, { type: pushType, feedbackId });
      // Same durable-Feed pairing as notify-new-feedback above — one personal entry per recipient
      // (the submitter if an admin replied, every other admin if the submitter replied).
      // `pushType === 'feedback_reply'` (admin -> submitter) is fully localized by FeedList.tsx
      // from `data.text` at render time; the reverse direction stays under the shared,
      // not-yet-localized `admin_feedback` type (admin-only, lower priority).
      await Promise.all(recipientUids.map((uid) => logFeedActivity(adminDb, {
        userId: uid, type: pushType, description: `${title}${body ? `: "${body}"` : ''}`,
        userName: actorName, data: { feedbackId, text: body },
      })));
      return res.json({ sent });
    } catch (error) {
      console.error('notify-feedback-comment error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // App version / force-update config, read publicly by the client (see UpdatePrompt.tsx) and
  // written only by admins here. `latestVersionCode` is compared against the installed native
  // app's versionCode (via @capacitor/app's App.getInfo()) — web/PWA use is unaffected since
  // there's no native build to be behind.
  app.get('/api/admin/app-version', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('app_config').doc('version').get();
      return res.json(snap.exists ? snap.data() : {});
    } catch (error) {
      console.error('admin/app-version get error:', error);
      return res.status(500).json({ error: 'Unable to load app version config.' });
    }
  });

  app.post('/api/admin/app-version', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;

    const latestVersionCode = Number(req.body?.latestVersionCode);
    const latestVersionName = String(req.body?.latestVersionName || '');
    const releaseNotes = String(req.body?.releaseNotes || '');
    if (!Number.isFinite(latestVersionCode) || latestVersionCode <= 0) {
      return res.status(400).json({ error: 'latestVersionCode must be a positive number.' });
    }

    try {
      await adminDb.collection('app_config').doc('version').set({
        latestVersionCode,
        latestVersionName,
        releaseNotes,
        updatedAt: new Date().toISOString(),
        updatedBy: decoded.email || decoded.uid,
      });
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/app-version post error:', error);
      return res.status(500).json({ error: 'Unable to save app version config.' });
    }
  });

  // Firestore caps a single document at 1MiB — with up to 5 resized-image data URIs plus an
  // 800-char message, a broadcast doc could get close to that. Rejects with a clear message
  // rather than letting the write throw a raw Firestore error.
  const BROADCAST_IMAGES_MAX_BYTES = 850_000;
  function broadcastImagesTooLarge(images: string[]): boolean {
    return images.reduce((sum, s) => sum + s.length, 0) > BROADCAST_IMAGES_MAX_BYTES;
  }

  // Last-sent broadcast, for AdminBroadcast.tsx to show as context before sending a new one.
  app.get('/api/admin/broadcast', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('app_config').doc('broadcast').get();
      return res.json(snap.exists ? snap.data() : {});
    } catch (error) {
      console.error('admin/broadcast get error:', error);
      return res.status(500).json({ error: 'Unable to load broadcast config.' });
    }
  });

  // Every broadcast ever sent or scheduled, newest first — the permanent record backing
  // AdminBroadcast.tsx's history list (Reuse / Edit / Cancel), distinct from `app_config/broadcast`
  // which only ever holds the single CURRENTLY-SHOWN one for BroadcastBanner.tsx's live listener.
  app.get('/api/admin/broadcast/history', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('broadcasts').orderBy('createdAt', 'desc').limit(50).get();
      return res.json({ broadcasts: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
    } catch (error) {
      console.error('admin/broadcast/history get error:', error);
      return res.status(500).json({ error: 'Unable to load broadcast history.' });
    }
  });

  // Broadcasts a message to the entire user base — either right now, or (if `scheduledFor` is a
  // future ISO timestamp) queued as a `broadcasts/{id}` doc with status 'scheduled' for
  // `processScheduledBroadcasts` (the per-minute cron job, see /api/cron/send-reminders) to fire
  // later. An immediate send: pushes a notification to every device (for anyone not currently in
  // the app) and writes `app_config/broadcast` carrying a fresh unique `id` — `BroadcastBanner.tsx`
  // (client) holds a live listener on that doc, so a user already in the app sees the floating
  // message the instant it's written, no push needed; anyone else sees it the next time they open
  // the app, since the listener re-fires on mount. Each user's `users/{uid}.lastSeenBroadcastId`
  // (set by the client on dismiss) is compared against the current broadcast's `id` so a given
  // message only ever shows once per user, no matter how many times they reopen the app — a new
  // broadcast gets a new `id`, which naturally breaks through that "already seen" state again.
  // Both paths also persist a permanent record to `broadcasts/{id}` (using the SAME id as
  // `app_config/broadcast.id` for an immediate send) for the history list.
  app.post('/api/admin/broadcast', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;

    const message = String(req.body?.message || '').trim();
    const title = String(req.body?.title || '').trim() || 'FamilyLedger';
    const images = Array.isArray(req.body?.images)
      ? req.body.images.filter((s: unknown) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 5)
      : [];
    const scheduledFor = req.body?.scheduledFor ? String(req.body.scheduledFor) : null;
    if (!message) {
      return res.status(400).json({ error: 'message is required.' });
    }
    if (message.length > 800) {
      return res.status(400).json({ error: 'message must be 800 characters or fewer.' });
    }
    if (scheduledFor && Number.isNaN(new Date(scheduledFor).getTime())) {
      return res.status(400).json({ error: 'scheduledFor must be a valid date.' });
    }
    if (broadcastImagesTooLarge(images)) {
      return res.status(400).json({ error: 'Those images are too large combined — remove one or use smaller photos.' });
    }

    try {
      const createdBy = decoded.email || decoded.uid;
      const broadcastId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) {
        await db.collection('broadcasts').doc(broadcastId).set({
          title,
          message,
          images,
          status: 'scheduled',
          scheduledFor,
          createdAt: new Date().toISOString(),
          createdBy,
        });
        return res.json({ ok: true, broadcastId, scheduled: true, scheduledFor });
      }

      await db.collection('app_config').doc('broadcast').set({
        id: broadcastId,
        title,
        message,
        images,
        createdAt: new Date().toISOString(),
        createdBy,
      });

      const usersSnap = await db.collection('users').select().get();
      const allUids = usersSnap.docs.map((d) => d.id);
      const tokens = await collectPushTokens(db, allUids, 'notificationsEnabled');
      const sent = await sendPush(tokens, title, message, { type: 'broadcast', broadcastId });

      await db.collection('broadcasts').doc(broadcastId).set({
        title,
        message,
        images,
        status: 'sent',
        createdAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        createdBy,
        recipientCount: allUids.length,
        pushSent: sent,
      });

      return res.json({ ok: true, broadcastId, recipientCount: allUids.length, pushSent: sent });
    } catch (error) {
      console.error('admin/broadcast post error:', error);
      return res.status(500).json({ error: 'Unable to send broadcast.' });
    }
  });

  // Edits a not-yet-sent scheduled broadcast in place. Already-sent ones are permanent history —
  // AdminBroadcast.tsx's "Reuse" instead loads a sent broadcast's content back into the compose
  // form as a starting point for a brand-new send.
  app.post('/api/admin/broadcast/:id', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;
    try {
      const ref = db.collection('broadcasts').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Broadcast not found.' });
      if (snap.data()!.status !== 'scheduled') {
        return res.status(400).json({ error: 'Only a not-yet-sent scheduled broadcast can be edited.' });
      }

      const message = String(req.body?.message || '').trim();
      const title = String(req.body?.title || '').trim() || 'FamilyLedger';
      const images = Array.isArray(req.body?.images)
        ? req.body.images.filter((s: unknown) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 5)
        : [];
      const scheduledFor = req.body?.scheduledFor ? String(req.body.scheduledFor) : null;
      if (!message) return res.status(400).json({ error: 'message is required.' });
      if (message.length > 800) return res.status(400).json({ error: 'message must be 800 characters or fewer.' });
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime()) || new Date(scheduledFor).getTime() <= Date.now()) {
        return res.status(400).json({ error: 'scheduledFor must be a future date.' });
      }
      if (broadcastImagesTooLarge(images)) {
        return res.status(400).json({ error: 'Those images are too large combined — remove one or use smaller photos.' });
      }

      await ref.update({ title, message, images, scheduledFor });
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/broadcast update error:', error);
      return res.status(500).json({ error: 'Unable to update broadcast.' });
    }
  });

  // Cancels a not-yet-sent scheduled broadcast — kept as a 'canceled' record rather than deleted,
  // so it still shows in history for context.
  app.delete('/api/admin/broadcast/:id', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const ref = adminDb.collection('broadcasts').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Broadcast not found.' });
      if (snap.data()!.status !== 'scheduled') {
        return res.status(400).json({ error: 'Only a scheduled broadcast can be canceled.' });
      }
      await ref.update({ status: 'canceled', canceledAt: new Date().toISOString() });
      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/broadcast cancel error:', error);
      return res.status(500).json({ error: 'Unable to cancel broadcast.' });
    }
  });

  // Grant or revoke secondary admin status. Restricted to sachin.rajputs@gmail.com exactly —
  // not the broader isPrimaryAdmin set — per explicit product requirement.
  app.post('/api/admin/manage-admin', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminAuth || !adminDb) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!isSuperAdmin(decoded)) {
      return res.status(403).json({ error: 'Only the primary admin account can manage admins.' });
    }

    const email = normalizeEmail(String(req.body.email || ''));
    const action = String(req.body.action || '');
    if (!email || !['add', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'email and action ("add" | "remove") are required.' });
    }

    try {
      const userRecord = await adminAuth.getUserByEmail(email);
      if (isPrimaryAdmin({ uid: userRecord.uid, email } as admin.auth.DecodedIdToken)) {
        return res.status(400).json({ error: 'This account is already a primary admin.' });
      }

      if (action === 'add') {
        await adminDb.collection('admins').doc(userRecord.uid).set({
          email,
          grantedAt: new Date().toISOString(),
          grantedBy: decoded.email,
        });
      } else {
        await adminDb.collection('admins').doc(userRecord.uid).delete();
      }

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'No account found for that email.' });
      }
      console.error('admin/manage-admin error:', error);
      return res.status(500).json({ error: 'Unable to update admin status.' });
    }
  });

  // ===================== Push notifications =====================

  app.post('/api/register-device-token', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const token = String(req.body.token || '');
    const platform = String(req.body.platform || 'unknown');
    if (!token) return res.status(400).json({ error: 'token is required.' });

    try {
      const ref = adminDb.collection('users').doc(decoded.uid).collection('private').doc('info');
      const snap = await ref.get();
      const existing: string[] = snap.exists ? snap.data()?.fcmTokens || [] : [];
      const tokens = Array.from(new Set([...existing, token]));
      await ref.set({ fcmTokens: tokens, updatedAt: new Date().toISOString() }, { merge: true });
      return res.json({ ok: true });
    } catch (error) {
      console.error('register-device-token error:', error);
      return res.status(500).json({ error: 'Unable to register device.' });
    }
  });

  // Called right before sign-out (see removeCurrentDeviceToken in pushNotifications.ts) so this
  // device's token stops being associated with the account that's signing out — otherwise it
  // keeps receiving that account's pushes even after a different account signs in on the same
  // device, landing notifications (and their tap-through navigation) on the wrong person's
  // session. Only ever removes the token from the CALLER's own account, never anyone else's.
  app.post('/api/unregister-device-token', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const token = String(req.body.token || '');
    if (!token) return res.status(400).json({ error: 'token is required.' });

    try {
      const ref = adminDb.collection('users').doc(decoded.uid).collection('private').doc('info');
      const snap = await ref.get();
      const existing: string[] = snap.exists ? snap.data()?.fcmTokens || [] : [];
      const tokens = existing.filter((t) => t !== token);
      await ref.set({ fcmTokens: tokens, updatedAt: new Date().toISOString() }, { merge: true });
      return res.json({ ok: true });
    } catch (error) {
      console.error('unregister-device-token error:', error);
      return res.status(500).json({ error: 'Unable to unregister device.' });
    }
  });

  // Sends a push to every OTHER member of a group when an expense is added/updated/deleted,
  // or when someone comments on an expense or in the group chat. Called by the client right
  // after the Firestore write succeeds (see AddExpense.tsx, GroupExpenses.tsx, Comments.tsx).
  // Respects each recipient's `notificationsEnabled` preference.
  app.post('/api/notify-group-activity', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const { groupId, action, description, amount, actorName, contextLabel, listId, expenseId } = req.body || {};
    if (!groupId || !action) {
      return res.status(400).json({ error: 'groupId and action are required.' });
    }

    try {
      const [membersSnap, groupSnap] = await Promise.all([
        adminDb.collection('members').where('groupId', '==', groupId).get(),
        adminDb.collection('groups').doc(groupId).get(),
      ]);
      const groupName = groupSnap.exists ? groupSnap.data()?.name || 'your group' : 'your group';
      const recipientUids = membersSnap.docs.map((d) => d.data().userId).filter((uid) => uid !== decoded.uid);
      if (recipientUids.length === 0) return res.json({ sent: 0 });

      const actionText: Record<string, string> = {
        added: 'added a new expense',
        updated: 'updated an expense',
        deleted: 'deleted an expense',
        commented: contextLabel ? `commented on "${contextLabel}"` : 'commented in the group',
        recurring_created: 'set up a recurring expense',
        recurring_changed: 'changed a recurring expense',
        recurring_deleted: 'deleted a recurring expense',
        shopping_list_created: 'created a shopping list',
        member_left: 'left the group',
        todo_created: 'added a new to-do',
        todo_completed: 'completed a to-do',
        budget_set: 'set the group budget',
        income_added: 'added income',
      };

      let title: string;
      let body: string;
      let pushType = 'group_activity';
      if (action === 'commented') {
        title = `${groupName}: New comment`;
        body = `${actorName || 'Someone'} ${actionText.commented}${description ? `: "${description}"` : ''}`;
        pushType = 'comment';
      } else if (action === 'recurring_created' || action === 'recurring_changed' || action === 'recurring_deleted') {
        title = `${groupName}: Recurring expense`;
        body = `${actorName || 'Someone'} ${actionText[action]}${description ? `: "${description}"` : ''}`;
        // Distinct from the generic 'group_activity' so the tap opens Recurring Expenses
        // (filtered to this group) directly, instead of the group's analysis summary page.
        pushType = 'recurring_activity';
      } else if (action === 'shopping_list_created') {
        title = `${groupName}: New shopping list`;
        body = `${actorName || 'Someone'} ${actionText.shopping_list_created}${description ? ` "${description}"` : ''}${contextLabel ? ` — scheduled for ${contextLabel}` : ''}. Add what you need!`;
        pushType = 'shopping_list';
      } else if (action === 'member_left') {
        title = `${groupName}: Member left`;
        body = `${actorName || 'Someone'} ${actionText.member_left}.`;
      } else if (action === 'todo_created') {
        title = `${groupName}: New to-do`;
        body = `${actorName || 'Someone'} ${actionText.todo_created}${description ? `: "${description}"` : ''}`;
        pushType = 'todo_created';
      } else if (action === 'todo_completed') {
        title = `${groupName}: To-do completed`;
        body = `${actorName || 'Someone'} ${actionText.todo_completed}${description ? `: "${description}"` : ''}`;
        pushType = 'todo_completed';
      } else if (action === 'budget_set') {
        title = `${groupName}: Budget updated`;
        body = `${actorName || 'Someone'} ${actionText.budget_set}${description ? `: ${description}` : ''}`;
        pushType = 'budget_set';
      } else {
        // Only 'added'/'updated'/'deleted'/'income_added' reach here (every other action has its
        // own branch above) — all genuinely expense-list activity, so this gets its own pushType
        // distinct from the generic 'group_activity' so the tap can open the expenses list
        // directly instead of just the group summary page.
        title = `${groupName}: ${actionText[action] || 'expense activity'}`;
        body = amount
          ? `${actorName || 'Someone'} ${actionText[action] || 'changed an expense'} — ${description || ''} (${amount})`
          : `${actorName || 'Someone'} ${actionText[action] || 'changed an expense'}${description ? `: ${description}` : ''}`;
        pushType = 'expense_activity';
      }

      const tokens = await collectPushTokens(adminDb, recipientUids, 'notificationsEnabled');
      const pushData: Record<string, string> = { type: pushType, groupId };
      if (listId) pushData.listId = listId;
      if (expenseId) pushData.expenseId = expenseId;
      const sent = await sendPush(tokens, title, body, pushData);
      return res.json({ sent });
    } catch (error) {
      console.error('notify-group-activity error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // Looks up an existing account by email for Personal Loans' "link this contact to their
  // account" flow — same getUserByEmail + swallow-not-found pattern as /api/invite-to-group,
  // just returning the match (or null) instead of sending an invite.
  app.post('/api/loans/find-user', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb || !adminAuth) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const email = normalizeEmail(String(req.body?.email || ''));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    try {
      let uid: string | null = null;
      try {
        uid = (await adminAuth.getUserByEmail(email)).uid;
      } catch (err: any) {
        if (err?.code !== 'auth/user-not-found') throw err;
      }
      if (!uid) return res.json({ uid: null });
      if (uid === decoded.uid) return res.status(400).json({ error: "That's your own account." });

      const userSnap = await db.collection('users').doc(uid).get();
      const userData = userSnap.data() || {};
      return res.json({ uid, displayName: userData.displayName || 'FamilyLedger user', photoURL: userData.photoURL || '' });
    } catch (error) {
      console.error('loans/find-user error:', error);
      return res.status(500).json({ error: 'Unable to look up that email.' });
    }
  });

  // Single-recipient push for Personal Loans activity (new ledger line, installment proposed/
  // accepted/declined, a "can't pay yet" message) — same shape as /api/notify-group-activity but
  // targeting one linked counterparty instead of a group's members, since a loan contact is a
  // 1:1 relationship, not a shared group. No-ops quietly if the target has no linked account
  // (nothing to push to) — the caller doesn't need to check that itself.
  app.post('/api/notify-loan-activity', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const targetUserId = String(req.body?.targetUserId || '');
    const action = String(req.body?.action || '');
    const contactName = String(req.body?.contactName || 'Someone');
    const description = req.body?.description ? String(req.body.description) : '';
    const amount = req.body?.amount != null ? Number(req.body.amount) : null;
    const contactId = String(req.body?.contactId || '');
    if (!targetUserId || !action) {
      return res.status(400).json({ error: 'targetUserId and action are required.' });
    }
    if (targetUserId === decoded.uid) return res.json({ sent: 0 });

    try {
      const actionText: Record<string, string> = {
        entry_given: 'recorded giving you money',
        entry_taken: 'recorded taking money from you',
        entry_repayment_by_them: 'recorded repaying you',
        entry_repayment_by_me: 'recorded that you repaid them',
        entry_note: 'added a note',
        installment_proposed: 'proposed an installment plan',
        installment_accepted: 'accepted the installment plan',
        installment_declined: 'declined the installment plan',
        commitment_message: "sent you a message about a payment",
        comment_added: 'commented on your loan record',
      };

      const title = `${contactName}: ${actionText[action] || 'updated your loan record'}`;
      const body = amount
        ? `${actionText[action] || 'made a change'}${description ? ` — ${description}` : ''} (${amount})`
        : `${actionText[action] || 'made a change'}${description ? `: ${description}` : ''}`;

      const tokens = await collectPushTokens(adminDb, [targetUserId], 'notificationsEnabled');
      const sent = await sendPush(tokens, title, body, { type: 'loan_activity', contactId });
      await logFeedActivity(adminDb, {
        userId: targetUserId, type: 'loan_activity', description: `${title} — ${body}`, userName: contactName, data: { contactId },
      });
      return res.json({ sent });
    } catch (error) {
      console.error('notify-loan-activity error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // --- Shopkeeper mode ---
  // Access is gated by admin approval: a user's `shopId`/`shopRole` (checked client-side to
  // decide whether the header's mode toggle shows at all) are excluded from what the client can
  // write to its own user doc (see firestore.rules) — every endpoint below is the *only* way
  // those fields, a shop doc, or a staff-roster entry can ever be created or changed.

  // Client writes its own shopkeeperRequests/{uid} doc directly (firestore.rules allows that,
  // forcing status to 'pending'), then calls this to fan the request out to admins — same
  // "client writes data, then pings a notify endpoint" split used by notify-group-activity etc.
  app.post('/api/notify-shopkeeper-request', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    try {
      const reqSnap = await adminDb.collection('shopkeeperRequests').doc(decoded.uid).get();
      if (!reqSnap.exists) return res.json({ sent: 0 });
      const data = reqSnap.data()!;

      const adminUids = await getAllAdminUids(adminDb);
      const tokens = await collectPushTokens(adminDb, adminUids, 'notificationsEnabled');
      const sent = await sendPush(
        tokens,
        'New Shopkeeper access request',
        `${data.userName || 'A user'} (${data.userEmail || ''}) wants to enable Shopkeeper mode.`,
        { type: 'shopkeeper_request' },
      );
      return res.json({ sent });
    } catch (error) {
      console.error('notify-shopkeeper-request error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // Invites specific users (picked from one of the caller's groups) to a Ludo game they've
  // already created client-side. The actual join (writing the invitee into the game's
  // players/playerUids) happens later, client-side, once they open the invite and tap Join —
  // this endpoint only ever sends a push, it can't add anyone to the game itself.
  app.post('/api/ludo/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('ludoGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: 'Ludo', routeSegment: 'ludo', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('ludo/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  // Host-only, and only while the game hasn't started (or is already over) — an active game has
  // other players mid-match. Same reasoning as Business's delete endpoint (also client-trusted,
  // no hands/secret subcollections to cascade) — this only exists so the code-pointer doc gets
  // cleaned up atomically rather than needing a separate client-side delete rule for it.
  app.post('/api/ludo/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('ludoGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (game.status === 'active') {
        return res.status(400).json({ error: 'Cannot delete a game in progress — end it instead, or wait for it to finish.' });
      }

      const batch = db.batch();
      if (game.code) batch.delete(db.collection('ludoGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('ludo/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  // Fired by whichever client just finished their move — tells the next player it's their turn.
  // No cron/polling involved: this fires the instant a turn actually changes, and picks one of
  // three outcomes based on the *recipient's* own presence (never the mover's):
  //   1. They're actively looking at this exact game right now (LudoGame.tsx's presence effect
  //      set `activeLudoGameId` to this gameId) — do nothing; their live Firestore listener
  //      already shows it's their turn, a push/indicator would just be noise.
  //   2. The app is open (AuthContext's presence heartbeat is fresh) but on some other screen —
  //      write a lightweight in-app indicator (`users/{uid}.ludoTurnIndicator`) instead of a
  //      push; LudoTurnIndicator.tsx shows it as a small tappable pill.
  //   3. The app is closed/backgrounded — send a real push, naming who they're playing against
  //      (pulled from the game doc) rather than a generic "it's your move".
  app.post('/api/notify-ludo-turn', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameId = String(req.body?.gameId || '');
    const nextPlayerUid = String(req.body?.nextPlayerUid || '');
    if (!gameId || !nextPlayerUid) return res.status(400).json({ error: 'gameId and nextPlayerUid are required.' });
    if (nextPlayerUid === decoded.uid) return res.json({ sent: 0 }); // your own turn continuing (rolled a 6/captured) needs no push

    try {
      const [userSnap, gameSnap] = await Promise.all([
        db.collection('users').doc(nextPlayerUid).get(),
        db.collection('ludoGames').doc(gameId).get(),
      ]);
      const userData = userSnap.data() || {};
      const game = gameSnap.data();
      const opponentNames = (game?.players || [])
        .filter((p: any) => p.uid !== nextPlayerUid)
        .map((p: any) => p.displayName)
        .filter(Boolean)
        .join(', ');

      if (userData.activeLudoGameId === gameId) {
        return res.json({ sent: 0, indicator: false, skipped: 'on_screen' });
      }

      const FOREGROUND_WINDOW_MS = 45000; // covers AuthContext's 25s heartbeat interval plus latency
      const foregroundedRecently = userData.appForegroundAt &&
        Date.now() - new Date(userData.appForegroundAt).getTime() < FOREGROUND_WINDOW_MS;

      if (foregroundedRecently) {
        await db.collection('users').doc(nextPlayerUid).set(
          { ludoTurnIndicator: { gameId, opponentNames: opponentNames || null, updatedAt: new Date().toISOString() } },
          { merge: true },
        );
        return res.json({ sent: 0, indicator: true });
      }

      const tokens = await collectPushTokens(db, [nextPlayerUid], 'notificationsEnabled');
      const body = opponentNames ? `It's your move against ${opponentNames}!` : "It's your move!";
      const sent = await sendPush(tokens, 'Ludo', body, { type: 'ludo_turn', gameId });
      return res.json({ sent, indicator: false });
    } catch (error) {
      console.error('notify-ludo-turn error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // Generic counterpart to /api/notify-ludo-turn for the other CLIENT-authoritative multiplayer
  // games (Business, Chess) — those games advance the turn via a direct client `updateDoc`, so
  // (unlike Rummy/Sweep/Sequence, which are server-mediated and call notifyGameTurn directly from
  // within their own turn-advancing endpoint) there's no natural server-side moment to hook this
  // into; the client calls this right after its own updateDoc succeeds, mirroring Ludo's
  // notifyNextPlayer pattern exactly.
  app.post('/api/notify-game-turn', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameType = String(req.body?.gameType || '');
    const gameId = String(req.body?.gameId || '');
    const nextPlayerUid = String(req.body?.nextPlayerUid || '');
    const opponentNames = req.body?.opponentNames ? String(req.body.opponentNames) : null;
    if (!gameType || !gameId || !nextPlayerUid) {
      return res.status(400).json({ error: 'gameType, gameId, and nextPlayerUid are required.' });
    }

    try {
      const result = await notifyGameTurn(db, { gameType, gameId, nextPlayerUid, movedByUid: decoded.uid, opponentNames });
      return res.json(result);
    } catch (error) {
      console.error('notify-game-turn error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // ===================== 27-Hand Rummy =====================
  // A custom variant (NOT the traditional "27 Card Rummy") — three combined 52-card decks (156
  // cards), up to 4 players each dealt a 27-card hand. This game has genuine hidden information
  // (opponents' hands, the undrawn stock) that Ludo/Sudoku never needed to deal with, so — unlike
  // those games' "client computes the move, firestore.rules just gate who can write" pattern —
  // every action that touches hidden state is mediated here, using the Admin SDK, which is the
  // only thing that can ever read/write a hand or the stock pile (see firestore.rules). The
  // validation engine below is a duplicate of the client's `src/lib/rummy.ts` copy (this project's
  // established convention: server.ts and the client bundle share no module graph) — this copy is
  // the authoritative one; the client's is only ever used for local UI hinting.

  const RUMMY_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RUMMY_SUITS = ['S', 'H', 'D', 'C'];
  const RUMMY_HAND_SIZE = 27;

  function buildRummyTripleDeck(): string[] {
    const deck: string[] = [];
    for (let d = 0; d < 3; d++) {
      for (const suit of RUMMY_SUITS) {
        for (const rank of RUMMY_RANKS) deck.push(`${rank}${suit}_${d}`);
      }
    }
    return deck; // 156 cards
  }

  // Draws the next card from the end of `deck` whose RANK differs from `excludeRank` — used so the
  // two joker reveals can never share a rank (drawing them naively could otherwise land on, say,
  // two different-suit 7s, which would collapse the "two distinct wildcard ranks" design). Cards
  // skipped over are pushed back into the deck (order doesn't matter, they end up in the stock
  // pile either way) rather than discarded.
  function rummyDrawDistinctRankCard(deck: string[], excludeRank: string): string {
    const setAside: string[] = [];
    let found: string | null = null;
    while (deck.length > 0) {
      const candidate = deck.pop()!;
      if (rummyParseCard(candidate).rank !== excludeRank) {
        found = candidate;
        break;
      }
      setAside.push(candidate);
    }
    deck.push(...setAside);
    if (!found) throw { status: 500, message: 'Unable to draw a distinct second joker.' };
    return found;
  }

  function rummyShuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function rummyParseCard(id: string): { rank: string; suit: string } {
    const face = id.split('_')[0];
    return { rank: face.slice(0, -1), suit: face.slice(-1) };
  }

  function rummyRankIndex(rank: string, aceHigh: boolean): number {
    if (rank === 'A') return aceHigh ? 13 : 0;
    return RUMMY_RANKS.indexOf(rank);
  }

  // Pure sequence: 3+ cards, one suit, genuinely consecutive ranks (ace-low OR ace-high, no
  // wraparound), no wildcard-rank card used to fill a gap (one may still appear at its own
  // natural position without disqualifying the run). Same suit AND same rank (e.g. three 7H's
  // from three different decks) counts as pure too, not just a genuine consecutive run —
  // consistent with same-suit sets being legal here.
  function rummyIsPureSequence(cardIds: string[]): boolean {
    if (cardIds.length < 3) return false;
    const parsed = cardIds.map(rummyParseCard);
    const suit = parsed[0].suit;
    if (!parsed.every((c) => c.suit === suit)) return false;
    if (parsed.every((c) => c.rank === parsed[0].rank)) return true;
    for (const aceHigh of [false, true]) {
      const idxs = parsed.map((c) => rummyRankIndex(c.rank, aceHigh)).sort((a, b) => a - b);
      if (new Set(idxs).size !== idxs.length) continue;
      let ok = true;
      for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  // Sequence (pure or impure) allowing wildcard-rank cards to fill gaps in an otherwise-consecutive
  // same-suit run.
  function rummyIsValidSequence(cardIds: string[], wildcardRanks: string[]): boolean {
    if (cardIds.length < 3) return false;
    const parsed = cardIds.map(rummyParseCard);
    const naturals = parsed.filter((c) => !wildcardRanks.includes(c.rank));
    const wilds = parsed.filter((c) => wildcardRanks.includes(c.rank));
    if (naturals.length === 0) return true; // all-wildcard group
    const suit = naturals[0].suit;
    if (!naturals.every((c) => c.suit === suit)) return false;
    const n = cardIds.length;
    for (const aceHigh of [false, true]) {
      const naturalIdxs = naturals.map((c) => rummyRankIndex(c.rank, aceHigh));
      if (new Set(naturalIdxs).size !== naturalIdxs.length) continue;
      const minIdx = Math.min(...naturalIdxs);
      const maxIdx = Math.max(...naturalIdxs);
      if (maxIdx - minIdx + 1 > n) continue;
      const maxStart = Math.min(minIdx, (aceHigh ? 14 : 13) - n);
      const minStart = Math.max(0, maxIdx - n + 1);
      for (let start = minStart; start <= maxStart; start++) {
        const windowIdxs = new Set(Array.from({ length: n }, (_, i) => start + i));
        if (!naturalIdxs.every((i) => windowIdxs.has(i))) continue;
        const gaps = n - naturalIdxs.length;
        if (gaps === wilds.length) return true;
      }
    }
    return false;
  }

  // Set: 3-4 cards, same rank. Suits must be either ALL the same (e.g. three separate 7H_0/7H_1/
  // 7H_2 from three different decks — legal here since the deck is tripled) or ALL different from
  // each other (the traditional one-of-each-suit set, e.g. AS/AH/AD). A PARTIAL match — two of one
  // suit plus one of another, e.g. AD_0/AD_1/AS — is not valid either way and must be rejected.
  function rummyIsValidSet(cardIds: string[], wildcardRanks: string[]): boolean {
    if (cardIds.length < 3 || cardIds.length > 4) return false;
    const parsed = cardIds.map(rummyParseCard);
    const naturals = parsed.filter((c) => !wildcardRanks.includes(c.rank));
    const wilds = parsed.filter((c) => wildcardRanks.includes(c.rank));
    if (naturals.length === 0) return true;
    const rank = naturals[0].rank;
    if (!naturals.every((c) => c.rank === rank)) return false;
    if (naturals.length + wilds.length !== cardIds.length) return false;
    const suitCounts = new Set(naturals.map((c) => c.suit));
    const allSameSuit = suitCounts.size === 1;
    const allDistinctSuits = suitCounts.size === naturals.length;
    if (!allSameSuit && !allDistinctSuits) return false;
    return true;
  }

  function rummyIsValidGroup(cardIds: string[], wildcardRanks: string[]): boolean {
    return rummyIsValidSequence(cardIds, wildcardRanks) || rummyIsValidSet(cardIds, wildcardRanks);
  }

  // Next seat that hasn't dropped out — wraps around; falls back to the same seat if everyone
  // else has dropped (the auto-win check elsewhere ends the game before this can matter).
  function rummyNextActiveSeat(players: any[], fromSeatIndex: number): number {
    const n = players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromSeatIndex + step) % n;
      if (!players[idx]?.dropped) return idx;
    }
    return fromSeatIndex;
  }

  function rummyArraysSameMultiset(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const counts = new Map<string, number>();
    for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
    for (const x of b) {
      const c = counts.get(x) || 0;
      if (c === 0) return false;
      counts.set(x, c - 1);
    }
    return true;
  }

  // Same alphabet/shape as the client's generateGameCode() in src/lib/rummy.ts and
  // src/lib/business.ts (no 0/O/1/I) — duplicated here since server.ts and the client bundle
  // share no module graph. Shared by both Rummy's and Business's rematch endpoints.
  function generateShareCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  // Invites specific users (picked from one of the caller's groups) to a Rummy game they've
  // already created client-side — same shape as /api/ludo/invite. This only ever sends a push;
  // the actual join (adding the invitee into players/playerUids) happens client-side once they
  // open the invite and tap Join, same as Ludo.
  app.post('/api/rummy/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('rummyGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: '27-Hand Rummy', routeSegment: 'rummy', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('rummy/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  app.post('/api/rummy/start', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can start the game.' });
      if (game.status !== 'waiting') return res.status(400).json({ error: 'Game already started.' });
      const players: any[] = game.players || [];
      if (players.length < 2) return res.status(400).json({ error: 'Need at least 2 players to start.' });

      let deck = rummyShuffle(buildRummyTripleDeck());
      const hands: Record<string, string[]> = {};
      for (const p of players) {
        hands[p.uid] = deck.slice(0, RUMMY_HAND_SIZE);
        deck = deck.slice(RUMMY_HAND_SIZE);
      }
      const jokerCard1 = deck.pop()!;
      const jokerCard2 = rummyDrawDistinctRankCard(deck, rummyParseCard(jokerCard1).rank);
      const starterDiscard = deck.pop()!;
      const stock = deck;

      const batch = db.batch();
      for (const p of players) {
        batch.set(gameRef.collection('hands').doc(p.uid), { cards: hands[p.uid] });
      }
      batch.set(gameRef.collection('secret').doc('stock'), { cards: stock });
      batch.update(gameRef, {
        status: 'active',
        startedAt: new Date().toISOString(),
        currentTurnSeatIndex: 0,
        turnPhase: 'draw',
        stockCount: stock.length,
        // Each discard pile entry tracks whether it's locked from pickup (see /api/rummy/discard
        // for how that's decided) alongside the card itself — the starter card is never locked,
        // even if its rank happens to match the joker rank: nobody "discarded" it as a
        // known-joker, it's just the default open card, and picking it up is explicitly allowed
        // for this one starter card only. Every later discard of a joker-rank card locks normally.
        discardPile: [{ card: starterDiscard, locked: false }],
        wildcardRank1: rummyParseCard(jokerCard1).rank,
        wildcardRank2: rummyParseCard(jokerCard2).rank,
        jokerCard1,
        jokerCard2,
        players: players.map((p) => ({
          ...p,
          handCount: RUMMY_HAND_SIZE,
          hasSecondJoker: false,
          pureRun543At: null,
          dropped: false,
        })),
      });
      await batch.commit();
      return res.json({ ok: true });
    } catch (error) {
      console.error('rummy/start error:', error);
      return res.status(500).json({ error: 'Unable to start game.' });
    }
  });

  app.post('/api/rummy/draw', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const source = req.body?.source === 'discard' ? 'discard' : 'stock';
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      const handRef = gameRef.collection('hands').doc(decoded.uid);
      const stockRef = gameRef.collection('secret').doc('stock');

      const result = await db.runTransaction(async (tx) => {
        const [gameSnap, handSnap, stockSnap] = await Promise.all([tx.get(gameRef), tx.get(handRef), tx.get(stockRef)]);
        if (!gameSnap.exists || !handSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players || [];
        const mySeat = players[game.currentTurnSeatIndex];
        if (!mySeat || mySeat.uid !== decoded.uid) throw { status: 403, message: 'Not your turn.' };
        if (game.turnPhase !== 'draw') throw { status: 400, message: 'You have already drawn this turn.' };

        const hand = handSnap.data()!;
        let stock: string[] = stockSnap.exists ? (stockSnap.data()!.cards || []) : [];
        let discardPile: { card: string; locked: boolean }[] = game.discardPile || [];
        let drawnCard: string;

        if (source === 'discard') {
          if (discardPile.length === 0) throw { status: 400, message: 'Discard pile is empty.' };
          const top = discardPile[discardPile.length - 1];
          // A joker-rank card is only dead in the discard pile if the player who discarded it had
          // actually SEEN it as a joker at that moment — the common joker (rank1) is public
          // knowledge from the start, but the second joker (rank2) only counts once that specific
          // discarder had personally unlocked it. `locked` was decided once, at discard time, in
          // /api/rummy/discard — this is just reading that decision back.
          if (top.locked) {
            throw { status: 400, message: 'That\'s a joker — it can\'t be picked up from the discard pile. Draw from stock instead.' };
          }
          drawnCard = top.card;
          discardPile = discardPile.slice(0, -1);
        } else {
          if (stock.length === 0) {
            // Reshuffle the discard pile (except its top card) back into the stock — standard
            // rummy behavior when the stock runs dry mid-game.
            if (discardPile.length <= 1) throw { status: 400, message: 'No cards left to draw.' };
            const top = discardPile[discardPile.length - 1];
            stock = rummyShuffle(discardPile.slice(0, -1).map((d) => d.card));
            discardPile = [top];
          }
          drawnCard = stock[stock.length - 1];
          stock = stock.slice(0, -1);
        }

        const newHandCards = [...hand.cards, drawnCard];
        tx.set(stockRef, { cards: stock });
        tx.update(handRef, { cards: newHandCards });
        const newPlayers = players.map((p: any, i: number) =>
          i === game.currentTurnSeatIndex ? { ...p, handCount: newHandCards.length } : p,
        );
        tx.update(gameRef, {
          discardPile,
          stockCount: stock.length,
          turnPhase: 'discard',
          players: newPlayers,
          lastAction: { type: 'draw', byUid: decoded.uid, at: new Date().toISOString() },
        });
        return { drawnCard };
      });

      return res.json({ ok: true, drawnCard: result.drawnCard });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('rummy/draw error:', error);
      return res.status(500).json({ error: 'Unable to draw.' });
    }
  });

  app.post('/api/rummy/discard', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const cardId = String(req.body?.cardId || '');
    if (!gameId || !cardId) return res.status(400).json({ error: 'gameId and cardId are required.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      const handRef = gameRef.collection('hands').doc(decoded.uid);
      let turnNotice: { nextPlayerUid: string; opponentNames: string | null } | null = null;

      await db.runTransaction(async (tx) => {
        const [gameSnap, handSnap] = await Promise.all([tx.get(gameRef), tx.get(handRef)]);
        if (!gameSnap.exists || !handSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players || [];
        const mySeatIndex = game.currentTurnSeatIndex;
        const mySeat = players[mySeatIndex];
        if (!mySeat || mySeat.uid !== decoded.uid) throw { status: 403, message: 'Not your turn.' };
        if (game.turnPhase !== 'discard') throw { status: 400, message: 'Draw a card first.' };

        const hand = handSnap.data()!;
        const cards: string[] = hand.cards || [];
        if (!cards.includes(cardId)) throw { status: 400, message: 'That card is not in your hand.' };

        // Remove only the ONE discarded card, not every card matching that value — three combined
        // decks routinely put duplicate rank+suit cards in the same hand, and
        // `.filter(c => c !== cardId)` would silently discard all of them instead of just the one
        // actually played.
        const discardedIdxInHand = cards.indexOf(cardId);
        const newHandCards = [...cards.slice(0, discardedIdxInHand), ...cards.slice(discardedIdxInHand + 1)];
        const nextSeatIndex = rummyNextActiveSeat(players, mySeatIndex);
        const newPlayers = players.map((p: any, i: number) =>
          i === mySeatIndex ? { ...p, handCount: newHandCards.length } : p,
        );

        // Locked from pickup only if THIS discarder had actually seen it as a joker: the common
        // joker (rank1) is public from the start, but the second joker (rank2) only counts if this
        // specific player has personally unlocked it — someone who hasn't yet has no way of
        // knowing that card is special, so the next player is free to pick it up.
        const discardedRank = rummyParseCard(cardId).rank;
        const locked = discardedRank === game.wildcardRank1 || (discardedRank === game.wildcardRank2 && !!mySeat.hasSecondJoker);

        tx.update(handRef, { cards: newHandCards });
        tx.update(gameRef, {
          discardPile: [...(game.discardPile || []), { card: cardId, locked }],
          currentTurnSeatIndex: nextSeatIndex,
          turnPhase: 'draw',
          players: newPlayers,
          lastAction: { type: 'discard', byUid: decoded.uid, at: new Date().toISOString() },
        });

        const nextPlayer = players[nextSeatIndex];
        if (nextPlayer) {
          turnNotice = {
            nextPlayerUid: nextPlayer.uid,
            opponentNames: players.filter((p) => p.uid !== nextPlayer.uid && !p.dropped).map((p) => p.displayName).filter(Boolean).join(', ') || null,
          };
        }
      });

      if (turnNotice) {
        await notifyGameTurn(db, { gameType: 'rummy', gameId, nextPlayerUid: turnNotice.nextPlayerUid, movedByUid: decoded.uid, opponentNames: turnNotice.opponentNames }).catch(
          (err) => console.error('notifyGameTurn (rummy discard) failed:', err),
        );
      }

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('rummy/discard error:', error);
      return res.status(500).json({ error: 'Unable to discard.' });
    }
  });

  // Declares a 5+4+3 pure-sequence hand shape, unlocking this player's personal use of the second
  // joker rank. This is a one-time SHOW, not a meld: the 12 named cards are only checked against
  // the current hand at the moment of declaring — they are never removed, locked, or tracked
  // afterward. The player is free to keep playing (drawing/discarding) any of those same cards
  // normally; the only lasting effect of a successful declare is `hasSecondJoker: true`. Doesn't
  // consume a turn — allowed any time it's genuinely this player's turn (either phase).
  app.post('/api/rummy/declare-543', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const five: string[] = Array.isArray(req.body?.five) ? req.body.five : [];
    const four: string[] = Array.isArray(req.body?.four) ? req.body.four : [];
    const three: string[] = Array.isArray(req.body?.three) ? req.body.three : [];
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });
    if (five.length !== 5 || four.length !== 4 || three.length !== 3) {
      return res.status(400).json({ error: 'Groups must be exactly 5, 4, and 3 cards.' });
    }
    const all = [...five, ...four, ...three];
    if (new Set(all).size !== all.length) return res.status(400).json({ error: 'Duplicate card in declaration.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      const handRef = gameRef.collection('hands').doc(decoded.uid);

      await db.runTransaction(async (tx) => {
        const [gameSnap, handSnap] = await Promise.all([tx.get(gameRef), tx.get(handRef)]);
        if (!gameSnap.exists || !handSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players || [];
        const mySeatIndex = game.currentTurnSeatIndex;
        const mySeat = players[mySeatIndex];
        if (!mySeat || mySeat.uid !== decoded.uid) throw { status: 403, message: 'You can only declare on your own turn.' };
        if (mySeat.pureRun543At) throw { status: 400, message: 'Already declared.' };

        const hand = handSnap.data()!;
        const cards: string[] = hand.cards || [];
        if (!all.every((c) => cards.includes(c))) throw { status: 400, message: 'Those cards are not all in your hand.' };
        if (!rummyIsPureSequence(five) || !rummyIsPureSequence(four) || !rummyIsPureSequence(three)) {
          throw { status: 400, message: 'Each group must be a valid pure sequence (no jokers).' };
        }

        const newPlayers = players.map((p: any, i: number) =>
          i === mySeatIndex ? { ...p, hasSecondJoker: true, pureRun543At: new Date().toISOString() } : p,
        );
        // `lastJokerSpot` drives a one-off "XXXX has spotted the Joker!" toast client-side (see
        // RummyGame.tsx's useJokerSpotted) — same "stamp a timestamped field, client diffs it"
        // pattern as `lastReaction` for quick reactions, just its own field since this is a
        // distinct game event, not a reaction.
        tx.update(gameRef, {
          players: newPlayers,
          lastJokerSpot: { uid: decoded.uid, displayName: mySeat.displayName, at: new Date().toISOString() },
        });
      });

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('rummy/declare-543 error:', error);
      return res.status(500).json({ error: 'Unable to declare.' });
    }
  });

  // The win declaration. Every winning hand — regardless of whether this player already declared
  // 5-4-3 earlier for the joker — must show its OWN 5+4+3 pure-sequence structure again here
  // (declaring earlier never locked those cards away, so the player may reuse the same ones or a
  // different set; declaring 5-4-3 only ever unlocked the joker, it was never a partial win-shape
  // credit). Must be called right after drawing (28-card hand): 12 cards in the mandatory
  // five/four/three pure runs, one card set aside as the finishing discard, and the remaining 15
  // grouped into further valid sequences/sets. The server never invents or searches for a grouping
  // on the player's behalf — it only validates the EXACT shape submitted, same as a real rummy
  // "show." An incorrect declaration is penalized by dropping that player from the game.
  app.post('/api/rummy/declare-win', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const discardCardId = String(req.body?.discardCardId || '');
    const five: string[] = Array.isArray(req.body?.five) ? req.body.five : [];
    const four: string[] = Array.isArray(req.body?.four) ? req.body.four : [];
    const three: string[] = Array.isArray(req.body?.three) ? req.body.three : [];
    const groups: string[][] = Array.isArray(req.body?.groups)
      ? req.body.groups.filter((g: unknown) => Array.isArray(g) && g.every((c) => typeof c === 'string'))
      : [];
    if (!gameId || !discardCardId) return res.status(400).json({ error: 'gameId and discardCardId are required.' });
    if (five.length !== 5 || four.length !== 4 || three.length !== 3) {
      return res.status(400).json({ error: 'A winning hand needs pure sequences of exactly 5, 4, and 3 cards.' });
    }

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);

      const outcome = await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players || [];
        const mySeatIndex = game.currentTurnSeatIndex;
        const mySeat = players[mySeatIndex];
        if (!mySeat || mySeat.uid !== decoded.uid) throw { status: 403, message: 'You can only declare on your own turn.' };
        if (game.turnPhase !== 'discard') throw { status: 400, message: 'Draw a card first.' };

        // Read every player's hand up front (not just the declarer's own) — this declare attempt
        // might end the game right here, and a finished game reveals everyone's final hand (see
        // the "Everyone's Cards" section below), so those reads must happen now, before any write.
        const handSnaps = await Promise.all(players.map((p: any) => tx.get(gameRef.collection('hands').doc(p.uid))));
        // `groups` here is a player's own cosmetic hand-organization (see RummyGame.tsx's
        // handGroups, client-synced to this same doc) — included in the reveal below so a losing
        // hand shows the way that player actually had it arranged, not just a flat sorted list.
        const handDataByUid = new Map(players.map((p: any, i: number) => [p.uid, handSnaps[i].data() || {}]));
        const handSnap = handSnaps[players.findIndex((p: any) => p.uid === decoded.uid)];
        if (!handSnap?.exists) throw { status: 404, message: 'Game not found.' };

        const hand = handSnap.data()!;
        const allCards: string[] = hand.cards || [];

        const wildcardRanks = mySeat.hasSecondJoker
          ? [game.wildcardRank1, game.wildcardRank2].filter(Boolean)
          : [game.wildcardRank1].filter(Boolean);

        const meldTriple = [...five, ...four, ...three];
        const flatGroups = groups.flat();
        const claimedTotal = [...meldTriple, discardCardId, ...flatGroups];
        const isValidShow =
          new Set(claimedTotal).size === claimedTotal.length &&
          rummyArraysSameMultiset(claimedTotal, allCards) &&
          rummyIsPureSequence(five) && rummyIsPureSequence(four) && rummyIsPureSequence(three) &&
          groups.every((g) => g.length >= 3 && rummyIsValidGroup(g, wildcardRanks));

        if (isValidShow) {
          // awardGamePoints does READS internally — must run before any tx.update/tx.set write in
          // this transaction, per Firestore's read-before-write rule, so it comes before the
          // game's own finish write below, not after.
          await awardGamePoints(tx, db, { gameType: 'rummy', gameId, playerUids: players.map((p: any) => p.uid), winnerUids: [decoded.uid] });
          const finishedAt1 = new Date().toISOString();
          // Everyone's final hand, revealed once the game is over — the winner's is shown as the
          // exact pure-sequence/set grouping they declared (never re-derived or guessed at), since
          // that's the only grouping this endpoint actually validated; everyone else's is just
          // their held cards as-is, since a losing hand was never grouped into anything.
          // Firestore rejects arrays nested directly inside arrays ("invalid nested entity") —
          // `groups`/`melds.groups` are conceptually string[][], so every group gets wrapped in a
          // single-key object ({cards: [...]}) to store as an array of maps instead.
          const revealedHands = Object.fromEntries(players.map((p: any) => [
            p.uid,
            p.uid === decoded.uid
              ? { cards: allCards, melds: { five, four, three, groups: groups.map((g) => ({ cards: g })), discardCardId } }
              : { cards: handDataByUid.get(p.uid)?.cards || [], groups: handDataByUid.get(p.uid)?.groups || [] },
          ]));
          tx.update(gameRef, { status: 'finished', winnerUid: decoded.uid, finishedAt: finishedAt1, revealedHands });
          recordGameOutcome(tx, db, gameId, {
            gameType: 'rummy', playerUids: players.map((p: any) => p.uid),
            players: players.map((p: any) => ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL })),
            winnerUid: decoded.uid, finishedAt: finishedAt1,
          });
          return { won: true };
        }

        // Incorrect declaration: drop the declarer and hand the turn to the next active player.
        const newPlayers = players.map((p: any, i: number) => (i === mySeatIndex ? { ...p, dropped: true } : p));
        const stillIn = newPlayers.filter((p: any) => !p.dropped);
        if (stillIn.length === 1) {
          await awardGamePoints(tx, db, { gameType: 'rummy', gameId, playerUids: newPlayers.map((p: any) => p.uid), winnerUids: [stillIn[0].uid] });
          const finishedAt2 = new Date().toISOString();
          // No meld to show — nobody validated a grouping here (the win is by elimination, not a
          // declare), so every hand is revealed as-is.
          const revealedHands2 = Object.fromEntries(newPlayers.map((p: any) => [
            p.uid,
            { cards: handDataByUid.get(p.uid)?.cards || [], groups: handDataByUid.get(p.uid)?.groups || [] },
          ]));
          tx.update(gameRef, { status: 'finished', winnerUid: stillIn[0].uid, finishedAt: finishedAt2, players: newPlayers, revealedHands: revealedHands2 });
          recordGameOutcome(tx, db, gameId, {
            gameType: 'rummy', playerUids: newPlayers.map((p: any) => p.uid),
            players: newPlayers.map((p: any) => ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL })),
            winnerUid: stillIn[0].uid, finishedAt: finishedAt2,
          });
        } else {
          tx.update(gameRef, {
            players: newPlayers,
            currentTurnSeatIndex: rummyNextActiveSeat(newPlayers, mySeatIndex),
            turnPhase: 'draw',
            lastAction: { type: 'invalid_declare', byUid: decoded.uid, at: new Date().toISOString() },
          });
        }
        return { won: false };
      });

      if (!outcome.won) return res.status(400).json({ error: 'Invalid declaration — you have been dropped from the game.' });
      return res.json({ ok: true, won: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('rummy/declare-win error:', error);
      return res.status(500).json({ error: 'Unable to process declaration.' });
    }
  });

  app.post('/api/rummy/drop', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      let turnNotice: { nextPlayerUid: string; opponentNames: string | null } | null = null;
      await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players || [];
        const myIndex = players.findIndex((p: any) => p.uid === decoded.uid);
        if (myIndex === -1) throw { status: 403, message: 'Not part of this game.' };
        if (players[myIndex].dropped) throw { status: 400, message: 'Already dropped.' };

        const newPlayers = players.map((p: any, i: number) => (i === myIndex ? { ...p, dropped: true } : p));
        const stillIn = newPlayers.filter((p: any) => !p.dropped);
        if (stillIn.length === 1) {
          // See the declare-win handler's comment: awardGamePoints reads before it writes, so it
          // must run before the game's own finish write, not after. Same reasoning for the hand
          // reads below — every hand is revealed once the game is over.
          const handSnaps = await Promise.all(newPlayers.map((p: any) => tx.get(gameRef.collection('hands').doc(p.uid))));
          const revealedHands = Object.fromEntries(newPlayers.map((p: any, i: number) => [
            p.uid,
            { cards: handSnaps[i].data()?.cards || [], groups: handSnaps[i].data()?.groups || [] },
          ]));
          await awardGamePoints(tx, db, { gameType: 'rummy', gameId, playerUids: newPlayers.map((p: any) => p.uid), winnerUids: [stillIn[0].uid] });
          const finishedAt = new Date().toISOString();
          tx.update(gameRef, { status: 'finished', winnerUid: stillIn[0].uid, finishedAt, players: newPlayers, revealedHands });
          recordGameOutcome(tx, db, gameId, {
            gameType: 'rummy', playerUids: newPlayers.map((p: any) => p.uid),
            players: newPlayers.map((p: any) => ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL })),
            winnerUid: stillIn[0].uid, finishedAt,
          });
        } else {
          const wasMyTurn = game.currentTurnSeatIndex === myIndex;
          tx.update(gameRef, {
            players: newPlayers,
            ...(wasMyTurn ? { currentTurnSeatIndex: rummyNextActiveSeat(newPlayers, myIndex), turnPhase: 'draw' } : {}),
          });
          if (wasMyTurn) {
            const nextPlayer = newPlayers[rummyNextActiveSeat(newPlayers, myIndex)];
            if (nextPlayer) {
              turnNotice = {
                nextPlayerUid: nextPlayer.uid,
                opponentNames: newPlayers.filter((p) => p.uid !== nextPlayer.uid && !p.dropped).map((p) => p.displayName).filter(Boolean).join(', ') || null,
              };
            }
          }
        }
      });
      if (turnNotice) {
        await notifyGameTurn(db, { gameType: 'rummy', gameId, nextPlayerUid: turnNotice.nextPlayerUid, movedByUid: decoded.uid, opponentNames: turnNotice.opponentNames }).catch(
          (err) => console.error('notifyGameTurn (rummy drop) failed:', err),
        );
      }
      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('rummy/drop error:', error);
      return res.status(500).json({ error: 'Unable to drop.' });
    }
  });

  // Deletes a game the caller hosts — only while it's still 'waiting' or already 'finished' (an
  // 'active' game has other players mid-match; they should Drop instead of the host yanking it out
  // from under them). Cascades through the hands/secret subcollections and the game-code pointer
  // doc via the Admin SDK, since clients can't reach those directly (firestore.rules blocks them —
  // hands are per-uid read-only, secret/stock is Admin-only) and a plain client-side doc delete of
  // just the top-level rummyGames doc would leave that private hand data orphaned indefinitely.
  app.post('/api/rummy/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (game.status === 'active') {
        return res.status(400).json({ error: 'Cannot delete a game in progress — drop out instead, or wait for it to finish.' });
      }

      const [handsSnap, secretSnap] = await Promise.all([
        gameRef.collection('hands').get(),
        gameRef.collection('secret').get(),
      ]);
      const batch = db.batch();
      handsSnap.docs.forEach((d) => batch.delete(d.ref));
      secretSnap.docs.forEach((d) => batch.delete(d.ref));
      if (game.code) batch.delete(db.collection('rummyGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('rummy/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  // Starts a rematch with the exact same players, so a fresh invite round never has to happen —
  // any player from the finished game can trigger this (not just the original host), and the
  // caller becomes host of the new game. Idempotent: if someone already started the rematch,
  // `rematchGameId` is already set on the finished game doc, and every subsequent caller (whoever
  // else taps "Play Again") just gets handed that same id back instead of spawning duplicates.
  app.post('/api/rummy/rematch', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('rummyGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'finished') return res.status(400).json({ error: 'Game is not finished yet.' });

      if (game.rematchGameId) {
        return res.json({ gameId: game.rematchGameId });
      }

      // Reuse the SAME room code across a rematch, rather than minting a new one — players
      // expect "the room" to carry over, not to be handed an unfamiliar new code every time they
      // rematch. The old (now-finished) game keeps its own doc; `rummyGameCodes/{code}` just gets
      // repointed at the new game so the familiar code still resolves correctly going forward.
      const newGameRef = db.collection('rummyGames').doc();
      const code = game.code;

      const players = (game.players || []).map((p: any) => ({
        uid: p.uid,
        displayName: p.displayName,
        photoURL: p.photoURL,
        seatIndex: p.seatIndex,
        handCount: 0,
        hasSecondJoker: false,
        pureRun543At: null,
        dropped: false,
      }));

      const batch = db.batch();
      batch.set(newGameRef, {
        hostUid: decoded.uid,
        code,
        status: 'waiting',
        players,
        playerUids: game.playerUids,
        currentTurnSeatIndex: 0,
        turnPhase: 'draw',
        stockCount: 0,
        discardPile: [],
        wildcardRank1: null,
        wildcardRank2: null,
        jokerCard1: null,
        jokerCard2: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        winnerUid: null,
        finishedAt: null,
        rematchGameId: null,
      });
      batch.set(db.collection('rummyGameCodes').doc(code), { gameId: newGameRef.id, hostUid: decoded.uid });
      batch.update(gameRef, { rematchGameId: newGameRef.id });
      await batch.commit();

      return res.json({ gameId: newGameRef.id });
    } catch (error) {
      console.error('rummy/rematch error:', error);
      return res.status(500).json({ error: 'Unable to start rematch.' });
    }
  });

  // ===================== Business (Indian Monopoly-style) =====================
  // Unlike Rummy, this game is fully client-trusted (same as Ludo) — there's no meaningful hidden
  // state (cash/properties/position are always public; only the Chance/Community Chest draw order
  // is randomized, and card CONTENTS are public rulebook knowledge). These endpoints only exist for
  // the same reasons Ludo/Rummy need a couple of server-side ones: pushing invites, and a clean
  // Admin-SDK-backed delete/rematch so the game-code pointer doc doesn't get orphaned.

  const BUSINESS_BOARD_SIZE = 32;
  const BUSINESS_STARTING_CASH = 15000;
  const BUSINESS_CHANCE_CARD_COUNT = 12;
  const BUSINESS_COMMUNITY_CARD_COUNT = 12;

  function businessShuffledIndexes(size: number): number[] {
    const arr = Array.from({ length: size }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function businessEmptyProperties(): { ownerUid: string | null; houses: number; hotel: boolean; mortgaged: boolean }[] {
    return Array.from({ length: BUSINESS_BOARD_SIZE }, () => ({ ownerUid: null, houses: 0, hotel: false, mortgaged: false }));
  }

  app.post('/api/business/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('businessGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: 'Business', routeSegment: 'business', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('business/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  // Host-only, and only while the game hasn't started (or is already over) — an active game has
  // other players mid-match. No hands/secret subcollections to cascade here (fully client-trusted,
  // unlike Rummy), so this just removes the game doc and frees up its share code.
  app.post('/api/business/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('businessGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (game.status === 'active') {
        return res.status(400).json({ error: 'Cannot delete a game in progress — it will end naturally via bankruptcy.' });
      }

      const batch = db.batch();
      if (game.code) batch.delete(db.collection('businessGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('business/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  // Same rematch pattern as Rummy: any player from the finished game can trigger it, the caller
  // becomes host of the new game, and it's idempotent via `rematchGameId` so a second/third player
  // tapping "Play Again" just gets handed back the same new game instead of spawning duplicates.
  app.post('/api/business/rematch', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('businessGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'finished') return res.status(400).json({ error: 'Game is not finished yet.' });

      if (game.rematchGameId) {
        return res.json({ gameId: game.rematchGameId });
      }

      const newGameRef = db.collection('businessGames').doc();
      let code = generateShareCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.collection('businessGameCodes').doc(code).get();
        if (!existing.exists) break;
        code = generateShareCode();
      }

      const players = (game.players || []).map((p: any) => ({
        uid: p.uid,
        displayName: p.displayName,
        photoURL: p.photoURL,
        seatIndex: p.seatIndex,
        cash: BUSINESS_STARTING_CASH,
        position: 0,
        inJail: false,
        jailTurns: 0,
        getOutOfJailCards: 0,
        bankrupt: false,
        doublesStreak: 0,
      }));

      const batch = db.batch();
      batch.set(newGameRef, {
        hostUid: decoded.uid,
        code,
        status: 'waiting',
        players,
        playerUids: game.playerUids,
        currentTurnSeatIndex: 0,
        turnPhase: 'roll',
        lastRoll: null,
        properties: businessEmptyProperties(),
        chanceDeck: businessShuffledIndexes(BUSINESS_CHANCE_CARD_COUNT),
        communityDeck: businessShuffledIndexes(BUSINESS_COMMUNITY_CARD_COUNT),
        freeParkingPot: 0,
        houseRules: game.houseRules || {
          freeParkingJackpot: true,
          doubleRentFullSet: true,
          doubleSalaryOnExactGo: true,
          doublesExtraTurn: true,
        },
        pendingCard: null,
        auction: null,
        pendingTrade: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        winnerUid: null,
        finishedAt: null,
        rematchGameId: null,
      });
      batch.set(db.collection('businessGameCodes').doc(code), { gameId: newGameRef.id, hostUid: decoded.uid });
      batch.update(gameRef, { rematchGameId: newGameRef.id });
      await batch.commit();

      return res.json({ gameId: newGameRef.id });
    } catch (error) {
      console.error('business/rematch error:', error);
      return res.status(500).json({ error: 'Unable to start rematch.' });
    }
  });

  // ===================== Sweep =====================
  // A fishing/capture card game, 2 or 4 players (4-player games are fixed partnerships, partners
  // always seated opposite each other — team = seatIndex % 2). One standard 52-card deck.
  //
  // Like Rummy, this has genuine hidden information (hands, and briefly the bidder's private peek
  // at the floor before it's revealed) that must never be readable by any client, so every action
  // is mediated here via the Admin SDK — see firestore.rules for the corresponding lockdown.
  //
  // Rule engine summary (the full precise rules doc this was built from is unusually explicit —
  // see project memory `project_sweep_build` for the handful of genuine judgment calls still
  // needed, e.g. how the bid's "make a house" option resolves arithmetically):
  //   - Deal: floor gets 4 cards (fully hidden — held in an Admin-only `secret/floorCards` doc, NOT
  //     visible to the bidder either), the player to the dealer's right (the bidder) privately gets
  //     4 cards; if none has capture value >= 9, it's an automatic reshuffle-and-redeal (same
  //     dealer) until a valid hand appears.
  //   - Bid (`/api/sweep/bid`): a value 9-13 matching a card (X) the bidder holds, chosen BLIND —
  //     from their own hand alone, no floor visibility advantage over anyone else. The instant the
  //     value is committed, the floor is revealed to EVERY player equally (copied into the public
  //     `game.floor`), bidder included — they get no earlier look than anyone else at the table.
  //   - Bid resolution (`/api/sweep/resolve-bid`, a separate call — the bidder needs to actually
  //     SEE the now-public floor before deciding, so this can't be combined with the bid itself) —
  //     exactly one of:
  //       capture: floor cards summing to the bid, captured immediately together with X.
  //       house: a DIFFERENT hand card + floor cards summing to the bid value forms a new weak
  //         house (X is never played here — it stays in hand as the eventual key to capture this
  //         house on a later turn; this is the only way the arithmetic works, since X's own value
  //         already equals the bid, so combining X with any floor cards would overshoot).
  //       throw: X just joins the floor as a loose card — only legal when "capture" isn't possible.
  //   - Remaining 44 cards are dealt so every player ends with handSize = 48/playerCount cards.
  //   - Regular turns: play one card. If it directly matches a loose card or a house's number,
  //     throwing it away is illegal — the player must either capture (mandatorily including every
  //     directly-matching loose card, optionally plus one more floor combo and/or whole houses that
  //     also sum/equal to that value) or create/extend/contribute to a house. Creating a brand-new
  //     house, or changing a WEAK house's only set to a new number, always requires the actor to
  //     still hold another card of the resulting value afterward. Contributing a new set to an
  //     EXISTING house (weak or strong) instead only needs EITHER that (own team already owns it)
  //     OR (retain a matching card) — a free add for your own side, a committed one against the
  //     other. A weak house changed to a new number transfers full ownership to whoever changed it;
  //     a house gaining an extra matching-value set becomes co-owned instead. Two houses can never
  //     share a number — a new/changed set matching an existing house's number merges into it.
  //   - Sweep bonus (a capture empties the floor): a flat 25 or 50 points, chosen once at game
  //     creation — except the very last card played in a deal never triggers a sweep even if it
  //     empties the floor (any leftover floor material at that point just goes to whoever captured
  //     most recently).
  //   - Scoring: each team's points = spades (own capture value) + non-spade aces (1) + 10 of
  //     Diamonds (6), plus sweep bonuses, captured that deal. The winning margin adds to (or
  //     subtracts from) a single running net score for the whole match; reaching +-100 ends the
  //     game. The next deal's dealer is a member of the LOSING team (rotated to the next seat
  //     belonging to that team from the current dealer); a tied deal keeps the same dealer.

  const SWEEP_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SWEEP_SUITS = ['S', 'H', 'D', 'C'];
  const SWEEP_CAPTURE_VALUE: Record<string, number> = {
    A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
  };

  function buildSweepDeck(): string[] {
    const deck: string[] = [];
    for (const suit of SWEEP_SUITS) for (const rank of SWEEP_RANKS) deck.push(`${rank}${suit}`);
    return deck; // 52 cards
  }

  function sweepParseCard(id: string): { rank: string; suit: string } {
    return { rank: id.slice(0, -1), suit: id.slice(-1) };
  }

  const SWEEP_SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

  // Human-readable "10♦" style label, for `lastAction.text` messages describing which card was
  // just played — client-side rendering of the raw id ("10D") would be less readable in plain text.
  function sweepCardLabel(id: string): string {
    const { rank, suit } = sweepParseCard(id);
    return `${rank}${SWEEP_SUIT_SYMBOL[suit] || suit}`;
  }

  function sweepCaptureValue(id: string): number {
    return SWEEP_CAPTURE_VALUE[sweepParseCard(id).rank];
  }

  function sweepCardPoints(id: string): number {
    const { rank, suit } = sweepParseCard(id);
    if (suit === 'S') return SWEEP_CAPTURE_VALUE[rank];
    if (rank === 'A') return 1;
    if (rank === '10' && suit === 'D') return 6;
    return 0;
  }

  function sweepSumValues(ids: string[]): number {
    return ids.reduce((sum, id) => sum + sweepCaptureValue(id), 0);
  }

  function sweepSumPoints(ids: string[]): number {
    return ids.reduce((sum, id) => sum + sweepCardPoints(id), 0);
  }

  function sweepShuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sweepTeamForSeat(seatIndex: number): 0 | 1 {
    return (seatIndex % 2) as 0 | 1;
  }

  function sweepNextSeat(seatIndex: number, playerCount: number): number {
    return (seatIndex + 1) % playerCount;
  }

  // Next seat belonging to `losingTeam`, rotating forward from `fromSeat` — the deal rotation rule
  // ("a member of the losing team deals the next hand," no further specifics on which member),
  // implemented as: advance one seat; if that's not the losing team, advance one more. Since teams
  // strictly alternate by seatIndex parity, this always lands on the losing team, and naturally
  // alternates between that team's two members (4p) or stays put (2p, where "the losing team" is
  // just the one player) across successive losses.
  function sweepNextDealerSeat(fromSeat: number, losingTeam: 0 | 1, playerCount: number): number {
    let seat = sweepNextSeat(fromSeat, playerCount);
    if (sweepTeamForSeat(seat) !== losingTeam) seat = sweepNextSeat(seat, playerCount);
    return seat;
  }

  function sweepNewHouseId(): string {
    return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  interface SweepSetSrv { cards: string[] }
  interface SweepHouseSrv { id: string; value: number; sets: SweepSetSrv[]; ownerTeams: number[] }
  interface SweepFloorSrv { looseCards: string[]; houses: SweepHouseSrv[] }

  function sweepFindDirectMatch(floor: SweepFloorSrv, value: number): { house: SweepHouseSrv } | { looseCard: string } | null {
    const house = floor.houses.find((h) => h.value === value);
    if (house) return { house };
    const loose = floor.looseCards.find((c) => sweepCaptureValue(c) === value);
    if (loose) return { looseCard: loose };
    return null;
  }

  function sweepAllCardsOf(house: SweepHouseSrv): string[] {
    return house.sets.flatMap((s) => s.cards);
  }

  // A house's number is a standing claim on ALL floor material worth that value — a loose card
  // left sitting next to a same-valued house would be ambiguous the moment someone plays a
  // matching card (are they capturing the loose card, the house, or both?). So any time a house's
  // value is newly established or changed (built from scratch, or a weak house re-valued), fold in
  // any loose card already on the floor that happens to match — as its own set, on the house, with
  // no ownership change (nobody spent a hand card to claim it; it's pure floor bookkeeping).
  // Free (no-matching-card-needed) contribution/value-change eligibility is scoped to the VALUE,
  // not to one specific house — if a team already owns/co-owns ANY house currently worth `value`
  // anywhere on the floor, that value counts as "established" for them, and they can freely
  // change or contribute to a DIFFERENT house to reach that same value too. (Interpretive call —
  // see project memory: broadened from "must already own THIS specific house" after user
  // feedback, since a team's partner having already built, say, a House·12 elsewhere should let
  // either of them push another weak house up to 12 too, without needing an actual 12 in hand.)
  function sweepTeamOwnsValue(floor: SweepFloorSrv, team: number, value: number): boolean {
    return floor.houses.some((h) => h.value === value && h.ownerTeams.includes(team));
  }

  function sweepAbsorbMatchingLoose(floor: SweepFloorSrv, house: SweepHouseSrv): void {
    const matches = floor.looseCards.filter((c) => sweepCaptureValue(c) === house.value);
    if (matches.length === 0) return;
    house.sets.push({ cards: matches });
    floor.looseCards = floor.looseCards.filter((c) => !matches.includes(c));
  }

  // Whether a played card of this value can capture ANYTHING — either directly (a lone loose card
  // or a house), by combining two or more loose cards (e.g. a 9 and a 2 captured by an 11), or by
  // folding in a WEAK house's current value alongside loose cards (e.g. a House·10 plus a loose 3,
  // captured together by a King — only weak/single-set houses fold in this way, a strong house is
  // locked to its own value). Used to decide whether throwing the card loose is illegal (a capture
  // being available forecloses it), matching the client's `canCaptureValue` hinting in
  // src/lib/sweep.ts.
  function sweepCanCapture(floor: SweepFloorSrv, value: number): boolean {
    if (sweepFindDirectMatch(floor, value)) return true;
    const weakHouseValues = floor.houses.filter((h) => h.sets.length === 1).map((h) => h.value);
    const pool = [...floor.looseCards.map(sweepCaptureValue), ...weakHouseValues];
    const n = pool.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      let sum = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += pool[i];
      if (sum === value) return true;
    }
    return false;
  }

  // Whether `values` can be exactly partitioned into 1+ groups that EACH sum to `target` — used
  // to validate a capture's "extra" loose-card selection, since a single play can sweep multiple
  // independent sets at once (e.g. playing an 11 to take BOTH a 5+6 group AND a separate 7+4
  // group in the same capture), not just one combined blob. Small backtracking search — the floor
  // only ever holds a handful of loose cards, so this is plenty fast.
  function sweepCanPartitionIntoGroups(values: number[], target: number): boolean {
    const total = values.reduce((a, b) => a + b, 0);
    if (target <= 0 || total === 0 || total % target !== 0) return false;
    const groupsNeeded = total / target;
    const sorted = [...values].sort((a, b) => b - a);
    const used = new Array(sorted.length).fill(false);
    function backtrack(groupsFormed: number, currentSum: number, startIdx: number): boolean {
      if (groupsFormed === groupsNeeded) return true;
      if (currentSum === target) return backtrack(groupsFormed + 1, 0, 0);
      for (let i = startIdx; i < sorted.length; i++) {
        if (used[i] || currentSum + sorted[i] > target) continue;
        used[i] = true;
        if (backtrack(groupsFormed, currentSum + sorted[i], i + 1)) return true;
        used[i] = false;
      }
      return false;
    }
    return backtrack(0, 0, 0);
  }

  function sweepCloneFloor(floor: any): SweepFloorSrv {
    return {
      looseCards: [...(floor?.looseCards || [])],
      houses: (floor?.houses || []).map((h: any) => ({ ...h, sets: h.sets.map((s: any) => ({ cards: [...s.cards] })), ownerTeams: [...h.ownerTeams] })),
    };
  }

  // Shared by /start (first deal of a match) and /deal (every subsequent deal) — shuffles, deals
  // the floor + bidder's peek hand, and auto-redeals (same dealer) until the bidder has a legally
  // biddable hand. Returns everything the caller needs to write; does not touch Firestore itself.
  function sweepDealHand(dealerSeatIndex: number, playerCount: number): { bidderSeatIndex: number; bidderHand: string[]; floorCards: string[]; restDeck: string[]; redeals: number } {
    const bidderSeatIndex = sweepNextSeat(dealerSeatIndex, playerCount);
    let redeals = 0;
    while (true) {
      const deck = sweepShuffle(buildSweepDeck());
      const floorCards = deck.slice(0, 4);
      const bidderHand = deck.slice(4, 8);
      if (bidderHand.some((c) => sweepCaptureValue(c) >= 9)) {
        return { bidderSeatIndex, bidderHand, floorCards, restDeck: deck.slice(8), redeals };
      }
      redeals += 1;
      if (redeals > 500) throw { status: 500, message: 'Unable to find a valid deal — please try again.' };
    }
  }

  app.post('/api/sweep/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('sweepGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: 'Sweep', routeSegment: 'sweep', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('sweep/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  // Lets the host manually re-pair partners in a 4-player game before it starts — teams default to
  // seatIndex % 2 as players join, but the host can freely reassign either player to either team
  // right up until Start Game (which then requires an exact 2-2 split). Only touches the `team`
  // field on the roster; players/seats/uids are untouched. Host-only, waiting-status only, since
  // Sweep is server-mediated (no client-writable update path for existing players).
  app.post('/api/sweep/set-team', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const targetUid = String(req.body?.uid || '');
    const team = Number(req.body?.team);
    if (!gameId || !targetUid) return res.status(400).json({ error: 'gameId and uid are required.' });
    if (team !== 0 && team !== 1) return res.status(400).json({ error: 'team must be 0 or 1.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can set teams.' });
      if (game.status !== 'waiting') return res.status(400).json({ error: 'Teams can only be changed before the game starts.' });
      const players: any[] = game.players || [];
      if (!players.some((p) => p.uid === targetUid)) return res.status(404).json({ error: 'That player is not in this game.' });

      await gameRef.update({ players: players.map((p) => (p.uid === targetUid ? { ...p, team } : p)) });
      return res.json({ ok: true });
    } catch (error) {
      console.error('sweep/set-team error:', error);
      return res.status(500).json({ error: 'Unable to update teams.' });
    }
  });

  // Deals the FIRST hand of a brand-new match. Host-only, requires the lobby to be exactly full
  // (2 or 4, matching the chosen playerCount). Picks a random first dealer, deals the bidder's
  // peek hand + floor, and stashes the remaining 44 cards in an Admin-only `secret/restDeck` doc
  // until /api/sweep/bid deals them out — the only way to keep them hidden from the bidder, who
  // can otherwise read their own `hands/{uid}` doc.
  app.post('/api/sweep/start', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can start the game.' });
      if (game.status !== 'waiting') return res.status(400).json({ error: 'Game already started.' });
      const players: any[] = game.players || [];
      const playerCount: number = game.playerCount;
      if (players.length !== playerCount) return res.status(400).json({ error: `Need exactly ${playerCount} players to start.` });
      if (playerCount === 4) {
        const team0Count = players.filter((p) => p.team === 0).length;
        if (team0Count !== 2) return res.status(400).json({ error: 'Teams must be split 2-2 before starting.' });
      }

      const dealerSeatIndex = Math.floor(Math.random() * playerCount);
      const { bidderSeatIndex, bidderHand, floorCards, restDeck } = sweepDealHand(dealerSeatIndex, playerCount);
      const bidderUid = players[bidderSeatIndex].uid;

      const batch = db.batch();
      batch.set(gameRef.collection('hands').doc(bidderUid), { cards: bidderHand });
      // The 4 floor cards stay Admin-only until the bid VALUE is committed — the bidder decides
      // what to bid from their own hand alone, with no floor visibility advantage over anyone
      // else. Storing them in the bidder's own `hands/{uid}` doc (as an earlier version of this
      // did) was a real leak: that doc is readable by its owner with no field-level restriction,
      // so a technically-savvy bidder could read it directly regardless of what the UI shows.
      batch.set(gameRef.collection('secret').doc('floorCards'), { cards: floorCards });
      batch.set(gameRef.collection('secret').doc('restDeck'), { cards: restDeck });
      batch.update(gameRef, {
        status: 'bidding',
        dealerSeatIndex,
        bidderSeatIndex,
        currentTurnSeatIndex: bidderSeatIndex,
        dealNumber: 1,
        floor: { looseCards: [], houses: [] },
        floorHiddenCount: 4,
        bidValue: null,
        cardsPlayedThisDeal: 0,
        lastCaptureTeam: null,
        capturedByTeam: { team0: [], team1: [] },
        sweepsThisDeal: [],
        netScore: 0,
        lastDealSummary: null,
        dealHistory: [],
        winnerTeam: null,
        startedAt: new Date().toISOString(),
        players: players.map((p, i) => ({ ...p, handCount: i === bidderSeatIndex ? 4 : 0 })),
        lastAction: { text: 'New deal — waiting on the bid.', at: new Date().toISOString() },
      });
      await batch.commit();
      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sweep/start error:', error);
      return res.status(500).json({ error: 'Unable to start game.' });
    }
  });

  // Step 1 of 2 — the bidder commits to a VALUE, chosen blind from their own hand alone (no floor
  // visibility advantage — the floor cards live in an Admin-only `secret/floorCards` doc up to this
  // point, unreadable by anyone including the bidder). The instant the value is committed, the
  // floor is revealed to EVERY player equally (copied into the public `game.floor`) — including the
  // bidder, who gets no earlier look than anyone else. Resolving what to actually DO with that now-
  // visible floor (capture/house/throw) is a separate second step, `/api/sweep/resolve-bid`, since
  // the bidder needs to see the floor before deciding — this can't be one combined call.
  app.post('/api/sweep/bid', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const bidValue = Number(req.body?.bidValue);
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });
    if (![9, 10, 11, 12, 13].includes(bidValue)) return res.status(400).json({ error: 'Bid must be between 9 and 13.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const floorCardsRef = gameRef.collection('secret').doc('floorCards');

      await db.runTransaction(async (tx) => {
        const [gameSnap, floorCardsSnap] = await Promise.all([tx.get(gameRef), tx.get(floorCardsRef)]);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'bidding' || game.bidValue != null) throw { status: 400, message: 'Bidding has already been resolved.' };
        const players: any[] = game.players;
        const bidderSeatIndex: number = game.bidderSeatIndex;
        const bidder = players[bidderSeatIndex];
        if (!bidder || bidder.uid !== decoded.uid) throw { status: 403, message: 'Only the bidder can bid.' };
        if (!floorCardsSnap.exists) throw { status: 404, message: 'Deal data missing.' };

        const handSnap = await tx.get(gameRef.collection('hands').doc(decoded.uid));
        if (!handSnap.exists) throw { status: 404, message: 'Deal data missing.' };
        const bidderCards: string[] = handSnap.data()!.cards || [];
        if (!bidderCards.some((c) => sweepCaptureValue(c) === bidValue)) {
          throw { status: 400, message: "You don't hold a card matching that bid value." };
        }

        const floorCards: string[] = floorCardsSnap.data()!.cards || [];
        tx.delete(floorCardsRef);
        tx.update(gameRef, {
          bidValue,
          floor: { looseCards: floorCards, houses: [] },
          floorHiddenCount: 0,
          lastAction: { text: `${bidder.displayName} bid ${bidValue}. The floor is revealed.`, at: new Date().toISOString() },
        });
      });

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sweep/bid error:', error);
      return res.status(500).json({ error: 'Unable to submit the bid.' });
    }
  });

  // Step 2 of 2 — now that the floor is public, the bidder decides how to own the bid (capture,
  // house, or throw) and the rest of the deck is dealt out, starting real play.
  app.post('/api/sweep/resolve-bid', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const action = String(req.body?.action || '');
    const floorCardIds: string[] = Array.isArray(req.body?.floorCardIds) ? req.body.floorCardIds.filter((c: unknown) => typeof c === 'string') : [];
    // 'house' can build MULTIPLE sets in one action — e.g. a lone-card set from a second
    // same-value card in hand, PLUS a separate floor-only combo also summing to the bid — making
    // an instant strong (multi-set) house on the very first build turn instead of only ever a weak
    // (1-set) one. `cardId: null` marks a floor-only set. See project memory for the interpretive
    // call: the OVERALL build still needs at least one hand-anchored set (the house must be
    // "staked" by something leaving the bidder's hand), but additional sets in the same build may
    // be pure floor combinations with no hand card of their own.
    const houseSets: Array<{ cardId: string | null; floorCardIds: string[] }> = Array.isArray(req.body?.sets)
      ? req.body.sets.map((s: any) => ({
          cardId: typeof s?.cardId === 'string' ? s.cardId : null,
          floorCardIds: Array.isArray(s?.floorCardIds) ? s.floorCardIds.filter((c: unknown) => typeof c === 'string') : [],
        }))
      : [];
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });
    if (!['capture', 'house', 'throw'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const restDeckRef = gameRef.collection('secret').doc('restDeck');
      const reserveDeckRef = gameRef.collection('secret').doc('reserveDeck');
      let turnNotice: { nextPlayerUid: string; opponentNames: string | null } | null = null;

      await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'bidding' || game.bidValue == null) throw { status: 400, message: 'No bid to resolve yet.' };
        const bidValue: number = game.bidValue;
        const players: any[] = game.players;
        const playerCount: number = game.playerCount;
        const bidderSeatIndex: number = game.bidderSeatIndex;
        const bidder = players[bidderSeatIndex];
        if (!bidder || bidder.uid !== decoded.uid) throw { status: 403, message: 'Only the bidder can resolve the bid.' };

        const handRef = gameRef.collection('hands').doc(decoded.uid);
        const restDeckSnap = await tx.get(restDeckRef);
        const handSnap = await tx.get(handRef);
        if (!handSnap.exists || !restDeckSnap.exists) throw { status: 404, message: 'Deal data missing.' };
        const bidderCards: string[] = handSnap.data()!.cards || [];
        const cardId = bidderCards.find((c) => sweepCaptureValue(c) === bidValue);
        if (!cardId) throw { status: 400, message: "You don't hold a card matching that bid value." };

        let floor: SweepFloorSrv = sweepCloneFloor(game.floor);
        const capturedCards: string[] = [];
        let playedCardIds: string[] = [cardId]; // the card(s) that actually leave the 4-card bidding hand this turn
        let sweep = false;

        const canCapture = floorCardIds.length > 0 && floorCardIds.every((c) => floor.looseCards.includes(c)) && sweepSumValues(floorCardIds) === bidValue;

        if (action === 'capture') {
          if (!canCapture) throw { status: 400, message: 'Selected floor cards must all be on the floor and sum exactly to the bid.' };
          floor.looseCards = floor.looseCards.filter((c) => !floorCardIds.includes(c));
          capturedCards.push(...floorCardIds, cardId);
          sweep = floor.looseCards.length === 0 && floor.houses.length === 0;
        } else if (action === 'house') {
          // Each set is either hand-anchored (a DIFFERENT card from hand, not the bid card itself
          // — its own value already equals the bid, so combining it with any floor cards would
          // overshoot — plus optional floor cards summing to the bid) or floor-only (pure floor
          // cards summing to the bid, no hand card). At least one set overall must be hand-
          // anchored — that's what "stakes" the house — but additional sets in the SAME build may
          // be floor-only, letting an instant strong (multi-set) house be built on the very first
          // turn. The bid card itself always stays in hand as the key to capture the house later.
          if (houseSets.length === 0) throw { status: 400, message: 'Select at least one set of cards to build with.' };

          const usedCardIds = new Set<string>();
          const usedFloorIds = new Set<string>();
          let hasHandAnchor = false;

          for (const set of houseSets) {
            if (set.cardId) {
              if (set.cardId === cardId) throw { status: 400, message: 'The bid card stays in your hand as the key — use a different card.' };
              if (!bidderCards.includes(set.cardId)) throw { status: 400, message: 'You can only build with cards in your hand.' };
              if (usedCardIds.has(set.cardId)) throw { status: 400, message: 'Each card can only be used once.' };
              usedCardIds.add(set.cardId);
              hasHandAnchor = true;
            } else if (set.floorCardIds.length === 0) {
              throw { status: 400, message: 'Each set needs at least one card.' };
            }
            for (const fc of set.floorCardIds) {
              if (!floor.looseCards.includes(fc)) throw { status: 400, message: 'Select floor cards that are actually on the floor.' };
              if (usedFloorIds.has(fc)) throw { status: 400, message: 'Each floor card can only be used once.' };
              usedFloorIds.add(fc);
            }
            const setValue = (set.cardId ? sweepCaptureValue(set.cardId) : 0) + sweepSumValues(set.floorCardIds);
            if (setValue !== bidValue) throw { status: 400, message: `Every set must sum to exactly the bid (${bidValue}).` };
          }
          if (!hasHandAnchor) throw { status: 400, message: 'At least one set must include a card from your hand.' };

          floor.looseCards = floor.looseCards.filter((c) => !usedFloorIds.has(c));
          const newSets = houseSets.map((s) => ({ cards: [...(s.cardId ? [s.cardId] : []), ...s.floorCardIds] }));
          const existing = floor.houses.find((h) => h.value === bidValue);
          if (existing) {
            existing.sets.push(...newSets);
            if (!existing.ownerTeams.includes(sweepTeamForSeat(bidderSeatIndex))) existing.ownerTeams.push(sweepTeamForSeat(bidderSeatIndex));
            sweepAbsorbMatchingLoose(floor, existing);
          } else {
            const newHouse: SweepHouseSrv = { id: sweepNewHouseId(), value: bidValue, sets: newSets, ownerTeams: [sweepTeamForSeat(bidderSeatIndex)] };
            floor.houses.push(newHouse);
            sweepAbsorbMatchingLoose(floor, newHouse);
          }
          playedCardIds = Array.from(usedCardIds);
        } else {
          if (canCapture) throw { status: 400, message: 'A capture is available — you must capture or build instead of throwing.' };
          floor.looseCards.push(cardId);
        }

        const bidderTeam = sweepTeamForSeat(bidderSeatIndex);
        const capturedByTeam = { team0: [...(game.capturedByTeam?.team0 || [])], team1: [...(game.capturedByTeam?.team1 || [])] };
        let lastCaptureTeam: number | null = game.lastCaptureTeam ?? null;
        const sweepsThisDeal: any[] = [...(game.sweepsThisDeal || [])];
        if (capturedCards.length > 0) {
          (bidderTeam === 0 ? capturedByTeam.team0 : capturedByTeam.team1).push(...capturedCards);
          lastCaptureTeam = bidderTeam;
          if (sweep) sweepsThisDeal.push({ team: bidderTeam, at: new Date().toISOString() });
        }

        // Deal the rest: bidder tops up to handSize (already holds 4, minus the one just played);
        // everyone else gets a full handSize straight from the shared rest deck. 2-player games
        // deal in two 12-card batches instead of one 24-card batch — the leftover half of the
        // rest deck is stashed in `secret/reserveDeck` for /api/sweep/play to deal out once both
        // hands empty, continuing the SAME deal rather than ending it. This mirrors how a
        // 4-player deal naturally paces (everyone always holds 12), which 2-player otherwise
        // can't match since 48/2 = 24 in one shot.
        const isTwoPlayerBatched = playerCount === 2;
        const handSize = isTwoPlayerBatched ? 12 : 48 / playerCount;
        const restDeck: string[] = restDeckSnap.data()!.cards || [];
        let cursor = 0;
        const bidderRemaining = bidderCards.filter((c) => !playedCardIds.includes(c));
        const bidderExtra = restDeck.slice(cursor, cursor + (handSize - 4));
        cursor += handSize - 4;
        tx.update(handRef, { cards: [...bidderRemaining, ...bidderExtra] });

        const newPlayers = players.map((p: any, i: number) => {
          if (i === bidderSeatIndex) return { ...p, handCount: handSize - playedCardIds.length };
          const dealt = restDeck.slice(cursor, cursor + handSize);
          cursor += handSize;
          tx.set(gameRef.collection('hands').doc(p.uid), { cards: dealt });
          return { ...p, handCount: handSize };
        });

        if (isTwoPlayerBatched) {
          const leftover = restDeck.slice(cursor);
          if (leftover.length > 0) tx.set(reserveDeckRef, { cards: leftover });
        }
        tx.delete(restDeckRef);
        tx.update(gameRef, {
          status: 'active',
          floor,
          players: newPlayers,
          currentTurnSeatIndex: sweepNextSeat(bidderSeatIndex, playerCount),
          cardsPlayedThisDeal: 1,
          capturedByTeam,
          lastCaptureTeam,
          sweepsThisDeal,
          lastAction: {
            text:
              action === 'capture'
                ? `${bidder.displayName} played ${sweepCardLabel(cardId)} — captured the floor.`
                : action === 'house'
                ? `${bidder.displayName} built a house${playedCardIds.length > 1 ? ` with ${playedCardIds.map(sweepCardLabel).join(' + ')}` : ` with ${sweepCardLabel(playedCardIds[0])}`}.`
                : `${bidder.displayName} played ${sweepCardLabel(cardId)} — threw it loose.`,
            at: new Date().toISOString(),
          },
        });

        const nextSeatIdx = sweepNextSeat(bidderSeatIndex, playerCount);
        const nextPlayer = newPlayers[nextSeatIdx];
        if (nextPlayer) {
          turnNotice = {
            nextPlayerUid: nextPlayer.uid,
            opponentNames: newPlayers.filter((p) => p.uid !== nextPlayer.uid).map((p) => p.displayName).filter(Boolean).join(', ') || null,
          };
        }
      });

      if (turnNotice) {
        await notifyGameTurn(db, { gameType: 'sweep', gameId, nextPlayerUid: turnNotice.nextPlayerUid, movedByUid: decoded.uid, opponentNames: turnNotice.opponentNames }).catch(
          (err) => console.error('notifyGameTurn (sweep resolve-bid) failed:', err),
        );
      }

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sweep/resolve-bid error:', error);
      return res.status(500).json({ error: 'Unable to resolve the bid.' });
    }
  });

  // The regular-turn action, used for every card after the opening bid. See the header comment
  // above for the full rule set this validates.
  app.post('/api/sweep/play', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const cardId = String(req.body?.cardId || '');
    const action = String(req.body?.action || '');
    const extraLooseCardIds: string[] = Array.isArray(req.body?.extraLooseCardIds) ? req.body.extraLooseCardIds.filter((c: unknown) => typeof c === 'string') : [];
    const houseIds: string[] = Array.isArray(req.body?.houseIds) ? req.body.houseIds.filter((c: unknown) => typeof c === 'string') : [];
    const floorCardIds: string[] = Array.isArray(req.body?.floorCardIds) ? req.body.floorCardIds.filter((c: unknown) => typeof c === 'string') : [];
    const targetHouseId = req.body?.targetHouseId ? String(req.body.targetHouseId) : null;
    if (!gameId || !cardId) return res.status(400).json({ error: 'gameId and cardId are required.' });
    if (!['capture', 'house', 'throw'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const handRef = gameRef.collection('hands').doc(decoded.uid);
      const reserveDeckRef = gameRef.collection('secret').doc('reserveDeck');
      let turnNotice: { nextPlayerUid: string; opponentNames: string | null } | null = null;

      await db.runTransaction(async (tx) => {
        const [gameSnap, handSnap, reserveSnap] = await Promise.all([tx.get(gameRef), tx.get(handRef), tx.get(reserveDeckRef)]);
        if (!gameSnap.exists || !handSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players;
        const playerCount: number = game.playerCount;
        const mySeatIndex: number = game.currentTurnSeatIndex;
        const mySeat = players[mySeatIndex];
        if (!mySeat || mySeat.uid !== decoded.uid) throw { status: 403, message: 'Not your turn.' };

        const hand = handSnap.data()!;
        const cards: string[] = hand.cards || [];
        if (!cards.includes(cardId)) throw { status: 400, message: 'That card is not in your hand.' };
        const remainingHand = cards.filter((c) => c !== cardId);
        const value = sweepCaptureValue(cardId);
        const myTeam = sweepTeamForSeat(mySeatIndex);

        let floor = sweepCloneFloor(game.floor);
        if (action === 'throw' && sweepCanCapture(floor, value)) {
          throw { status: 400, message: 'That card can capture something on the floor — throw it loose only when nothing matches.' };
        }

        const capturedCards: string[] = [];
        let sweep = false;

        if (action === 'capture') {
          const directLoose = floor.looseCards.filter((c) => sweepCaptureValue(c) === value);
          const directHouses = floor.houses.filter((h) => h.value === value);
          // Cards that already directly match are auto-captured below regardless of what the
          // client sent — silently drop any of them (and any duplicate house id) out of the
          // "extra" selections rather than rejecting the whole request, since it's easy for a
          // player to tap an already-auto-included card while building their extra combo.
          const requestedExtra = extraLooseCardIds.filter((c) => !directLoose.includes(c));
          if (!requestedExtra.every((c) => floor.looseCards.includes(c))) {
            throw { status: 400, message: 'Select loose floor cards that are actually on the floor.' };
          }
          const requestedHouseIds = houseIds.filter((id) => !directHouses.some((h) => h.id === id));
          const chosenHouses = requestedHouseIds.map((id) => {
            const h = floor.houses.find((x) => x.id === id);
            if (!h) throw { status: 400, message: 'That house is no longer on the floor.' };
            return h;
          });
          // A strong house (2+ sets) is locked to its own value and can only ever be captured
          // standing alone at exactly that value — never folded into a bigger combined sum. A
          // WEAK house (a single, not-yet-locked set) is more flexible: its current value can be
          // folded into a combined-value capture right alongside loose cards, e.g. a House·10
          // plus a loose 3 both captured together by a King. Multiple strong houses each
          // independently worth `value` remain fully supported (each is already a complete group
          // on its own, so it never needs to go through the partition check below).
          const chosenStrongHouses = chosenHouses.filter((h) => h.sets.length > 1);
          if (chosenStrongHouses.some((h) => h.value !== value)) {
            throw { status: 400, message: `A strong house can only be captured by a card matching its exact value (${value}).` };
          }
          const chosenWeakHouses = chosenHouses.filter((h) => h.sets.length === 1);
          // The combined loose-card + weak-house selection can be MULTIPLE independent groups
          // worth `value` each (e.g. a 5+6 group AND a separate House·7-plus-loose-4 group, both
          // captured together by the same played 11) — not just one combined blob — so this
          // checks for a valid exact partition, not a flat sum.
          const comboValues = [...requestedExtra.map(sweepCaptureValue), ...chosenWeakHouses.map((h) => h.value)];
          if (comboValues.length > 0 && !sweepCanPartitionIntoGroups(comboValues, value)) {
            throw { status: 400, message: `Your extra floor/house selection must split into one or more groups that each sum to exactly ${value}.` };
          }
          if (directLoose.length === 0 && directHouses.length === 0 && requestedExtra.length === 0 && chosenHouses.length === 0) {
            throw { status: 400, message: 'Nothing on the floor matches that card.' };
          }
          capturedCards.push(cardId, ...directLoose, ...requestedExtra, ...directHouses.flatMap((h) => sweepAllCardsOf(h)), ...chosenHouses.flatMap((h) => sweepAllCardsOf(h)));
          const removedLoose = new Set([...directLoose, ...requestedExtra]);
          floor.looseCards = floor.looseCards.filter((c) => !removedLoose.has(c));
          const removedHouseIds = new Set([...directHouses.map((h) => h.id), ...chosenHouses.map((h) => h.id)]);
          floor.houses = floor.houses.filter((h) => !removedHouseIds.has(h.id));
          sweep = floor.looseCards.length === 0 && floor.houses.length === 0;
        } else if (action === 'house') {
          if (targetHouseId) {
            const house = floor.houses.find((h) => h.id === targetHouseId);
            if (!house) throw { status: 400, message: 'That house is no longer on the floor.' };
            if (!floorCardIds.every((c) => floor.looseCards.includes(c))) {
              throw { status: 400, message: 'Select loose floor cards that are actually on the floor.' };
            }
            const newSetCards = [cardId, ...floorCardIds];
            const newSetSum = sweepSumValues(newSetCards);
            // Every selected card independently worth the house's number (e.g. playing a 9 plus a
            // loose 9 onto a House·9) forms its OWN one-card set each, rather than being summed
            // together into one oversized group — two 9s make a two-set House·9, not an (invalid)
            // 18. Falls back to the plain summed-set case below whenever that's not what's going on.
            const allIndividuallyMatchHouse = newSetCards.every((c) => sweepCaptureValue(c) === house.value);

            if (allIndividuallyMatchHouse || newSetSum === house.value) {
              // Contributing (a) new set(s) that already match the house's CURRENT number — legal
              // against a weak house too (that's exactly how a weak house becomes strong), not
              // just a strong one. Checked before the "change a weak house's value" branch below,
              // since a card whose own value already equals the house number can never legally
              // extend that house's existing set (the sum could only grow past it).
              const eligible = sweepTeamOwnsValue(floor, myTeam, house.value) || remainingHand.some((c) => sweepCaptureValue(c) === house.value);
              if (!eligible) throw { status: 400, message: `You need a card worth ${house.value} left in hand to add to that house.` };
              floor.looseCards = floor.looseCards.filter((c) => !floorCardIds.includes(c));
              if (allIndividuallyMatchHouse) {
                for (const c of newSetCards) house.sets.push({ cards: [c] });
              } else {
                house.sets.push({ cards: newSetCards });
              }
              if (!house.ownerTeams.includes(myTeam)) house.ownerTeams.push(myTeam);
            } else if (house.sets.length === 1) {
              // Weak house — this can be "changed" to a whole new number by extending its only set.
              const extendedSetCards = [...house.sets[0].cards, cardId, ...floorCardIds];
              const newValue = sweepSumValues(extendedSetCards);
              if (newValue < 9 || newValue > 13) throw { status: 400, message: 'A house must be worth 9-13.' };
              const eligible = sweepTeamOwnsValue(floor, myTeam, newValue) || remainingHand.some((c) => sweepCaptureValue(c) === newValue);
              if (!eligible) throw { status: 400, message: `You need another card worth ${newValue} left in hand to change this house.` };
              floor.looseCards = floor.looseCards.filter((c) => !floorCardIds.includes(c));
              const other = floor.houses.find((h) => h.id !== house.id && h.value === newValue);
              if (other) {
                other.sets.push({ cards: extendedSetCards });
                if (!other.ownerTeams.includes(myTeam)) other.ownerTeams.push(myTeam);
                floor.houses = floor.houses.filter((h) => h.id !== house.id);
                sweepAbsorbMatchingLoose(floor, other);
              } else {
                house.value = newValue;
                house.sets = [{ cards: extendedSetCards }];
                house.ownerTeams = [myTeam]; // full ownership transfer to whoever changed it
                sweepAbsorbMatchingLoose(floor, house);
              }
            } else {
              // Strong house, and the new set doesn't match its current number — strong houses can
              // never change value, only gain more sets worth exactly the existing house number.
              throw { status: 400, message: `A strong house can't change value — that group must sum to exactly ${house.value}.` };
            }
          } else {
            // Brand-new house from scratch — zero floor cards is legal too: a card whose own
            // value is already 9-13 can be staked as its own lone-card weak house (distinct from
            // a same-value loose card sitting there — a house is owned, and teammates can freely
            // pile more matching-sum sets onto it later, unlike a plain loose card).
            if (!floorCardIds.every((c) => floor.looseCards.includes(c))) {
              throw { status: 400, message: 'Select loose floor cards that are actually on the floor.' };
            }
            const newSetCards = [cardId, ...floorCardIds];
            const baseValue = sweepCaptureValue(cardId);
            // If the played card's own value is already a valid house number, and every OTHER
            // selected card independently matches that same value too (e.g. playing a 9 alongside
            // a loose 9), each becomes its own one-card set — an instant two-set (strong) house —
            // rather than summing them into one oversized, invalid group.
            const allIndividuallyMatchBase = baseValue >= 9 && baseValue <= 13 && floorCardIds.every((c) => sweepCaptureValue(c) === baseValue);
            let newValue: number;
            let newSets: SweepSetSrv[];
            if (allIndividuallyMatchBase) {
              newValue = baseValue;
              newSets = newSetCards.map((c) => ({ cards: [c] }));
            } else {
              newValue = sweepSumValues(newSetCards);
              if (newValue < 9 || newValue > 13) throw { status: 400, message: 'A house must be worth 9-13.' };
              newSets = [{ cards: newSetCards }];
            }
            floor.looseCards = floor.looseCards.filter((c) => !floorCardIds.includes(c));
            const existing = floor.houses.find((h) => h.value === newValue);
            if (existing) {
              const eligible = sweepTeamOwnsValue(floor, myTeam, newValue) || remainingHand.some((c) => sweepCaptureValue(c) === newValue);
              if (!eligible) throw { status: 400, message: `You need another card worth ${newValue} left in hand to contribute to that house.` };
              existing.sets.push(...newSets);
              if (!existing.ownerTeams.includes(myTeam)) existing.ownerTeams.push(myTeam);
              sweepAbsorbMatchingLoose(floor, existing);
            } else {
              if (!remainingHand.some((c) => sweepCaptureValue(c) === newValue)) {
                throw { status: 400, message: `You need another card worth ${newValue} left in hand to claim this house.` };
              }
              const newHouse: SweepHouseSrv = { id: sweepNewHouseId(), value: newValue, sets: newSets, ownerTeams: [myTeam] };
              floor.houses.push(newHouse);
              sweepAbsorbMatchingLoose(floor, newHouse);
            }
          }
        } else {
          floor.looseCards.push(cardId);
        }

        const capturedByTeam = { team0: [...(game.capturedByTeam?.team0 || [])], team1: [...(game.capturedByTeam?.team1 || [])] };
        let lastCaptureTeam: number | null = game.lastCaptureTeam ?? null;
        const cardsPlayedThisDeal: number = (game.cardsPlayedThisDeal || 0) + 1;
        const sweepsThisDeal: any[] = [...(game.sweepsThisDeal || [])];
        const newPlayers = players.map((p: any, i: number) => (i === mySeatIndex ? { ...p, handCount: remainingHand.length } : p));
        const dealOver = newPlayers.every((p: any) => p.handCount === 0);

        // Must read BEFORE the tx.update(handRef,...) write just below — Firestore requires every
        // read in a transaction before any write, and this handler can't tell whether this play
        // actually finishes the GAME (not just the deal) until well after that write. Pre-fetch
        // unconditionally whenever the deal is ending (a superset of "game finishes" — also covers
        // the ordinary deal_end and the 2-player mid-deal redeal cases, where these reads are simply
        // never used) so the winner can be decided later, safely, in the write phase.
        const gamePointsStates = dealOver
          ? await readGamePointsPlan(tx, db, { gameType: 'sweep', gameId, playerUids: players.map((p: any) => p.uid) })
          : null;

        if (capturedCards.length > 0) {
          (myTeam === 0 ? capturedByTeam.team0 : capturedByTeam.team1).push(...capturedCards);
          lastCaptureTeam = myTeam;
          if (sweep && !dealOver) sweepsThisDeal.push({ team: myTeam, at: new Date().toISOString() });
        }

        tx.update(handRef, { cards: remainingHand });

        const playedLabel = sweepCardLabel(cardId);
        const actionText =
          action === 'capture'
            ? `${mySeat.displayName} played ${playedLabel} — captured.`
            : action === 'house'
            ? targetHouseId
              ? `${mySeat.displayName} played ${playedLabel} — built onto a house.`
              : `${mySeat.displayName} played ${playedLabel} — built a house.`
            : `${mySeat.displayName} played ${playedLabel} — threw it loose.`;

        // 2-player games deal in two 12-card batches per deal (see /api/sweep/resolve-bid) —
        // once both hands empty from the first batch, silently deal the stashed second batch and
        // keep playing the SAME deal, rather than ending it early like a normal dealOver would.
        if (dealOver && playerCount === 2 && reserveSnap.exists) {
          const reserve: string[] = reserveSnap.data()!.cards || [];
          if (reserve.length > 0) {
            const batchSize = reserve.length / playerCount;
            const redealtPlayers = newPlayers.map((p: any, i: number) => {
              const dealt = reserve.slice(i * batchSize, (i + 1) * batchSize);
              tx.set(gameRef.collection('hands').doc(p.uid), { cards: dealt });
              return { ...p, handCount: dealt.length };
            });
            tx.delete(reserveDeckRef);
            tx.update(gameRef, {
              floor,
              players: redealtPlayers,
              currentTurnSeatIndex: sweepNextSeat(mySeatIndex, playerCount),
              cardsPlayedThisDeal,
              capturedByTeam,
              lastCaptureTeam,
              sweepsThisDeal,
              lastAction: { text: `${actionText} Next 12 cards dealt to each player.`, at: new Date().toISOString() },
            });
            const nextPlayer = redealtPlayers[sweepNextSeat(mySeatIndex, playerCount)];
            if (nextPlayer) {
              turnNotice = {
                nextPlayerUid: nextPlayer.uid,
                opponentNames: redealtPlayers.filter((p: any) => p.uid !== nextPlayer.uid).map((p: any) => p.displayName).filter(Boolean).join(', ') || null,
              };
            }
            return;
          }
        }

        if (!dealOver) {
          tx.update(gameRef, {
            floor,
            players: newPlayers,
            currentTurnSeatIndex: sweepNextSeat(mySeatIndex, playerCount),
            cardsPlayedThisDeal,
            capturedByTeam,
            lastCaptureTeam,
            sweepsThisDeal,
            lastAction: { text: actionText, at: new Date().toISOString() },
          });
          const nextPlayer = newPlayers[sweepNextSeat(mySeatIndex, playerCount)];
          if (nextPlayer) {
            turnNotice = {
              nextPlayerUid: nextPlayer.uid,
              opponentNames: newPlayers.filter((p: any) => p.uid !== nextPlayer.uid).map((p: any) => p.displayName).filter(Boolean).join(', ') || null,
            };
          }
          return;
        }

        // Deal over — the last turn never triggers a sweep even if it empties the floor; any
        // leftover floor material just goes to whoever captured most recently.
        if (lastCaptureTeam != null) {
          const leftover = [...floor.looseCards, ...floor.houses.flatMap((h) => sweepAllCardsOf(h))];
          if (leftover.length > 0) (lastCaptureTeam === 0 ? capturedByTeam.team0 : capturedByTeam.team1).push(...leftover);
        }
        floor = { looseCards: [], houses: [] };

        const sweepCount: [number, number] = [0, 0];
        for (const s of sweepsThisDeal) sweepCount[s.team as 0 | 1] += 1;
        const sweepPoints: number = game.sweepPoints;
        const teamPoints: [number, number] = [
          sweepSumPoints(capturedByTeam.team0) + sweepCount[0] * sweepPoints,
          sweepSumPoints(capturedByTeam.team1) + sweepCount[1] * sweepPoints,
        ];

        const dealWinner: 0 | 1 | 'tie' = teamPoints[0] > teamPoints[1] ? 0 : teamPoints[1] > teamPoints[0] ? 1 : 'tie';
        const diff = teamPoints[0] - teamPoints[1];
        const netScore: number = (game.netScore || 0) + diff;

        let status = 'deal_end';
        let winnerTeam: 0 | 1 | null = null;
        let newDealerSeatIndex = game.dealerSeatIndex;
        if (Math.abs(netScore) >= 100) {
          status = 'finished';
          winnerTeam = netScore > 0 ? 0 : 1;
        } else if (dealWinner !== 'tie') {
          const losingTeam: 0 | 1 = dealWinner === 0 ? 1 : 0;
          newDealerSeatIndex = sweepNextDealerSeat(newDealerSeatIndex, losingTeam, playerCount);
        }
        // A tied deal keeps the same dealer — newDealerSeatIndex is left unchanged in that case.
        const dealHistoryEntry = {
          dealNumber: game.dealNumber,
          teamPoints,
          sweepCount,
          winnerTeam: dealWinner,
          netScoreAfter: netScore,
          capturedByTeam,
        };

        // Pure writes from here — gamePointsStates was already read up front (see comment above),
        // so this is safe to call alongside the tx.update below regardless of order.
        const sweepFinishedAt = status === 'finished' ? new Date().toISOString() : null;
        if (status === 'finished' && winnerTeam !== null && gamePointsStates) {
          writeGamePointsPlan(tx, gamePointsStates, {
            gameType: 'sweep', gameId,
            winnerUids: newPlayers.filter((p: any) => p.team === winnerTeam).map((p: any) => p.uid),
          });
          recordGameOutcome(tx, db, gameId, {
            gameType: 'sweep', playerUids: newPlayers.map((p: any) => p.uid),
            players: newPlayers.map((p: any) => ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL, team: p.team })),
            winnerTeam, finishedAt: sweepFinishedAt,
          });
        }
        tx.update(gameRef, {
          status,
          floor,
          players: newPlayers,
          dealerSeatIndex: newDealerSeatIndex,
          capturedByTeam,
          lastCaptureTeam,
          sweepsThisDeal,
          netScore,
          winnerTeam,
          finishedAt: sweepFinishedAt,
          lastDealSummary: { dealNumber: game.dealNumber, teamPoints, sweepCount, winnerTeam: dealWinner, netScoreAfter: netScore },
          dealHistory: [...(game.dealHistory || []), dealHistoryEntry],
          lastAction: { text: `${actionText} Deal ${game.dealNumber} is over.`, at: new Date().toISOString() },
        });
      });

      if (turnNotice) {
        await notifyGameTurn(db, { gameType: 'sweep', gameId, nextPlayerUid: turnNotice.nextPlayerUid, movedByUid: decoded.uid, opponentNames: turnNotice.opponentNames }).catch(
          (err) => console.error('notifyGameTurn (sweep play) failed:', err),
        );
      }

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sweep/play error:', error);
      return res.status(500).json({ error: 'Unable to play that card.' });
    }
  });

  // Host-only continuation from the deal-summary screen into the next deal — the match itself only
  // ends inside /api/sweep/play once a deal pushes the net score to +-100.
  app.post('/api/sweep/deal', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can deal the next hand.' });
      if (game.status !== 'deal_end') return res.status(400).json({ error: 'Not ready for the next deal.' });
      const players: any[] = game.players;
      const playerCount: number = game.playerCount;

      const { bidderSeatIndex, bidderHand, floorCards, restDeck } = sweepDealHand(game.dealerSeatIndex, playerCount);
      const bidderUid = players[bidderSeatIndex].uid;

      const oldHandsSnap = await gameRef.collection('hands').get();
      const batch = db.batch();
      oldHandsSnap.docs.forEach((d) => batch.delete(d.ref));
      batch.set(gameRef.collection('hands').doc(bidderUid), { cards: bidderHand });
      batch.set(gameRef.collection('secret').doc('floorCards'), { cards: floorCards });
      batch.set(gameRef.collection('secret').doc('restDeck'), { cards: restDeck });
      batch.update(gameRef, {
        status: 'bidding',
        bidderSeatIndex,
        currentTurnSeatIndex: bidderSeatIndex,
        dealNumber: (game.dealNumber || 1) + 1,
        floor: { looseCards: [], houses: [] },
        floorHiddenCount: 4,
        bidValue: null,
        cardsPlayedThisDeal: 0,
        lastCaptureTeam: null,
        capturedByTeam: { team0: [], team1: [] },
        sweepsThisDeal: [],
        lastDealSummary: null,
        players: players.map((p, i) => ({ ...p, handCount: i === bidderSeatIndex ? 4 : 0 })),
        lastAction: { text: 'New deal — waiting on the bid.', at: new Date().toISOString() },
      });
      await batch.commit();
      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sweep/deal error:', error);
      return res.status(500).json({ error: 'Unable to deal the next hand.' });
    }
  });

  // Ends a mid-match game early — any player (not just the host) can call this, same as Ludo's
  // "End Game". Sets status straight to 'finished' with no winner declared, which is what then
  // makes /api/sweep/delete available for it (delete is blocked for anything but waiting/finished,
  // to protect other players genuinely mid-match — this is the escape hatch for a stuck/abandoned
  // game rather than a rules change to delete itself).
  app.post('/api/sweep/end', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (!['bidding', 'active', 'deal_end'].includes(game.status)) {
        return res.status(400).json({ error: 'This game is not in progress.' });
      }
      const ender = (game.players || []).find((p: any) => p.uid === decoded.uid);
      await gameRef.update({
        status: 'finished',
        winnerTeam: null,
        finishedAt: new Date().toISOString(),
        lastAction: { text: `${ender?.displayName || 'A player'} ended the game early.`, at: new Date().toISOString() },
      });
      return res.json({ ok: true });
    } catch (error) {
      console.error('sweep/end error:', error);
      return res.status(500).json({ error: 'Unable to end game.' });
    }
  });

  // Host-only, and only while the game hasn't started (or is already over) — any mid-match status
  // has other players actively at the table. Cascades the hands/secret subcollections and the
  // game-code pointer doc via the Admin SDK, since clients can't reach those directly.
  app.post('/api/sweep/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (!['waiting', 'finished'].includes(game.status)) {
        return res.status(400).json({ error: 'Cannot delete a game in progress.' });
      }

      const [handsSnap, secretSnap] = await Promise.all([
        gameRef.collection('hands').get(),
        gameRef.collection('secret').get(),
      ]);
      const batch = db.batch();
      handsSnap.docs.forEach((d) => batch.delete(d.ref));
      secretSnap.docs.forEach((d) => batch.delete(d.ref));
      if (game.code) batch.delete(db.collection('sweepGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('sweep/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  // Same idempotent rematch pattern as Rummy/Business.
  app.post('/api/sweep/rematch', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sweepGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'finished') return res.status(400).json({ error: 'Game is not finished yet.' });

      if (game.rematchGameId) return res.json({ gameId: game.rematchGameId });

      const newGameRef = db.collection('sweepGames').doc();
      let code = generateShareCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.collection('sweepGameCodes').doc(code).get();
        if (!existing.exists) break;
        code = generateShareCode();
      }

      const players = (game.players || []).map((p: any) => ({
        uid: p.uid,
        displayName: p.displayName,
        photoURL: p.photoURL,
        seatIndex: p.seatIndex,
        team: p.team,
        handCount: 0,
      }));

      const batch = db.batch();
      batch.set(newGameRef, {
        hostUid: decoded.uid,
        code,
        status: 'waiting',
        playerCount: game.playerCount,
        sweepPoints: game.sweepPoints,
        players,
        playerUids: game.playerUids,
        dealerSeatIndex: 0,
        currentTurnSeatIndex: 0,
        dealNumber: 0,
        floor: { looseCards: [], houses: [] },
        floorHiddenCount: 0,
        bidderSeatIndex: null,
        bidValue: null,
        cardsPlayedThisDeal: 0,
        lastCaptureTeam: null,
        capturedByTeam: { team0: [], team1: [] },
        sweepsThisDeal: [],
        netScore: 0,
        lastDealSummary: null,
        dealHistory: [],
        winnerTeam: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        rematchGameId: null,
      });
      batch.set(db.collection('sweepGameCodes').doc(code), { gameId: newGameRef.id, hostUid: decoded.uid });
      batch.update(gameRef, { rematchGameId: newGameRef.id });
      await batch.commit();

      return res.json({ gameId: newGameRef.id });
    } catch (error) {
      console.error('sweep/rematch error:', error);
      return res.status(500).json({ error: 'Unable to start rematch.' });
    }
  });

  // ===================== Sequence =====================
  // Hidden information (opponents' hands, and what's left in the draw pile) means this, like
  // Rummy/Sweep, can't use Ludo/Business/Chess's "trust the client" pattern — every action that
  // touches hidden state goes through these Admin-SDK-backed endpoints. The BOARD itself is fully
  // public (chips are visible to everyone the instant they're placed), so unlike Sweep there's no
  // "secret floor" phase — gameplay is a single steady loop of play/draw/next-turn.
  //
  // The 10x10 board layout is an ORIGINAL arrangement (see BOARD_LAYOUT below and its counterpart
  // in src/lib/sequence.ts) — generated once with a seeded shuffle, not copied from any commercial
  // Sequence board, since the specific commercial layout is Jax Ltd's trade dress. Same reasoning
  // as keeping this game's board original instead of a literal clone.
  const SEQUENCE_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SEQUENCE_SUITS = ['S', 'H', 'D', 'C'];
  const SEQUENCE_TWO_EYED_JACKS = ['JC', 'JD'];
  const SEQUENCE_ONE_EYED_JACKS = ['JH', 'JS'];
  const SEQUENCE_BOARD_LAYOUT: string[] = [
    'FREE', '7S', '2H', '3D', '8C', '2S', '3D', '7H', 'QC', 'FREE',
    '8C', '5S', 'KD', '10H', 'AH', '9D', 'AD', '3C', '7D', '9C',
    'AC', '2D', '5D', 'KS', '8H', '3S', '8S', '5S', '8H', '2D',
    '7S', '3C', '8D', '6C', '3H', 'QC', '10C', '5H', '10S', '4S',
    '2S', '6D', '4D', '10S', 'KC', '9C', '10D', '4C', '4C', 'AS',
    'QH', 'QS', '4S', 'KC', 'QS', '3S', '9H', 'QH', 'AH', '4D',
    '9H', '3H', '10H', 'KS', 'QD', '2H', '7C', 'AD', '8D', '10C',
    'KH', '7H', '7C', '2C', '5D', 'AC', '4H', 'AS', '6H', '9S',
    '5H', '6H', 'KH', '5C', '8S', '6S', '9D', '6C', '10D', 'KD',
    'FREE', '5C', '2C', '6S', '9S', '4H', '6D', 'QD', '7D', 'FREE',
  ];
  const SEQUENCE_CORNERS = [0, 9, 90, 99];
  const SEQUENCE_CARD_TO_CELLS: Record<string, number[]> = (() => {
    const map: Record<string, number[]> = {};
    SEQUENCE_BOARD_LAYOUT.forEach((c, i) => {
      if (c === 'FREE') return;
      (map[c] ||= []).push(i);
    });
    return map;
  })();
  const SEQUENCE_HAND_SIZE: Record<number, number> = { 2: 7, 3: 6, 4: 6, 6: 5, 8: 4, 9: 4, 10: 3, 12: 3 };
  const SEQUENCE_DIRECTIONS: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function sequenceBuildShoe(): string[] {
    const deck: string[] = [];
    for (let d = 0; d < 2; d++) {
      for (const r of SEQUENCE_RANKS) for (const s of SEQUENCE_SUITS) deck.push(`${r}${s}`);
    }
    return deck; // 104 cards
  }

  function sequenceShuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 2 or 3 players play every seat for itself; every other supported count is fixed partnerships
  // — pairs of 2 for 4/6/8/10/12, or 3 teams of 3 for 9 (official rules allow either reading for
  // 9; this project picks teams, matching every other count above 3). See src/lib/sequence.ts's
  // matching comment for the full reasoning.
  function sequenceSideCount(playerCount: number): number {
    if (playerCount === 3) return 3;
    if (playerCount === 9) return 3;
    return 2;
  }
  function sequenceSideForSeat(seatIndex: number, playerCount: number): number {
    return seatIndex % sequenceSideCount(playerCount);
  }
  function sequenceSequencesToWin(playerCount: number): number {
    return sequenceSideCount(playerCount) === 3 ? 1 : 2;
  }
  function sequenceCellEligible(board: (number | null)[], idx: number, side: number): boolean {
    return SEQUENCE_CORNERS.includes(idx) || board[idx] === side;
  }

  // See src/lib/sequence.ts's `findNewSequences` doc comment for the reasoning behind the overlap
  // cap — this is a byte-for-byte duplicate (server.ts never imports from src/lib, matching every
  // other hidden-info game in this file).
  function sequenceFindNewSequences(board: (number | null)[], lockedCells: Set<number>, placedIdx: number, side: number): number[][] {
    const row = Math.floor(placedIdx / 10);
    const col = placedIdx % 10;
    const candidates: number[][] = [];

    for (const [dr, dc] of SEQUENCE_DIRECTIONS) {
      let minK = 0;
      while (true) {
        const r = row + dr * (minK - 1);
        const c = col + dc * (minK - 1);
        if (r < 0 || r > 9 || c < 0 || c > 9) break;
        const idx = r * 10 + c;
        if (!sequenceCellEligible(board, idx, side)) break;
        minK--;
      }
      let maxK = 0;
      while (true) {
        const r = row + dr * (maxK + 1);
        const c = col + dc * (maxK + 1);
        if (r < 0 || r > 9 || c < 0 || c > 9) break;
        const idx = r * 10 + c;
        if (!sequenceCellEligible(board, idx, side)) break;
        maxK++;
      }
      for (let start = minK; start + 4 <= maxK; start++) {
        if (!(start <= 0 && start + 4 >= 0)) continue;
        const window: number[] = [];
        for (let k = start; k < start + 5; k++) {
          const r = row + dr * k;
          const c = col + dc * k;
          window.push(r * 10 + c);
        }
        candidates.push(window);
      }
    }

    const accepted: number[][] = [];
    const claimed = new Set(lockedCells);
    const seenKeys = new Set<string>();
    for (const window of candidates) {
      const key = [...window].sort((a, b) => a - b).join(',');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const overlap = window.filter((i) => claimed.has(i)).length;
      if (overlap <= 1) {
        accepted.push(window);
        window.forEach((i) => claimed.add(i));
      }
    }
    return accepted;
  }

  // Deals the first hand for a brand-new match. Host-only, requires the lobby to be exactly full.
  // Wrapped in a transaction (not a plain read-then-batch-write) so a double-tapped Start Game
  // button can't race two concurrent deals against the same game doc — the second attempt's
  // read/write set now genuinely conflicts with the first's inside Firestore's transaction
  // machinery instead of both silently reading 'waiting' before either commits.
  app.post('/api/sequence/start', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sequenceGames').doc(gameId);

      await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.hostUid !== decoded.uid) throw { status: 403, message: 'Only the host can start the game.' };
        if (game.status !== 'waiting') throw { status: 400, message: 'Game already started.' };
        const players: any[] = game.players || [];
        const playerCount: number = game.playerCount;
        if (players.length !== playerCount) throw { status: 400, message: `Need exactly ${playerCount} players to start.` };

        const handSize = SEQUENCE_HAND_SIZE[playerCount];
        const shoe = sequenceShuffle(sequenceBuildShoe());
        const hands: string[][] = [];
        let cursor = 0;
        for (let i = 0; i < playerCount; i++) {
          hands.push(shoe.slice(cursor, cursor + handSize));
          cursor += handSize;
        }
        const deck = shoe.slice(cursor);
        const startSeat = Math.floor(Math.random() * playerCount);

        players.forEach((p, i) => tx.set(gameRef.collection('hands').doc(p.uid), { cards: hands[i] }));
        tx.set(gameRef.collection('secret').doc('deck'), { cards: deck });
        tx.update(gameRef, {
          status: 'active',
          currentTurnSeatIndex: startSeat,
          board: new Array(100).fill(null),
          lockedCells: [],
          sequences: [],
          lastPlacedCell: null,
          sequenceCountBySide: new Array(sequenceSideCount(playerCount)).fill(0),
          winnerSide: null,
          cardsRemaining: deck.length,
          startedAt: new Date().toISOString(),
          players: players.map((p, i) => ({ ...p, handCount: hands[i].length })),
          lastAction: { text: `${players[startSeat].displayName} goes first.`, at: new Date().toISOString() },
        });
      });
      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sequence/start error:', error);
      return res.status(500).json({ error: 'Unable to start game.' });
    }
  });

  // The core turn action — place a chip (matching card, or wild via a two-eyed jack), remove an
  // opponent's chip (one-eyed jack), or exchange a "dead" card (both its board spots already
  // covered, or — for a one-eyed jack — no removable opponent chip exists anywhere) for a fresh
  // one without placing/removing anything. Every branch ends the same way: discard the played
  // card, draw a replacement (if any remain), advance the turn.
  app.post('/api/sequence/play', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const cardId = String(req.body?.cardId || '');
    const action = String(req.body?.action || '');
    const cellIndex = req.body?.cellIndex != null ? Number(req.body.cellIndex) : null;
    if (!gameId || !cardId) return res.status(400).json({ error: 'gameId and cardId are required.' });
    if (!['place', 'remove', 'dead'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });

    try {
      const gameRef = db.collection('sequenceGames').doc(gameId);
      const handRef = gameRef.collection('hands').doc(decoded.uid);
      const deckRef = gameRef.collection('secret').doc('deck');
      let turnNotice: { nextPlayerUid: string; opponentNames: string | null } | null = null;

      await db.runTransaction(async (tx) => {
        const [gameSnap, handSnap, deckSnap] = await Promise.all([tx.get(gameRef), tx.get(handRef), tx.get(deckRef)]);
        if (!gameSnap.exists || !handSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };
        const players: any[] = game.players;
        const playerCount: number = game.playerCount;
        const mySeatIndex: number = game.currentTurnSeatIndex;
        const mySeat = players[mySeatIndex];
        if (!mySeat || mySeat.uid !== decoded.uid) throw { status: 403, message: 'Not your turn.' };

        const hand: string[] = handSnap.data()!.cards || [];
        if (!hand.includes(cardId)) throw { status: 400, message: 'That card is not in your hand.' };

        const mySide = sequenceSideForSeat(mySeatIndex, playerCount);
        const board: (number | null)[] = (game.board || new Array(100).fill(null)).slice();
        const lockedCells = new Set<number>(game.lockedCells || []);
        const sequenceCountBySide: number[] = [...(game.sequenceCountBySide || [])];
        const isTwoEyed = SEQUENCE_TWO_EYED_JACKS.includes(cardId);
        const isOneEyed = SEQUENCE_ONE_EYED_JACKS.includes(cardId);

        let newlyLocked: number[] = [];
        let newSequenceGroups: { cells: number[]; side: number }[] = [];

        if (action === 'dead') {
          if (isTwoEyed) {
            const anyOpen = board.some((v, i) => v === null && !SEQUENCE_CORNERS.includes(i));
            if (anyOpen) throw { status: 400, message: 'That card can still be played — there are open spaces.' };
          } else if (isOneEyed) {
            const anyRemovable = board.some((v, i) => v !== null && v !== mySide && !lockedCells.has(i));
            if (anyRemovable) throw { status: 400, message: 'That card can still remove a chip.' };
          } else {
            const cells = SEQUENCE_CARD_TO_CELLS[cardId] || [];
            const bothTaken = cells.length === 2 && cells.every((i) => board[i] !== null);
            if (!bothTaken) throw { status: 400, message: 'That card is not dead — you still have an open space for it.' };
          }
        } else if (action === 'place') {
          if (isOneEyed) throw { status: 400, message: 'A one-eyed jack removes a chip — it cannot be placed.' };
          if (cellIndex == null || cellIndex < 0 || cellIndex > 99) throw { status: 400, message: 'A valid cell is required.' };
          if (SEQUENCE_CORNERS.includes(cellIndex)) throw { status: 400, message: 'Corners are already wild for everyone.' };
          if (board[cellIndex] !== null) throw { status: 400, message: 'That space is already taken.' };
          if (!isTwoEyed) {
            const cells = SEQUENCE_CARD_TO_CELLS[cardId] || [];
            if (!cells.includes(cellIndex)) throw { status: 400, message: 'That card does not match that space.' };
          }
          board[cellIndex] = mySide;
          const newSeqs = sequenceFindNewSequences(board, lockedCells, cellIndex, mySide);
          newSeqs.forEach((seq) => seq.forEach((i) => { lockedCells.add(i); newlyLocked.push(i); }));
          newSequenceGroups = newSeqs.map((cells) => ({ cells, side: mySide }));
          sequenceCountBySide[mySide] = (sequenceCountBySide[mySide] || 0) + newSeqs.length;
        } else if (action === 'remove') {
          if (!isOneEyed) throw { status: 400, message: 'Only a one-eyed jack can remove a chip.' };
          if (cellIndex == null || cellIndex < 0 || cellIndex > 99) throw { status: 400, message: 'A valid cell is required.' };
          if (board[cellIndex] === null || board[cellIndex] === mySide) throw { status: 400, message: 'Pick an opponent chip to remove.' };
          if (lockedCells.has(cellIndex)) throw { status: 400, message: 'That chip is part of a completed sequence — it cannot be removed.' };
          board[cellIndex] = null;
        }

        // Computed here, before any write, specifically so the game-points pre-fetch just below
        // can decide whether it's needed BEFORE the deck/hand writes that follow — Firestore
        // requires every read in a transaction before any write (see the Rummy declare-win
        // handler's comment), and this handler can't leave that pre-fetch until after those writes.
        const won = sequenceCountBySide[mySide] >= sequenceSequencesToWin(playerCount);
        const gamePointsStates = won
          ? await readGamePointsPlan(tx, db, { gameType: 'sequence', gameId, playerUids: players.map((p: any) => p.uid) })
          : null;

        // Remove only the ONE played card, not every card matching that value — a two-deck shoe
        // routinely puts duplicate rank+suit cards in the same hand (e.g. two Kings of Hearts),
        // and `.filter(c => c !== cardId)` would silently discard both instead of just the one
        // actually played.
        const playedIdxInHand = hand.indexOf(cardId);
        const remainingHand = [...hand.slice(0, playedIdxInHand), ...hand.slice(playedIdxInHand + 1)];
        const deck: string[] = deckSnap.exists ? deckSnap.data()!.cards || [] : [];
        if (deck.length > 0) {
          remainingHand.push(deck.shift()!);
          tx.set(deckRef, { cards: deck });
        }
        tx.set(handRef, { cards: remainingHand });

        const nextSeat = (mySeatIndex + 1) % playerCount;
        const newPlayers = players.map((p: any, i: number) => (i === mySeatIndex ? { ...p, handCount: remainingHand.length } : p));

        const actionText =
          action === 'dead'
            ? `${mySeat.displayName} exchanged a dead card.`
            : action === 'remove'
            ? `${mySeat.displayName} removed a chip.`
            : `${mySeat.displayName} placed a chip.`;

        // Pure writes from here — gamePointsStates was already read up front (see comment above),
        // so this is safe to call alongside the tx.update below regardless of order.
        const sequenceFinishedAt = won ? new Date().toISOString() : null;
        if (won && gamePointsStates) {
          const winnerUids = newPlayers
            .map((p: any, i: number) => ({ uid: p.uid, side: sequenceSideForSeat(i, playerCount) }))
            .filter((p: any) => p.side === mySide)
            .map((p: any) => p.uid);
          writeGamePointsPlan(tx, gamePointsStates, { gameType: 'sequence', gameId, winnerUids });
          recordGameOutcome(tx, db, gameId, {
            gameType: 'sequence', playerUids: newPlayers.map((p: any) => p.uid),
            players: newPlayers.map((p: any) => ({ uid: p.uid, displayName: p.displayName, photoURL: p.photoURL, seatIndex: p.seatIndex })),
            playerCount, winnerSide: mySide, finishedAt: sequenceFinishedAt,
          });
        }

        tx.update(gameRef, {
          board,
          lockedCells: Array.from(lockedCells),
          sequences: [...(game.sequences || []), ...newSequenceGroups],
          sequenceCountBySide,
          players: newPlayers,
          cardsRemaining: deck.length,
          currentTurnSeatIndex: won ? mySeatIndex : nextSeat,
          status: won ? 'finished' : 'active',
          winnerSide: won ? mySide : null,
          finishedAt: sequenceFinishedAt,
          // Only a 'place' actually puts a new chip down — 'remove'/'dead' leave this pointing at
          // whatever the last real placement was, so the "last played" glow never highlights an
          // empty or just-vacated cell.
          lastPlacedCell: action === 'place' ? cellIndex : game.lastPlacedCell ?? null,
          lastAction: { text: won ? `${mySeat.displayName} completed a sequence and won!` : actionText, at: new Date().toISOString() },
        });

        if (!won) {
          const nextPlayer = players[nextSeat];
          if (nextPlayer) {
            turnNotice = {
              nextPlayerUid: nextPlayer.uid,
              opponentNames: players.filter((p) => p.uid !== nextPlayer.uid).map((p) => p.displayName).filter(Boolean).join(', ') || null,
            };
          }
        }
      });

      if (turnNotice) {
        await notifyGameTurn(db, { gameType: 'sequence', gameId, nextPlayerUid: turnNotice.nextPlayerUid, movedByUid: decoded.uid, opponentNames: turnNotice.opponentNames }).catch(
          (err) => console.error('notifyGameTurn (sequence play) failed:', err),
        );
      }

      return res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('sequence/play error:', error);
      return res.status(500).json({ error: 'Unable to play.' });
    }
  });

  app.post('/api/sequence/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('sequenceGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: 'Sequence', routeSegment: 'sequence', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('sequence/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  app.post('/api/sequence/end', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sequenceGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'active') return res.status(400).json({ error: 'This game is not in progress.' });
      const ender = (game.players || []).find((p: any) => p.uid === decoded.uid);
      await gameRef.update({
        status: 'finished',
        winnerSide: null,
        finishedAt: new Date().toISOString(),
        lastAction: { text: `${ender?.displayName || 'A player'} ended the game early.`, at: new Date().toISOString() },
      });
      return res.json({ ok: true });
    } catch (error) {
      console.error('sequence/end error:', error);
      return res.status(500).json({ error: 'Unable to end game.' });
    }
  });

  app.post('/api/sequence/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sequenceGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (!['waiting', 'finished'].includes(game.status)) {
        return res.status(400).json({ error: 'Cannot delete a game in progress.' });
      }

      const [handsSnap, secretSnap] = await Promise.all([
        gameRef.collection('hands').get(),
        gameRef.collection('secret').get(),
      ]);
      const batch = db.batch();
      handsSnap.docs.forEach((d) => batch.delete(d.ref));
      secretSnap.docs.forEach((d) => batch.delete(d.ref));
      if (game.code) batch.delete(db.collection('sequenceGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('sequence/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  app.post('/api/sequence/rematch', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('sequenceGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'finished') return res.status(400).json({ error: 'Game is not finished yet.' });

      if (game.rematchGameId) return res.json({ gameId: game.rematchGameId });

      const newGameRef = db.collection('sequenceGames').doc();
      let code = generateShareCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.collection('sequenceGameCodes').doc(code).get();
        if (!existing.exists) break;
        code = generateShareCode();
      }

      const players = (game.players || []).map((p: any) => ({
        uid: p.uid,
        displayName: p.displayName,
        photoURL: p.photoURL,
        seatIndex: p.seatIndex,
        handCount: 0,
      }));

      const batch = db.batch();
      batch.set(newGameRef, {
        hostUid: decoded.uid,
        code,
        status: 'waiting',
        playerCount: game.playerCount,
        players,
        playerUids: game.playerUids,
        currentTurnSeatIndex: 0,
        board: new Array(100).fill(null),
        lockedCells: [],
        sequences: [],
        lastPlacedCell: null,
        sequenceCountBySide: new Array(sequenceSideCount(game.playerCount)).fill(0),
        winnerSide: null,
        cardsRemaining: 0,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        rematchGameId: null,
      });
      batch.set(db.collection('sequenceGameCodes').doc(code), { gameId: newGameRef.id, hostUid: decoded.uid });
      batch.update(gameRef, { rematchGameId: newGameRef.id });
      await batch.commit();

      return res.json({ gameId: newGameRef.id });
    } catch (error) {
      console.error('sequence/rematch error:', error);
      return res.status(500).json({ error: 'Unable to start rematch.' });
    }
  });

  // ===================== Chess =====================
  // Fully client-trusted, same as Ludo/Business — chess has no hidden information at all (both
  // players always see the full board), so there's no analog to Rummy/Sweep's Admin-SDK-only
  // move endpoints. Actual move legality (check, checkmate, castling, en passant, promotion,
  // draw detection) is enforced by the `chess.js` library running client-side (see
  // src/lib/chess.ts) — these endpoints exist for the same reasons every other game needs a
  // couple of server-side ones: pushing invites, and a clean Admin-SDK-backed delete/rematch so
  // the game-code pointer doc doesn't get orphaned. Ending an in-progress game early is a direct
  // client write (same as Ludo's handleEndGame), not a server endpoint — the rules already allow
  // any player in the game to update it any time.
  const CHESS_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  app.post('/api/chess/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('chessGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: 'Chess', routeSegment: 'chess', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('chess/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  app.post('/api/chess/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('chessGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (game.status === 'active') {
        return res.status(400).json({ error: 'Cannot delete a game in progress — end it instead, or wait for it to finish.' });
      }

      const batch = db.batch();
      if (game.code) batch.delete(db.collection('chessGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('chess/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  // Same rematch pattern as Business/Rummy: either player can trigger it, the caller becomes
  // host of the new game, and it's idempotent via `rematchGameId` — colors swap so a rematch
  // isn't just a repeat of the same side.
  app.post('/api/chess/rematch', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('chessGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'finished') return res.status(400).json({ error: 'Game is not finished yet.' });

      if (game.rematchGameId) {
        return res.json({ gameId: game.rematchGameId });
      }

      const newGameRef = db.collection('chessGames').doc();
      let code = generateShareCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.collection('chessGameCodes').doc(code).get();
        if (!existing.exists) break;
        code = generateShareCode();
      }

      const players = (game.players || []).map((p: any) => ({
        uid: p.uid,
        displayName: p.displayName,
        photoURL: p.photoURL,
        color: p.color === 'w' ? 'b' : 'w', // swap sides for the rematch
      }));

      const batch = db.batch();
      batch.set(newGameRef, {
        hostUid: decoded.uid,
        code,
        status: 'waiting',
        players,
        playerUids: game.playerUids,
        fen: CHESS_START_FEN,
        history: [],
        lastMove: null,
        drawOfferBy: null,
        result: null,
        resultReason: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        rematchGameId: null,
      });
      batch.set(db.collection('chessGameCodes').doc(code), { gameId: newGameRef.id, hostUid: decoded.uid });
      batch.update(gameRef, { rematchGameId: newGameRef.id });
      await batch.commit();

      return res.json({ gameId: newGameRef.id });
    } catch (error) {
      console.error('chess/rematch error:', error);
      return res.status(500).json({ error: 'Unable to start rematch.' });
    }
  });

  // ===================== Scramble (multiplayer) =====================
  // Server-authoritative like Rummy/Sweep/Sequence — a client-trusted score would be trivially
  // cheatable in a competitive word game. Clients only ever create/join the open lobby directly;
  // starting the match, every answer submission, hints, and match-end all go through here.
  //
  // Interpretive calls (spec left these ambiguous — see also src/lib/scramble.ts's header for the
  // single-player equivalents, which this mirrors as closely as the multiplayer shape allows):
  // - "Word length range" is read as ONE fixed length for the whole match (matching single-player),
  //   not a per-round-varying range — simpler and keeps the two modes' word-length concept aligned.
  // - The per-word timer (`timerMode`) is soft/cosmetic, same as single-player — only the overall
  //   `matchEndsAt` (from the host's chosen match timer) is server-enforced.
  // - "Hinted solve cannot receive a first-place speed bonus" is applied as "no speed bonus at all"
  //   for a round solved after using a hint on it (simpler than exactly replicating "only the
  //   +5 tier is barred," and matches the rule's stated intent of "prevents hint abuse"). A hinted
  //   player also doesn't consume a non-hinted competitor's tier slot — tiers are assigned by
  //   position among non-hinted finishers only.
  // - "Exact target word only" mode from the spec is NOT implemented (same as single-player) —
  //   every match is the open-anagram mode.
  const SCRAMBLE_BASE_POINTS = 10;
  const SCRAMBLE_HINT_PENALTY = 3;
  const SCRAMBLE_MAX_HINTS = 5;
  const SCRAMBLE_PASS_PENALTY = 5;
  const SCRAMBLE_SHUFFLE_PENALTY = 1;
  const SCRAMBLE_TIER_BONUS = [5, 3, 2, 1];
  const SCRAMBLE_TIMER_SECONDS: Record<string, number> = { '3min': 180, '5min': 300, '10min': 600 };
  const SCRAMBLE_DICTIONARY_VERSION = 'aoew2.0.0+mcwbl3.0.14-filtered-v4';

  function scrambleShuffleLetters(word: string): string[] {
    let attempt = word.split('');
    for (let tries = 0; tries < 10; tries++) {
      for (let i = attempt.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [attempt[i], attempt[j]] = [attempt[j], attempt[i]];
      }
      if (attempt.join('') !== word) break;
    }
    return attempt;
  }

  function scramblePickTargetWord(length: number, exclude: Set<string>): string {
    const pool = scrambleTargetWordsByLength[length] || [];
    for (let tries = 0; tries < 50; tries++) {
      const w = pool[Math.floor(Math.random() * pool.length)];
      if (!exclude.has(w)) return w;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function scrambleIsValidAnswer(guess: string, tiles: string[]): boolean {
    const g = guess.trim().toLowerCase();
    if (g.length > tiles.length) return false;
    if (!scrambleAllWords.has(g)) return false;
    const avail = tiles.slice();
    for (const ch of g) {
      const idx = avail.indexOf(ch);
      if (idx === -1) return false;
      avail.splice(idx, 1);
    }
    return true;
  }

  function finalizeScrambleMatchInTx(tx: FirebaseFirestore.Transaction, gameRef: FirebaseFirestore.DocumentReference, game: any) {
    const progress = game.progress || {};
    let winnerUid: string | null = null;
    let bestScore = -1;
    for (const uid of Object.keys(progress)) {
      const score = progress[uid]?.score || 0;
      if (score > bestScore) {
        bestScore = score;
        winnerUid = uid;
      }
    }
    tx.update(gameRef, { status: 'finished', finishedAt: new Date().toISOString(), winnerUid });
  }

  // Copies the target-word sequence from the admin-only `secret` subcollection onto the public
  // doc once a match is finished, so the finished screen can reveal every word (with its
  // definition, fetched client-side) to every player. Deliberately a plain read+write done AFTER
  // any finalizing transaction commits, not inside it — Firestore transactions require every read
  // to happen before any write, and finalizeScrambleMatchInTx above is sometimes called partway
  // through a transaction that's already issued writes (see /submit), so adding a fresh read there
  // would throw. A cheap, idempotent no-op (`revealedWords` already set, or status isn't
  // 'finished' yet) in every other case. Called at the end of every endpoint that might have just
  // finalized a match — best-effort, failures are logged but never fail the caller's response.
  async function revealScrambleWordsIfFinished(db: Firestore, gameRef: FirebaseFirestore.DocumentReference) {
    const snap = await gameRef.get();
    if (!snap.exists) return;
    const data = snap.data()!;
    if (data.status !== 'finished' || data.revealedWords) return;
    const secretSnap = await gameRef.collection('secret').doc('wordSequence').get();
    if (!secretSnap.exists) return;
    await gameRef.update({ revealedWords: secretSnap.data()!.targetWords || [] });
  }

  app.post('/api/scramble/invite', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const inviteeUids: string[] = Array.isArray(req.body?.inviteeUids) ? req.body.inviteeUids.filter((u: unknown) => typeof u === 'string') : [];
    const poke = req.body?.poke === true;
    if (!gameId || inviteeUids.length === 0) return res.status(400).json({ error: 'gameId and inviteeUids are required.' });

    try {
      const gameSnap = await db.collection('scrambleGames').doc(gameId).get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const targets = inviteeUids.filter((uid) => uid !== decoded.uid && !(game.playerUids || []).includes(uid));
      const sent = await sendGameInvites(db, { gameId, game, callerUid: decoded.uid, targets, gameLabel: 'Scramble', routeSegment: 'scramble-multiplayer', poke });
      return res.json({ sent });
    } catch (error) {
      console.error('scramble/invite error:', error);
      return res.status(500).json({ error: 'Unable to send invites.' });
    }
  });

  // Host-only. Generates the FULL locked word sequence (target words + their shuffled tile order)
  // up front, once, from this SERVER's dictionary — every player gets the exact same sequence in
  // the exact same order. Tiles are safe to expose on the public game doc (seeing a later round's
  // letters gives no advantage: you still have to actually solve every round before it to reach
  // it), but the target words themselves stay in an Admin-only `secret` doc since they're the
  // source for hints.
  app.post('/api/scramble/start', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can start the game.' });
      if (game.status !== 'waiting') return res.status(400).json({ error: 'Game already started.' });
      const players: any[] = game.players || [];
      if (players.length < 2) return res.status(400).json({ error: 'Need at least 2 players to start.' });

      const wordLength: number = game.wordLength;
      const totalWords: number = game.totalWords;
      const usedTargets = new Set<string>();
      const targetWords: string[] = [];
      // Firestore rejects nested arrays outright ("Nested arrays are not allowed"), so each
      // round's shuffled tiles are stored as one joined string rather than string[][] — split back
      // into individual letters client-side.
      const roundTiles: string[] = [];
      for (let i = 0; i < totalWords; i++) {
        const target = scramblePickTargetWord(wordLength, usedTargets);
        usedTargets.add(target);
        targetWords.push(target);
        roundTiles.push(scrambleShuffleLetters(target).join(''));
      }

      const progress: Record<string, any> = {};
      for (const p of players) {
        progress[p.uid] = {
          roundIndex: 0,
          score: 0,
          solvedCount: 0,
          wrongGuesses: 0,
          hintsUsedThisRound: 0,
          hintsUsedTotal: 0,
          finished: false,
          finishedAt: null,
        };
      }

      const now = Date.now();
      const matchEndsAt = new Date(now + (SCRAMBLE_TIMER_SECONDS[game.matchTimerMode] || 180) * 1000).toISOString();

      const batch = db.batch();
      batch.set(gameRef.collection('secret').doc('wordSequence'), { targetWords });
      for (const p of players) {
        batch.set(gameRef.collection('private').doc(p.uid), { hintPrefix: '', solvedAnswers: [] });
      }
      batch.update(gameRef, {
        status: 'active',
        roundTiles,
        progress,
        roundCompletions: {},
        startedAt: new Date(now).toISOString(),
        matchEndsAt,
        dictionaryVersion: SCRAMBLE_DICTIONARY_VERSION,
      });
      await batch.commit();
      return res.json({ ok: true });
    } catch (error) {
      console.error('scramble/start error:', error);
      return res.status(500).json({ error: 'Unable to start game.' });
    }
  });

  // The core gameplay action. One transaction handles wrong guesses (public wrongGuesses counter),
  // already-used-this-match answers (checked against the player's OWN private solved-answers list,
  // not shared across players — two different players independently finding the same word for
  // their own current round is fine), correct answers (base points + a speed-tier bonus based on
  // arrival order among non-hinted solvers of that SAME round index), and match-end (either every
  // player has finished all rounds, or the server clock has passed matchEndsAt).
  app.post('/api/scramble/submit', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const guessRaw = String(req.body?.guess || '');
    if (!gameId || !guessRaw) return res.status(400).json({ error: 'gameId and guess are required.' });
    const guess = guessRaw.trim().toLowerCase();

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const privateRef = gameRef.collection('private').doc(decoded.uid);

      const result = await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };

        const progress = game.progress || {};
        const mine = progress[decoded.uid];
        if (!mine) throw { status: 403, message: 'Not part of this game.' };

        if (Date.now() >= new Date(game.matchEndsAt).getTime()) {
          finalizeScrambleMatchInTx(tx, gameRef, game);
          return { status: 'expired' };
        }
        if (mine.finished) throw { status: 400, message: 'You already finished this match.' };

        const privateSnap = await tx.get(privateRef);
        const privateData = privateSnap.exists ? privateSnap.data()! : { hintPrefix: '', solvedAnswers: [] };
        const tiles: string[] = ((game.roundTiles || [])[mine.roundIndex] || '').split('');

        if (!scrambleIsValidAnswer(guess, tiles)) {
          tx.update(gameRef, { [`progress.${decoded.uid}.wrongGuesses`]: (mine.wrongGuesses || 0) + 1 });
          return { status: 'invalid' };
        }
        if ((privateData.solvedAnswers || []).includes(guess)) {
          tx.update(gameRef, { [`progress.${decoded.uid}.wrongGuesses`]: (mine.wrongGuesses || 0) + 1 });
          return { status: 'already-used' };
        }

        const roundIndex = mine.roundIndex;
        const roundCompletions = { ...(game.roundCompletions || {}) };
        const thisRoundList: Array<{ uid: string; hinted: boolean }> = roundCompletions[String(roundIndex)] || [];
        const hintedThisRound = (mine.hintsUsedThisRound || 0) > 0;
        const nonHintedBefore = thisRoundList.filter((e) => !e.hinted).length;
        const tierBonus = hintedThisRound ? 0 : (SCRAMBLE_TIER_BONUS[nonHintedBefore] || 0);
        roundCompletions[String(roundIndex)] = [...thisRoundList, { uid: decoded.uid, hinted: hintedThisRound }];

        const pointsAwarded = SCRAMBLE_BASE_POINTS + tierBonus;
        const nextRoundIndex = roundIndex + 1;
        const finished = nextRoundIndex >= (game.totalWords || 0);

        tx.update(gameRef, {
          [`progress.${decoded.uid}.roundIndex`]: nextRoundIndex,
          [`progress.${decoded.uid}.score`]: (mine.score || 0) + pointsAwarded,
          [`progress.${decoded.uid}.solvedCount`]: (mine.solvedCount || 0) + 1,
          [`progress.${decoded.uid}.hintsUsedThisRound`]: 0,
          [`progress.${decoded.uid}.finished`]: finished,
          [`progress.${decoded.uid}.finishedAt`]: finished ? new Date().toISOString() : null,
          roundCompletions,
        });
        tx.set(privateRef, { hintPrefix: '', solvedAnswers: [...(privateData.solvedAnswers || []), guess] }, { merge: true });

        const allProgress = { ...progress, [decoded.uid]: { ...mine, finished } };
        const everyoneFinished = (game.players || []).every((p: any) => allProgress[p.uid]?.finished);
        if (everyoneFinished) {
          finalizeScrambleMatchInTx(tx, gameRef, { ...game, progress: allProgress });
        }

        return { status: 'correct', pointsAwarded, tierBonus };
      });

      await revealScrambleWordsIfFinished(db, gameRef).catch((err) => console.error('scramble reveal error:', err));
      return res.json(result);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('scramble/submit error:', error);
      return res.status(500).json({ error: 'Unable to submit answer.' });
    }
  });

  // Reveals the next letter of the CURRENT round's underlying target word as a prefix clue, same
  // as single-player — written to a per-player `private` doc (not the public game doc) so other
  // players can't read someone else's hint progress even though they can see the same tiles.
  app.post('/api/scramble/hint', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const secretRef = gameRef.collection('secret').doc('wordSequence');
      const privateRef = gameRef.collection('private').doc(decoded.uid);

      const result = await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };

        const progress = game.progress || {};
        const mine = progress[decoded.uid];
        if (!mine) throw { status: 403, message: 'Not part of this game.' };

        if (Date.now() >= new Date(game.matchEndsAt).getTime()) {
          finalizeScrambleMatchInTx(tx, gameRef, game);
          return { status: 'expired' };
        }
        if (mine.finished) throw { status: 400, message: 'You already finished this match.' };
        if ((mine.hintsUsedTotal || 0) >= SCRAMBLE_MAX_HINTS) throw { status: 400, message: 'No hints left.' };

        const secretSnap = await tx.get(secretRef);
        const targetWords: string[] = secretSnap.exists ? secretSnap.data()!.targetWords : [];
        const targetWord = targetWords[mine.roundIndex] || '';
        const privateSnap = await tx.get(privateRef);
        const privateData = privateSnap.exists ? privateSnap.data()! : { hintPrefix: '', solvedAnswers: [] };
        const revealLength = (privateData.hintPrefix || '').length;
        if (revealLength >= targetWord.length) throw { status: 400, message: 'No more letters to reveal for this word.' };

        const letter = targetWord[revealLength];
        const nextPrefix = (privateData.hintPrefix || '') + letter;

        tx.update(gameRef, {
          [`progress.${decoded.uid}.score`]: Math.max(0, (mine.score || 0) - SCRAMBLE_HINT_PENALTY),
          [`progress.${decoded.uid}.hintsUsedThisRound`]: (mine.hintsUsedThisRound || 0) + 1,
          [`progress.${decoded.uid}.hintsUsedTotal`]: (mine.hintsUsedTotal || 0) + 1,
        });
        tx.set(privateRef, { ...privateData, hintPrefix: nextPrefix }, { merge: true });

        return { status: 'ok', letter, hintPrefix: nextPrefix };
      });

      await revealScrambleWordsIfFinished(db, gameRef).catch((err) => console.error('scramble reveal error:', err));
      return res.json(result);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('scramble/hint error:', error);
      return res.status(500).json({ error: 'Unable to use hint.' });
    }
  });

  // Gives up on the current round without solving it — advances to the next round exactly like a
  // correct submit (roundIndex+1, same "finished when it runs off the end" rule), but doesn't
  // touch solvedCount and applies a penalty instead of points. The given-up round index is
  // remembered in `passedRounds` so it can be redeemed later for bonus points via
  // /api/scramble/submit-passed (see ScrambleMultiplayerGame.tsx's "Passed Words" panel), same
  // idea as single-player's passWord in scramble.ts.
  app.post('/api/scramble/pass', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const privateRef = gameRef.collection('private').doc(decoded.uid);

      const result = await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };

        const progress = game.progress || {};
        const mine = progress[decoded.uid];
        if (!mine) throw { status: 403, message: 'Not part of this game.' };

        if (Date.now() >= new Date(game.matchEndsAt).getTime()) {
          finalizeScrambleMatchInTx(tx, gameRef, game);
          return { status: 'expired' };
        }
        if (mine.finished) throw { status: 400, message: 'You already finished this match.' };

        const privateSnap = await tx.get(privateRef);
        const privateData = privateSnap.exists ? privateSnap.data()! : { hintPrefix: '', solvedAnswers: [] };

        const roundIndex = mine.roundIndex;
        const nextRoundIndex = roundIndex + 1;
        const finished = nextRoundIndex >= (game.totalWords || 0);
        const passedRounds = [...(mine.passedRounds || []), roundIndex];

        tx.update(gameRef, {
          [`progress.${decoded.uid}.roundIndex`]: nextRoundIndex,
          [`progress.${decoded.uid}.score`]: Math.max(0, (mine.score || 0) - SCRAMBLE_PASS_PENALTY),
          [`progress.${decoded.uid}.hintsUsedThisRound`]: 0,
          [`progress.${decoded.uid}.finished`]: finished,
          [`progress.${decoded.uid}.finishedAt`]: finished ? new Date().toISOString() : null,
          [`progress.${decoded.uid}.passedRounds`]: passedRounds,
        });
        tx.set(privateRef, { ...privateData, hintPrefix: '' }, { merge: true });

        const allProgress = { ...progress, [decoded.uid]: { ...mine, finished } };
        const everyoneFinished = (game.players || []).every((p: any) => allProgress[p.uid]?.finished);
        if (everyoneFinished) {
          finalizeScrambleMatchInTx(tx, gameRef, { ...game, progress: allProgress });
        }

        return { status: 'ok', passedRoundIndex: roundIndex };
      });

      await revealScrambleWordsIfFinished(db, gameRef).catch((err) => console.error('scramble reveal error:', err));
      return res.json(result);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('scramble/pass error:', error);
      return res.status(500).json({ error: 'Unable to pass this word.' });
    }
  });

  // Purely cosmetic re-roll of the pool tiles' display order (the round's actual letter set never
  // changes) — same point cost as single-player's useShuffle in scramble.ts, kept server-side only
  // because score is server-authoritative here.
  app.post('/api/scramble/shuffle', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const result = await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };

        const progress = game.progress || {};
        const mine = progress[decoded.uid];
        if (!mine) throw { status: 403, message: 'Not part of this game.' };
        // No `mine.finished` gate, unlike /submit and /hint — a finished player can still be
        // revisiting a passed word (see /submit-passed) and shuffling its tiles is harmless either
        // way, since it never reveals anything about a word beyond the letters already shown.

        tx.update(gameRef, { [`progress.${decoded.uid}.score`]: Math.max(0, (mine.score || 0) - SCRAMBLE_SHUFFLE_PENALTY) });
        return { status: 'ok' };
      });
      return res.json(result);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('scramble/shuffle error:', error);
      return res.status(500).json({ error: 'Unable to shuffle.' });
    }
  });

  // Redeems a previously-passed round for bonus points without touching the player's forward
  // `roundIndex`/`finished` state — a player can revisit and solve a passed word any time before
  // the match clock runs out, even after finishing their own sequential run (see the "Passed
  // Words" panel in ScrambleMultiplayerGame.tsx). No speed-tier bonus (that concept only makes
  // sense among players racing the SAME live round; a revisit happens asynchronously, after
  // everyone else has already moved past that round) — flat base points only.
  app.post('/api/scramble/submit-passed', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    const roundIndex = Number(req.body?.roundIndex);
    const guessRaw = String(req.body?.guess || '');
    if (!gameId || !Number.isInteger(roundIndex) || !guessRaw) {
      return res.status(400).json({ error: 'gameId, roundIndex, and guess are required.' });
    }
    const guess = guessRaw.trim().toLowerCase();

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const privateRef = gameRef.collection('private').doc(decoded.uid);

      const result = await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) throw { status: 404, message: 'Game not found.' };
        const game = gameSnap.data()!;
        if (game.status !== 'active') throw { status: 400, message: 'Game is not active.' };

        const progress = game.progress || {};
        const mine = progress[decoded.uid];
        if (!mine) throw { status: 403, message: 'Not part of this game.' };

        if (Date.now() >= new Date(game.matchEndsAt).getTime()) {
          finalizeScrambleMatchInTx(tx, gameRef, game);
          return { status: 'expired' };
        }

        const passedRounds: number[] = mine.passedRounds || [];
        if (!passedRounds.includes(roundIndex)) throw { status: 400, message: 'That word is not in your passed list.' };

        const privateSnap = await tx.get(privateRef);
        const privateData = privateSnap.exists ? privateSnap.data()! : { hintPrefix: '', solvedAnswers: [] };
        const tiles: string[] = ((game.roundTiles || [])[roundIndex] || '').split('');

        if (!scrambleIsValidAnswer(guess, tiles)) return { status: 'invalid' };
        if ((privateData.solvedAnswers || []).includes(guess)) return { status: 'already-used' };

        const nextPassedRounds = passedRounds.filter((r) => r !== roundIndex);
        tx.update(gameRef, {
          [`progress.${decoded.uid}.score`]: (mine.score || 0) + SCRAMBLE_BASE_POINTS,
          [`progress.${decoded.uid}.solvedCount`]: (mine.solvedCount || 0) + 1,
          [`progress.${decoded.uid}.passedRounds`]: nextPassedRounds,
        });
        tx.set(privateRef, { ...privateData, solvedAnswers: [...(privateData.solvedAnswers || []), guess] }, { merge: true });

        return { status: 'correct', pointsAwarded: SCRAMBLE_BASE_POINTS };
      });

      return res.json(result);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error('scramble/submit-passed error:', error);
      return res.status(500).json({ error: 'Unable to submit answer.' });
    }
  });

  // Any player viewing a match whose local clock shows time-up calls this — a no-op if someone's
  // /submit or /hint call already finalized it first (or if it's not actually expired yet).
  // Belt-and-suspenders for the case where nobody happens to submit/hint again after the deadline.
  app.post('/api/scramble/finalize-if-expired', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      await db.runTransaction(async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists) return;
        const game = gameSnap.data()!;
        if (game.status !== 'active') return;
        if (Date.now() < new Date(game.matchEndsAt).getTime()) return;
        finalizeScrambleMatchInTx(tx, gameRef, game);
      });
      await revealScrambleWordsIfFinished(db, gameRef).catch((err) => console.error('scramble reveal error:', err));
      return res.json({ ok: true });
    } catch (error) {
      console.error('scramble/finalize-if-expired error:', error);
      return res.status(500).json({ error: 'Unable to finalize match.' });
    }
  });

  app.post('/api/scramble/delete', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (game.hostUid !== decoded.uid) return res.status(403).json({ error: 'Only the host can delete this game.' });
      if (!['waiting', 'finished'].includes(game.status)) {
        return res.status(400).json({ error: 'Cannot delete a game in progress.' });
      }

      const [secretSnap, privateSnap] = await Promise.all([
        gameRef.collection('secret').get(),
        gameRef.collection('private').get(),
      ]);
      const batch = db.batch();
      secretSnap.docs.forEach((d) => batch.delete(d.ref));
      privateSnap.docs.forEach((d) => batch.delete(d.ref));
      if (game.code) batch.delete(db.collection('scrambleGameCodes').doc(game.code));
      batch.delete(gameRef);
      await batch.commit();

      return res.json({ ok: true });
    } catch (error) {
      console.error('scramble/delete error:', error);
      return res.status(500).json({ error: 'Unable to delete game.' });
    }
  });

  // Same shape as sweep/sequence's rematch: a fresh 'waiting' lobby with the same players/settings,
  // pointed to from the finished game's `rematchGameId` so every player's "Join Rematch" button
  // lands in the same new game instead of each of them spawning their own (see
  // ScrambleMultiplayerGame.tsx).
  app.post('/api/scramble/rematch', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'gameId is required.' });

    try {
      const gameRef = db.collection('scrambleGames').doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
      if (game.status !== 'finished') return res.status(400).json({ error: 'Game is not finished yet.' });

      if (game.rematchGameId) return res.json({ gameId: game.rematchGameId });

      const newGameRef = db.collection('scrambleGames').doc();
      let code = generateShareCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await db.collection('scrambleGameCodes').doc(code).get();
        if (!existing.exists) break;
        code = generateShareCode();
      }

      const players = (game.players || []).map((p: any, i: number) => ({
        uid: p.uid,
        displayName: p.displayName,
        photoURL: p.photoURL,
        seatIndex: i,
      }));

      const batch = db.batch();
      batch.set(newGameRef, {
        hostUid: decoded.uid,
        code,
        status: 'waiting',
        wordLength: game.wordLength,
        totalWords: game.totalWords,
        timerMode: game.timerMode,
        matchTimerMode: game.matchTimerMode,
        players,
        playerUids: players.map((p: any) => p.uid),
        createdAt: new Date().toISOString(),
        startedAt: null,
        matchEndsAt: null,
        finishedAt: null,
        winnerUid: null,
        rematchGameId: null,
      });
      batch.set(db.collection('scrambleGameCodes').doc(code), { gameId: newGameRef.id, hostUid: decoded.uid });
      batch.update(gameRef, { rematchGameId: newGameRef.id });
      await batch.commit();

      return res.json({ gameId: newGameRef.id });
    } catch (error) {
      console.error('scramble/rematch error:', error);
      return res.status(500).json({ error: 'Unable to start rematch.' });
    }
  });

  // ===================== Multiplayer game reactions =====================
  // A single generic endpoint shared by all four multiplayer games, rather than one per game —
  // this is purely cosmetic (stamps a `lastReaction` field the client animates for ~3s and
  // ignores otherwise), so there's no game-specific logic to justify separate routes. Runs
  // through the Admin SDK because Rummy/Sweep's Firestore rules block client `update` on an
  // active game entirely (hidden-info games only allow direct client writes to join the lobby).
  const REACTION_GAME_COLLECTIONS: Record<string, string> = {
    ludo: 'ludoGames',
    rummy: 'rummyGames',
    business: 'businessGames',
    sweep: 'sweepGames',
    chess: 'chessGames',
    sequence: 'sequenceGames',
  };
  const REACTION_EMOJI_SET = new Set(['👍', '❤️', '😂', '😮', '😢', '🎉']);

  app.post('/api/games/react', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const gameType = String(req.body?.gameType || '');
    const gameId = String(req.body?.gameId || '');
    const emoji = String(req.body?.emoji || '');
    const collectionName = REACTION_GAME_COLLECTIONS[gameType];
    if (!collectionName || !gameId || !REACTION_EMOJI_SET.has(emoji)) {
      return res.status(400).json({ error: 'Invalid reaction request.' });
    }

    try {
      const gameRef = db.collection(collectionName).doc(gameId);
      const gameSnap = await gameRef.get();
      if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
      const game = gameSnap.data()!;
      if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });

      const displayName = (game.players || []).find((p: any) => p.uid === decoded.uid)?.displayName || 'Player';
      await gameRef.update({
        lastReaction: { emoji, uid: decoded.uid, displayName, at: new Date().toISOString() },
      });
      return res.json({ ok: true });
    } catch (error) {
      console.error('games/react error:', error);
      return res.status(500).json({ error: 'Unable to send reaction.' });
    }
  });

  app.get('/api/admin/shopkeeper-requests', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    try {
      const snap = await adminDb.collection('shopkeeperRequests').orderBy('createdAt', 'desc').limit(200).get();
      return res.json({ requests: snap.docs.map((d) => ({ uid: d.id, ...d.data() })) });
    } catch (error) {
      console.error('admin/shopkeeper-requests error:', error);
      return res.status(500).json({ error: 'Unable to load requests.' });
    }
  });

  // Approving creates the shop itself and grants the requester owner access in one atomic
  // batch — a shop can never exist without a corresponding approved request, by construction.
  app.post('/api/admin/shopkeeper-requests/:uid/approve', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;
    const targetUid = req.params.uid;

    try {
      const reqRef = db.collection('shopkeeperRequests').doc(targetUid);
      const reqSnap = await reqRef.get();
      if (!reqSnap.exists) return res.status(404).json({ error: 'Request not found.' });
      const data = reqSnap.data()!;
      if (data.status !== 'pending') return res.status(400).json({ error: 'Already reviewed.' });

      const shopRef = db.collection('shops').doc();
      const nowIso = new Date().toISOString();
      const batch = db.batch();
      batch.set(shopRef, {
        ownerId: targetUid,
        shopName: `${data.userName || 'My'}'s Shop`,
        ownerName: data.userName || '',
        phone: '',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      batch.update(db.collection('users').doc(targetUid), { shopId: shopRef.id, shopRole: 'owner' });
      batch.update(reqRef, { status: 'approved', reviewedAt: nowIso, reviewedBy: decoded.email || decoded.uid });
      await batch.commit();

      const tokens = await collectPushTokens(db, [targetUid], 'notificationsEnabled');
      await sendPush(tokens, 'Shopkeeper access approved', 'You can now switch to Shopkeeper mode from the header toggle.', { type: 'shopkeeper_approved' });

      return res.json({ ok: true, shopId: shopRef.id });
    } catch (error) {
      console.error('admin/shopkeeper-requests approve error:', error);
      return res.status(500).json({ error: 'Unable to approve request.' });
    }
  });

  app.post('/api/admin/shopkeeper-requests/:uid/reject', async (req, res) => {
    const decoded = await requireAdmin(req, res);
    if (!decoded || !adminDb) return;
    const db = adminDb;
    const targetUid = req.params.uid;

    try {
      const reqRef = db.collection('shopkeeperRequests').doc(targetUid);
      const reqSnap = await reqRef.get();
      if (!reqSnap.exists) return res.status(404).json({ error: 'Request not found.' });
      if (reqSnap.data()!.status !== 'pending') return res.status(400).json({ error: 'Already reviewed.' });

      await reqRef.update({ status: 'rejected', reviewedAt: new Date().toISOString(), reviewedBy: decoded.email || decoded.uid });

      const tokens = await collectPushTokens(db, [targetUid], 'notificationsEnabled');
      await sendPush(tokens, 'Shopkeeper request declined', 'Your request to enable Shopkeeper mode was not approved.', { type: 'shopkeeper_rejected' });

      return res.json({ ok: true });
    } catch (error) {
      console.error('admin/shopkeeper-requests reject error:', error);
      return res.status(500).json({ error: 'Unable to reject request.' });
    }
  });

  // Adding staff grants that person `shopId`/`shopRole: 'staff'` on their own user doc at the
  // same time as the roster entry — kept on one Admin-SDK code path (rather than a client write
  // plus a server write) so the two can never drift out of sync with each other.
  app.post('/api/shops/:shopId/add-staff', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb || !adminAuth) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const shopId = req.params.shopId;
    const email = normalizeEmail(String(req.body?.email || ''));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    try {
      const shopSnap = await db.collection('shops').doc(shopId).get();
      if (!shopSnap.exists) return res.status(404).json({ error: 'Shop not found.' });
      if (shopSnap.data()!.ownerId !== decoded.uid) {
        return res.status(403).json({ error: 'Only the shop owner can add staff.' });
      }

      let staffUid: string;
      try {
        staffUid = (await adminAuth.getUserByEmail(email)).uid;
      } catch (err: any) {
        if (err?.code === 'auth/user-not-found') {
          return res.status(404).json({ error: 'No FamilyLedger account found for that email — they need to sign up first.' });
        }
        throw err;
      }
      if (staffUid === decoded.uid) return res.status(400).json({ error: "That's you." });

      const staffUserSnap = await db.collection('users').doc(staffUid).get();
      if (staffUserSnap.data()?.shopId) {
        return res.status(400).json({ error: 'That person already belongs to a shop.' });
      }

      const batch = db.batch();
      batch.set(db.collection('shops').doc(shopId).collection('staff').doc(staffUid), {
        name: staffUserSnap.data()?.displayName || 'Staff',
        email,
        addedAt: new Date().toISOString(),
        addedBy: decoded.uid,
      });
      batch.update(db.collection('users').doc(staffUid), { shopId, shopRole: 'staff' });
      await batch.commit();

      const tokens = await collectPushTokens(db, [staffUid], 'notificationsEnabled');
      await sendPush(tokens, 'Added as shop staff', 'You can now switch to Shopkeeper mode from the header toggle.', { type: 'shopkeeper_approved' });

      return res.json({ ok: true, staffUid });
    } catch (error) {
      console.error('shops/add-staff error:', error);
      return res.status(500).json({ error: 'Unable to add staff.' });
    }
  });

  app.post('/api/shops/:shopId/remove-staff', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const shopId = req.params.shopId;
    const staffUid = String(req.body?.staffUid || '');
    if (!staffUid) return res.status(400).json({ error: 'staffUid is required.' });

    try {
      const shopSnap = await db.collection('shops').doc(shopId).get();
      if (!shopSnap.exists) return res.status(404).json({ error: 'Shop not found.' });
      if (shopSnap.data()!.ownerId !== decoded.uid) {
        return res.status(403).json({ error: 'Only the shop owner can remove staff.' });
      }

      const batch = db.batch();
      batch.delete(db.collection('shops').doc(shopId).collection('staff').doc(staffUid));
      // Only clear shopId/shopRole if they're still pointed at *this* shop — avoids clobbering
      // a later, unrelated shop membership in the unlikely case timing overlaps.
      const staffUserSnap = await db.collection('users').doc(staffUid).get();
      if (staffUserSnap.data()?.shopId === shopId) {
        batch.update(db.collection('users').doc(staffUid), { shopId: admin.firestore.FieldValue.delete(), shopRole: admin.firestore.FieldValue.delete() });
      }
      await batch.commit();
      return res.json({ ok: true });
    } catch (error) {
      console.error('shops/remove-staff error:', error);
      return res.status(500).json({ error: 'Unable to remove staff.' });
    }
  });

  // Bulk promotional email to a shop's customers — automated/one-click since it's a normal SMTP
  // send (unlike WhatsApp, which stays a tap-per-customer wa.me link, see ShopSales.tsx/
  // ShopCustomers.tsx — no WhatsApp Business API, deliberately, to avoid the paid/approved-
  // template overhead that's overkill for a small shopkeeper tool).
  app.post('/api/shops/:shopId/send-promo-email', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const shopId = req.params.shopId;
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();
    const imageDataUri = req.body?.imageDataUri;
    if (!subject || !message) return res.status(400).json({ error: 'subject and message are required.' });
    if (!transporter) return res.status(500).json({ error: 'Email is not configured on the server.' });
    if (imageDataUri != null && (typeof imageDataUri !== 'string' || !imageDataUri.startsWith('data:image/'))) {
      return res.status(400).json({ error: 'imageDataUri must be a data:image/ URI.' });
    }

    try {
      const imageMatch = typeof imageDataUri === 'string' ? imageDataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/) : null;
      const attachments = imageMatch
        ? [{ filename: 'promo.jpg', content: Buffer.from(imageMatch[2], 'base64'), contentType: imageMatch[1], cid: 'promo-image' }]
        : undefined;
      const shopSnap = await db.collection('shops').doc(shopId).get();
      if (!shopSnap.exists) return res.status(404).json({ error: 'Shop not found.' });
      const isMember =
        shopSnap.data()!.ownerId === decoded.uid ||
        (await db.collection('shops').doc(shopId).collection('staff').doc(decoded.uid).get()).exists;
      if (!isMember) return res.status(403).json({ error: 'Not a member of this shop.' });

      const customersSnap = await db.collection('shops').doc(shopId).collection('customers').get();
      const recipients = customersSnap.docs.map((d) => d.data().email).filter((e): e is string => !!e);
      if (recipients.length === 0) return res.json({ sent: 0 });

      let sent = 0;
      for (const to of recipients) {
        try {
          await transporter.sendMail({
            from: emailFrom,
            to,
            subject,
            text: `${message}\n\n— ${shopSnap.data()!.shopName}`,
            html: attachments
              ? `<p>${message.replace(/\n/g, '<br>')}</p><img src="cid:promo-image" style="max-width:100%;border-radius:8px;" /><p>— ${shopSnap.data()!.shopName}</p>`
              : undefined,
            attachments,
          });
          sent++;
        } catch (err) {
          console.error(`send-promo-email failed for ${to}:`, err);
        }
      }
      return res.json({ sent, total: recipients.length });
    } catch (error) {
      console.error('shops/send-promo-email error:', error);
      return res.status(500).json({ error: 'Unable to send promotional emails.' });
    }
  });

  // Nudges a fellow group member (or everyone else in the group, via pokeAll) to add their
  // expenses — a lightweight social poke, open to any member (not just admins/creator),
  // matching the app's general "members can act on each other socially" pattern already used
  // for invites.
  app.post('/api/poke-member', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const groupId = String(req.body?.groupId || '');
    const targetUserId = String(req.body?.targetUserId || '');
    const pokeAll = req.body?.pokeAll === true;
    if (!groupId || (!targetUserId && !pokeAll)) {
      return res.status(400).json({ error: 'groupId and (targetUserId or pokeAll) are required.' });
    }
    if (targetUserId && targetUserId === decoded.uid) return res.status(400).json({ error: "You can't poke yourself." });

    try {
      const [callerMemberSnap, groupSnap] = await Promise.all([
        adminDb.collection('members').doc(`${decoded.uid}_${groupId}`).get(),
        adminDb.collection('groups').doc(groupId).get(),
      ]);
      if (!callerMemberSnap.exists) return res.status(403).json({ error: 'You must be a member of this group to poke someone.' });

      const groupName = groupSnap.exists ? groupSnap.data()?.name || 'the group' : 'the group';
      const actorName = decoded.name || callerMemberSnap.data()?.displayName || 'Someone';

      let recipientUids: string[];
      if (pokeAll) {
        const membersSnap = await adminDb.collection('members').where('groupId', '==', groupId).get();
        recipientUids = membersSnap.docs.map((d) => d.data().userId).filter((uid) => uid !== decoded.uid);
      } else {
        const targetMemberSnap = await adminDb.collection('members').doc(`${targetUserId}_${groupId}`).get();
        if (!targetMemberSnap.exists) return res.status(404).json({ error: 'That person is not a member of this group.' });
        recipientUids = [targetUserId];
      }
      if (recipientUids.length === 0) return res.json({ sent: 0 });

      const tokens = await collectPushTokens(adminDb, recipientUids, 'notificationsEnabled');
      const pokeBody = `Add your expenses in "${groupName}" when you get a chance.`;
      const sent = await sendPush(
        tokens,
        `${actorName} poked you 👋`,
        pokeBody,
        { type: 'poke', groupId },
      );
      if (pokeAll) {
        // One doc reaches every group member via the groupId list rule, same as any other
        // group-wide activity. `pokedAll: true` (not the pre-composed English sentence) is what
        // FeedList.tsx needs to pick the right translated template.
        await logFeedActivity(adminDb, {
          userId: decoded.uid, type: 'poke', description: pokeBody,
          userName: actorName, userPhoto: callerMemberSnap.data()?.photoURL || '', groupId, data: { groupId, pokedAll: true },
        });
      } else {
        await logFeedActivity(adminDb, {
          userId: targetUserId, type: 'poke', description: pokeBody,
          userName: actorName, userPhoto: callerMemberSnap.data()?.photoURL || '', data: { groupId, pokedAll: false },
        });
      }
      return res.json({ sent });
    } catch (error) {
      console.error('poke-member error:', error);
      return res.status(500).json({ error: 'Unable to send poke.' });
    }
  });

  // Sent from Settlements.tsx's "who owes who" detail view by whoever is OWED money, nudging the
  // person who owes them. `targetUserId` is the ower (the recipient of this push); `amount` is
  // re-validated against the group's own membership only (not re-derived from expenses server-
  // side — the client already computed it from real data, and this is a nudge, not a financial
  // transaction, so there's nothing here for a forged amount to actually steal). Deep-links the
  // ower straight to a pre-filled settle-up expense via `settleWith` — see AddExpense.tsx and
  // pushNotifications.ts/FeedList.tsx's `settlement_reminder` routing.
  app.post('/api/settlement-reminder', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const groupId = String(req.body?.groupId || '');
    const targetUserId = String(req.body?.targetUserId || '');
    const amount = Number(req.body?.amount || 0);
    if (!groupId || !targetUserId || !(amount > 0)) {
      return res.status(400).json({ error: 'groupId, targetUserId, and a positive amount are required.' });
    }
    if (targetUserId === decoded.uid) return res.status(400).json({ error: "You can't send a reminder to yourself." });

    try {
      const [callerMemberSnap, targetMemberSnap, groupSnap] = await Promise.all([
        adminDb.collection('members').doc(`${decoded.uid}_${groupId}`).get(),
        adminDb.collection('members').doc(`${targetUserId}_${groupId}`).get(),
        adminDb.collection('groups').doc(groupId).get(),
      ]);
      if (!callerMemberSnap.exists) return res.status(403).json({ error: 'You must be a member of this group.' });
      if (!targetMemberSnap.exists) return res.status(404).json({ error: 'That person is not a member of this group.' });

      const groupName = groupSnap.exists ? groupSnap.data()?.name || 'the group' : 'the group';
      const actorName = decoded.name || callerMemberSnap.data()?.displayName || 'Someone';
      const amountStr = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const tokens = await collectPushTokens(adminDb, [targetUserId], 'notificationsEnabled');
      const body = `You owe ${actorName} ${amountStr} in "${groupName}" — tap to settle up.`;
      const sent = await sendPush(
        tokens,
        `${actorName} sent a payment reminder 💸`,
        body,
        { type: 'settlement_reminder', groupId, amount: String(amount), settleWith: decoded.uid },
      );
      await logFeedActivity(adminDb, {
        userId: targetUserId, type: 'settlement_reminder', description: body,
        userName: actorName, userPhoto: callerMemberSnap.data()?.photoURL || '',
        data: { groupId, amount, settleWith: decoded.uid },
      });
      return res.json({ sent });
    } catch (error) {
      console.error('settlement-reminder error:', error);
      return res.status(500).json({ error: 'Unable to send reminder.' });
    }
  });

  // Fired after a client-side member-role update (the write itself goes straight to Firestore
  // under firestore.rules, not through this endpoint) to push/log a notification to the newly
  // promoted member. Re-checks both the caller's and the target's roles server-side rather than
  // trusting the request body, since a forged call could otherwise fake an "you're now admin"
  // notification for anyone.
  app.post('/api/notify-role-change', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const groupId = String(req.body?.groupId || '');
    const targetUserId = String(req.body?.targetUserId || '');
    if (!groupId || !targetUserId) {
      return res.status(400).json({ error: 'groupId and targetUserId are required.' });
    }
    if (targetUserId === decoded.uid) return res.json({ sent: 0 });

    try {
      const [callerMemberSnap, targetMemberSnap, groupSnap] = await Promise.all([
        adminDb.collection('members').doc(`${decoded.uid}_${groupId}`).get(),
        adminDb.collection('members').doc(`${targetUserId}_${groupId}`).get(),
        adminDb.collection('groups').doc(groupId).get(),
      ]);
      const callerRole = callerMemberSnap.data()?.role;
      if (!callerMemberSnap.exists || (callerRole !== 'admin' && callerRole !== 'owner')) {
        return res.status(403).json({ error: 'Only group admins can promote members.' });
      }
      if (!targetMemberSnap.exists || targetMemberSnap.data()?.role !== 'admin') {
        return res.status(400).json({ error: 'That member is not an admin.' });
      }

      const groupName = groupSnap.exists ? groupSnap.data()?.name || 'the group' : 'the group';
      const actorName = decoded.name || callerMemberSnap.data()?.displayName || 'Someone';

      const tokens = await collectPushTokens(adminDb, [targetUserId], 'notificationsEnabled');
      const sent = await sendPush(
        tokens,
        `${groupName}: You're now an admin`,
        `${actorName} made you an admin of "${groupName}".`,
        { type: 'made_admin', groupId },
      );
      await logFeedActivity(adminDb, {
        userId: targetUserId, type: 'made_admin', description: `${actorName} made you an admin of "${groupName}".`,
        userName: actorName, userPhoto: callerMemberSnap.data()?.photoURL || '', data: { groupId },
      });
      return res.json({ sent });
    } catch (error) {
      console.error('notify-role-change error:', error);
      return res.status(500).json({ error: 'Unable to send notification.' });
    }
  });

  // Every chat surface in the app (group chat, all 6 game chats, and 1:1 direct messages between
  // group co-members) shares this one endpoint — same `comments` subcollection shape as before,
  // just written via Admin SDK now instead of a direct client Firestore write, so the server can
  // fan out a push to the other participant(s) in the same request. Recipients who've muted this
  // specific chat (`mutedGameChats`), muted the sender specifically (`mutedUsers`), or blocked the
  // sender (`blockedUsers`) are skipped — same suppression rules the client already applies to the
  // in-app unread dot (see GameChat.tsx's useGameChat), just enforced server-side for the push too.
  const CHAT_SURFACES: Record<string, { kind: 'group' | 'game' | 'dm'; label: string; routeSegment?: string }> = {
    groups: { kind: 'group', label: 'Group chat' },
    directChats: { kind: 'dm', label: 'Direct message' },
    rummyGames: { kind: 'game', label: '27-Hand Rummy', routeSegment: 'rummy' },
    sequenceGames: { kind: 'game', label: 'Sequence', routeSegment: 'sequence' },
    ludoGames: { kind: 'game', label: 'Ludo', routeSegment: 'ludo' },
    sweepGames: { kind: 'game', label: 'Sweep', routeSegment: 'sweep' },
    businessGames: { kind: 'game', label: 'Business', routeSegment: 'business' },
    chessGames: { kind: 'game', label: 'Chess', routeSegment: 'chess' },
  };

  app.post('/api/chat/send', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const collectionName = String(req.body?.collectionName || '');
    const chatId = String(req.body?.chatId || '');
    const text = String(req.body?.text || '').trim().slice(0, 500);
    const surface = CHAT_SURFACES[collectionName];
    if (!surface || !chatId || !text) return res.status(400).json({ error: 'collectionName, chatId, and text are required.' });

    try {
      let recipients: string[] = [];
      let displayName = 'Someone';
      let photoURL = '';
      let title = surface.label;
      let pushType = 'group_chat';
      let otherUid: string | null = null;

      if (surface.kind === 'group') {
        const [groupSnap, membersSnap, callerMemberSnap] = await Promise.all([
          db.collection('groups').doc(chatId).get(),
          db.collection('members').where('groupId', '==', chatId).get(),
          db.collection('members').doc(`${decoded.uid}_${chatId}`).get(),
        ]);
        if (!groupSnap.exists) return res.status(404).json({ error: 'Group not found.' });
        if (!callerMemberSnap.exists) return res.status(403).json({ error: 'Not a member of this group.' });
        displayName = callerMemberSnap.data()?.displayName || 'Someone';
        photoURL = callerMemberSnap.data()?.photoURL || '';
        recipients = membersSnap.docs.map((d) => d.data().userId).filter((uid: string) => uid !== decoded.uid);
        title = groupSnap.data()?.name || 'Group chat';
        // Deliberately distinct from 'comment' (Comments.tsx's expense/discussion threads) even
        // though both are group-scoped text — conflating them would make a plain expense-comment
        // push wrongly deep-link into the live chat panel (see routeNotificationTap).
        pushType = 'group_chat';
      } else if (surface.kind === 'dm') {
        // `chatId` is always `[uidA, uidB].sort().join('_')` (see Dashboard.tsx's dmChatId) —
        // authorization is just "am I one of the two halves," no separate membership doc needed.
        const parts = chatId.split('_');
        if (parts.length !== 2 || !parts.includes(decoded.uid)) {
          return res.status(403).json({ error: 'Not part of this conversation.' });
        }
        otherUid = parts[0] === decoded.uid ? parts[1] : parts[0];
        const callerSnap = await db.collection('users').doc(decoded.uid).get();
        displayName = callerSnap.data()?.displayName || decoded.name || 'Someone';
        photoURL = callerSnap.data()?.photoURL || '';
        recipients = [otherUid];
        pushType = 'dm_chat';
      } else {
        const gameSnap = await db.collection(collectionName).doc(chatId).get();
        if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found.' });
        const game = gameSnap.data()!;
        if (!(game.playerUids || []).includes(decoded.uid)) return res.status(403).json({ error: 'Not part of this game.' });
        const me = (game.players || []).find((p: any) => p.uid === decoded.uid);
        displayName = me?.displayName || 'Someone';
        photoURL = me?.photoURL || '';
        recipients = (game.playerUids || []).filter((uid: string) => uid !== decoded.uid);
        title = surface.label;
        pushType = `${surface.routeSegment}_chat`;
      }

      const nowIso = new Date().toISOString();
      const commentRef = await db.collection(collectionName).doc(chatId).collection('comments').add({
        userId: decoded.uid,
        displayName,
        photoURL,
        text,
        createdAt: nowIso,
      });

      if (surface.kind === 'dm' && otherUid) {
        // Parent `directChats/{chatId}` doc — the comments subcollection alone has no efficient
        // way to answer "which of my DM chats have unread messages / are most recent," since a
        // `collectionGroup` scan across all users' chats isn't scoped to just mine. This doc is
        // the queryable index: `participants` lets the client do one
        // `array-contains(myUid)` query for its whole DM list, `unreadFor` is a per-uid counter
        // (incremented for the recipient, zeroed for the sender — who's obviously caught up on
        // their own message) that the client zeroes again once it opens the chat. Low-stakes
        // (cosmetic unread badge, not financial data), so — unlike the comments themselves —
        // this doc is written server-only; see firestore.rules for the matching read/update-only
        // rule.
        await db.collection('directChats').doc(chatId).set({
          participants: [decoded.uid, otherUid],
          lastMessageAt: nowIso,
          lastMessageText: text,
          lastMessageBy: decoded.uid,
          [`unreadFor.${otherUid}`]: admin.firestore.FieldValue.increment(1),
          [`unreadFor.${decoded.uid}`]: 0,
        }, { merge: true });
      }

      let sent = 0;
      if (recipients.length > 0) {
        const chatKey = `${collectionName}:${chatId}`;
        const recipientSnaps = await Promise.all(recipients.map((uid) => db.collection('users').doc(uid).get()));
        const notifiable = recipients.filter((uid, i) => {
          const data = recipientSnaps[i].data() || {};
          const muted: string[] = data.mutedGameChats || [];
          const mutedSenders: string[] = data.mutedUsers || [];
          const blocked: string[] = data.blockedUsers || [];
          return !muted.includes(chatKey) && !mutedSenders.includes(decoded.uid) && !blocked.includes(decoded.uid);
        });
        const tokens = await collectPushTokens(db, notifiable, 'notificationsEnabled');
        const data: Record<string, string> = { type: pushType };
        if (surface.kind === 'group') data.groupId = chatId;
        else if (surface.kind === 'dm') { data.chatId = chatId; data.otherUid = decoded.uid; }
        else data.gameId = chatId;
        const pushTitle = surface.kind === 'dm' ? displayName : title;
        const pushBody = surface.kind === 'dm' ? text.slice(0, 100) : `${displayName}: ${text.slice(0, 100)}`;
        sent = await sendPush(tokens, pushTitle, pushBody, data);

        // `?chat=1` tells the destination screen to auto-open the chat panel itself (not just
        // land on the group/game page) — see the `?chat=1`-reading effect in
        // GroupAnalysisSummary.tsx and each game screen, mirroring how `?dm=` already works for
        // direct messages.
        const bannerTo = surface.kind === 'group'
          ? `/groups/${chatId}?chat=1`
          : surface.kind === 'dm'
            ? `/?dm=${decoded.uid}`
            : `/games/${surface.routeSegment}/${chatId}?chat=1`;

        if (surface.kind === 'group') {
          // One doc reaches every group member via the groupId list rule — same as any other
          // group-wide activity, not fanned out per recipient.
          await logFeedActivity(db, {
            userId: decoded.uid, type: pushType, description: pushBody, userName: displayName,
            userPhoto: photoURL, groupId: chatId, data,
          });
        } else {
          await Promise.all(notifiable.map((uid) => logFeedActivity(db, {
            userId: uid, type: pushType, description: pushBody, userName: pushTitle, userPhoto: photoURL, data,
          })));
        }
        // In-app drop-down banner for whoever has the app open right now — see InviteBanner.tsx.
        await Promise.all(notifiable.map((uid) => createInviteNotice(db, uid, 'chat', pushTitle, pushBody, bannerTo, photoURL)));
      }

      return res.json({ ok: true, id: commentRef.id, sent });
    } catch (error) {
      console.error('chat/send error:', error);
      return res.status(500).json({ error: 'Unable to send message.' });
    }
  });

  // Invites someone to a group by email. Any group member may call this (matches the app's
  // "anyone can invite" policy — enforced below via the caller's own membership doc, since
  // Firestore rules don't apply to Admin SDK writes made by this route).
  // - If the email already belongs to a FamilyLedger account, they get a push notification
  //   (same delivery path as other group activity) plus an activity feed entry.
  // - Otherwise, they get an email with a join link.
  // Calling this again for the same email while an invite is still pending is treated as a
  // "resend" — it reuses the existing invite doc instead of creating a duplicate.
  // Excludes 0/O/1/I/L — visually ambiguous when read aloud or typed by hand, which is the whole
  // point of a short ID (sharing it verbally or over text to be found in the invite search below).
  const SHORT_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  function generateShortId(): string {
    let id = '';
    for (let i = 0; i < 6; i++) id += SHORT_ID_ALPHABET[Math.floor(Math.random() * SHORT_ID_ALPHABET.length)];
    return id;
  }

  // Idempotent — assigns a 6-character search ID the first time it's called for an account, and
  // just returns the existing one on every call after that. Called fire-and-forget on every
  // sign-in (see AuthContext.tsx) so both new and pre-existing accounts end up with one.
  app.post('/api/ensure-short-id', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      const userRef = adminDb.collection('users').doc(decoded.uid);
      const snap = await userRef.get();
      if (snap.exists && snap.data()?.shortId) return res.json({ shortId: snap.data()!.shortId });

      // Collisions are vanishingly unlikely at this app's user count (31^6 ≈ 887M combinations)
      // but checked anyway rather than assumed away.
      let shortId = '';
      for (let attempt = 0; attempt < 5 && !shortId; attempt++) {
        const candidate = generateShortId();
        const clash = await adminDb.collection('users').where('shortId', '==', candidate).limit(1).get();
        if (clash.empty) shortId = candidate;
      }
      if (!shortId) return res.status(500).json({ error: 'Could not generate a unique ID — try again.' });

      await userRef.set({ shortId }, { merge: true });
      return res.json({ shortId });
    } catch (error) {
      console.error('ensure-short-id error:', error);
      return res.status(500).json({ error: 'Unable to assign an ID.' });
    }
  });

  // Backs the "Search FamilyLedger Users" invite picker (see ManageGroup.tsx) — any signed-in
  // user can look up others by their short ID, exact email, or a name substring, to invite them
  // into a group directly instead of only sharing a link. Runs server-side (Admin SDK) rather
  // than as a client Firestore query for two reasons: email isn't stored on the public `users`
  // doc at all (only encrypted, in the private subcollection — see AuthContext.tsx), so an email
  // lookup has to go through Firebase Auth; and keeping this server-side lets the response omit
  // email entirely, so searching by name/ID never leaks anyone's email address to the searcher.
  app.post('/api/search-users', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    const query = String(req.body?.query || '').trim();
    const groupId = req.body?.groupId ? String(req.body.groupId) : '';
    if (query.length < 2) return res.json({ users: [] });

    try {
      let existingMemberUids = new Set<string>();
      if (groupId) {
        const membersSnap = await adminDb.collection('members').where('groupId', '==', groupId).get();
        existingMemberUids = new Set(membersSnap.docs.map((d) => d.data().userId));
      }

      const matches = new Map<string, any>();

      const shortIdCandidate = query.toUpperCase();
      if (/^[A-Z0-9]{4,8}$/.test(shortIdCandidate)) {
        const snap = await adminDb.collection('users').where('shortId', '==', shortIdCandidate).limit(5).get();
        snap.docs.forEach((d) => matches.set(d.id, { uid: d.id, ...d.data() }));
      }

      if (query.includes('@') && adminAuth) {
        try {
          const userRecord = await adminAuth.getUserByEmail(normalizeEmail(query));
          const userSnap = await adminDb.collection('users').doc(userRecord.uid).get();
          if (userSnap.exists) matches.set(userRecord.uid, { uid: userRecord.uid, ...userSnap.data() });
        } catch (err: any) {
          if (err?.code !== 'auth/user-not-found') console.error('search-users email lookup error:', err);
        }
      }

      // Name substring match — a full collection scan + in-memory filter, simpler than
      // maintaining a lower-cased mirror field just for this. Fine at this app's current user
      // count; would need revisiting (e.g. a `displayNameLower` field + prefix query) if the user
      // base grows enough for this to become a real cost.
      if (matches.size < 10) {
        const lowerQuery = query.toLowerCase();
        const snap = await adminDb.collection('users').get();
        snap.docs.forEach((d) => {
          if (matches.has(d.id)) return;
          const displayName = String(d.data()?.displayName || '');
          if (displayName.toLowerCase().includes(lowerQuery)) matches.set(d.id, { uid: d.id, ...d.data() });
        });
      }

      const results = Array.from(matches.values())
        .filter((u) => u.uid !== decoded.uid && !existingMemberUids.has(u.uid))
        .slice(0, 10)
        .map((u) => ({ uid: u.uid, displayName: u.displayName || 'User', photoURL: u.photoURL || '', shortId: u.shortId || null }));

      return res.json({ users: results });
    } catch (error) {
      console.error('search-users error:', error);
      return res.status(500).json({ error: 'Search failed.' });
    }
  });

  app.post('/api/invite-to-group', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const groupId = String(req.body?.groupId || '');
    // `uid` (from the Search FamilyLedger Users picker) is an alternative to `email` (the
    // original manual-entry flow) — either identifies who to invite, resolved to the other below
    // since the rest of this handler (pending-invite dedup, the email itself) is written in
    // terms of `email`.
    const rawUid = String(req.body?.uid || '');
    let email = normalizeEmail(String(req.body?.email || ''));
    if (!groupId || (!email && !rawUid)) return res.status(400).json({ error: 'groupId and (email or uid) are required.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    try {
      if (rawUid && !email) {
        if (!adminAuth) return res.status(500).json({ error: 'Unable to resolve that user.' });
        const userRecord = await adminAuth.getUser(rawUid).catch(() => null);
        if (!userRecord?.email) return res.status(404).json({ error: 'That account could not be found.' });
        email = normalizeEmail(userRecord.email);
      }
      const callerMemberSnap = await db.collection('members').doc(`${decoded.uid}_${groupId}`).get();
      if (!callerMemberSnap.exists) {
        return res.status(403).json({ error: 'You must be a member of this group to invite people.' });
      }

      const groupSnap = await db.collection('groups').doc(groupId).get();
      if (!groupSnap.exists) return res.status(404).json({ error: 'Group not found.' });
      const groupName = groupSnap.data()?.name || 'a group';
      const inviterName = decoded.name || callerMemberSnap.data()?.displayName || 'Someone';
      const joinLink = `${PUBLIC_APP_URL}/join/${groupId}`;
      const invitesRef = db.collection('groups').doc(groupId).collection('invites');

      let targetUid: string | null = null;
      if (adminAuth) {
        try {
          targetUid = (await adminAuth.getUserByEmail(email)).uid;
        } catch (err: any) {
          if (err?.code !== 'auth/user-not-found') throw err;
        }
      }

      if (targetUid) {
        const existingMemberSnap = await db.collection('members').doc(`${targetUid}_${groupId}`).get();
        if (existingMemberSnap.exists) {
          return res.json({ method: 'already_member' });
        }
      }

      // Reuse a still-pending invite for this email instead of creating a duplicate.
      try {
        const pendingSnap = await invitesRef.where('email', '==', email).where('status', '==', 'pending').limit(1).get();
        const nowIso = new Date().toISOString();
        if (!pendingSnap.empty) {
          await pendingSnap.docs[0].ref.update({
            lastSentAt: nowIso,
            resendCount: admin.firestore.FieldValue.increment(1),
            ...(targetUid ? { targetUid } : {}),
          });
        } else {
          await invitesRef.add({
            email, invitedBy: decoded.uid, status: 'pending', groupName, link: joinLink,
            createdAt: nowIso, lastSentAt: nowIso, resendCount: 0,
            ...(targetUid ? { targetUid } : {}),
          });
        }
      } catch (logErr) {
        console.error('invite-to-group: failed to log invite doc:', logErr);
      }

      // Activity feed entry for existing group members.
      try {
        await db.collection('activities').add({
          groupId, userId: decoded.uid, userName: inviterName,
          userPhoto: callerMemberSnap.data()?.photoURL || '',
          type: 'invite', description: `${inviterName} invited ${email} to join the group.`,
          data: { groupName, invitedEmail: email },
          createdAt: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('invite-to-group: failed to log group activity:', logErr);
      }

      if (targetUid) {
        // Personal feed entry for the invitee — readable via canViewActivity's
        // `data.userId == request.auth.uid` clause even though they aren't a member yet.
        try {
          // `groupId` is deliberately kept OUT of the top level here (only inside `data`) — this
          // doc must stay reachable *only* via the personal `userId == request.auth.uid` query.
          // A top-level `groupId` would ALSO match every existing group member's
          // `groupId in myGroupIds` feed query (that query doesn't filter by type or userId),
          // which was leaking "You're invited" cards for OTHER people's pending invites into
          // every current member's own feed — see the bug report this fixes.
          await db.collection('activities').add({
            userId: targetUid, type: 'invite_received', personal: true,
            userName: inviterName, userPhoto: callerMemberSnap.data()?.photoURL || '',
            description: `${inviterName} invited you to join "${groupName}".`,
            data: { groupName, invitedBy: inviterName, groupId },
            createdAt: new Date().toISOString(),
          });
        } catch (logErr) {
          console.error('invite-to-group: failed to log invitee activity:', logErr);
        }

        const tokens = await collectPushTokens(db, [targetUid], 'notificationsEnabled');
        const sent = await sendPush(
          tokens,
          `Invitation to join ${groupName}`,
          `${inviterName} invited you to join "${groupName}" on FamilyLedger.`,
          { type: 'group_invite', groupId, groupName },
        );
        await createInviteNotice(db, targetUid, 'group', `Invitation to join ${groupName}`, `${inviterName} invited you to join "${groupName}"`, `/join/${groupId}`);
        return res.json({ method: 'push', sent });
      }

      if (!transporter) {
        return res.status(500).json({ error: 'Email invites are not configured on the server.' });
      }

      await transporter.sendMail({
        from: emailFrom,
        to: email,
        subject: `${inviterName} invited you to join "${groupName}" on FamilyLedger`,
        text: `${inviterName} invited you to join the group "${groupName}" on FamilyLedger, a shared expense tracker.\n\nJoin here: ${joinLink}\n\nIf you weren't expecting this, you can ignore this email.`,
        html: `
          <p>${inviterName} invited you to join the group <strong>${groupName}</strong> on FamilyLedger, a shared expense tracker.</p>
          <p><a href="${joinLink}" style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Join ${groupName}</a></p>
          <p>Or copy this link: ${joinLink}</p>
          <p>If you weren't expecting this, you can ignore this email.</p>
        `,
      });

      return res.json({ method: 'email' });
    } catch (error) {
      console.error('invite-to-group error:', error);
      return res.status(500).json({ error: 'Unable to send invite. Please try again.' });
    }
  });

  // Shared by the initial send, the single-request resend, and resend-all below — a feed entry +
  // push + in-app banner, exactly what a first-time request already got. Resending intentionally
  // fires every one of these again (not deduped/cooled-down) since the whole point of "resend" is
  // nudging someone who missed or ignored the first one.
  async function notifyFriendRequest(
    db: Firestore,
    params: { targetUid: string; requesterUid: string; requesterName: string; requesterPhoto: string },
  ): Promise<void> {
    await logFeedActivity(db, {
      userId: params.targetUid, type: 'friend_request',
      userName: params.requesterName, userPhoto: params.requesterPhoto,
      description: `${params.requesterName} sent you a friend request.`,
      data: { friendUid: params.requesterUid },
    });
    const tokens = await collectPushTokens(db, [params.targetUid], 'notificationsEnabled');
    await sendPush(tokens, 'New friend request', `${params.requesterName} wants to add you as a friend.`, { type: 'friend_request', uid: params.requesterUid });
    await createInviteNotice(db, params.targetUid, 'friend', 'New friend request', `${params.requesterName} wants to add you as a friend`, `/friends?request=${params.requesterUid}`);
  }

  // Friend requests are server-mediated (unlike group `invites`, which the client writes
  // directly) because this single endpoint needs to: resolve an email to a uid (Admin SDK),
  // respect blocks in both directions, and — the one piece of real logic — silently merge into
  // an acceptance if the other person already sent a request the other way, instead of leaving
  // two conflicting pending docs. `friendships/{id}` itself is `[uidA,uidB].sort().join('_')`,
  // same idiom as `directChats`, so "am I a participant" never needs a separate array field.
  // Accept goes through /api/friends/respond below for the same reason (push notification needs
  // Admin SDK); decline/cancel/unfriend need none of that and are plain client-side `deleteDoc`
  // calls under firestore.rules' `allow delete: if isParticipant()`.
  app.post('/api/friends/request', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const rawUid = String(req.body?.uid || '');
    const email = normalizeEmail(String(req.body?.email || ''));
    const resend = req.body?.resend === true;
    if (!rawUid && !email) return res.status(400).json({ error: 'uid or email is required.' });

    try {
      let targetUid = rawUid;
      if (!targetUid) {
        if (!adminAuth) return res.status(500).json({ error: 'Unable to resolve that user.' });
        const userRecord = await adminAuth.getUserByEmail(email).catch(() => null);
        if (!userRecord) return res.status(404).json({ error: 'No FamilyLedger account found with that email.' });
        targetUid = userRecord.uid;
      }
      if (targetUid === decoded.uid) return res.status(400).json({ error: "You can't add yourself as a friend." });

      const [meSnap, targetSnap] = await Promise.all([
        db.collection('users').doc(decoded.uid).get(),
        db.collection('users').doc(targetUid).get(),
      ]);
      if (!targetSnap.exists) return res.status(404).json({ error: 'That account could not be found.' });
      const meData = meSnap.data() || {};
      const targetData = targetSnap.data() || {};
      if ((targetData.blockedUsers || []).includes(decoded.uid)) {
        return res.status(403).json({ error: 'Unable to send a friend request to this person.' });
      }
      if ((meData.blockedUsers || []).includes(targetUid)) {
        return res.status(403).json({ error: "You've blocked this person. Unblock them first." });
      }

      const friendshipId = decoded.uid < targetUid ? `${decoded.uid}_${targetUid}` : `${targetUid}_${decoded.uid}`;
      const friendRef = db.collection('friendships').doc(friendshipId);
      const friendSnap = await friendRef.get();
      const myName = decoded.name || meData.displayName || 'Someone';

      if (friendSnap.exists) {
        const existing = friendSnap.data()!;
        if (existing.status === 'accepted') return res.json({ status: 'already_friends' });
        if (existing.requestedBy === decoded.uid) {
          if (!resend) return res.json({ status: 'already_pending' });
          await friendRef.update({
            lastSentAt: new Date().toISOString(),
            resendCount: admin.firestore.FieldValue.increment(1),
          });
          await notifyFriendRequest(db, { targetUid, requesterUid: decoded.uid, requesterName: myName, requesterPhoto: meData.photoURL || '' });
          return res.json({ status: 'resent' });
        }

        // The other person already requested us — merge into an acceptance rather than leaving
        // two pending requests pointed at each other.
        await friendRef.update({ status: 'accepted', respondedAt: new Date().toISOString() });
        await logFeedActivity(db, {
          userId: existing.requestedBy, type: 'friend_accepted',
          userName: myName, userPhoto: meData.photoURL || '',
          description: `${myName} accepted your friend request.`,
          data: { friendUid: decoded.uid },
        });
        const tokens = await collectPushTokens(db, [existing.requestedBy], 'notificationsEnabled');
        await sendPush(tokens, 'Friend request accepted', `${myName} accepted your friend request.`, { type: 'friend_accepted', uid: decoded.uid });
        await awardPointsStandalone(db, decoded.uid, { actionType: 'friend_accepted', ledgerKey: `${decoded.uid}_friend_accepted_${friendshipId}`, xp: 10, coins: 10, sourceCollection: 'friendships', sourceDocId: friendshipId });
        await awardPointsStandalone(db, existing.requestedBy, { actionType: 'friend_request_converted', ledgerKey: `${existing.requestedBy}_friend_request_converted_${friendshipId}`, xp: 20, coins: 20, sourceCollection: 'friendships', sourceDocId: friendshipId });
        return res.json({ status: 'accepted' });
      }

      // `participants` is redundant with the doc id ([uidA,uidB].sort().join('_')) but lets the
      // client run `where('participants', 'array-contains', myUid)` to list its own friendships —
      // Firestore can't query "is my uid one of the two halves of the document id" directly. Safe
      // to trust here since this doc is only ever written server-side (rules: create/update are
      // both `false`), so there's no way a client could set it inconsistently with the id.
      await friendRef.set({
        requestedBy: decoded.uid, status: 'pending', participants: [decoded.uid, targetUid],
        createdAt: new Date().toISOString(),
      });
      await notifyFriendRequest(db, { targetUid, requesterUid: decoded.uid, requesterName: myName, requesterPhoto: meData.photoURL || '' });
      return res.json({ status: 'pending' });
    } catch (error) {
      console.error('friends/request error:', error);
      return res.status(500).json({ error: 'Unable to send friend request. Please try again.' });
    }
  });

  // Nudges every request the caller has SENT and is still pending, in one action — the "resend
  // to all" companion to the single-target `resend: true` branch above. Done server-side as one
  // query + loop rather than the client firing N separate resend calls, both to save N auth
  // round-trips and to keep this in the same place as the identical single-resend logic.
  app.post('/api/friends/resend-all', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    try {
      const snap = await db.collection('friendships')
        .where('participants', 'array-contains', decoded.uid)
        .where('status', '==', 'pending')
        .where('requestedBy', '==', decoded.uid)
        .get();
      if (snap.empty) return res.json({ resent: 0 });

      const meSnap = await db.collection('users').doc(decoded.uid).get();
      const meData = meSnap.data() || {};
      const myName = decoded.name || meData.displayName || 'Someone';

      let resent = 0;
      for (const d of snap.docs) {
        const targetUid = (d.data().participants || []).find((u: string) => u !== decoded.uid);
        if (!targetUid) continue;
        await d.ref.update({
          lastSentAt: new Date().toISOString(),
          resendCount: admin.firestore.FieldValue.increment(1),
        });
        await notifyFriendRequest(db, { targetUid, requesterUid: decoded.uid, requesterName: myName, requesterPhoto: meData.photoURL || '' });
        resent++;
      }
      return res.json({ resent });
    } catch (error) {
      console.error('friends/resend-all error:', error);
      return res.status(500).json({ error: 'Unable to resend requests. Please try again.' });
    }
  });

  app.post('/api/friends/respond', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    const friendUid = String(req.body?.friendUid || '');
    if (!friendUid) return res.status(400).json({ error: 'friendUid is required.' });

    try {
      const friendshipId = decoded.uid < friendUid ? `${decoded.uid}_${friendUid}` : `${friendUid}_${decoded.uid}`;
      const friendRef = db.collection('friendships').doc(friendshipId);
      const friendSnap = await friendRef.get();
      if (!friendSnap.exists) return res.status(404).json({ error: 'Friend request not found.' });
      const existing = friendSnap.data()!;
      if (existing.status !== 'pending') return res.status(400).json({ error: 'Already handled.' });
      if (existing.requestedBy === decoded.uid) return res.status(403).json({ error: "You can't accept your own request." });

      await friendRef.update({ status: 'accepted', respondedAt: new Date().toISOString() });

      const meSnap = await db.collection('users').doc(decoded.uid).get();
      const meData = meSnap.data() || {};
      const myName = decoded.name || meData.displayName || 'Someone';
      await logFeedActivity(db, {
        userId: existing.requestedBy, type: 'friend_accepted',
        userName: myName, userPhoto: meData.photoURL || '',
        description: `${myName} accepted your friend request.`,
        data: { friendUid: decoded.uid },
      });
      const tokens = await collectPushTokens(db, [existing.requestedBy], 'notificationsEnabled');
      await sendPush(tokens, 'Friend request accepted', `${myName} accepted your friend request.`, { type: 'friend_accepted', uid: decoded.uid });
      await awardPointsStandalone(db, decoded.uid, { actionType: 'friend_accepted', ledgerKey: `${decoded.uid}_friend_accepted_${friendshipId}`, xp: 10, coins: 10, sourceCollection: 'friendships', sourceDocId: friendshipId });
      await awardPointsStandalone(db, existing.requestedBy, { actionType: 'friend_request_converted', ledgerKey: `${existing.requestedBy}_friend_request_converted_${friendshipId}`, xp: 20, coins: 20, sourceCollection: 'friendships', sourceDocId: friendshipId });
      return res.json({ status: 'accepted' });
    } catch (error) {
      console.error('friends/respond error:', error);
      return res.status(500).json({ error: 'Unable to respond to friend request. Please try again.' });
    }
  });

  // "People you may know" — mutual-friend suggestions, the friends-of-friends graph traversal
  // Firestore can't express as a single query. Computed server-side (not a client hook, unlike
  // the rest of Friends.tsx) because it needs to fan out across every one of the caller's
  // friends' OWN friend lists, which would otherwise leak the whole social graph shape to the
  // client just to compute a count. `array-contains-any` caps at 10 values per query, same limit
  // that forced useFriendships.ts's profile lookup to chunk at 30 for plain `in` — chunked the
  // same way here, just at the tighter 10-value ceiling.
  app.get('/api/friends/suggestions', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;
    const myUid = decoded.uid;

    try {
      const mySnap = await db.collection('friendships').where('participants', 'array-contains', myUid).get();
      const myFriends = new Set<string>();
      const excluded = new Set<string>([myUid]);
      mySnap.docs.forEach((d) => {
        const data = d.data();
        const other = (data.participants || []).find((u: string) => u !== myUid);
        if (!other) return;
        excluded.add(other);
        if (data.status === 'accepted') myFriends.add(other);
      });

      if (myFriends.size === 0) return res.json({ suggestions: [] });

      const friendList = Array.from(myFriends);
      const chunks: string[][] = [];
      for (let i = 0; i < friendList.length; i += 10) chunks.push(friendList.slice(i, i + 10));

      const mutualCount = new Map<string, number>();
      for (const chunk of chunks) {
        const snap = await db.collection('friendships')
          .where('participants', 'array-contains-any', chunk)
          .where('status', '==', 'accepted')
          .get();
        snap.docs.forEach((d) => {
          const parts: string[] = d.data().participants || [];
          for (const p of parts) {
            if (!chunk.includes(p)) continue;
            const other = parts.find((x) => x !== p);
            if (!other || excluded.has(other)) continue;
            mutualCount.set(other, (mutualCount.get(other) || 0) + 1);
          }
        });
      }

      const suggestedUids = Array.from(mutualCount.keys())
        .sort((a, b) => (mutualCount.get(b) || 0) - (mutualCount.get(a) || 0))
        .slice(0, 20);
      if (suggestedUids.length === 0) return res.json({ suggestions: [] });

      const meSnap = await db.collection('users').doc(myUid).get();
      const myBlocked = new Set<string>(meSnap.data()?.blockedUsers || []);

      const profiles = new Map<string, any>();
      for (let i = 0; i < suggestedUids.length; i += 30) {
        const chunk = suggestedUids.slice(i, i + 30);
        const snap = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get();
        snap.docs.forEach((d) => profiles.set(d.id, d.data()));
      }

      const suggestions = suggestedUids
        .filter((uid) => !myBlocked.has(uid) && !(profiles.get(uid)?.blockedUsers || []).includes(myUid))
        .map((uid) => ({
          uid,
          displayName: profiles.get(uid)?.displayName || 'Someone',
          photoURL: profiles.get(uid)?.photoURL || '',
          mutualCount: mutualCount.get(uid) || 0,
        }));

      return res.json({ suggestions });
    } catch (error) {
      console.error('friends/suggestions error:', error);
      return res.status(500).json({ error: 'Unable to load suggestions.' });
    }
  });

  // Accepts a pending recurring-expense confirmation, actually creating the expense now —
  // optionally with overridden amount/category/description (the "change it" option), leaving
  // the underlying recurring rule itself untouched for future occurrences.
  app.post('/api/recurring-confirm/:id/accept', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    try {
      const pendingRef = db.collection('pendingRecurringExpenses').doc(req.params.id);
      const pendingSnap = await pendingRef.get();
      if (!pendingSnap.exists) return res.status(404).json({ error: 'Not found.' });
      const pending = pendingSnap.data()!;
      if (pending.userId !== decoded.uid) return res.status(403).json({ error: 'Not yours to confirm.' });
      if (pending.status !== 'pending') return res.status(400).json({ error: 'Already handled.' });

      const amount = Number(req.body?.amount) > 0 ? Number(req.body.amount) : pending.amount;
      const category = String(req.body?.category || pending.category);
      const description = String(req.body?.description || pending.description);

      const groupRef = db.collection('groups').doc(pending.groupId);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) {
        await pendingRef.update({ status: 'declined' });
        return res.status(404).json({ error: 'Group no longer exists.' });
      }
      const groupData = groupSnap.data()!;
      const isIncome = pending.type === 'income';

      const expenseDoc: any = {
        groupId: pending.groupId,
        type: isIncome ? 'income' : 'expense',
        amount,
        description,
        category,
        date: pending.date,
        paidBy: pending.userId,
        paymentMethod: 'cash',
        addedBy: pending.userId,
        createdAt: new Date().toISOString(),
        recurringExpenseId: pending.recurringExpenseId,
        ...(pending.images?.length ? { images: pending.images } : {}),
      };

      // Income never splits — same as a live-added income entry (see AddExpense.tsx).
      if (!isIncome && groupData.splitEnabled) {
        const membersSnap = await db.collection('members').where('groupId', '==', pending.groupId).get();
        const memberUids = membersSnap.docs.map((d) => d.data().userId);
        const ruleSnap = pending.recurringExpenseId
          ? await db.collection('recurringExpenses').doc(pending.recurringExpenseId).get()
          : null;
        const splitInfo = computeRecurringSplitInfo(ruleSnap?.data(), amount, memberUids);
        if (splitInfo) expenseDoc.splitInfo = splitInfo;
      }

      await db.collection('expenses').add(expenseDoc);
      // Same expense-only totalSpending convention as AddExpense.tsx's live add — income
      // increments totalIncome instead, never totalSpending, so it can't be mistaken for spend
      // anywhere that reads totalSpending (group tiles, budgets, etc).
      await groupRef.update(
        isIncome
          ? { totalIncome: (groupData.totalIncome || 0) + amount }
          : { totalSpending: (groupData.totalSpending || 0) + amount },
      );
      if (!isIncome) {
        await db.collection('stats').doc('global').set(
          { totalExpenses: admin.firestore.FieldValue.increment(1), totalAmount: admin.firestore.FieldValue.increment(amount) },
          { merge: true },
        );
      }
      await db.collection('activities').add({
        groupId: pending.groupId,
        userId: pending.userId,
        userName: isIncome ? 'Recurring income' : 'Recurring expense',
        userPhoto: '',
        // FeedList.tsx's add_expense/add_income case keys its "Expense added" vs "Income added"
        // label off this literal type, not off `data` — must match a live AddExpense.tsx entry.
        type: isIncome ? 'add_income' : 'add_expense',
        description: `${isIncome ? 'Recurring income added' : 'Recurring expense added'}: ${description}`,
        data: { amount, description, groupName: groupData.name, currencyCode: groupData.currency },
        createdAt: new Date().toISOString(),
      });

      const membersSnap = await db.collection('members').where('groupId', '==', pending.groupId).get();
      const recipientUids = membersSnap.docs.map((d) => d.data().userId).filter((uid) => uid !== pending.userId);
      if (recipientUids.length > 0) {
        const tokens = await collectPushTokens(db, recipientUids, 'notificationsEnabled');
        await sendPush(
          tokens,
          isIncome ? `${groupData.name}: Recurring income added` : `${groupData.name}: Recurring expense added`,
          `"${description}" — ${amount} was added.`,
          { type: 'group_activity', groupId: pending.groupId },
        );
      }

      await pendingRef.update({ status: 'accepted', amount, category, description });
      if (pending.createdAt >= POINTS_LAUNCH_AT && Date.now() - new Date(pending.createdAt).getTime() < 24 * 3600 * 1000) {
        await awardPointsStandalone(db, pending.userId, {
          actionType: 'recurring_confirmed_ontime', ledgerKey: `${pending.userId}_recurring_confirmed_ontime_${req.params.id}`,
          xp: 5, coins: 5, sourceCollection: 'pendingRecurringExpenses', sourceDocId: req.params.id,
        });
      }
      return res.json({ ok: true });
    } catch (error) {
      console.error('recurring-confirm accept error:', error);
      return res.status(500).json({ error: 'Unable to accept this expense.' });
    }
  });

  // Declines a pending recurring-expense confirmation — nothing gets added this occurrence,
  // the recurring rule keeps running on schedule for future ones.
  app.post('/api/recurring-confirm/:id/decline', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });

    try {
      const pendingRef = adminDb.collection('pendingRecurringExpenses').doc(req.params.id);
      const pendingSnap = await pendingRef.get();
      if (!pendingSnap.exists) return res.json({ ok: true });
      if (pendingSnap.data()!.userId !== decoded.uid) return res.status(403).json({ error: 'Not yours to decline.' });

      await pendingRef.update({ status: 'declined' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('recurring-confirm decline error:', error);
      return res.status(500).json({ error: 'Unable to decline this expense.' });
    }
  });

  // Daily scheduled job (Cloud Scheduler -> this endpoint). Sends two kinds of reminders:
  // 1. Haven't logged an expense in 2+ days (only reminded once per day at most).
  // 2. Haven't opened the app in 5+ days, then again every 5 days after that.
  // Runs on a FAST schedule (every 15 min — see Cloud Scheduler job `familyledger-daily-reminders`,
  // repurposed as the fast job) — only the time-sensitive checks live here: things that can
  // genuinely become due at any moment during the day and where a user would notice/mind a long
  // delay (a recurring expense becoming due, a budget alert, a todo/loan reminder at its set time).
  // The per-user spend/inactivity/spread-word nudges and the activities cleanup sweep moved to
  // /api/cron/send-daily-reminders below, on a once-a-day schedule — those are multi-day-threshold
  // checks (2/5/14 days) where being off by up to a day is imperceptible, so there was no reason to
  // pay for evaluating them 96x/day at a 15-minute cadence. This split (plus running every 15
  // minutes instead of every 1 minute, i.e. 96x/day instead of 1,440x/day) is the main lever for
  // Cloud Run cost here — the job's cost scales with (invocations/day) × (work done per invocation),
  // and this cuts the first factor by 15x on this endpoint and moves the rest to run only once/day.
  app.post('/api/cron/send-reminders', async (req, res) => {
    const providedSecret = req.headers['x-cron-secret'];
    if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!adminDb) return res.status(500).json({ error: 'Firestore not available.' });
    const db = adminDb;

    try {
      const recurringExpensesProcessed = await processRecurringExpenses(db);
      const recurringRemindersNudged = await processRecurringReminderNudges(db);
      const expenseRemindersSent = await processExpenseReminders(db);
      const budgetRemindersSent = await processBudgetReminders(db);
      const todoRemindersSent = await processTodoReminders(db);
      const recurringTodosProcessed = await processRecurringTodos(db);
      const habitRemindersSent = await processHabitReminders(db);
      const loanRemindersSent = await processLoanReminders(db);
      const scheduledBroadcastsSent = await processScheduledBroadcasts(db);

      return res.json({
        ok: true,
        recurringExpensesProcessed,
        recurringRemindersNudged,
        expenseRemindersSent,
        budgetRemindersSent,
        todoRemindersSent,
        recurringTodosProcessed,
        habitRemindersSent,
        loanRemindersSent,
        scheduledBroadcastsSent,
      });
    } catch (error) {
      console.error('cron/send-reminders error:', error);
      return res.status(500).json({ error: 'Reminder job failed.' });
    }
  });

  // Runs once a day (new Cloud Scheduler job `familyledger-daily-digest`) — the multi-day-threshold
  // per-user nudges (2-day spend gap, 5-day inactivity, 14-day spread-the-word) plus the old-
  // activities cleanup sweep, none of which need — or benefit from — checking more than once a day.
  // The per-user loop is parallelized (`Promise.all` over every user's own read+maybe-send+maybe-
  // write) rather than the previous sequential `for...await` loop, which serialized one Firestore
  // round-trip per user one at a time; that pattern is exactly what made each invocation slow (and
  // therefore expensive under Cloud Run's per-request billing) as the user count grows.
  app.post('/api/cron/send-daily-reminders', async (req, res) => {
    const providedSecret = req.headers['x-cron-secret'];
    if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!adminDb) return res.status(500).json({ error: 'Firestore not available.' });
    const db = adminDb;

    const SPEND_MESSAGES = [
      "Haven't logged a spend in 2 days — even a coffee counts! ☕",
      "Your ledger's feeling a little quiet. Add today's expenses in 30 seconds.",
      "Psst — don't forget to log what you've spent the last couple of days!",
      "A gap in the ledger is a gap in the story. Catch up your expenses?",
    ];
    const INACTIVE_MESSAGES = [
      "We miss you! See how your spending's trending and settle up with the group.",
      "It's been a few days — your balances might have changed. Take a peek?",
      "Your family's still tracking expenses — come see where things stand!",
      "5 minutes now saves a headache later. Check in on your FamilyLedger.",
    ];
    const SPREAD_WORD_MESSAGES = [
      "Enjoying FamilyLedger? Share it with family or friends who split expenses too.",
      "Know someone who'd love an easier way to track shared expenses? Spread the word!",
      "A quick share goes a long way — tell someone about FamilyLedger today.",
      "Loving the app? A recommendation from you means more than any ad.",
    ];
    // Weekly nudge to add a birthday — only ever sent to someone with no `dateOfBirth` set yet,
    // and stops entirely (see dobReminderEnabled below) the moment they either add one or say
    // they'd rather not, so this never repeats past the point it's actually useful.
    const DOB_REMINDER_MESSAGES = [
      "Add your birthday and we'll help your groups remember it — and give you a proper shout-out too! 🎂",
      "Psst — you haven't told us your birthday yet. Add it so we don't miss the celebration!",
      "One quick thing: add your birthday and we'll handle the reminders for you (and your family/friends).",
    ];
    // Sent to the birthday person themselves, once a year, on the day itself — deliberately
    // silly/celebratory rather than a plain "Happy Birthday" line, per how this app already
    // handles other milestone moments (see JOKER_SPOTTED_LINES in RummyGame.tsx for the same
    // "table banter" tone applied to a game event instead of a life event).
    const BIRTHDAY_WISH_MESSAGES = [
      "🎉 Happy Birthday! Legally obligated to remind you: cake has zero calories today.",
      "🎂 It's your day! May your balances stay settled and your cake slices stay unsplit.",
      "🥳 Happy Birthday! Somewhere out there, a spreadsheet is throwing you a party too.",
      "🎈 Another trip around the sun, logged and verified. Happy Birthday!",
      "🎁 Happy Birthday! Today's the one expense you're allowed to NOT split with anyone.",
    ];
    const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

    try {
      const now = Date.now();
      const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
      const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
      const ONE_DAY = 24 * 60 * 60 * 1000;

      const usersSnap = await db
        .collection('users')
        .select('lastActiveAt', 'lastExpenseAddedAt', 'joinedAt', 'displayName', 'timezone')
        .get();

      const perUserResults = await Promise.all(
        usersSnap.docs.map(async (userDoc) => {
          const uid = userDoc.id;
          const data = userDoc.data();
          const privateSnap = await db.collection('users').doc(uid).collection('private').doc('info').get();
          const privateData = privateSnap.exists ? privateSnap.data()! : {};
          const fcmTokens: string[] = privateData.fcmTokens || [];
          if (fcmTokens.length === 0) return { spend: false, inactivity: false, spreadWord: false };

          const lastActive = new Date(data.lastActiveAt || data.joinedAt || 0).getTime();
          const lastExpense = data.lastExpenseAddedAt ? new Date(data.lastExpenseAddedAt).getTime() : 0;
          const lastSpendReminder = privateData.lastSpendReminderSentAt
            ? new Date(privateData.lastSpendReminderSentAt).getTime()
            : 0;
          const lastInactivityReminder = privateData.lastInactivityReminderSentAt
            ? new Date(privateData.lastInactivityReminderSentAt).getTime()
            : 0;
          // No prior send yet: baseline off lastActive (falls back to joinedAt) rather than 0, so
          // a brand-new user isn't asked to promote the app before they've had a chance to use it.
          const lastSpreadWordReminder = privateData.lastSpreadWordReminderSentAt
            ? new Date(privateData.lastSpreadWordReminderSentAt).getTime()
            : lastActive;

          let spend = false;
          let inactivity = false;
          let spreadWord = false;
          const privateRef = db.collection('users').doc(uid).collection('private').doc('info');

          // Spend reminder: 2+ days since last expense, not reminded in the last day.
          if (
            privateData.spendReminderEnabled !== false &&
            now - lastExpense >= TWO_DAYS &&
            now - lastSpendReminder >= ONE_DAY
          ) {
            const sent = await sendPush(fcmTokens, 'FamilyLedger', pick(SPEND_MESSAGES), { type: 'spend_reminder' });
            if (sent > 0) {
              await privateRef.set({ lastSpendReminderSentAt: new Date().toISOString() }, { merge: true });
              spend = true;
            }
          }

          // Inactivity reminder: 5+ days since last active, then every 5 days after that.
          if (
            privateData.inactivityReminderEnabled !== false &&
            now - lastActive >= FIVE_DAYS &&
            now - lastInactivityReminder >= FIVE_DAYS
          ) {
            const sent = await sendPush(fcmTokens, 'FamilyLedger', pick(INACTIVE_MESSAGES), { type: 'inactivity_reminder' });
            if (sent > 0) {
              await privateRef.set({ lastInactivityReminderSentAt: new Date().toISOString() }, { merge: true });
              inactivity = true;
            }
          }

          // Spread-the-word reminder: nudges every 14 days.
          if (privateData.spreadWordReminderEnabled !== false && now - lastSpreadWordReminder >= FOURTEEN_DAYS) {
            const sent = await sendPush(fcmTokens, 'FamilyLedger', pick(SPREAD_WORD_MESSAGES), { type: 'spread_word_reminder' });
            if (sent > 0) {
              await privateRef.set({ lastSpreadWordReminderSentAt: new Date().toISOString() }, { merge: true });
              spreadWord = true;
            }
          }

          let dobReminder = false;
          let birthdayWished = false;
          let birthdayTodos = 0;

          if (!privateData.dateOfBirth) {
            // Weekly nag — only while no birthday is on file AND the user hasn't asked to stop
            // (see handleDeclineDob in Profile.tsx).
            const lastDobReminder = privateData.lastDobReminderSentAt ? new Date(privateData.lastDobReminderSentAt).getTime() : 0;
            if (privateData.dobReminderEnabled !== false && now - lastDobReminder >= SEVEN_DAYS) {
              const sent = await sendPush(fcmTokens, 'FamilyLedger', pick(DOB_REMINDER_MESSAGES), { type: 'dob_reminder' });
              if (sent > 0) {
                await privateRef.set({ lastDobReminderSentAt: new Date().toISOString() }, { merge: true });
                dobReminder = true;
              }
            }
          } else {
            // Both the birthday-person's own wish and the group-mate to-dos fire on THEIR
            // calendar day (their own timezone, same convention as recurring expenses/expense
            // reminders — see todayDateStringInTimeZone), not the server's — a birthday shouldn't
            // shift by however far the server's UTC clock happens to be from where the user lives.
            const tz = data.timezone || 'UTC';
            const todayMonthDay = todayDateStringInTimeZone(tz).slice(5); // 'MM-DD'
            const dobMonthDay = String(privateData.dateOfBirth).slice(5, 10);
            const currentYear = Number(todayDateStringInTimeZone(tz).slice(0, 4));

            if (todayMonthDay === dobMonthDay) {
              if (privateData.lastBirthdayWishedYear !== currentYear) {
                const sent = await sendPush(fcmTokens, 'FamilyLedger', pick(BIRTHDAY_WISH_MESSAGES), { type: 'birthday_wish' });
                if (sent > 0) {
                  await privateRef.set({ lastBirthdayWishedYear: currentYear }, { merge: true });
                  birthdayWished = true;
                }
              }

              if (privateData.shareBirthdayWithFriends !== false && privateData.lastBirthdayTodosGeneratedYear !== currentYear) {
                try {
                  const membershipsSnap = await db.collection('members').where('userId', '==', uid).select('groupId').get();
                  const groupIds = Array.from(new Set(membershipsSnap.docs.map((d) => d.data().groupId)));
                  if (groupIds.length > 0) {
                    const memberDocsSnap = await db.collection('members').where('groupId', 'in', groupIds.slice(0, 30)).select('userId').get();
                    const groupMateUids = Array.from(new Set(memberDocsSnap.docs.map((d) => d.data().userId))).filter((u) => u !== uid);
                    const displayName = data.displayName || 'A group member';
                    const nowIso = new Date().toISOString();
                    const todoTokensByUid = await Promise.all(
                      groupMateUids.map((mateUid) => collectPushTokens(db, [mateUid], 'notificationsEnabled')),
                    );
                    await Promise.all(
                      groupMateUids.map(async (mateUid, i) => {
                        await db.collection('todos').add({
                          userId: mateUid,
                          text: `🎂 It's ${displayName}'s birthday today!`,
                          done: false,
                          reminderAt: null,
                          dueDate: null,
                          reminderSent: true, // sent directly below — the generic todo-reminder
                          // cron skips personal (no groupId) to-dos entirely, so this is never
                          // double-sent through that path.
                          groupId: null,
                          systemGenerated: true,
                          birthdayOwnerUid: uid,
                          birthdayYear: currentYear,
                          createdAt: nowIso,
                        });
                        await sendPush(todoTokensByUid[i], 'FamilyLedger', `🎂 It's ${displayName}'s birthday today! Give them a shout.`, {
                          type: 'birthday_group_reminder',
                        });
                      }),
                    );
                    birthdayTodos = groupMateUids.length;
                  }
                  await privateRef.set({ lastBirthdayTodosGeneratedYear: currentYear }, { merge: true });
                } catch (birthdayErr) {
                  console.error(`Failed to generate birthday to-dos for user ${uid}:`, birthdayErr);
                }
              }
            }
          }

          return { spend, inactivity, spreadWord, dobReminder, birthdayWished, birthdayTodos };
        }),
      );

      const spendReminders = perUserResults.filter((r) => r.spend).length;
      const inactivityReminders = perUserResults.filter((r) => r.inactivity).length;
      const spreadWordReminders = perUserResults.filter((r) => r.spreadWord).length;
      const dobReminders = perUserResults.filter((r) => r.dobReminder).length;
      const birthdaysWished = perUserResults.filter((r) => r.birthdayWished).length;
      const birthdayTodosCreated = perUserResults.reduce((sum, r) => sum + r.birthdayTodos, 0);
      const oldActivitiesDeleted = await cleanupOldActivities(db);

      return res.json({
        ok: true,
        spendReminders,
        inactivityReminders,
        spreadWordReminders,
        dobReminders,
        birthdaysWished,
        birthdayTodosCreated,
        usersScanned: usersSnap.size,
        oldActivitiesDeleted,
      });
    } catch (error) {
      console.error('cron/send-daily-reminders error:', error);
      return res.status(500).json({ error: 'Daily reminder job failed.' });
    }
  });

  // Runs once a week (Cloud Scheduler job `familyledger-weekly-summary`, registered separately —
  // see project notes, no Cloud Scheduler IaC lives in this repo for any cron job). For every user
  // with push enabled, computes games/groups/expenses/chat stats across 4 comparison windows (see
  // computeUserWeeklyStats), writes a `userWeeklySummaries` doc, a personal Feed entry, and a push
  // — same `x-cron-secret` guard and per-user `Promise.all` shape as send-daily-reminders above.
  app.post('/api/cron/send-weekly-summary', async (req, res) => {
    const providedSecret = req.headers['x-cron-secret'];
    if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!adminDb) return res.status(500).json({ error: 'Firestore not available.' });
    const db = adminDb;

    try {
      const now = Date.now();

      // Test-only scoping (never used by the real Cloud Scheduler job, which posts an empty body):
      // pass `testUid` or `testEmail` to run this against exactly one account instead of every
      // real user — lets a full end-to-end verification happen without pushing/writing to anyone
      // else. Resolves to an empty list (silent no-op) if the given email doesn't match a user.
      const usersSnap = await db.collection('users').select('displayName').get();
      const testUidRaw = String(req.body?.testUid || '');
      const testEmailRaw = String(req.body?.testEmail || '');
      let targetUserDocs = usersSnap.docs;
      if (testUidRaw) {
        targetUserDocs = usersSnap.docs.filter((d) => d.id === testUidRaw);
      } else if (testEmailRaw) {
        const authUser = await admin.auth().getUserByEmail(testEmailRaw).catch(() => null);
        targetUserDocs = usersSnap.docs.filter((d) => d.id === authUser?.uid);
      }

      const results = await Promise.all(
        targetUserDocs.map(async (userDoc) => {
          const uid = userDoc.id;
          const privateSnap = await db.collection('users').doc(uid).collection('private').doc('info').get();
          const privateData = privateSnap.exists ? privateSnap.data()! : {};
          // On-by-default, same convention as notificationsEnabled — only an explicit `false` opts
          // out of the whole feature (no summary doc, no feed entry, no push), not just the push.
          if (privateData.weeklySummaryEnabled === false) return { sent: false, generated: false };

          const { pushSent } = await generateAndDeliverWeeklySummary(db, uid, now);
          return { sent: pushSent, generated: true };
        }),
      );

      return res.json({
        ok: true,
        totalUsers: usersSnap.size,
        usersProcessed: targetUserDocs.length,
        summariesGenerated: results.filter((r) => r.generated).length,
        pushesSent: results.filter((r) => r.sent).length,
      });
    } catch (error) {
      console.error('cron/send-weekly-summary error:', error);
      return res.status(500).json({ error: 'Weekly summary job failed.' });
    }
  });

  // Self-service "Generate my weekly recap" button (Profile.tsx) — lets a signed-in user trigger
  // their OWN summary on demand, for trying the feature out before the real weekly Cloud Scheduler
  // job is registered (see the cron endpoint above), and afterward as a manual refresh if someone
  // wants an up-to-the-minute recap without waiting for next week's automatic one.
  app.post('/api/weekly-summary/generate-mine', async (req, res) => {
    const decoded = await verifyAuthHeader(req);
    if (!decoded || !adminDb) return res.status(401).json({ error: 'Unauthorized.' });
    const db = adminDb;

    try {
      const { summaryId, pushSent } = await generateAndDeliverWeeklySummary(db, decoded.uid, Date.now());
      return res.json({ ok: true, summaryId, pushSent });
    } catch (error) {
      console.error('weekly-summary/generate-mine error:', error);
      return res.status(500).json({ error: 'Unable to generate your weekly recap.' });
    }
  });

  // Social-share landing page — a plain server-rendered HTML page (not the SPA) with real Open
  // Graph tags, so Facebook/WhatsApp link previews show a proper banner + description instead
  // of just a bare URL. Deliberately does NOT auto-redirect (no meta-refresh, no JS redirect) —
  // an earlier version did, and some clients' link-preview fetchers (observed: the Facebook
  // Android app's own composer, not just its server-side crawler) follow a meta-refresh/JS
  // redirect when building the preview, landing on whatever the target page's <title> is. Since
  // the Play Store listing isn't published yet (playStoreUrl currently 404s — Google's "Not
  // Found" page's own <title> is literally "Not Found"), that redirect-chasing was clobbering
  // the preview with the Play Store's 404 title instead of this page's own OG tags. A static
  // page with just a manual "Get it on Google Play" link/button sidesteps that entirely, and
  // will keep working with no code changes once the listing goes public.
  app.get('/share', (req, res) => {
    const baseUrl = PUBLIC_APP_URL;
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
    const title = 'FamilyLedger — Track & Split Expenses Together';
    const description =
      "I'm using FamilyLedger to track and organise my expenses — group splitting, recurring expenses, budgets & alerts. I recommend this app!";
    const imageUrl = `${baseUrl}/share-banner.png`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${baseUrl}/share" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${imageUrl}" />
  <style>
    body{font-family:-apple-system,'Segoe UI',Arial,sans-serif;text-align:center;padding:0;margin:0;color:#0F172A;background:#F8FAFC;}
    img{width:100%;max-width:600px;height:auto;display:block;margin:0 auto;}
    .wrap{padding:32px 20px 60px;max-width:600px;margin:0 auto;}
    p{font-size:16px;line-height:1.5;color:#334155;}
    a.cta{display:inline-block;margin-top:12px;padding:14px 28px;background:#123A82;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;}
  </style>
</head>
<body>
  <img src="${imageUrl}" alt="${title}" />
  <div class="wrap">
    <p>${description}</p>
    <a class="cta" href="${playStoreUrl}">Get it on Google Play</a>
  </div>
</body>
</html>`);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static serving with SPA fallback. Vite content-hashes every filename under
    // dist/assets (a new build always ships under new filenames), so those are safe to cache
    // aggressively — but index.html itself is NOT hashed and is what actually references those
    // filenames, so it must never be cached: an Android WebView (this app's Capacitor
    // `server.url` points straight at this server, not a bundled local copy) that caches an old
    // index.html would keep loading whatever JS bundle was live the last time it fetched it,
    // silently making every fix in a new deploy invisible until the cache expires or is cleared —
    // indistinguishable from "the fix didn't work" from inside the app itself.
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (/[\\/](sw|registerSW|workbox-.*)\.js$/.test(filePath)) {
          // The service worker script (and its registration/runtime helpers) must always be
          // revalidated — that's the only way the browser ever notices a new build shipped and
          // swaps the offline-cached app shell for it. Caching this would silently defeat the
          // vite-plugin-pwa autoUpdate mechanism.
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
    app.get("*", (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  await verifySmtpConnection();

  // Stamps this revision into `app_config/webBuild` so every open tab's UpdateBanner listener
  // learns a new deploy has landed, without polling. Guarded to Cloud Run only (`K_REVISION` is
  // absent from local `npm start`) so a local dev server never overwrites the real production
  // marker with a value every real user's tab would then treat as "newer" than what they're
  // actually running.
  if (adminDb && process.env.K_REVISION) {
    adminDb.collection('app_config').doc('webBuild').set({
      revision: process.env.K_REVISION,
      updatedAt: new Date().toISOString(),
    }).catch((err) => console.error('Failed to stamp app_config/webBuild:', err));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
