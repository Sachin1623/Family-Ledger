// Shared group-icon picker options (CreateGroup.tsx, ManageGroup.tsx) and the legacy-value
// migration used everywhere a group's `icon` field is displayed (Dashboard.tsx,
// GroupAnalysisSummary.tsx, JoinGroup.tsx, ManageGroup.tsx) — `icon` is native emoji now, but
// every group created before this change has it stored as the OLD Material Symbol ligature name
// (e.g. "cottage"), so a straight display would show broken literal text for those. `groupIconEmoji`
// maps known old values back to their new emoji equivalent; anything not in the table (already
// emoji, from a group created/edited after this change) passes through unchanged.
export const GROUP_ICONS = [
  { id: 'family', name: 'Family', icon: '👨‍👩‍👧‍👦' },
  { id: 'friends', name: 'Friends', icon: '🧑‍🤝‍🧑' },
  { id: 'home', name: 'Home', icon: '🏠' },
  { id: 'shopping', name: 'Shopping', icon: '🛒' },
  { id: 'restaurant', name: 'Food', icon: '🍽️' },
  { id: 'commute', name: 'Transport', icon: '🚗' },
  { id: 'flight', name: 'Travel', icon: '✈️' },
  { id: 'savings', name: 'Savings', icon: '🐷' },
  { id: 'receipt', name: 'Bills', icon: '🧾' },
  { id: 'celebration', name: 'Events', icon: '🎉' },
  { id: 'school', name: 'Education', icon: '🎓' },
];

const LEGACY_ICON_MAP: Record<string, string> = {
  family_restroom: '👨‍👩‍👧‍👦',
  diversity_3: '🧑‍🤝‍🧑',
  home: '🏠',
  cottage: '🏠',
  shopping_cart: '🛒',
  restaurant: '🍽️',
  directions_car: '🚗',
  travel_explore: '✈️',
  savings: '🐷',
  receipt: '🧾',
  celebration: '🎉',
  school: '🎓',
  groups: '👥',
};

export function groupIconEmoji(icon: string | undefined | null): string {
  if (!icon) return '🏠';
  return LEGACY_ICON_MAP[icon] || icon;
}
