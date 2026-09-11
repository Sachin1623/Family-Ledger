// Placeholder trip participants — people added to a split group BY NAME who don't (yet) have an
// app account. Stored as a map on the group doc: `group.participants = { [id]: GroupParticipant }`
// where `id` is a client-generated key that is used DIRECTLY as a `userId` inside an expense's
// `splitInfo.splits[]` (and as `paidBy`). The balance engine (Settlements.tsx) already keys
// balances by that string, so a placeholder nets correctly with no math changes — the only thing
// that needs help is turning the id back into a name in every list/picker.
//
// When the real person joins, `POST /api/group/link-participant` (server.ts, Admin SDK) rewrites
// every split from this id to their real uid and sets `linkedUserId` here — after which the
// placeholder is "claimed" and drops out of the roster (its old id no longer appears in any
// split, so nothing to resolve).
//
// A map keyed by a client id (not an array) so two people adding a name at the same time don't
// race — `updateDoc(groupRef, { ['participants.' + id]: {...} })` merges by key.

export interface GroupParticipant {
  name: string;
  addedBy: string; // uid of the member who added them
  linkedUserId: string | null; // set once claimed by a real account
  createdAt: string;
}

export interface RosterEntry {
  userId: string; // real uid, or a placeholder id
  displayName: string;
  photoURL: string;
  isPlaceholder?: boolean;
}

// Unclaimed placeholders (linkedUserId still null), shaped like a member row so they drop
// straight into any picker/list that already iterates `members`.
export function placeholderRows(group: any): RosterEntry[] {
  const map = (group?.participants || {}) as Record<string, GroupParticipant>;
  return Object.entries(map)
    .filter(([, p]) => p && !p.linkedUserId && typeof p.name === 'string')
    .map(([id, p]) => ({ userId: id, displayName: p.name, photoURL: '', isPlaceholder: true }));
}

// `members` + unclaimed placeholders, in one array the split UI iterates unchanged.
export function buildRoster<T extends { userId: string }>(members: T[], group: any): (T | RosterEntry)[] {
  return [...members, ...placeholderRows(group)];
}

// Whether an id in a split is a not-yet-claimed placeholder in this group.
export function isPlaceholderId(id: string, group: any): boolean {
  const p = (group?.participants || {})[id];
  return !!p && !p.linkedUserId;
}

// id -> display name across one OR MANY groups' participant maps — for Settlements /
// ExpenseQuickView, which resolve split ids that could belong to any of several loaded groups.
export function participantNameMap(groups: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups || []) {
    const map = (g?.participants || {}) as Record<string, GroupParticipant>;
    for (const [id, p] of Object.entries(map)) {
      if (p && typeof p.name === 'string') m.set(id, p.name);
    }
  }
  return m;
}

// Number of one-time expense docs that still reference `participantId` (as payer or split
// participant) — one expense counts once even if the id appears in both places. Used both to
// block deleting a placeholder that's mid-trip and to show the user how much is still tied to it.
export function participantExpenseCount(participantId: string, expenses: any[]): number {
  return (expenses || []).filter(
    (e) =>
      e.paidBy === participantId ||
      (e.splitInfo?.splits || []).some((s: any) => s.userId === participantId),
  ).length;
}

// True if any recurring rule's split still references `participantId` — a rule can hold a
// placeholder id in `splitMembers` without ever having materialized an expense yet, so this needs
// its own check rather than relying on the `expenses` collection.
export function participantInRecurringUse(participantId: string, recurringRules: any[]): boolean {
  return (recurringRules || []).some((r) => (r.splitMembers || []).includes(participantId));
}

// True if any of this group's expenses OR recurring rules still reference `participantId` (used
// to block deleting a placeholder that's mid-trip — pass the group's expenses/recurring rules in).
export function participantInUse(participantId: string, expenses: any[], recurringRules: any[] = []): boolean {
  return participantExpenseCount(participantId, expenses) > 0 || participantInRecurringUse(participantId, recurringRules);
}
