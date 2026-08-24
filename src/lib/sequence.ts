// Sequence — the classic "cards + chips on a 10x10 board" game, for 2, 3, or 4 players (4 players
// are fixed partnerships, team = seatIndex % 2, same convention as Sweep). Two standard 52-card
// decks provide the draw pile; the board is its own ORIGINAL 10x10 layout (not a reproduction of
// Jax Ltd's commercial board — see the generation note on BOARD_LAYOUT below), where each of the
// 48 non-jack cards appears exactly twice and the four corners are wild "FREE" spaces anyone's
// sequence can run through.
//
// Hidden-information integrity (nobody, including this client, may ever see another player's
// hand, or what's left in the draw pile) means this game — like Rummy/Sweep — can't use this
// app's "client computes the move, Firestore rules just gate who can write" pattern. All actions
// that touch hidden state go through server.ts endpoints backed by the Admin SDK; this client
// only ever sees its OWN hand (a private Firestore subcollection doc it's the sole reader of) and
// the public game doc (which includes the fully-public board).
//
// The validation logic below is a client-side MIRROR for instant UI feedback — it is NOT
// authoritative. server.ts holds its own duplicate copy (this project's established convention).

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];
export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_RED: Record<Suit, boolean> = { S: false, H: true, D: true, C: false };

export interface ParsedCard {
  id: string;
  rank: Rank;
  suit: Suit;
}

export function parseCard(id: string): ParsedCard {
  const suit = id.slice(-1) as Suit;
  const rank = id.slice(0, -1) as Rank;
  return { id, rank, suit };
}

// Two-eyed jacks (clubs, diamonds) are wild — place a chip on ANY open, non-corner space.
// One-eyed jacks (hearts, spades) remove one opponent chip from the board (never one that's
// already part of a completed, locked sequence).
export const TWO_EYED_JACKS = ['JC', 'JD'];
export const ONE_EYED_JACKS = ['JH', 'JS'];
export const isTwoEyedJack = (id: string) => TWO_EYED_JACKS.includes(id);
export const isOneEyedJack = (id: string) => ONE_EYED_JACKS.includes(id);
export const isJack = (id: string) => id.startsWith('J');

export function buildTwoDeckShoe(): string[] {
  const deck: string[] = [];
  for (let d = 0; d < 2; d++) {
    for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  }
  return deck; // 104 cards
}

// Cards are sorted for display purposes only — pure hand-arrangement convenience, not part of any
// validated game state.
export function sortHandForDisplay(cardIds: string[]): string[] {
  return [...cardIds].sort((a, b) => {
    const pa = parseCard(a);
    const pb = parseCard(b);
    if (pa.suit !== pb.suit) return SUITS.indexOf(pa.suit) - SUITS.indexOf(pb.suit);
    return RANKS.indexOf(pa.rank) - RANKS.indexOf(pb.rank);
  });
}

// A fixed, ORIGINAL 10x10 layout — generated once with a seeded shuffle (not copied from any
// commercial Sequence board) so every match uses the exact same board, the way a real printed
// board never changes; only the deck's draw order is randomized per game. Row-major, index
// row*10+col. 'FREE' marks the four wild corners (0, 9, 90, 99) that count as anyone's chip when
// forming a sequence. Every other non-jack card (48 of them: A,2-10,Q,K x 4 suits) appears in
// exactly 2 of the remaining 96 cells, matching the two decks in play.
export const BOARD_LAYOUT: string[] = [
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

export const CORNER_INDICES = [0, 9, 90, 99];

// Every non-jack, non-FREE card maps to the 2 board cells it can be played on.
export const CARD_TO_CELLS: Record<string, number[]> = (() => {
  const map: Record<string, number[]> = {};
  BOARD_LAYOUT.forEach((c, i) => {
    if (c === 'FREE') return;
    (map[c] ||= []).push(i);
  });
  return map;
})();

// The official player counts Sequence supports, and the max hand size dealt to each player at
// that count (fewer players holding more cards each, since the same 104-card shoe is split more
// ways as the table fills up).
export type SequencePlayerCount = 2 | 3 | 4 | 6 | 8 | 9 | 10 | 12;
export const PLAYER_COUNT_OPTIONS: SequencePlayerCount[] = [2, 3, 4, 6, 8, 9, 10, 12];
export const HAND_SIZE: Record<SequencePlayerCount, number> = {
  2: 7, 3: 6, 4: 6, 6: 5, 8: 4, 9: 4, 10: 3, 12: 3,
};

// 2 or 3 players play every seat for itself; every other supported count is fixed partnerships —
// pairs of 2 for 4/6/8/10/12 (seat 0 partners seat 2, 1 partners 3, etc. — teammates never end up
// seated next to each other, same convention as Sweep), or 3 teams of 3 for 9. Chip color on the
// board is keyed by "side", not raw seatIndex, so teammates' chips render identically and count
// toward the same sequences. (9 could also be read as "9 individual sides," but every other
// supported count above 3 is team play, so 9 follows that pattern too, as 3 teams of 3 — the one
// genuine judgment call in this table, since official Sequence rules allow either.)
export function sideCount(playerCount: SequencePlayerCount): number {
  if (playerCount === 3) return 3;
  if (playerCount === 9) return 3;
  return 2;
}
export function sideForSeat(seatIndex: number, playerCount: SequencePlayerCount): number {
  return seatIndex % sideCount(playerCount);
}
// 2 sides (whether 1v1 or team play) race to 2 sequences; a 3-way split only needs 1, since three
// sides in play makes even a single sequence a meaningfully harder race.
export function sequencesToWin(playerCount: SequencePlayerCount): number {
  return sideCount(playerCount) === 3 ? 1 : 2;
}
// How many seats share each side — purely for lobby copy ("2 teams of 3"), not used in any
// gameplay logic.
export function seatsPerSide(playerCount: SequencePlayerCount): number {
  return playerCount / sideCount(playerCount);
}

// Shared plain-English summary of a player count's team structure and win condition — used by
// both the lobby (choosing a count) and the game screen (waiting room / win banner).
export function playerCountDescription(n: SequencePlayerCount): string {
  const sides = sideCount(n);
  const need = sequencesToWin(n);
  if (sides === n) return `Every player for themselves — first to ${need} sequence${need > 1 ? 's' : ''} wins.`;
  return `${sides} teams of ${seatsPerSide(n)} — first to ${need} sequence${need > 1 ? 's' : ''} wins.`;
}

// Deliberately avoids red and black — those are the two card-suit text colors, and a chip's own
// card label is drawn ON TOP of it (see SequenceGame.tsx's board cell rendering), so a red or
// black chip would make a same-colored rank/suit label unreadable.
export const SIDE_COLOR = ['#2563EB', '#16A34A', '#D97706']; // blue, green, amber
export const SIDE_LABEL = ['Blue', 'Green', 'Amber'];

export function cellEligibleForSide(board: (number | null)[], idx: number, side: number): boolean {
  return CORNER_INDICES.includes(idx) || board[idx] === side;
}

const DIRECTIONS: [number, number][] = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal down-right
  [1, -1], // diagonal down-left
];

function windowKey(cells: number[]): string {
  return [...cells].sort((a, b) => a - b).join(',');
}

// Finds every NEW 5-in-a-row window formed by the chip just placed at `placedIdx`, across all 4
// directions. A window only counts as "new" if it shares at most 1 cell with `lockedCells` PLUS
// whatever this same call has already accepted — a deliberate, documented approximation of the
// official "one chip may count toward two sequences, but a full second identical run doesn't"
// rule: it correctly allows two genuinely different sequences crossing through the placed chip
// (e.g. one horizontal + one vertical, sharing only that 1 cell) while correctly capping a single
// 6-in-a-row from being double-counted as two heavily-overlapping sequences in one move.
export function findNewSequences(board: (number | null)[], lockedCells: Set<number>, placedIdx: number, side: number): number[][] {
  const row = Math.floor(placedIdx / 10);
  const col = placedIdx % 10;
  const candidates: number[][] = [];

  for (const [dr, dc] of DIRECTIONS) {
    let minK = 0;
    while (true) {
      const r = row + dr * (minK - 1);
      const c = col + dc * (minK - 1);
      if (r < 0 || r > 9 || c < 0 || c > 9) break;
      const idx = r * 10 + c;
      if (!cellEligibleForSide(board, idx, side)) break;
      minK--;
    }
    let maxK = 0;
    while (true) {
      const r = row + dr * (maxK + 1);
      const c = col + dc * (maxK + 1);
      if (r < 0 || r > 9 || c < 0 || c > 9) break;
      const idx = r * 10 + c;
      if (!cellEligibleForSide(board, idx, side)) break;
      maxK++;
    }
    for (let start = minK; start + 4 <= maxK; start++) {
      if (!(start <= 0 && start + 4 >= 0)) continue; // window must include the placed cell (k=0)
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
    const key = windowKey(window);
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

export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export interface SequencePlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: number;
  handCount: number;
}

export type SequenceStatus = 'waiting' | 'active' | 'finished';

export interface SequenceGame {
  hostUid: string;
  code: string;
  status: SequenceStatus;
  playerCount: SequencePlayerCount;
  players: SequencePlayer[];
  playerUids: string[];
  currentTurnSeatIndex: number;
  board: (number | null)[]; // length 100, side index or null
  lockedCells: number[]; // cells that are part of a completed sequence (immune to removal)
  sequences?: { cells: number[]; side: number }[]; // each completed sequence's own 5 cells + side, for drawing a per-sequence outline (lockedCells alone is just the flat union, not enough to know which 5 belong together)
  lastPlacedCell?: number | null; // the most recent 'place' action's cell, for a brief highlight — untouched by 'remove'/'dead' actions
  sequenceCountBySide: number[];
  winnerSide: number | null;
  cardsRemaining: number;
  lastAction?: { text: string; at: string } | null;
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  rematchGameId?: string | null;
}
