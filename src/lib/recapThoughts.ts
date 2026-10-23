// What financially steady families tend to do, in plain words, with where each idea comes from. These are widely repeated rules of thumb from
// financial planners and consumer-finance research, offered as encouragement, never as a promise of a result. (No invented statistics: the one
// study quoted is real, and says only what the study reported.)
export interface CommunityThought {
  icon: string; // Material Symbols name, for the in-app card
  emoji: string; // for the shared picture
  text: string;
  source: string;
}

export const COMMUNITY_THOUGHTS: CommunityThought[] = [
  { icon: 'savings', emoji: '🛟', text: 'Financial planners commonly suggest keeping 3 to 6 months of living expenses aside as an emergency fund, kept separate from everyday savings.', source: 'Common planner guidance' },
  { icon: 'pie_chart', emoji: '🥧', text: 'The popular 50/30/20 guide splits income into needs, wants and savings. It only works if you know where the money actually goes, and you are finding that out.', source: '50/30/20 rule of thumb (Elizabeth Warren)' },
  { icon: 'visibility', emoji: '👀', text: 'In a UK study, people who used a budgeting method for three months: about half said it helped them keep track of what they spend, and over a third understood their income and spending better.', source: 'Royal London, "Looking after the pennies" (2017)' },
  { icon: 'event_repeat', emoji: '🔁', text: 'Money habits stick when they are small and regular. A quick check-in each week matters more than a long review once a year.', source: 'Habit-building principle widely used by planners' },
  { icon: 'family_restroom', emoji: '👨‍👩‍👧', text: 'Families who talk about money openly, with everyone seeing the same numbers, tend to argue less about it. Shared groups give you exactly that.', source: 'Common family-finance advice' },
  { icon: 'flag', emoji: '🎯', text: 'Writing a goal down, with an amount and a date, makes it far easier to act on than a vague wish to save more.', source: 'Goal-setting guidance used by planners' },
  { icon: 'health_and_safety', emoji: '🩺', text: 'Health is a money topic too. Medical costs are one of the biggest surprises in a family budget, and staying on top of check-ups and medicines helps avoid them.', source: 'Common family-finance advice' },
];

/** The thought for a given recap: one per week, rotating. */
export function thoughtFor(generatedAt: string): CommunityThought {
  const weekNumber = Math.floor(new Date(generatedAt).getTime() / (7 * 86_400_000));
  return COMMUNITY_THOUGHTS[((weekNumber % COMMUNITY_THOUGHTS.length) + COMMUNITY_THOUGHTS.length) % COMMUNITY_THOUGHTS.length];
}

// The number of days someone has been active on FamilyLedger gets a name, and a rank that grows as the days add up.
export const GUARDIAN_DAYS_NAME = 'Guardian Days';
export function guardianLevel(days: number): { title: string; next: number | null } {
  if (days >= 150) return { title: 'Legendary Guardian', next: null };
  if (days >= 75) return { title: 'Trusted Guardian', next: 150 };
  if (days >= 30) return { title: 'Steady Guardian', next: 75 };
  if (days >= 10) return { title: 'Rising Guardian', next: 30 };
  return { title: 'Guardian in the making', next: 10 };
}

export interface RecapHabit {
  done: boolean;
  icon: string;
  emoji: string;
  title: string;
  text: string;
}

/** The three habits shown on the recap, ticked from what this person actually did. */
export function recapHabits(opts: {
  trackedMoney: boolean;
  planning: boolean;
  health: boolean;
  goalsTracked: number;
  accountsMonitored: number;
}): RecapHabit[] {
  const { trackedMoney, planning, health, goalsTracked, accountsMonitored } = opts;
  return [
    { done: trackedMoney, icon: 'receipt_long', emoji: '🧾', title: 'Knows where the money goes', text: 'Tracks spending, the first step planners ask of every family.' },
    {
      done: planning, icon: 'flag', emoji: '🎯', title: 'Plans ahead',
      text: planning ? `Tracking ${goalsTracked} goal${goalsTracked === 1 ? '' : 's'} and ${accountsMonitored} account${accountsMonitored === 1 ? '' : 's'}.` : 'Set one goal with an amount and a date to join the planners.',
    },
    {
      done: health, icon: 'favorite', emoji: '❤️', title: "Protects the family's health",
      text: health ? 'Keeps health records, which helps avoid costly surprises.' : 'Add a medicine or health log to cover family wellbeing.',
    },
  ];
}
