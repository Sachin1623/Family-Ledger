// Hands off "these expense ids were just added to this group" from AddExpense.tsx to
// Dashboard.tsx, so the group tile can highlight them once the user actually gets back there —
// whether that's via the "Save" button (leaves immediately, one id) or after several rounds of
// "Save & Add More" (stays on the form, accumulates ids, then whatever eventually navigates away
// — the header back arrow, a bottom-nav tap, browser back — picks up the whole accumulated set).
// localStorage rather than a React ref/context, since this has to survive AddExpense actually
// unmounting — same reasoning as Dashboard's own EXPANDED_STORAGE_KEY.
const STORAGE_KEY = 'familyledger_recently_added_expenses';
// A save-and-add-more session that never makes it back to Dashboard (closed the tab, force-quit
// the app) shouldn't keep re-highlighting stale entries on some much-later visit.
const MAX_AGE_MS = 10 * 60 * 1000;

interface RecentEntry { groupId: string; expenseIds: string[]; savedAt: number }

function readAll(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all: RecentEntry[] = raw ? JSON.parse(raw) : [];
    return all.filter((e) => Date.now() - e.savedAt < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function writeAll(entries: RecentEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable (private browsing etc.) — the highlight hand-off just won't
    // happen; never worth failing the actual expense save over.
  }
}

// Called after every successful expense save (both "Save" and "Save & Add More").
export function markExpenseAdded(groupId: string, expenseId: string) {
  const all = readAll();
  const existing = all.find((e) => e.groupId === groupId);
  if (existing) {
    existing.expenseIds.push(expenseId);
    existing.savedAt = Date.now();
  } else {
    all.push({ groupId, expenseIds: [expenseId], savedAt: Date.now() });
  }
  writeAll(all);
}

// Non-destructive: Dashboard.tsx reads this ONCE up front (a lazy useState initializer, so it
// runs synchronously before first paint) to know which groups to render already-expanded and
// which expense ids to highlight in each — then calls clearRecentlyAdded() right after, so a
// later reload doesn't keep re-highlighting the same entries.
export function peekRecentlyAdded(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  readAll().forEach((e) => { map[e.groupId] = e.expenseIds; });
  return map;
}

export function clearRecentlyAdded() {
  writeAll([]);
}
