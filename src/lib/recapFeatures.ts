// Decides what a person's weekly recap shows: every feature the app tracks gets a score for the week,
// the ones they were most engaged in float to the top, and the recap always lists at least six
// different features (topped up with standing stats and gentle "try this" suggestions when someone
// was quiet), so no two people's recaps look alike.

export interface RecapBucketData {
  gamesPlayed: number;
  coPlayers: number;
  groupsEngaged: number;
  expensesTracked: number;
  expenseLinesAdded: number;
  chatGroups: number;
  chatPeople: number;
  // Newer fields — missing on recaps generated before they existed.
  bpReadings?: number;
  glucoseReadings?: number;
  medicineDoses?: number;
  vaccinesGiven?: number;
  todosAdded?: number;
  shoppingLists?: number;
  goalsCreated?: number;
}

export type RecapCategory = 'money' | 'health' | 'games' | 'social' | 'planning';

export interface RecapFeature {
  key: string;
  emoji: string;
  label: string;
  category: RecapCategory;
  value: number;
  prev: number;
  active: boolean; // false → shown as a suggestion ("try it"), not a real stat
}

interface FeatureDef {
  key: string;
  emoji: string;
  label: (week: RecapBucketData) => string;
  category: RecapCategory;
  weight: number; // how much one unit counts toward "where you were most engaged"
  read: (b: RecapBucketData) => number;
}

const FEATURES: FeatureDef[] = [
  { key: 'games', emoji: '🎮', category: 'games', weight: 3, read: (b) => b.gamesPlayed, label: (w) => `Games played${w.coPlayers ? ` · with ${w.coPlayers}` : ''}` },
  { key: 'groups', emoji: '🏠', category: 'social', weight: 3, read: (b) => b.groupsEngaged, label: () => 'Groups engaged in' },
  { key: 'expenses', emoji: '🧾', category: 'money', weight: 1, read: (b) => b.expensesTracked, label: () => 'Expenses tracked' },
  { key: 'expenseLines', emoji: '✍️', category: 'money', weight: 1.5, read: (b) => b.expenseLinesAdded, label: () => 'Expenses you added' },
  { key: 'chat', emoji: '💬', category: 'social', weight: 2, read: (b) => b.chatPeople, label: () => 'People chatted with' },
  { key: 'bp', emoji: '❤️', category: 'health', weight: 2, read: (b) => b.bpReadings ?? 0, label: () => 'BP readings logged' },
  { key: 'glucose', emoji: '🩸', category: 'health', weight: 2, read: (b) => b.glucoseReadings ?? 0, label: () => 'Glucose readings logged' },
  { key: 'meds', emoji: '💊', category: 'health', weight: 1.5, read: (b) => b.medicineDoses ?? 0, label: () => 'Medicine doses taken' },
  { key: 'vaccines', emoji: '💉', category: 'health', weight: 5, read: (b) => b.vaccinesGiven ?? 0, label: () => 'Vaccines recorded' },
  { key: 'todos', emoji: '✅', category: 'planning', weight: 1.5, read: (b) => b.todosAdded ?? 0, label: () => 'To-dos added' },
  { key: 'shopping', emoji: '🛒', category: 'planning', weight: 2, read: (b) => b.shoppingLists ?? 0, label: () => 'Shopping lists made' },
  { key: 'goals', emoji: '🎯', category: 'money', weight: 5, read: (b) => b.goalsCreated ?? 0, label: () => 'New goals set' },
];

const CATEGORY_HEADLINE: Record<RecapCategory, { headline: string; focus: string }> = {
  money: { headline: 'A money-savvy week', focus: 'Money' },
  health: { headline: 'A healthy week', focus: 'Health' },
  games: { headline: 'Game-night champ', focus: 'Games' },
  social: { headline: 'The family connector', focus: 'Family & chat' },
  planning: { headline: 'Getting things done', focus: 'Planning' },
};

export interface RecapView {
  headline: string;
  focus: string | null;  // "Money", "Health"... or null for a quiet week
  features: RecapFeature[]; // 6 to 8, most-engaged first
}

export function buildRecapView(
  week: RecapBucketData,
  prevWeek: RecapBucketData,
  snapshot: { goalsTracked?: number; accountsMonitored?: number },
): RecapView {
  const all: Array<RecapFeature & { score: number }> = FEATURES.map((f) => {
    const value = f.read(week);
    return { key: f.key, emoji: f.emoji, label: f.label(week), category: f.category, value, prev: f.read(prevWeek), active: value > 0, score: value * f.weight };
  });

  const engaged = all.filter((f) => f.active).sort((a, b) => b.score - a.score);
  const picked: RecapFeature[] = engaged.slice(0, 8);

  // Top up to six with standing stats the person already has (not week-over-week activity)...
  const standing: RecapFeature[] = [];
  if (snapshot.goalsTracked) standing.push({ key: 'goalsTracked', emoji: '🏆', label: 'Savings goals tracked', category: 'money', value: snapshot.goalsTracked, prev: snapshot.goalsTracked, active: true });
  if (snapshot.accountsMonitored) standing.push({ key: 'accounts', emoji: '🏦', label: 'Accounts monitored', category: 'money', value: snapshot.accountsMonitored, prev: snapshot.accountsMonitored, active: true });
  for (const s of standing) {
    if (picked.length >= 6) break;
    picked.push(s);
  }

  // ...then with features they haven't touched this week, spread across categories so the
  // suggestions are varied rather than six health rows in a row.
  const idle = all.filter((f) => !f.active);
  const seenCategories = new Set<RecapCategory>(picked.map((f) => f.category));
  const ordered = [...idle.filter((f) => !seenCategories.has(f.category)), ...idle.filter((f) => seenCategories.has(f.category))];
  for (const f of ordered) {
    if (picked.length >= 6) break;
    picked.push({ key: f.key, emoji: f.emoji, label: f.label, category: f.category, value: 0, prev: f.prev, active: false });
  }

  const top = engaged[0];
  const meta = top ? CATEGORY_HEADLINE[top.category] : null;
  return {
    headline: meta?.headline ?? 'A fresh start',
    focus: meta?.focus ?? null,
    features: picked,
  };
}
