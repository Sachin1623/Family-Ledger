// Sweep — a fishing/capture card game for 2 or 4 players (4-player games are fixed partnerships,
// team = seatIndex % 2, which puts seats 0&2 on one team and 1&3 on the other — teammates always
// end up opposite each other around the table, satisfying "players on the same team cannot sit
// next to each other"). One standard 52-card deck, no wildcards.
//
// Hidden-information integrity (nobody, including this client, may ever see another player's hand,
// or the bidder's brief private peek at the 4 floor cards before they're revealed) means this game
// — like 27-Hand Rummy — can't use this app's usual "client computes the move, Firestore rules just
// gate who can write" pattern. All actions that touch hidden state go through server.ts endpoints
// backed by the Admin SDK; this client only ever sees its OWN hand (a private Firestore
// subcollection doc it's the sole reader of) and the public game doc.
//
// The rules doc this was built from is precise enough that almost nothing needed interpretation —
// the handful of genuine judgment calls (how the bid's "make a house" option resolves arithmetically,
// exactly how a multi-entity capture is selected in the UI, the dealer-rotates-to-the-losing-team
// algorithm) are written up in this project's memory (`project_sweep_build`), not repeated here.
//
// The validation logic below is a client-side MIRROR for instant UI feedback — it is NOT
// authoritative. server.ts holds its own duplicate copy (this project's established convention).

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];
export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_RED: Record<Suit, boolean> = { S: false, H: true, D: true, C: false };

export const CAPTURE_VALUE: Record<Rank, number> = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};

export const HOUSE_VALUES = [9, 10, 11, 12, 13];

export interface ParsedCard {
  id: string;
  rank: Rank;
  suit: Suit;
}

export function buildDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck; // 52 cards
}

export function parseCard(id: string): ParsedCard {
  const suit = id.slice(-1) as Suit;
  const rank = id.slice(0, -1) as Rank;
  return { id, rank, suit };
}

export function captureValue(id: string): number {
  return CAPTURE_VALUE[parseCard(id).rank];
}

// Point value at end-of-deal scoring — spades score their own capture value, non-spade aces are
// worth 1, the 10 of Diamonds is worth 6, everything else (35 of the 52 cards) is worth 0. Sums to
// exactly 100 across the full deck (13 spades: 1+2+...+13=91, plus 3 non-spade aces, plus 6 for
// 10♦ = 100).
export function cardPoints(id: string): number {
  const { rank, suit } = parseCard(id);
  if (suit === 'S') return CAPTURE_VALUE[rank];
  if (rank === 'A') return 1;
  if (rank === '10' && suit === 'D') return 6;
  return 0;
}

export function sumCardValues(ids: string[]): number {
  return ids.reduce((sum, id) => sum + captureValue(id), 0);
}

export function sumPoints(ids: string[]): number {
  return ids.reduce((sum, id) => sum + cardPoints(id), 0);
}

// Firestore disallows directly-nested arrays, so each set is wrapped in a `{cards}` object rather
// than being a bare string[], and captured piles are keyed rather than a [string[], string[]] tuple.
export interface SweepSet {
  cards: string[];
}

export interface SweepHouse {
  id: string;
  value: number; // 9-13
  sets: SweepSet[]; // 1 set = weak house (can still be changed to a new number); 2+ = strong (fixed number, can only grow)
  ownerTeams: (0 | 1)[]; // co-owned if both teams have contributed
}

export interface SweepFloor {
  looseCards: string[];
  houses: SweepHouse[];
}

export interface SweepPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: number;
  team: 0 | 1;
  handCount: number;
}

export type SweepStatus = 'waiting' | 'bidding' | 'active' | 'deal_end' | 'finished';

export interface SweepDealHistoryEntry {
  dealNumber: number;
  teamPoints: [number, number];
  sweepCount: [number, number];
  winnerTeam: 0 | 1 | 'tie';
  netScoreAfter: number;
  // A snapshot of exactly which cards each team captured that deal — kept even though
  // `capturedByTeam` itself resets every deal, so past deals can still be reviewed in full.
  capturedByTeam: { team0: string[]; team1: string[] };
}

export interface SweepGame {
  hostUid: string;
  code: string;
  status: SweepStatus;
  playerCount: 2 | 4;
  sweepPoints: 25 | 50;
  players: SweepPlayer[];
  playerUids: string[];
  dealerSeatIndex: number;
  currentTurnSeatIndex: number;
  dealNumber: number;
  floor: SweepFloor;
  floorHiddenCount: number; // 4 while status === 'bidding' and not yet revealed, else 0
  bidderSeatIndex: number | null;
  bidValue: number | null;
  cardsPlayedThisDeal: number;
  lastCaptureTeam: 0 | 1 | null;
  capturedByTeam: { team0: string[]; team1: string[] };
  sweepsThisDeal: { team: 0 | 1; at: string }[];
  // Net running score for the whole match — positive favors team 0, negative favors team 1.
  // Reaching +-100 ends the game outright (no "bazzi" reset structure).
  netScore: number;
  lastDealSummary: {
    dealNumber: number;
    teamPoints: [number, number];
    sweepCount: [number, number];
    winnerTeam: 0 | 1 | 'tie' | null;
    netScoreAfter: number;
  } | null;
  // The running log of every completed deal this match, oldest first — persists across deals
  // (unlike `capturedByTeam`, which resets each deal) so the full match history can be reviewed.
  dealHistory: SweepDealHistoryEntry[];
  winnerTeam: 0 | 1 | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastAction?: { text: string; at: string } | null;
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
  rematchGameId?: string | null;
}

export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Cards are sorted for display purposes only — pure hand-arrangement convenience, not part of any
// validated game state.
export function sortHandForDisplay(cardIds: string[]): string[] {
  return [...cardIds].sort((a, b) => {
    const pa = parseCard(a);
    const pb = parseCard(b);
    if (pa.suit !== pb.suit) return SUITS.indexOf(pa.suit) - SUITS.indexOf(pb.suit);
    return CAPTURE_VALUE[pa.rank] - CAPTURE_VALUE[pb.rank];
  });
}

// Every floor entity a played card of a given value could directly capture: a lone loose card of
// that exact rank, or a house whose number matches. Client-side hinting only — the "Play card
// rule" (throw is illegal while a direct match exists) is enforced authoritatively server-side.
export function findDirectMatch(floor: SweepFloor, value: number): { house: SweepHouse } | { looseCard: string } | null {
  const house = floor.houses.find((h) => h.value === value);
  if (house) return { house };
  const loose = floor.looseCards.find((c) => captureValue(c) === value);
  if (loose) return { looseCard: loose };
  return null;
}

// Whether a played card of this value can capture ANYTHING — either directly (findDirectMatch),
// by combining two or more loose cards that together sum to it (e.g. a 9 and a 2 captured by an
// 11), or by folding in a WEAK house's current value alongside loose cards (e.g. a House·10 plus
// a loose 3, captured together by a King). Only weak houses (a single, not-yet-locked set) can be
// folded into a combined-value capture this way — a strong house (2+ sets) is explicitly locked
// to its own value and can only ever be captured by a card matching it exactly. The floor only
// ever holds a handful of loose cards/houses at once, so a brute-force subset sum is plenty fast.
// Client-side hinting only — the server enforces this authoritatively.
export function canCaptureValue(floor: SweepFloor, value: number): boolean {
  if (findDirectMatch(floor, value)) return true;
  const weakHouseValues = floor.houses.filter((h) => h.sets.length === 1).map((h) => h.value);
  const pool = [...floor.looseCards.map(captureValue), ...weakHouseValues];
  const n = pool.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += pool[i];
    if (sum === value) return true;
  }
  return false;
}
