// 27-Hand Rummy — a custom variant (NOT the traditional "27 Card Rummy" game, which uses a
// different deck/joker/scoring system entirely — this is the user's own house-rules design).
//
// Three full 52-card decks (156 cards) are combined; each of up to 4 players is dealt a 27-card
// hand. A common joker rank is revealed to everyone at deal time. A second joker rank is also
// revealed, but each player can only USE it after they've separately declared a fixed 5+4+3 pure
// -sequence meld (12 of their 27 cards) — those 12 cards are then locked aside, leaving 15 to be
// grouped (in 3s or more) for the final win declaration.
//
// Hidden-information integrity (nobody, including this client, may ever see another player's hand
// or the undrawn stock pile) means this game — unlike Ludo/Sudoku — can't use this app's usual
// "client computes the move, Firestore rules just gate who can write" pattern. All actions that
// touch hidden state (dealing, drawing, discarding, declaring) go through server.ts endpoints
// backed by the Admin SDK; this client only ever sees its OWN hand (a private Firestore
// subcollection doc it's the sole reader of) and the public game doc (turn state, discard pile,
// opponents' card COUNTS, never their actual cards).
//
// The validation logic below is a client-side MIRROR for instant UI feedback (highlighting a
// group green/red as the player arranges their hand) — it is NOT authoritative. server.ts holds
// its own copy (this project's established convention: server.ts and the client bundle don't
// share a module graph, so game logic needed on both sides is deliberately duplicated rather than
// imported) and re-validates every declaration from scratch against the real hand before accepting
// it, exactly the way it must for any hidden-information game.

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
  deckIndex: number;
}

export function buildTripleDeck(): string[] {
  const deck: string[] = [];
  for (let d = 0; d < 3; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) deck.push(`${rank}${suit}_${d}`);
    }
  }
  return deck; // 156 cards
}

export function parseCard(id: string): ParsedCard {
  const [face, deckIdx] = id.split('_');
  const suit = face.slice(-1) as Suit;
  const rank = face.slice(0, -1) as Rank;
  return { id, rank, suit, deckIndex: Number(deckIdx) };
}

function rankIndex(rank: Rank, aceHigh: boolean): number {
  if (rank === 'A') return aceHigh ? 13 : 0;
  return RANKS.indexOf(rank);
}

export function isWildcardRank(rank: Rank, wildcardRanks: Rank[]): boolean {
  return wildcardRanks.includes(rank);
}

export function isPureSequence(cardIds: string[]): boolean {
  if (cardIds.length < 3) return false;
  const parsed = cardIds.map(parseCard);
  const suit = parsed[0].suit;
  if (!parsed.every((c) => c.suit === suit)) return false;
  // Same suit AND same rank (e.g. three 7H's from three different decks) counts as pure too, not
  // just a genuine consecutive run — consistent with same-suit sets being legal here.
  if (parsed.every((c) => c.rank === parsed[0].rank)) return true;
  for (const aceHigh of [false, true]) {
    const idxs = parsed.map((c) => rankIndex(c.rank, aceHigh)).sort((a, b) => a - b);
    if (new Set(idxs).size !== idxs.length) continue;
    let ok = true;
    for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

export type GroupType = 'pure' | 'impure' | 'set';
export interface GroupCheck { valid: boolean; type?: GroupType }

export function isValidSequence(cardIds: string[], wildcardRanks: Rank[]): GroupCheck {
  if (cardIds.length < 3) return { valid: false };
  const parsed = cardIds.map(parseCard);
  const naturals = parsed.filter((c) => !isWildcardRank(c.rank, wildcardRanks));
  const wilds = parsed.filter((c) => isWildcardRank(c.rank, wildcardRanks));

  if (naturals.length === 0) return { valid: true, type: 'impure' };
  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) return { valid: false };

  const n = cardIds.length;
  for (const aceHigh of [false, true]) {
    const naturalIdxs = naturals.map((c) => rankIndex(c.rank, aceHigh));
    if (new Set(naturalIdxs).size !== naturalIdxs.length) continue;
    const minIdx = Math.min(...naturalIdxs);
    const maxIdx = Math.max(...naturalIdxs);
    if (maxIdx - minIdx + 1 > n) continue;
    const maxStart = Math.min(minIdx, (aceHigh ? 14 : 13) - n);
    const minStart = Math.max(0, maxIdx - n + 1);
    for (let start = minStart; start <= maxStart; start++) {
      const windowIdxs = new Set(Array.from({ length: n }, (_, i) => start + i));
      if (!naturalIdxs.every((i) => windowIdxs.has(i))) continue;
      const gaps = n - naturalIdxs.length;
      if (gaps === wilds.length) return { valid: true, type: wilds.length > 0 ? 'impure' : 'pure' };
    }
  }
  return { valid: false };
}

export function isValidSet(cardIds: string[], wildcardRanks: Rank[] = []): GroupCheck {
  if (cardIds.length < 3 || cardIds.length > 4) return { valid: false };
  const parsed = cardIds.map(parseCard);
  const naturals = parsed.filter((c) => !isWildcardRank(c.rank, wildcardRanks));
  const wilds = parsed.filter((c) => isWildcardRank(c.rank, wildcardRanks));
  if (naturals.length === 0) return { valid: true, type: 'impure' };
  const rank = naturals[0].rank;
  if (!naturals.every((c) => c.rank === rank)) return { valid: false };
  if (naturals.length + wilds.length !== cardIds.length) return { valid: false };
  // Suits must be either ALL the same (three/four identical cards pulled from different decks —
  // legal here since the deck is tripled) or ALL different from each other (the traditional
  // one-of-each-suit set). A PARTIAL match — e.g. two diamonds and one spade — is not a valid set
  // even though the ranks all match, since neither "same" nor "all different" holds.
  const suitCounts = new Set(naturals.map((c) => c.suit));
  const allSameSuit = suitCounts.size === 1;
  const allDistinctSuits = suitCounts.size === naturals.length;
  if (!allSameSuit && !allDistinctSuits) return { valid: false };
  return { valid: true, type: wilds.length > 0 ? 'impure' : 'set' };
}

export function isValidGroup(cardIds: string[], wildcardRanks: Rank[]): GroupCheck {
  const seq = isValidSequence(cardIds, wildcardRanks);
  if (seq.valid) return seq;
  return isValidSet(cardIds, wildcardRanks);
}

export interface RummyPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: number;
  handCount: number;
  hasSecondJoker: boolean;
  pureRun543At: string | null;
  dropped: boolean;
  finishedRank?: number | null;
}

export type TurnPhase = 'draw' | 'discard';
export type GameStatus = 'waiting' | 'active' | 'finished';

export interface RummyGame {
  hostUid: string;
  code: string;
  status: GameStatus;
  players: RummyPlayer[];
  playerUids: string[];
  currentTurnSeatIndex: number;
  turnPhase: TurnPhase;
  stockCount: number;
  // `locked` — decided once, at the moment of discard, from the DISCARDER's own point of view: the
  // common joker (rank1) is public knowledge from the start, but the second joker (rank2) only
  // locks a discard if that specific player had personally unlocked it already. See server.ts's
  // /api/rummy/discard and /api/rummy/draw for the authoritative logic.
  discardPile: { card: string; locked: boolean }[];
  wildcardRank1: Rank | null;
  wildcardRank2: Rank | null;
  jokerCard1: string | null;
  jokerCard2: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  winnerUid: string | null;
  lastAction?: { type: string; byUid: string; at: string } | null;
  // Set once any player taps "Play Again" on the finished screen — points every other player at
  // the same rematch game instead of each of them spawning their own. See /api/rummy/rematch.
  rematchGameId?: string | null;
  // Stamped by POST /api/games/react (Admin SDK write) whenever a player sends a quick reaction —
  // see components/GameReactions.tsx for how this is consumed to render the floating emoji burst.
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
  lastJokerSpot?: { uid: string; displayName: string; at: string } | null;
  // Every player's final hand, written once at the same moment the game finishes (see
  // server.ts's declare-win/drop handlers) — the winner's is the exact grouping they declared
  // (`melds`), present only when they won by a genuine declare rather than by elimination;
  // everyone else's is just their held cards, ungrouped, since a losing hand was never validated
  // into anything.
  // `groups` (only present for non-winners) is that player's own cosmetic hand-organization from
  // when they were playing (see RummyGame.tsx's handGroups) — cards not in any group are simply
  // the ones left out of `groups`, shown separately as "Ungrouped" by the reveal screen. Each
  // group is wrapped as `{cards: [...]}` rather than a bare string[] — Firestore rejects arrays
  // nested directly inside arrays, so this can never be stored as a plain string[][].
  revealedHands?: Record<string, {
    cards: string[];
    groups?: { cards: string[] }[];
    melds?: { five: string[]; four: string[]; three: string[]; groups: { cards: string[] }[]; discardCardId: string };
  }>;
}

export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Cards are sorted for display purposes only (suit, then ace-low rank) — pure hand-arrangement
// convenience, not part of any validated game state.
export function sortHandForDisplay(cardIds: string[]): string[] {
  return [...cardIds].sort((a, b) => {
    const pa = parseCard(a);
    const pb = parseCard(b);
    if (pa.suit !== pb.suit) return SUITS.indexOf(pa.suit) - SUITS.indexOf(pb.suit);
    return rankIndex(pa.rank, false) - rankIndex(pb.rank, false);
  });
}
