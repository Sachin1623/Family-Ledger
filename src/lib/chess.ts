// Chess board math and small helpers — unlike Ludo/Rummy/Sweep/Business, actual move legality
// (check, checkmate, castling, en passant, promotion, draw detection) is NOT hand-rolled here.
// Chess has far more edge cases than any of this app's other games, and getting even one subtly
// wrong (e.g. castling-through-check, en passant timing) is the kind of bug that's easy to ship
// and hard to notice — so this wraps the battle-tested `chess.js` library (zero dependencies,
// MIT) for the actual rules engine, and only adds the UI-facing bits chess.js doesn't care about:
// board orientation per player, Firestore game-doc shape, and game codes (matching every other
// game's share-code pattern).
import { Chess, type Color as ChessColor, type PieceSymbol, type Square } from 'chess.js';

export type PlayerColor = 'w' | 'b';

export interface ChessPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  color: PlayerColor;
}

export type ChessResult = 'w' | 'b' | 'draw' | null;
export type ChessResultReason =
  | 'checkmate'
  | 'resignation'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_move_rule'
  | 'draw_agreed'
  | 'ended_early'
  | null;

export interface ChessGame {
  hostUid: string;
  code: string;
  status: 'waiting' | 'active' | 'finished';
  players: ChessPlayer[];
  playerUids: string[];
  fen: string;
  history: string[]; // SAN moves, oldest first
  lastMove: { from: string; to: string; san: string } | null;
  drawOfferBy: string | null;
  result: ChessResult;
  resultReason: ChessResultReason;
  endedBy?: string | null;
  endedByName?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastAction?: { text: string; at: string } | null;
  lastReaction?: { emoji: string; uid: string; displayName: string; at: string } | null;
  rematchGameId?: string | null;
}

// Six-digit, unambiguous-alphabet game code (no 0/O/1/I) — identical scheme to every other game's
// share code in this app.
export function generateGameCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Unicode ships two separate glyph sets — hollow/outline "white" pieces (U+2654-2659) and
// solid/filled "black" pieces (U+265A-265F) — but the "white" set has NO fillable interior in
// most fonts (it's a bare outline), so coloring it light makes it read as nearly invisible
// against a light square instead of as a piece. Using the same SOLID/filled glyph shape for both
// colors and differentiating purely by fill (white fill + a dark outline drawn via `text-shadow`,
// black fill needing no outline) reads correctly at any square/theme, and `text-shadow` renders
// far more reliably across browsers than the `-webkit-text-stroke` trick this replaced.
export const PIECE_GLYPH: Record<PieceSymbol, string> = {
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
};

export const COLOR_LABEL: Record<PlayerColor, string> = { w: 'White', b: 'Black' };

export function otherColor(color: PlayerColor): PlayerColor {
  return color === 'w' ? 'b' : 'w';
}

export interface BoardCell {
  square: Square;
  piece: { type: PieceSymbol; color: ChessColor } | null;
}

const FILES = 'abcdefgh';

// `chess.js`'s own `board()` returns a literal `null` (not a cell object) for every EMPTY square
// — only occupied squares carry a `.square` identifier. Building the grid from row/col math
// instead of trusting `board()`'s cells directly means every square (occupied or not) always has
// a real identifier to key/select/click on, and none of them silently vanish from the grid.
//
// Each player sees the board from their own side — `board()` always returns rank 8 first, files
// a-h left to right (white's natural view); flipping for black is just reversing both axes, since
// a 180-degree rotation of the whole grid is exactly "swap row order and column order together."
export function orientedBoard(chess: Chess, viewColor: PlayerColor): BoardCell[][] {
  const raw = chess.board();
  const grid: BoardCell[][] = raw.map((row, r) =>
    row.map((cell, c) => ({
      square: `${FILES[c]}${8 - r}` as Square,
      piece: cell ? { type: cell.type, color: cell.color } : null,
    })),
  );
  if (viewColor === 'w') return grid;
  return grid.slice().reverse().map((row) => row.slice().reverse());
}

// Material captured so far, grouped by which color captured it — derived from verbose move
// history rather than tracked separately, so it can never drift from the actual game state.
export function capturedByColor(chess: Chess): { w: PieceSymbol[]; b: PieceSymbol[] } {
  const captured: { w: PieceSymbol[]; b: PieceSymbol[] } = { w: [], b: [] };
  for (const move of chess.history({ verbose: true })) {
    if (move.captured) captured[move.color].push(move.captured);
  }
  return captured;
}

const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function materialEdge(captured: { w: PieceSymbol[]; b: PieceSymbol[] }): number {
  const sum = (pieces: PieceSymbol[]) => pieces.reduce((s, p) => s + PIECE_VALUE[p], 0);
  return sum(captured.w) - sum(captured.b);
}

// Human-readable "what just happened" line for the shared `lastAction` field every game screen
// already shows — mirrors Sweep's `sweepCardLabel`-style summary text.
export function describeMove(chess: Chess, moveSan: string, moverName: string): string {
  const suffix = chess.isCheckmate() ? ' — checkmate!' : chess.inCheck() ? ' — check' : '';
  return `${moverName} played ${moveSan}${suffix}`;
}
