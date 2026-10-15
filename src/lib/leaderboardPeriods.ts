// "Today" and "This week" for the score leaderboards (Sudoku, Scramble). Each leaderboard document already
// holds a player's lifetime numbers; it also carries `dayScores` — one number per local calendar day, kept for
// the last 8 days only — so the period boards read the very same documents (no extra reads, no extra index).
// Sudoku ranks by the SUM of a day's puzzle scores, Scramble by the BEST single match of the day.
import { toLocalDateString } from './dateUtils';

export type LeaderboardPeriod = 'today' | 'week' | 'all';
export type DayScoreMode = 'sum' | 'max';
export type DayScores = Record<string, number>;

const KEEP_DAYS = 8;

export function dayKeyOf(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return toLocalDateString(Number.isNaN(d.getTime()) ? new Date() : d);
}

/** Adds one finished game's score to the per-day map and drops anything older than the last 8 days. */
export function addToDayScores(current: DayScores | undefined, score: number, whenIso: string, mode: DayScoreMode): DayScores {
  const next: DayScores = { ...(current || {}) };
  const key = dayKeyOf(whenIso);
  next[key] = mode === 'sum' ? (next[key] || 0) + score : Math.max(next[key] || 0, score);
  const cutoff = dayKeyOf(new Date(Date.now() - KEEP_DAYS * 86400000));
  Object.keys(next).forEach((k) => { if (k < cutoff) delete next[k]; });
  return next;
}

/** The player's number for the chosen period (0 when they haven't played in it). */
export function periodValue(dayScores: DayScores | undefined, period: Exclude<LeaderboardPeriod, 'all'>, mode: DayScoreMode, now = new Date()): number {
  if (!dayScores) return 0;
  const keys: string[] = [];
  const days = period === 'today' ? 1 : 7;
  for (let i = 0; i < days; i++) keys.push(dayKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  const values = keys.map((k) => dayScores[k] || 0);
  return mode === 'sum' ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values);
}

export const PERIOD_LABEL: Record<LeaderboardPeriod, string> = { today: 'Today', week: 'This week', all: 'All time' };
