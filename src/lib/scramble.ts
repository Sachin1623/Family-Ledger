// Scramble game engine: bundled offline dictionary (see scripts/generateScrambleWords.cjs — an
// English word list filtered to lengths 4-10 and stripped of profanity), round/tile generation,
// answer validation, scoring, and local persistence + a pending-sync queue for offline play.
// Everything here runs entirely on-device — no network needed to play a match end to end; only
// posting a finished score to the leaderboard needs connectivity (see scrambleSync.ts).
//
// Interpretive calls made building this (spec left them ambiguous):
// - "Any dictionary-approved word that uses only the displayed letters is valid" is read as an
//   OPEN anagram: any dictionary word (>= the bundled dictionary's 4-letter floor) whose letters
//   are a sub-multiset of the round's tiles counts, not just the one word the tiles were generated
//   from. The generating word ("targetWord") is kept only for hints and match-wide dedup.
// - The per-word timer is a soft, on-screen-only countdown (no server/local enforcement of a
//   per-round cutoff) — the match's real cutoff is the single overall timer mode picked at start.
// - "Duplicate answer, once per round" is enforced match-wide (not just within one round's tile
//   set), since a short common word can legally solve multiple different rounds' letter sets —
//   without a match-wide guard a player could farm the same easy word every round.
import wordBank from '../data/scrambleWords.json';
import targetWordBank from '../data/scrambleTargetWords.json';

export type ScrambleWordLength = 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type ScrambleTimerMode = '3min' | '5min' | '10min';

export const WORD_LENGTHS: ScrambleWordLength[] = [4, 5, 6, 7, 8, 9, 10];
export const TIMER_MODES: ScrambleTimerMode[] = ['3min', '5min', '10min'];
export const TIMER_MODE_SECONDS: Record<ScrambleTimerMode, number> = { '3min': 180, '5min': 300, '10min': 600 };
export const TIMER_MODE_LABEL: Record<ScrambleTimerMode, string> = { '3min': '3 min', '5min': '5 min', '10min': '10 min' };

// Bump this if the bundled word list is ever regenerated with different filtering/source data —
// stored on every score record per the "lock the dictionary version" fairness rule.
export const SCRAMBLE_DICTIONARY_VERSION = 'aoew2.0.0+mcwbl3.0.14-filtered-v4';

type WordBank = Record<string, string[]>;
const BANK = wordBank as WordBank;
const ALL_WORDS = new Set<string>(Object.values(BANK).flat());
// A round's TARGET word (the one scrambled into tiles) is picked from this much smaller,
// frequency-curated pool — not the full validation dictionary above, which is broad on purpose
// so an unusual-but-real answer someone actually finds isn't rejected, but is a bad source for
// what to make someone SOLVE (too many obscure/archaic words). Every entry here is guaranteed (by
// scripts/generateScrambleWords.cjs's generation step) to also be a member of ALL_WORDS, so a
// picked target is always itself a valid, acceptable answer.
const TARGET_BANK = targetWordBank as WordBank;

export const BASE_POINTS = 10;
export const HINT_PENALTY = 3;
export const MAX_HINTS_PER_MATCH = 5;

function shuffleLetters(word: string): string[] {
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

function pickTargetWord(length: ScrambleWordLength, exclude: Set<string>): string {
  const pool = TARGET_BANK[String(length)] || [];
  for (let tries = 0; tries < 50; tries++) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!exclude.has(w)) return w;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// A submitted guess is valid if it's in the dictionary and every letter it uses is available
// among the round's tiles (each tile usable at most once).
export function isValidAnswer(guess: string, tiles: string[]): boolean {
  const g = guess.trim().toLowerCase();
  if (g.length > tiles.length) return false;
  if (!ALL_WORDS.has(g)) return false;
  const avail = tiles.slice();
  for (const ch of g) {
    const idx = avail.indexOf(ch);
    if (idx === -1) return false;
    avail.splice(idx, 1);
  }
  return true;
}

// --- Cross-match word history — keeps a rolling window of the last ~30 matches' worth of words
// (per word length, since each length draws from its own separate target pool) so the same word
// doesn't resurface across matches either, not just within one. Games are stored individually
// (rather than as one flat word list) so trimming to "last N games" is exact regardless of how
// many words any one match happened to use. Some lengths' target pools (as few as ~560 words at
// length 10) could still be smaller than 30 games' worth of usage in a heavy session —
// pickTargetWord already degrades gracefully (falls back to picking anything once nothing unused
// is left) rather than failing, so exhausting the pool just means repeats become possible again,
// not a crash.
const WORD_HISTORY_KEY = 'fl_scramble_word_history';
const WORD_HISTORY_GAMES = 30;

type WordHistoryState = Record<string, string[][]>;

function readWordHistory(): WordHistoryState {
  try {
    const raw = localStorage.getItem(WORD_HISTORY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function historyExcludeSet(length: ScrambleWordLength): Set<string> {
  const games = readWordHistory()[String(length)] || [];
  const set = new Set<string>();
  for (const words of games) for (const w of words) set.add(w);
  return set;
}

function recordGameHistory(length: ScrambleWordLength, words: string[]) {
  if (words.length === 0) return;
  const history = readWordHistory();
  const key = String(length);
  const games = history[key] || [];
  games.push(words);
  while (games.length > WORD_HISTORY_GAMES) games.shift();
  history[key] = games;
  localStorage.setItem(WORD_HISTORY_KEY, JSON.stringify(history));
}

export interface ScrambleRound {
  index: number;
  targetWord: string;
  tiles: string[];
}

function generateRound(index: number, length: ScrambleWordLength, exclude: Set<string>): ScrambleRound {
  const targetWord = pickTargetWord(length, exclude);
  return { index, targetWord, tiles: shuffleLetters(targetWord) };
}

export interface ScrambleActiveGame {
  wordLength: ScrambleWordLength;
  timerMode: ScrambleTimerMode;
  startedAt: string;
  endsAt: string;
  currentRound: ScrambleRound;
  roundIndex: number;
  solvedAnswers: string[];
  usedTargets: string[];
  score: number;
  hintsUsed: number;
  hintRevealLength: number;
}

const ACTIVE_KEY = 'fl_scramble_active_game';

export function saveActiveGame(game: ScrambleActiveGame) {
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(game));
}

export function loadActiveGame(): ScrambleActiveGame | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearActiveGame() {
  localStorage.removeItem(ACTIVE_KEY);
}

export function startNewGame(wordLength: ScrambleWordLength, timerMode: ScrambleTimerMode): ScrambleActiveGame {
  const now = Date.now();
  const round = generateRound(0, wordLength, historyExcludeSet(wordLength));
  const game: ScrambleActiveGame = {
    wordLength,
    timerMode,
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + TIMER_MODE_SECONDS[timerMode] * 1000).toISOString(),
    currentRound: round,
    roundIndex: 0,
    solvedAnswers: [],
    usedTargets: [round.targetWord],
    score: 0,
    hintsUsed: 0,
    hintRevealLength: 0,
  };
  saveActiveGame(game);
  return game;
}

export function isMatchOver(game: ScrambleActiveGame): boolean {
  return Date.now() >= new Date(game.endsAt).getTime();
}

export function secondsRemaining(game: ScrambleActiveGame): number {
  return Math.max(0, Math.round((new Date(game.endsAt).getTime() - Date.now()) / 1000));
}

export type SubmitResult =
  | { status: 'correct'; pointsAwarded: number; game: ScrambleActiveGame }
  | { status: 'already-used' }
  | { status: 'invalid' };

export function submitAnswer(game: ScrambleActiveGame, guessRaw: string): SubmitResult {
  const guess = guessRaw.trim().toLowerCase();
  if (!isValidAnswer(guess, game.currentRound.tiles)) return { status: 'invalid' };
  if (game.solvedAnswers.includes(guess)) return { status: 'already-used' };

  // The solved word must be excluded from ever becoming a FUTURE round's target too, even though
  // it may differ from THIS round's own generated target (open-anagram mode lets any valid word
  // solve a round) — otherwise a word found as a bonus answer here could later get regenerated as
  // some other round's actual target, where it'd then be blocked as "already used" with no way to
  // solve that round at all.
  const exclude = new Set(game.usedTargets);
  exclude.add(guess);
  for (const w of historyExcludeSet(game.wordLength)) exclude.add(w);
  const nextRound = generateRound(game.roundIndex + 1, game.wordLength, exclude);
  const nextGame: ScrambleActiveGame = {
    ...game,
    currentRound: nextRound,
    roundIndex: game.roundIndex + 1,
    solvedAnswers: [...game.solvedAnswers, guess],
    usedTargets: [...game.usedTargets, guess, nextRound.targetWord],
    score: game.score + BASE_POINTS,
    hintRevealLength: 0,
  };
  saveActiveGame(nextGame);
  return { status: 'correct', pointsAwarded: BASE_POINTS, game: nextGame };
}

// Hints reveal the generating target word's next letter, in order, as a prefix clue (e.g. "G_ _ _
// _ _") — a nudge rather than a giveaway, since another valid word sharing that prefix might still
// be found first. Capped per match, not per round.
export function useHint(game: ScrambleActiveGame): { game: ScrambleActiveGame; letter: string | null } {
  if (game.hintsUsed >= MAX_HINTS_PER_MATCH) return { game, letter: null };
  if (game.hintRevealLength >= game.currentRound.targetWord.length) return { game, letter: null };
  const letter = game.currentRound.targetWord[game.hintRevealLength];
  const nextGame: ScrambleActiveGame = {
    ...game,
    hintsUsed: game.hintsUsed + 1,
    hintRevealLength: game.hintRevealLength + 1,
    score: Math.max(0, game.score - HINT_PENALTY),
  };
  saveActiveGame(nextGame);
  return { game: nextGame, letter };
}

export const SHUFFLE_PENALTY = 1;

// Re-shuffling which unplaced tiles look like which is purely a client-side rendering choice (the
// round's tile set itself doesn't change) — this just applies the point penalty and persists it.
export function useShuffle(game: ScrambleActiveGame): ScrambleActiveGame {
  const nextGame: ScrambleActiveGame = { ...game, score: Math.max(0, game.score - SHUFFLE_PENALTY) };
  saveActiveGame(nextGame);
  return nextGame;
}

export const PASS_PENALTY = 5;

// Gives up on the current word — moves straight to a fresh scramble without counting as solved
// (doesn't touch solvedAnswers, so the "words solved" stat only ever reflects genuine solves).
export function passWord(game: ScrambleActiveGame): ScrambleActiveGame {
  const exclude = new Set(game.usedTargets);
  for (const w of historyExcludeSet(game.wordLength)) exclude.add(w);
  const nextRound = generateRound(game.roundIndex + 1, game.wordLength, exclude);
  const nextGame: ScrambleActiveGame = {
    ...game,
    currentRound: nextRound,
    roundIndex: game.roundIndex + 1,
    usedTargets: [...game.usedTargets, nextRound.targetWord],
    score: Math.max(0, game.score - PASS_PENALTY),
    hintRevealLength: 0,
  };
  saveActiveGame(nextGame);
  return nextGame;
}

// --- Pending score sync queue (offline-first) ---

export interface ScrambleScoreRecord {
  id: string;
  wordLength: ScrambleWordLength;
  timerMode: ScrambleTimerMode;
  score: number;
  wordsSolved: number;
  hintsUsed: number;
  dictionaryVersion: string;
  completedAt: string;
}

const PENDING_SCORES_KEY = 'fl_scramble_pending_scores';

export function queuePendingScore(record: ScrambleScoreRecord) {
  const pending = readPendingScores();
  pending.push(record);
  localStorage.setItem(PENDING_SCORES_KEY, JSON.stringify(pending));
}

export function readPendingScores(): ScrambleScoreRecord[] {
  try {
    const raw = localStorage.getItem(PENDING_SCORES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function removePendingScore(id: string) {
  const pending = readPendingScores().filter((r) => r.id !== id);
  localStorage.setItem(PENDING_SCORES_KEY, JSON.stringify(pending));
}

// --- Local best-score cache, separated by word length + timer mode per the fairness rule that
// leaderboards/bests must never mix different puzzle shapes together. ---

export interface ScrambleBestEntry {
  bestScore: number;
  gamesPlayed: number;
}

const BEST_SCORES_KEY = 'fl_scramble_best';

function bestKey(wordLength: ScrambleWordLength, timerMode: ScrambleTimerMode): string {
  return `${wordLength}_${timerMode}`;
}

export function readBestScores(): Record<string, ScrambleBestEntry> {
  try {
    const raw = localStorage.getItem(BEST_SCORES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to default
  }
  return {};
}

export function getBest(wordLength: ScrambleWordLength, timerMode: ScrambleTimerMode): ScrambleBestEntry {
  return readBestScores()[bestKey(wordLength, timerMode)] || { bestScore: 0, gamesPlayed: 0 };
}

// Returns true if this score beat the previous personal best.
function recordLocalScore(wordLength: ScrambleWordLength, timerMode: ScrambleTimerMode, score: number): boolean {
  const all = readBestScores();
  const key = bestKey(wordLength, timerMode);
  const prev = all[key] || { bestScore: 0, gamesPlayed: 0 };
  const brokeBest = score > prev.bestScore;
  all[key] = { bestScore: brokeBest ? score : prev.bestScore, gamesPlayed: prev.gamesPlayed + 1 };
  localStorage.setItem(BEST_SCORES_KEY, JSON.stringify(all));
  return brokeBest;
}

export interface ScrambleMatchResult {
  score: number;
  wordsSolved: number;
  hintsUsed: number;
  brokeBest: boolean;
  previousBest: number;
}

// Ends the match: records the personal best, queues the score for leaderboard sync, and clears
// the active-game slot. Safe to call more than once for the same match id would be — but callers
// (ScrambleHome's expired-match check, ScrambleGame's timer-up handler) both clear the active game
// immediately after, so in practice it only ever runs once per match.
export function finalizeMatch(game: ScrambleActiveGame): ScrambleMatchResult {
  const previousBest = getBest(game.wordLength, game.timerMode).bestScore;
  const brokeBest = recordLocalScore(game.wordLength, game.timerMode, game.score);
  recordGameHistory(game.wordLength, game.usedTargets);
  queuePendingScore({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    wordLength: game.wordLength,
    timerMode: game.timerMode,
    score: game.score,
    wordsSolved: game.solvedAnswers.length,
    hintsUsed: game.hintsUsed,
    dictionaryVersion: SCRAMBLE_DICTIONARY_VERSION,
    completedAt: new Date().toISOString(),
  });
  clearActiveGame();
  return { score: game.score, wordsSolved: game.solvedAnswers.length, hintsUsed: game.hintsUsed, brokeBest, previousBest };
}
