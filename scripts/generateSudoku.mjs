// One-time generator for the offline Sudoku puzzle bank shipped with the app
// (src/data/sudokuPuzzles.json). Run with: node scripts/generateSudoku.mjs
//
// Not imported by the app itself — this is a build-time tool, same rationale as server.ts's
// duplicated date math: the output (a static JSON file) is what actually ships, not this script.
// Only the puzzle's givens are stored; the solution is re-derived client-side by the same kind of
// solver (src/lib/sudoku.ts) at load time, since solving an 81-cell Sudoku is fast and this halves
// the bundled asset size.

import { writeFileSync } from 'fs';

const SIZE = 9;
const CELLS = 81;

function emptyBoard() {
  return new Array(CELLS).fill(0);
}

const PEERS = buildPeers();

function buildPeers() {
  const peers = [];
  for (let i = 0; i < CELLS; i++) {
    const row = Math.floor(i / 9);
    const col = i % 9;
    const boxRow = Math.floor(row / 3) * 3;
    const boxCol = Math.floor(col / 3) * 3;
    const set = new Set();
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

function candidatesMask(board, i) {
  let mask = 0b1111111110; // bits 1-9 set, bit 0 unused
  for (const p of PEERS[i]) {
    if (board[p] !== 0) mask &= ~(1 << board[p]);
  }
  return mask;
}

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// Randomized backtracking fill of a complete, valid grid using MRV (fewest-candidates-first) —
// far faster than naive row-major filling and avoids the "just shuffle digits/rows" approach,
// which produces visibly-correlated grids across a large batch.
function fillGrid(board) {
  let bestIdx = -1;
  let bestMask = 0;
  let bestCount = 10;
  for (let i = 0; i < CELLS; i++) {
    if (board[i] !== 0) continue;
    const mask = candidatesMask(board, i);
    const count = popcount(mask);
    if (count === 0) return false;
    if (count < bestCount) {
      bestCount = count;
      bestMask = mask;
      bestIdx = i;
      if (count === 1) break;
    }
  }
  if (bestIdx === -1) return true; // no empty cells left — solved

  const digits = [];
  for (let d = 1; d <= 9; d++) if (bestMask & (1 << d)) digits.push(d);
  shuffle(digits);

  for (const d of digits) {
    board[bestIdx] = d;
    if (fillGrid(board)) return true;
    board[bestIdx] = 0;
  }
  return false;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Counts solutions up to `limit` (default 2) with early exit — used only to check "exactly one
// solution", never to actually enumerate every solution, so this stays fast even on a puzzle
// with many valid completions.
function countSolutions(board, limit = 2) {
  let count = 0;

  function solve(b) {
    if (count >= limit) return;
    let bestIdx = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (b[i] !== 0) continue;
      const mask = candidatesMask(b, i);
      const c = popcount(mask);
      if (c === 0) return; // dead end
      if (c < bestCount) {
        bestCount = c;
        bestMask = mask;
        bestIdx = i;
        if (c === 1) break;
      }
    }
    if (bestIdx === -1) {
      count++;
      return;
    }
    for (let d = 1; d <= 9; d++) {
      if (!(bestMask & (1 << d))) continue;
      b[bestIdx] = d;
      solve(b);
      b[bestIdx] = 0;
      if (count >= limit) return;
    }
  }

  solve(board.slice());
  return count;
}

// Digs a puzzle out of a completed grid: removes cells in random order, keeping each removal
// only if the puzzle still has a unique solution, until reaching the target clue count for the
// given difficulty band (or running out of safely-removable cells, whichever comes first).
function digPuzzle(solved, minClues, maxClues) {
  const board = solved.slice();
  const order = Array.from({ length: CELLS }, (_, i) => i);
  shuffle(order);
  const targetClues = minClues + Math.floor(Math.random() * (maxClues - minClues + 1));
  let clues = CELLS;

  for (const idx of order) {
    if (clues <= targetClues) break;
    if (board[idx] === 0) continue;
    const backup = board[idx];
    board[idx] = 0;
    if (countSolutions(board, 2) === 1) {
      clues--;
    } else {
      board[idx] = backup;
    }
  }
  return { puzzle: board, clues };
}

function boardToString(board) {
  return board.join('');
}

const DIFFICULTIES = [
  { id: 'easy', minClues: 38, maxClues: 45 },
  { id: 'medium', minClues: 30, maxClues: 36 },
  { id: 'hard', minClues: 24, maxClues: 29 },
];

const PER_DIFFICULTY = Number(process.argv[2]) || 1000;

const startedAt = Date.now();
const bank = { easy: [], medium: [], hard: [] };
const seenPuzzles = new Set();

for (const { id, minClues, maxClues } of DIFFICULTIES) {
  let generated = 0;
  let attempts = 0;
  while (generated < PER_DIFFICULTY) {
    attempts++;
    const solved = emptyBoard();
    fillGrid(solved);
    const { puzzle, clues } = digPuzzle(solved, minClues, maxClues);
    const key = boardToString(puzzle);
    if (clues > maxClues || seenPuzzles.has(key)) continue; // dig fell short of the band, or a dupe — skip
    seenPuzzles.add(key);
    bank[id].push(key);
    generated++;
    if (generated % 100 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`${id}: ${generated}/${PER_DIFFICULTY} (${attempts} attempts, ${elapsed}s elapsed)`);
    }
  }
  console.log(`Finished ${id}: ${generated} puzzles in ${attempts} attempts.`);
}

const outPath = new URL('../src/data/sudokuPuzzles.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(bank));
console.log(`Wrote ${bank.easy.length + bank.medium.length + bank.hard.length} puzzles to ${outPath.pathname}`);
console.log(`Total time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
