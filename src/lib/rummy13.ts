// 13-Card Rummy — the standard/classic Indian Rummy variant, distinct from this app's own
// "27-Hand Rummy" house-rules game (src/lib/rummy.ts). Supports 2-6 players, Single Deal and Pool
// (101/201) formats.
//
// Hidden-information integrity (nobody, including this client, may ever see another player's hand
// or the undrawn stock pile) means this game — like 27-Hand Rummy and Sweep — can't use this app's
// usual "client computes the move, Firestore rules just gate who can write" pattern. All actions
// that touch hidden state go through server.ts endpoints backed by the Admin SDK; this client only
// ever sees its OWN hand and the public table/deal docs (turn state, discard pile, opponents' card
// COUNTS, never their actual cards).
//
// The validation logic here is a client-side MIRROR for instant UI feedback — it is NOT
// authoritative. server.ts holds its own copy (server.ts and the client bundle share no module
// graph, so game logic needed on both sides is deliberately duplicated, per this project's
// established convention — see rummy.ts's own header comment). This file DOES freely import the
// generic, deck-size-agnostic primitives from rummy.ts, though — that's a within-client-bundle
// reuse, not a client/server boundary crossing, and those functions (parseCard/isValidSequence/
// isValidSet/isPureSequence/etc.) already work for any card-id scheme shaped
// "{rank}{suit}_{deckIndex}" regardless of how many decks or players are involved.
//
// Printed jokers are represented as card ids using a reserved rank token 'JK' and placeholder
// suit 'X' (e.g. "JKX_0") — this lets every rummy.ts validator work completely unmodified; call
// sites just pass `withPrintedJoker(wildRanks)` as the wildcard list, so a 'JK' card is always
// wild (it only ever gets filtered into "wilds", never "naturals", so the placeholder suit never
// participates in a same-suit check).

import {
  RANKS, SUITS, SUIT_SYMBOL, SUIT_RED,
  type Rank, type Suit,
  parseCard, isWildcardRank, isPureSequence, isValidSequence, isValidSet, isValidGroup,
  sortHandForDisplay, generateGameCode,
} from './rummy';

export { RANKS, SUITS, SUIT_SYMBOL, SUIT_RED, parseCard, isWildcardRank, isPureSequence, isValidSequence, isValidSet, isValidGroup, sortHandForDisplay, generateGameCode };
export type { Rank, Suit };

export const PRINTED_JOKER_RANK = 'JK';

// `'JK'` is a runtime-only sentinel never part of the real `Rank` union — every validator only
// ever does a plain string `.includes()` check against the wildcard-ranks array, so this cast is
// safe in practice even though it's not type-accurate.
export function withPrintedJoker(wildRanks: (Rank | null)[]): Rank[] {
  return [...wildRanks.filter((r): r is Rank => !!r), PRINTED_JOKER_RANK as Rank];
}

export function isPrintedJoker(cardId: string): boolean {
  return parseCard(cardId).rank === (PRINTED_JOKER_RANK as Rank);
}

export function buildRummy13Deck(deckCount: 1 | 2): string[] {
  const deck: string[] = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) deck.push(`${rank}${suit}_${d}`);
    }
    deck.push(`${PRINTED_JOKER_RANK}X_${d}`);
  }
  return deck; // 53 or 106 cards
}

export function cardValue(cardId: string, wildcardRanks: Rank[]): number {
  const { rank } = parseCard(cardId);
  if (isWildcardRank(rank, wildcardRanks)) return 0;
  if (rank === 'A' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank) || 0;
}

export type Rummy13Format = 'single' | 'pool101' | 'pool201';
export type Rummy13TableStatus = 'waiting' | 'active' | 'finished';

export interface Rummy13Player {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: number;
  cumulativeScore: number;   // Pool formats only; always 0 for 'single'
  eliminated: boolean;       // Pool formats only; permanent for the rest of the table
  finishedRank?: number | null;
  isBot?: boolean;
}

export interface Rummy13DealSummary {
  dealNumber: number;
  endedBy: 'declare' | 'drop' | 'timeout' | 'void';
  winnerUid: string | null;
  dealScores: Record<string, number>;
  invalidDeclareUid?: string | null;
}

export interface Rummy13Table {
  hostUid: string;
  code: string;
  status: Rummy13TableStatus;
  format: Rummy13Format;
  poolLimit: number | null;
  maxPlayers: number;
  players: Rummy13Player[];
  playerUids: string[];
  currentDealId: string | null;
  dealNumber: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  winnerUid: string | null;
  lastDealSummary: Rummy13DealSummary | null;
  rematchGameId?: string | null;
  lastAction?: { type: string; byUid: string; at: string } | null;
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
}

export interface Rummy13DealPlayer {
  uid: string;
  seatIndex: number;
  handCount: number;
  dropped: boolean;
  hasActedThisDeal: boolean;
}

export type Rummy13TurnPhase = 'draw' | 'discard';
export type Rummy13DealStatus = 'active' | 'finished' | 'void';

export interface Rummy13Deal {
  tableId: string;
  playerUids: string[];
  dealNumber: number;
  players: Rummy13DealPlayer[];
  currentTurnSeatIndex: number;
  turnPhase: Rummy13TurnPhase;
  turnStartedAt: string;
  stockCount: number;
  discardPile: string[];
  wildJokerRank: Rank | null;
  wildJokerIndicatorCard: string | null;
  deckCount: 1 | 2;
  turnDrawnCard: string | null;
  turnDrawnFromDiscard: boolean;
  status: Rummy13DealStatus;
  startedAt: string;
  finishedAt: string | null;
  winnerUid: string | null;
  dealScores?: Record<string, number> | null;
  revealedHands?: Record<string, {
    cards: string[];
    groups?: { cards: string[] }[];
    declaredGroups?: { cards: string[] }[];
    discardCardId?: string;
  }>;
  lastAction?: { type: string; byUid: string; at: string } | null;
}

export const TURN_TIMEOUT_MS = 45_000;
export const TURN_WARNING_MS = 15_000;

// Client-side preview of the server's protect-tier penalty scoring — used to show a player their
// own likely penalty while organizing, and to render a revealed losing hand's breakdown post-deal.
// Bounded, exhaustive-over-small-N search (not a generic NP-hard solve) — see server.ts's
// `computeRummy13HandPenalty` for the authoritative copy and full reasoning; kept in sync by hand.
function combinations<T>(arr: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, size - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

export function computeRummy13HandPenalty(hand: string[], wildcardRanks: Rank[]): { penalty: number; protectedCardIds: string[] } {
  const pureCandidates: string[][] = [];
  for (const size of [3, 4]) {
    for (const combo of combinations(hand, size)) {
      if (isPureSequence(combo)) pureCandidates.push(combo);
    }
  }

  if (pureCandidates.length === 0) {
    const penalty = Math.min(hand.reduce((sum, c) => sum + cardValue(c, wildcardRanks), 0), 80);
    return { penalty, protectedCardIds: [] };
  }

  // Dedupe identical card-sets (order-insensitive) — a real hand has only a handful of distinct
  // pure-sequence candidates once duplicates are collapsed.
  const seen = new Set<string>();
  const dedupedCandidates = pureCandidates.filter((c) => {
    const key = [...c].sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  function bestCoverage(remaining: string[]): { value: number; cards: Set<string> } {
    if (remaining.length === 0) return { value: 0, cards: new Set() };
    const [first, ...rest] = remaining;
    let best = bestCoverage(rest); // leave `first` unprotected
    for (const size of [3, 4]) {
      if (rest.length < size - 1) continue;
      for (const combo of combinations(rest, size - 1)) {
        const groupCards = [first, ...combo];
        if (!isValidGroup(groupCards, wildcardRanks).valid) continue;
        const restOfRemaining = remaining.filter((c) => !groupCards.includes(c));
        const sub = bestCoverage(restOfRemaining);
        const groupValue = groupCards.reduce((s, c) => s + cardValue(c, wildcardRanks), 0);
        if (sub.value + groupValue > best.value) {
          best = { value: sub.value + groupValue, cards: new Set([...sub.cards, ...groupCards]) };
        }
      }
    }
    return best;
  }

  let bestPenalty = Infinity;
  let bestProtected: string[] = [];
  for (const anchor of dedupedCandidates) {
    const remaining = hand.filter((c) => !anchor.includes(c));
    const coverage = bestCoverage(remaining);
    const protectedIds = [...anchor, ...coverage.cards];
    const protectedSet = new Set(protectedIds);
    const penalty = hand.reduce((sum, c) => (protectedSet.has(c) ? sum : sum + cardValue(c, wildcardRanks)), 0);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestProtected = protectedIds;
    }
  }

  return { penalty: Math.min(bestPenalty, 80), protectedCardIds: bestProtected };
}
