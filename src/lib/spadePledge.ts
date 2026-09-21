// Spade Pledge — a 4-player, server-authoritative Spades-family trick-taking game with
// bidding/contracts. Card ids use a simple "{rank}{suit}" scheme (a single standard 52-card deck,
// no jokers — unlike rummy13.ts's multi-deck "_{deckIndex}" suffix, no multi-deck support is
// needed here).
//
// Hidden-information integrity (nobody, including this client, may ever see another player's
// hand) means this game — like 27-Hand Rummy, Sweep, and 13-Card Rummy — can't use this app's
// usual "client computes the move, Firestore rules just gate who can write" pattern. All bidding
// and card-play actions go through server.ts endpoints backed by the Admin SDK; this client only
// ever sees its OWN hand and the public table/deal docs (opponents' card COUNTS, never their
// actual cards, until a card is actually played into a trick).
//
// The validation logic below (legal moves, trick winner) is a client-side MIRROR for instant UI
// feedback — it is NOT authoritative. server.ts holds its own duplicate copy (established
// convention — see rummy.ts's header comment).
//
// Supports two formats, chosen by the host at table creation and immutable thereafter:
//  - 'partnership': 2v2, teammates seated opposite each other (team = seatIndex % 2, same
//    convention as sweep.ts).
//  - 'ffa': 4 individual players (team = seatIndex, i.e. globally unique per player).
// Both formats are unified as "scoring groups" — see scoringGroupSeats/teamForSeat below. The
// per-hand scoring algorithm (server.ts's resolveSpadePledgeHandEnd) is written once, generalized
// over groups, with no branching on format.

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANKS)[number];
export const SUITS = ['C', 'D', 'H', 'S'] as const;
export type Suit = (typeof SUITS)[number];
export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_RED: Record<Suit, boolean> = { S: false, H: true, D: true, C: false };
export const TRUMP_SUIT: Suit = 'S';

export function buildDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck; // 52 cards
}

export function parseCard(cardId: string): { rank: Rank; suit: Suit } {
  const suit = cardId.slice(-1) as Suit;
  const rank = cardId.slice(0, -1) as Rank;
  return { rank, suit };
}

export function rankValue(cardId: string): number {
  return RANKS.indexOf(parseCard(cardId).rank);
}

export function sortHandForDisplay(cardIds: string[]): string[] {
  return [...cardIds].sort((a, b) => {
    const pa = parseCard(a);
    const pb = parseCard(b);
    if (pa.suit !== pb.suit) return SUITS.indexOf(pa.suit) - SUITS.indexOf(pb.suit);
    return rankValue(a) - rankValue(b);
  });
}

export function generateGameCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export type SpadePledgeFormat = 'partnership' | 'ffa';
export type SpadePledgeStatus = 'waiting' | 'active' | 'finished';
export type SpadePledgePhase = 'bidding' | 'playing';
export type SpadePledgeDealStatus = 'active' | 'finished';

export const MIN_BID = 2;
export const MAX_BID = 8;
export const BOT_CONVERSION_THRESHOLD = 2;
export const TURN_TIMEOUT_MS = 30_000;
export const TURN_WARNING_MS = 10_000;
export const TARGET_SCORE = 300;
export const BID_TRICK_POINTS = 10;
export const OVERTRICK_POINTS = 1;
export const FAILED_BID_TRICK_PENALTY = 10;
export const NIL_BONUS = 100;
export const NIL_PENALTY = 100;
export const BAG_PENALTY_THRESHOLD = 10;
export const BAG_PENALTY = 100;

// The one place `format` ever affects seat->group mapping. Everything downstream (scoring,
// match-end, rewards) consumes only `team`/`groups`, never `format`, directly.
export function scoringGroupSeats(format: SpadePledgeFormat): number[][] {
  return format === 'partnership' ? [[0, 2], [1, 3]] : [[0], [1], [2], [3]];
}
export function teamForSeat(format: SpadePledgeFormat, seatIndex: number): number {
  return format === 'partnership' ? seatIndex % 2 : seatIndex;
}

export interface SpadePledgePlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: 0 | 1 | 2 | 3;
  // Opaque scoring-group id: 0|1 for partnership (seat%2, teammates seated opposite), 0..3 for
  // FFA (== seatIndex, globally unique). Named `team` — not `groupIndex` — so GameRanks.tsx's
  // existing resultMode:'team' comparisons (a.team===b.team, me.team===winnerTeam) work
  // unmodified for both formats.
  team: number;
  isBot: boolean;
  consecutiveTimeouts: number;
}

export interface SpadePledgeScoreGroup {
  groupIndex: number; // equals the shared `team` value of its members
  memberUids: string[]; // fixed for the match — seats don't rotate mid-match
  cumulativeScore: number;
  bags: number;
}

export interface SpadePledgeHandHistoryEntry {
  handNumber: number;
  bids: Record<string, number>;
  tricksWon: Record<string, number>;
  nilResults: Record<string, 'made' | 'broken' | null>;
  // Indexed by groupIndex; length 2 (partnership) or 4 (ffa).
  groupScoreDelta: number[];
  groupBagsAfter: number[];
  netScoreAfter: number[];
}

export interface SpadePledgeTable {
  hostUid: string;
  code: string;
  status: SpadePledgeStatus;
  format: SpadePledgeFormat;
  players: SpadePledgePlayer[];
  playerUids: string[];
  groups: SpadePledgeScoreGroup[]; // [] until /start (needs all 4 seats filled)
  currentDealId: string | null;
  handNumber: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  winnerTeam: number | null; // same field name/semantics as Sweep's winnerTeam
  lastHandSummary: SpadePledgeHandHistoryEntry | null;
  dealHistory: SpadePledgeHandHistoryEntry[]; // permanent, uncapped log (Sweep's dealHistory pattern)
  rematchGameId?: string | null;
  lastAction?: { text: string; at: string } | null;
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
}

export interface SpadePledgeTrickCardPlay {
  seatIndex: number;
  uid: string;
  cardId: string;
}

export interface SpadePledgeTrick {
  leaderSeatIndex: number;
  cards: SpadePledgeTrickCardPlay[]; // 0..4
  winnerSeatIndex?: number; // set once cards.length === 4
}

export interface SpadePledgeDealPlayer {
  uid: string;
  seatIndex: number;
  team: number; // copied from the table player at deal time
  handCount: number; // 13 -> 0
  bid: number | null; // null while bidding; 0-13 once bid (0 == nil)
  tricksWon: number;
}

export interface SpadePledgeDeal {
  tableId: string;
  playerUids: string[];
  handNumber: number;
  players: SpadePledgeDealPlayer[];
  dealerSeatIndex: number;
  phase: SpadePledgePhase;
  currentTurnSeatIndex: number; // authoritative "whose turn" for BOTH bidding and play
  turnStartedAt: string;
  spadesBroken: boolean;
  completedTricks: SpadePledgeTrick[];
  currentTrick: SpadePledgeTrick; // always present; cards:[] between tricks
  status: SpadePledgeDealStatus;
  startedAt: string;
  finishedAt: string | null;
  lastAction?: { type: string; byUid: string; at: string } | null;
}

// --- Client-side mirror of the authoritative legal-move algorithm (see server.ts for the real one) ---

function suitOf(cardId: string): Suit {
  return parseCard(cardId).suit;
}

// true if `candidate` would win the trick if compared only against `currentBest`, given trump is
// always Spades.
function beats(candidate: string, currentBest: string, ledSuit: Suit): boolean {
  const cSpade = suitOf(candidate) === 'S';
  const bSpade = suitOf(currentBest) === 'S';
  if (cSpade && !bSpade) return true;
  if (bSpade && !cSpade) return false;
  if (cSpade && bSpade) return rankValue(candidate) > rankValue(currentBest);
  if (suitOf(candidate) !== ledSuit) return false;
  return rankValue(candidate) > rankValue(currentBest);
}

export function trickBestPlay(trick: SpadePledgeTrick): SpadePledgeTrickCardPlay {
  const ledSuit = suitOf(trick.cards[0].cardId);
  let best = trick.cards[0];
  for (const play of trick.cards.slice(1)) {
    if (beats(play.cardId, best.cardId, ledSuit)) best = play;
  }
  return best;
}

export function trickWinnerSeat(trick: SpadePledgeTrick): number {
  return trickBestPlay(trick).seatIndex;
}

// The authoritative legal-move set for the seat whose turn it is. A player void in the led suit
// may discard or trump freely (no forced trumping) — confirmed with the user. A player who CAN
// follow suit must beat the current best-in-trick card with a higher card of that suit if one is
// held (stricter than standard Spades' plain follow-suit rule) — also confirmed with the user.
export function legalCards(hand: string[], trick: SpadePledgeTrick, spadesBroken: boolean): string[] {
  if (trick.cards.length === 0) {
    // Leading a new trick.
    const nonSpades = hand.filter((c) => suitOf(c) !== 'S');
    if (!spadesBroken && nonSpades.length > 0) return nonSpades; // can't lead spades until broken
    return hand; // spades broken, or hand is all spades (exception)
  }

  const ledSuit = suitOf(trick.cards[0].cardId);
  const followCards = hand.filter((c) => suitOf(c) === ledSuit);

  if (followCards.length === 0) return hand; // void — free choice

  // Can follow suit — the stricter "must beat if possible" rule applies here and only here. When
  // spades are the LED suit, "following suit" IS playing a trump, and the same must-beat rule
  // applies among those trump cards (a trick led with a spade is still just a trick). The exemption
  // below only fires for a genuine CROSS-suit trump — some void player discarded a spade into a
  // trick led in a different suit, which a follow-suit (non-trump) card can never beat regardless
  // of rank.
  const best = trickBestPlay(trick);
  if (ledSuit !== 'S' && suitOf(best.cardId) === 'S') return followCards;
  const beatingFollowCards = followCards.filter((c) => rankValue(c) > rankValue(best.cardId));
  return beatingFollowCards.length > 0 ? beatingFollowCards : followCards;
}
