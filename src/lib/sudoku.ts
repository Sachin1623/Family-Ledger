// Sudoku game engine: solver (for hints/validation), the bundled offline puzzle bank, local
// progress/resume state, and scoring + a pending-sync queue for offline play. Everything here
// runs entirely on-device — no network needed to play a single puzzle end to end; only posting a
// finished score to the leaderboard needs connectivity, and that's queued and retried (see
// flushPendingSudokuScores) rather than blocking the game itself.
import puzzleBank from '../data/sudokuPuzzles.json';

export type Difficulty = 'easy' | 'medium' | 'hard';
export type Board = number[]; // 81 cells, 0 = empty
export type NotesMap = Record<number, number[]>; // cell index -> pencil-marked candidates

const CELLS = 81;
const PEERS = buildPeers();

function buildPeers(): number[][] {
  const peers: number[][] = [];
  for (let i = 0; i < CELLS; i++) {
    const row = Math.floor(i / 9);
    const col = i % 9;
    const boxRow = Math.floor(row / 3) * 3;
    const boxCol = Math.floor(col / 3) * 3;
    const set = new Set<number>();
    for (let c = 0; c < 9; c++) set.add(row * 9 + c);
    for (let r = 0; r < 9; r++) set.add(r * 9 + col);
    for (let r = boxRow; r < boxRow + 3; r++) {
      for (let c = boxCol; c < boxCol + 3; c++) set.add(r * 9 + c);
    }
    set.delete(i);
    peers.push([...set]);
  }
  return peers;
}

export function peersOf(index: number): number[] {
  return PEERS[index];
}

export function parseBoard(s: string): Board {
  return s.split('').map((c) => Number(c));
}

function candidatesMaskFor(board: Board, i: number): number {
  let mask = 0b1111111110;
  for (const p of PEERS[i]) {
    if (board[p] !== 0) mask &= ~(1 << board[p]);
  }
  return mask;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// Returns the candidate digits (1-9) still valid for an empty cell given the current board.
export function candidatesFor(board: Board, index: number): number[] {
  if (board[index] !== 0) return [];
  const mask = candidatesMaskFor(board, index);
  const out: number[] = [];
  for (let d = 1; d <= 9; d++) if (mask & (1 << d)) out.push(d);
  return out;
}

// Indices (within the same row/col/box) that already hold `value` — used to highlight a conflict
// the instant the player creates one, rather than only catching it at submit time.
export function conflictsFor(board: Board, index: number, value: number): number[] {
  if (!value) return [];
  return PEERS[index].filter((p) => board[p] === value);
}

// Solves via the same MRV-backtracking approach as the generator — fast enough (a few ms even for
// the hardest bundled puzzles) to call on demand for hints/reveal rather than pre-computing and
// storing every solution in the bundle.
export function solve(board: Board): Board | null {
  const b = board.slice();

  function step(): boolean {
    let bestIdx = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (b[i] !== 0) continue;
      const mask = candidatesMaskFor(b, i);
      const count = popcount(mask);
      if (count === 0) return false;
      if (count < bestCount) {
        bestCount = count;
        bestMask = mask;
        bestIdx = i;
        if (count === 1) break;
      }
    }
    if (bestIdx === -1) return true;
    for (let d = 1; d <= 9; d++) {
      if (!(bestMask & (1 << d))) continue;
      b[bestIdx] = d;
      if (step()) return true;
      b[bestIdx] = 0;
    }
    return false;
  }

  return step() ? b : null;
}

export function isComplete(board: Board): boolean {
  return board.every((v) => v !== 0);
}

// True only if every filled cell matches its peers with no duplicates — used for the final
// "did you actually solve it correctly" check (a full board with no empty cells could still be
// wrong if the player forced an invalid value in past a conflict warning).
export function isValidSolved(board: Board): boolean {
  if (!isComplete(board)) return false;
  for (let i = 0; i < CELLS; i++) {
    if (conflictsFor(board, i, board[i]).length > 0) return false;
  }
  return true;
}

// --- Puzzle bank ---

type PuzzleBank = Record<Difficulty, string[]>;
const BANK = puzzleBank as PuzzleBank;

export function bankSize(difficulty: Difficulty): number {
  return BANK[difficulty].length;
}

export function getPuzzleGivens(difficulty: Difficulty, index: number): Board {
  const key = BANK[difficulty][index % BANK[difficulty].length];
  return parseBoard(key);
}

// --- Local progress: which puzzles have been played, cycling through a shuffled order per
// difficulty so the same 1500 puzzles don't repeat in the same sequence every time they're
// exhausted, without needing any network round trip to pick "what's next". ---

interface ProgressState {
  order: Record<Difficulty, number[]>;
  cursor: Record<Difficulty, number>;
  completedCount: Record<Difficulty, number>;
}

const PROGRESS_KEY = 'fl_sudoku_progress';

function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function defaultProgress(): ProgressState {
  return {
    order: { easy: shuffledIndices(bankSize('easy')), medium: shuffledIndices(bankSize('medium')), hard: shuffledIndices(bankSize('hard')) },
    cursor: { easy: 0, medium: 0, hard: 0 },
    completedCount: { easy: 0, medium: 0, hard: 0 },
  };
}

function readProgress(): ProgressState {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw);
    // Guard against a bank-size change (e.g. a future re-generation) leaving a stale order array.
    for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
      if (!parsed.order?.[d] || parsed.order[d].length !== bankSize(d)) return defaultProgress();
    }
    return parsed;
  } catch {
    return defaultProgress();
  }
}

function writeProgress(state: ProgressState) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(state));
}

// The next puzzle's bank index for a difficulty, without yet committing to playing it (used to
// preview/start a game). Cycles back to a freshly-reshuffled order once exhausted.
export function nextPuzzleIndex(difficulty: Difficulty): number {
  const state = readProgress();
  if (state.cursor[difficulty] >= state.order[difficulty].length) {
    state.order[difficulty] = shuffledIndices(bankSize(difficulty));
    state.cursor[difficulty] = 0;
    writeProgress(state);
  }
  return state.order[difficulty][state.cursor[difficulty]];
}

export function advancePuzzleCursor(difficulty: Difficulty) {
  const state = readProgress();
  state.cursor[difficulty] = (state.cursor[difficulty] || 0) + 1;
  state.completedCount[difficulty] = (state.completedCount[difficulty] || 0) + 1;
  writeProgress(state);
}

export function getCompletedCount(difficulty: Difficulty): number {
  return readProgress().completedCount[difficulty] || 0;
}

// --- Active game state: persisted on every move so the app can be killed mid-puzzle (offline or
// not) and resume exactly where it left off, matching the "playable fully offline" requirement. ---

export interface ActiveGame {
  difficulty: Difficulty;
  puzzleIndex: number;
  givens: Board;
  board: Board;
  notes: NotesMap;
  mistakes: number;
  hintsUsed: number;
  elapsedSeconds: number;
  startedAt: string;
}

// Keyed per difficulty (not a single global slot) so an easy, medium, and hard game can each be
// in progress at once, independently resumable — starting/resuming one never discards another.
function activeGameKey(difficulty: Difficulty): string {
  return `fl_sudoku_active_game_${difficulty}`;
}

export function saveActiveGame(game: ActiveGame) {
  localStorage.setItem(activeGameKey(game.difficulty), JSON.stringify(game));
}

export function loadActiveGame(difficulty: Difficulty): ActiveGame | null {
  try {
    const raw = localStorage.getItem(activeGameKey(difficulty));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearActiveGame(difficulty: Difficulty) {
  localStorage.removeItem(activeGameKey(difficulty));
}

export function startNewGame(difficulty: Difficulty): ActiveGame {
  const puzzleIndex = nextPuzzleIndex(difficulty);
  const givens = getPuzzleGivens(difficulty, puzzleIndex);
  const game: ActiveGame = {
    difficulty,
    puzzleIndex,
    givens,
    board: givens.slice(),
    notes: {},
    mistakes: 0,
    hintsUsed: 0,
    elapsedSeconds: 0,
    startedAt: new Date().toISOString(),
  };
  saveActiveGame(game);
  return game;
}

// --- Scoring ---
// Base score per difficulty, minus a time penalty (capped so a very long session can't go
// negative) and a flat penalty per mistake and per hint used. Floors at a small positive number
// so finishing — however messily — always counts for something on the leaderboard.
const BASE_SCORE: Record<Difficulty, number> = { easy: 1000, medium: 2000, hard: 3500 };
const TIME_PENALTY_PER_MIN = 8;
const MISTAKE_PENALTY = 40;
const HINT_PENALTY = 60;

export function computeScore(params: { difficulty: Difficulty; elapsedSeconds: number; mistakes: number; hintsUsed: number }): number {
  const { difficulty, elapsedSeconds, mistakes, hintsUsed } = params;
  const timePenalty = Math.floor(elapsedSeconds / 60) * TIME_PENALTY_PER_MIN;
  const raw = BASE_SCORE[difficulty] - timePenalty - mistakes * MISTAKE_PENALTY - hintsUsed * HINT_PENALTY;
  return Math.max(100, raw);
}

// --- Pending score sync queue (offline-first) ---

export interface SudokuScoreRecord {
  id: string;
  difficulty: Difficulty;
  score: number;
  elapsedSeconds: number;
  mistakes: number;
  hintsUsed: number;
  completedAt: string;
}

const PENDING_SCORES_KEY = 'fl_sudoku_pending_scores';

export function queuePendingScore(record: SudokuScoreRecord) {
  const pending = readPendingScores();
  pending.push(record);
  localStorage.setItem(PENDING_SCORES_KEY, JSON.stringify(pending));
}

export function readPendingScores(): SudokuScoreRecord[] {
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

// --- Local best-score cache (instant display without waiting on a leaderboard round trip) ---

export interface BestScores {
  easy: { bestScore: number; gamesPlayed: number };
  medium: { bestScore: number; gamesPlayed: number };
  hard: { bestScore: number; gamesPlayed: number };
}

const BEST_SCORES_KEY = 'fl_sudoku_best';

export function readBestScores(): BestScores {
  try {
    const raw = localStorage.getItem(BEST_SCORES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to default
  }
  return {
    easy: { bestScore: 0, gamesPlayed: 0 },
    medium: { bestScore: 0, gamesPlayed: 0 },
    hard: { bestScore: 0, gamesPlayed: 0 },
  };
}

export function recordLocalScore(difficulty: Difficulty, score: number) {
  const best = readBestScores();
  best[difficulty].gamesPlayed += 1;
  if (score > best[difficulty].bestScore) best[difficulty].bestScore = score;
  localStorage.setItem(BEST_SCORES_KEY, JSON.stringify(best));
}
