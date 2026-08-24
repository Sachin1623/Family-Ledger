// Business (Indian Monopoly-style) board math and shared types — same trust level as ludo.ts:
// pure, client-computed game state, no Firestore/auth dependency. Like Ludo/Sudoku, this is a
// deliberately client-trusted game (firestore.rules only gate who can write, not full move
// legality) — there's essentially no hidden information in Monopoly-style games (everyone's cash,
// properties, and position are always public; only the Chance/Community Chest draw ORDER is
// randomized, and since card contents are public rulebook knowledge, that's not meaningfully
// "hidden" the way a Rummy hand is), so this doesn't need Rummy's server-mediated architecture.
// Includes an auction (open-outcry, any non-passed player can raise or pass, highest bid wins) for
// a landed-on property the mover declines to buy outright, and direct player-to-player trading
// (properties/cash for properties/cash, proposer picks a target, target accepts or rejects).

export type SquareType =
  | 'go'
  | 'property'
  | 'railway'
  | 'utility'
  | 'chance'
  | 'community'
  | 'tax'
  | 'jail'
  | 'free_parking'
  | 'go_to_jail';

export interface PropertySquare {
  index: number;
  type: 'property';
  name: string;
  group: string;
  price: number;
  baseRent: number;
  houseCost: number;
  mortgageValue: number;
}
export interface RailwaySquare {
  index: number;
  type: 'railway';
  name: string;
  price: number;
  mortgageValue: number;
}
export interface UtilitySquare {
  index: number;
  type: 'utility';
  name: string;
  price: number;
  mortgageValue: number;
}
export interface PlainSquare {
  index: number;
  type: Exclude<SquareType, 'property' | 'railway' | 'utility'>;
  name: string;
}
export type BoardSquare = PropertySquare | RailwaySquare | UtilitySquare | PlainSquare;

export const BOARD_SIZE = 32;
export const STARTING_CASH = 15000;
export const SALARY = 2000;
export const JAIL_BAIL = 500;
export const INCOME_TAX = 1000;
export const JAIL_INDEX = 8;
export const GO_TO_JAIL_INDEX = 24;
export const FREE_PARKING_INDEX = 16;
export const MAX_JAIL_TURNS = 3; // after 3 failed attempts to leave, pay the bail and exit anyway
export const UNMORTGAGE_INTEREST = 0.1; // 10%, per the "pay mortgage + interest" rule

// Saturated group colors — used for the group's own accent (e.g. a legend key), not the tile fill.
// 7 groups (A-G): the extra group came from re-splitting the same 17 properties more finely, not
// from adding new squares — the board total stays 32.
export const COLOR_GROUPS: Record<string, string> = {
  A: '#8D5524',
  B: '#38BDF8',
  C: '#EC4899',
  D: '#EAB308',
  E: '#F97316',
  F: '#DC2626',
  G: '#16A34A',
};

// Light/pastel versions for filling a whole property tile's background (readable at tiny board
// scale) — a separate palette from COLOR_GROUPS rather than a computed tint, so each stays
// hand-picked for contrast against the dark text.
export const COLOR_GROUPS_LIGHT: Record<string, string> = {
  A: '#E8D5C4',
  B: '#BAE6FD',
  C: '#FBCFE8',
  D: '#FEF08A',
  E: '#FED7AA',
  F: '#FECACA',
  G: '#BBF7D0',
};

// Geometry verified separately (32-cell outer ring of a 9x9 grid, corners at 0/8/16/24) before
// this layout was written — see the board-construction note in BusinessGame.tsx. Railways are all
// named identically ("Railway") and utilities are named generically too, matching how the
// physical Indian Business board labels them (not individual station names).
// houseCost is 75% of price (was 50%, same as mortgageValue) — building was undervalued relative
// to the property's own worth; mortgageValue stays at 50% (a separate, deliberately lower number).
export const BOARD: BoardSquare[] = [
  { index: 0, type: 'go', name: 'GO' },
  { index: 1, type: 'property', name: 'Faridabad', group: 'A', price: 800, baseRent: 80, houseCost: 600, mortgageValue: 400 },
  { index: 2, type: 'community', name: 'Chest' },
  { index: 3, type: 'property', name: 'Meerut', group: 'A', price: 1000, baseRent: 100, houseCost: 750, mortgageValue: 500 },
  { index: 4, type: 'tax', name: 'Income Tax' },
  { index: 5, type: 'railway', name: 'Railway', price: 1000, mortgageValue: 500 },
  { index: 6, type: 'property', name: 'Nashik', group: 'B', price: 1200, baseRent: 120, houseCost: 900, mortgageValue: 600 },
  { index: 7, type: 'property', name: 'Rajkot', group: 'B', price: 1400, baseRent: 140, houseCost: 1050, mortgageValue: 700 },
  { index: 8, type: 'jail', name: 'Jail' },
  { index: 9, type: 'property', name: 'Jaipur', group: 'C', price: 1600, baseRent: 160, houseCost: 1200, mortgageValue: 800 },
  { index: 10, type: 'chance', name: 'Chance' },
  { index: 11, type: 'property', name: 'Lucknow', group: 'C', price: 1800, baseRent: 180, houseCost: 1350, mortgageValue: 900 },
  { index: 12, type: 'utility', name: 'Electricity', price: 750, mortgageValue: 375 },
  { index: 13, type: 'property', name: 'Kanpur', group: 'D', price: 2000, baseRent: 200, houseCost: 1500, mortgageValue: 1000 },
  { index: 14, type: 'property', name: 'Nagpur', group: 'D', price: 2200, baseRent: 220, houseCost: 1650, mortgageValue: 1100 },
  { index: 15, type: 'railway', name: 'Railway', price: 1000, mortgageValue: 500 },
  { index: 16, type: 'free_parking', name: 'Free Parking' },
  { index: 17, type: 'property', name: 'Pune', group: 'E', price: 2600, baseRent: 260, houseCost: 1950, mortgageValue: 1300 },
  { index: 18, type: 'community', name: 'Chest' },
  { index: 19, type: 'property', name: 'Ahm', group: 'E', price: 2800, baseRent: 280, houseCost: 2100, mortgageValue: 1400 },
  { index: 20, type: 'property', name: 'Surat', group: 'E', price: 3000, baseRent: 300, houseCost: 2250, mortgageValue: 1500 },
  { index: 21, type: 'railway', name: 'Railway', price: 1000, mortgageValue: 500 },
  { index: 22, type: 'property', name: 'Kolkata', group: 'F', price: 3200, baseRent: 320, houseCost: 2400, mortgageValue: 1600 },
  { index: 23, type: 'chance', name: 'Chance' },
  { index: 24, type: 'go_to_jail', name: 'Go To Jail' },
  { index: 25, type: 'property', name: 'Chennai', group: 'F', price: 3400, baseRent: 340, houseCost: 2550, mortgageValue: 1700 },
  { index: 26, type: 'property', name: 'Gurgaon', group: 'F', price: 3600, baseRent: 360, houseCost: 2700, mortgageValue: 1800 },
  { index: 27, type: 'railway', name: 'Railway', price: 1000, mortgageValue: 500 },
  { index: 28, type: 'utility', name: 'Water', price: 750, mortgageValue: 375 },
  { index: 29, type: 'property', name: 'Bengaluru', group: 'G', price: 3800, baseRent: 380, houseCost: 2850, mortgageValue: 1900 },
  { index: 30, type: 'property', name: 'Delhi', group: 'G', price: 4000, baseRent: 400, houseCost: 3000, mortgageValue: 2000 },
  { index: 31, type: 'property', name: 'Mumbai', group: 'G', price: 4200, baseRent: 420, houseCost: 3150, mortgageValue: 2100 },
];

export function squareAt(position: number): BoardSquare {
  return BOARD[((position % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE];
}

export function isOwnable(square: BoardSquare): square is PropertySquare | RailwaySquare | UtilitySquare {
  return square.type === 'property' || square.type === 'railway' || square.type === 'utility';
}

export function groupPropertyIndexes(group: string): number[] {
  return BOARD.filter((s): s is PropertySquare => s.type === 'property' && s.group === group).map((s) => s.index);
}

export function railwayIndexes(): number[] {
  return BOARD.filter((s) => s.type === 'railway').map((s) => s.index);
}

export function utilityIndexes(): number[] {
  return BOARD.filter((s) => s.type === 'utility').map((s) => s.index);
}

// --- Movement ---

export function movePlayer(position: number, steps: number): { newPosition: number; passedGo: boolean } {
  const raw = position + steps;
  const newPosition = raw % BOARD_SIZE;
  return { newPosition, passedGo: raw >= BOARD_SIZE };
}

// Smallest index of the given type strictly ahead of `from` (wrapping around the board) — used for
// Chance's "advance to the nearest railway/utility" cards.
export function nearestSquareOfType(from: number, type: 'railway' | 'utility'): number {
  const indexes = type === 'railway' ? railwayIndexes() : utilityIndexes();
  const ahead = indexes.filter((i) => i > from);
  return ahead.length > 0 ? ahead[0] : indexes[0];
}

// --- Rent ---

// Multiplier applied to a property's base rent — index 0 is the unimproved rate (before any
// houses), indices 1-4 are 1-4 houses; a hotel uses RENT_HOTEL_MULTIPLIER instead.
export const RENT_HOUSE_MULTIPLIERS = [1, 5, 15, 30, 45];
export const RENT_HOTEL_MULTIPLIER = 60;

export function propertyRent(
  square: PropertySquare,
  houses: number,
  hasHotel: boolean,
  ownerOwnsFullGroup: boolean,
  doubleRentFullSet: boolean,
): number {
  if (hasHotel) return square.baseRent * RENT_HOTEL_MULTIPLIER;
  if (houses > 0) return square.baseRent * RENT_HOUSE_MULTIPLIERS[houses];
  return ownerOwnsFullGroup && doubleRentFullSet ? square.baseRent * 2 : square.baseRent;
}

const RAILWAY_RENT_BY_COUNT = [0, 500, 1000, 2000, 4000];
export function railwayRent(ownedCount: number): number {
  return RAILWAY_RENT_BY_COUNT[Math.max(0, Math.min(ownedCount, 4))];
}

export function utilityRent(diceSum: number, ownsBothUtilities: boolean): number {
  return diceSum * (ownsBothUtilities ? 10 : 4);
}

// --- Cards ---

export type CardEffect =
  | { kind: 'receive'; amount: number }
  | { kind: 'pay'; amount: number }
  | { kind: 'payEachPlayer'; amount: number }
  | { kind: 'collectFromEachPlayer'; amount: number }
  | { kind: 'moveTo'; position: number }
  | { kind: 'moveRelative'; steps: number }
  | { kind: 'moveToNearestRailway' }
  | { kind: 'moveToNearestUtility' }
  | { kind: 'goToJail' }
  | { kind: 'getOutOfJailCard' }
  | { kind: 'repairs'; perHouse: number; perHotel: number };

export interface Card {
  text: string;
  effect: CardEffect;
}

export const CHANCE_CARDS: Card[] = [
  { text: 'Advance to GO. Collect ₹2000.', effect: { kind: 'moveTo', position: 0 } },
  { text: 'Bank pays you a dividend of ₹500.', effect: { kind: 'receive', amount: 500 } },
  { text: 'You have been elected Chairman of the Board. Pay each player ₹500.', effect: { kind: 'payEachPlayer', amount: 500 } },
  { text: 'Go directly to Jail. Do not pass GO.', effect: { kind: 'goToJail' } },
  { text: 'Your building loan matures. Collect ₹1500.', effect: { kind: 'receive', amount: 1500 } },
  { text: 'Pay poor tax of ₹300.', effect: { kind: 'pay', amount: 300 } },
  { text: 'Take a trip to the nearest railway station.', effect: { kind: 'moveToNearestRailway' } },
  { text: 'Advance to the nearest utility.', effect: { kind: 'moveToNearestUtility' } },
  { text: 'Get Out of Jail Free. Keep this card until needed.', effect: { kind: 'getOutOfJailCard' } },
  { text: 'Speeding fine. Pay ₹200.', effect: { kind: 'pay', amount: 200 } },
  { text: 'You win a crossword competition. Collect ₹1000.', effect: { kind: 'receive', amount: 1000 } },
  { text: 'Advance three squares.', effect: { kind: 'moveRelative', steps: 3 } },
];

export const COMMUNITY_CHEST_CARDS: Card[] = [
  { text: 'Life insurance matures. Collect ₹1000.', effect: { kind: 'receive', amount: 1000 } },
  { text: "Doctor's fees. Pay ₹500.", effect: { kind: 'pay', amount: 500 } },
  { text: 'You inherit ₹1000.', effect: { kind: 'receive', amount: 1000 } },
  { text: 'Hospital fees. Pay ₹1000.', effect: { kind: 'pay', amount: 1000 } },
  { text: 'School fees. Pay ₹500.', effect: { kind: 'pay', amount: 500 } },
  { text: 'Receive ₹250 consultancy fee.', effect: { kind: 'receive', amount: 250 } },
  { text: 'You are assessed for street repairs: ₹400 per house and ₹1150 per hotel you own.', effect: { kind: 'repairs', perHouse: 400, perHotel: 1150 } },
  { text: 'Income tax refund. Collect ₹200.', effect: { kind: 'receive', amount: 200 } },
  { text: 'It is your birthday. Collect ₹100 from every player.', effect: { kind: 'collectFromEachPlayer', amount: 100 } },
  { text: 'Go directly to Jail. Do not pass GO.', effect: { kind: 'goToJail' } },
  { text: 'Get Out of Jail Free. Keep this card until needed.', effect: { kind: 'getOutOfJailCard' } },
  { text: 'Advance to GO. Collect ₹2000.', effect: { kind: 'moveTo', position: 0 } },
];

export function shuffledIndexes(size: number): number[] {
  const arr = Array.from({ length: size }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Game state shapes ---

export interface BusinessPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  seatIndex: number;
  cash: number;
  position: number;
  inJail: boolean;
  jailTurns: number;
  getOutOfJailCards: number;
  bankrupt: boolean;
  doublesStreak: number;
}

export interface PropertyState {
  ownerUid: string | null;
  houses: number;
  hotel: boolean;
  mortgaged: boolean;
}

export interface HouseRules {
  freeParkingJackpot: boolean;
  doubleRentFullSet: boolean;
  doubleSalaryOnExactGo: boolean;
  doublesExtraTurn: boolean; // also gates the "3 doubles in a row -> jail" safety rule
}

export const DEFAULT_HOUSE_RULES: HouseRules = {
  freeParkingJackpot: true,
  doubleRentFullSet: true,
  doubleSalaryOnExactGo: true,
  doublesExtraTurn: true,
};

export type BusinessTurnPhase = 'roll' | 'action' | 'end';
export type BusinessStatus = 'waiting' | 'active' | 'finished';

export interface PendingCard {
  deck: 'chance' | 'community';
  cardIndex: number;
}

// Open-outcry auction for a property the landing player declined to buy outright — any player who
// hasn't passed may raise the bid or pass; once only one non-passed player remains, they win at
// their last bid (or the property stays unowned if nobody ever bid). Independent of `turnPhase` —
// every player can act on it regardless of whose turn it nominally is.
export interface Auction {
  propertyIndex: number;
  currentBid: number;
  currentBidderUid: string | null;
  passedUids: string[];
}

// A direct player-to-player trade proposal — one at a time (a new proposal can't be opened while
// one is already pending). Either side of the trade can include properties, cash, or both.
export interface TradeOffer {
  id: string;
  fromUid: string;
  toUid: string;
  offerProperties: number[];
  offerCash: number;
  requestProperties: number[];
  requestCash: number;
}

export interface BusinessGame {
  hostUid: string;
  code: string;
  status: BusinessStatus;
  players: BusinessPlayer[];
  playerUids: string[];
  currentTurnSeatIndex: number;
  turnPhase: BusinessTurnPhase;
  lastRoll: [number, number] | null;
  properties: PropertyState[]; // length BOARD_SIZE, indexed by board position
  chanceDeck: number[];
  communityDeck: number[];
  freeParkingPot: number;
  houseRules: HouseRules;
  pendingCard: PendingCard | null;
  auction: Auction | null;
  pendingTrade: TradeOffer | null;
  lastAction?: { text: string; at: string } | null;
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  winnerUid: string | null;
  endedBy?: string | null;
  endedByName?: string | null;
  rematchGameId?: string | null;
}

export function emptyProperties(): PropertyState[] {
  return Array.from({ length: BOARD_SIZE }, () => ({ ownerUid: null, houses: 0, hotel: false, mortgaged: false }));
}

export function ownsFullGroup(group: string, ownerUid: string, properties: PropertyState[]): boolean {
  return groupPropertyIndexes(group).every((idx) => properties[idx]?.ownerUid === ownerUid);
}

// Building requires owning every property in the group AND none of them mortgaged — standard rule.
export function canBuildOnGroup(group: string, ownerUid: string, properties: PropertyState[]): boolean {
  return groupPropertyIndexes(group).every((idx) => properties[idx]?.ownerUid === ownerUid && !properties[idx]?.mortgaged);
}

// Even-build enforcement: a property can get its next house/hotel only if no other property in
// the same group is more than 1 level behind it (can't build 3 on one and 0 on another).
export function canBuildOnProperty(square: PropertySquare, properties: PropertyState[]): { canBuild: boolean; isHotel: boolean } {
  const state = properties[square.index];
  if (!state || state.mortgaged) return { canBuild: false, isHotel: false };
  if (state.hotel) return { canBuild: false, isHotel: false }; // already maxed out
  const groupIdxs = groupPropertyIndexes(square.group);
  const levels = groupIdxs.map((idx) => (properties[idx].hotel ? 5 : properties[idx].houses));
  const myLevel = state.hotel ? 5 : state.houses;
  const minLevel = Math.min(...levels);
  if (myLevel > minLevel) return { canBuild: false, isHotel: false }; // others must catch up first
  return { canBuild: true, isHotel: myLevel === 4 };
}

export function ownedRailwayCount(ownerUid: string, properties: PropertyState[]): number {
  return railwayIndexes().filter((idx) => properties[idx]?.ownerUid === ownerUid).length;
}

export function ownsBothUtilities(ownerUid: string, properties: PropertyState[]): boolean {
  return utilityIndexes().every((idx) => properties[idx]?.ownerUid === ownerUid);
}

export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
