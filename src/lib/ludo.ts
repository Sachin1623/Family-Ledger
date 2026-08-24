// Ludo board math and turn logic — shared, pure, no Firestore/auth dependency (matches sudoku.ts's
// separation: this module is trusted, client-computed game state, and firestore.rules only
// structurally validate writes (right shape, right player) rather than re-deriving full move
// legality server-side. That mirrors the trust level already used for Personal Loans/Shopkeeper
// entries elsewhere in this app — a full authoritative rules-engine reimplementation in the
// Firestore rules DSL would be a huge, error-prone undertaking for a casual family-app game.

export type Color = 'red' | 'green' | 'yellow' | 'blue';
export const COLORS: Color[] = ['red', 'green', 'yellow', 'blue'];
export const COLOR_HEX: Record<Color, string> = { red: '#DC2626', green: '#16A34A', yellow: '#EAB308', blue: '#2563EB' };

// Diagonal (yard-opposite) color for each color — green/blue and yellow/red are the two diagonal
// pairs on the board (green=TL, yellow=TR, red=BL, blue=BR). Used specifically so a 2-player game
// seats the two players across the board from each other rather than in adjacent corners.
export const OPPOSITE_COLOR: Record<Color, Color> = { green: 'blue', blue: 'green', yellow: 'red', red: 'yellow' };

// Picks the color for the next player joining a game that already has `existingColors` seated —
// the 2nd player specifically gets seated diagonally opposite the 1st (not just "next in the
// list"), matching standard Ludo's 2-player convention; the 3rd/4th just take whatever's left.
// Used only as a suggested default in the join-screen color picker now that players can freely
// choose any unclaimed color — see LudoGame.tsx's handleJoin.
export function nextJoinColor(existingColors: Color[]): Color {
  if (existingColors.length === 1) return OPPOSITE_COLOR[existingColors[0]];
  return COLORS.find((c) => !existingColors.includes(c)) || COLORS[existingColors.length % 4];
}

// True physical clockwise order of the 4 corners around the board (green=TL, yellow=TR,
// blue=BR, red=BL — see the PATH52 derivation note in LudoGame.tsx). These 4 names are reused
// purely as PHYSICAL SLOT identifiers throughout this file and LudoGame.tsx's rendering — see
// boardSlot() below for why that's now a separate concept from a player's own chosen `color`.
export const CLOCKWISE_ORDER: Color[] = ['green', 'yellow', 'blue', 'red'];

// Which physical board quadrant (expressed as one of the 4 fixed slot names above — green=TL,
// yellow=TR, blue=BR, red=BL) a given SEAT occupies, independent of that seat's own freely-chosen
// display `color`. Determined purely by join order (seatIndex) + how many total players there
// are, so a 2-player game is ALWAYS physically opposite on the board no matter which 2 of the 4
// colors those players picked (they might both be "green" and "red", say — colors most people
// wouldn't think of as a matched diagonal pair, yet the board still seats them across from each
// other), a 3-player game spreads across 3 of the 4 quadrants, and a 4-player game fills all 4 in
// clockwise order. This is what lets color choice be completely free (see LudoGame.tsx's
// handleJoin/handleChangeColor) while the board layout itself still always makes sense.
export function boardSlot(seatIndex: number, totalPlayers: number): Color {
  if (totalPlayers === 2) return seatIndex === 0 ? CLOCKWISE_ORDER[0] : CLOCKWISE_ORDER[2];
  return CLOCKWISE_ORDER[seatIndex % 4];
}

// Given the currently-seated players and whose turn it is now, finds the seatIndex of the next
// SEATED player walking clockwise by PHYSICAL SLOT (see boardSlot) from the current player —
// skipping any of the 4 quadrants nobody occupies (a 2-3 player game doesn't fill all 4).
export function nextClockwiseSeat(players: LudoPlayer[], currentSeatIndex: number): number {
  const total = players.length;
  const currentSlot = boardSlot(players[currentSeatIndex].seatIndex, total);
  const startIdx = CLOCKWISE_ORDER.indexOf(currentSlot);
  for (let step = 1; step <= CLOCKWISE_ORDER.length; step++) {
    const candidateSlot = CLOCKWISE_ORDER[(startIdx + step) % CLOCKWISE_ORDER.length];
    const seat = players.findIndex((p) => boardSlot(p.seatIndex, total) === candidateSlot);
    if (seat !== -1) return seat;
  }
  return currentSeatIndex;
}

// Each color's start offset on the shared 52-square outer track — the clean 0/13/26/39 split
// this produces isn't a coincidence: it's the direct result of the board's rotational symmetry
// once the track goes clockwise and each color's absolute-square-0 sits on the lane directly
// adjacent to *its own* yard (not another color's), matching the classic board layout. See the
// board-construction note in LudoGame.tsx for how PATH52 was derived and verified to match this.
export const START_OFFSET: Record<Color, number> = { green: 0, yellow: 13, blue: 26, red: 39 };

// Absolute squares (0-51) safe from capture: each color's own start square plus one star square
// 8 squares further along — standard Ludo convention.
export const SAFE_SQUARES = new Set<number>([0, 8, 13, 21, 26, 34, 39, 47]);

export const YARD = -1;
export const HOME_ENTRY = 51; // relative position where a token turns off the shared track into its own home stretch
// The 6th and LAST of the 6 visible home-stretch cells (51-56) — deliberately not a 7th,
// invisible position beyond what's actually drawn on the board. An earlier version used 57 here,
// which meant a token could sit on the last cell anyone can see and still not count as finished,
// silently requiring one more roll the board never showed. "Home" IS that last visible cell.
export const HOME = 56;
export const TRACK_LENGTH = 52;

export interface LudoPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  color: Color;
  seatIndex: number;
  tokens: number[]; // 4 entries, each YARD | 0-50 (shared track) | 51-55 (home stretch) | HOME (=56, the stretch's own last cell)
  finishedCount: number;
  // Explicit, player-chosen team (0 or 1) — only ever offered in the UI for 4-player games, and
  // entirely optional even then. Absent or explicitly null for anyone who hasn't picked one
  // (null, not undefined, once cleared — Firestore rejects literal undefined in writes), which
  // naturally means no capture immunity applies until BOTH players in a pair have chosen the SAME
  // team — see applyMove. Deliberately replaces an earlier "diagonal color = teammate" assumption,
  // which stopped making sense once color choice became fully free (any two colors could end up
  // opposite each other with no relation to who a player actually wants as a partner).
  team?: 0 | 1 | null;
}

// Converts a token's relative position (own color's frame of reference) to an absolute square on
// the shared 52-square track. Only meaningful for 0-50 — the home stretch (51-56) and yard/home
// have no shared-track equivalent, since they're private to that color.
export function toAbsolute(color: Color, relativePos: number): number | null {
  if (relativePos < 0 || relativePos > 50) return null;
  return (START_OFFSET[color] + relativePos) % TRACK_LENGTH;
}

export function isSafeSquare(absolutePos: number): boolean {
  return SAFE_SQUARES.has(absolutePos);
}

// Which of a player's tokens can legally move given a dice roll — a token in the yard needs a 6
// to exit; an in-play token can move any amount that doesn't overshoot HOME (traditional Ludo:
// a token needs the EXACT roll to finish — a token 2 squares from home stays put on a roll of 5,
// it must wait for a 2 or less... a roll under the exact amount still legally advances it partway,
// only an overshoot past HOME is illegal).
export function movableTokens(tokens: number[], dice: number): number[] {
  const movable: number[] = [];
  tokens.forEach((pos, i) => {
    if (pos === YARD) {
      if (dice === 6) movable.push(i);
    } else if (pos < HOME && pos + dice <= HOME) {
      movable.push(i);
    }
  });
  return movable;
}

export interface MoveResult {
  players: LudoPlayer[];
  captured: { seatIndex: number; tokenIndex: number }[];
  finished: boolean; // this token reached HOME
  bonusRoll: boolean; // dice was a 6 or a capture happened — same player rolls again
}

// Applies moving `tokenIndex` of the player at `seatIndex` forward by `dice` — the caller (see
// movableTokens) already guarantees `from + dice <= HOME`, so this never needs to clamp. Captures
// any single opponent token landed on (not on a safe square, and not stacked — blockades of 2+
// same-color tokens aren't modeled in this v1, a deliberate simplification), EXCEPT a teammate's
// token: teammates are whoever explicitly chose the SAME `team` value (see LudoPlayer.team) —
// undefined for either side means no immunity, so this is a no-op unless both players actually
// opted into the same team. Track-position math uses each player's PHYSICAL board slot (see
// boardSlot), not their freely-chosen display `color` — those are different things now, and
// mixing them up here would compute captures against the wrong track alignment. Returns a fresh
// players array (does not mutate the input) plus what happened, for the caller to persist/describe.
export function applyMove(players: LudoPlayer[], seatIndex: number, tokenIndex: number, dice: number): MoveResult {
  const next = players.map((p) => ({ ...p, tokens: [...p.tokens] }));
  const total = next.length;
  const mover = next[seatIndex];
  const moverSlot = boardSlot(mover.seatIndex, total);
  const from = mover.tokens[tokenIndex];
  const to = from === YARD ? 0 : from + dice;
  mover.tokens[tokenIndex] = to;

  const captured: { seatIndex: number; tokenIndex: number }[] = [];
  const finished = to === HOME;

  if (to < HOME_ENTRY) {
    const abs = toAbsolute(moverSlot, to);
    if (abs != null && !isSafeSquare(abs)) {
      next.forEach((opponent, oSeat) => {
        if (oSeat === seatIndex) return;
        if (mover.team != null && opponent.team === mover.team) return;
        const opponentSlot = boardSlot(opponent.seatIndex, total);
        opponent.tokens.forEach((oPos, oTokenIdx) => {
          if (oPos >= 0 && oPos < HOME_ENTRY && toAbsolute(opponentSlot, oPos) === abs) {
            opponent.tokens[oTokenIdx] = YARD;
            captured.push({ seatIndex: oSeat, tokenIndex: oTokenIdx });
          }
        });
      });
    }
  }

  if (finished) mover.finishedCount += 1;

  // Rolling a 6, capturing an opponent, OR getting a token home all grant another roll.
  return { players: next, captured, finished, bonusRoll: dice === 6 || captured.length > 0 || finished };
}

export function hasWon(player: LudoPlayer): boolean {
  return player.tokens.every((t) => t === HOME);
}

// Six-digit, unambiguous-alphabet game code (no 0/O/1/I) for sharing outside a group.
export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export function emptyTokens(): number[] {
  return [YARD, YARD, YARD, YARD];
}
